/** Report rendering: grouped by page, then per-origin plumbing, then a total. */
import type { AuditReport, Check } from "./audit.js";

const mark = (c: Check): string => (c.ok ? "✓" : c.severity === "warn" ? "!" : "✗");

function line(c: Check): string {
  return `  ${mark(c)} ${c.label}${c.detail ? ` — ${c.detail}` : ""}`;
}

export function renderText(report: AuditReport): string {
  const out: string[] = [];
  for (const page of report.pages) {
    out.push(`${page.url}${sameAsFinal(page) ? "" : ` → ${page.finalUrl}`}  (HTTP ${page.status})`);
    for (const c of page.checks) out.push(line(c));
    for (const n of page.notes) out.push(`  · ${n}`);
    out.push("");
  }
  for (const site of report.sites) {
    out.push(`site ${site.origin}`);
    for (const c of site.checks) out.push(line(c));
    out.push("");
  }
  const { passed, warnings, failed } = report.summary;
  out.push(`${passed} passed, ${warnings} warning(s), ${failed} failed`);
  return out.join("\n");
}

function sameAsFinal(page: { url: string; finalUrl: string }): boolean {
  return page.url.replace(/\/+$/, "") === page.finalUrl.replace(/\/+$/, "");
}

export function renderJson(report: AuditReport): string {
  return JSON.stringify(report, null, 2);
}
