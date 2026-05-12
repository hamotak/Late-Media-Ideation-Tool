import { NextResponse } from "next/server";
import { CompetitorSyncError, syncCompetitor } from "@/lib/competitor-sync";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const competitorId = Number(id);
  if (!Number.isFinite(competitorId)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  try {
    const result = await syncCompetitor(competitorId);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const status = err instanceof CompetitorSyncError ? 400 : 500;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "sync failed" },
      { status }
    );
  }
}
