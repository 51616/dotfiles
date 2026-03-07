#!/usr/bin/env bash
set -euo pipefail

ROOT="."
FORCE=0

usage() {
  cat <<'EOF'
Usage: setup.sh [--root <path>] [--force]

Scaffold Conductor-style context files in a target repo.

Creates (under <root>):
  conductor/{index.md,project.md,project-guidelines.md,tech-stack.md,workflow.md,tracks.md}
  conductor/tracks/
  conductor/code_styleguides/
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --root)
      ROOT="${2:-}"; shift 2 ;;
    --force)
      FORCE=1; shift ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      echo "Unknown arg: $1" >&2
      usage
      exit 2
      ;;
  esac
done

source "$(dirname -- "${BASH_SOURCE[0]}")/lib.sh"

[[ -n "$ROOT" ]] || usage_die "--root requires a path"

ROOT="$(cd -- "$ROOT" >/dev/null 2>&1 && pwd)" || usage_die "root not found: $ROOT"

TDIR="$(templates_dir)"

mkdir -p "$ROOT/conductor/tracks" "$ROOT/conductor/code_styleguides"

copy_tpl() {
  local src_rel="$1"
  local dst_rel="$2"
  local src="$TDIR/$src_rel"
  local dst="$ROOT/$dst_rel"

  [[ -f "$src" ]] || usage_die "missing template: $src"

  if [[ -f "$dst" && "$FORCE" -ne 1 ]]; then
    echo "skip (exists): $dst_rel"
    return
  fi

  mkdir -p "$(dirname -- "$dst")"
  cp "$src" "$dst"
  echo "write: $dst_rel"
}

copy_tpl "index.md" "conductor/index.md"
copy_tpl "project.md" "conductor/project.md"
copy_tpl "project-guidelines.md" "conductor/project-guidelines.md"
copy_tpl "tech-stack.md" "conductor/tech-stack.md"
copy_tpl "workflow.md" "conductor/workflow.md"
copy_tpl "tracks.md" "conductor/tracks.md"

copy_tpl "code_styleguides/general.md" "conductor/code_styleguides/general.md"
copy_tpl "code_styleguides/python.md" "conductor/code_styleguides/python.md"
copy_tpl "code_styleguides/typescript.md" "conductor/code_styleguides/typescript.md"

echo "ok: Conductor scaffold created under: $ROOT/conductor"
