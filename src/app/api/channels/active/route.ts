import {
  getActiveChannelId,
  getChannel,
  listAllChannels,
  setActiveChannelId,
} from "@/lib/db";

export const runtime = "nodejs";

/**
 * Read or update the active channel pointer. POST with `{ id }` switches
 * the dashboard / videos / analytics screens to that channel. Validation:
 * the id must exist in the local `channels` table — silently accepting an
 * unknown id would leave the UI showing "no data" with no clue why.
 */
export async function GET() {
  const activeId = getActiveChannelId();
  const channel = getChannel() ?? null;
  return Response.json({ activeId, channel });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { id?: string };
  const id = body.id?.trim();
  if (!id) {
    return Response.json({ error: "Missing channel id" }, { status: 400 });
  }
  const known = listAllChannels().some((c) => c.id === id);
  if (!known) {
    return Response.json({ error: "Unknown channel id" }, { status: 404 });
  }
  setActiveChannelId(id);
  // Return fresh status so the client doesn't need a follow-up GET.
  return Response.json({ activeId: id, channel: getChannel() ?? null });
}
