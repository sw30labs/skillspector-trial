#!/usr/bin/env bash
#
# scan-skills.sh — point SkillSpector at a folder of agent skills and scan each one.
#
# Each immediate subdirectory of SKILLS_DIR that contains a SKILL.md (at any
# depth) is treated as one skill and scanned independently. Per-skill JSON and
# Markdown reports land in reports/, plus a roll-up summary.json + summary.md.
#
# Usage:
#   scripts/scan-skills.sh [SKILLS_DIR] [--llm]
#
#   SKILLS_DIR   folder holding skill subfolders   (default: ~/Code/SKILLS)
#   --llm        enable LLM semantic analysis      (default: static-only, no API key needed)
#
# LLM mode needs SKILLSPECTOR_PROVIDER + the matching API key exported. See
# SkillSpector/README.md. Without it the scan is purely static (regex + AST +
# OSV.dev), which needs no credentials.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJ="$(dirname "$HERE")"
SPECTOR="$PROJ/SkillSpector"
REPORTS="${REPORTS_DIR:-$PROJ/reports}"

SKILLS_DIR="${1:-$HOME/Code/SKILLS}"
LLM_FLAG="--no-llm"
for arg in "$@"; do
  [ "$arg" = "--llm" ] && LLM_FLAG=""
done

if [ ! -d "$SKILLS_DIR" ]; then
  echo "ERROR: skills dir not found: $SKILLS_DIR" >&2
  exit 1
fi

mkdir -p "$REPORTS"
rm -f "$REPORTS"/*.json "$REPORTS"/*.md 2>/dev/null || true

echo "Skills dir : $SKILLS_DIR"
echo "Mode       : $([ -z "$LLM_FLAG" ] && echo 'static + LLM' || echo 'static only')"
echo "Reports    : $REPORTS"
echo

# --no-sync: never re-link the venv mid-batch. SkillSpector is installed once by
# setup.sh; uv's auto-sync would revert it to a flaky editable install.
run() { ( cd "$SPECTOR" && uv run --no-sync skillspector "$@" ); }

count=0
for dir in "$SKILLS_DIR"/*/; do
  name="$(basename "$dir")"
  # only treat it as a skill if there's a SKILL.md somewhere inside
  if ! find "$dir" -name SKILL.md -print -quit | grep -q .; then
    continue
  fi
  count=$((count + 1))
  echo "[$count] scanning $name ..."
  # NOTE: skillspector exits non-zero when a skill is high-risk (like a linter),
  # so we judge success by whether the report file was written, not exit code.
  # Capture per-skill stderr so analyzer failures are diagnosable (not /dev/null).
  run scan "$dir" $LLM_FLAG --format json     --output "$REPORTS/$name.json" >/dev/null 2>"$REPORTS/$name.err" || true
  # The markdown pass re-runs the entire analysis just to reformat. With the LLM
  # stage that doubles cost, so SKIP_MARKDOWN=1 skips it (JSON + summary suffice).
  if [ -z "${SKIP_MARKDOWN:-}" ]; then
    run scan "$dir" $LLM_FLAG --format markdown  --output "$REPORTS/$name.md"   >/dev/null 2>&1 || true
  fi
  [ -s "$REPORTS/$name.json" ] || echo "    WARNING: no report produced for $name (see $name.err)"
done

echo
echo "Scanned $count skills. Building summary ..."

# Roll the per-skill JSON up into summary.json + summary.md
python3 - "$REPORTS" "$SKILLS_DIR" <<'PY'
import json, sys, glob, os, datetime

reports_dir, skills_dir = sys.argv[1], sys.argv[2]
rows = []
for path in sorted(glob.glob(os.path.join(reports_dir, "*.json"))):
    if os.path.basename(path) == "summary.json":
        continue
    with open(path) as fh:
        d = json.load(fh)
    ra = d.get("risk_assessment", {})
    issues = d.get("issues", [])
    sev_counts = {}
    for i in issues:
        s = (i.get("severity") or "UNKNOWN").upper()
        sev_counts[s] = sev_counts.get(s, 0) + 1
    folder = os.path.basename(path)[:-5]  # report filename == skill folder name
    name = d.get("skill", {}).get("name") or ""
    if not name or name.lower() == "unknown":
        name = folder
    rows.append({
        "skill": name,
        "score": ra.get("score"),
        "severity": ra.get("severity"),
        "recommendation": ra.get("recommendation"),
        "n_issues": len(issues),
        "by_severity": sev_counts,
        "has_scripts": d.get("metadata", {}).get("has_executable_scripts", False),
        "components": len(d.get("components", [])),
        "report": os.path.basename(path),
    })

rows.sort(key=lambda r: (r["score"] or 0), reverse=True)

summary = {
    "scanned_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "skills_dir": skills_dir,
    "n_skills": len(rows),
    "totals": {
        "issues": sum(r["n_issues"] for r in rows),
        "with_scripts": sum(1 for r in rows if r["has_scripts"]),
        "not_safe": sum(1 for r in rows if (r["recommendation"] or "").upper() not in ("SAFE", "")),
    },
    "skills": rows,
}
with open(os.path.join(reports_dir, "summary.json"), "w") as fh:
    json.dump(summary, fh, indent=2)

def sev_cell(c):
    order = ["CRITICAL", "HIGH", "MEDIUM", "LOW"]
    parts = [f"{c[s]} {s[0]}" for s in order if c.get(s)]
    return ", ".join(parts) or "-"

lines = []
lines.append(f"# Skill Security Scan — Summary\n")
lines.append(f"- **Scanned:** {summary['scanned_at']}")
lines.append(f"- **Skills folder:** `{skills_dir}`")
lines.append(f"- **Skills scanned:** {summary['n_skills']}")
lines.append(f"- **Total findings:** {summary['totals']['issues']}")
lines.append(f"- **Skills with executable scripts:** {summary['totals']['with_scripts']}")
lines.append(f"- **Skills flagged (not SAFE):** {summary['totals']['not_safe']}\n")
lines.append("| Skill | Score | Severity | Recommendation | Findings | Breakdown | Scripts |")
lines.append("|---|---:|---|---|---:|---|:---:|")
for r in rows:
    lines.append(
        f"| {r['skill']} | {r['score']} | {r['severity']} | {r['recommendation']} "
        f"| {r['n_issues']} | {sev_cell(r['by_severity'])} | {'yes' if r['has_scripts'] else '-'} |"
    )
lines.append("\n_Severity breakdown key: C=Critical, H=High, M=Medium, L=Low._")
with open(os.path.join(reports_dir, "summary.md"), "w") as fh:
    fh.write("\n".join(lines) + "\n")

print(f"\nSummary: {summary['n_skills']} skills, "
      f"{summary['totals']['issues']} findings, "
      f"{summary['totals']['not_safe']} flagged not-SAFE.")
print(f"  -> {os.path.join(reports_dir, 'summary.md')}")
print(f"  -> {os.path.join(reports_dir, 'summary.json')}")
PY
