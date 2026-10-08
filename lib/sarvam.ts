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

/** Full relay WebSocket URL for the browser. */
export function streamingUrl(token: string, sampleRate: number): string {
  const params = new URLSearchParams({ token, sample_rate: String(sampleRate) });
  return `${process.env.STT_RELAY_URL || DEFAULT_RELAY_URL}?${params.toString()}`;
}

/** Upstream URL and headers the relay opens to Sarvam. Server-side only. */
export function upstreamConnection(sampleRate: number): { url: string; headers: Record<string, string> } {
  const model = process.env.SARVAM_MODEL || "saaras:v3-realtime";
  const params = new URLSearchParams({
    model,
    // hi-IN suits Hinglish visits; "auto" detects across 22 languages and reports the language back.
    language_code: process.env.SARVAM_LANGUAGE_CODE || "hi-IN",
    // codemix keeps Hindi in Devanagari and English words in Latin. Sarvam applies it to finals only.
    mode: "codemix",
    stream_type: "balanced",
    endpointing: "vad",
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
