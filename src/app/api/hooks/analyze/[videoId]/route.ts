import { NextResponse } from "next/server";
import { analyzeVideoHook } from "@/lib/hook-analyzer";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ videoId: string }> }
) {
  const { videoId } = await params;
  const result = await analyzeVideoHook(videoId);
  if (!result.ok) {
    return NextResponse.json({ error: result.reason }, { status: 400 });
  }
  return NextResponse.json({ ok: true, overallScore: result.overallScore });
}
