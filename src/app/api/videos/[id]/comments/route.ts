import { NextResponse } from "next/server";
import { getVideo, listTopLevelComments, commentCount } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!getVideo(id)) {
    return NextResponse.json({ error: "video not found" }, { status: 404 });
  }

  const url = new URL(req.url);
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 50));
  const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);

  const comments = listTopLevelComments(id, limit, offset);
  const summary = commentCount(id);

  return NextResponse.json({
    comments,
    summary,
    pagination: { limit, offset, returned: comments.length },
  });
}
