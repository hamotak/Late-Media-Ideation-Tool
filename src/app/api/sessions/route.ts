import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { createSession, listSessions } from "@/lib/db";

export async function GET() {
  return NextResponse.json({ sessions: listSessions() });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { title?: string };
  const id = randomUUID();
  createSession(id, body.title?.trim() || null);
  return NextResponse.json({ id });
}
