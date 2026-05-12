import { NextResponse } from "next/server";
import { searchComments } from "@/lib/db";

export const runtime = "nodejs";

/**
 * FTS5 search across cached comments. Used by the chat attachment picker.
 * Empty query returns an empty list — the UI shows a "type to search" hint.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit")) || 20));

  if (!q) return NextResponse.json({ comments: [] });

  const rows = searchComments(q, limit);
  return NextResponse.json({
    comments: rows.map((c) => ({
      id: c.id,
      videoId: c.video_id,
      videoTitle: c.video_title,
      parentId: c.parent_id,
      author: c.author,
      text: c.text,
      likeCount: c.like_count,
      replyCount: c.reply_count,
      publishedAt: c.published_at,
    })),
  });
}
