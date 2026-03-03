#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
init-skill.sh

Create a new skill folder in this vault using the skill-authoring templates.

Usage:
  init-skill.sh <skill-name> [--path agents/skills]

Example:
  bash agents/skills/skill-authoring/scripts/init-skill.sh my-new-skill

Notes:
- Skill names should be hyphen-case.
- This creates: SKILL.md, templates/, examples/, scripts/
- Run quick validation afterwards.
USAGE
}

NAME=""
OUT_BASE="agents/skills"

if [[ $# -lt 1 ]]; then
  usage
  exit 2
fi

NAME="$1"
shift

while [[ $# -gt 0 ]]; do
  case "$1" in
    --path) OUT_BASE="$2"; shift 2;;
    -h|--help) usage; exit 0;;
    *) echo "Unknown arg: $1" >&2; usage; exit 2;;
  esac
done

if [[ ! "$NAME" =~ ^[a-z0-9-]+$ ]]; then
  echo "Skill name must be hyphen-case: $NAME" >&2
  exit 2
fi

SKILL_DIR="$OUT_BASE/$NAME"
if [[ -e "$SKILL_DIR" ]]; then
  echo "Refusing to overwrite existing path: $SKILL_DIR" >&2
  exit 1
fi

mkdir -p "$SKILL_DIR" "$SKILL_DIR/templates" "$SKILL_DIR/examples" "$SKILL_DIR/scripts"

TEMPLATE_DIR="agents/skills/skill-authoring/templates"

# Initialize SKILL.md from template, replacing <skill-name>
python3 - <<PY
from pathlib import Path
name = "$NAME"
tpl = Path("$TEMPLATE_DIR/SKILL.md.template").read_text()
text = tpl.replace("<skill-name>", name)
# Avoid leaving angle brackets in frontmatter.
text = text.replace("<concrete trigger(s)>", "...")
text = text.replace("<common confusion>", "...")
text = text.replace("<other-skill>", "...")
text = text.replace("<alternative>", "...")
text = text.replace("<artifacts + success criteria>", "...")
Path("$SKILL_DIR/SKILL.md").write_text(text)
PY

chmod 644 "$SKILL_DIR/SKILL.md" 2>/dev/null || true

cat <<MSG
Created: $SKILL_DIR
Next:
  python3 agents/skills/skill-authoring/scripts/quick_validate.py "$SKILL_DIR"
MSG
