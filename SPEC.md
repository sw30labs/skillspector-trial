# Skillspector — Skill Scanner SPEC

Single-file, offline, client-side web app. Users drop a Claude skill (folder, `.zip`, or `.skill`) and get a security + quality scan report. No frameworks, no CDN, no network calls — everything inline in the final `index.html`.

## Project layout

```
Skill Scanner/
  index.html          # BUILT artifact — single-file app (committed)
  build.mjs           # inlines src/* into index.html
  SPEC.md             # this file
  README.md
  src/
    engine.js         # scan engine (ES module; browser + node >= 18)
    ui.js             # GUI logic (plain script, no module)
    style.css         # styles
    template.html     # shell with markers: /*__CSS__*/ /*__ENGINE__*/ /*__UI__*/
  tests/
    run-tests.mjs     # node test runner, zero deps (node:assert, node:test ok)
    fixtures/         # skill bundles used by tests
      clean-skill/
      evil-skill/
      sloppy-skill/
  samples/            # demo skills users can drop (zips built by tests or build)
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

## UI contract (GUI agent)

- Calls only: `await SkillScanner.scanFiles(entries)` and `await SkillScanner.parseZip(bytes)`. Never reimplements rules.
- Input paths: (1) drag-drop of folder(s) — webkitGetAsEntry traversal; (2) drag-drop or file-picker of .zip/.skill — parseZip; (3) "Scan demo skill" button — embedded demo FileEntry[] (a small deliberately-sketchy skill defined as JS string constants in ui.js, so first-time users see a rich report instantly).
- Multiple skills per drop → summary table (name, grade chip, score, criticals) with click-through to each report.
- Report view: score ring gauge (animated), grade, severity pill counts, capabilities row (neutral chips w/ tooltip evidence), findings grouped by category, each expandable to show file, line, excerpt (monospace, escaped), rule id. Severity filter toggles. Buttons: "Export report (.md)" and "Export JSON" via Blob download. "Scan another" resets.
- While scanning: brief scanner animation (sweep line over a file-list ticker). Keep under ~1.2s artificial minimum so it feels like it did work, but don't fake longer.
- Design brief: product name "Skillspector". Dark theme default (deep navy/charcoal, neon-teal accent, amber/red for severities), light theme via prefers-color-scheme. Monospace accents (ui-monospace stack). Subtle CRT/scanline texture ok — tasteful, not noisy. `prefers-reduced-motion` honored. Fully keyboard-usable; drop zone also a button. Responsive ≥ 360px. No external fonts/assets — inline SVG only.
- Everything must work from `file://` (no fetch of local resources, no modules in final build).

## Build

`node build.mjs` → reads src/template.html, substitutes markers with file contents:
`/*__CSS__*/` (inside a `<style>`), `/*__ENGINE__*/` then `/*__UI__*/` (inside ONE
non-module `<script>`; engine's `export` statements must be build-stripped or engine
written export-free using the globalThis attach + `export { … }` on one final line the
build strips). Output: ./index.html. Build must fail loudly if any marker missing.

## Tests (engine agent owns)

`node tests/run-tests.mjs` (or node --test). Cover: zip round-trip (build a zip in-test
programmatically — stored + deflate entries), root detection (0, 1, n, nested), every
SEC rule fires on evil-skill fixture, clean-skill scores ≥ 90 with zero
critical/high, sloppy-skill triggers expected QUA set, scoring math, cap-at-3 logic,
invisible-unicode excerpt escaping. Exit non-zero on failure.
