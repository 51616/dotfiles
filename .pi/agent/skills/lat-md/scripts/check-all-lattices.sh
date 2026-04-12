#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_LAT_SCRIPT="$SCRIPT_DIR/run-lat.sh"
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

TARGET_ROOT="$(cd "$TARGET_ROOT" && pwd)"

if [[ ! -x "$RUN_LAT_SCRIPT" ]]; then
  echo "Missing required helper: $RUN_LAT_SCRIPT" >&2
  exit 1
fi

rel_path() {
  local path="$1"
  if [[ "$path" == "$TARGET_ROOT" ]]; then
    printf '.'
  elif [[ "$path" == "$TARGET_ROOT"/* ]]; then
    printf '%s' "${path#"$TARGET_ROOT"/}"
  else
    printf '%s' "$path"
  fi
}

print_block() {
  local prefix="$1"
  local text="$2"
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    printf '    %s%s\n' "$prefix" "$line"
  done <<<"$text"
}

discover_lattice_dirs() {
  find "$TARGET_ROOT" \
    \( \
      -name .git -o \
      -name node_modules -o \
      -name dist -o \
      -name build -o \
      -name .cache -o \
      -name .venv -o \
      -name __pycache__ -o \
      -name .pytest_cache -o \
      -name .mypy_cache \
    \) -prune -o \
    -type d -name 'lat-md' -print | sort
}

declare -A seen_roots=()
declare -a owner_roots=()
while IFS= read -r lattice_dir; do
  owner_root="$(dirname "$lattice_dir")"
  owner_root="$(cd "$owner_root" && pwd)"
  if [[ -z "${seen_roots[$owner_root]:-}" ]]; then
    seen_roots["$owner_root"]=1
    owner_roots+=("$owner_root")
  fi
done < <(discover_lattice_dirs)

if [[ ${#owner_roots[@]} -eq 0 ]]; then
  echo "No lat-md directories found under $(rel_path "$TARGET_ROOT")"
  exit 1
fi

echo "[lat-check] repo root: $TARGET_ROOT"
echo

pass_count=0
fail_count=0

for owner_root in "${owner_roots[@]}"; do
  rel_owner="$(rel_path "$owner_root")"
  rel_lattice="$rel_owner/lat-md/"
  if [[ "$rel_owner" == "." ]]; then
    rel_lattice='lat-md/'
  fi

  printf '[lat-check] %s -> %s\n' "$rel_owner" "$rel_lattice"

  set +e
  output="$("$RUN_LAT_SCRIPT" "$owner_root" check --no-color 2>&1)"
  rc=$?
  set -e

  if [[ $rc -eq 0 ]]; then
    printf '[ok] %s\n' "$rel_owner"
    pass_count=$((pass_count + 1))

    warnings="$(printf '%s\n' "$output" | awk '/^Warning:/{print}')"
    if [[ -n "$warnings" ]]; then
      print_block '! ' "$warnings"
    fi
    if [[ "$VERBOSE" == "1" ]]; then
      print_block '' "$output"
    fi
  else
    printf '[fail] %s\n' "$rel_owner"
    print_block '' "$output"
    fail_count=$((fail_count + 1))
  fi

  echo
done

printf '[lat-check] summary: %d passed, %d failed\n' "$pass_count" "$fail_count"

if [[ $fail_count -gt 0 ]]; then
  exit 1
fi
