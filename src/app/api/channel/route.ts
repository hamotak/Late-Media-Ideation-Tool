import { NextResponse } from "next/server";
import { channelAnalytics, getChannel, videoStats } from "@/lib/db";

export const runtime = "nodejs";

export async function GET() {
  const channel = getChannel();
  if (!channel) return NextResponse.json({ channel: null });
  const stats = videoStats();
  // Deep analytics bundle — everything we can compute from the local
  // `videos` + `transcripts` tables, no external API calls. Drives the
  // Channel Details page. Returns `null` if there are no videos yet.
  const analytics = channelAnalytics();
  return NextResponse.json({ channel, stats, analytics });
}
