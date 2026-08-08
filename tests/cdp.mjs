// Minimal Chrome DevTools Protocol driver — zero dependencies.
// Node 22 ships a global WebSocket, which is all a CDP client really needs.
//
// Author: Nic Cravino — Skillspector
// License: MIT
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

import { statSync } from "node:fs";
function exists(p) {
  try { return statSync(p).isFile(); } catch { return false; }
}

export async function launchChrome({ port = 9333, headless = true } = {}) {
  const bin = CHROME_CANDIDATES.find(exists);
  if (!bin) throw new Error("no Chrome/Chromium binary found");
  const profile = mkdtempSync(join(tmpdir(), "skillspector-cdp-"));
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-extensions",
    "--disable-sync",
    "--disable-gpu",
    "--window-size=1600,1100",
    "about:blank",
  ];
  if (headless) args.unshift("--headless=new");
  const proc = spawn(bin, args, { stdio: "ignore", detached: false });

  const wsUrl = await waitFor(async () => {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`).catch(() => null);
    if (!r || !r.ok) return null;
    return (await r.json()).webSocketDebuggerUrl;
  }, 20000, "chrome devtools endpoint");

  return {
    proc,
    wsUrl,
    port,
    close() {
      try { proc.kill("SIGTERM"); } catch { /* already gone */ }
      setTimeout(() => { try { rmSync(profile, { recursive: true, force: true }); } catch {} }, 300);
    },
  };
}

export async function waitFor(fn, timeoutMs, label) {
  const started = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

export class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id != null && this.pending.has(msg.id)) {
        const { ok, fail } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) fail(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data || "")})`));
        else ok(msg.result);
      } else if (msg.method) {
        for (const l of this.listeners) l(msg);
      }
    });
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((ok, fail) => {
      ws.addEventListener("open", ok, { once: true });
      ws.addEventListener("error", () => fail(new Error("websocket failed")), { once: true });
    });
    return new CDP(ws);
  }

  on(fn) { this.listeners.push(fn); }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((ok, fail) => {
      this.pending.set(id, { ok, fail });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          fail(new Error(`CDP ${method} timed out`));
        }
      }, 120000);
    });
  }

  close() { try { this.ws.close(); } catch { /* already closed */ } }
}

export class Page {
  constructor(cdp, sessionId, targetId) {
    this.cdp = cdp;
    this.sessionId = sessionId;
    this.targetId = targetId;
    this.consoleErrors = [];
    this.consoleAll = [];
    cdp.on((msg) => {
      if (msg.sessionId !== sessionId) return;
      if (msg.method === "Runtime.consoleAPICalled") {
        const text = (msg.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(" ");
        this.consoleAll.push({ level: msg.params.type, text });
        if (msg.params.type === "error") this.consoleErrors.push(text);
      }
      if (msg.method === "Runtime.exceptionThrown") {
        const d = msg.params.exceptionDetails;
        const text = d.exception?.description || d.text;
        this.consoleAll.push({ level: "exception", text });
        this.consoleErrors.push(text);
      }
    });
  }

  static async open(cdp, url) {
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const page = new Page(cdp, sessionId, targetId);
    await cdp.send("Runtime.enable", {}, sessionId);
    await cdp.send("Page.enable", {}, sessionId);
    await page.goto(url);
    return page;
  }

  async goto(url) {
    await this.cdp.send("Page.navigate", { url }, this.sessionId);
    await waitFor(async () => {
      const r = await this.eval("document.readyState").catch(() => null);
      return r === "complete";
    }, 20000, `${url} to load`);
  }

  async eval(expression, { awaitPromise = true } = {}) {
    const res = await this.cdp.send(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise, allowUnsafeEvalBlockedByCSP: true },
      this.sessionId,
    );
    if (res.exceptionDetails) {
      throw new Error(
        res.exceptionDetails.exception?.description || res.exceptionDetails.text || "evaluation failed",
      );
    }
    return res.result.value;
  }

  async waitForEval(expression, timeoutMs, label) {
    return waitFor(() => this.eval(expression).catch(() => null), timeoutMs, label);
  }

  async click(selector) {
    const ok = await this.eval(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`,
    );
    if (!ok) throw new Error(`no element matched ${selector}`);
  }

  async screenshot(path) {
    const { data } = await this.cdp.send(
      "Page.captureScreenshot",
      { format: "png", captureBeyondViewport: false },
      this.sessionId,
    );
    writeFileSync(path, Buffer.from(data, "base64"));
    return path;
  }

  async setViewport(width, height) {
    await this.cdp.send(
      "Emulation.setDeviceMetricsOverride",
      { width, height, deviceScaleFactor: 1, mobile: false },
      this.sessionId,
    );
  }
}
