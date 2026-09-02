#!/usr/bin/env node
// Screenshot each Storybook story WITHOUT the app server, D1, or the API.
// Renders built stories (fixed fixtures) and captures a PNG per story.
//
// Usage:  npm run build-storybook && npm run shoot
// Output: web/screenshots/<story-id>.png
//
// Uses a direct one-shot chrome-headless-shell launch (no playwright daemon),
// which is the reliable path in sandboxed shells. Set CHROME_SHELL to override
// the binary; falls back to system Google Chrome.

import { createServer } from "node:http";
import { readFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync, spawn } from "node:child_process";
import { extname, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const staticDir = join(root, "storybook-static");
const outDir = join(root, "screenshots");

// The stories to shoot: Storybook story ids (title path, kebab-cased).
const STORIES = [
  "pages-statuspage--all-operational",
  "pages-statuspage--active-incident",
  "pages-statuspage--empty",
  "pages-statuspage--login",
];

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".map": "application/json",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function findChrome() {
  if (process.env.CHROME_SHELL && existsSync(process.env.CHROME_SHELL))
    return process.env.CHROME_SHELL;
  // Playwright's headless shell, if installed.
  const cache = join(
    process.env.HOME || "",
    "Library/Caches/ms-playwright",
  );
  if (existsSync(cache)) {
    // best-effort: find the NEWEST chrome-headless-shell under the cache
    // (multiple builds may be installed; older ones can be broken).
    const hit = spawnSync("bash", [
      "-lc",
      `ls -d ${cache}/chromium_headless_shell-*/chrome-headless-shell-*/chrome-headless-shell 2>/dev/null | sort -V | tail -1`,
    ]);
    const p = hit.stdout.toString().trim();
    if (p && existsSync(p)) return p;
  }
  const sys = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (existsSync(sys)) return sys;
  throw new Error("No Chrome/Chromium found. Set CHROME_SHELL to a binary path.");
}

async function serve() {
  const server = createServer(async (req, res) => {
    try {
      let path = decodeURIComponent((req.url || "/").split("?")[0]);
      if (path === "/") path = "/index.html";
      const file = join(staticDir, path);
      const buf = await readFile(file);
      res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
      res.end(buf);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  server.unref(); // don't let the server keep the process alive after we're done
  const port = server.address().port;
  return { server, port };
}

/** Screenshot one URL with a non-blocking chrome spawn (so the server can serve). */
function shoot(chrome, url, out) {
  return new Promise((resolve) => {
    const child = spawn(
      chrome,
      [
        "--headless",
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--hide-scrollbars",
        "--window-size=960,1200",
        "--virtual-time-budget=3000",
        `--screenshot=${out}`,
        url,
      ],
      { stdio: "ignore" },
    );
    const timer = setTimeout(() => child.kill("SIGKILL"), 30000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code === 0 && existsSync(out));
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

async function main() {  if (!existsSync(staticDir)) {
    console.error("storybook-static/ missing. Run: npm run build-storybook");
    process.exit(1);
  }
  await mkdir(outDir, { recursive: true });
  const chrome = findChrome();
  const { server, port } = await serve();
  let failures = 0;
  try {
    for (const id of STORIES) {
      const url = `http://127.0.0.1:${port}/iframe.html?id=${id}&viewMode=story`;
      const out = join(outDir, `${id}.png`);
      const ok = await shoot(chrome, url, out);
      if (!ok) {
        console.error(`FAILED: ${id}`);
        failures++;
      } else {
        console.log(`shot: screenshots/${id}.png`);
      }
    }
  } finally {
    server.close();
  }
  process.exit(failures ? 1 : 0);
}

main();
