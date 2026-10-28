/**
 * Rendered-width yardstick.
 *
 * Character count is the wrong unit across scripts. Search engines truncate on
 * *rendered width* (roughly 600px for a title, ~920px for a description), and a
 * Chinese, Japanese or Korean character occupies about twice the width of a
 * Latin one — so a 40-character CJK title is a full-length title, not a stub.
 * Thai and Devanagari are not full-width and stay at 1 column.
 *
 * The range below is the set of blocks Unicode treats as wide; it is the same
 * one-big-regex trick the hishmate audit scripts use, kept verbatim because it
 * is the part that makes the numbers mean anything.
 */
export const FULL_WIDTH =
  /[\u1100-\u115F\u2E80-\uA4CF\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;

/** Rendered width of `s`: full-width characters count 2, everything else 1. */
export function width(s: string): number {
  let n = 0;
  for (const ch of s.trim()) n += FULL_WIDTH.test(ch) ? 2 : 1;
  return n;
}
