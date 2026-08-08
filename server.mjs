#!/usr/bin/env node
// ---------------------------------------------------------------------------
// server.mjs — Skillspector OMLX bridge.
//
// Serves the built single-file deck (index.html) and a small JSON API that
// lets it reach the local OMLX model. Loopback only, in both directions:
// the bind host must be loopback and API clients must be loopback, because
// the prompts carry untrusted skill content verbatim.
//
// Zero dependencies — node:http and friends, mirroring the stdlib-only
// discipline of book-buddy-2026/web/server.py.
//
//   node server.mjs                  → http://127.0.0.1:8787
//   node server.mjs --port 9000 --no-browser
//
// The deck still works without this server (open index.html directly); the
// Analyst view simply reports the bridge as offline.
//
// Author: Nic Cravino — Skillspector
// License: MIT
// ---------------------------------------------------------------------------

import http from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import * as analyst from "./server/analyst.mjs";
import { OMLXClient, resolveConfig } from "./server/omlx.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const MAX_BODY_BYTES = 6_000_000; // scan reports carry evidence excerpts
const DEFAULT_PORT = 8787;

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"]);

export function isLoopbackHost(host) {
  if (!host) return false;
  const h = String(host).replace(/^\[|\]$/g, "");
  if (LOOPBACK.has(h)) return true;
  if (/^127\.\d+\.\d+\.\d+$/.test(h)) return true;
  return /^::ffff:127\.\d+\.\d+\.\d+$/.test(h);
}

/**
 * A loopback *socket* is not proof of a loopback *origin*.
 *
 * In a DNS-rebinding attack the browser really is on this machine, so
 * `remoteAddress` is 127.0.0.1 — but the page came from the attacker's domain,
 * which has re-resolved to loopback. What gives it away is the name the client
 * used: the Host header says `evil.tld`, and any Origin says so too. Legitimate
 * use of this bridge only ever names a loopback address.
 */
export function isTrustedNameHeaders(headers = {}) {
  const hostHeader = String(headers.host || "");
  if (!hostHeader) return false;
  // Strip the port; keep bracketed IPv6 intact.
  const hostname = hostHeader.startsWith("[")
    ? hostHeader.slice(0, hostHeader.indexOf("]") + 1)
    : hostHeader.split(":")[0];
  if (!isLoopbackHost(hostname)) return false;

  for (const key of ["origin", "referer"]) {
    const raw = headers[key];
    if (!raw || raw === "null") continue;
    try {
      if (!isLoopbackHost(new URL(raw).hostname)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function version() {
  return readFile(resolve(ROOT, "src/engine.js"), "utf8")
    .then((s) => (s.match(/const VERSION\s*=\s*"([^"]+)"/) || [])[1] || "unknown")
    .catch(() => "unknown");
}

const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/favicon.svg": ["assets/favicon.svg", "image/svg+xml"],
};

function sendJson(res, payload, status = 200) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(body.length),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
  });
  res.end(body);
}

async function sendFile(res, relPath, contentType) {
  let body;
  try {
    body = await readFile(resolve(ROOT, relPath));
  } catch {
    sendJson(res, { error: `${relPath} not found — run \`node build.mjs\` first` }, 404);
    return;
  }
  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": String(body.length),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((ok, fail) => {
    const declared = Number(req.headers["content-length"] ?? NaN);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      fail(Object.assign(new Error("request body is too large"), { status: 413 }));
      return;
    }
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        // Reject first, then stop reading. Destroying the socket here would
        // tear down the connection before the handler's catch could write the
        // 413, so the client would see a dropped connection instead.
        req.pause();
        fail(Object.assign(new Error("request body is too large"), { status: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) return ok({});
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          fail(Object.assign(new Error("JSON body must be an object"), { status: 400 }));
          return;
        }
        ok(parsed);
      } catch {
        fail(Object.assign(new Error("invalid JSON body"), { status: 400 }));
      }
    });
    req.on("error", (e) => fail(e));
  });
}

