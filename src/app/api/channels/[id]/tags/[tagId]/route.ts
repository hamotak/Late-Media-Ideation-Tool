import { NextResponse } from "next/server";
import { detachTag, listTagsForChannel } from "@/lib/db";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string; tagId: string }> };

/** DELETE — detach a tag from this channel (does not delete the tag itself). */
export async function DELETE(_req: Request, ctx: Ctx) {
  const { id, tagId } = await ctx.params;
  const tagIdNum = Number(tagId);
  if (!Number.isInteger(tagIdNum) || tagIdNum <= 0) {
    return NextResponse.json({ error: "Invalid tagId" }, { status: 400 });
  }
  detachTag(id, tagIdNum);
  return NextResponse.json({ ok: true, tags: listTagsForChannel(id) });
}
