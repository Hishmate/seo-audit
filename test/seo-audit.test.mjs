/**
 * Self-test. Spins up a local HTTP server with a deliberately good page, a
 * deliberately broken one, and the plumbing around them, then runs the built
 * CLI against it. Nothing here touches the network — the fixtures are the
 * whole internet as far as the audit is concerned.
 *
 *   npm test
 *
 * The CLI runs through async `execFile`, not `execFileSync`: the fixture
 * server lives in this process, and a synchronous spawn would block the event
 * loop the server needs to answer on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "dist", "cli.js");

// ── fixtures ───────────────────────────────────────────────────────────────
const goodTitle = "Good Page Title For Width Testing Purposes"; // 42 columns
const goodDesc =
  "A deliberately well-formed page: title and description inside the width budget, a self canonical, reciprocal hreflang, parsable JSON-LD and Open Graph tags.";
const warnTitle = "Warning Page Title That Runs Well Past The Configured Maximum Width Limit"; // > 65 columns

function shell(base, { title, desc, canonical, alternates, jsonld, og }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
${title ? `<title>${title}</title>` : ""}
${desc ? `<meta name="description" content="${desc}">` : ""}
${canonical ? `<link rel="canonical" href="${canonical}">` : ""}
${alternates ?? ""}
${jsonld ?? ""}
${og ?? ""}
</head>
<body><h1>Hello</h1></body>
</html>`;
}

function alts(base, langs) {
  // langs: [["x-default", "/good.html"], ["fr", "/good-fr.html"], ...]
  return langs
    .map(([lang, href]) => `<link rel="alternate" hreflang="${lang}" href="${base}${href}">`)
    .join("\n");
}

const goodJsonLd = `<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebPage","name":"Good"}</script>`;

let base = "";

function pages() {
  const ogFor = (p) =>
    `<meta property="og:title" content="${goodTitle}">\n` +
    `<meta property="og:description" content="${goodDesc}">\n` +
    `<meta property="og:url" content="${base}${p}">`;
  return {
    "/good.html": shell(base, {
      title: goodTitle,
      desc: goodDesc,
      canonical: `${base}/good.html`,
      alternates: alts(base, [
        ["x-default", "/good.html"],
        ["en", "/good.html"],
        ["fr", "/good-fr.html"],
      ]),
      jsonld: goodJsonLd,
      og: ogFor("/good.html"),
    }),
    "/good-fr.html": shell(base, {
      title: "Page de test bien formee avec un titre raisonnable",
      desc: "Une page deliberement bien formee : titre et description dans les limites de largeur, canonique, hreflang reciproque et JSON-LD analysable.",
      canonical: `${base}/good-fr.html`,
      alternates: alts(base, [
        ["x-default", "/good.html"],
        ["en", "/good.html"],
        ["fr", "/good-fr.html"],
      ]),
      jsonld: goodJsonLd,
      og: ogFor("/good-fr.html"),
    }),
    // Everything wrong at once: over-wide title, thin description, no
    // canonical, a one-way hreflang with no x-default, unparsable JSON-LD,
    // no Open Graph.
    "/bad.html": shell(base, {
      title: "Bad Page Title That Runs Comfortably Past The Sixty Five Column Budget For Titles",
      desc: "Too thin.",
      canonical: null,
      alternates: alts(base, [["de", "/bad-de.html"]]),
      jsonld: `<script type="application/ld+json">{"@type": "WebPage", "name": }</script>`,
      og: "",
    }),
    // Exists, but carries no hreflang back to the page that points at it.
    "/bad-de.html": shell(base, {
      title: "Zielseite ohne Rueckverweis auf die Quellseite",
      desc: "Eine absichtlich einseitig verlinkte Seite: sie antwortet mit 200, verweist aber nie zurueck.",
      canonical: `${base}/bad-de.html`,
      alternates: "",
      jsonld: goodJsonLd,
      og: ogFor("/bad-de.html"),
    }),
    // Only the width check is wrong; everything else is green.
    "/warn.html": shell(base, {
      title: warnTitle,
      desc: goodDesc,
      canonical: `${base}/warn.html`,
      alternates: alts(base, [
        ["x-default", "/warn.html"],
        ["en", "/warn.html"],
      ]),
      jsonld: goodJsonLd,
      og: ogFor("/warn.html"),
    }),
    // Its hreflang target 404s — reciprocity fails for a different reason.
    "/dead-alt.html": shell(base, {
      title: goodTitle,
      desc: goodDesc,
      canonical: `${base}/dead-alt.html`,
      alternates: alts(base, [
        ["x-default", "/dead-alt.html"],
        ["en", "/gone.html"],
      ]),
      jsonld: goodJsonLd,
      og: ogFor("/dead-alt.html"),
    }),
  };
}

function handler(req, res) {
  const url = new URL(req.url, "http://127.0.0.1");
  const p = url.pathname;
  const body = pages()[p];
  if (body !== undefined) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
    return;
  }
  if (p === "/robots.txt") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`User-agent: *\nDisallow:\n\nSitemap: ${base}/sitemap.xml\n`);
    return;
  }
  if (p === "/sitemap.xml") {
    res.writeHead(200, { "content-type": "application/xml" });
    res.end(
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
        `  <url><loc>${base}/good.html</loc></url>\n` +
        `  <url><loc>${base}/bad.html</loc></url>\n` +
        `</urlset>\n`,
    );
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
}

// ── harness ────────────────────────────────────────────────────────────────
let server;

test.before(async () => {
  server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function run(args) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [CLI, ...args], {
      encoding: "utf8",
    });
    return { code: 0, out: stdout };
  } catch (e) {
    // execFile rejects with the child's exit code on `e.code` (not `e.status`,
    // which is the sync variant's property).
    return { code: e.code ?? e.status ?? 1, out: (e.stdout || "") + (e.stderr || "") };
  }
}

// ── width unit ─────────────────────────────────────────────────────────────
test("full-width characters count 2 columns", async () => {
  const { width } = await import("../dist/width.js");
  assert.equal(width("你好世界"), 8);
  assert.equal(width("abc"), 3);
  assert.equal(width("  abc  "), 3); // trimmed
  assert.equal(width("a中b"), 4);
  assert.equal(width(""), 0);
  assert.equal(width("สวัสดี"), 6); // Thai is not full-width
});

// ── the good page ──────────────────────────────────────────────────────────
test("a well-formed page passes every check", async () => {
  const r = await run(["--url", `${base}/good.html`]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /0 failed/);
  for (const needle of [
    "✓ title within 15–65 columns",
    "✓ description within 70–165 columns",
    "✓ canonical self-referencing",
    "✓ hreflang self-link present",
    "✓ hreflang x-default present",
    "✓ hreflang alternates reciprocal (3)",
    "✓ every JSON-LD block parses",
    "✓ JSON-LD carries an @type",
    "✓ og:title present",
    "✓ og:description present",
    "✓ og:url present",
    "✓ robots.txt reachable",
    "✓ sitemap.xml reachable",
  ])
    assert.ok(r.out.includes(needle), `missing: ${needle}`);
});

test("--json emits a machine-readable report", async () => {
  const r = await run(["--url", `${base}/good.html`, "--json"]);
  assert.equal(r.code, 0, r.out);
  const report = JSON.parse(r.out);
  assert.equal(report.summary.failed, 0);
  assert.equal(report.pages[0].url, `${base}/good.html`);
  assert.ok(report.pages[0].checks.every((c) => c.ok));
});

// ── the bad page ───────────────────────────────────────────────────────────
test("a broken page fails every check it breaks, with a non-zero exit", async () => {
  const r = await run(["--url", `${base}/bad.html`]);
  assert.equal(r.code, 1);
  for (const needle of [
    "✗ canonical present",
    "✗ hreflang self-link present",
    "✗ hreflang x-default present",
    "✗ hreflang alternates reciprocal",
    "has no link back",
    "✗ every JSON-LD block parses",
    "✗ JSON-LD carries an @type",
    "✗ og:title present",
    "✗ og:description present",
    "✗ og:url present",
    "! title within 15–65 columns",
    "! description within 70–165 columns",
  ])
    assert.ok(r.out.includes(needle), `missing: ${needle}`);
});

test("a hreflang target that 404s fails reciprocity", async () => {
  const r = await run(["--url", `${base}/dead-alt.html`]);
  assert.equal(r.code, 1);
  assert.ok(r.out.includes("target returned 404"), r.out);
});

test("a page that 404s is a failure, not a crash", async () => {
  const r = await run(["--url", `${base}/nope.html`]);
  assert.equal(r.code, 1);
  assert.ok(r.out.includes("got 404"), r.out);
});

// ── warnings are not failures, unless --strict ─────────────────────────────
test("an over-wide title warns but exits 0; --strict gates on it", async () => {
  const plain = await run(["--url", `${base}/warn.html`]);
  assert.equal(plain.code, 0, plain.out);
  assert.match(plain.out, /1 warning\(s\), 0 failed/);
  const strict = await run(["--url", `${base}/warn.html`, "--strict"]);
  assert.equal(strict.code, 1);
});

// ── thresholds are configurable ────────────────────────────────────────────
test("--title-max lowers the bar the good page is judged against", async () => {
  const r = await run(["--url", `${base}/good.html`, "--title-max", "20"]);
  assert.equal(r.code, 0); // width is a warning, not a failure
  assert.match(r.out, /1 warning\(s\)/);
  const strict = await run(["--url", `${base}/good.html`, "--title-max", "20", "--strict"]);
  assert.equal(strict.code, 1);
  const wider = await run(["--url", `${base}/good.html`, "--title-min", "10", "--title-max", "200"]);
  assert.equal(wider.code, 0);
  assert.match(wider.out, /0 warning\(s\)/);
});

// ── sitemap mode ───────────────────────────────────────────────────────────
test("--sitemap extracts <loc> URLs and --limit caps them", async () => {
  const all = await run(["--sitemap", `${base}/sitemap.xml`]);
  assert.equal(all.code, 1); // the bad page is in there
  assert.ok(all.out.includes("/good.html"));
  assert.ok(all.out.includes("/bad.html"));

  const capped = await run(["--sitemap", `${base}/sitemap.xml`, "--limit", "1"]);
  assert.equal(capped.code, 0); // only the good page made the cut
  assert.ok(capped.out.includes("/good.html"));
  assert.ok(!capped.out.includes("/bad.html"));
});

test("--sitemap reads a local file", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "seo-audit-test-"));
  const file = path.join(tmp, "sitemap.xml");
  fs.writeFileSync(
    file,
    `<?xml version="1.0"?><urlset><url><loc>${base}/good.html</loc></url></urlset>`,
  );
  const r = await run(["--sitemap", file]);
  assert.equal(r.code, 0, r.out);
  assert.ok(r.out.includes("/good.html"));
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── usage errors ───────────────────────────────────────────────────────────
test("usage errors exit 2", async () => {
  assert.equal((await run([])).code, 2);
  assert.equal((await run(["--url", `${base}/good.html`, "--sitemap", `${base}/sitemap.xml`])).code, 2);
  assert.equal((await run(["--nope"])).code, 2);
  assert.equal((await run(["--url"])).code, 2); // missing value
  const help = await run(["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.out, /--sitemap/);
});
