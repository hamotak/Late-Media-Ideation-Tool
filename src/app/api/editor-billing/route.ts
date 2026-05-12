import { NextResponse } from "next/server";
import {
  ChannelMeta,
  db,
  editorBillingByMonth,
  getActiveChannelId,
  getSetting,
  listAllChannels,
  setSetting,
  updateChannelMeta,
} from "@/lib/db";

export const runtime = "nodejs";

/**
 * Per-channel rate so each channel has its own per-video price (different
 * editors / different work scope = different rates). Falls back to the
 * legacy global key for installs that pre-date multi-channel.
 */
function rateKey(channelId: string | null): string {
  return channelId
    ? `editor.costPerVideoUsd.${channelId}`
    : "editor.costPerVideoUsd";
}

function readRate(channelId: string | null): number {
  if (channelId) {
    const perChannel = getSetting(`editor.costPerVideoUsd.${channelId}`);
    if (perChannel !== null && perChannel !== "") return Number(perChannel) || 0;
  }
  return Number(getSetting("editor.costPerVideoUsd") ?? "0") || 0;
}

type EditorAggregateRow = {
  editorName: string | null; // null = unassigned
  totalAmount: number;
  videoCount: number;
  channelCount: number;
  /** Sum of (channel.expected_videos_per_month × channel.rate) across
   *  every channel under this editor. Lets the user see "you'll spend
   *  $X / month if everyone hits their agreed pace". */
  forecastMonthly: number;
  forecastVideoCount: number;
  channels: {
    id: string;
    title: string | null;
    videoCount: number;
    amount: number;
    expectedVideos: number;
    forecastAmount: number;
  }[];
};

/**
 * Aggregate this month's editor cost across every channel, grouped by
 * `channels.editor_name`. Channels without a set editor land under
 * `null` ("Unassigned") so the user sees "you've got 5 channels with no
 * editor name set — go fill those in".
 */
function aggregateByEditor(): EditorAggregateRow[] {
  const channels = listAllChannels();
  const now = new Date();
  const monthStart = Math.floor(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000
  );
  const nextMonthStart = Math.floor(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) / 1000
  );

  // Per-channel video count this month, plus rate, plus amount, plus
  // expected forecast.
  const groups = new Map<string | null, EditorAggregateRow>();
  for (const c of channels) {
    const rate = readRate(c.id);
    const row = db
      .prepare(
        `SELECT COUNT(*) as n FROM videos
         WHERE channel_id = ? AND published_at IS NOT NULL
           AND published_at >= ? AND published_at < ?`
      )
      .get(c.id, monthStart, nextMonthStart) as { n: number };
    const videoCount = row?.n ?? 0;
    const amount = videoCount * rate;
    const expectedVideos = c.expected_videos_per_month ?? 0;
    const forecastAmount = expectedVideos * rate;

    const editorName = (c.editor_name ?? "")?.trim() || null;
    let bucket = groups.get(editorName);
    if (!bucket) {
      bucket = {
        editorName,
        totalAmount: 0,
        videoCount: 0,
        channelCount: 0,
        forecastMonthly: 0,
        forecastVideoCount: 0,
        channels: [],
      };
      groups.set(editorName, bucket);
    }
    bucket.totalAmount += amount;
    bucket.videoCount += videoCount;
    bucket.channelCount += 1;
    bucket.forecastMonthly += forecastAmount;
    bucket.forecastVideoCount += expectedVideos;
    bucket.channels.push({
      id: c.id,
      title: c.title,
      videoCount,
      amount: Number(amount.toFixed(2)),
      expectedVideos,
      forecastAmount: Number(forecastAmount.toFixed(2)),
    });
  }

  // Sort: largest payout first, "unassigned" last.
  return [...groups.values()]
    .map((g) => ({
      ...g,
      totalAmount: Number(g.totalAmount.toFixed(2)),
      forecastMonthly: Number(g.forecastMonthly.toFixed(2)),
    }))
    .sort((a, b) => {
      if (a.editorName === null && b.editorName !== null) return 1;
      if (b.editorName === null && a.editorName !== null) return -1;
      return b.totalAmount - a.totalAmount;
    });
}

/**
 * GET — current rate + editor name + last 12 months of upload counts ×
 * rate, scoped to the active channel. ALSO returns a cross-channel
 * by-editor aggregation for the current month so the dashboard card
 * can show "John (3 channels): $480 due" etc.
 */
export async function GET() {
  const channelId = getActiveChannelId();
  const rate = readRate(channelId);
  // Editor name + expected-videos pulled from the active channel's
  // row — both are per-channel attributes managed by updateChannelMeta.
  const channels = listAllChannels();
  const activeChannel = channels.find((c) => c.id === channelId);
  const editorName = activeChannel?.editor_name ?? null;
  const expectedVideos = activeChannel?.expected_videos_per_month ?? 0;

  const months = editorBillingByMonth(12);
  const now = new Date();
  const currentMonthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const hasCurrent = months.some((m) => m.month === currentMonthKey);
  if (!hasCurrent) {
    months.unshift({
      month: currentMonthKey,
      videoCount: 0,
      rateUsd: rate,
      amountUsd: 0,
      videos: [],
    });
  }

  // Sum the forecast across all channels = "if everyone hits agreed
  // pace, you spend this much per month on editors total".
  const byEditor = aggregateByEditor();
  const totalForecastMonthly = byEditor.reduce(
    (s, r) => s + r.forecastMonthly,
    0
  );

  return NextResponse.json({
    rateUsd: rate,
    editorName,
    expectedVideos,
    currentMonth: currentMonthKey,
    months,
    channelId,
    byEditor,
    totalForecastMonthly: Number(totalForecastMonthly.toFixed(2)),
  });
}

/**
 * POST — update rate + editor name + expected videos / month for the
 * active channel. All three fields optional; omit one to leave it
 * untouched. Empty string for editorName clears it.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    rateUsd?: number;
    editorName?: string | null;
    expectedVideos?: number | null;
  };
  const channelId = getActiveChannelId();

  if (typeof body.rateUsd === "number") {
    if (!Number.isFinite(body.rateUsd) || body.rateUsd < 0) {
      return NextResponse.json(
        { error: "rateUsd must be a non-negative number" },
        { status: 400 }
      );
    }
    setSetting(rateKey(channelId), String(body.rateUsd));
  }
  // Both editor name and expected-videos live on the channels row, so
  // we patch them together via updateChannelMeta.
  if (channelId) {
    const patch: ChannelMeta = {};
    if ("editorName" in body) {
      patch.editor_name =
        body.editorName === null || body.editorName === undefined
          ? null
          : String(body.editorName).trim() || null;
    }
    if ("expectedVideos" in body) {
      const v = body.expectedVideos;
      if (v === null || v === undefined || v === 0) {
        patch.expected_videos_per_month = null;
      } else if (typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 1000) {
        patch.expected_videos_per_month = Math.round(v);
      } else {
        return NextResponse.json(
          { error: "expectedVideos must be 0-1000" },
          { status: 400 }
        );
      }
    }
    if (Object.keys(patch).length > 0) {
      updateChannelMeta(channelId, patch);
    }
  }

  return NextResponse.json({
    ok: true,
    channelId,
    rateUsd: readRate(channelId),
  });
}
