// Sarvam realtime speech-to-text. Sarvam has no short-lived browser tokens, so the browser talks to
// our relay (scripts/stt-relay.ts), which holds the API key and speaks Sarvam's protocol upstream.
// Kept free of imports so the relay can load it directly with Node.
import { createHmac, timingSafeEqual } from "node:crypto";

const SARVAM_WS_URL = "wss://api.sarvam.ai/speech-to-text-realtime/ws";
const DEFAULT_RELAY_URL = "ws://localhost:8787";

function apiKey(): string {
  const key = process.env.SARVAM_API_KEY;
  if (!key) throw new Error("SARVAM_API_KEY is not set");
  return key;
}

function sign(expires: number): string {
  return createHmac("sha256", apiKey()).update(`stt-relay:${expires}`).digest("base64url");
}

/** Short-lived relay token, so the relay is not an open door to the Sarvam key. */
export async function createStreamingToken(expiresInSeconds = 600): Promise<string> {
  const expires = Math.floor(Date.now() / 1000) + expiresInSeconds;
  return `${expires}.${sign(expires)}`;
}

export function verifyStreamingToken(token: string | null): boolean {
  const [exp, sig] = (token ?? "").split(".");
  const expires = Number(exp);
  if (!sig || !Number.isFinite(expires) || expires < Date.now() / 1000) return false;
  const expected = Buffer.from(sign(expires));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/**
 * How the stream finds the end of an utterance. "vad": Sarvam detects pauses (tap to start and stop).
 * "manual": the client marks it (hold to talk): the relay sends speech_start before the first audio
 * of a press and speech_end plus flush on release, so the last words are transcribed at once.
 */
export type Endpointing = "vad" | "manual";

export interface StreamOptions {
  language?: string | null; // null: the relay's SARVAM_LANGUAGE_CODE
  endpointing?: Endpointing;
}

/**
 * Speech-to-text language for the agent's language. Saaras does not list Marwari, so Marwari speech
 * is sent as Hindi (hi-IN), never auto-detect; codemix keeps English words. Others use the default.
 */
export function sttLanguageFor(lang: string | null | undefined): string | null {
  return lang === "mwr" ? "hi-IN" : null;
}

const LANGUAGE_RE = /^(?:[a-z]{2,3}-IN|auto|unknown)$/;

/** The relay's options from the browser's URL, allow-listed. */
export function relayOptions(params: URLSearchParams): { sampleRate: number; language: string | null; endpointing: Endpointing } {
  const rate = Number(params.get("sample_rate") || 16000);
  const language = params.get("language_code");
  return {
    sampleRate: Number.isFinite(rate) && rate > 0 ? rate : 16000,
    language: language && LANGUAGE_RE.test(language) ? language : null,
    endpointing: params.get("endpointing") === "manual" ? "manual" : "vad",
  };
}

/** Full relay WebSocket URL for the browser. */
export function streamingUrl(token: string, sampleRate: number, opts: StreamOptions = {}): string {
  const params = new URLSearchParams({ token, sample_rate: String(sampleRate) });
  if (opts.language) params.set("language_code", opts.language);
  if (opts.endpointing) params.set("endpointing", opts.endpointing);
  return `${process.env.STT_RELAY_URL || DEFAULT_RELAY_URL}?${params.toString()}`;
}

/** Upstream URL and headers the relay opens to Sarvam. Server-side only. */
export function upstreamConnection(sampleRate: number, opts: StreamOptions = {}): { url: string; headers: Record<string, string> } {
  const model = process.env.SARVAM_MODEL || "saaras:v3-realtime";
  const params = new URLSearchParams({
    model,
    // hi-IN suits Hinglish visits; "auto" detects across 22 languages and reports the language back.
    language_code: opts.language || process.env.SARVAM_LANGUAGE_CODE || "hi-IN",
    // codemix keeps Hindi in Devanagari and English words in Latin. Sarvam applies it to finals only.
    mode: "codemix",
    stream_type: "balanced",
    endpointing: opts.endpointing ?? "vad",
    encoding: "linear16",
    sample_rate: String(sampleRate),
  });
  // Sarvam only accepts keyterms on saaras:v4.
  const keyterms = (process.env.SARVAM_KEYTERMS ?? "")
    .split(",")
    .map((t) => t.trim().slice(0, 64))
    .filter(Boolean)
    .slice(0, 50);
  if (model === "saaras:v4" && keyterms.length) params.set("keyterms", JSON.stringify(keyterms));
  return { url: `${SARVAM_WS_URL}?${params.toString()}`, headers: { "api-subscription-key": apiKey() } };
}

/** Raw PCM16 frame from the browser -> Sarvam's audio message. */
export function audioMessage(pcm: Buffer): string {
  return JSON.stringify({ event: "audio_input", audio: pcm.toString("base64") });
}

export const END_MESSAGE = JSON.stringify({ event: "end" });
export const PING_MESSAGE = JSON.stringify({ event: "ping" });
export const SPEECH_START_MESSAGE = JSON.stringify({ event: "speech_start" });
export const SPEECH_END_MESSAGE = JSON.stringify({ event: "speech_end" });
export const FLUSH_MESSAGE = JSON.stringify({ event: "flush" });

/**
 * One browser connection's turn control. Browser messages follow AssemblyAI's v3 protocol: binary
 * audio, {"type":"ForceEndpoint"} when the worker releases the button, {"type":"Terminate"} to close.
 * Returns the messages to send to Sarvam, in order.
 */
export function relaySession(endpointing: Endpointing) {
  let inSpeech = false;
  return {
    fromClient(data: Buffer, isBinary: boolean): string[] {
      if (isBinary) {
        const out: string[] = [];
        // Manual mode: Sarvam needs speech_start before the first audio of each press.
        if (endpointing === "manual" && !inSpeech) out.push(SPEECH_START_MESSAGE);
        inSpeech = true;
        out.push(audioMessage(data));
        return out;
      }
      const text = data.toString();
      if (text.includes('"Terminate"')) return [END_MESSAGE];
      if (text.includes('"ForceEndpoint"')) {
        // Released: end the utterance and force-finalize it, so the last words come back now.
        // Sarvam accepts speech_end and flush only in manual mode; in vad mode its own endpointing decides.
        if (endpointing !== "manual" || !inSpeech) return [];
        inSpeech = false;
        return [SPEECH_END_MESSAGE, FLUSH_MESSAGE];
      }
      return [];
    },
  };
}

type SarvamMessage = {
  event?: string;
  text?: string;
  language?: string;
  code?: string;
  message?: string;
  is_fatal?: boolean;
};

/**
 * Sarvam server event -> the AssemblyAI-shaped message the record page already parses,
 * so the page is identical whichever provider is behind it. Returns null for events it ignores.
 */
export function toClientMessage(raw: string): string | null {
  let msg: SarvamMessage;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  switch (msg.event) {
    case "transcript.partial":
      return JSON.stringify({ type: "Turn", transcript: msg.text ?? "", end_of_turn: false, turn_is_formatted: false });
    case "transcript.final":
      if (!msg.text?.trim()) return null;
      return JSON.stringify({
        type: "Turn",
        transcript: msg.text,
        end_of_turn: true,
        turn_is_formatted: true,
        language_code: msg.language ?? null,
      });
    case "error":
      return JSON.stringify({ type: "Error", error: `Sarvam ${msg.code ?? "error"}: ${msg.message ?? "unknown"}` });
    default:
      return null;
  }
}
