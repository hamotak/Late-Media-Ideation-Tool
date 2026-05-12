import { NextResponse } from "next/server";
import { getLatestTranscriptionJob } from "@/lib/db";

export const runtime = "nodejs";

/**
 * Most-recent transcription job, whatever its status. The /videos page
 * polls this every few seconds while a batch is running so users see
 * live "43 of 172 done, $1.23 spent" progress.
 */
export async function GET() {
  const job = getLatestTranscriptionJob();
  return NextResponse.json({ job: job ?? null });
}
