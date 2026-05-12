import { NextResponse } from "next/server";
import {
  AlertRuleInput,
  deleteRule,
  getRule,
  updateRule,
} from "@/lib/alerts";

export const runtime = "nodejs";

/** Per-rule operations: read, partial update (PATCH), delete. */

type Ctx = { params: Promise<{ id: string }> };

async function parseId(ctx: Ctx): Promise<number | null> {
  const { id } = await ctx.params;
  const n = Number(id);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function GET(_req: Request, ctx: Ctx) {
  const id = await parseId(ctx);
  if (id === null) return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  const rule = getRule(id);
  if (!rule) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ rule });
}

export async function PATCH(req: Request, ctx: Ctx) {
  const id = await parseId(ctx);
  if (id === null) return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  const body = (await req.json().catch(() => ({}))) as Partial<AlertRuleInput>;
  try {
    const rule = updateRule(id, body);
    if (!rule) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ rule });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid update" },
      { status: 400 }
    );
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const id = await parseId(ctx);
  if (id === null) return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  const ok = deleteRule(id);
  if (!ok) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
