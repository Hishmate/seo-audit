/** Sitemap reading: `<loc>` extraction, sitemap indexes, file or URL input. */
import { readFileSync } from "node:fs";
import { fetchPage } from "./fetch.js";

export function extractLocs(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((m) => (m[1] ?? "").trim()).filter(Boolean);
}

export function isSitemapIndex(xml: string): boolean {
  return /<sitemapindex[\s>]/i.test(xml);
}

export interface SitemapSource {
  /** Human-readable description of where the URLs came from. */
  label: string;
  urls: string[];
}

/** Reads a sitemap from an http(s) URL or a local file path. */
export async function readSitemap(
  source: string,
  opts: { timeoutMs?: number; userAgent?: string } = {},
): Promise<SitemapSource> {
  const body = /^https?:\/\//i.test(source)
    ? (await fetchPage(source, opts)).body
    : readFileSync(source, "utf8");

  if (isSitemapIndex(body)) {
    // A sitemap index points at child sitemaps. One level of recursion is
    // enough for every generator in practice, and bounds the worst case.
    const children = extractLocs(body).slice(0, 50);
    const urls: string[] = [];
    for (const child of children) {
      const childBody = /^https?:\/\//i.test(child)
        ? (await fetchPage(child, opts)).body
        : safeRead(child);
      urls.push(...extractLocs(childBody));
    }
    return { label: `${source} (index of ${children.length})`, urls };
  }
  return { label: source, urls: extractLocs(body) };
}

function safeRead(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}
