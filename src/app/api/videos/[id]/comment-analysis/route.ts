import { NextResponse } from "next/server";
import { getCommentAnalysis } from "@/lib/db";
import { analyzeVideoComments } from "@/lib/comment-analyzer";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * GET /api/videos/:id/comment-analysis
 *
 * Returns the cached AI analysis for a video, or { analysis: null }
 * if nothing's been computed yet. Parses the JSON-stored sub-fields
 * (themes, objections, future_ideas, hook_candidates) into proper
 * arrays so the UI doesn't have to re-parse.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const cached = getCommentAnalysis(id);
  if (!cached) return NextResponse.json({ analysis: null });
  const safeParse = <T>(s: string | null, fallback: T): T => {
    if (!s) return fallback;
    try {
      return JSON.parse(s) as T;
    } catch {
      return fallback;
    }
  };
  return NextResponse.json({
    analysis: {
      ...cached,
      themes: safeParse(cached.themes, [] as string[]),
      objections: safeParse(cached.objections, [] as Array<{
        text: string;
        severity: string;
      }>),
      future_ideas: safeParse(cached.future_ideas, [] as Array<{
        title: string;
        demand: string;
        evidence: string;
      }>),
      hook_candidates: safeParse(cached.hook_candidates, [] as Array<{
        author: string;
        quote: string;
        why: string;
      }>),
    },
  });
}

/**
 * POST /api/videos/:id/comment-analysis
 *
 * Kicks off a fresh Claude analysis run. Always overwrites the
 * previous row — the user clicked because they wanted current data.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const result = await analyzeVideoComments(id);
  if (!result.ok) {
    return NextResponse.json({ error: result.reason }, { status: 400 });
  }
  return NextResponse.json({
    ok: true,
    commentsCount: result.commentsCount,
    sentimentScore: result.sentimentScore,
  });
}
