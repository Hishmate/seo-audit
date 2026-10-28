/**
 * The audit engine.
 *
 * Input: a list of URLs (a single page, or everything a sitemap lists, capped
 * by `limit`). Output: one report per page plus per-origin plumbing checks,
 * with warnings kept apart from failures on purpose — a 62-column title is a
 * missed opportunity, not a broken page, and mixing the two makes the exit
 * code useless as a CI gate.
 */
import {
  alternateLinks,
  canonicalHref,
  collectTypes,
  jsonLdBlocks,
  metaContent,
  pageTitle,
  propContent,
} from "./html.js";
import { fetchPage, sameUrl, type Fetched } from "./fetch.js";
import { width as widthOf } from "./width.js";

// ── thresholds ─────────────────────────────────────────────────────────────
export interface Thresholds {
  titleMin: number;
  titleMax: number;
  descMin: number;
  descMax: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  titleMin: 15,
  titleMax: 65,
  descMin: 70,
  descMax: 165,
};

// ── report shapes ──────────────────────────────────────────────────────────
export type Severity = "fail" | "warn";

export interface Check {
  id: string;
  label: string;
  ok: boolean;
  severity: Severity;
  detail?: string;
}

export interface PageReport {
  url: string;
  finalUrl: string;
  status: number;
  checks: Check[];
  notes: string[];
}

export interface SiteReport {
  origin: string;
  checks: Check[];
}

export interface AuditReport {
  pages: PageReport[];
  sites: SiteReport[];
  summary: { passed: number; warnings: number; failed: number };
}

export interface AuditOptions {
  urls: string[];
  thresholds?: Partial<Thresholds>;
  concurrency?: number;
  timeoutMs?: number;
  userAgent?: string;
  /** Require an x-default entry whenever a page has hreflang annotations. */
  requireXDefault?: boolean;
}

// ── concurrency pool ───────────────────────────────────────────────────────
async function pool<T, R>(items: T[], workers: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const queue = [...items];
  const out: R[] = [];
  await Promise.all(
    Array.from({ length: Math.max(1, workers) }, async () => {
      for (;;) {
        const item = queue.shift();
        if (item === undefined) return;
        out.push(await fn(item));
      }
    }),
  );
  return out;
}

const fail = (id: string, label: string, detail?: string): Check => ({ id, label, ok: false, severity: "fail", detail });
const warn = (id: string, label: string, detail?: string): Check => ({ id, label, ok: false, severity: "warn", detail });
const pass = (id: string, label: string, detail?: string): Check => ({ id, label, ok: true, severity: "fail", detail });

const short = (s: string, n = 70) => (s.length > n ? `${s.slice(0, n)}…` : s);

// ── per-page checks ────────────────────────────────────────────────────────
interface CheckContext {
  thresholds: Thresholds;
  requireXDefault: boolean;
  /** Everything fetched, keyed by slash-normalised final URL. */
  byUrl: Map<string, Fetched>;
}

