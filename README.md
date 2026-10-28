# seo-audit

Audit the SEO signals of a page — or a whole sitemap — in one command, with
zero runtime dependencies.

Most SEO checkers either drown you in 200 "opportunities" or fail only on the
trivial stuff. This one asks the narrower question: *is this page actually
indexable, understandable and answerable?* It checks the handful of signals a
crawler or an answer engine really reads, reports per page, and exits non-zero
when something is broken — so it drops straight into CI.

```bash
node dist/cli.js --url https://example.com/pricing
node dist/cli.js --sitemap https://example.com/sitemap.xml --limit 50
```

## What it checks, and what happens when it doesn't

Every check below is something a crawler reads. The right-hand column is the
part most checkers leave out: what the failure actually costs you.

### Per page

| Check | If it fails |
|---|---|
| **`<title>` / `meta description` width** (full-width chars count 2 columns; defaults 15–65 / 70–165, all configurable) | Engines truncate on *rendered width*, roughly 600px for a title and ~920px for a description. A 40-character Chinese title is a full title, not a stub — character counts lie across scripts. Over the limit, your differentiator words are replaced by "…"; under it, you have thrown away ranking real estate. The title is also the string answer engines quote as the page's name. |
| **Canonical present and self-referencing** | Without a canonical, every URL variant (`?utm_source=…`, trailing slash, http/https) is a separate page competing for the same ranking signals. A canonical pointing somewhere *else* is worse: it donates this page's signals to another URL and can de-index the one you wanted ranked. |
| **hreflang set self-consistent** — every annotation has a reciprocal back-link, plus `x-default` | Search engines discard the *entire* hreflang set when return links are missing — not just the broken entry. One one-way annotation and your whole localisation effort silently does nothing: users get the wrong language, and answer engines cite the wrong locale's content. Missing `x-default` leaves unmatched languages with no fallback. |
| **JSON-LD parses and carries an `@type`** | An unparsable block is *silently ignored* — identical to having no block at all in every rich-result test you will ever run. That means no FAQ dropdown, no breadcrumbs, no product card, and none of the structured facts an answer engine could have quoted. |
| **`og:title` / `og:description` / `og:url` present** | Every chat app and feed reader renders a bare, untrusted URL instead of your headline. Missing `og:url` also splits likes and shares across variants of the same page. |
| **HTTP 200** | The page must answer. A sitemap that lists 200s and a server that serves 404s is the most expensive kind of "everything looks fine". |

### Per site (once per origin)

| Check | If it fails |
|---|---|
| **`robots.txt` reachable** | Crawlers log the error in Search Console and keep crawling anyway, but you have lost the `Sitemap:` discovery line and every per-bot rule you thought you had set. |
| **`sitemap.xml` reachable** | New pages wait to be *found* by links instead of being pushed. On a young domain, that is the difference between indexed this week and indexed eventually. |

### Warnings vs. failures

A 62-column title is a missed opportunity, not a broken page — so width
problems are **warnings**: they print, they don't gate. Everything else is a
failure and exits `1`. `--strict` promotes warnings to gateable too.

## Install

```bash
git clone https://github.com/Hishmate/seo-audit.git && cd seo-audit
npm install     # devDependencies only: typescript + @types/node
npm run build   # emits dist/
```

Or copy `src/` into your own repo — the runtime has zero dependencies, so the
compiled `dist/` is all you need to ship. Requires Node 18+ (uses global
`fetch`).

## Usage

```
seo-audit --url <pageUrl>
seo-audit --sitemap <sitemapUrl|file.xml>

  --limit <n>          max URLs taken from the sitemap (0 = all, default 0)
  --concurrency <n>    parallel fetches (default 6)
  --timeout <ms>       per-request timeout (default 15000)
  --user-agent <ua>    User-Agent header sent with every request
  --title-min <n>      title minimum rendered columns (default 15)
  --title-max <n>      title maximum rendered columns (default 65)
  --desc-min <n>       description minimum rendered columns (default 70)
  --desc-max <n>       description maximum rendered columns (default 165)
  --no-x-default       do not require an x-default hreflang entry
  --strict             warnings also set a non-zero exit code
  --json               machine-readable JSON report
  --help               show this help
```

Sitemap input accepts a URL or a local file, follows `<sitemapindex>`
children, and deduplicates. hreflang targets are fetched automatically so
reciprocity is verified against a real response instead of assumed.

Exit codes: `0` clean · `1` problems found · `2` usage error.

## CI

```yaml
- run: npm ci && npm run build
- run: node dist/cli.js --sitemap https://example.com/sitemap.xml --limit 100
```

Point it at a deployed preview and the pull request fails on the same page
that would have shipped broken. `--json` is there when you want to post the
report somewhere other than the log.

## Try it

`example/` holds a two-page site: one page that passes everything, one that
breaks everything at once.

```bash
npm run example     # serves example/ at http://127.0.0.1:8731
# in another shell:
node dist/cli.js --sitemap http://127.0.0.1:8731/sitemap.xml
```

```
http://127.0.0.1:8731/good.html  (HTTP 200)
  ✓ title within 15–65 columns — 42 columns
  ✓ canonical self-referencing
  ✓ hreflang alternates reciprocal (3)
  ✓ JSON-LD carries an @type — WebPage
  ...

http://127.0.0.1:8731/bad.html  (HTTP 200)
  ! title within 15–65 columns — 81 (81 chars): Bad Page Title That Runs…
  ✗ canonical present — missing
  ✗ hreflang alternates reciprocal — de → …/bad-de.html has no link back
  ✗ every JSON-LD block parses — SyntaxError: Unexpected token '}'
  ✗ og:title present — missing
  ...

20 passed, 2 warning(s), 9 failed
```

`npm test` runs the same fixtures through a local `node:http` server — the
suite never touches the network — plus the width unit, threshold overrides,
sitemap capping and the usage-error paths.

## Three design decisions worth knowing

**Width, not length.** Character count is the wrong yardstick across scripts.
The width function is one regex — the Unicode blocks that are genuinely wide
(CJK, Hangul, full-width forms) count 2, everything else 1 — because that is
the number that matches what a rendered SERP does to your string. Thai and
Devanagari are *not* wide and stay at 1; treating them as 2 would flag correct
titles as broken.

**hreflang is verified, not counted.** A checker that only asserts "11
alternate tags exist" passes happily on a set the engines have already
discarded. This one fetches every annotation target and demands the link
back, which is the actual rule — and tells you *which* direction is missing.
**The report is grouped by page, and the exit code means one thing.** A run
that dies at URL 60 of 66 reports nothing at all, so every fetch is
failure-contained. Warnings never touch the exit code unless you ask for
`--strict`, because a gate that cries wolf gets disabled in week two.

## Where this comes from

Built for [hishmate.com](https://hishmate.com), which ships 11 locales —
including CJK — off a single codebase. Its in-repo audit walked every page in
every language and kept catching the same classes of drift: hreflang
reciprocity broken by one one-way annotation, JSON-LD blocks that parsed fine
in the editor and not in the RSC payload, and titles that were comfortably
inside the limit in English and comfortably outside it in Chinese. This CLI is
that audit with the site-specific checklist removed: same width regex, same
thresholds, no hardcoded page list.

## License

MIT — see [LICENSE](./LICENSE).
