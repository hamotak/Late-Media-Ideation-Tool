import { NextResponse } from "next/server";
import { searchVideosLite } from "@/lib/db";

export const runtime = "nodejs";

// Used by the chat attachment picker — needs to stay snappy.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = url.searchParams.get("q") ?? "";
  const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get("limit") ?? "20", 10) || 20));
  return NextResponse.json({ videos: searchVideosLite(q, limit) });
}
