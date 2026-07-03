# Skillspector

![tests](https://img.shields.io/badge/tests-74%20passing-2ce6c8?style=flat-square)
![dependencies](https://img.shields.io/badge/dependencies-none-38bdf8?style=flat-square)
![single file](https://img.shields.io/badge/app-single%20HTML%20file-8b5cf6?style=flat-square)
![offline](https://img.shields.io/badge/runs-100%25%20offline-16a766?style=flat-square)
![engine](https://img.shields.io/badge/engine-2.0.0-64748b?style=flat-square)
![release](https://img.shields.io/badge/release-v2.0.0-2ce6c8?style=flat-square)

A single-file, offline web app that scans Claude skills for **security** and **quality** problems. Drag a skill in — a folder, a `.zip`, or a `.skill` file — and get a graded report with findings, evidence, and a capability breakdown. Everything runs client-side in the browser; nothing is uploaded and there are no network calls.

![Skillspector tour — drop zone, live scan, graded report, findings, multi-skill summary](docs/skillspector-tour.gif)

## Screenshots

| | |
| --- | --- |
| ![Drop zone with the scanner idling in standby](docs/screenshots/01-standby.png) *Workbench — scanner on standby* | ![Scan in flight: beam sweep and file ticker](docs/screenshots/02-scanning.png) *Inspecting a bundle* |
| ![Graded report: F gauge, severity pills, capability surface](docs/screenshots/03-report.png) *Report — grade gauge & severity pills* | ![Findings list with evidence excerpts expanded](docs/screenshots/04-findings.png) *Findings with evidence* |
| ![Multi-skill scan summary with sortable columns](docs/screenshots/05-summary.png) *Multi-skill summary — sortable, bulk export* | |

## Use it

Open `index.html` in any modern browser (works straight off `file://` — no server needed). Then either:

- drag a skill folder, `.zip`, or `.skill` onto the drop zone,
- use the folder / archive pickers, or
- click **Scan demo skill** to see a full report immediately.

Drop a bundle containing several skills and you get a summary table with click-through to each report. Every report exports to Markdown or JSON.

## What it checks

Security rules key on the *shape* of an attack, not on mere capability — a legitimate newsletter skill that sends email via SMTP with an env-var password grades A with its capabilities listed, while a skill that reads `~/.aws/credentials` and POSTs it to a webhook grades F.

Security (SEC-001…010): prompt-injection phrasing, hidden/invisible-unicode and ASCII smuggling, data exfiltration, dangerous shell (`rm -rf /`, `curl | bash`, fork bombs, process substitution), dynamic-code/obfuscation (`exec(b64decode(...))`, `powershell -enc`), hardcoded secrets (AWS/OpenAI/GitHub keys, private keys), sensitive-path access, persistence/env tampering, safety-bypass instructions, and remote fetch-and-run guidance.

Quality (QUA-001…011): SKILL.md presence and body, frontmatter validity, `name`/`description` quality and kebab-case, trigger guidance, file length, broken relative references, junk files, bundle size, unreferenced scripts, and binary blobs.

Documentation-aware: a SKILL.md that *warns against* dangerous commands ("never run `rm -rf /`") is not punished as if it ran them, and obvious placeholder secrets (`AKIAIOSFODNN7EXAMPLE`) are ignored.

Each finding carries a severity, the file and line, and a trimmed excerpt (invisible characters rendered as `\u{...}` escapes so they can't hide). Score starts at 100 and deducts per finding (critical −30, high −15, medium −7, low −3), grading A–F.

## Project layout

```
index.html        # the app — built, self-contained, this is what you open
build.mjs         # inlines src/* into index.html:  node build.mjs
SPEC.md           # the engine/UI contract and full rule catalog
src/
  engine.js       # scan engine: zip reader, rules, scoring (also runs in node)
  ui.js           # drop zone, scan animation, report rendering, exports
  style.css       # dark-first theme with light mode
  template.html   # shell with build markers
tests/
  run-tests.mjs   # 74 tests, zero dependencies:  node tests/run-tests.mjs
  fixtures/       # clean / evil / sloppy sample skills
```

## Develop

Edit files under `src/`, then rebuild and test:

```bash
node build.mjs            # regenerate index.html
node tests/run-tests.mjs  # run the suite (should print PASSED: 74  FAILED: 0)
```

The engine is the single source of truth for detection; the UI only calls `SkillScanner.scanFiles()` and `SkillScanner.parseZip()` and never reimplements a rule. See `SPEC.md` before changing rule IDs or severities — they're a stable contract.
