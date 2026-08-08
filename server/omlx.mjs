// ---------------------------------------------------------------------------
// omlx.mjs — OpenAI-compatible client for the local OMLX server.
//
// Same provider contract as book-buddy-2026 (`backends.py::OMLXBackend`) and
// contingency-atlas (`llm.py::OMLXClient`):
//   base_url  http://127.0.0.1:8000/v1        (OMLX_BASE_URL)
//   api_key   "test"                          (OMLX_API_KEY — OMLX ignores the
//                                              value but requires the header)
//   model     DeepSeek-V4-Flash-0731-MLX      (OMLX_MODEL)
//   streaming DISABLED — OMLX hangs with stream:true on large models.
//
// Zero dependencies: node:http / node:https only.
//
// Author: Nic Cravino — Skillspector
// License: MIT
// ---------------------------------------------------------------------------

import http from "node:http";
import https from "node:https";

export const DEFAULT_BASE_URL = "http://127.0.0.1:8000/v1";
export const DEFAULT_MODEL = "DeepSeek-V4-Flash-0731-MLX";
export const DEFAULT_TIMEOUT_MS = 300_000;
export const DEFAULT_MAX_TOKENS = 1200;

export class LLMError extends Error {
  constructor(message, { status = null, body = null, kind = "llm" } = {}) {
    super(message);
    this.name = "LLMError";
    this.status = status;
    this.body = body;
    this.kind = kind;
  }
}

/** Truncated-output marker: the budget, not the model, is the defect. */
export class TruncatedError extends LLMError {
  constructor(message, opts = {}) {
    super(message, { ...opts, kind: "truncated" });
    this.name = "TruncatedError";
  }
}

const LOOPBACK_NAMES = new Set(["localhost"]);

/**
 * True only for a genuine loopback address.
 *
 * Parsed, never prefix-matched: `/^127\./` would accept the hostname
 * `127.0.0.1.evil.tld`, which any wildcard-DNS service hands out for free —
 * and this guard is the only thing keeping untrusted skill text on the machine.
 */
export function isLoopbackHostname(host) {
  if (!host) return false;
  const h = String(host).replace(/^\[|\]$/g, "").toLowerCase();
  if (LOOPBACK_NAMES.has(h)) return true;

  // IPv4: exactly four numeric octets, first === 127.
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const parts = v4.slice(1).map(Number);
    if (parts.some((n) => n > 255)) return false;
    return parts[0] === 127;
  }

  // IPv6 loopback, in its own right or IPv4-mapped.
  if (h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
  const mapped = h.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return isLoopbackHostname(mapped[1]);
  return false;
}

