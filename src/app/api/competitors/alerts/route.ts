import { NextResponse } from "next/server";
import { listCompetitorAlerts } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const unreadOnly = url.searchParams.get("unread") === "1";
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 100)));
  const alerts = listCompetitorAlerts({ unreadOnly, limit });
  return NextResponse.json({ alerts });
}
