#!/usr/bin/env node
// Regenerate docs/skillspector-tour.gif by driving the real deck in Chrome.
//
//   node scripts/make-tour.mjs                # writes docs/skillspector-tour.gif
//   node scripts/make-tour.mjs --analyst      # include a live OMLX review (slow)
//   node scripts/make-tour.mjs --out x.gif
//
// Needs ffmpeg on PATH. Everything else is node builtins.
//
// Author: Nic Cravino — Skillspector
// License: MIT
import http from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { launchChrome, CDP, Page, waitFor } from "../tests/cdp.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const bridge = await import(resolve(ROOT, "server.mjs"));

const argv = process.argv.slice(2);
const WANT_ANALYST = argv.includes("--analyst");
const OUT = (() => {
  const i = argv.indexOf("--out");
  return i !== -1 && argv[i + 1] ? resolve(argv[i + 1]) : resolve(ROOT, "docs/skillspector-tour.gif");
})();

const W = 1280, H = 800, FPS = 6, GIF_WIDTH = 880;
const frameDir = mkdtempSync(join(tmpdir(), "skillspector-tour-"));
let frame = 0;

const server = http.createServer(bridge.createHandler({ engineVersion: "tour" }));
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const BASE = `http://127.0.0.1:${server.address().port}`;

const chrome = await launchChrome({ headless: true });
const cdp = await CDP.connect(chrome.wsUrl);
const page = await Page.open(cdp, BASE);
await page.setViewport(W, H);

async function grab(n = 1) {
  for (let i = 0; i < n; i++) {
    await page.screenshot(join(frameDir, `f-${String(++frame).padStart(4, "0")}.png`));
  }
}
/** Grab frames continuously until `predicate` evaluates truthy in the page. */
async function grabUntil(predicate, timeoutMs, label) {
  const started = Date.now();
  for (;;) {
    await grab();
    const done = await page.eval(predicate).catch(() => null);
    if (done) return;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
  }
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  console.log("recording…");
  await page.waitForEval('document.getElementById("boot").classList.contains("done")', 15000, "boot");
  // The drifting starfield changes every pixel of every frame, which defeats
  // GIF inter-frame compression — a 2 MB tour for an otherwise static deck.
  // The deck reads the same without it.
  await page.eval(`(() => {
    for (const id of ["bg-canvas", "grain"]) {
      const el = document.getElementById(id);
      if (el) el.style.display = "none";
    }
  })()`);
  await grab(8);                                            // standby

  await page.click("#demoBtn");                             // scan animation
  await grabUntil(
    '(() => { const d = globalThis.__skillspectorDeck; return d && d.state.result ? 1 : null; })()',
    20000, "the scan");
  await grab(10);                                           // settled report

  for (const [view, hold] of [["findings", 8], ["capabilities", 7], ["bundle", 8]]) {
    await page.click(`.nav-btn[data-view="${view}"]`);
    await pause(350);
    await grab(hold);
  }

  await page.click('.nav-btn[data-view="findings"]');       // evidence modal
  await pause(250);
  await page.click("#find-tbody tr");
  await pause(300);
  await grab(9);
  await page.click("#modal-close");

  await page.click('.nav-btn[data-view="analyst"]');
  await pause(400);
  await grab(8);

  if (WANT_ANALYST) {
    console.log("running a live review — this takes minutes…");
    await page.eval('document.getElementById("runAnalysisBtn").click()');
    // Sample the stage track rather than every frame; a 5-minute review must
    // not become a 2000-frame GIF.
    await waitFor(async () => {
      await grab();
      await pause(12000);   // one frame per 12s: a 7-minute review is ~35 frames
      // state.analysis is populated after PASS 1 so triage can show early —
      // the verdict is what says the run is actually over.
      return page
        .eval('(() => { const a = globalThis.__skillspectorDeck.state.analysis; return a && a.verdict ? 1 : null; })()')
        .catch(() => null);
    }, 900_000, "the live review");
    await grab(12);
  }

  await page.click('.nav-btn[data-view="overview"]');
  await pause(350);
  await grab(8);

  console.log(`captured ${frame} frames → encoding`);
  mkdirSync(dirname(OUT), { recursive: true });
  const palette = join(frameDir, "palette.png");
  const input = join(frameDir, "f-%04d.png");
  const scale = `scale=${GIF_WIDTH}:-1:flags=lanczos`;
  // dither=none is not cosmetic here: ordered dithering sprays per-pixel noise
  // that differs every frame, which defeats GIF inter-frame compression — the
  // same tour weighed 2.1 MB with bayer and ~150 KB without. A flat dark UI has
  // no gradients to dither anyway.
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(FPS), "-i", input,
    "-vf", `${scale},palettegen=stats_mode=diff:max_colors=128`, palette]);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(FPS), "-i", input, "-i", palette,
    "-lavfi", `${scale}[x];[x][1:v]paletteuse=dither=none`, "-loop", "0", OUT]);
  const size = execFileSync("du", ["-h", OUT]).toString().split("\t")[0];
  console.log(`wrote ${OUT} (${size})`);
} finally {
  cdp.close();
  chrome.close();
  server.close();
  rmSync(frameDir, { recursive: true, force: true });
}
