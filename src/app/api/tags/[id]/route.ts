import { NextResponse } from "next/server";
import { deleteTag, getTag, updateTag } from "@/lib/db";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

async function parseId(ctx: Ctx): Promise<number | null> {
  const { id } = await ctx.params;
  const n = Number(id);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function GET(_req: Request, ctx: Ctx) {
  const id = await parseId(ctx);
  if (id === null) return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  const tag = getTag(id);
  if (!tag) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ tag });
}

export async function PATCH(req: Request, ctx: Ctx) {
  const id = await parseId(ctx);
  if (id === null) return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  const body = (await req.json().catch(() => ({}))) as {
    name?: string;
    cut_percent?: number | null;
    color?: string | null;
  };
  if (
    body.cut_percent !== null &&
    body.cut_percent !== undefined &&
    (typeof body.cut_percent !== "number" ||
      !Number.isFinite(body.cut_percent) ||
      body.cut_percent < 0 ||
      body.cut_percent > 100)
  ) {
    return NextResponse.json(
      { error: "cut_percent must be 0-100" },
      { status: 400 }
    );
  }
  try {
    const tag = updateTag(id, body);
    if (!tag) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ tag });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Update failed" },
      { status: 400 }
    );
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const id = await parseId(ctx);
  if (id === null) return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  const ok = deleteTag(id);
  if (!ok) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
