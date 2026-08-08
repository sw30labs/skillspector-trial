// Skillspector end-to-end test — drives the real deck in real Chrome.
//
//   node tests/run-e2e.mjs                 # deck only (fast, no model needed)
//   node tests/run-e2e.mjs --analyst       # + a live OMLX review (minutes)
//   node tests/run-e2e.mjs --headful       # watch it happen
//   node tests/run-e2e.mjs --shots <dir>   # where screenshots land
//
// Starts its own bridge on a free port, so it never collides with a deck you
// already have open.
//
// Author: Nic Cravino — Skillspector
// License: MIT
import assert from "node:assert";
import http from "node:http";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { launchChrome, CDP, Page, waitFor } from "./cdp.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const bridge = await import(resolve(__dirname, "../server.mjs"));

const argv = process.argv.slice(2);
const WANT_ANALYST = argv.includes("--analyst");
const HEADLESS = !argv.includes("--headful");
const SHOT_DIR = (() => {
  const i = argv.indexOf("--shots");
  return i !== -1 && argv[i + 1] ? argv[i + 1] : join(__dirname, "..", "docs", "screenshots");
})();
const ANALYST_TIMEOUT_MS = Number(process.env.E2E_ANALYST_TIMEOUT_MS || 900_000);

let passed = 0, failed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log("  ✓ " + name);
  } catch (e) {
    failed++;
    failures.push({ name, err: e });
    console.log("  ✗ " + name);
    console.log("      " + (e && e.message ? e.message : e));
  }
}
function section(t) { console.log("\n" + t); }

mkdirSync(SHOT_DIR, { recursive: true });

// ── bring up the bridge on a free port ──────────────────────────────────────
const server = http.createServer(bridge.createHandler({ engineVersion: "e2e" }));
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const BASE = `http://127.0.0.1:${server.address().port}`;
console.log(`bridge  ${BASE}`);

const chrome = await launchChrome({ headless: HEADLESS });
const cdp = await CDP.connect(chrome.wsUrl);
const page = await Page.open(cdp, BASE);
await page.setViewport(1600, 1100);
console.log(`chrome  ${HEADLESS ? "headless" : "headful"}\n`);

/** Findings tests must not inherit each other's filter state. */
async function resetFindingFilters() {
  await page.eval(`(() => {
    const d = globalThis.__skillspectorDeck;
    const i = document.getElementById("find-search");
    i.value = "";
    i.dispatchEvent(new Event("input"));
    d.state.filters = null;
    d.state.findSort = { key: "severity", dir: "asc" };
    i.dispatchEvent(new Event("input"));
  })()`);
}

/** Rule ids live in the second column; the location column is also .mono. */
const RULE_CELLS = '[...document.querySelectorAll("#find-tbody tr td:nth-child(2)")].map(t => t.textContent)';

async function shot(name) {
  const p = join(SHOT_DIR, name);
  await page.screenshot(p);
  return p;
}

