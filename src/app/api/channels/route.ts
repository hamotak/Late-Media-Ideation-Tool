import { getActiveChannelId, listAllChannels, tagsByChannel } from "@/lib/db";

export const runtime = "nodejs";

/**
 * Returns every channel currently stored locally plus the id of the
 * active one. Each channel row now also carries its attached tags
 * (folded in from the channel_tags m:n table) so the UI can render
 * chips without an N+1 round-trip per channel.
 */
export async function GET() {
  const channels = listAllChannels();
  const activeId = getActiveChannelId();
  const tagsMap = tagsByChannel();
  const enriched = channels.map((c) => ({
    ...c,
    tags: tagsMap.get(c.id) ?? [],
  }));
  return Response.json({ channels: enriched, activeId });
}
