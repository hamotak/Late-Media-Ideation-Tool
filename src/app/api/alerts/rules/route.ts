import { NextResponse } from "next/server";
import {
  AlertRuleInput,
  createRule,
  ensureRulesSeed,
  listRules,
} from "@/lib/alerts";

export const runtime = "nodejs";

/**
 * Alert rule list + create. Each rule defines an independent alert
 * condition (velocity / milestone / delta-in-window) on a metric
 * (views / likes / comments) for a video scope (recent N / all). The
 * poll engine walks every enabled rule each tick.
 */
export async function GET() {
  ensureRulesSeed();
  return NextResponse.json({ rules: listRules() });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Partial<AlertRuleInput>;
  try {
    const rule = createRule(normalizeRuleInput(body));
    return NextResponse.json({ rule });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid rule" },
      { status: 400 }
    );
  }
}

/** Coerce loose JSON from the client into a typed rule input. */
function normalizeRuleInput(body: Partial<AlertRuleInput>): AlertRuleInput {
  return {
    enabled: body.enabled ?? true,
    name: (body.name ?? "").trim(),
    type: (body.type ?? "velocity") as AlertRuleInput["type"],
    metric: (body.metric ?? "views") as AlertRuleInput["metric"],
    threshold: Number(body.threshold ?? 0),
    windowMinutes:
      body.windowMinutes === null || body.windowMinutes === undefined
        ? null
        : Number(body.windowMinutes),
    scope: (body.scope ?? "recent_n") as AlertRuleInput["scope"],
    scopeValue:
      body.scopeValue === null || body.scopeValue === undefined
        ? null
        : Number(body.scopeValue),
    channelId: body.channelId ?? null,
    cooldownMinutes: Number(body.cooldownMinutes ?? 60),
    fireOnce: body.fireOnce ?? false,
  };
}
