import { NextResponse } from "next/server";
import { listRecentFires } from "@/lib/alerts";

export const runtime = "nodejs";

/** Recent fires feed for the /alerts UI. Soft cap at 100 entries. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 50)));
  return NextResponse.json({ fires: listRecentFires(limit) });
}
