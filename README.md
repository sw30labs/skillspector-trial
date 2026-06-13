# SkillSpector Trial

A small wrapper project for trying out [**NVIDIA SkillSpector**](https://github.com/NVIDIA/SkillSpector)
against my own collection of Claude agent skills.

SkillSpector is a **security scanner for AI agent skills** — it answers *"is this
skill safe to install?"* by scanning `SKILL.md` files and their helper scripts for
prompt injection, data exfiltration, dangerous code, supply-chain risks, and more
(64 patterns across 16 categories). This project points it at every skill in my
skills folder and rolls the per-skill results up into a single summary.

## What this project is

```
skillspector-trial/
├── SkillSpector/        # vendored copy of NVIDIA/SkillSpector (Apache-2.0, see its LICENSE)
├── scripts/
│   ├── setup.sh         # one-time: create venv + install SkillSpector
│   └── scan-skills.sh   # scan every skill in a folder → reports/
├── reports/             # per-skill JSON + Markdown, plus summary.{json,md}
├── .gitignore
└── README.md
```

- **SkillSpector** is vendored at upstream commit
  [`1a7bf02`](https://github.com/NVIDIA/SkillSpector/commit/1a7bf026a3cf0ecfd957b6c173244d51b3141baf)
  (v2.1.3, 2026-06-10) — a flat copy with no nested `.git`, so the project is
  self-contained and clones cleanly. It is licensed separately under Apache-2.0
  (see [`SkillSpector/LICENSE`](SkillSpector/LICENSE)). To pull future pattern
  updates, re-vendor from that commit or convert `SkillSpector/` to a git submodule.

## How it works

```mermaid
flowchart TD
    A["Skills folder<br/>~/Code/SKILLS"] --> B{"scan-skills.sh<br/>discover skill dirs"}
    B -->|"each subdir<br/>containing a SKILL.md"| C["SkillSpector scan"]

    subgraph SS ["SkillSpector two-stage pipeline"]
        direction TB
        C --> D["Stage 1 — Static analysis<br/>regex · AST · taint · YARA<br/>OSV.dev CVE lookup"]
        D --> E{"LLM stage<br/>enabled?"}
        E -->|"--no-llm (default here)<br/>no API key needed"| G["Risk score 0–100<br/>+ severity + recommendation"]
        E -->|"--llm + provider key<br/>filters false positives → ~87% precision"| F["Stage 2 — LLM semantic review"]
        F --> G
    end

    G --> H["Per-skill report<br/>reports/&lt;skill&gt;.json + .md"]
    H --> I["Roll-up<br/>reports/summary.md<br/>reports/summary.json"]

    classDef src fill:#1f6feb,stroke:#0b3a8c,color:#fff;
    classDef out fill:#238636,stroke:#10401d,color:#fff;
    classDef warn fill:#9e6a03,stroke:#5a3d02,color:#fff;
    class A src;
    class H,I out;
    class G warn;
```

## Where my skills were found

I keep skills in a few places, but the main collection is **`~/Code/SKILLS/`**
(other `SKILL.md` files also live under `~/Code/REPOS`, `~/Code/sw30`, and
`~/.claude/skills` — those weren't part of this run). The scanner treats each
immediate subdirectory containing a `SKILL.md` as one skill.

**6 skills scanned** from `~/Code/SKILLS` (static analysis only, no LLM):

| Skill | Score | Severity | Recommendation | Findings | Breakdown | Scripts |
|---|---:|---|---|---:|---|:---:|
| create-graph-api | 13 | LOW | SAFE | 1 | 1 M | yes |
| manage-portfolio | 13 | LOW | SAFE | 1 | 1 M | yes |
| article-qa | 0 | LOW | SAFE | 0 | — | — |
| idea-buddy | 0 | LOW | SAFE | 0 | — | — |
| tab-newsletter | 0 | LOW | SAFE | 0 | — | yes |
| web-to-md-js | 0 | LOW | SAFE | 0 | — | — |

_Key: H=High, M=Medium, L=Low. Full per-skill reports in_
[`reports/`](reports/).

### Result distribution

All 6 skills scored **SAFE** (LOW severity). Only two findings surfaced —
both **Medium**, flagging `MCP Least Privilege` (an MCP tool granted broader
scope than the skill needs). Nothing in this set is high-risk under static
analysis.

## ⚠️ How to read these results

These are **my own skills**, so even the SAFE verdicts are best read as a
baseline, not a clean bill of health. Worth understanding before trusting the score:

- **Static-only run.** I scanned with `--no-llm` (no API key required). SkillSpector
  itself notes static analysis has *"moderate precision (some false positives)"*; the
  optional LLM stage raises precision to ~87% by filtering them. Re-run with `--llm`
  for a sharper read (see below).
- **The two Medium flags merit a glance.** Both are `MCP Least Privilege`
  (`create-graph-api`, `manage-portfolio`) — worth confirming each MCP tool is
  scoped to only what the skill actually uses, but neither is exploitable on its own.
- **Score ≠ malware.** A non-zero score reflects patterns static analysis treats as
  risk signals on real automation skills, not evidence of malicious behavior.

## Re-running

```bash
# 1. One-time setup (creates SkillSpector/.venv, installs the tool)
scripts/setup.sh

# 2. Scan the default skills folder (~/Code/SKILLS), static only
scripts/scan-skills.sh

# Scan a different folder
scripts/scan-skills.sh ~/some/other/skills

# Enable the LLM semantic stage (better precision; needs a provider + key)
export SKILLSPECTOR_PROVIDER=anthropic
export ANTHROPIC_API_KEY=sk-ant-...
scripts/scan-skills.sh ~/Code/SKILLS --llm
```

Results land in [`reports/`](reports/): one `<skill>.json` and `<skill>.md` per skill,
plus `summary.json` and `summary.md`.

### Scan a single skill directly

```bash
cd SkillSpector
uv run --no-sync skillspector scan ~/Code/SKILLS/web2md --no-llm
```

## Notes / gotchas

- **Requires `uv`** (already installed here) and Python 3.12 (uv fetches it automatically).
- **Non-editable install on purpose.** `setup.sh` installs SkillSpector as a plain copy
  in the venv rather than editable. uv's editable install drops a bare-path `.pth` that
  uv's auto-sync intermittently reverts, which breaks `import skillspector` mid-batch.
  `scan-skills.sh` therefore calls `uv run --no-sync` so the venv is never re-linked
  during a run.
- **Exit codes are linter-style:** SkillSpector exits non-zero when a skill is high-risk.
  `scan-skills.sh` treats that as a normal result (a report was produced), not a failure.
- **LLM analysis costs API calls** and sends skill contents to your chosen provider —
  the default static-only mode stays fully local except for OSV.dev CVE lookups.