function checkPage(page: Fetched, ctx: CheckContext): PageReport {
  const checks: Check[] = [];
  const notes: string[] = [];
  const report: PageReport = {
    url: page.url,
    finalUrl: page.finalUrl,
    status: page.status,
    checks,
    notes,
  };
  const { thresholds } = ctx;

  if (page.error) {
    checks.push(fail("http-200", "GET reachable", page.error));
    return report;
  }
  if (page.status !== 200) {
    checks.push(fail("http-200", "GET 200", `got ${page.status}`));
    return report;
  }
  checks.push(pass("http-200", "GET 200"));

  if (sameUrl(page.finalUrl, page.url)) {
    // no redirect worth reporting
  } else {
    notes.push(`redirected to ${page.finalUrl}`);
  }

  const html = page.body;

  // ── title / description width ────────────────────────────────────────
  const title = pageTitle(html);
  if (title === null || !title.trim()) {
    checks.push(fail("title-present", "<title> present and non-empty", title === null ? "missing" : "empty"));
  } else {
    checks.push(pass("title-present", "<title> present and non-empty"));
    const w = widthOf(title);
    if (w > thresholds.titleMax || w < thresholds.titleMin) {
      checks.push(
        warn(
          "title-width",
          `title within ${thresholds.titleMin}–${thresholds.titleMax} columns`,
          `${w} (${title.trim().length} chars): ${short(title.trim())}`,
        ),
      );
    } else {
      checks.push(pass("title-width", `title within ${thresholds.titleMin}–${thresholds.titleMax} columns`, `${w} columns`));
    }
  }

  const desc = metaContent(html, "description");
  if (desc === null || !desc.trim()) {
    checks.push(fail("desc-present", "meta description present and non-empty", desc === null ? "missing" : "empty"));
  } else {
    checks.push(pass("desc-present", "meta description present and non-empty"));
    const w = widthOf(desc);
    if (w > thresholds.descMax || w < thresholds.descMin) {
      checks.push(
        warn(
          "desc-width",
          `description within ${thresholds.descMin}–${thresholds.descMax} columns`,
          `${w} (${desc.trim().length} chars): ${short(desc.trim())}`,
        ),
      );
    } else {
      checks.push(pass("desc-width", `description within ${thresholds.descMin}–${thresholds.descMax} columns`, `${w} columns`));
    }
  }

  // ── canonical ────────────────────────────────────────────────────────
  const canon = canonicalHref(html);
  if (canon === null) {
    checks.push(fail("canonical-present", "canonical present", "missing"));
  } else {
    checks.push(pass("canonical-present", "canonical present"));
    const resolved = resolveUrl(canon, page.finalUrl);
    if (resolved === null || !sameUrl(resolved, page.finalUrl)) {
      checks.push(fail("canonical-self", "canonical self-referencing", `got ${canon}, want ${page.finalUrl}`));
    } else {
      checks.push(pass("canonical-self", "canonical self-referencing"));
    }
  }

  // ── hreflang ─────────────────────────────────────────────────────────
  const alts = alternateLinks(html).map((a) => ({
    hreflang: a.hreflang,
    href: resolveUrl(a.href, page.finalUrl) ?? a.href,
  }));
  if (alts.length === 0) {
    notes.push("no hreflang annotations");
  } else {
    const selfLink = alts.some((a) => sameUrl(a.href, page.finalUrl));
    checks.push(
      selfLink
        ? pass("hreflang-self", "hreflang self-link present")
        : fail("hreflang-self", "hreflang self-link present", `no alternate points back at ${page.finalUrl}`),
    );

    if (ctx.requireXDefault) {
      const hasDefault = alts.some((a) => a.hreflang.toLowerCase() === "x-default");
      checks.push(
        hasDefault
          ? pass("hreflang-xdefault", "hreflang x-default present")
          : fail("hreflang-xdefault", "hreflang x-default present", "missing"),
      );
    }

    // Reciprocity: every alternate must point at a page that links back.
    // Search engines discard the whole annotation set when return links are
    // missing, so this is the check that keeps the set alive at all.
    const broken: string[] = [];
    for (const alt of alts) {
      const target = ctx.byUrl.get(slashless(alt.href));
      if (!target) {
        broken.push(`${alt.hreflang} → ${alt.href} (target not reachable)`);
        continue;
      }
      if (target.status !== 200) {
        broken.push(`${alt.hreflang} → ${alt.href} (target returned ${target.status})`);
        continue;
      }
      const backLinks = alternateLinks(target.body).map((b) => resolveUrl(b.href, target.finalUrl) ?? b.href);
      if (!backLinks.some((b) => sameUrl(b, page.finalUrl))) {
        broken.push(`${alt.hreflang} → ${alt.href} has no link back`);
      }
    }
    checks.push(
      broken.length === 0
        ? pass("hreflang-reciprocal", `hreflang alternates reciprocal (${alts.length})`)
        : fail("hreflang-reciprocal", "hreflang alternates reciprocal", broken.join("; ")),
    );
  }

  // ── JSON-LD ──────────────────────────────────────────────────────────
  const blocks = jsonLdBlocks(html);
  const parseErrors = blocks.filter((b) => b.error);
  checks.push(
    parseErrors.length === 0
      ? pass("jsonld-parse", `every JSON-LD block parses (${blocks.length})`)
      : fail("jsonld-parse", "every JSON-LD block parses", parseErrors.map((b) => b.error).join(" | ")),
  );
  const types = blocks.flatMap((b) => (b.value === undefined ? [] : collectTypes(b.value)));
  checks.push(
    types.length > 0
      ? pass("jsonld-type", "JSON-LD carries an @type", types.join(", "))
      : fail("jsonld-type", "JSON-LD carries an @type", blocks.length === 0 ? "no JSON-LD found" : "no @type in any block"),
  );

  // ── Open Graph ───────────────────────────────────────────────────────
  for (const [id, prop, label] of [
    ["og-title", "og:title", "og:title present"],
    ["og-description", "og:description", "og:description present"],
    ["og-url", "og:url", "og:url present"],
  ] as const) {
    const v = propContent(html, prop);
    checks.push(v ? pass(id, label) : fail(id, label, "missing"));
  }

  return report;
}

