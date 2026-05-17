import "server-only";

// Same stopword set used by validate-idea — keeps token-overlap math
// consistent across the two ideation guard-rails.
const STOPWORDS = new Set([
  "the","a","an","and","or","but","if","of","in","on","for","to","with",
  "is","are","was","were","be","been","this","that","these","those","i",
  "you","he","she","it","we","they","my","your","his","her","its","our",
  "their","do","does","did","done","have","has","had","not","no","yes",
  "at","by","from","as","than","then","so","very","what","when","where",
  "why","how","who","which","there","here","just","like","get","got",
  "make","made","will","would","can","could","should","shall","may",
  "might","one","two","three","new","video","videos","about","into",
  "over","out","off","up","down","why","what's","whats","thats","that's",
]);

function tokenize(s: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of s
    .toLowerCase()
    .replace(/[^a-zа-яёіїєґ0-9 ]+/giu, " ")
    .split(/\s+/)) {
    if (!raw) continue;
    if (raw.length < 4) continue;
    if (STOPWORDS.has(raw)) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

/**
 * Token-overlap originality score for a proposed title against one or
 * more source titles. Returns:
 *   { maxOverlap: float, originalityScore: float, worstSourceIndex: number }
 *
 *   overlap(proposed, source) = |tokens(proposed) ∩ tokens(source)|
 *                                  / max(1, |tokens(proposed)|)
 *
 * originalityScore = 1 - maxOverlap. Higher = more original. The chat-side
 * threshold is 0.6 maxOverlap (i.e. originalityScore < 0.4 triggers a
 * regenerate). Stopwords and tokens <4 chars are dropped so common
 * connector words don't poison the score.
 */
export function scoreOriginality(
  proposed: string,
  sources: string[]
): { maxOverlap: number; originalityScore: number; worstSourceIndex: number } {
  const proposedTokens = tokenize(proposed);
  if (proposedTokens.length === 0 || sources.length === 0) {
    return { maxOverlap: 0, originalityScore: 1, worstSourceIndex: -1 };
  }
  const proposedSet = new Set(proposedTokens);
  let maxOverlap = 0;
  let worstIdx = -1;
  for (let i = 0; i < sources.length; i++) {
    const sourceTokens = tokenize(sources[i]);
    if (sourceTokens.length === 0) continue;
    let shared = 0;
    for (const t of sourceTokens) {
      if (proposedSet.has(t)) shared++;
    }
    const overlap = shared / Math.max(1, proposedTokens.length);
    if (overlap > maxOverlap) {
      maxOverlap = overlap;
      worstIdx = i;
    }
  }
  return {
    maxOverlap,
    originalityScore: Math.max(0, 1 - maxOverlap),
    worstSourceIndex: worstIdx,
  };
}
