import { NextResponse } from "next/server";
import {
  banOutlierFormat,
  getActiveChannelId,
  getOutlierFormatById,
} from "@/lib/db";

export const runtime = "nodejs";

/**
 * POST /api/outlier-formats/:id/ban
 *
 * Soft-bans a trending format for the active channel: sets banned_at = now
 * on the row. Banned formats stop appearing in the Patterns tab, the
 * list_format_patterns chat tool, and the idea-generator's format pool
 * (every read path goes through listFormatsForChannel, which filters
 * banned_at IS NULL).
 *
 * Scope check: the format's user_channel_id must match the active
 * channel. We refuse cross-channel bans to keep multi-channel users
 * from accidentally banning a format they own elsewhere.
 *
 * Idempotent — banning an already-banned row returns ok:true with
 * alreadyBanned:true so the optimistic UI can settle without surfacing
 * an error toast on rapid double-click.
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

  const flipped = banOutlierFormat(formatId);
  return NextResponse.json({
    ok: true,
    formatId,
    template: fmt.template,
    alreadyBanned: !flipped,
  });
}
