import "server-only";
import fs from "node:fs";
import path from "node:path";

/**
 * Read MENTOR_METHOD.md from disk and extract specific sections by their
 * "## N. <title>" headers. Cached per process — the file is small and
 * stable. Used by every AI endpoint that needs to inline the methodology
 * into a system prompt (analyze-with-ai, outliers/explain, outliers/
 * generate-ideas, future steps).
 */

let cache: string | null = null;

export function loadMentorMethod(): string {
  if (cache !== null) return cache;
  try {
    // Walk up from cwd to find package.json, then read MENTOR_METHOD.md
    // alongside it. Same posture as src/lib/db.ts's findProjectRoot.
    let cur = process.cwd();
    for (let i = 0; i < 8; i++) {
      if (fs.existsSync(path.join(cur, "package.json"))) break;
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
    cache = fs.readFileSync(path.join(cur, "MENTOR_METHOD.md"), "utf8");
  } catch {
    cache = "";
  }
  return cache;
}

/**
 * Slice the methodology document down to a specific section by its
 * "## N. <title>" header. Returns the section body WITHOUT its own
 * header line. Empty string if the section isn't found — caller can
 * fall back to "(section unavailable)" or skip.
 */
export function extractSection(md: string, sectionNumber: number): string {
  const re = new RegExp(
    `^##\\s+${sectionNumber}\\.\\s+[^\\n]*\\n([\\s\\S]*?)(?=^##\\s+\\d+\\.|\\Z)`,
    "m"
  );
  const m = md.match(re);
  if (!m) return "";
  return m[1].trim();
}

/**
 * Vocabulary of "what made it work" lever names from §9, in the exact
 * casing the AI prompts mandate for JSON outputs. Used to validate
 * AI responses + render UI chips with consistent labels.
 */
export const LEVERS = [
  "Curiosity",
  "Nostalgia",
  "Counterintuitive",
  "Story most don't know",
  "Identity",
  "Authority",
  "Specificity",
  "Conflict",
  "Stakes",
  "Visual hook",
] as const;

export type Lever = (typeof LEVERS)[number];

export function isLever(v: unknown): v is Lever {
  return typeof v === "string" && (LEVERS as readonly string[]).includes(v);
}
