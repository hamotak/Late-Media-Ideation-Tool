import { NextResponse } from "next/server";
import { getStatus } from "@/lib/google-oauth";
import { listAllChannels } from "@/lib/db";

export const runtime = "nodejs";

/**
 * Returns OAuth status for the global slot (back-compat) plus a
 * per-channel breakdown so the multi-account UI can show "Connect
 * Google" buttons with the right state on each row.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const channelId = url.searchParams.get("channelId");
  if (channelId) {
    return NextResponse.json(getStatus(channelId));
  }
  const channels = listAllChannels();
  return NextResponse.json({
    ...getStatus(),
    channels: channels.map((c) => ({
      channelId: c.id,
      title: c.title,
      handle: c.handle,
      ...getStatus(c.id),
    })),
  });
}
