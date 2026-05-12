"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  Globe,
  Loader2,
  RefreshCw,
  Smartphone,
  Tv,
  Monitor,
  Tablet,
  HelpCircle,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
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
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Bundle = {
  period: { startDate: string; endDate: string; days: number };
  demographics: { ageGroup: string; gender: string; viewerPercentage: number }[];
  geography: { country: string; views: number; watchMinutes: number }[];
  devices: { deviceType: string; views: number; watchMinutes: number }[];
  trafficSources: { source: string; views: number; watchMinutes: number }[];
};

type Payload = {
  connected: boolean;
  period: string;
  audience: Bundle | null;
  error?: string;
};

const PERIODS = ["28d", "90d", "365d", "all"] as const;

const PIE_COLORS = [
  "hsl(var(--primary))",
  "#f59e0b",
  "#10b981",
  "#6366f1",
  "#ec4899",
  "#14b8a6",
  "#eab308",
  "#8b5cf6",
];

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return n.toLocaleString("en-US");
}

function sourceLabel(s: string): string {
  const map: Record<string, string> = {
    YT_SEARCH: "YouTube search",
    SUGGESTED_VIDEO: "Suggested videos",
    EXTERNAL: "External",
    BROWSE: "Browse features",
    PLAYLIST: "Playlist",
    YT_CHANNEL: "Channel page",
    YT_OTHER_PAGE: "Other YouTube",
    NOTIFICATION: "Notifications",
    SUBSCRIBER: "Subscribers feed",
    NO_LINK_OTHER: "Direct / unknown",
    NO_LINK_EMBEDDED: "Embedded player",
    SHORTS: "Shorts feed",
    HASHTAGS: "Hashtags",
    END_SCREEN: "End screen",
    ANNOTATION: "Cards / annotations",
    ADVERTISING: "Advertising",
    LIVE: "Live",
  };
  return map[s] ?? s;
}

function deviceIcon(d: string): React.ComponentType<{ className?: string }> {
  switch (d) {
    case "MOBILE":
      return Smartphone;
    case "DESKTOP":
      return Monitor;
    case "TABLET":
      return Tablet;
    case "TV":
      return Tv;
    default:
      return HelpCircle;
  }
}

/**
 * Channel-wide audience block: who watches, where they are, what they
 * watch on, how they got there. Lives on /channel as its own card. All
 * four sub-reports come back in one /api/analytics/audience round-trip.
 */
