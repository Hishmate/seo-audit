#!/usr/bin/env node
/**
 * Serves example/ so the audit has something to chew on.
 *
 *   npm run example          # then, in another shell:
 *   node dist/cli.js --sitemap http://127.0.0.1:8123/sitemap.xml
 *
 * Zero dependencies, one file, port overridable with PORT.
 */
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8731);
const BASE = `http://127.0.0.1:${PORT}`;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".xml": "application/xml",
  ".txt": "text/plain",
};

http
  .createServer(async (req, res) => {
    const p = new URL(req.url, BASE).pathname;
    const file = path.join(ROOT, p === "/" ? "/good.html" : p);
    if (!file.startsWith(ROOT)) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("forbidden");
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    }
  })
  .listen(PORT, "127.0.0.1", () => {
    console.log(`example site on ${BASE} — try:\n`);
    console.log(`  node dist/cli.js --url ${BASE}/good.html`);
    console.log(`  node dist/cli.js --url ${BASE}/bad.html`);
    console.log(`  node dist/cli.js --sitemap ${BASE}/sitemap.xml\n`);
  })
  .on("error", (e) => {
    if (e.code === "EADDRINUSE") {
      console.error(`port ${PORT} is taken — try PORT=9000 npm run example`);
      process.exit(1);
    }
    throw e;
  });
