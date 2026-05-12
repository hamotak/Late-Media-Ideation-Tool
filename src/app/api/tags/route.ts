import { NextResponse } from "next/server";
import { createTag, getTagByName, listTags } from "@/lib/db";

export const runtime = "nodejs";

/**
 * Tag CRUD. Each tag is a free-form label that can optionally carry a
 * `cut_percent` — when set, the dashboard subtracts that % from the
 * revenue of every channel tagged with it. Used to model CMS / network
 * deals, AdSense splits, etc.
 */
export async function GET() {
  return NextResponse.json({ tags: listTags() });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    name?: string;
    cut_percent?: number | null;
    color?: string | null;
  };
  const name = (body.name ?? "").trim();
  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  if (
    body.cut_percent !== null &&
    body.cut_percent !== undefined &&
    (typeof body.cut_percent !== "number" ||
      !Number.isFinite(body.cut_percent) ||
      body.cut_percent < 0 ||
      body.cut_percent > 100)
  ) {
    return NextResponse.json(
      { error: "cut_percent must be a number between 0 and 100" },
      { status: 400 }
    );
  }

  // Idempotent on name (UNIQUE COLLATE NOCASE) — return the existing tag
  // if the user posted a duplicate name. Saves a round-trip in the UI.
  const existing = getTagByName(name);
  if (existing) {
    return NextResponse.json({ tag: existing, alreadyExisted: true });
  }
  const tag = createTag({
    name,
    cut_percent: body.cut_percent ?? null,
    color: body.color ?? null,
  });
  return NextResponse.json({ tag });
}
