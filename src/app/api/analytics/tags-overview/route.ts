import { NextResponse } from "next/server";
import { listAllChannels, listTags, tagsByChannel } from "@/lib/db";
import { fetchChannelRevenue, getRevenueAccessFlag } from "@/lib/yt-analytics";
import { getOAuthTokens } from "@/lib/google-oauth";

export const runtime = "nodejs";
export const maxDuration = 60;

const PERIODS: Record<string, number | "all"> = {
  "28d": 28,
  "90d": 90,
  "365d": 365,
  all: "all",
};

type TagOverview = {
  id: number;
  name: string;
  cut_percent: number | null;
  channelCount: number;
  // Sums across every channel carrying this tag for the period.
  grossRevenue: number;
  netRevenue: number; // grossRevenue × (1 − cut/100)
  channels: { id: string; title: string | null; revenue: number }[];
};

/**
 * Aggregate revenue across all channels grouped by tag. The dashboard
 * widget calls this to show "you earned $X with channels tagged
 * 'Freedom CMS', $Y after their 15% cut" type rows.
 *
 * Walks every connected channel, fetches its revenue (re-using the
 * same helper as the per-channel revenue widget), then groups by tag.
 * Channels with multiple tags contribute their full revenue to EACH
 * tag they're attached to — the friend's mental model is "see total
 * revenue per network", not "split revenue across networks".
 */
export async function GET(req: Request) {
  const tokens = getOAuthTokens();
  if (!tokens?.refresh_token) {
    return NextResponse.json({ connected: false, tags: [] });
  }

  const url = new URL(req.url);
  const periodKey = url.searchParams.get("period") ?? "90d";
  const periodSpec = PERIODS[periodKey];
  if (periodSpec === undefined) {
    return NextResponse.json(
      { error: `Invalid period. Use one of: ${Object.keys(PERIODS).join(", ")}` },
      { status: 400 }
    );
  }

  const channels = listAllChannels();
  const tags = listTags();
  const tagsMap = tagsByChannel();

  // Build a per-channel revenue map first so each channel is fetched
  // once even if it has multiple tags.
  const revenueByChannel = new Map<string, number>();
  await Promise.all(
    channels.map(async (c) => {
      if (
        getRevenueAccessFlag(c.id) === "denied" ||
        !getOAuthTokens(c.id)?.refresh_token
      ) {
        revenueByChannel.set(c.id, 0);
        return;
      }
      try {
        const bundle = await fetchChannelRevenue(periodSpec, c.id);
        revenueByChannel.set(c.id, bundle.totals.estimatedRevenue);
      } catch {
        revenueByChannel.set(c.id, 0);
      }
    })
  );

  // For each tag, collect the channels carrying it and sum revenue.
  const overview: TagOverview[] = tags.map((t) => {
    const tagChannels: { id: string; title: string | null; revenue: number }[] = [];
    let gross = 0;
    for (const c of channels) {
      const channelTags = tagsMap.get(c.id) ?? [];
      if (!channelTags.some((ct) => ct.id === t.id)) continue;
      const rev = revenueByChannel.get(c.id) ?? 0;
      gross += rev;
      tagChannels.push({
        id: c.id,
        title: c.title,
        revenue: Number(rev.toFixed(2)),
      });
    }
    const cut =
      typeof t.cut_percent === "number" && t.cut_percent > 0
        ? Math.max(0, Math.min(100, t.cut_percent))
        : 0;
    const net = gross * (1 - cut / 100);
    return {
      id: t.id,
      name: t.name,
      cut_percent: t.cut_percent,
      channelCount: tagChannels.length,
      grossRevenue: Number(gross.toFixed(2)),
      netRevenue: Number(net.toFixed(2)),
      channels: tagChannels.sort((a, b) => b.revenue - a.revenue),
    };
  });

  // Filter out tags with 0 channels so the widget stays compact.
  // Sort by gross revenue desc — the user cares about big-money tags first.
  const filtered = overview
    .filter((t) => t.channelCount > 0)
    .sort((a, b) => b.grossRevenue - a.grossRevenue);

  return NextResponse.json({
    connected: true,
    period: periodKey,
    tags: filtered,
  });
}
