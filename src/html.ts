/**
 * HTML extraction.
 *
 * Meta tags are matched as real tags (`<meta name="description" content=…>`)
 * rather than by searching for a substring: modern pages inline entire JS
 * payloads into the document, so "this string appears somewhere in the HTML"
 * is true for almost any string and proves nothing.
 *
 * This is deliberately a small, honest subset of an HTML parser — enough for
 * the head-level signals an SEO audit reads, and nothing that would pretend to
 * understand the body.
 */

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** First capture group (or the whole match) of `re` in `html`, or null. */
function first(html: string, re: RegExp): string | null {
  const m = html.match(re);
  return m ? (m[1] ?? m[0]) : null;
}

const attrOf = (tag: string, attr: string) =>
  first(tag, new RegExp(`${attr}=["']([^"']*)["']`, "i"));

/** `<meta name="…" content="…">`, in either attribute order. */
export function metaContent(html: string, name: string): string | null {
  const n = escapeRe(name);
  return (
    first(html, new RegExp(`<meta[^>]+name=["']${n}["'][^>]*content=["']([^"']*)["']`, "i")) ??
    first(html, new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*name=["']${n}["']`, "i"))
  );
}

/** `<meta property="og:…" content="…">`. */
export function propContent(html: string, property: string): string | null {
  const p = escapeRe(property);
  return first(
    html,
    new RegExp(`<meta[^>]+property=["']${p}["'][^>]*content=["']([^"']*)["']`, "i"),
  );
}

/** Contents of `<title>`, or null when absent. */
export function pageTitle(html: string): string | null {
  return first(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
}

/** First `<link rel="canonical" href="…">`, or null. */
export function canonicalHref(html: string): string | null {
  const tags = linkTags(html, "canonical");
  for (const t of tags) {
    const href = attrOf(t, "href");
    if (href) return href;
  }
  return null;
}

export interface AlternateLink {
  hreflang: string;
  href: string;
  raw: string;
}

/** Every `<link rel="alternate" hreflang="…" href="…">`. */
export function alternateLinks(html: string): AlternateLink[] {
  const out: AlternateLink[] = [];
  for (const tag of linkTags(html, "alternate")) {
    const hreflang = attrOf(tag, "hreflang");
    const href = attrOf(tag, "href");
    if (hreflang && href) out.push({ hreflang, href, raw: tag });
  }
  return out;
}

function linkTags(html: string, rel: string): string[] {
  const re = new RegExp(`<link\\b[^>]*\\brel=["']${escapeRe(rel)}["'][^>]*>`, "gi");
  return [...html.matchAll(re)].map((m) => m[0]);
}

export interface JsonLdBlock {
  value?: unknown;
  error?: string;
}

/**
 * Every `<script type="application/ld+json">` block, JSON.parsed.
 *
 * Frameworks that inline data into HTML escape the payload's quotes and angle
 * brackets, so the common entities are decoded before parsing — an unparsable
 * block is reported as an error object, never thrown, because a crawler
 * silently ignores exactly those blocks.
 */
export function jsonLdBlocks(html: string): JsonLdBlock[] {
  const out: JsonLdBlock[] = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    const raw = (m[1] ?? "")
      .replace(/&quot;/g, '"')
      .replace(/&#x27;|&#39;/g, "'")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/\\u003c/g, "<");
    try {
      out.push({ value: JSON.parse(raw) });
    } catch (e) {
      out.push({ error: String(e).slice(0, 120) });
    }
  }
  return out;
}

/**
 * Every `@type` reachable from a JSON-LD node, including the nesting search
 * engines actually walk (`@graph`, `mainEntity`, `itemListElement`, `about`).
 */
export function collectTypes(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const n of node) collectTypes(n, out);
  } else if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    const t = obj["@type"];
    if (typeof t === "string") out.push(t);
    else if (Array.isArray(t)) for (const x of t) if (typeof x === "string") out.push(x);
    for (const key of ["@graph", "mainEntity", "itemListElement", "about"]) {
      if (obj[key]) collectTypes(obj[key], out);
    }
  }
  return out;
}
