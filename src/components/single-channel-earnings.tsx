"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { DollarSign, Loader2, RefreshCw } from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * Per-channel revenue card — the single-channel sibling of
 * `<MultiChannelEarnings>`. Shown on the Dashboard when the user has a
 * specific channel selected (not "All channels"). Title reads
 * "<Channel name> — earnings"; every number is scoped to that one
 * channel via the existing /api/analytics/revenue endpoint (which reads
 * youtube.activeChannelId server-side — no new endpoint).
 *
 * Structure mirrors MultiChannelEarnings: period selector + 3 summary
 * tiles + revenue-over-time bar chart with granularity toggle. The
 * per-channel table is omitted (there's only one channel).
 *
 * Auto-hides when revenue access is denied or OAuth isn't connected —
 * matches MultiChannelEarnings's behaviour so users without monetary
 * access don't see broken tiles.
 */

const PERIOD_OPTIONS = [
  { value: "28d" as const, label: "28d" },
  { value: "90d" as const, label: "90d" },
  { value: "365d" as const, label: "1y" },
  { value: "all" as const, label: "All" },
];
type PeriodKey = (typeof PERIOD_OPTIONS)[number]["value"];

type Granularity = "day" | "week" | "month";

type DailyPoint = { date: string; estimatedRevenue: number; cpm: number };

type RevenueBundle = {
  period: { startDate: string; endDate: string; days: number };
  totals: {
    views: number;
    estimatedRevenue: number;
    cpm: number;
    monetizedPlaybacks: number;
  };
  daily: DailyPoint[];
};

type Payload = {
  connected: boolean;
  revenueAccess: "allowed" | "denied" | "unknown";
  period: string;
  revenue: RevenueBundle | null;
};

function fmtUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

function fmtShortDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function SingleChannelEarnings({
  channelTitle,
}: {
  channelTitle: string;
}) {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(false);
  const [period, setPeriod] = useState<PeriodKey>("90d");
  const [granularity, setGranularity] = useState<Granularity>("day");

  const load = useCallback(async (p: PeriodKey) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/analytics/revenue?period=${p}`, {
        cache: "no-store",
      });
      const d = (await res.json()) as Payload;
      setData(d);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(period);
  }, [load, period]);

  // Roll the daily series up to weekly / monthly when the user toggles
  // granularity. Daily data is small enough that the rollup is free.
  const chartData = useMemo(() => {
    const daily = data?.revenue?.daily ?? [];
    if (daily.length === 0) return [];
    if (granularity === "day") {
      return daily.map((d) => ({
        bucket: d.date,
        total: d.estimatedRevenue,
      }));
    }
    if (granularity === "month") {
      const map = new Map<string, number>();
      for (const d of daily) {
        const key = d.date.slice(0, 7);
        map.set(key, (map.get(key) ?? 0) + d.estimatedRevenue);
      }
      return [...map.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([bucket, total]) => ({ bucket, total: Number(total.toFixed(2)) }));
    }
    // Week — shift each date back to Monday and accumulate.
    const map = new Map<string, number>();
    for (const d of daily) {
      const dt = new Date(d.date + "T00:00:00Z");
      const day = dt.getUTCDay(); // 0 = Sun, 1 = Mon, ...
      const offset = day === 0 ? -6 : 1 - day;
      const monday = new Date(dt.getTime() + offset * 86400_000);
      const key = monday.toISOString().slice(0, 10);
      map.set(key, (map.get(key) ?? 0) + d.estimatedRevenue);
    }
    return [...map.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([bucket, total]) => ({ bucket, total: Number(total.toFixed(2)) }));
  }, [data, granularity]);

  // MTD + previous-month fallback. Sums client-side from the daily
  // series. The fallback handles YouTube Analytics's 1-3 day data lag —
  // when MTD is $0.00 on the 1st-2nd of a new month we show the previous
  // month's total instead, with an explicit label.
  const monthInfo = useMemo(() => {
    const daily = data?.revenue?.daily ?? [];
    if (daily.length === 0) {
      return { mtd: 0, prevMonth: 0, prevMonthKey: null as string | null };
    }
    const today = new Date();
    const curKey = `${today.getUTCFullYear()}-${String(
      today.getUTCMonth() + 1
    ).padStart(2, "0")}`;
    const prevDate = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1)
    );
    const prevKey = `${prevDate.getUTCFullYear()}-${String(
      prevDate.getUTCMonth() + 1
    ).padStart(2, "0")}`;
    let mtd = 0;
    let prevMonth = 0;
    for (const d of daily) {
      const key = d.date.slice(0, 7);
      if (key === curKey) mtd += d.estimatedRevenue;
      else if (key === prevKey) prevMonth += d.estimatedRevenue;
    }
    return {
      mtd: Number(mtd.toFixed(2)),
      prevMonth: Number(prevMonth.toFixed(2)),
      prevMonthKey: prevKey,
    };
  }, [data]);

  if (!data) {
    return null; // initial render — first paint should be the rest of the dashboard
  }
  if (!data.connected || data.revenueAccess === "denied" || !data.revenue) {
    // Same posture as MultiChannelEarnings: hide rather than show a
    // half-broken card. The user's other surfaces (Integrations) tell
    // them OAuth isn't connected.
    return null;
  }

  const bundle = data.revenue;
  const latestDay =
    bundle.daily.length > 0
      ? bundle.daily[bundle.daily.length - 1].estimatedRevenue
      : 0;
  const periodTotal = bundle.totals.estimatedRevenue;
  const periodLabel =
    PERIOD_OPTIONS.find((p) => p.value === period)?.label ?? period;

  const useFallback = monthInfo.mtd < 0.01 && monthInfo.prevMonth > 0;
  const monthValue = useFallback ? monthInfo.prevMonth : monthInfo.mtd;
  const prevMonthLabel = formatMonthKey(monthInfo.prevMonthKey);
  const monthBaseLabel = useFallback
    ? `${prevMonthLabel} total`
    : "Month-to-date";

  return (
    <Card className="mb-4">
      <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-3">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <DollarSign className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
            {channelTitle} — earnings
          </CardTitle>
          <CardDescription>
            Revenue from this channel only. Switch via the channel picker.
          </CardDescription>
        </div>
        <div className="flex items-center gap-1">
          <div className="flex rounded-md border border-border bg-background">
            {PERIOD_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setPeriod(opt.value)}
                disabled={loading}
                className={cn(
                  "px-2 py-1 text-[11px] font-medium transition-colors",
                  period === opt.value
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-accent"
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <button
            onClick={() => load(period)}
            disabled={loading}
            className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
            aria-label="Refresh"
            title="Refresh"
          >
            <RefreshCw
              className={cn("h-3.5 w-3.5", loading && "animate-spin")}
            />
          </button>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <SummaryTile label="Latest day" value={latestDay} />
          <SummaryTile label={monthBaseLabel} value={monthValue} highlight />
          <SummaryTile label={`Total (${periodLabel})`} value={periodTotal} />
        </div>

        {useFallback && (
          <p className="text-[10px] text-muted-foreground">
            Showing {prevMonthLabel} total because YouTube Analytics
            hasn&apos;t reported any current-month days yet (typical 1-3 day
            data lag).
          </p>
        )}

        {chartData.length > 0 && (
          <div className="rounded-md border bg-card p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="text-[11px] uppercase text-muted-foreground">
                Revenue over time
              </div>
              <div className="flex rounded-md border border-border bg-background">
                {(["day", "week", "month"] as Granularity[]).map((g) => (
                  <button
                    key={g}
                    onClick={() => setGranularity(g)}
                    className={cn(
                      "px-2 py-0.5 text-[11px] font-medium capitalize transition-colors",
                      granularity === g
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:bg-accent"
                    )}
                  >
                    {g}
                  </button>
                ))}
              </div>
            </div>
            <div className="h-44">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={chartData}
                  margin={{ top: 4, right: 8, bottom: 0, left: -8 }}
                >
                  <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                  <XAxis
                    dataKey="bucket"
                    tick={{ fontSize: 10 }}
                    tickFormatter={fmtShortDay}
                    interval="preserveStartEnd"
                    minTickGap={40}
                  />
                  <YAxis
                    tick={{ fontSize: 10 }}
                    tickFormatter={(v) =>
                      `$${v >= 1000 ? `${(v / 1000).toFixed(1)}K` : v.toFixed(0)}`
                    }
                    width={50}
                  />
                  <Tooltip
                    formatter={(v) => [`$${Number(v ?? 0).toFixed(2)}`, "Revenue"]}
                    labelFormatter={(label) => fmtShortDay(String(label ?? ""))}
                    contentStyle={{ fontSize: 12 }}
                  />
                  <Bar dataKey="total" fill="#10b981" radius={[2, 2, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}

        {loading && (
          <div className="flex items-center justify-center gap-2 py-3 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Updating…
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SummaryTile({
  label,
  value,
  highlight,
}: {
  label: string;
  value: number;
  highlight?: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border bg-card p-3",
        highlight && "border-emerald-500/40 bg-emerald-500/5"
      )}
    >
      <div className="text-[10px] uppercase text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-bold tabular-nums">{fmtUsd(value)}</div>
    </div>
  );
}

function formatMonthKey(key: string | null): string {
  if (!key) return "Previous month";
  const [year, month] = key.split("-").map(Number);
  if (!year || !month) return "Previous month";
  const d = new Date(Date.UTC(year, month - 1, 1));
  return d.toLocaleDateString("en-US", { month: "short", year: "numeric" });
}
