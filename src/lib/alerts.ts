import "server-only";
import { db, getActiveChannelId, getIntegration, getSetting, setSetting } from "./db";
import { fetchVideos, YouTubeApiError } from "./youtube";
import { sendTelegramMessage, isTelegramConfigured } from "./telegram";
import { log } from "./logger";

/**
 * Rule-based alert engine.
 *
 * Each poll:
 *   1. Reads every enabled rule from `alert_rules`.
 *   2. For each rule, picks the videos in scope (recent N / all in
 *      channel), fetches their current views/likes/comments via YouTube
 *      Data API.
 *   3. Records a unified snapshot into `video_view_snapshots`.
 *   4. Evaluates every rule against every in-scope video and fires a
 *      Telegram message when the rule's condition is met (subject to
 *      per-rule cooldown / fire_once gates).
 *
 * Why one big poll instead of N polls per rule: every rule type
 * needs the same fresh `videos.list` data from YouTube, and snapshots
 * are shared between rule types (a "views/hour > 500" rule and a "100k
 * views milestone" rule both consume the same view-count snapshot).
 * Polling once per cron tick keeps API quota minimal.
 */

// -------------------- Types --------------------

export type AlertRuleType = "velocity" | "total_milestone" | "delta_window";
export type AlertMetric = "views" | "likes" | "comments";
export type AlertScope = "recent_n" | "all";

export type AlertRule = {
  id: number;
  enabled: boolean;
  name: string;
  type: AlertRuleType;
  metric: AlertMetric;
  threshold: number;
  /** For velocity / delta_window: how far back to compare. Ignored for
   * total_milestone. */
  windowMinutes: number | null;
  scope: AlertScope;
  /** For scope=recent_n: how many recent uploads to monitor. */
  scopeValue: number | null;
  /** Null = whichever channel is active at poll time. Specific id pins
   * the rule to a single channel even when the user switches the active
   * channel in the UI (useful for "alert me when channel A hits 1M").  */
  channelId: string | null;
  cooldownMinutes: number;
  fireOnce: boolean;
  createdAt: number;
  updatedAt: number;
};

export type AlertRuleInput = Omit<AlertRule, "id" | "createdAt" | "updatedAt">;

export type AlertFire = {
  id: number;
  ruleId: number;
  videoId: string;
  firedAt: number;
  metricValue: number | null;
  delivered: boolean;
  error: string | null;
};

// -------------------- CRUD --------------------

type RuleRow = {
  id: number;
  enabled: number;
  name: string;
  type: AlertRuleType;
  metric: AlertMetric;
  threshold: number;
  window_minutes: number | null;
  scope: AlertScope;
  scope_value: number | null;
  channel_id: string | null;
  cooldown_minutes: number;
  fire_once: number;
  created_at: number;
  updated_at: number;
};

