#!/usr/bin/env bash
set -euo pipefail

# Shared helpers for conductor skill scripts.

script_dir() {
  cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd
}

skill_root() {
  cd -- "$(script_dir)/.." >/dev/null 2>&1 && pwd
}

templates_dir() {
  echo "$(skill_root)/templates"
}

usage_die() {
  echo "error: $*" >&2
  exit 2
}

# Escape a string for safe insertion into a sed replacement.
escape_sed_repl() {
  # escape backslash, ampersand, and delimiter (/)
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/&/\\&/g' -e 's/\//\\\//g'
}

slugify() {
  local s="$1"
  s="$(printf '%s' "$s" | tr '[:upper:]' '[:lower:]')"
  s="$(printf '%s' "$s" | sed -E 's/[^a-z0-9]+/-/g; s/^-+|-+$//g')"
  if [[ -z "$s" ]]; then
    s="track"
  fi
  # keep it reasonably short
  printf '%s' "$s" | cut -c1-24
}
