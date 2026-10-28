#!/usr/bin/env node
/**
 * seo-audit — audit a page (or a whole sitemap) for the signals crawlers and
 * answer engines actually read.
 *
 *   seo-audit --url https://example.com/page
 *   seo-audit --sitemap https://example.com/sitemap.xml --limit 50
 *
 * Exit codes: 0 clean, 1 problems found (CI gate), 2 usage error.
 */
import { audit, DEFAULT_THRESHOLDS, type Thresholds } from "./audit.js";
import { renderJson, renderText } from "./report.js";
import { readSitemap } from "./sitemap.js";

const USAGE = `seo-audit — audit the SEO signals of a page or a whole sitemap

Usage:
  seo-audit --url <pageUrl>
  seo-audit --sitemap <sitemapUrl|file.xml>

Options:
  --limit <n>          max URLs taken from the sitemap (0 = all, default 0)
  --concurrency <n>    parallel fetches (default 6)
  --timeout <ms>       per-request timeout (default 15000)
  --user-agent <ua>    User-Agent header sent with every request
  --title-min <n>      title minimum rendered columns (default ${DEFAULT_THRESHOLDS.titleMin})
  --title-max <n>      title maximum rendered columns (default ${DEFAULT_THRESHOLDS.titleMax})
  --desc-min <n>       description minimum rendered columns (default ${DEFAULT_THRESHOLDS.descMin})
  --desc-max <n>       description maximum rendered columns (default ${DEFAULT_THRESHOLDS.descMax})
  --no-x-default       do not require an x-default hreflang entry
  --strict             warnings also set a non-zero exit code
  --json               machine-readable JSON report
  --help               show this help

Full-width characters (CJK) count as 2 columns. Thresholds are inclusive.`;

interface Args {
  url?: string;
  sitemap?: string;
  limit: number;
  concurrency: number;
  timeout?: number;
  userAgent?: string;
  thresholds: Partial<Thresholds>;
  requireXDefault: boolean;
  strict: boolean;
  json: boolean;
  help: boolean;
}

function parseIntArg(value: string | undefined, flag: string): number {
  const n = Number(value);
  if (value === undefined || !Number.isFinite(n) || n < 0) {
    console.error(`seo-audit: ${flag} expects a non-negative number, got ${JSON.stringify(value)}`);
    process.exit(2);
  }
  return n;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    limit: 0,
    concurrency: 6,
    thresholds: {},
    requireXDefault: true,
    strict: false,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    const next = () => argv[++i];
    const eq = flag.indexOf("=");
    const inline = eq > -1 ? flag.slice(eq + 1) : undefined;
    const value = () => inline ?? next();
    const name = inline !== undefined ? flag.slice(0, eq) : flag;
    switch (name) {
      case "--url":
        args.url = value();
        break;
      case "--sitemap":
        args.sitemap = value();
        break;
      case "--limit":
        args.limit = parseIntArg(value(), "--limit");
        break;
      case "--concurrency":
        args.concurrency = Math.max(1, parseIntArg(value(), "--concurrency"));
        break;
      case "--timeout":
        args.timeout = parseIntArg(value(), "--timeout");
        break;
      case "--user-agent":
        args.userAgent = value();
        break;
      case "--title-min":
        args.thresholds.titleMin = parseIntArg(value(), "--title-min");
        break;
      case "--title-max":
        args.thresholds.titleMax = parseIntArg(value(), "--title-max");
        break;
      case "--desc-min":
        args.thresholds.descMin = parseIntArg(value(), "--desc-min");
        break;
      case "--desc-max":
        args.thresholds.descMax = parseIntArg(value(), "--desc-max");
        break;
      case "--no-x-default":
        args.requireXDefault = false;
        break;
      case "--strict":
        args.strict = true;
        break;
      case "--json":
        args.json = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        console.error(`seo-audit: unknown flag ${flag}\n\n${USAGE}`);
        process.exit(2);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }
  if (!args.url && !args.sitemap) {
    console.error(`seo-audit: one of --url or --sitemap is required\n\n${USAGE}`);
    process.exit(2);
  }
  if (args.url && args.sitemap) {
    console.error("seo-audit: --url and --sitemap are mutually exclusive");
    process.exit(2);
  }

  let urls: string[];
  let source: string;
  if (args.url) {
    urls = [args.url];
    source = args.url;
  } else {
    const sm = await readSitemap(args.sitemap!, { timeoutMs: args.timeout, userAgent: args.userAgent });
    urls = args.limit > 0 ? sm.urls.slice(0, args.limit) : sm.urls;
    source = sm.label;
    if (urls.length === 0) {
      console.error(`seo-audit: no <loc> URLs found in ${source}`);
      process.exit(2);
    }
  }

  const report = await audit({
    urls,
    thresholds: args.thresholds,
    concurrency: args.concurrency,
    timeoutMs: args.timeout,
    userAgent: args.userAgent,
    requireXDefault: args.requireXDefault,
  });

  if (args.json) {
    console.log(renderJson(report));
  } else {
    console.log(`\nseo-audit — ${report.pages.length} URL(s) from ${source}\n`);
    console.log(renderText(report));
  }

  const { failed, warnings } = report.summary;
  if (failed > 0 || (args.strict && warnings > 0)) process.exitCode = 1;
}

main();
