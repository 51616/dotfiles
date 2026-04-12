#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OWNER_ROOT='.'

usage() {
  cat <<'EOF'
Usage:
  bash <run-lat.sh> [owner-root] <command> [args...]

Replace `<run-lat.sh>` with a repo-local wrapper or the shared helper at
`.pi/skills/lat-md/scripts/run-lat.sh`.

If owner-root is omitted, it defaults to `.`.

Work with lattices stored under lat-md/.

What this tool is for:
  A lattice is a small markdown graph that explains architecture, ownership,
  boundaries, invariants, and links back to code.

What "owner-root" means:
  The directory that directly contains a lat-md/ folder.
  Common examples in this repo are:
    .
    .pi/scripts
    src

Good starting points:
  bash <run-lat.sh> --help
  bash <run-lat.sh> check --help
  bash <run-lat.sh> check
  bash <run-lat.sh> locate scripts
  bash <run-lat.sh> section 'scripts#Scripts'

Commands:
  check    validate a lattice
  locate   search for a section id or heading
  section  show one section in full, plus links and code refs
  refs     find markdown/code references to a section or source target
  ref      alias for refs
  expand   resolve [[wiki refs]] inside free text
  gen      print a starter template
  init     create a new lat-md/ root

Examples:
  bash <run-lat.sh> check --no-color
  bash <run-lat.sh> .pi/extensions section 'pi-instance-manager#Change guidance'
  bash <run-lat.sh> .pi/scripts refs 'slash-command-rpc#Discord parity wrappers'
  printf 'See [[scripts]]\n' | bash <run-lat.sh> expand --stdin
  bash <run-lat.sh> gen section

Options:
  -h, --help       Show this help
EOF
}

case "${1:-}" in
  -h|--help|help)
    usage
    exit 0
    ;;
  --)
    shift
    ;;
esac

if [[ $# -gt 0 && ! "${1:-}" =~ ^- && -d "$1" ]]; then
  OWNER_ROOT="$1"
  shift
fi

if [[ $# -eq 0 ]]; then
  echo "Missing lattice command." >&2
  usage >&2
  exit 2
fi

if [[ ! -d "$OWNER_ROOT" ]]; then
  echo "Owner root does not exist: $OWNER_ROOT" >&2
  exit 1
fi

COMMAND="$1"
shift
if [[ "$COMMAND" == "gen" ]]; then
  exec python3 "$SCRIPT_DIR/latmd.py" "$COMMAND" "$@"
fi
exec python3 "$SCRIPT_DIR/latmd.py" "$COMMAND" "$OWNER_ROOT" "$@"