export function ChannelAudience() {
  const [period, setPeriod] = useState<string>("28d");
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    async (force = false) => {
      setLoading(true);
      try {
        const url = new URL("/api/analytics/audience", window.location.origin);
        url.searchParams.set("period", period);
        if (force) url.searchParams.set("nocache", "1");
        const res = await fetch(url.toString());
        const d = (await res.json()) as Payload;
        setData(d);
      } catch {
        /* keep prior */
      } finally {
        setLoading(false);
      }
    },
    [period]
  );

  useEffect(() => {
    load();
  }, [load]);

  // Not connected — silently render nothing. The dashboard already nudges
  // the user to connect; we don't need a second CTA on /channel.
  if (data && !data.connected) return null;

  if (data?.error) {
    const is403 = /\b403\b/.test(data.error);
    return (
      <Card className="mb-4 border-amber-500/40 bg-amber-500/5">
        <CardContent className="flex items-start gap-3 p-4 text-sm">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="flex-1">
            <div className="font-medium">
              {is403 ? "Audience analytics unavailable" : "Audience load failed"}
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">{data.error}</p>
          </div>
          <Button size="sm" variant="ghost" onClick={() => load(true)} className="gap-1.5">
            <RefreshCw className="h-3.5 w-3.5" />
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  const a = data?.audience;
  return (
    <Card className="mb-4">
      <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-3">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <Globe className="h-4 w-4 text-primary" />
            Audience
          </CardTitle>
          <CardDescription>
            Demographics, geography, devices, traffic — live from YouTube Analytics
          </CardDescription>
        </div>
        <div className="flex items-center gap-1">
          {PERIODS.map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={cn(
                "rounded px-2 py-1 text-xs font-medium transition-colors",
                period === p
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground"
              )}
            >
              {p}
            </button>
          ))}
          <button
            onClick={() => load(true)}
            disabled={loading}
            className="ml-1 rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
            aria-label="Refresh"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
          </button>
        </div>
      </CardHeader>

      <CardContent>
        {!a ? (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading audience…
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {/* Demographics */}
            {a.demographics.length > 0 && (
              <div>
                <h3 className="mb-2 text-sm font-medium">Demographics</h3>
                <Demographics rows={a.demographics} />
              </div>
            )}

            {/* Devices */}
            {a.devices.length > 0 && (
              <div>
                <h3 className="mb-2 text-sm font-medium">Devices</h3>
                <ul className="space-y-1.5">
                  {a.devices.map((d) => {
                    const Icon = deviceIcon(d.deviceType);
                    const total = a.devices.reduce((s, r) => s + r.views, 0) || 1;
                    const pct = (d.views / total) * 100;
                    return (
                      <li key={d.deviceType} className="flex items-center gap-2 text-xs">
                        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="w-20 shrink-0 capitalize">
                          {d.deviceType.toLowerCase()}
                        </span>
                        <div className="flex-1">
                          <div className="relative h-2 rounded bg-muted">
                            <div
                              className="absolute inset-y-0 left-0 rounded bg-primary"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        </div>
                        <span className="w-10 shrink-0 text-right tabular-nums">
                          {pct.toFixed(0)}%
                        </span>
                        <span className="w-14 shrink-0 text-right text-muted-foreground tabular-nums">
                          {fmt(d.views)}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            {/* Top countries */}
            {a.geography.length > 0 && (
              <div>
                <h3 className="mb-2 text-sm font-medium">Top countries</h3>
                <div className="h-[260px] w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={a.geography.slice(0, 12)}
                      layout="vertical"
                      margin={{ top: 4, right: 8, left: 8, bottom: 0 }}
                    >
                      <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" horizontal={false} />
                      <XAxis
                        type="number"
                        stroke="hsl(var(--muted-foreground))"
                        fontSize={10}
                        tickLine={false}
                        axisLine={false}
                        tickFormatter={(v: number) => fmt(v)}
                      />
                      <YAxis
                        type="category"
                        dataKey="country"
                        stroke="hsl(var(--muted-foreground))"
                        fontSize={10}
                        tickLine={false}
                        axisLine={false}
                        width={32}
                      />
                      <Tooltip
                        contentStyle={{
                          background: "hsl(var(--card))",
                          border: "1px solid hsl(var(--border))",
                          borderRadius: 6,
                          fontSize: 12,
                        }}
                        formatter={(value) => [fmt(Number(value) || 0), "Views"]}
                      />
                      <Bar dataKey="views" fill="hsl(var(--primary))" radius={[0, 3, 3, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}

            {/* Traffic sources */}
            {a.trafficSources.length > 0 && (
              <div>
                <h3 className="mb-2 text-sm font-medium">Traffic sources</h3>
                <div className="h-[220px] w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={a.trafficSources}
                        dataKey="views"
                        nameKey="source"
                        innerRadius={45}
                        outerRadius={75}
                        paddingAngle={2}
                      >
                        {a.trafficSources.map((_, i) => (
                          <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip
                        contentStyle={{
                          background: "hsl(var(--card))",
                          border: "1px solid hsl(var(--border))",
                          borderRadius: 6,
                          fontSize: 12,
                        }}
                        formatter={(value, name) => [fmt(Number(value) || 0), sourceLabel(String(name))]}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <ul className="mt-1 space-y-0.5 text-xs">
                  {a.trafficSources.slice(0, 6).map((s, i) => (
                    <li key={s.source} className="flex items-center gap-2">
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ background: PIE_COLORS[i % PIE_COLORS.length] }}
                      />
                      <span className="flex-1 truncate">{sourceLabel(s.source)}</span>
                      <span className="tabular-nums text-muted-foreground">{fmt(s.views)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Demographics({
  rows,
}: {
  rows: { ageGroup: string; gender: string; viewerPercentage: number }[];
}) {
  const ages = Array.from(
    new Set(rows.map((r) => r.ageGroup).sort((a, b) => a.localeCompare(b)))
  );
  const data = ages.map((age) => {
    const male =
      rows.find(
        (r) => r.ageGroup === age && /male/i.test(r.gender) && !/female/i.test(r.gender)
      )?.viewerPercentage ?? 0;
    const female =
      rows.find((r) => r.ageGroup === age && /female/i.test(r.gender))?.viewerPercentage ?? 0;
    const other =
      rows.find((r) => r.ageGroup === age && !/male|female/i.test(r.gender))?.viewerPercentage ?? 0;
    return {
      age: age.replace("age", ""),
      male: Number(male.toFixed(1)),
      female: Number(female.toFixed(1)),
      other: Number(other.toFixed(1)),
    };
  });
  return (
    <div className="h-[220px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="age"
            stroke="hsl(var(--muted-foreground))"
            fontSize={10}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            stroke="hsl(var(--muted-foreground))"
            fontSize={10}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v: number) => `${v}%`}
          />
          <Tooltip
            contentStyle={{
              background: "hsl(var(--card))",
              border: "1px solid hsl(var(--border))",
              borderRadius: 6,
              fontSize: 12,
            }}
            formatter={(value, name) => [
              `${value}%`,
              String(name).charAt(0).toUpperCase() + String(name).slice(1),
            ]}
          />
          <Bar dataKey="male" stackId="a" fill="#3b82f6" />
          <Bar dataKey="female" stackId="a" fill="#ec4899" />
          <Bar dataKey="other" stackId="a" fill="#94a3b8" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
