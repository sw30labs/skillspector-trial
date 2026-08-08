# Skillspector — Skill Scanner SPEC

Single-file, offline, client-side web app. Users drop a Claude skill (folder, `.zip`, or `.skill`) and get a security + quality scan report. No frameworks, no CDN, no network calls — everything inline in the final `index.html`.

An **optional** local bridge (`node server.mjs`) serves that same file and adds an AI Analyst backed by a local OMLX model. It is strictly additive: without it the deck behaves exactly as specified above, and the Analyst view reports the bridge as offline. The scan itself never leaves the browser under any configuration.

## Project layout

```
skill-scanner/
  index.html          # BUILT artifact — single-file app (committed)
  build.mjs           # inlines src/* + assets/favicon.svg into index.html
  server.mjs          # OPTIONAL bridge: serves index.html + /api/*, loopback only
  SPEC.md             # this file
  README.md
  assets/
    favicon.svg       # atlas-style mark; inlined as a data: URI at build time
  src/
    engine.js         # scan engine (ES module; browser + node >= 18)
    ui.js             # command deck controller (plain script, no module)
    bridge.js         # browser-side client for the optional bridge
    style.css         # command deck theme
    template.html     # shell with markers (see Build)
  server/
    omlx.mjs          # OpenAI-compatible OMLX client (node stdlib only)
    analyst.mjs       # three-pass review pipeline, jobs, event ring
  tests/
    run-tests.mjs         # engine suite — 74 tests, zero deps
    run-bridge-tests.mjs  # bridge/analyst suite — 49 tests against a fake OMLX
    run-e2e.mjs           # end-to-end: real Chrome over CDP, real bridge
    cdp.mjs               # zero-dep Chrome DevTools Protocol driver
    fixtures/             # skill bundles used by tests
      clean-skill/
      evil-skill/
      sloppy-skill/
```

## Engine API (hard contract — both agents code against this)

`src/engine.js` is an ES module, but must ALSO attach itself to `globalThis.SkillScanner` when loaded (so the inlined non-module build works):

```js
globalThis.SkillScanner = { scanFiles, parseZip, VERSION, RULES };
```

```ts
// One dropped payload may contain several skills (each dir with a SKILL.md).
// UI is responsible for producing FileEntry[] (from folder traversal or parseZip),
// engine is responsible for everything after.

type FileEntry = { path: string; bytes: Uint8Array };  // path uses "/", no leading "/"

async function parseZip(bytes: Uint8Array): Promise<FileEntry[]>
// Pure-JS zip reader. DEFLATE via DecompressionStream("deflate-raw") — available in
// browsers and node >= 18. Support stored (0) and deflate (8) methods. Ignore dirs.
// Must handle .skill files (they are zips). Throw Error("not-a-zip") on bad magic.

async function scanFiles(files: FileEntry[]): Promise<ScanResult>

type ScanResult = {
  version: string;
  scannedAt: string;            // ISO
  skills: SkillReport[];        // one per detected SKILL.md root; if none found,
                                // a single report with rootPath "" and a critical
                                // QUA-001 finding (missing SKILL.md)
}

type SkillReport = {
  rootPath: string;             // "" or "my-skill/" etc.
  name: string;                 // frontmatter name, else root dir name, else "(unknown)"
  score: number;                // 0..100
  grade: "A"|"B"|"C"|"D"|"F";
  summary: { critical: number; high: number; medium: number; low: number; info: number };
  findings: Finding[];          // sorted by severity desc, then file
  capabilities: Capability[];   // what the skill CAN do — informational, no score impact
  meta: { fileCount: number; totalBytes: number; skillMdBytes: number;
          frontmatter: Record<string,string> | null };
}

type Finding = {
  ruleId: string;               // e.g. "SEC-004"
  severity: "critical"|"high"|"medium"|"low"|"info";
  category: "security"|"quality";
  title: string;                // short, human
  detail: string;               // one-two sentences, plain language, why it matters
  file: string;                 // path relative to bundle
  line: number | null;          // 1-based
  excerpt: string | null;       // offending line, trimmed to <= 200 chars,
                                // invisible chars made visible as \u{XXXX}
}

type Capability = {
  id: "network"|"shell"|"filesystem"|"email"|"credentials"|"subprocess"|"schedule";
  label: string;                // "Makes network requests"
  evidence: { file: string; line: number }[];   // max 5 kept
}
```

### Scoring

