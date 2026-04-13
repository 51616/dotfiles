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
  /tmp/pi-work/checkpoints/YYYY-MM-DD_HHMM_<slug>.md
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

OUT_DIR="/tmp/pi-work/checkpoints"
TPL="$SKILL_ROOT/templates/checkpoint.template.md"

if [[ ! -f "$TPL" ]]; then
  echo "Template not found at: $TPL" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

TS=$(TZ=Asia/Tokyo date +%F_%H%M)
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

echo "$OUT"
