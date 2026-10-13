// WebSocket relay between the browser and Sarvam, so the Sarvam key never leaves the server.
// Browser -> relay: binary PCM16 frames, {"type":"ForceEndpoint"} when hold-to-talk is released, and
// {"type":"Terminate"} on stop (the same messages as AssemblyAI). ?endpointing=manual turns on
// Sarvam's manual turns (speech_start / speech_end / flush); ?language_code= overrides the language.
// Relay -> browser: AssemblyAI-shaped Turn/Error messages, translated in lib/sarvam.ts.
//
// Run: npm run relay   (next to npm run dev)
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { END_MESSAGE, PING_MESSAGE, relayOptions, relaySession, toClientMessage, upstreamConnection, verifyStreamingToken } from "../lib/sarvam.ts";

const PORT = Number(process.env.PORT || process.env.STT_RELAY_PORT || 8787);
const PING_MS = 15_000;
const MAX_QUEUED_FRAMES = 200; // ~10 s of 50 ms frames while Sarvam is still connecting

const server = new WebSocketServer({ port: PORT });

server.on("connection", (client, req) => {
  const params = new URL(req.url ?? "/", "http://relay").searchParams;
  if (!verifyStreamingToken(params.get("token"))) {
    client.close(4001, "Invalid or expired relay token");
    return;
  }

  const opts = relayOptions(params);
  const session = relaySession(opts.endpointing);
  let upstream: WebSocket;
  try {
    const { url, headers } = upstreamConnection(opts.sampleRate, { language: opts.language, endpointing: opts.endpointing });
    upstream = new WebSocket(url, { headers });
  } catch (err) {
    client.close(1011, (err as Error).message.slice(0, 120));
    return;
  }

  const queued: string[] = [];
  const ping = setInterval(() => upstream.readyState === WebSocket.OPEN && upstream.send(PING_MESSAGE), PING_MS);

  upstream.on("open", () => {
    for (const msg of queued.splice(0)) upstream.send(msg);
  });
  upstream.on("message", (data) => {
    const out = toClientMessage(data.toString());
    if (out && client.readyState === WebSocket.OPEN) client.send(out);
  });
  upstream.on("unexpected-response", (_req, res) => {
    client.close(1011, `Sarvam rejected the connection: HTTP ${res.statusCode}`);
  });
  upstream.on("close", (code, reason) => {
    clearInterval(ping);
    // Sarvam close codes (1003 bad key/quota, 4000 bad config or no beta access) carry the useful reason.
    if (client.readyState === WebSocket.OPEN) {
      client.close(code === 1000 ? 1000 : 1011, `Sarvam closed (${code}): ${reason.toString()}`.slice(0, 120));
    }
  });
  upstream.on("error", (err) => console.error("[relay] upstream error:", err.message));

  client.on("message", (data: RawData, isBinary) => {
    const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);
    for (const msg of session.fromClient(buf, isBinary)) {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(msg);
      else if (upstream.readyState === WebSocket.CONNECTING && queued.length < MAX_QUEUED_FRAMES) queued.push(msg);
    }
  });
  client.on("close", () => {
    clearInterval(ping);
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(END_MESSAGE);
      upstream.close(1000);
    } else if (upstream.readyState === WebSocket.CONNECTING) {
      upstream.terminate();
    }
  });
});

console.log(`[relay] Sarvam STT relay listening on ws://localhost:${PORT}`);