Start 100 per skill. Deduct per finding: critical −30, high −15, medium −7, low −3, info −0.
Same ruleId counts at most 3 times toward the deduction (still report all findings).
Floor 0. Grade: A ≥ 90, B ≥ 75, C ≥ 60, D ≥ 40, else F.
Capabilities never affect the score.

### Skill root detection

Every directory containing a `SKILL.md` (case-insensitive match on filename) is a skill
root; its report covers all files under it. Nested skill roots: inner one wins for its
subtree. Files outside any root: attach to a synthetic report only if there are NO roots
at all.

## Rule catalog (engine agent implements; IDs are stable API)

Text files = extensions .md .txt .py .js .mjs .ts .sh .bash .zsh .yaml .yml .json .html
.css .toml .cfg .ini .csv .xml, files named Dockerfile/Makefile, plus any file ≤ 512KB
with no NUL byte in the first 8KB. Others → binary (skanned only by QUA-010).

### Security (category: "security")

- SEC-001 prompt-injection phrasing (SKILL.md / any .md / any text file). Patterns (case-insensitive, allow flexible whitespace): "ignore (all |any )?(previous|prior|above) instructions", "disregard .{0,30}instructions", "do not (tell|inform|mention|reveal|show).{0,30}(user|human)", "without (telling|asking|informing) the user", "hide this from", "keep this secret from the user", "the user has (already )?(approved|authorized|consented)", "you are now", "new system prompt", "act as if", "before (doing|responding to) anything else". Severity: critical in SKILL.md frontmatter/body, high elsewhere.
- SEC-002 hidden/invisible unicode: zero-width (U+200B–U+200F, U+2060, U+FEFF not at file start), bidi controls (U+202A–U+202E, U+2066–U+2069), Unicode tag block (U+E0000–U+E007F — ASCII smuggling). critical. Excerpt must render them visibly as escapes.
- SEC-003 data exfiltration: sending local data out — POST/PUT/upload with file/env payloads; URLs on known exfil-friendly hosts (discord.com/api/webhooks, hooks.slack.com, pastebin, transfer.sh, ngrok, webhook.site, requestbin, telegram bot api, burpcollaborator, interactsh, oastify); reading then sending ~/.ssh, ~/.aws, .env, keychain, browser profiles, os.environ / process.env serialization into a request. critical.
- SEC-004 dangerous shell: `rm -rf /` or `rm -rf ~` or rm -rf on non-relative path, `curl … | (ba)?sh`, `wget … | sh`, mkfs, `dd if=… of=/dev/`, fork bomb `:(){ :|:& };:`, `chmod -R 777 /`, `> /dev/sda`, sudo inside scripts. critical (sudo alone: high).
- SEC-005 dynamic code execution / obfuscation: eval/exec on decoded or constructed strings (b64decode→exec, atob→eval/Function, `String.fromCharCode` chains ≥ 8 calls, hex-escape walls), `python -c` with b64, `powershell -enc`. critical. Plain eval/exec/Function with variable arg: high.
- SEC-006 hardcoded secrets: AWS `AKIA[0-9A-Z]{16}`, `sk-[A-Za-z0-9]{20,}`, `ghp_`/`gho_`/`github_pat_`, `xox[baprs]-`, `AIza[0-9A-Za-z_-]{35}`, `-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----`, generic `(password|passwd|secret|token|api_?key)\s*[:=]\s*["'][^"']{8,}` (this generic one: medium, and skip obvious placeholders: empty, `...`, contains  `example|changeme|placeholder|xxx|<|>|\$\{|dummy|your[-_ ]`). Key-shaped: high.
- SEC-007 sensitive path access: ~/.ssh, ~/.aws/credentials, ~/.gnupg, /etc/shadow, /etc/passwd, keychain(-db), Login Data / Cookies (browser profile files), .git-credentials, id_rsa/id_ed25519. high (medium if inside an obvious docstring/comment explaining what NOT to do).
- SEC-008 persistence & environment tampering: crontab -e/-l w/ write, launchctl load, systemctl enable, writing to ~/.bashrc/.zshrc/.profile, git config --global, creating LaunchAgents plists. high.
- SEC-009 instruction to disable safety/tooling: telling the agent to skip permission prompts, auto-approve, "--dangerously-skip-permissions", disable sandbox, exfil approval phrases ("the user consents to all actions"). critical.
- SEC-010 suspicious external fetch at run time: instructions in SKILL.md telling the agent to fetch and follow/execute remote content ("fetch X and follow the instructions", "download and run"). critical if follow/execute, medium for plain URL fetching guidance.

