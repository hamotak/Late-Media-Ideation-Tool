"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Upload, ArrowUpRight, RefreshCw } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n/provider";
import { ConnectBanner } from "@/components/connect-banner";
import { StudioOverview } from "@/components/studio-overview";
import { TodaysEarnings } from "@/components/todays-earnings";
import { TagsOverview } from "@/components/tags-overview";
import { SingleChannelEarnings } from "@/components/single-channel-earnings";
import { AllChannelsOverview } from "@/components/all-channels-overview";
import { cn } from "@/lib/utils";

// Subset of `/api/dashboard` response that survives after the dedupe pass —
// only `total` is still consumed (the `hasData` check). The 4-KPI strip
// that read totalViews / avgViews lived above StudioOverview and was cut
// because StudioOverview already renders period-windowed Views + Subs +
// Watch time + Avg view duration. Subs/Views/Videos/AvgViews were the
// channel-LIFETIME variants — two strips on one page, no labelling for
// "lifetime vs period", users couldn't reconcile the numbers.
type Stats = {
  total: number;
};

type Channel = {
  id: string;
  title: string | null;
  subscriber_count: number | null;
  view_count: number | null;
  video_count: number | null;
};

export default function DashboardPage() {
  const { t } = useI18n();
  const [stats, setStats] = useState<Stats | null>(null);
  const [channel, setChannel] = useState<Channel | null>(null);
  // "all" = cross-channel summary view; "channel" = single-channel view.
  // Source of truth is localStorage["dashboard.viewMode"], written by the
  // top-bar ChannelSwitcher. The inline DashboardTabs toggle was removed
  // in favour of the unified picker — same key, same vocabulary.
  const [viewMode, setViewMode] = useState<"all" | "channel">("channel");
  useEffect(() => {
    if (typeof window === "undefined") return;
    const saved = window.localStorage.getItem("dashboard.viewMode");
    if (saved === "all" || saved === "channel") setViewMode(saved);
  }, []);
  const [refreshing, setRefreshing] = useState(false);
  // Bumped each time the user hits Refresh — child components keyed off
  // this re-mount and re-fetch fresh data.
  const [refreshKey, setRefreshKey] = useState(0);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      // Bust the analytics-cache table on the server, then re-fetch
      // dashboard aggregates and force every refresh-key-aware child
      // (Studio Overview, today's earnings, multi-channel, etc.) to
      // re-fetch by changing their key.
      await fetch("/api/analytics/cache", { method: "POST" });
      const r = await fetch("/api/dashboard");
      const d = await r.json();
      setStats(d.stats);
      setChannel(d.channel);
      setRefreshKey((k) => k + 1);
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetch("/api/dashboard")
      .then((r) => r.json())
      .then((d) => {
        setStats(d.stats);
        setChannel(d.channel);
      })
      .catch(() => {});
  }, []);

  const hasData = (stats?.total ?? 0) > 0;

  return (
    <div className="mx-auto max-w-6xl">
      <header className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t.dashboard.title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {viewMode === "all"
              ? "All connected channels — combined view"
              : channel?.title
                ? channel.title
                : t.dashboard.subtitle}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            disabled={refreshing}
            className="gap-1.5"
            title="Bust the analytics cache and reload fresh data"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
            Refresh
          </Button>
          {channel && viewMode === "channel" && (
            <Link href="/channel-info">
              <Button variant="outline" size="sm" className="gap-2">
                <ArrowUpRight className="h-3.5 w-3.5" />
                {t.dashboard.channelDetails}
              </Button>
            </Link>
          )}
        </div>
      </header>

      <ConnectBanner />

      {/* Cross-channel summary view. AllChannelsOverview already nests
          MultiChannelEarnings inside itself, so the combined revenue card
          renders here without a second mount. TagsOverview is cross-channel
          by design (it sums revenue across every channel carrying each
          tag) so it belongs in this branch too. */}
      {viewMode === "all" && (
        <>
          <AllChannelsOverview key={`all-${refreshKey}`} />
          <TagsOverview key={`tg-${refreshKey}`} />
        </>
      )}

      {/* Per-channel widgets — hidden when "All channels" tab is active.
          `key={refreshKey}` forces a full re-mount when the user clicks
          Refresh, so each widget re-runs its useEffect and re-fetches
          freshly (after the server-side analytics cache was busted).
          SingleChannelEarnings is the single-channel sibling of
          MultiChannelEarnings — its title shows the channel name and
          every number is scoped to that channel via /api/analytics/revenue. */}
      {viewMode === "channel" && channel && (
        <>
          <SingleChannelEarnings
            key={`sce-${channel.id}-${refreshKey}`}
            channelTitle={channel.title ?? "This channel"}
          />
          <TodaysEarnings key={`te-${refreshKey}`} />
        </>
      )}

      {viewMode === "channel" && channel && <StudioOverview key={`so-${refreshKey}`} />}

      {viewMode === "channel" && !hasData && (
        <Card>
          <CardHeader>
            <CardTitle>{t.dashboard.emptyTitle}</CardTitle>
            <CardDescription>{t.dashboard.noData}</CardDescription>
          </CardHeader>
          <CardContent>
            <Link href="/settings/integrations">
              <Button size="sm" className="gap-2">
                Bind channel
              </Button>
            </Link>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

