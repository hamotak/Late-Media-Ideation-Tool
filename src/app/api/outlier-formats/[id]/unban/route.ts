import { NextResponse } from "next/server";
import {
  getActiveChannelId,
  getOutlierFormatById,
  unbanOutlierFormat,
} from "@/lib/db";

export const runtime = "nodejs";

/**
 * POST /api/outlier-formats/:id/unban
 *
 * Clears banned_at on the row. Same scope check as ban (must belong to
 * the active channel). Idempotent — unbanning an already-active row
 * returns alreadyActive:true.
 */
export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id: idParam } = await ctx.params;
  const formatId = Number(idParam);
  if (!Number.isFinite(formatId) || formatId <= 0) {
    return NextResponse.json(
      { error: "format id must be a positive integer" },
      { status: 400 }
    );
  }

  const activeChannelId = getActiveChannelId();
  if (!activeChannelId) {
    return NextResponse.json(
      { error: "No active channel — set one from the top-right picker." },
      { status: 400 }
    );
  }

  const fmt = getOutlierFormatById(formatId);
  if (!fmt) {
    return NextResponse.json({ error: "format not found" }, { status: 404 });
  }
  if (fmt.userChannelId !== activeChannelId) {
    return NextResponse.json(
      { error: "format does not belong to the active channel" },
      { status: 403 }
    );
  }

  const flipped = unbanOutlierFormat(formatId);
  return NextResponse.json({
    ok: true,
    formatId,
    template: fmt.template,
    alreadyActive: !flipped,
  });
}
