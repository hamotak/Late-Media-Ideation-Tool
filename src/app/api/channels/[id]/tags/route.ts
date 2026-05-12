import { NextResponse } from "next/server";
import {
  attachTag,
  createTag,
  getTagByName,
  listTagsForChannel,
} from "@/lib/db";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** GET — list tags currently attached to this channel. */
export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  return NextResponse.json({ tags: listTagsForChannel(id) });
}

/**
 * POST — attach a tag to this channel. Body forms supported:
 *   { tagId: number }            — attach an existing tag by id
 *   { name: string, cut_percent? } — create-or-find by name and attach
 *
 * The second form lets the UI's combobox feel like one click: type a
 * name, hit Enter; the server creates the tag if it didn't exist and
 * attaches it in the same call.
 */
export async function POST(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as {
    tagId?: number;
    name?: string;
    cut_percent?: number | null;
  };

  let tagId = body.tagId;
  if (!tagId && body.name) {
    const name = body.name.trim();
    if (!name) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    const existing = getTagByName(name);
    if (existing) {
      tagId = existing.id;
    } else {
      const tag = createTag({
        name,
        cut_percent: body.cut_percent ?? null,
      });
      tagId = tag.id;
    }
  }

  if (typeof tagId !== "number") {
    return NextResponse.json(
      { error: "Provide either tagId or name" },
      { status: 400 }
    );
  }

  attachTag(id, tagId);
  return NextResponse.json({ ok: true, tags: listTagsForChannel(id) });
}