// ── site-level plumbing ────────────────────────────────────────────────────
async function checkSite(origin: string, opts: { timeoutMs?: number; userAgent?: string }): Promise<SiteReport> {
  const checks: Check[] = [];
  const robots = await fetchPage(`${origin}/robots.txt`, opts);
  checks.push(
    robots.status === 200
      ? pass("robots-txt", "robots.txt reachable")
      : fail("robots-txt", "robots.txt reachable", robots.error ?? `got ${robots.status}`),
  );
  const sitemap = await fetchPage(`${origin}/sitemap.xml`, opts);
  checks.push(
    sitemap.status === 200
      ? pass("sitemap-xml", "sitemap.xml reachable")
      : fail("sitemap-xml", "sitemap.xml reachable", sitemap.error ?? `got ${sitemap.status}`),
  );
  return { origin, checks };
}

// ── helpers ────────────────────────────────────────────────────────────────
function slashless(u: string): string {
  return u.replace(/\/+$/, "");
}

function resolveUrl(href: string, base: string): string | null {
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
}

// ── entry point ────────────────────────────────────────────────────────────
export async function audit(options: AuditOptions): Promise<AuditReport> {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...options.thresholds };
  const requireXDefault = options.requireXDefault ?? true;
  const fetchOpts = { timeoutMs: options.timeoutMs, userAgent: options.userAgent };

  // Wave 1: the requested pages.
  const pages = await pool(options.urls, options.concurrency ?? 6, (url) => fetchPage(url, fetchOpts));

  // Wave 2: every hreflang target, so reciprocity can be verified against a
  // real response instead of assumed.
  const extra = new Set<string>();
  for (const p of pages) {
    if (p.status !== 200) continue;
    for (const alt of alternateLinks(p.body)) {
      const resolved = resolveUrl(alt.href, p.finalUrl);
      if (resolved && !pages.some((q) => sameUrl(q.finalUrl, resolved))) extra.add(resolved);
    }
  }
  const alternates = await pool([...extra], options.concurrency ?? 6, (url) => fetchPage(url, fetchOpts));

  const byUrl = new Map<string, Fetched>();
  for (const p of [...pages, ...alternates]) byUrl.set(slashless(p.finalUrl), p);

  const ctx: CheckContext = { thresholds, requireXDefault, byUrl };
  const pageReports = pages.map((p) => checkPage(p, ctx));

  // One plumbing check per distinct origin.
  const origins = [...new Set(pages.map((p) => new URL(p.finalUrl).origin))];
  const sites: SiteReport[] = [];
  for (const origin of origins) sites.push(await checkSite(origin, fetchOpts));

  let passed = 0;
  let warnings = 0;
  let failed = 0;
  for (const c of [...pageReports.flatMap((p) => p.checks), ...sites.flatMap((s) => s.checks)]) {
    if (c.ok) passed++;
    else if (c.severity === "warn") warnings++;
    else failed++;
  }

  return { pages: pageReports, sites, summary: { passed, warnings, failed } };
}