function rowToRule(r: RuleRow): AlertRule {
  return {
    id: r.id,
    enabled: r.enabled === 1,
    name: r.name,
    type: r.type,
    metric: r.metric,
    threshold: r.threshold,
    windowMinutes: r.window_minutes,
    scope: r.scope,
    scopeValue: r.scope_value,
    channelId: r.channel_id,
    cooldownMinutes: r.cooldown_minutes,
    fireOnce: r.fire_once === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function listRules(): AlertRule[] {
  const rows = db
    .prepare(`SELECT * FROM alert_rules ORDER BY enabled DESC, id ASC`)
    .all() as RuleRow[];
  return rows.map(rowToRule);
}

export function getRule(id: number): AlertRule | null {
  const row = db
    .prepare(`SELECT * FROM alert_rules WHERE id = ?`)
    .get(id) as RuleRow | undefined;
  return row ? rowToRule(row) : null;
}

export function createRule(input: AlertRuleInput): AlertRule {
  validateRule(input);
  const info = db
    .prepare(
      `INSERT INTO alert_rules (
        enabled, name, type, metric, threshold, window_minutes,
        scope, scope_value, channel_id, cooldown_minutes, fire_once,
        created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                strftime('%s','now'), strftime('%s','now'))`
    )
    .run(
      input.enabled ? 1 : 0,
      input.name,
      input.type,
      input.metric,
      input.threshold,
      input.windowMinutes,
      input.scope,
      input.scopeValue,
      input.channelId,
      input.cooldownMinutes,
      input.fireOnce ? 1 : 0
    );
  return getRule(Number(info.lastInsertRowid))!;
}

export function updateRule(id: number, patch: Partial<AlertRuleInput>): AlertRule | null {
  const existing = getRule(id);
  if (!existing) return null;
  const merged: AlertRuleInput = { ...existing, ...patch };
  validateRule(merged);
  db.prepare(
    `UPDATE alert_rules SET
       enabled = ?, name = ?, type = ?, metric = ?, threshold = ?,
       window_minutes = ?, scope = ?, scope_value = ?, channel_id = ?,
       cooldown_minutes = ?, fire_once = ?, updated_at = strftime('%s','now')
     WHERE id = ?`
  ).run(
    merged.enabled ? 1 : 0,
    merged.name,
    merged.type,
    merged.metric,
    merged.threshold,
    merged.windowMinutes,
    merged.scope,
    merged.scopeValue,
    merged.channelId,
    merged.cooldownMinutes,
    merged.fireOnce ? 1 : 0,
    id
  );
  return getRule(id);
}

export function deleteRule(id: number): boolean {
  const info = db.prepare(`DELETE FROM alert_rules WHERE id = ?`).run(id);
  return info.changes > 0;
}

function validateRule(r: AlertRuleInput): void {
  if (!r.name?.trim()) throw new Error("Rule name is required");
  if (!["velocity", "total_milestone", "delta_window"].includes(r.type)) {
    throw new Error(`Unknown rule type: ${r.type}`);
  }
  if (!["views", "likes", "comments"].includes(r.metric)) {
    throw new Error(`Unknown metric: ${r.metric}`);
  }
  if (!Number.isFinite(r.threshold) || r.threshold <= 0) {
    throw new Error("Threshold must be a positive number");
  }
  if (r.type !== "total_milestone") {
    if (!r.windowMinutes || r.windowMinutes < 5) {
      throw new Error("windowMinutes ≥ 5 required for velocity / delta_window rules");
    }
  }
  if (!["recent_n", "all"].includes(r.scope)) {
    throw new Error(`Unknown scope: ${r.scope}`);
  }
  if (r.scope === "recent_n" && (!r.scopeValue || r.scopeValue < 1 || r.scopeValue > 100)) {
    throw new Error("recent_n scope requires scopeValue between 1 and 100");
  }
  if (r.cooldownMinutes < 0) throw new Error("cooldownMinutes must be ≥ 0");
}

// -------------------- One-time migration from legacy single-rule config -----

const LEGACY_THRESHOLD_KEY = "alerts.velocityViewsPerHour";
const LEGACY_MONITORED_KEY = "alerts.monitoredVideoCount";
const LEGACY_MIGRATED_FLAG = "alerts.legacyMigrated";

/**
 * If the user previously configured the single-rule velocity alert,
 * promote it into a row in `alert_rules` so they don't lose their
 * settings. Idempotent — once migrated, never runs again. Also seeds
 * a sensible default rule on a fresh install so the user has something
 * to look at on first visit to /alerts.
 */
export function ensureRulesSeed(): void {
  if (getSetting(LEGACY_MIGRATED_FLAG) === "1") return;
  const existing = listRules();
  if (existing.length > 0) {
    setSetting(LEGACY_MIGRATED_FLAG, "1");
    return;
  }
  const legacyThreshold = Number(getSetting(LEGACY_THRESHOLD_KEY) ?? 100);
  const legacyMonitored = Number(getSetting(LEGACY_MONITORED_KEY) ?? 10);
  createRule({
    enabled: true,
    name: "Recent uploads — views/hour spike",
    type: "velocity",
    metric: "views",
    threshold: legacyThreshold,
    windowMinutes: 60,
    scope: "recent_n",
    scopeValue: legacyMonitored,
    channelId: null,
    cooldownMinutes: 60,
    fireOnce: false,
  });
  setSetting(LEGACY_MIGRATED_FLAG, "1");
}

// -------------------- Master switch + alert config (compat) -----------------

const ENABLED_KEY = "alerts.enabled";

export type AlertConfig = {
  enabled: boolean;
};

export function getAlertConfig(): AlertConfig {
  return { enabled: getSetting(ENABLED_KEY) === "1" };
}

export function setAlertConfig(patch: Partial<AlertConfig>): void {
  if (patch.enabled !== undefined) {
    setSetting(ENABLED_KEY, patch.enabled ? "1" : "0");
  }
}

// -------------------- Snapshot helpers --------------------

type Snapshot = { ts: number; views: number; likes: number | null; comments: number | null };

function recordSnapshot(videoId: string, ts: number, views: number, likes: number, comments: number) {
  db.prepare(
    `INSERT INTO video_view_snapshots (video_id, ts, views, likes, comments)
     VALUES (?, ?, ?, ?, ?)`
  ).run(videoId, ts, views, likes, comments);
}

function findPriorSnapshot(videoId: string, atOrBefore: number): Snapshot | null {
  return (
    db
      .prepare(
        `SELECT ts, views, likes, comments FROM video_view_snapshots
         WHERE video_id = ? AND ts <= ?
         ORDER BY ts DESC LIMIT 1`
      )
      .get(videoId, atOrBefore) as Snapshot | undefined
  ) ?? null;
}

function metricFromSnapshot(s: Snapshot | { views: number; likes: number; comments: number }, m: AlertMetric): number {
  if (m === "views") return s.views;
  if (m === "likes") return s.likes ?? 0;
  if (m === "comments") return s.comments ?? 0;
  return 0;
}

// -------------------- Fires (cooldown / once) --------------------

function lastFireFor(ruleId: number, videoId: string): { firedAt: number } | null {
  const row = db
    .prepare(
      `SELECT fired_at FROM alert_fires
       WHERE rule_id = ? AND video_id = ? AND delivered = 1
       ORDER BY fired_at DESC LIMIT 1`
    )
    .get(ruleId, videoId) as { fired_at: number } | undefined;
  return row ? { firedAt: row.fired_at } : null;
}

function recordFire(ruleId: number, videoId: string, metricValue: number, delivered: boolean, error?: string) {
  db.prepare(
    `INSERT INTO alert_fires (rule_id, video_id, fired_at, metric_value, delivered, error)
     VALUES (?, ?, strftime('%s','now'), ?, ?, ?)`
  ).run(ruleId, videoId, metricValue, delivered ? 1 : 0, error ?? null);
}

export function listRecentFires(limit = 50): (AlertFire & { ruleName: string | null; videoTitle: string | null })[] {
  return db
    .prepare(
      `SELECT f.id, f.rule_id as ruleId, f.video_id as videoId,
              f.fired_at as firedAt, f.metric_value as metricValue,
              f.delivered, f.error,
              r.name as ruleName, v.title as videoTitle
       FROM alert_fires f
       LEFT JOIN alert_rules r ON r.id = f.rule_id
       LEFT JOIN videos v ON v.id = f.video_id
       ORDER BY f.fired_at DESC
       LIMIT ?`
    )
    .all(limit) as never;
}

// -------------------- Poll engine --------------------

export type PollResult = {
  ok: boolean;
  monitoredCount: number;
  alertsFired: number;
  rulesEvaluated: number;
  errors: string[];
  snapshotsRecorded: number;
};

export async function runAlertPoll(): Promise<PollResult> {
  ensureRulesSeed();
  const errors: string[] = [];
  let alertsFired = 0;
  let snapshotsRecorded = 0;

  const masterCfg = getAlertConfig();
  if (!masterCfg.enabled) {
    return {
      ok: true,
      monitoredCount: 0,
      alertsFired: 0,
      rulesEvaluated: 0,
      errors: ["alerts disabled"],
      snapshotsRecorded: 0,
    };
  }

  const apiKey = getIntegration("youtube")?.api_key;
  if (!apiKey) {
    return {
      ok: false,
      monitoredCount: 0,
      alertsFired: 0,
      rulesEvaluated: 0,
      errors: ["YouTube API key not configured"],
      snapshotsRecorded: 0,
    };
  }

  const rules = listRules().filter((r) => r.enabled);
  if (rules.length === 0) {
    return {
      ok: true,
      monitoredCount: 0,
      alertsFired: 0,
      rulesEvaluated: 0,
      errors: ["no enabled rules"],
      snapshotsRecorded: 0,
    };
  }

  if (!isTelegramConfigured()) {
    errors.push("Telegram not configured (snapshots still recorded)");
  }

  // Collect every video ID across every rule so we hit YouTube once per
  // video regardless of how many rules reference it. Also remember which
  // rules apply to which videos for the evaluation pass below.
  const activeChannelId = getActiveChannelId();
  const videoIdsByRule = new Map<number, { id: string; title: string }[]>();
  const allVideoIds = new Set<string>();
  for (const rule of rules) {
    const channelId = rule.channelId ?? activeChannelId;
    const vids = pickVideosForRule(rule, channelId);
    videoIdsByRule.set(rule.id, vids);
    for (const v of vids) allVideoIds.add(v.id);
  }

  if (allVideoIds.size === 0) {
    return {
      ok: true,
      monitoredCount: 0,
      alertsFired: 0,
      rulesEvaluated: rules.length,
      errors: ["no videos in scope for any enabled rule"],
      snapshotsRecorded: 0,
    };
  }

  // Single batched fetch for all video IDs across all rules.
  let liveStats: Awaited<ReturnType<typeof fetchVideos>>;
  try {
    liveStats = await fetchVideos(Array.from(allVideoIds), apiKey);
  } catch (err) {
    if (err instanceof YouTubeApiError) {
      errors.push(`YT API ${err.status}: ${err.message}`);
    } else {
      errors.push(err instanceof Error ? err.message : String(err));
    }
    return {
      ok: false,
      monitoredCount: allVideoIds.size,
      alertsFired: 0,
      rulesEvaluated: rules.length,
      errors,
      snapshotsRecorded: 0,
    };
  }

  // Index live data by video id for fast lookup during rule evaluation.
  const liveById = new Map<string, (typeof liveStats)[number]>();
  for (const v of liveStats) liveById.set(v.id, v);

  const now = Math.floor(Date.now() / 1000);
  // Record one snapshot per fetched video — shared across all rules.
  for (const live of liveStats) {
    recordSnapshot(live.id, now, live.views, live.likes, live.comments);
    snapshotsRecorded++;
  }

  // Evaluate each rule against its scoped video set.
  for (const rule of rules) {
    const scopedVideos = videoIdsByRule.get(rule.id) ?? [];
    for (const meta of scopedVideos) {
      const live = liveById.get(meta.id);
      if (!live) continue;
      const title = meta.title || live.title || meta.id;
      try {
        const fired = await evaluateAndMaybeFire(rule, meta.id, title, live, now);
        if (fired) alertsFired++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`rule#${rule.id} ${meta.id}: ${msg}`);
      }
    }
  }

  // Trim snapshots older than 7 days.
  db.prepare(
    `DELETE FROM video_view_snapshots WHERE ts < strftime('%s','now') - 7 * 86400`
  ).run();

  return {
    ok: true,
    monitoredCount: allVideoIds.size,
    alertsFired,
    rulesEvaluated: rules.length,
    errors,
    snapshotsRecorded,
  };
}

function pickVideosForRule(
  rule: AlertRule,
  channelId: string | null
): { id: string; title: string }[] {
  const channelClause = channelId ? "AND channel_id = ?" : "";
  if (rule.scope === "recent_n") {
    const n = rule.scopeValue ?? 10;
    const args = channelId ? [channelId, n] : [n];
    return db
      .prepare(
        `SELECT id, title FROM videos
         WHERE published_at IS NOT NULL ${channelClause}
         ORDER BY published_at DESC
         LIMIT ?`
      )
      .all(...args) as { id: string; title: string }[];
  }
  // scope === "all"
  if (channelId) {
    return db
      .prepare(`SELECT id, title FROM videos WHERE channel_id = ?`)
      .all(channelId) as { id: string; title: string }[];
  }
  return db.prepare(`SELECT id, title FROM videos`).all() as {
    id: string;
    title: string;
  }[];
}

async function evaluateAndMaybeFire(
  rule: AlertRule,
  videoId: string,
  title: string,
  live: { id: string; views: number; likes: number; comments: number },
  now: number
): Promise<boolean> {
  // Cooldown / fire_once gating.
  const lastFire = lastFireFor(rule.id, videoId);
  if (rule.fireOnce && lastFire) return false;
  if (
    !rule.fireOnce &&
    lastFire &&
    now - lastFire.firedAt < rule.cooldownMinutes * 60
  ) {
    return false;
  }

  const currentMetric = metricFromSnapshot(live, rule.metric);

  let triggered = false;
  let context: { delta?: number; elapsedMin?: number; rate?: number } = {};

  if (rule.type === "total_milestone") {
    triggered = currentMetric >= rule.threshold;
  } else {
    // velocity or delta_window — both need a prior snapshot.
    const window = rule.windowMinutes ?? 60;
    const cutoff = now - window * 60;
    const prior = findPriorSnapshot(videoId, cutoff);
    if (!prior) return false; // not enough history yet
    const elapsedMin = Math.max(1, (now - prior.ts) / 60);
    const priorMetric = metricFromSnapshot(prior, rule.metric);
    const delta = currentMetric - priorMetric;
    if (rule.type === "velocity") {
      const rate = (delta / elapsedMin) * 60; // metric per hour
      triggered = rate >= rule.threshold;
      context = { delta, elapsedMin, rate };
    } else if (rule.type === "delta_window") {
      triggered = delta >= rule.threshold;
      context = { delta, elapsedMin };
    }
  }

  if (!triggered) return false;

  const message = formatRuleMessage(rule, videoId, title, currentMetric, context);
  let delivered = true;
  let errorMsg: string | undefined;
  if (isTelegramConfigured()) {
    const r = await sendTelegramMessage(message);
    if (!r.ok) {
      delivered = false;
      errorMsg = r.error;
    }
  } else {
    // No Telegram configured — record the fire as undelivered so user
    // can see in the recent-fires feed that something would have fired.
    delivered = false;
    errorMsg = "Telegram not configured";
  }
  recordFire(rule.id, videoId, currentMetric, delivered, errorMsg);
  log.info("alerts", `Rule fired: ${rule.name}`, {
    ruleId: rule.id,
    videoId,
    metric: rule.metric,
    metricValue: currentMetric,
    threshold: rule.threshold,
    delivered,
    error: errorMsg,
  });
  return delivered;
}

function metricLabel(m: AlertMetric): string {
  if (m === "views") return "views";
  if (m === "likes") return "likes";
  return "comments";
}

function formatRuleMessage(
  rule: AlertRule,
  videoId: string,
  title: string,
  currentMetric: number,
  ctx: { delta?: number; elapsedMin?: number; rate?: number }
): string {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const safeTitle = escapeHtml(title);
  const lines: string[] = [];
  if (rule.type === "total_milestone") {
    lines.push(`🎯 <b>Milestone reached</b>`);
    lines.push("");
    lines.push(`<a href="${url}">${safeTitle}</a>`);
    lines.push("");
    lines.push(
      `Hit <b>${currentMetric.toLocaleString("en-US")}</b> ${metricLabel(rule.metric)}` +
        ` (threshold ${rule.threshold.toLocaleString("en-US")}).`
    );
  } else if (rule.type === "velocity") {
    const rate = Math.round(ctx.rate ?? 0);
    const delta = ctx.delta ?? 0;
    const min = Math.round(ctx.elapsedMin ?? 0);
    lines.push(`🔥 <b>Heating up</b>`);
    lines.push("");
    lines.push(`<a href="${url}">${safeTitle}</a>`);
    lines.push("");
    lines.push(
      `+${delta.toLocaleString("en-US")} ${metricLabel(rule.metric)} in last ${min} min`
    );
    lines.push(
      `Velocity: <b>${rate.toLocaleString("en-US")}</b> ${metricLabel(rule.metric)}/hour`
    );
    lines.push(`Total: ${currentMetric.toLocaleString("en-US")} ${metricLabel(rule.metric)}`);
  } else {
    // delta_window
    const delta = ctx.delta ?? 0;
    const min = Math.round(ctx.elapsedMin ?? 0);
    lines.push(`📈 <b>Burst</b>`);
    lines.push("");
    lines.push(`<a href="${url}">${safeTitle}</a>`);
    lines.push("");
    lines.push(
      `+${delta.toLocaleString("en-US")} ${metricLabel(rule.metric)} in last ${min} min`
    );
    lines.push(`Total: ${currentMetric.toLocaleString("en-US")} ${metricLabel(rule.metric)}`);
  }
  lines.push("");
  lines.push(`<i>rule: ${escapeHtml(rule.name)}</i>`);
  return lines.join("\n");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