### Quality (category: "quality")

- QUA-001 SKILL.md missing (critical) / empty body < 20 chars (high).
- QUA-002 frontmatter: missing entirely (high); unparsable YAML-lite (high); missing `name` (high) or `description` (high); unknown risky fields fine. Parser: simple `key: value` lines between `---` fences is enough — no YAML lib.
- QUA-003 name format: not kebab-case `[a-z0-9]+(-[a-z0-9]+)*` (medium); name ≠ root dir name (low); name > 64 chars (low).
- QUA-004 description quality: < 20 chars (medium); > 1024 chars (low); no trigger guidance — lacks any of "use when|trigger|use this skill|when the user" (low); first-person "I can/I will" (low).
- QUA-005 SKILL.md too long: body > 500 lines (low) or > 5000 words (medium) — progressive-disclosure hint.
- QUA-006 broken relative references: markdown links/paths in SKILL.md pointing at files not present in bundle (medium each, cap 5). Anchor-only, http(s), mailto exempt.
- QUA-007 junk files: .DS_Store, Thumbs.db, ._* (AppleDouble), __pycache__/, *.pyc, .git/, node_modules/, *.log (low, one finding listing up to 10). Note: `__MACOSX/` subtrees are macOS zip packaging artifacts and are excluded from scanning entirely during input normalization (they must never create a skill root or count toward file totals).
- QUA-008 oversized bundle: total > 10 MB (medium) or > 30 files of code (info: consider splitting), single text file > 1 MB (low).
- QUA-009 scripts without mention: executable-ish files (.py/.sh/.js) never referenced in any .md (info, list them) — dead weight or surprise behavior.
- QUA-010 binary blobs: any non-media binary > 100 KB (medium — can hide anything), media (png/jpg/gif/svg/pdf) info only.
- QUA-011 frontmatter description mismatch: description mentions triggers/files that don't exist in body/bundle (info). Optional/best-effort.

### Capabilities detection (not findings)

- network: requests/urllib/fetch/axios/http.client/curl/wget usage
- email: smtplib/SMTP/sendmail/mail MCP mentions
- shell: subprocess/os.system/child_process/`bash -c`
- filesystem: open(...,"w")/writeFile/shutil/rm/mkdir outside bundle-relative
- credentials: reads env vars that look like secrets (SMTP_PASS, API_KEY, TOKEN) — evidence, not a finding
- subprocess: spawning other programs
- schedule: cron/scheduled-task mentions

A legit skill (e.g. newsletter that sends mail via SMTP with env-var password) must come
out ~A/B with capabilities listed — NOT be buried in criticals. Rules must key on
*exfil/injection shape*, not on "uses the network".

## UI contract

- Calls only: `await SkillScanner.scanFiles(entries)` and `await SkillScanner.parseZip(bytes)`. Never reimplements rules.
- Input paths: (1) drag-drop of folder(s) — webkitGetAsEntry traversal; (2) drag-drop or file-picker of .zip/.skill — parseZip; (3) "Scan demo skill" button — embedded demo FileEntry[] (a small deliberately-sketchy skill defined as JS string constants in ui.js, so first-time users see a rich report instantly).
- While scanning: sweep line over a file-path ticker, ~0.9s artificial minimum so it reads as work; never fake longer.
- Everything must work from `file://` (no fetch of local resources, no modules in final build).

### Command deck

The GUI is a **command deck** in the same visual language as `contingency-atlas` and
`book-buddy-2026`: boot sequence, ambient starfield canvas, mouse spotlight, film grain,
sticky header with live badges and a clock, left sidebar nav, translucent panels over a
near-black ground. Dark only — the reference decks have no light mode and neither does
this one. Palette is shared verbatim (`--cyan #22d3ee`, `--teal #5eead4`, `--bg #04060c`,
mono labels in wide tracking).

Views (sidebar order), each a `.view` toggled by `[data-view]`:

| View | Contents |
| --- | --- |
| `overview` — Situation Room | intake dropzone + scanner instrument, 6 KPI tiles, live line, grade gauge, severity pills, skill roster, activity log |
| `findings` — Finding Register | search + severity filters, sortable table (severity/rule/title/location/verdict), row → modal with detail, evidence and analyst adjudication; export buttons |
| `capabilities` — Capability Surface | one card per detected capability with evidence chips; model-read behaviour panel once triaged |
| `bundle` — Bundle Inventory | bundle KPIs, frontmatter fields, sortable skill-root roster, full file manifest with per-file rule-hit counts |
| `analyst` — AI Analyst | bridge/OMLX status, model + base-url controls, three-pass stage track, verdict panel, adjudication table, chat, review history |
| `about` | what it does, the analyst, stack, run commands, privacy, author |

