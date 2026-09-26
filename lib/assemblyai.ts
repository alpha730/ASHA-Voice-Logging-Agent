// Server-side helper: mint a short-lived streaming token so the API key never reaches the browser.
const TOKEN_URL = "https://streaming.assemblyai.com/v3/token";
const STREAMING_WS_URL = "wss://streaming.assemblyai.com/v3/ws";

export async function createStreamingToken(expiresInSeconds = 600): Promise<string> {
  const key = process.env.ASSEMBLYAI_API_KEY;
  if (!key) throw new Error("ASSEMBLYAI_API_KEY is not set");
  const res = await fetch(`${TOKEN_URL}?expires_in_seconds=${expiresInSeconds}`, {
    headers: { Authorization: key },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`AssemblyAI token request failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { token: string };
  return data.token;
}

/** Full WebSocket URL for the browser, including model, turn formatting and keyterm prompting. */
export function streamingUrl(token: string, sampleRate: number): string {
  const params = new URLSearchParams({
    token,
    sample_rate: String(sampleRate),
    encoding: "pcm_s16le",
    format_turns: "true",
  });
  // universal-3-5-pro is the only streaming model with Hindi and native code-switching.
  params.set("speech_model", process.env.ASSEMBLYAI_SPEECH_MODEL || "universal-3-5-pro");
  const keyterms = (process.env.ASSEMBLYAI_KEYTERMS ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 100);
  if (keyterms.length) params.set("keyterms_prompt", JSON.stringify(keyterms));
  return `${STREAMING_WS_URL}?${params.toString()}`;
}
