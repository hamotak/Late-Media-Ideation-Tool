import { NextResponse } from "next/server";
import { markCompetitorAlertRead } from "@/lib/db";

export const runtime = "nodejs";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const alertId = Number(id);
  if (!Number.isFinite(alertId)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  markCompetitorAlertRead(alertId);
  return NextResponse.json({ ok: true });
}
