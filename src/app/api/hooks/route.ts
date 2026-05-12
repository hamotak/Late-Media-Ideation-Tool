import { NextResponse } from "next/server";
import { HOOK_FORMULAS, listHooksWithVideos, type HookFormula } from "@/lib/db";

export const runtime = "nodejs";

/**
 * GET /api/hooks?formula=...&orderBy=score|views|recent&limit=200
 *
 * Returns hooks joined to their source videos. Drives the Rankings
 * and Video Cards tabs on /hooks — both want the same data, just
 * different views over it.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const formulaParam = url.searchParams.get("formula");
  const formula =
    formulaParam && (HOOK_FORMULAS as readonly string[]).includes(formulaParam)
      ? (formulaParam as HookFormula)
      : undefined;
  const orderByParam = url.searchParams.get("orderBy") as
    | "score"
    | "views"
    | "recent"
    | null;
  const orderBy =
    orderByParam === "views" || orderByParam === "recent" ? orderByParam : "score";
  const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? 200)));
  const hooks = listHooksWithVideos({ formula, orderBy, limit });
  return NextResponse.json({ hooks });
}
