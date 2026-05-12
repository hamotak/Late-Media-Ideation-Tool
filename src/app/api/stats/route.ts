import { NextResponse } from "next/server";
import { getChannel, videoStats } from "@/lib/db";

export async function GET() {
  const channel = getChannel();
  const stats = videoStats();
  return NextResponse.json({ channel, stats });
}
