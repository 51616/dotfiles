#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
new-checkpoint.sh

Create a new checkpoint note from the template with a JST timestamped filename.

Usage:
  new-checkpoint.sh <slug>

Example:
  bash scripts/new-checkpoint.sh ssh-pi-agent-flow

Output:
  work/log/checkpoints/YYYY-MM-DD_HHMM_<slug>.md
USAGE
}

if [[ ${1:-} == "" || ${1:-} == "-h" || ${1:-} == "--help" ]]; then
  usage
  exit 2
fi

SLUG="$1"

# Simple slug guard (keep it filesystem-safe)
if [[ ! "$SLUG" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo "Slug must be hyphen-case (a-z0-9 and '-') and start with alnum: $SLUG" >&2
  exit 2
fi

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
SKILL_ROOT=$(cd -- "$SCRIPT_DIR/.." && pwd)

# Resolve the target project root from the current working tree, not from the skill install
# location. The helper's assets come from SKILL_ROOT, while outputs belong to the active
# workspace rooted at the current cwd/git checkout.
if ROOT=$(git rev-parse --show-toplevel 2>/dev/null); then
  :
else
  ROOT=$(pwd)
fi

OUT_DIR="$ROOT/work/log/checkpoints"
TPL="$SKILL_ROOT/templates/checkpoint.template.md"

if [[ ! -f "$TPL" ]]; then
  echo "Template not found at: $TPL" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

TS=$(TZ=Asia/Tokyo date +%F_%H%M)
OUT_REL="work/log/checkpoints/${TS}_${SLUG}.md"
OUT="$OUT_DIR/${TS}_${SLUG}.md"

if [[ -e "$OUT" ]]; then
  echo "Refusing to overwrite existing file: $OUT" >&2
  exit 1
fi

cp "$TPL" "$OUT"

# Fill the Date line (best-effort; template may change)
DATE_LINE=$(TZ=Asia/Tokyo date '+%Y-%m-%d %H:%M JST')
python3 - <<PY
from pathlib import Path
p=Path(r"$OUT")
text=p.read_text()
text=text.replace('Date: <%Y-%m-%d %H:%M JST>', f'Date: {"$DATE_LINE"}')
p.write_text(text)
PY

# IMPORTANT: autockpt footer parsing expects a vault-relative path starting with
# "work/log/checkpoints/" (NOT an absolute path).
echo "$OUT_REL"
