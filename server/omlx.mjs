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

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost", "0:0:0:0:0:0:0:1"]);

export function isLoopback(baseUrl) {
  try {
    const host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, "");
    if (LOOPBACK_HOSTS.has(host)) return true;
    return /^127\./.test(host);
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

export function resolveConfig(overrides = {}) {
  const baseUrl = String(
    overrides.baseUrl || process.env.OMLX_BASE_URL || DEFAULT_BASE_URL,
  ).replace(/\/+$/, "");
  return {
    baseUrl,
    apiKey: String(overrides.apiKey || process.env.OMLX_API_KEY || "test") || "test",
    model: String(overrides.model || process.env.OMLX_MODEL || DEFAULT_MODEL),
    timeoutMs: overrides.timeoutMs || envNum("OMLX_TIMEOUT", DEFAULT_TIMEOUT_MS / 1000) * 1000,
    maxTokens: overrides.maxTokens || envNum("OMLX_MAX_TOKENS", DEFAULT_MAX_TOKENS),
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
        res.on("end", () =>
          resolve({ status: res.statusCode || 0, text: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(
        new LLMError(`request to ${u.host} timed out after ${Math.round(timeoutMs / 1000)}s`, {
          kind: "timeout",
        }),
      );
    });
    req.on("error", (err) =>
      reject(
        err instanceof LLMError
          ? err
          : new LLMError(`connection to ${u.host} failed: ${err.message}`, { kind: "network" }),
      ),
    );
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
    const maxTokens = opts.maxTokens || this.config.maxTokens;
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
    const budget = opts.maxTokens || this.config.maxTokens;
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
      return { data: reparsed, raw: second, repaired: true, truncated };
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
