# Skillspector

![tests](https://img.shields.io/badge/tests-192%20passing-2ce6c8?style=flat-square)
![e2e](https://img.shields.io/badge/e2e-real%20Chrome%20%2B%20real%20model-a78bfa?style=flat-square)
![dependencies](https://img.shields.io/badge/dependencies-none-38bdf8?style=flat-square)
![single file](https://img.shields.io/badge/app-single%20HTML%20file-8b5cf6?style=flat-square)
![offline](https://img.shields.io/badge/scan-100%25%20offline-16a766?style=flat-square)
![model](https://img.shields.io/badge/analyst-OMLX%20%C2%B7%20local-22d3ee?style=flat-square)
![engine](https://img.shields.io/badge/engine-2.0.0-64748b?style=flat-square)

A **command deck** for inspecting Claude Agent Skills. Drag a skill in — a folder, a `.zip`, or a `.skill` file — and 21 static rules grade it A–F for **security** and **quality**, with findings, evidence and a capability breakdown. The scan runs entirely in your browser: nothing is uploaded, there are no network calls, and it works straight off `file://`.

Start the optional bridge and a **local model reviews the report with you** — reading SKILL.md for intent the regexes can't see, ruling on each finding, and issuing an install recommendation. The model is OMLX on your own machine; loopback only, in both directions.

![Skillspector tour — drop zone, live scan, graded report, findings, multi-skill summary](docs/skillspector-tour.gif)

## Screenshots

| | |
| --- | --- |
| ![Situation Room on standby, drop zone armed](docs/screenshots/01-standby.png) *Situation Room — scanner on standby* | ![Graded report after scanning a bundle](docs/screenshots/02-scanning.png) *Scan complete — gauge, KPIs, roster* |
| ![Analyst verdict with adjusted grade and actions](docs/screenshots/03-report.png) *AI Analyst — verdict & adjudications* | ![Findings register with evidence modal open](docs/screenshots/04-findings.png) *Finding register — filter, sort, drill in* |
| ![Bundle inventory with file manifest](docs/screenshots/05-summary.png) *Bundle inventory — roots & manifest* | ![Follow-up question answered by the local model](docs/screenshots/06-analyst.png) *Asking the analyst a follow-up* |

## Use it

**Scanner only — no install, no server.** Open `index.html` in any modern browser. Then either

- drag a skill folder, `.zip`, or `.skill` onto the drop zone,
- use the folder / archive pickers, or
- click **Scan demo skill** for a full report immediately.

**With the AI Analyst.** Needs OMLX serving on `127.0.0.1:8000` and Node ≥ 18:

```bash
node server.mjs           # → http://127.0.0.1:8787, opens your browser
```

The deck is the same file either way — the bridge just serves it and adds `/api/*`. Without the bridge the Analyst view says so and everything else works unchanged.

## The deck

| View | What's in it |
| --- | --- |
| **Situation Room** | intake, live scanner instrument, KPI tiles, grade gauge, severity pills, skill roster, activity log |
| **Findings** | every rule hit — searchable, filterable by severity, sortable; click a row for the detail, the evidence line, and the analyst's ruling |
| **Capabilities** | what the bundle can reach, with the lines that prove it |
| **Bundle** | frontmatter, every skill root found in the drop, and a file manifest with per-file hit counts |
| **AI Analyst** | OMLX status, the three review passes, the verdict, per-finding adjudications, and a chat box for follow-ups |
| **About** | the rule model, the stack, and exactly what does and doesn't leave your machine |

Drop a bundle containing several skills and the roster lists each one; click any root to make it active across every view. Reports export to Markdown (per skill or all of them) and JSON.

## What it checks

Rules key on the **shape** of an attack, not on mere capability — a legitimate newsletter skill that sends email via SMTP with an env-var password grades A with its capabilities listed, while a skill that reads `~/.aws/credentials` and POSTs it to a webhook grades F.

**Security (SEC-001…010):** prompt-injection phrasing, hidden/invisible-unicode and ASCII smuggling, data exfiltration, dangerous shell (`rm -rf /`, `curl | bash`, fork bombs, process substitution), dynamic-code/obfuscation (`exec(b64decode(...))`, `powershell -enc`), hardcoded secrets (AWS/OpenAI/GitHub keys, private keys), sensitive-path access, persistence/env tampering, safety-bypass instructions, and remote fetch-and-run guidance.

**Quality (QUA-001…011):** SKILL.md presence and body, frontmatter validity, `name`/`description` quality and kebab-case, trigger guidance, file length, broken relative references, junk files, bundle size, unreferenced scripts, and binary blobs.

**Documentation-aware:** a SKILL.md that *warns against* dangerous commands ("never run `rm -rf /`") is not punished as if it ran them, and obvious placeholder secrets (`AKIAIOSFODNN7EXAMPLE`) are ignored.

Each finding carries a severity, the file and line, and a trimmed excerpt — invisible characters rendered as `\u{...}` escapes so they can't hide. Score starts at 100 and deducts per finding (critical −30, high −15, medium −7, low −3), grading A–F.

## The AI Analyst

Three passes over the report, each its own call with its own prompt:

1. **Triage** — reads SKILL.md as untrusted data and reports what the skill *actually* does: concrete behaviours, anything the description hides, risks a regex can't see, and whether the bundle is trying to redirect the agent reading it.
2. **Adjudicate** — rules on each finding: `confirmed`, `false_positive`, or `needs_review`, with a confidence and a one-line reason. Worst-first, capped at 24; anything not sent to the model is reported, never silently dropped.
3. **Verdict** — an install call (`allow` / `caution` / `block`), an adjusted grade, and the actions to take first.

Adjudications fold back into the Findings register, and the Markdown export carries the whole verdict.

Same provider contract as `contingency-atlas` and `book-buddy-2026`: OMLX at `http://127.0.0.1:8000/v1`, model `DeepSeek-V4-Flash-0731-MLX`, non-streaming (OMLX hangs with streaming on large models), API key from `OMLX_API_KEY` (default `test`).

| Env var | Default |
| --- | --- |
| `OMLX_BASE_URL` | `http://127.0.0.1:8000/v1` |
| `OMLX_API_KEY` | `test` |
| `OMLX_MODEL` | `DeepSeek-V4-Flash-0731-MLX` |
| `OMLX_TIMEOUT` | `300` (seconds per call) |
| `OMLX_MAX_TOKENS` | per-pass (1800 / 2400 / 1400); set it to pin one ceiling |

**A local model is slow and that is fine** — a full review of a busy skill is a few minutes. The deck streams progress the whole way.

### Where your data goes

Nowhere, by default. The scan is pure client-side JavaScript.

The bridge checks loopback three ways, because any one alone is bypassable: it binds a loopback address, it requires the client socket to be loopback, and it requires the request to *name* a loopback host (`Host`, and any `Origin`/`Referer`). That last one is what stops DNS rebinding — in that attack the browser genuinely is on your machine, so the socket check passes; the giveaway is the name the page used.

It also **refuses a non-loopback LLM endpoint outright**, with the hostname parsed rather than prefix-matched (`127.0.0.1.evil.tld` is not loopback, and wildcard-DNS services hand out names like that for free). Skill bundles are untrusted third-party content and the prompts carry their text verbatim. Override only if you mean it: `SKILLSPECTOR_ALLOW_REMOTE_LLM=1`.

Prompts frame bundle content as untrusted data, and a bundle cannot forge the fence that says so: marker-shaped lines in a skill's own text are defanged before interpolation, so a SKILL.md that writes `----- END UNTRUSTED SKILL.md -----` into itself cannot continue as trusted instructions. An instruction inside a skill telling the analyst to clear it is treated as evidence of injection, not as an instruction.

## Project layout

```
index.html        # the app — built, self-contained; this is what you open
build.mjs         # inlines src/* + the favicon into index.html:  node build.mjs
server.mjs        # optional OMLX bridge (zero deps, loopback only)
SPEC.md           # engine/UI/bridge contracts and the full rule catalog
assets/
  favicon.svg     # inlined as a data: URI at build time
src/
  engine.js       # scan engine: zip reader, rules, scoring (also runs in node)
  ui.js           # command deck: intake, views, rendering, exports, analyst
  bridge.js       # browser-side client for the bridge
  style.css       # command deck theme (dark only)
  template.html   # shell with build markers
server/
  omlx.mjs        # OpenAI-compatible OMLX client (node stdlib only)
  analyst.mjs     # three-pass review pipeline, jobs, event ring
tests/
  run-tests.mjs         # 74 engine tests
  run-bridge-tests.mjs  # 49 bridge/analyst tests against a fake OMLX
  run-e2e.mjs           # end-to-end in real Chrome; --analyst uses the real model
  cdp.mjs               # zero-dep Chrome DevTools Protocol driver
  fixtures/             # clean / evil / sloppy sample skills
```

## Develop

```bash
node build.mjs                   # regenerate index.html
node tests/run-tests.mjs         # engine        → PASSED: 74
node tests/run-bridge-tests.mjs  # bridge        → PASSED: 76
node tests/run-e2e.mjs           # deck in Chrome (no model needed)
node tests/run-e2e.mjs --analyst # + a live review against OMLX (minutes)
node tests/run-e2e.mjs --headful # watch it drive the browser
```

Every suite is dependency-free — `node:*` builtins only, including the CDP driver that runs the browser tests.

The engine is the single source of truth for detection; the UI only calls `SkillScanner.scanFiles()` and `SkillScanner.parseZip()` and never reimplements a rule. See `SPEC.md` before changing rule IDs or severities — they're a stable contract.

## License

MIT · Nic Cravino
