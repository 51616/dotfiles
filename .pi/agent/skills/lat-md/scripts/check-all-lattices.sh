#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LATMD_SCRIPT="$SCRIPT_DIR/latmd.py"
TARGET_ROOT='.'
VERBOSE="${LAT_VERBOSE:-0}"

usage() {
  cat <<'EOF'
Usage:
  bash <check-all-lattices.sh> [repo-root]
  bash <check-all-lattices.sh> --verbose [repo-root]

Replace `<check-all-lattices.sh>` with a repo-local wrapper or the shared helper
at `.pi/skills/lat-md/scripts/check-all-lattices.sh`.

Run the shared lattice check for every discovered `lat-md/` directory under the
target repo, using the correct owning project root for each lattice.

Options:
  --verbose        Print full `lat check` output for successful checks too
  -h, --help       Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "${1:-}" in
    --verbose)
      VERBOSE=1
      shift
      ;;
    -h|--help|help)
      usage
      exit 0
      ;;
    --)
      shift
      break
      ;;
    -*)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      TARGET_ROOT="$1"
      shift
      ;;
  esac
done

if [[ $# -gt 0 ]]; then
  echo "Unexpected extra arguments: $*" >&2
  usage >&2
  exit 2
fi

if [[ ! -d "$TARGET_ROOT" ]]; then
  echo "Target root does not exist: $TARGET_ROOT" >&2
  exit 1
fi

if [[ ! -f "$LATMD_SCRIPT" ]]; then
  echo "Missing required helper: $LATMD_SCRIPT" >&2
  exit 1
fi

args=(check-all "$TARGET_ROOT")
if [[ "$VERBOSE" == "1" ]]; then
  args+=(--verbose)
fi

exec python3 "$LATMD_SCRIPT" "${args[@]}"
