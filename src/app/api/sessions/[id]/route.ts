import { NextResponse } from "next/server";
import {
  deleteSession,
  getMessages,
  getSession,
  isSessionPending,
  renameSession,
} from "@/lib/db";

// Defence-in-depth: even with the build-phase :memory: DB workaround
// in db.ts, we'd rather Next not try to evaluate this dynamic API
// route during `next build` at all. The collect-page-data phase
// imports the module and races on the SQLite write lock with ~30
// other workers; force-dynamic short-circuits that.
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = getSession(id);
  if (!session) return NextResponse.json({ error: "not found" }, { status: 404 });
  const messages = getMessages(id);
  // `pending` tells the client whether a chat turn is still streaming on the
  // server. The /chat page polls this endpoint while pending=true so users
  // see "Claude is generating…" even after navigating away and back.
  const pending = isSessionPending(id);
  return NextResponse.json({ session, messages, pending });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json()) as { title?: string };
  if (typeof body.title !== "string") {
    return NextResponse.json({ error: "title required" }, { status: 400 });
  }
  renameSession(id, body.title);
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  deleteSession(id);
  return NextResponse.json({ ok: true });
}