export function createHandler({ engineVersion = "unknown" } = {}) {
  return async function handle(req, res) {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const path = url.pathname;
    const local = isLoopbackHost(req.socket?.remoteAddress);

    if (!local) {
      sendJson(res, { error: "the Skillspector bridge is restricted to loopback" }, 403);
      return;
    }
    if (!isTrustedNameHeaders(req.headers)) {
      sendJson(
        res,
        { error: "request must name a loopback host and come from a loopback origin" },
        403,
      );
      return;
    }

    try {
      if (req.method === "GET") {
        if (STATIC[path]) {
          await sendFile(res, ...STATIC[path]);
          return;
        }
        if (path === "/api/health") {
          const cfg = resolveConfig();
          sendJson(res, {
            ok: true,
            engine: engineVersion,
            bridge: "1.0.0",
            model: cfg.model,
            base_url: cfg.baseUrl,
            backend: "omlx",
            busy: analyst.busy(),
            active_job_id: analyst.activeJobId(),
          });
          return;
        }
        if (path === "/api/backend") {
          const client = safeClient(url.searchParams.get("model"), url.searchParams.get("base_url"));
          if (client.error) {
            sendJson(res, { reachable: false, detail: client.error });
            return;
          }
          sendJson(res, { backend: "omlx", ...(await client.value.probe()) });
          return;
        }
        if (path === "/api/events") {
          const limit = clampInt(url.searchParams.get("limit"), 100, 1, 400);
          sendJson(res, { events: analyst.events(limit), busy: analyst.busy() });
          return;
        }
        if (path === "/api/jobs") {
          sendJson(res, { jobs: analyst.listJobs(), busy: analyst.busy(), active_job_id: analyst.activeJobId() });
          return;
        }
        if (path.startsWith("/api/jobs/")) {
          const job = analyst.getJob(path.slice("/api/jobs/".length));
          if (job) sendJson(res, job);
          else sendJson(res, { error: "unknown job" }, 404);
          return;
        }
      }

      if (req.method === "POST") {
        const ctype = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
        if (path === "/api/analyze" || path === "/api/chat") {
          if (ctype !== "application/json") {
            sendJson(res, { error: "Content-Type must be application/json" }, 415);
            return;
          }
        }
        if (path === "/api/analyze") {
          const body = await readBody(req);
          const { jobId, error } = analyst.startAnalysis(body);
          if (error) sendJson(res, { error }, /running/.test(error) ? 409 : 400);
          else sendJson(res, { job_id: jobId }, 202);
          return;
        }
        if (path === "/api/chat") {
          const body = await readBody(req);
          try {
            sendJson(res, await analyst.ask(body));
          } catch (e) {
            sendJson(res, { error: e?.message || String(e) }, Number(e?.status) || 502);
          }
          return;
        }
      }

      sendJson(res, { error: "not found" }, 404);
    } catch (err) {
      const status = Number(err?.status) || 500;
      sendJson(res, { error: err?.message || "internal error" }, status);
    }
  };
}

function clampInt(raw, dflt, lo, hi) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, Math.trunc(n)));
}

function safeClient(model, baseUrl) {
  try {
    return { value: new OMLXClient({ model: model || undefined, baseUrl: baseUrl || undefined }) };
  } catch (e) {
    return { error: e.message };
  }
}

export async function serve({ host = "127.0.0.1", port = DEFAULT_PORT, openBrowser = true } = {}) {
  if (!isLoopbackHost(host)) {
    throw new Error(`--host must be loopback; the bridge is intentionally local-only (got ${host})`);
  }
  const engineVersion = await version();
  const server = http.createServer(createHandler({ engineVersion }));

  await new Promise((ok, fail) => {
    server.once("error", (err) => {
      if (err.code === "EADDRINUSE") {
        fail(
          new Error(
            `Port ${port} is already in use — a bridge is most likely already running at ` +
              `http://${host}:${port} (or pick another: node server.mjs --port ${port + 1})`,
          ),
        );
      } else fail(err);
    });
    server.listen(port, host, ok);
  });

  const cfg = resolveConfig();
  const url = `http://${host}:${port}`;
  console.log(`Skillspector command deck → ${url}   (Ctrl+C to stop)`);
  console.log(`  engine  ${engineVersion}`);
  console.log(`  omlx    ${cfg.model} @ ${cfg.baseUrl}`);
  if (openBrowser) openUrl(url);
  return server;
}

function openUrl(url) {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    spawn(cmd, [url], { stdio: "ignore", detached: true }).unref();
  } catch {
    /* a browser is a convenience, not a requirement */
  }
}

function parseArgs(argv) {
  const out = { host: "127.0.0.1", port: DEFAULT_PORT, openBrowser: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") out.port = Number(argv[++i]);
    else if (a === "--host") out.host = String(argv[++i]);
    else if (a === "--no-browser") out.openBrowser = false;
    else if (a === "--help" || a === "-h") {
      console.log("usage: node server.mjs [--host 127.0.0.1] [--port 8787] [--no-browser]");
      process.exit(0);
    }
  }
  if (!Number.isInteger(out.port) || out.port < 1 || out.port > 65535) {
    console.error(`invalid --port: ${out.port}`);
    process.exit(2);
  }
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  serve(parseArgs(process.argv.slice(2))).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
