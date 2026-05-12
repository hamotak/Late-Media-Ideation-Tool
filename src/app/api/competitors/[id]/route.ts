import { NextResponse } from "next/server";
import { deleteCompetitor, getCompetitor, listCompetitorVideos } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const competitorId = Number(id);
  if (!Number.isFinite(competitorId)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  const competitor = getCompetitor(competitorId);
  if (!competitor) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const videos = listCompetitorVideos(competitorId, 100);
  return NextResponse.json({ competitor, videos });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const competitorId = Number(id);
  if (!Number.isFinite(competitorId)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  // ON DELETE CASCADE wipes competitor_videos and competitor_alerts too,
  // so we don't have to lift cleanup logic into the route handler.
  deleteCompetitor(competitorId);
  return NextResponse.json({ ok: true });
}
