// Matching of what is typed in the palette against names. Pure functions; higher scores are better matches.
//
//   fuzzyScore("wb1", "web-1")      // > 0: every character appears in order
//   fuzzyScore("web", "web-1")      // higher: a prefix
//   containsScore("kube", "kube-system") // a substring only (namespaces, kinds), never a scattered subsequence

/** Characters after which a new word starts (`web-1`, `kube.system`, `a/b`). */
const SEPARATORS = new Set(["-", "_", ".", "/", ":", " "]);

const EXACT = 1000;
const PREFIX = 800;
const SUBSTRING = 600;
const SUBSEQUENCE = 100;

/**
 * Score of `query` against `text`, ignoring case: an exact match beats a prefix, a prefix beats a substring (more
 * so at a word start), a substring beats characters scattered in order (more so when they run together or start
 * words). `null` when the characters of `query` do not all appear in `text` in order. An empty query scores 0.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase();
  const s = text.toLowerCase();
  if (q.length === 0) return 0;
  if (q.length > s.length) return null;
  if (s === q) return EXACT;
  if (s.startsWith(q)) return PREFIX - Math.min(s.length - q.length, 100);
  const at = s.indexOf(q);
  if (at >= 0) {
    const wordStart = SEPARATORS.has(s[at - 1] ?? "");
    return SUBSTRING + (wordStart ? 100 : 0) - Math.min(at, 50) - Math.min(s.length - q.length, 50);
  }
  let score = 0;
  let from = 0;
  let previous = -2;
  for (const ch of q) {
    const index = s.indexOf(ch, from);
    if (index < 0) return null;
    if (index === previous + 1) score += 8;
    if (index === 0 || SEPARATORS.has(s[index - 1] ?? "")) score += 10;
    score -= Math.min(index - from, 10);
    previous = index;
    from = index + 1;
  }
  return SUBSEQUENCE + Math.max(-90, Math.min(score, 400));
}

/** Like `fuzzyScore`, but only for `query` as a whole substring of `text` (no scattered characters). */
export function containsScore(query: string, text: string): number | null {
  const score = fuzzyScore(query, text);
  return score !== null && score >= SUBSTRING ? score : null;
}

/** The words of a query: split on whitespace, empty ones dropped. */
export function queryWords(query: string): string[] {
  return query.trim().split(/\s+/).filter(Boolean);
}