- Multiple skills per drop → the roster lists every root; clicking one makes it active
  across every view. "Export all (.md)" surfaces only when the bundle holds ≥ 2 skills.
- Exports: per-skill Markdown, all-skills Markdown, and JSON (`{scan, analyst?}`) via Blob
  download. When a review has run, the Markdown carries the verdict and per-finding
  adjudications.
- Accessibility: `prefers-reduced-motion` honored (boot skipped, starfield frozen, ticker
  slowed); drop zone is a keyboard-operable button; skip link; responsive to 360px with the
  sidebar becoming a scrolling top bar. No external fonts or assets — inline SVG only.

## Bridge contract (optional)

`node server.mjs [--host 127.0.0.1] [--port 8787] [--no-browser]`. Zero dependencies
(`node:http` and friends). Every response carries `nosniff`, `X-Frame-Options: DENY`,
`Referrer-Policy: no-referrer`, `Cache-Control: no-store`.

**Three independent loopback checks**, because any one of them alone is bypassable:

1. the bind host must be a loopback address (`serve()` refuses otherwise);
2. the client socket's `remoteAddress` must be loopback;
3. the request must *name* a loopback host — `Host` is required to be a loopback literal
   and any `Origin`/`Referer` must be loopback too.

(3) is what stops DNS rebinding: in that attack the browser really is on this machine, so
(2) passes. The giveaway is the name the client used. It applies to every route, not just
`/api/*` — serving the deck itself to a rebound origin would hand the attacker a
same-origin page.

| Route | Behaviour |
| --- | --- |
| `GET /`, `/index.html` | the built deck |
| `GET /favicon.svg` | the mark |
| `GET /api/health` | `{ok, engine, bridge, model, base_url, backend, busy, active_job_id}` |
| `GET /api/backend?model=&base_url=` | probes OMLX → `{reachable, base_url, models[], detail?}` |
| `POST /api/analyze` | `{report, skill_md, files, model?, base_url?}` → `202 {job_id}`; `409` while one is running, `400` on a bad payload, `415` without a JSON content type |
| `GET /api/jobs`, `GET /api/jobs/:id` | job status, progress, usage, result |
| `GET /api/events?limit=` | ring buffer of pipeline events (max 400) |
| `POST /api/chat` | `{question, report, history[], …}` → `{answer, truncated, usage, elapsed_ms}`; `409` while a review is running |

Provider contract is identical to `book-buddy-2026/backends.py::OMLXBackend` and
`contingency-atlas/llm.py::OMLXClient`:

- `OMLX_BASE_URL` default `http://127.0.0.1:8000/v1`, `OMLX_API_KEY` default `test`,
  `OMLX_MODEL` default `DeepSeek-V4-Flash-0731-MLX`, `OMLX_TIMEOUT` seconds. `OMLX_MAX_TOKENS`,
  when set, **overrides** the per-pass budgets — otherwise it would be documentation for a
  value nothing reads, since every call site passes its own.