export function isLoopback(baseUrl) {
  try {
    return isLoopbackHostname(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

/**
 * Skill bundles are untrusted third-party content and the prompts carry their
 * text verbatim. Refuse to ship that to a non-loopback endpoint unless the
 * operator opts in explicitly.
 */
export function requireLocalEndpoint(baseUrl, { allowRemote = false } = {}) {
  if (isLoopback(baseUrl) || allowRemote) return;
  throw new LLMError(
    `LLM endpoint ${baseUrl} is not loopback. Skill contents would leave this ` +
      `machine. Set SKILLSPECTOR_ALLOW_REMOTE_LLM=1 to override.`,
    { kind: "config" },
  );
}

function envNum(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** The budget actually used: an operator-pinned ceiling wins over the caller. */
function budgetFor(config, requested) {
  if (config.maxTokensPinned) return config.maxTokens;
  return requested || config.maxTokens;
}

export function resolveConfig(overrides = {}) {
  const baseUrl = String(
    overrides.baseUrl || process.env.OMLX_BASE_URL || DEFAULT_BASE_URL,
  ).replace(/\/+$/, "");
  // Callers pass a per-pass budget, so config.maxTokens would never be
  // consulted and OMLX_MAX_TOKENS would be documentation for nothing. An
  // explicitly set env var is an operator decision and overrides the caller.
  const envMax = envNum("OMLX_MAX_TOKENS", null);
  return {
    baseUrl,
    apiKey: String(overrides.apiKey || process.env.OMLX_API_KEY || "test") || "test",
    model: String(overrides.model || process.env.OMLX_MODEL || DEFAULT_MODEL),
    timeoutMs: overrides.timeoutMs || envNum("OMLX_TIMEOUT", DEFAULT_TIMEOUT_MS / 1000) * 1000,
    maxTokens: overrides.maxTokens || envMax || DEFAULT_MAX_TOKENS,
    maxTokensPinned: overrides.maxTokens != null || envMax != null,
    allowRemote: process.env.SKILLSPECTOR_ALLOW_REMOTE_LLM === "1",
  };
}

function request(url, { method = "GET", headers = {}, body = null, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      reject(new LLMError(`invalid endpoint URL: ${url}`, { kind: "config" }));
      return;
    }
    const mod = u.protocol === "https:" ? https : http;
    const payload = body == null ? null : Buffer.from(body, "utf8");

    let settled = false;
    let deadline = null;
    const settle = (fn) => (v) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      fn(v);
    };
    const ok = settle(resolve);
    const fail = settle(reject);
    const netError = (what) => (err) =>
      fail(
        err instanceof LLMError
          ? err
          : new LLMError(`${what} ${u.host}: ${err?.message || "connection lost"}`, {
              kind: "network",
            }),
      );

    const req = mod.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method,
        headers: {
          ...headers,
          ...(payload ? { "Content-Length": String(payload.length) } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          // A chunked response whose socket died mid-body ends without
          // `complete`. Treating that as a successful read would hand a
          // truncated envelope to the JSON parser as if it were the answer.
          if (res.complete === false) {
            fail(new LLMError(`response from ${u.host} ended mid-body`, { kind: "network" }));
            return;
          }
          ok({ status: res.statusCode || 0, text: Buffer.concat(chunks).toString("utf8") });
        });
        res.on("error", netError("response from"));
        res.on("aborted", () =>
          fail(new LLMError(`response from ${u.host} was aborted mid-body`, { kind: "network" })),
        );
      },
    );

    // A hard deadline on the whole exchange. `req.setTimeout` only arms a
    // socket-inactivity timer, so a peer that accepts the request and then goes
    // quiet forever would leave this promise pending — and with it the
    // analyst's single-writer lock.
    deadline = setTimeout(() => {
      fail(
        new LLMError(`request to ${u.host} timed out after ${Math.round(timeoutMs / 1000)}s`, {
          kind: "timeout",
        }),
      );
      try {
        req.destroy();
      } catch {
        /* already gone */
      }
    }, timeoutMs);
    if (typeof deadline.unref === "function") deadline.unref();

    req.setTimeout(timeoutMs, () => {
      req.destroy(
        new LLMError(`request to ${u.host} timed out after ${Math.round(timeoutMs / 1000)}s`, {
          kind: "timeout",
        }),
      );
    });
    req.on("error", netError("connection to"));
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Parse an HTTP response envelope. STRICT on purpose: the lenient
 * `extractJson` below would happily latch onto a ```json fence *inside*
 * the model's own reply and hand it back as if it were the envelope.
 */
function parseEnvelope(text, what) {
  try {
    return JSON.parse(text);
  } catch {
    throw new LLMError(`${what} returned a non-JSON body`, { body: String(text).slice(0, 400), kind: "parse" });
  }
}

/**
 * Pull the first balanced JSON object/array out of a model response.
 * Handles ```json fences, leading prose, and trailing commentary.
 */
export function extractJson(text) {
  if (typeof text !== "string" || text.trim() === "") return null;
  let s = text.trim();

  const fence = s.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();

  const direct = tryParse(s);
  if (direct !== undefined) return direct;

  for (const [open, close] of [
    ["{", "}"],
    ["[", "]"],
  ]) {
    const start = s.indexOf(open);
    if (start === -1) continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < s.length; i++) {
      const ch = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          const parsed = tryParse(s.slice(start, i + 1));
          if (parsed !== undefined) return parsed;
          break;
        }
      }
    }
  }
  return null;
}

function tryParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/** Sum two calls' usage so a repair round-trip is billed for what it cost. */
export function mergeUsage(first, second) {
  const add = (k) => Number(first.usage?.[k] || 0) + Number(second.usage?.[k] || 0);
  return {
    ...second,
    usage: {
      prompt_tokens: add("prompt_tokens") || add("input_tokens"),
      completion_tokens: add("completion_tokens") || add("output_tokens"),
      total_tokens: add("total_tokens"),
    },
    calls: 2,
    elapsedMs: (first.elapsedMs || 0) + (second.elapsedMs || 0),
  };
}

export class OMLXClient {
  constructor(overrides = {}) {
    this.config = resolveConfig(overrides);
    requireLocalEndpoint(this.config.baseUrl, { allowRemote: this.config.allowRemote });
  }

  get baseUrl() {
    return this.config.baseUrl;
  }

  get model() {
    return this.config.model;
  }

