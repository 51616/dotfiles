#!/usr/bin/env bash
set -euo pipefail

ROOT="."

usage() {
  cat <<'EOF'
Usage: status.sh [--root <path>]

Print a lightweight overview of Conductor tracks.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --root)
      ROOT="${2:-}"; shift 2 ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      echo "Unknown arg: $1" >&2
      usage
      exit 2
      ;;
  esac
done

ROOT="$(cd -- "$ROOT" >/dev/null 2>&1 && pwd)" || { echo "root not found: $ROOT" >&2; exit 2; }

tracks="$ROOT/conductor/tracks.md"

if [[ ! -f "$tracks" ]]; then
  echo "Conductor not set up (missing conductor/tracks.md)." >&2
  exit 1
fi

echo "Tracks: $tracks"

total=$(rg -c "^- \[[ x~]\] \*\*Track:" "$tracks" || true)
new=$(rg -c "^- \[ \] \*\*Track:" "$tracks" || true)
prog=$(rg -c "^- \[~\] \*\*Track:" "$tracks" || true)
done=$(rg -c "^- \[x\] \*\*Track:" "$tracks" || true)

echo "Summary: total=$total new=$new in_progress=$prog done=$done"

echo
rg -n "^- \[[ x~]\] \*\*Track:" "$tracks" || true