try {
  // =========================================================================
  section("deck — shell");
  // =========================================================================
  await test("boot sequence completes and hands over to the deck", async () => {
    await page.waitForEval('document.getElementById("boot").classList.contains("done")', 15000, "boot to finish");
    assert.strictEqual(await page.eval('document.querySelector(".brand b").textContent'), "SKILLSPECTOR");
  });

  await test("header reports the engine version and a live bridge", async () => {
    const engine = await page.eval('document.getElementById("badge-engine").textContent');
    assert.match(engine, /^ENGINE \d+\.\d+\.\d+$/, engine);
    const bridgeBadge = await page.waitForEval(
      '(() => { const t = document.getElementById("badge-bridge").textContent; return t.indexOf("OFFLINE") === -1 ? t : null; })()',
      10000, "bridge badge to go online");
    assert.match(bridgeBadge, /DeepSeek/i, bridgeBadge);
  });

  await test("all six views are present and navigable", async () => {
    const views = ["overview", "findings", "capabilities", "bundle", "analyst", "about"];
    for (const v of views) {
      await page.click(`.nav-btn[data-view="${v}"]`);
      const active = await page.eval('document.querySelector(".view.active").id');
      assert.strictEqual(active, "view-" + v, `expected view-${v}, got ${active}`);
    }
    await page.click('.nav-btn[data-view="overview"]');
  });

  await test("the deck is dark-first, matching the atlas palette", async () => {
    const cyan = await page.eval('getComputedStyle(document.documentElement).getPropertyValue("--cyan").trim()');
    const bg = await page.eval('getComputedStyle(document.body).backgroundColor');
    assert.strictEqual(cyan, "#22d3ee");
    assert.strictEqual(bg, "rgb(4, 6, 12)");
  });

  await test("the ambient starfield canvas is live", async () => {
    const w = await page.eval('document.getElementById("bg-canvas").width');
    assert.ok(w > 0, "canvas should be sized to the window");
  });

  await test("report panels stay hidden until something is scanned", async () => {
    // Regression: .grid sets display, which outranks the UA's [hidden] rule,
    // so an empty "Verdict & Grade" panel used to sit on the standby screen.
    for (const id of ["report-row", "verdict-panel", "adjudication-panel", "triage-panel", "exportAllBtn"]) {
      const shown = await page.eval(
        `(() => { const el = document.getElementById(${JSON.stringify(id)}); return el ? getComputedStyle(el).display : "missing"; })()`);
      assert.strictEqual(shown, "none", `#${id} should not be visible before a scan`);
    }
  });

  await shot("01-standby.png");

  // =========================================================================
  section("deck — scan");
  // =========================================================================
  await test("the demo skill scans and grades F", async () => {
    await page.click("#demoBtn");
    await page.waitForEval(
      '(() => { const d = globalThis.__skillspectorDeck; return d && d.state.result ? 1 : null; })()',
      20000, "the scan to finish");
    const grade = await page.eval("globalThis.__skillspectorDeck.state.active.grade");
    const score = await page.eval("globalThis.__skillspectorDeck.state.active.score");
    assert.strictEqual(grade, "F", `demo skill should grade F, got ${grade}`);
    assert.ok(score <= 20, `expected a low score, got ${score}`);
  });

  await test("KPI tiles render the grade, criticals and capabilities", async () => {
    const labels = await page.eval('[...document.querySelectorAll("#kpis .k-label")].map(n => n.textContent)');
    assert.deepStrictEqual(labels, ["Grade", "Critical", "High", "Findings", "Capabilities", "Bundle"]);
    const gradeTile = await page.eval('document.querySelector("#kpis .k-value").textContent');
    assert.strictEqual(gradeTile, "F");
  });

  await test("the grade gauge draws an arc proportional to the score", async () => {
    const dash = await page.eval('document.querySelector(".gauge .g-fill").getAttribute("stroke-dasharray")');
    const offset = Number(await page.eval('document.querySelector(".gauge .g-fill").getAttribute("stroke-dashoffset")'));
    const score = await page.eval("globalThis.__skillspectorDeck.state.active.score");
    const expected = Number(dash) * (1 - score / 100);
    assert.ok(Math.abs(offset - expected) < 1, `arc offset ${offset} should track score ${score}`);
  });

  await test("severity pills carry the engine's own counts", async () => {
    const pills = await page.eval(
      '[...document.querySelectorAll("#sev-pills .sev-pill")].map(p => [p.dataset.sev, Number(p.querySelector(".n").textContent)])');
    const summary = await page.eval("globalThis.__skillspectorDeck.state.active.summary");
    for (const [sev, n] of pills) assert.strictEqual(n, summary[sev], `${sev} count`);
  });

  await test("the live line summarises the scan", async () => {
    const line = await page.eval('document.getElementById("live-line").textContent');
    assert.match(line, /grade F/);
    assert.match(line, /critical/);
  });

  await test("the activity log records the scan", async () => {
    const log = await page.eval('document.getElementById("event-log").textContent');
    assert.match(log, /scan/);
    assert.match(log, /complete/);
  });

  await shot("02-scanning.png");

  // =========================================================================
  section("deck — findings");
  // =========================================================================
  await test("every finding is listed in the register", async () => {
    await page.click('.nav-btn[data-view="findings"]');
    await resetFindingFilters();
    const rows = await page.eval('document.querySelectorAll("#find-tbody tr").length');
    const total = await page.eval("globalThis.__skillspectorDeck.state.active.findings.length");
    assert.ok(total > 0, "the demo skill must produce findings");
    assert.strictEqual(rows, total);
  });

  await test("the search box filters the register", async () => {
    await resetFindingFilters();
    await page.eval(
      '(() => { const i = document.getElementById("find-search"); i.value = "SEC-001"; i.dispatchEvent(new Event("input")); })()');
    const rows = await page.eval(RULE_CELLS);
    assert.ok(rows.length > 0, "SEC-001 should match at least one finding");
    assert.ok(rows.every((r) => r === "SEC-001"), `unexpected rows: ${rows.join(",")}`);
    await resetFindingFilters();
  });

  await test("a severity pill filters the register", async () => {
    await resetFindingFilters();
    const before = await page.eval('document.querySelectorAll("#find-tbody tr").length');
    await page.click('#find-filters .sev-pill[data-sev="critical"]');
    const after = await page.eval('document.querySelectorAll("#find-tbody tr").length');
    const crit = await page.eval("globalThis.__skillspectorDeck.state.active.summary.critical");
    assert.strictEqual(after, before - crit, "toggling critical off should drop exactly the criticals");
    await page.click('#find-filters .sev-pill[data-sev="critical"]');
    assert.strictEqual(await page.eval('document.querySelectorAll("#find-tbody tr").length'), before);
  });

  await test("sorting by rule reorders the register", async () => {
    await resetFindingFilters();
    await page.click('#find-table th[data-sort="ruleId"]');
    const asc = await page.eval(RULE_CELLS);
    assert.ok(asc.length > 1, "need more than one row to prove sorting");
    assert.deepStrictEqual(asc, [...asc].sort(), "ascending sort should be sorted");
    await page.click('#find-table th[data-sort="ruleId"]');
    const desc = await page.eval(RULE_CELLS);
    assert.deepStrictEqual(desc, [...asc].reverse());
    await resetFindingFilters();
  });

  await test("clicking a finding opens the evidence modal", async () => {
    await resetFindingFilters();
    await page.click("#find-tbody tr");
    assert.ok(await page.eval('document.getElementById("modal-overlay").classList.contains("open")'));
    const body = await page.eval('document.getElementById("modal-body").textContent');
    assert.match(body, /Why it matters/);
    assert.match(body, /Evidence/);
    await shot("04-findings.png");
    await page.click("#modal-close");
    assert.ok(!(await page.eval('document.getElementById("modal-overlay").classList.contains("open")')));
  });

  await test("invisible characters stay escaped in the evidence", async () => {
    // The engine renders them as \u{...}; the deck must not undo that.
    const raw = await page.eval(
      'JSON.stringify(globalThis.__skillspectorDeck.state.active.findings.map(f => f.excerpt).join(""))');
    assert.ok(!/[​‌‍⁠﻿]/.test(raw), "no raw invisible characters may reach the DOM");
  });

  // =========================================================================
  section("deck — capabilities & bundle");
  // =========================================================================
  await test("capability cards list their evidence", async () => {
    await page.click('.nav-btn[data-view="capabilities"]');
    const cards = await page.eval('document.querySelectorAll("#cap-grid .scn-card").length');
    const caps = await page.eval("globalThis.__skillspectorDeck.state.active.capabilities.length");
    assert.ok(caps > 0, "the demo skill reaches several surfaces");
    assert.strictEqual(cards, caps);
    const chips = await page.eval('document.querySelectorAll("#cap-grid .tag").length');
    assert.ok(chips > 0, "each capability should show where it was seen");
  });

  await test("the bundle view lists frontmatter, roots and every file", async () => {
    await page.click('.nav-btn[data-view="bundle"]');
    const fm = await page.eval('document.getElementById("fm-body").textContent');
    assert.match(fm, /Demo_Helper/);
    const roots = await page.eval('document.querySelectorAll("#roster-tbody tr").length');
    assert.strictEqual(roots, 1);
    const files = await page.eval('document.querySelectorAll("#files-tbody tr").length');
    assert.strictEqual(files, 4, "the demo bundle has 4 files");
    const manifest = await page.eval('document.getElementById("files-tbody").textContent');
    assert.match(manifest, /SKILL\.md/);
    assert.match(manifest, /helper\.py/);
  });

  await test("the file manifest attributes findings to their file", async () => {
    const rows = await page.eval(
      '[...document.querySelectorAll("#files-tbody tr")].map(tr => [...tr.children].map(td => td.textContent))');
    const skillMd = rows.find((r) => /SKILL\.md$/.test(r[0]));
    assert.ok(skillMd, "SKILL.md must be in the manifest");
    assert.ok(Number(skillMd[3]) > 0, "SKILL.md should carry rule hits");
  });

  // Built here, not inside the page expression: escaping a multi-line document
  // through a template literal into Runtime.evaluate is a trap worth avoiding.
  const OUTER_SKILL_MD = [
    "---", "name: outer-skill",
    "description: An outer skill. Use when the user asks for the outer thing.",
    "---", "", "# Outer", "",
  ].join("\n");
  const INNER_SKILL_MD = [
    "---", "name: inner-skill",
    "description: An inner skill. Use when the user asks for the inner thing.",
    "---", "", "# Inner", "",
  ].join("\n");

  const CLEAN_SKILL_MD = [
    "---",
    "name: tidy-notes",
    "description: Summarise meeting notes into action items. Use when the user shares raw notes.",
    "---",
    "",
    "# Tidy Notes",
    "",
    "Read the notes the user provides and return a short list of action items.",
    "Never run shell commands; this skill only reads text the user pastes in.",
  ].join("\n");

  await test("a bundle with several skills lists every root", async () => {
    await page.eval(`(() => {
      const enc = new TextEncoder();
      const d = globalThis.__skillspectorDeck;
      d.state.result = null;
      d.runScan([
        ...d.buildDemoEntries(),
        { path: "tidy-notes/SKILL.md", bytes: enc.encode(${JSON.stringify(CLEAN_SKILL_MD)}) },
      ]);
    })()`);
    await page.waitForEval(
      '(() => { const d = globalThis.__skillspectorDeck; return d.state.result && d.state.result.skills.length === 2 ? 1 : null; })()',
      20000, "the multi-skill scan");
    await page.click('.nav-btn[data-view="bundle"]');
    const rows = await page.eval('document.querySelectorAll("#roster-tbody tr").length');
    assert.strictEqual(rows, 2);
    const names = await page.eval('[...document.querySelectorAll("#roster-tbody tr td:first-child")].map(t => t.textContent)');
    assert.ok(names.some((n) => /tidy-notes/.test(n)), names.join(","));
  });

  await test("the clean skill grades well while the hostile one still fails", async () => {
    const grades = JSON.parse(await page.eval(
      'JSON.stringify(globalThis.__skillspectorDeck.state.result.skills.map(s => [s.name, s.grade]))'));
    const tidy = grades.find((g) => /tidy-notes/.test(g[0]));
    const demo = grades.find((g) => /Demo_Helper|demo-skill/.test(g[0]));
    assert.ok(tidy, "tidy-notes should be its own root: " + JSON.stringify(grades));
    assert.ok("AB".includes(tidy[1]), `a benign skill should grade well, got ${tidy[1]}`);
    assert.strictEqual(demo[1], "F");
  });

  await test("selecting another root switches the whole deck to it", async () => {
    await page.eval(`(() => {
      const rows = [...document.querySelectorAll("#roster-tbody tr")];
      const tidy = rows.find(r => /tidy-notes/.test(r.textContent));
      tidy.click();
    })()`);
    const active = await page.eval("globalThis.__skillspectorDeck.state.active.name");
    assert.match(active, /tidy-notes/);
    const badge = await page.eval('document.getElementById("badge-grade").textContent');
    assert.match(badge, /GRADE [AB]/, badge);
    const files = await page.eval('document.querySelectorAll("#files-tbody tr").length');
    assert.strictEqual(files, 1, "the manifest should follow the selected root");
  });

  await test("export-all appears only when the bundle holds several skills", async () => {
    await page.click('.nav-btn[data-view="findings"]');
    const display = await page.eval('getComputedStyle(document.getElementById("exportAllBtn")).display');
    assert.notStrictEqual(display, "none", "export-all should surface for a multi-skill scan");
    const md = await page.eval(`(() => {
      let captured = null;
      const orig = URL.createObjectURL;
      URL.createObjectURL = (blob) => { captured = blob; return "blob:stub"; };
      document.getElementById("exportAllBtn").click();
      URL.createObjectURL = orig;
      return captured ? captured.text() : null;
    })()`);
    assert.match(md, /^# Skillspector scan — 2 skills/m);
    assert.match(md, /## Overview/);
    assert.match(md, /tidy-notes/);
  });

  await test("rescanning the demo skill restores the single-skill deck", async () => {
    await page.click('.nav-btn[data-view="overview"]');
    await page.click("#demoBtn");
    await page.waitForEval(
      '(() => { const d = globalThis.__skillspectorDeck; return d.state.result && d.state.result.skills.length === 1 ? 1 : null; })()',
      20000, "the rescan");
    assert.strictEqual(await page.eval("globalThis.__skillspectorDeck.state.active.grade"), "F");
    assert.strictEqual(
      await page.eval('getComputedStyle(document.getElementById("exportAllBtn")).display'), "none");
  });

  await shot("05-summary.png");

  // =========================================================================
  section("deck — exports");
  // =========================================================================
  await test("markdown export builds a full report", async () => {
    const md = await page.eval(`(() => {
      let captured = null;
      const orig = URL.createObjectURL;
      URL.createObjectURL = (blob) => { captured = blob; return "blob:stub"; };
      document.getElementById("exportMdBtn").click();
      URL.createObjectURL = orig;
      return captured ? captured.text() : null;
    })()`);
    assert.ok(md, "export should produce a blob");
    assert.match(md, /^# Skillspector report — /m);
    assert.match(md, /## Summary/);
    assert.match(md, /## Capabilities/);
    assert.match(md, /## Findings/);
    assert.match(md, /SEC-001/);
  });

  await test("json export carries the whole scan result", async () => {
    const text = await page.eval(`(() => {
      let captured = null;
      const orig = URL.createObjectURL;
      URL.createObjectURL = (blob) => { captured = blob; return "blob:stub"; };
      document.getElementById("exportJsonBtn").click();
      URL.createObjectURL = orig;
      return captured ? captured.text() : null;
    })()`);
    const data = JSON.parse(text);
    assert.ok(data.scan.skills.length >= 1);
    assert.ok(data.scan.version);
    assert.strictEqual(data.scan.skills[0].grade, "F");
  });

  // =========================================================================
  section("deck — analyst wiring");
  // =========================================================================
  await test("the analyst view probes OMLX and lists its models", async () => {
    await page.click('.nav-btn[data-view="analyst"]');
    const status = await page.waitForEval(
      '(() => { const t = document.getElementById("backend-status").textContent; return /reachable/.test(t) ? t : null; })()',
      20000, "the OMLX probe");
    assert.match(status, /omlx reachable at http:\/\/127\.0\.0\.1:8000\/v1/);
    const models = await page.eval('[...document.querySelectorAll("#f-model option")].map(o => o.value).filter(Boolean)');
    assert.ok(models.includes("DeepSeek-V4-Flash-0731-MLX"), `models: ${models.join(",")}`);
  });

  await test("the review button is armed once a skill is loaded", async () => {
    assert.strictEqual(await page.eval('document.getElementById("runAnalysisBtn").disabled'), false);
    assert.strictEqual(await page.eval('document.getElementById("chatBtn").disabled'), false);
  });

  await test("the three review passes are shown before any run", async () => {
    const stages = await page.eval('[...document.querySelectorAll("#analyst-stages .sn")].map(n => n.textContent)');
    assert.deepStrictEqual(stages, ["Triage", "Adjudicate", "Verdict"]);
  });

  await test("the payload sent to the model carries SKILL.md and the findings", async () => {
    const payload = await page.eval(`(() => {
      let body = null;
      const orig = window.fetch;
      window.fetch = (url, opts) => {
        if (String(url).endsWith("/api/analyze")) { body = opts.body; return Promise.reject(new Error("intercepted")); }
        return orig(url, opts);
      };
      document.getElementById("runAnalysisBtn").click();
      window.fetch = orig;
      return body;
    })()`);
    const parsed = JSON.parse(payload);
    assert.match(parsed.skill_md, /Ignore all previous instructions/);
    assert.strictEqual(parsed.files.length, 4);
    assert.ok(parsed.report.findings.length > 0);
    assert.ok(parsed.report.findings[0].excerpt !== undefined, "evidence must travel with the finding");
  });

  // =========================================================================
  if (WANT_ANALYST) {
    section("analyst — live OMLX review (this takes minutes)");

    await test("a full three-pass review completes against the real model", async () => {
      await page.eval('document.getElementById("runAnalysisBtn").click()');
      const t0 = Date.now();
      let lastNote = "";
      const done = await waitFor(async () => {
        const st = await page.eval(`(() => {
          const d = globalThis.__skillspectorDeck;
          return JSON.stringify({ job: d.state.jobId, analysis: !!(d.state.analysis && d.state.analysis.verdict),
                                  stage: (document.querySelector("#analyst-stages .active .sn") || {}).textContent || "",
                                  note: (document.querySelector("#analyst-stages .active .sv") || {}).textContent || "" });
        })()`);
        const s = JSON.parse(st);
        const note = `${s.stage} ${s.note}`.trim();
        if (note && note !== lastNote) {
          lastNote = note;
          console.log(`      … ${Math.round((Date.now() - t0) / 1000)}s  ${note}`);
        }
        if (s.analysis) return s;
        if (!s.job && !s.analysis) {
          const err = await page.eval('document.getElementById("event-log").textContent');
          if (/analysis_error/.test(err)) throw new Error("the bridge reported an analysis error: " + err.slice(0, 300));
        }
        return null;
      }, ANALYST_TIMEOUT_MS, "the live review");
      assert.ok(done.analysis);
      console.log(`      review finished in ${Math.round((Date.now() - t0) / 1000)}s`);
    });

    await test("the verdict panel renders a recommendation and actions", async () => {
      const v = await page.eval("JSON.stringify(globalThis.__skillspectorDeck.state.analysis.verdict)");
      const verdict = JSON.parse(v);
      assert.ok(["allow", "caution", "block"].includes(verdict.recommendation), verdict.recommendation);
      assert.ok("ABCDF".includes(verdict.adjusted_grade));
      const badge = await page.eval('document.querySelector(".verdict-badge").textContent');
      assert.strictEqual(badge, verdict.recommendation);
      const headline = await page.eval('document.querySelector(".verdict-headline").textContent');
      assert.ok(headline.length > 0);
      console.log(`      verdict: ${verdict.recommendation} · grade ${verdict.adjusted_grade} · "${headline}"`);
    });

    await test("the model blocks this deliberately hostile demo skill", async () => {
      const rec = await page.eval("globalThis.__skillspectorDeck.state.analysis.verdict.recommendation");
      assert.strictEqual(rec, "block", `a credential-exfiltrating skill must not be cleared (got ${rec})`);
    });

    await test("triage reports the injection attempt the rules also caught", async () => {
      const t = JSON.parse(await page.eval("JSON.stringify(globalThis.__skillspectorDeck.state.analysis.triage)"));
      assert.ok(t.intent && t.intent.length > 0);
      assert.strictEqual(t.injection_attempt, true, "SKILL.md openly instructs the agent to ignore prior instructions");
    });

    await test("every finding sent to the model comes back adjudicated", async () => {
      const adj = JSON.parse(await page.eval("JSON.stringify(globalThis.__skillspectorDeck.state.analysis.adjudications)"));
      const total = await page.eval("globalThis.__skillspectorDeck.state.active.findings.length");
      assert.strictEqual(adj.length, Math.min(total, 24));
      for (const a of adj) {
        assert.ok(["confirmed", "false_positive", "needs_review"].includes(a.status), a.status);
        assert.ok(a.ruleId && a.file !== undefined);
      }
      const table = await page.eval('document.querySelectorAll("#adj-tbody tr").length');
      assert.strictEqual(table, adj.length);
    });

    await test("adjudications are folded back into the finding register", async () => {
      await page.click('.nav-btn[data-view="findings"]');
      const verdicts = await page.eval(
        '[...document.querySelectorAll("#find-tbody tr td:last-child")].map(t => t.textContent.trim())');
      assert.ok(verdicts.some((v) => v !== "—"), "at least one row should carry an analyst verdict");
      await page.click('.nav-btn[data-view="analyst"]');
    });

    await test("the analyst KPI tile replaces the bundle tile after a review", async () => {
      await page.click('.nav-btn[data-view="overview"]');
      const labels = await page.eval('[...document.querySelectorAll("#kpis .k-label")].map(n => n.textContent)');
      assert.ok(labels.includes("Analyst"), labels.join(","));
      await page.click('.nav-btn[data-view="analyst"]');
    });

    await test("the review is recorded in history with its token spend", async () => {
      const rows = await page.eval(
        '[...document.querySelectorAll("#job-tbody tr")].map(tr => [...tr.children].map(td => td.textContent))');
      assert.ok(rows.length >= 1 && rows[0][0].startsWith("an_"), JSON.stringify(rows));
      assert.strictEqual(rows[0][2], "done");
      assert.ok(Number(rows[0][4]) > 0, "token spend should be recorded");
    });

    await test("the markdown export carries the analyst verdict", async () => {
      await page.click('.nav-btn[data-view="findings"]');
      const md = await page.eval(`(() => {
        let captured = null;
        const orig = URL.createObjectURL;
        URL.createObjectURL = (blob) => { captured = blob; return "blob:stub"; };
        document.getElementById("exportMdBtn").click();
        URL.createObjectURL = orig;
        return captured ? captured.text() : null;
      })()`);
      assert.match(md, /## Analyst verdict \(local model\)/);
      assert.match(md, /\*\*Recommendation:\*\* BLOCK/);
      await page.click('.nav-btn[data-view="analyst"]');
    });

    await shot("03-report.png");

    await test("the analyst answers a follow-up question about the skill", async () => {
      await page.eval(`(() => {
        const i = document.getElementById("chat-input");
        i.value = "In one sentence: which file exfiltrates data, and where does it send it?";
        document.getElementById("chatBtn").click();
      })()`);
      const answer = await waitFor(async () => {
        const turns = JSON.parse(await page.eval("JSON.stringify(globalThis.__skillspectorDeck.state.chat)"));
        const last = turns[turns.length - 1];
        if (last && last.role === "assistant" && !/thinking/.test(last.content)) return last;
        return null;
      }, ANALYST_TIMEOUT_MS, "the chat answer");
      assert.ok(!answer.error, "chat should not error: " + answer.content);
      assert.ok(answer.content.length > 10, answer.content);
      console.log(`      answer: ${answer.content.slice(0, 160).replace(/\s+/g, " ")}…`);
      const rendered = await page.eval('document.getElementById("chat-log").textContent');
      assert.ok(rendered.includes(answer.content.slice(0, 40)));
    });

    await shot("06-analyst.png");
  } else {
    section("analyst — live OMLX review");
    console.log("  – skipped (pass --analyst to run it)");
  }

  // =========================================================================
  section("deck — analyst state handling");
  // =========================================================================
  await test("two findings sharing a rule, file and line keep separate verdicts", async () => {
    // The engine emits several QUA-003 variants against SKILL.md:1. Keying the
    // adjudication index by rule|file|line alone let one overwrite the other.
    await page.click('.nav-btn[data-view="findings"]');
    await resetFindingFilters();
    const dupes = JSON.parse(await page.eval(`(() => {
      const fs = globalThis.__skillspectorDeck.state.active.findings;
      const byKey = {};
      for (const f of fs) {
        const k = f.ruleId + "|" + f.file + "|" + f.line;
        (byKey[k] = byKey[k] || []).push(f);
      }
      const group = Object.values(byKey).find(g => g.length > 1) || [];
      return JSON.stringify(group.map(f => ({ ord: f.ord, ruleId: f.ruleId, severity: f.severity, title: f.title, file: f.file, line: f.line })));
    })()`));
    assert.ok(dupes.length > 1, "the demo skill must contain a same-rule/file/line pair to test with");
    assert.notStrictEqual(dupes[0].ord, dupes[1].ord, "each finding must carry its own ordinal");

    await page.eval(`(() => {
      const g = ${JSON.stringify(dupes)};
      globalThis.__skillspectorDeck.applyAnalysis({
        triage: null,
        verdict: { recommendation: "block", adjusted_grade: "F", confidence: 1, headline: "h", rationale: "r", actions: [] },
        adjudications: g.map((f, i) => ({ ...f, status: i === 0 ? "confirmed" : "false_positive",
                                          confidence: 0.9, note: "verdict for #" + (i + 1) })),
        usage: { total_tokens: 1, calls: 1 },
      });
    })()`);

    const notes = JSON.parse(await page.eval(`(() => {
      const d = globalThis.__skillspectorDeck;
      const g = ${JSON.stringify(dupes)};
      return JSON.stringify(g.map(f => d.state.adjIndex[d.adjKey(f)] || null));
    })()`));
    assert.strictEqual(notes.length, dupes.length);
    assert.strictEqual(notes[0].status, "confirmed");
    assert.strictEqual(notes[1].status, "false_positive");
    assert.notStrictEqual(notes[0].note, notes[1].note);

    const statuses = await page.eval(
      '[...document.querySelectorAll("#find-tbody tr td:last-child")].map(t => t.textContent.trim())');
    assert.ok(statuses.includes("confirmed"), statuses.join(","));
    assert.ok(statuses.includes("false positive"), statuses.join(","));
  });

  await test("a triage-only result does not print 'analyst says undefined'", async () => {
    await page.eval(`(() => {
      globalThis.__skillspectorDeck.applyAnalysis({
        triage: { intent: "half-finished", behaviours: [], undeclared: [], semantic_risks: [], injection_attempt: false, notes: "" },
        adjudications: [], verdict: null, usage: {},
      });
    })()`);
    await page.click('.nav-btn[data-view="overview"]');
    const line = await page.eval('document.getElementById("live-line").textContent');
    assert.ok(!/undefined/.test(line), line);
    // …and the model-read panel still surfaces what the first pass produced.
    await page.click('.nav-btn[data-view="capabilities"]');
    assert.strictEqual(await page.eval('getComputedStyle(document.getElementById("triage-panel")).display') === "none", false);
    assert.match(await page.eval('document.getElementById("triage-body").textContent'), /half-finished/);
  });

  await test("a review that finishes after a root switch is not shown as the new skill's", async () => {
    // Reproduces the cross-skill bleed: start a review on skill A, switch to B
    // while it runs, and the poller must not paint A's verdict onto B.
    await page.eval(`(() => {
      const enc = new TextEncoder();
      const d = globalThis.__skillspectorDeck;
      d.state.result = null;
      d.runScan([
        ...d.buildDemoEntries(),
        { path: "tidy-notes/SKILL.md", bytes: enc.encode(${JSON.stringify(CLEAN_SKILL_MD)}) },
      ]);
    })()`);
    await page.waitForEval(
      '(() => { const d = globalThis.__skillspectorDeck; return d.state.result && d.state.result.skills.length === 2 ? 1 : null; })()',
      20000, "the multi-skill scan");

    const outcome = JSON.parse(await page.eval(`(async () => {
      const d = globalThis.__skillspectorDeck;
      const demo = d.state.result.skills.find(s => /Demo_Helper|demo-skill/.test(s.name));
      const tidy = d.state.result.skills.find(s => /tidy-notes/.test(s.name));
      d.selectSkill(demo.rootPath);

      const orig = window.fetch;
      let finished = false;
      const job = {
        id: "an_test", status: "running", skill: "Demo_Helper",
        progress: { stage: "triage", note: "x" }, usage: { total_tokens: 1 }, result: null,
      };
      window.fetch = (url, opts) => {
        const u = String(url);
        if (u.endsWith("/api/analyze")) return Promise.resolve(new Response(JSON.stringify({ job_id: "an_test" }), { status: 202 }));
        if (u.includes("/api/jobs/")) {
          const body = finished
            ? { ...job, status: "done",
                result: { verdict: { recommendation: "block", adjusted_grade: "F", confidence: 1, headline: "A's verdict", rationale: "r", actions: [] },
                          triage: null, adjudications: [], usage: {}, skill: "Demo_Helper" } }
            : job;
          return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
        }
        if (u.includes("/api/events") || u.endsWith("/api/jobs")) {
          return Promise.resolve(new Response(JSON.stringify({ events: [], jobs: [] }), { status: 200 }));
        }
        return orig(url, opts);
      };

      document.getElementById("runAnalysisBtn").click();
      await new Promise(r => setTimeout(r, 400));
      const startedOn = d.state.jobRoot;
      d.selectSkill(tidy.rootPath);          // user switches mid-review
      finished = true;
      await new Promise(r => setTimeout(r, 2600));   // let the poller land it
      window.fetch = orig;
      return JSON.stringify({
        startedOn, activeNow: d.state.active.name,
        analysis: d.state.analysis ? d.state.analysis.verdict.headline : null,
        jobId: d.state.jobId,
      });
    })()`));
    assert.match(outcome.startedOn, /demo-skill/);
    assert.match(outcome.activeNow, /tidy-notes/);
    assert.strictEqual(outcome.analysis, null, "skill A's verdict must not be shown as skill B's");
    assert.strictEqual(outcome.jobId, null, "the poller should have stopped");
  });

  await test("nested skill roots do not steal each other's files", async () => {
    const counts = JSON.parse(await page.eval(`(async () => {
      const enc = new TextEncoder();
      const d = globalThis.__skillspectorDeck;
      d.state.result = null;
      d.runScan([
        { path: "outer/SKILL.md", bytes: enc.encode(${JSON.stringify(OUTER_SKILL_MD)}) },
        { path: "outer/notes.md", bytes: enc.encode("# outer notes") },
        { path: "outer/inner/SKILL.md", bytes: enc.encode(${JSON.stringify(INNER_SKILL_MD)}) },
        { path: "outer/inner/helper.md", bytes: enc.encode("# inner helper") },
      ]);
      for (let i = 0; i < 100 && !d.state.result; i++) await new Promise(r => setTimeout(r, 100));
      return JSON.stringify(d.state.result.skills.map(s => ({
        root: s.rootPath, files: d.entriesForSkill(s).map(e => e.path).sort(),
      })));
    })()`));
    assert.strictEqual(counts.length, 2, JSON.stringify(counts));
    const outer = counts.find((c) => c.root === "outer/");
    const inner = counts.find((c) => c.root === "outer/inner/");
    assert.ok(outer && inner, JSON.stringify(counts));
    assert.deepStrictEqual(outer.files, ["outer/SKILL.md", "outer/notes.md"],
      "the outer root must not claim the nested skill's files");
    assert.deepStrictEqual(inner.files, ["outer/inner/SKILL.md", "outer/inner/helper.md"].sort());
  });

  await test("clearing the activity log does not refill from the bridge replay", async () => {
    const after = await page.eval(`(async () => {
      const d = globalThis.__skillspectorDeck;
      const before = d.state.log.length;
      document.getElementById("clearEvents").click();
      // The bridge replays its whole ring on every poll; the dedupe set has to
      // survive the clear or those events walk straight back in.
      const replay = { at: new Date().toISOString(), kind: "stage", note: "replayed" };
      d.state.log.push(replay);
      const key = replay.at + "|stage|replayed";
      d.state.logSeen[key] = 1;
      d.state.log.length = 0;
      return d.state.log.length + "/" + (d.state.logSeen[key] ? "kept" : "lost") + "/" + before;
    })()`);
    assert.match(after, /kept/, "the dedupe set must survive CLEAR");
    assert.strictEqual(await page.eval('document.getElementById("event-log").textContent').then((t) => /NO ACTIVITY|replayed/.test(t)), true);
  });

  await test("the ASK button is dead while a review holds the model", async () => {
    // The local model is single-writer: a question fired mid-review competes
    // with it for the GPU and can push the running pass past its timeout.
    const r = JSON.parse(await page.eval(`(() => {
      const d = globalThis.__skillspectorDeck;
      const btn = document.getElementById("chatBtn");
      const run = document.getElementById("runAnalysisBtn");
      const saved = d.state.jobId;
      d.state.bridgeOnline = true;

      d.state.jobId = null;
      d.updateAnalystControls();
      const idle = { chat: btn.disabled, run: run.disabled, label: run.textContent };

      d.state.jobId = "an_busy";
      d.updateAnalystControls();
      const busy = { chat: btn.disabled, run: run.disabled, label: run.textContent };

      d.state.jobId = saved;
      d.updateAnalystControls();
      return JSON.stringify({ idle, busy });
    })()`));
    assert.strictEqual(r.idle.chat, false, "ASK is live when nothing is running");
    assert.strictEqual(r.idle.run, false);
    assert.strictEqual(r.busy.chat, true, "ASK must be disabled while a review runs");
    assert.strictEqual(r.busy.run, true, "and so must RUN");
    assert.match(r.busy.label, /REVIEWING/);
  });

  await test("rescanning the demo skill leaves the deck in a clean single-skill state", async () => {
    await page.click('.nav-btn[data-view="overview"]');
    await page.click("#demoBtn");
    await page.waitForEval(
      '(() => { const d = globalThis.__skillspectorDeck; return d.state.result && d.state.result.skills.length === 1 ? 1 : null; })()',
      20000, "the rescan");
    assert.strictEqual(await page.eval("globalThis.__skillspectorDeck.state.analysis"), null);
    assert.strictEqual(await page.eval("globalThis.__skillspectorDeck.state.jobId"), null);
  });

  // =========================================================================
  section("deck — hygiene");
  // =========================================================================
  await test("no uncaught errors reached the console", async () => {
    const errs = page.consoleErrors.filter((e) => !/intercepted/.test(e));
    assert.deepStrictEqual(errs, [], errs.join("\n"));
  });

  await test("the deck is responsive down to a phone viewport", async () => {
    await page.setViewport(390, 844);
    await page.eval("window.dispatchEvent(new Event('resize'))");
    const navDir = await page.eval('getComputedStyle(document.querySelector("nav.side")).flexDirection');
    assert.strictEqual(navDir, "row", "the sidebar should become a scrolling top bar");
    const overflow = await page.eval("document.documentElement.scrollWidth <= window.innerWidth + 1");
    assert.strictEqual(overflow, true, "the page must not scroll horizontally");
    await page.setViewport(1600, 1100);
  });

  await test("the built file scans straight off file:// with no bridge at all", async () => {
    // The strongest form of the offline claim: no server, no origin, no fetch.
    const offline = await Page.open(cdp, "file://" + resolve(__dirname, "..", "index.html"));
    try {
      await offline.setViewport(1400, 900);
      await offline.waitForEval('document.getElementById("boot").classList.contains("done")', 15000, "boot");
      assert.strictEqual(await offline.eval("location.protocol"), "file:");
      assert.strictEqual(await offline.eval("window.SkillBridge.reachable"), false);
      assert.strictEqual(await offline.eval('document.getElementById("badge-bridge").textContent'), "BRIDGE OFFLINE");
      assert.match(
        await offline.eval('document.getElementById("backend-status").textContent'),
        /no bridge on this origin/);

      await offline.click("#demoBtn");
      await offline.waitForEval(
        '(() => { const d = globalThis.__skillspectorDeck; return d && d.state.result ? 1 : null; })()',
        20000, "the offline scan");
      assert.strictEqual(await offline.eval("globalThis.__skillspectorDeck.state.active.grade"), "F");
      assert.ok(await offline.eval("globalThis.__skillspectorDeck.state.active.findings.length") > 0);

      // The analyst must be inert, not broken, when there is nothing to talk to.
      assert.strictEqual(await offline.eval('document.getElementById("runAnalysisBtn").disabled'), true);
      assert.strictEqual(await offline.eval('document.getElementById("chatBtn").disabled'), true);
      assert.deepStrictEqual(offline.consoleErrors, [], offline.consoleErrors.join("\n"));
    } finally {
      await cdp.send("Target.closeTarget", { targetId: offline.targetId }).catch(() => {});
    }
  });
} finally {
  console.log("\n" + "=".repeat(52));
  console.log("  Skillspector end-to-end tests");
  console.log("  PASSED: " + passed + "   FAILED: " + failed + "   TOTAL: " + (passed + failed));
  console.log("=".repeat(52));
  if (failures.length) {
    console.log("\nFailures:");
    for (const f of failures) console.log("  - " + f.name + ": " + (f.err && f.err.message ? f.err.message : f.err));
  }
  cdp.close();
  chrome.close();
  server.close();
}
process.exit(failed > 0 ? 1 : 0);
