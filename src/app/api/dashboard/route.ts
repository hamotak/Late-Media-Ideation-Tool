import { NextResponse } from "next/server";
import { dashboardAggregates, getChannel, videoStats } from "@/lib/db";

export const runtime = "nodejs";

export async function GET() {
  const channel = getChannel();
  const stats = videoStats();
  const aggregates = dashboardAggregates();
  return NextResponse.json({ channel, stats, aggregates });
}
