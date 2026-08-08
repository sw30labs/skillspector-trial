/* ============================================================
   Skillspector — bridge client.

   Thin wrapper over the optional local OMLX bridge (server.mjs).
   The deck works without it: every call resolves to a structured
   failure instead of throwing, and the UI degrades to scan-only.

   Attaches globalThis.SkillBridge.
   ============================================================ */
(function () {
  "use strict";

  var OFFLINE_REASON =
    "no bridge on this origin — start it with `node server.mjs` and open http://127.0.0.1:8787";

  // file:// has no origin to talk to; skip probing entirely.
  var canReach = typeof location !== "undefined" && /^https?:$/.test(location.protocol);

  var state = { online: false, health: null, lastError: null };

  function req(path, opts) {
    if (!canReach) {
      return Promise.reject(new Error(OFFLINE_REASON));
    }
    var controller = null;
    var timer = null;
    var init = opts || {};
    try {
      if (typeof AbortController !== "undefined") {
        controller = new AbortController();
        init.signal = controller.signal;
        timer = setTimeout(function () { controller.abort(); }, init.timeoutMs || 600000);
      }
    } catch (e) { /* no abort support — rely on the browser default */ }
    delete init.timeoutMs;

    return fetch(path, init)
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (data) {
          if (!r.ok) {
            var err = new Error(data && data.error ? data.error : r.status + " " + r.statusText);
            err.status = r.status;
            throw err;
          }
          return data;
        });
      })
      .finally(function () { if (timer) clearTimeout(timer); });
  }

  function json(path, body) {
    return req(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
  }

  var Bridge = {
    get online() { return state.online; },
    get health() { return state.health; },
    get lastError() { return state.lastError; },
    get reachable() { return canReach; },
    OFFLINE_REASON: OFFLINE_REASON,

    /** Probe the bridge itself. Never rejects. */
    connect: function () {
      return req("/api/health", { timeoutMs: 5000 })
        .then(function (h) {
          state.online = true;
          state.health = h;
          state.lastError = null;
          return h;
        })
        .catch(function (e) {
          state.online = false;
          state.health = null;
          state.lastError = e.message || String(e);
          return null;
        });
    },

    /** Probe the OMLX endpoint behind the bridge. Never rejects. */
    backend: function (opts) {
      opts = opts || {};
      var q = [];
      if (opts.model) q.push("model=" + encodeURIComponent(opts.model));
      if (opts.baseUrl) q.push("base_url=" + encodeURIComponent(opts.baseUrl));
      var path = "/api/backend" + (q.length ? "?" + q.join("&") : "");
      return req(path, { timeoutMs: 12000 }).catch(function (e) {
        return { reachable: false, detail: e.message || String(e), models: [] };
      });
    },

    analyze: function (payload) { return json("/api/analyze", payload); },
    ask: function (payload) { return json("/api/chat", payload); },
    job: function (id) { return req("/api/jobs/" + encodeURIComponent(id), { timeoutMs: 15000 }); },
    jobs: function () { return req("/api/jobs", { timeoutMs: 15000 }); },
    events: function (limit) {
      return req("/api/events?limit=" + (limit || 100), { timeoutMs: 15000 });
    },
  };

  globalThis.SkillBridge = Bridge;
})();
