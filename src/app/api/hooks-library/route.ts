import { NextResponse } from "next/server";
import { addHookToLibrary, listHooksLibrary } from "@/lib/db";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({ hooks: listHooksLibrary() });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    comment_id?: string;
    source_video_id?: string;
    quote?: string;
    author?: string;
    score?: number;
    note?: string;
  };
  if (!body.quote?.trim()) {
    return NextResponse.json({ error: "quote required" }, { status: 400 });
  }
  const id = addHookToLibrary({
    comment_id: body.comment_id ?? null,
    source_video_id: body.source_video_id ?? null,
    quote: body.quote.trim(),
    author: body.author ?? null,
    score: typeof body.score === "number" ? body.score : null,
    note: body.note ?? null,
  });
  return NextResponse.json({ ok: true, id });
}
