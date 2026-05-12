"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronUp, Loader2, RefreshCw, Tag as TagIcon } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";

type TagOverview = {
  id: number;
  name: string;
  cut_percent: number | null;
  channelCount: number;
  grossRevenue: number;
  netRevenue: number;
  channels: { id: string; title: string | null; revenue: number }[];
};

type Payload = {
  connected: boolean;
  period?: string;
  tags: TagOverview[];
};

type PeriodKey = "28d" | "90d" | "365d" | "all";

const PERIODS: { value: PeriodKey; label: string }[] = [
  { value: "28d", label: "28d" },
  { value: "90d", label: "90d" },
  { value: "365d", label: "1y" },
  { value: "all", label: "All" },
];

/**
 * Cross-channel "Tags overview" — sums revenue across every channel
 * carrying each tag, then shows gross + net-after-cut. Hidden when
 * there are no tags or no revenue access (the user hasn't set up any
 * tags yet, or no channel is monetised).
 *
 * Self-contained: fetches /api/analytics/tags-overview on mount.
 * Click a row to expand a per-channel breakdown for that tag.
 */
export function TagsOverview() {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(false);
  const [period, setPeriod] = useState<PeriodKey>("90d");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const load = useCallback(async (p: PeriodKey) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/analytics/tags-overview?period=${p}`, {
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

  if (!data || !data.connected) return null;
  if (data.tags.length === 0) return null;

  const toggle = (id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const totalGross = data.tags.reduce((s, t) => s + t.grossRevenue, 0);
  const totalNet = data.tags.reduce((s, t) => s + t.netRevenue, 0);
  const periodLabel =
    PERIODS.find((p) => p.value === period)?.label ?? period;

  return (
    <Card className="mb-4">
      <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-3">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <TagIcon className="h-4 w-4 text-primary" />
            Tags overview
          </CardTitle>
          <CardDescription>
            Revenue grouped by tag. Tags with a % cut subtract that share
            from gross to compute net.
          </CardDescription>
        </div>
        <div className="flex items-center gap-1">
          <div className="flex rounded-md border border-border bg-background">
            {PERIODS.map((opt) => (
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
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
          </button>
        </div>
      </CardHeader>

      <CardContent className="space-y-2">
        {/* Summary line — total across every tagged channel for the period */}
        <div className="flex items-center justify-between rounded-md border bg-muted/30 px-3 py-2 text-xs">
          <span className="text-muted-foreground">
            {data.tags.length} tag{data.tags.length === 1 ? "" : "s"} ·{" "}
            {periodLabel}
          </span>
          <span className="tabular-nums">
            Gross{" "}
            <span className="font-semibold text-foreground">
              ${totalGross.toFixed(2)}
            </span>
            {totalNet < totalGross - 0.01 && (
              <>
                {" "}
                · Net{" "}
                <span className="font-semibold text-emerald-700 dark:text-emerald-400">
                  ${totalNet.toFixed(2)}
                </span>
              </>
            )}
          </span>
        </div>

        {/* Tag rows */}
        <div className="space-y-1">
          {data.tags.map((t) => {
            const isOpen = expanded.has(t.id);
            return (
              <div
                key={t.id}
                className="rounded-md border bg-card text-xs"
              >
                <button
                  onClick={() => toggle(t.id)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent"
                >
                  {isOpen ? (
                    <ChevronUp className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  ) : (
                    <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <span className="font-medium">{t.name}</span>
                  {typeof t.cut_percent === "number" && t.cut_percent > 0 && (
                    <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">
                      −{t.cut_percent}% cut
                    </span>
                  )}
                  <span className="text-[11px] text-muted-foreground">
                    {t.channelCount}{" "}
                    {t.channelCount === 1 ? "channel" : "channels"}
                  </span>
                  <span className="ml-auto flex items-center gap-3 tabular-nums">
                    {t.netRevenue < t.grossRevenue - 0.01 ? (
                      <>
                        <span className="text-muted-foreground">
                          gross ${t.grossRevenue.toFixed(2)}
                        </span>
                        <span className="font-semibold text-emerald-700 dark:text-emerald-400">
                          net ${t.netRevenue.toFixed(2)}
                        </span>
                      </>
                    ) : (
                      <span className="font-semibold tabular-nums">
                        ${t.grossRevenue.toFixed(2)}
                      </span>
                    )}
                  </span>
                </button>

                {isOpen && (
                  <ul className="border-t border-border px-3 py-2 text-[11px]">
                    {t.channels.length === 0 ? (
                      <li className="italic text-muted-foreground">
                        No channels.
                      </li>
                    ) : (
                      t.channels.map((c) => (
                        <li
                          key={c.id}
                          className="flex items-center justify-between gap-2 py-0.5"
                        >
                          <span className="truncate">
                            {c.title ?? c.id}
                          </span>
                          <span className="shrink-0 tabular-nums text-muted-foreground">
                            ${c.revenue.toFixed(2)}
                          </span>
                        </li>
                      ))
                    )}
                  </ul>
                )}
              </div>
            );
          })}
        </div>

        {loading && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            Refreshing tag totals…
          </div>
        )}
      </CardContent>
    </Card>
  );
}