- **Never streams** — OMLX hangs with `stream: true` on large models.
- `reasoning_content` is read and reported but never mistaken for the answer.
- HTTP envelopes are parsed **strictly**; only model *content* goes through the lenient
  JSON extractor. (A ```json fence inside a reply must not be able to pose as the envelope.)
- Every request has a hard deadline covering the whole exchange, not just socket
  inactivity: a peer that dies mid-body must not leave the single-writer lock held forever.
- A reply that stops on `length` is a budget failure, not a formatting one — the repair
  round-trip gets 1.6× the budget, and both calls are billed.
- The LLM endpoint hostname is **parsed**, never prefix-matched: `127.0.0.1.evil.tld` is
  not loopback. A non-loopback endpoint is refused — skill text is untrusted third-party
  content and must not leave the machine — unless `SKILLSPECTOR_ALLOW_REMOTE_LLM=1`.

### Analyst pipeline

Three passes, each its own LLM call with its own prompt. They are structurally separate on
purpose; do not merge a later pass into an earlier one.

1. **Triage** — reads SKILL.md as untrusted data → `{intent, behaviours[], undeclared[], semantic_risks[], injection_attempt, notes}`.
2. **Adjudicate** — findings worst-first, capped at 24, in batches of 5 → per finding `confirmed | false_positive | needs_review` with confidence and a note. Dropped findings are reported, never silently truncated.
3. **Verdict** — `{recommendation: allow|caution|block, adjusted_grade: A–F, confidence, headline, rationale, actions[]}`.

Every model reply is normalised into the shapes above; unknown enum values fall back
(`needs_review`, `caution`, grade `C`) rather than propagating junk, and a finding the model
never ruled on says so at zero confidence rather than presenting as a considered verdict.

**Findings have no natural key.** The engine can emit two findings that agree on rule, file,
line *and* title. The UI therefore stamps a stable ordinal on every finding at scan time;
that ordinal travels in the payload and comes back on each adjudication, so a verdict always
returns to the finding it judged. Verdict rows are matched by the model's `n` first,
positionally only when the list is full-length, and by rule id only when that identifies
exactly one finding and one row.

**Untrusted content cannot forge the fence.** The `----- BEGIN/END UNTRUSTED … -----`
markers are the only thing telling the model where attacker-authored text stops, so every
interpolation of bundle-authored text — SKILL.md, skill name, description, file list,
evidence excerpts, the operator's question — has marker-shaped lines defanged before it goes
in. The text is still shown; it just cannot pose as structure. Prompt framing states that
bundle content is untrusted data and that an instruction inside it to change the verdict is
itself evidence of injection.

**One job at a time**, and chat obeys the same lock: the local model is a single-writer
resource, so a question fired mid-review is refused (409) rather than allowed to compete
with the running pass for the GPU.

## Build

`node build.mjs` → reads `src/template.html` and substitutes markers with file contents:

| Marker | Source | Placement |
| --- | --- | --- |
| `__FAVICON__` | `assets/favicon.svg`, base64 `data:` URI | `<link rel="icon">` |
| `/*__CSS__*/` | `src/style.css` | inside `<style>` |
| `/*__ENGINE__*/` | `src/engine.js`, export statements stripped | its own non-module `<script>` |
| `/*__BRIDGE__*/` | `src/bridge.js` | its own non-module `<script>` |
| `/*__UI__*/` | `src/ui.js` | its own non-module `<script>` |

Output: `./index.html`. The build fails loudly if a marker is missing, if a marker survives
substitution, or if the result references any external resource (`src=` on a script, or a
non-`data:` `href` on a link) — the artifact must stay self-contained.

## Tests

All three suites are zero-dependency and exit non-zero on failure.

**`node tests/run-tests.mjs`** — engine, 74 tests. Zip round-trip (zips built in-test,
stored + deflate), root detection (0, 1, n, nested), every SEC rule fires on the evil-skill
fixture, clean-skill scores ≥ 90 with zero critical/high, sloppy-skill triggers the expected
QUA set, scoring math, cap-at-3 logic, invisible-unicode excerpt escaping.

**`node tests/run-bridge-tests.mjs`** — bridge + analyst, 77 tests, driven by a fake OMLX
server so no model is needed. JSON extraction (fences, prose, braces inside strings, the
strict-envelope regression), the parsed loopback guard and the forged-Host rejection on a
raw socket, a connection dying mid-body, truncation-aware repair and its billing, the
normalisers and verdict matching, fence forging, the full three-pass pipeline, single-flight
locking across both analyze and chat, error propagation, and every HTTP route including its
status codes.

**`node tests/run-e2e.mjs`** — 42 tests end to end in real Chrome (52 with `--analyst`), driven over CDP by
`tests/cdp.mjs` (zero deps; Node 22's global `WebSocket` is the whole client). Boots its own
bridge on a free port. Covers the boot sequence, all six views, the palette, scanning the
demo skill, KPI/gauge/pill/roster rendering, search + severity filtering + sorting, the
evidence modal, capability cards, the bundle manifest, multi-skill roster and switching,
both Markdown exports and JSON, the analyst wiring and payload, console cleanliness,
responsiveness at 390px, cross-skill state handling (a review that lands after a root
switch, duplicate-identity findings, nested roots), and a genuine `file://` load with no
server at all.

Add `--analyst` to run the review against the **real** local model end to end — verdict,
triage, adjudications folded back into the register, history, export, and a chat round-trip.
That path needs OMLX up and takes minutes. `--headful` to watch, `--shots <dir>` for
screenshots.
