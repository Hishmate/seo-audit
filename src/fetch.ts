/** Fetching that never throws. */

export const DEFAULT_USER_AGENT = "seo-audit/1.0 (+https://github.com/Hishmate/seo-audit)";
export const DEFAULT_TIMEOUT_MS = 15_000;

export interface Fetched {
  /** The URL that was requested. */
  url: string;
  /** Where it ended up after redirects. */
  finalUrl: string;
  status: number;
  headers: Headers;
  body: string;
  /** Network-level error, when there was one (status stays 0). */
  error: string | null;
}

const reason = (e: unknown) =>
  String((e as { cause?: { code?: string } })?.cause?.code || (e as Error)?.message || e).slice(0, 70);

/**
 * One GET. A host being unreachable has to show up as a failed check, not as a
 * stack trace that takes the other results down with it — the report is the
 * deliverable, and a run that dies at URL 60 of 66 reports nothing at all.
 */
export async function fetchPage(
  url: string,
  opts: { timeoutMs?: number; userAgent?: string } = {},
): Promise<Fetched> {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: { "user-agent": opts.userAgent ?? DEFAULT_USER_AGENT },
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    return {
      url,
      finalUrl: res.url || url,
      status: res.status,
      headers: res.headers,
      body: await res.text(),
      error: null,
    };
  } catch (e) {
    return { url, finalUrl: url, status: 0, headers: new Headers(), body: "", error: reason(e) };
  }
}

/**
 * URL identity with trailing slashes ignored. `https://x.com` and
 * `https://x.com/` are one address, and frameworks routinely emit the canonical
 * with the slash while hreflang goes without it — treating that as a wrong URL
 * reports failures for a difference no crawler sees.
 */
export function sameUrl(a: string | null | undefined, b: string | null | undefined): boolean {
  return normUrl(a) === normUrl(b);
}

function normUrl(u: string | null | undefined): string {
  return (u ?? "").replace(/\/+$/, "");
}