  /** GET /models — also doubles as the liveness probe. */
  async listModels({ timeoutMs = 6000 } = {}) {
    const res = await request(`${this.config.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${this.config.apiKey}` },
      timeoutMs,
    });
    if (res.status !== 200) {
      throw new LLMError(`GET /models returned ${res.status}`, {
        status: res.status,
        body: res.text.slice(0, 400),
      });
    }
    const data = parseEnvelope(res.text, "GET /models");
    const list = (data && data.data) || [];
    return list.map((m) => (typeof m === "string" ? m : String(m.id || ""))).filter(Boolean);
  }

  async probe() {
    try {
      const models = await this.listModels();
      return { reachable: true, base_url: this.config.baseUrl, models, model: this.config.model };
    } catch (e) {
      return {
        reachable: false,
        base_url: this.config.baseUrl,
        models: [],
        model: this.config.model,
        detail: e.message,
      };
    }
  }

  /**
   * Non-streaming chat completion.
   * Returns { content, reasoning, usage, finishReason, elapsedMs }.
   */
  async chat(messages, opts = {}) {
    const model = opts.model || this.config.model;
    const maxTokens = budgetFor(this.config, opts.maxTokens);
    const body = JSON.stringify({
      model,
      messages,
      temperature: opts.temperature ?? 0.2,
      max_tokens: maxTokens,
      stream: false,
    });
    const started = Date.now();
    const res = await request(`${this.config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json",
      },
      body,
      timeoutMs: opts.timeoutMs || this.config.timeoutMs,
    });
    if (res.status !== 200) {
      let detail = res.text.slice(0, 400);
      try {
        detail = JSON.parse(res.text)?.error?.message || detail;
      } catch {
        /* a non-JSON error body is still worth reporting verbatim */
      }
      throw new LLMError(`chat/completions returned ${res.status}: ${detail}`, {
        status: res.status,
        body: res.text.slice(0, 400),
      });
    }
    const data = parseEnvelope(res.text, "POST /chat/completions");
    const choice = data?.choices?.[0] || {};
    const message = choice.message || {};
    const content = String(message.content ?? "");
    const reasoning = String(message.reasoning_content ?? "");
    const finishReason = choice.finish_reason || "stop";
    if (finishReason === "length" && content.trim() === "") {
      throw new TruncatedError(
        `model spent its entire ${maxTokens}-token budget on reasoning and emitted no answer`,
        { status: 200 },
      );
    }
    return {
      content,
      reasoning,
      finishReason,
      // The server said it stopped because it ran out of room. Prose callers
      // must be able to tell their user the answer is cut off rather than
      // present a half-sentence as complete.
      truncated: finishReason === "length",
      maxTokens,
      usage: data?.usage || {},
      elapsedMs: Date.now() - started,
      model,
    };
  }

  /**
   * Chat that must return JSON. One repair round-trip if the first reply is
   * unparseable.
   *
   * Reasoning models spend most of a budget thinking before they write a
   * single character of answer, so an unparseable reply that stopped on
   * ``length`` is a budget failure, not a formatting failure. Retrying it with
   * the same ceiling just burns another minute reaching the same wall — the
   * repair gets a bigger budget and is told to think less.
   */
  async chatJson(messages, opts = {}) {
    const first = await this.chat(messages, opts);
    const parsed = extractJson(first.content);
    if (parsed !== null && typeof parsed === "object") {
      return { data: parsed, raw: first, repaired: false };
    }

    const truncated = first.finishReason === "length";
    const budget = budgetFor(this.config, opts.maxTokens);
    const repairMessages = [
      ...messages,
      { role: "assistant", content: first.content.slice(0, 2000) },
      {
        role: "user",
        content: truncated
          ? "That reply was cut off before the JSON was complete. Think briefly, " +
            "then reply with ONLY the finished JSON object — no prose, no markdown fences."
          : "That was not valid JSON. Reply again with ONLY the JSON object — " +
            "no prose, no markdown fences, no commentary.",
      },
    ];
    const second = await this.chat(repairMessages, {
      ...opts,
      temperature: 0,
      maxTokens: truncated ? Math.ceil(budget * 1.6) : budget,
    });
    const reparsed = extractJson(second.content);
    if (reparsed !== null && typeof reparsed === "object") {
      // Two requests were made; reporting only the second understates cost
      // exactly where it is highest.
      return { data: reparsed, raw: mergeUsage(first, second), repaired: true, truncated };
    }
    if (truncated || second.finishReason === "length") {
      throw new TruncatedError(
        `model ran out of tokens before finishing its JSON (budget ${budget}); ` +
          "raise OMLX_MAX_TOKENS",
        { body: second.content.slice(0, 400) },
      );
    }
    throw new LLMError("model did not return parseable JSON after one repair attempt", {
      body: second.content.slice(0, 400),
      kind: "parse",
    });
  }
}
