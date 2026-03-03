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
      echo "usage: verify-artifacts.sh --track-dir <conductor/tracks/<track_id>> [--rounds 10]"
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

ROUNDS_DIR="$TRACK_DIR/rounds"
missing=0

for ((i=1; i<=ROUNDS; i++)); do
  nn=$(printf "%02d" "$i")
  for kind in review trim implement; do
    f="$ROUNDS_DIR/round_${nn}/${kind}_round_${nn}.md"
    if [[ ! -f "$f" ]]; then
      echo "MISSING: $f"
      missing=$((missing+1))
    fi
  done
done

expected=$((ROUNDS*3))
actual=$(find "$ROUNDS_DIR" -type f \( -name 'review_round_*.md' -o -name 'trim_round_*.md' -o -name 'implement_round_*.md' \) | wc -l | tr -d ' ')

echo "expected_artifacts=$expected"
echo "actual_artifacts=$actual"

if [[ "$missing" -ne 0 ]]; then
  echo "artifact verification failed (missing=$missing)" >&2
  exit 1
fi

if [[ "$actual" -lt "$expected" ]]; then
  echo "artifact verification failed (actual < expected)" >&2
  exit 1
fi

echo "artifact verification passed"
