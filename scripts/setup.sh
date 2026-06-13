#!/usr/bin/env bash
#
# setup.sh — one-time install of SkillSpector into a local venv.
#
# We install NON-editable on purpose: uv's editable install drops a bare-path
# .pth that uv's auto-sync intermittently reverts, which breaks `import
# skillspector` mid-batch. A plain copy in site-packages + `uv run --no-sync`
# (used by scan-skills.sh) is stable.

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SPECTOR="$(dirname "$HERE")/SkillSpector"

command -v uv >/dev/null || { echo "uv not found. Install: https://docs.astral.sh/uv/"; exit 1; }

cd "$SPECTOR"
echo "Creating venv + installing dependencies (uv sync) ..."
uv sync
echo "Reinstalling skillspector non-editable (stable for batch scans) ..."
uv pip install --reinstall-package skillspector .
echo
uv run --no-sync skillspector --version
echo "Setup complete. Run a scan with: scripts/scan-skills.sh"
