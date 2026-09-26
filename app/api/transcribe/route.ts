import { NextResponse } from "next/server";
import { createStreamingToken, streamingUrl } from "@/lib/assemblyai";

export const dynamic = "force-dynamic";

/** Returns a ready-to-open AssemblyAI streaming WebSocket URL with a temporary token. */
export async function GET(req: Request) {
  const sampleRate = Number(new URL(req.url).searchParams.get("sample_rate") ?? 16000);
  try {
    const token = await createStreamingToken();
    return NextResponse.json({ url: streamingUrl(token, sampleRate) });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
