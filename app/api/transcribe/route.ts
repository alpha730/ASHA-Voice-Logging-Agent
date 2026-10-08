import { NextResponse } from "next/server";
import * as assemblyai from "@/lib/assemblyai";
import * as sarvam from "@/lib/sarvam";

export const dynamic = "force-dynamic";

/**
 * Returns a ready-to-open streaming WebSocket URL with a temporary token.
 * STT_PROVIDER=sarvam (default) points at our Sarvam relay; assemblyai connects to AssemblyAI directly.
 */
export async function GET(req: Request) {
  const sampleRate = Number(new URL(req.url).searchParams.get("sample_rate") ?? 16000);
  const stt = (process.env.STT_PROVIDER || "sarvam").toLowerCase() === "assemblyai" ? assemblyai : sarvam;
  try {
    const token = await stt.createStreamingToken();
    return NextResponse.json({ url: stt.streamingUrl(token, sampleRate) });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
