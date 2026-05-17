import { NextResponse } from "next/server";
import { getLatestCommentSyncJob } from "@/lib/db";

export const runtime = "nodejs";

/**
 * Latest comment-sync job (running or finished). The bulk-sync banner
 * polls this every couple of seconds while a job is in flight.
 */
export async function GET() {
  const job = getLatestCommentSyncJob();
  return NextResponse.json({ job: job ?? null });
}
