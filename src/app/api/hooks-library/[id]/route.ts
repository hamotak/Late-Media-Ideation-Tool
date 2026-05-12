import { NextResponse } from "next/server";
import { deleteHookLibraryEntry, updateHookLibraryEntry } from "@/lib/db";

export const runtime = "nodejs";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const entryId = Number(id);
  if (!Number.isFinite(entryId)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  const body = (await req.json().catch(() => ({}))) as {
    status?: "available" | "used";
    score?: number;
    note?: string;
    used_in_video_id?: string;
  };
  updateHookLibraryEntry(entryId, body);
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const entryId = Number(id);
  if (!Number.isFinite(entryId)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  deleteHookLibraryEntry(entryId);
  return NextResponse.json({ ok: true });
}
