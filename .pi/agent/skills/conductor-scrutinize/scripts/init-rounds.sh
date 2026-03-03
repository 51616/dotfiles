#!/usr/bin/env bash
set -euo pipefail

TRACK_DIR=""
ROUNDS=10

while [[ $# -gt 0 ]]; do
  case "$1" in
    --track-dir)
      TRACK_DIR="${2:-}"
      shift 2
      ;;
    --rounds)
      ROUNDS="${2:-10}"
      shift 2
      ;;
    -h|--help)
      echo "usage: init-rounds.sh --track-dir <conductor/tracks/<track_id>> [--rounds 10]"
      exit 0
      ;;
    *)
      echo "unknown arg: $1" >&2
      exit 2
      ;;
  esac
done

if [[ -z "$TRACK_DIR" ]]; then
  echo "--track-dir is required" >&2
  exit 2
fi

if [[ ! -d "$TRACK_DIR" ]]; then
  echo "track dir not found: $TRACK_DIR" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TEMPLATES_DIR="$SKILL_DIR/templates"

ROUNDS_DIR="$TRACK_DIR/rounds"
mkdir -p "$ROUNDS_DIR"

scope_mode_for_round() {
  local n="$1"
  if [[ "$n" -le 2 ]]; then
    echo "legacy_partial"
  elif [[ "$n" -eq 3 || "$n" -eq 6 || "$n" -eq 9 ]]; then
    echo "extensions_full"
  elif [[ "$n" -eq 4 || "$n" -eq 7 ]]; then
    echo "scripts_full"
  else
    echo "both_full"
  fi
}

render_template() {
  local tpl="$1"; shift
  local nn="$1"; shift
  local sm="$1"; shift

  # Only the core placeholders are filled; the rest remain as TODO markers.
  sed \
    -e "s/{{NN}}/${nn}/g" \
    -e "s/{{scope_mode}}/${sm}/g" \
    -e "s/{{scope_label}}/${sm}/g" \
    "$tpl"
}

for ((i=1; i<=ROUNDS; i++)); do
  nn=$(printf "%02d" "$i")
  rdir="$ROUNDS_DIR/round_${nn}"
  mkdir -p "$rdir"
  sm=$(scope_mode_for_round "$i")

  for kind in review trim implement; do
    f="$rdir/${kind}_round_${nn}.md"
    if [[ -f "$f" ]]; then
      continue
    fi

    tpl="$TEMPLATES_DIR/${kind}_round.md"
    if [[ -f "$tpl" ]]; then
      render_template "$tpl" "$nn" "$sm" >"$f"
      continue
    fi

    # Fallback: minimal placeholder.
    cat >"$f" <<EOF
# Round ${nn} ${kind^}

## Round scope declaration
- \`scope_mode\`: \`${sm}\`

## Notes
- TODO
EOF
  done
done

echo "initialized ${ROUNDS} rounds under: $ROUNDS_DIR"