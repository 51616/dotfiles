#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK_SCRIPT="$SCRIPT_DIR/check-all-lattices.sh"
TARGET_ROOT='.'
SHOW_REPO_TREE=0
VERBOSE=0

usage() {
  cat <<'EOF'
Usage:
  bash <lat-walk.sh> [repo-root]
  bash <lat-walk.sh> --repo-tree [repo-root]
  bash <lat-walk.sh> --repo-tree --verbose [repo-root]

Replace `<lat-walk.sh>` with a repo-local wrapper or the shared helper at
`.pi/skills/lat-md/scripts/lat-walk.sh`.

Print a lattice-focused onboarding map: repo identity, lattice ownership,
lattice files, and verification commands.

Options:
  --repo-tree      Include a pruned repo tree and owned-subtree trees
  --verbose        With --repo-tree, include owned-subtree trees too
  -h, --help       Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "${1:-}" in
    --repo-tree)
      SHOW_REPO_TREE=1
      shift
      ;;
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

print_lattice_files() {
  local owner_root="$1"
  local lattice_dir="$owner_root/lat-md"

  if [[ ! -d "$lattice_dir" ]]; then
    return
  fi

  while IFS= read -r file_path; do
    local rel_file
    rel_file="$(rel_path "$file_path")"
    echo "  - $rel_file"
  done < <(find "$lattice_dir" -maxdepth 1 -type f -name '*.md' | sort)
}

print_tree() {
  local root_path="$1"
  local label="$2"
  local max_depth="$3"

  python3 - "$root_path" "$label" "$max_depth" <<'PY'
import os
import sys

root = os.path.abspath(sys.argv[1])
label = sys.argv[2]
max_depth = int(sys.argv[3])

if not os.path.exists(root):
    sys.exit(0)

PRUNE_NAMES = {
    '.git',
    '.obsidian',
    '.claude',
    '.codex',
    '.cursor',
    '.idea',
    '.vscode',
    'node_modules',
    'dist',
    'build',
    '.cache',
    '.venv',
    '__pycache__',
    '.pytest_cache',
    '.mypy_cache',
}


def display_name(path: str) -> str:
    name = os.path.basename(path)
    if os.path.isdir(path):
        if name in PRUNE_NAMES:
            return f'{name}/ [pruned]'
        return f'{name}/'
    return name


def children(path: str):
    try:
        entries = [os.path.join(path, name) for name in os.listdir(path)]
    except OSError:
        return []

    entries.sort(key=lambda p: (not os.path.isdir(p), os.path.basename(p).lower()))
    return entries


def walk(path: str, prefix: str = '', depth: int = 0):
    if depth >= max_depth:
        return
    entries = children(path)
    if not entries:
        return
    for idx, child in enumerate(entries):
        connector = '└── ' if idx == len(entries) - 1 else '├── '
        print(f'{prefix}{connector}{display_name(child)}')
        if not os.path.isdir(child):
            continue
        if os.path.basename(child) in PRUNE_NAMES:
            continue
        extension = '    ' if idx == len(entries) - 1 else '│   '
        walk(child, prefix + extension, depth + 1)


print(label)
walk(root)
PY
}

echo "repo: $TARGET_ROOT"

if git -C "$TARGET_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  branch="$(git -C "$TARGET_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo detached)"
  status_count="$(git -C "$TARGET_ROOT" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
  if [[ "$status_count" == "0" ]]; then
    status_summary='clean'
  else
    status_summary="dirty (${status_count} paths)"
  fi
  echo "branch: $branch"
  echo "status: $status_summary"
else
  echo 'branch: n/a'
  echo 'status: n/a'
fi

echo

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

echo 'lattices:'
if [[ ${#owner_roots[@]} -eq 0 ]]; then
  echo '- none found'
else
  for owner_root in "${owner_roots[@]}"; do
    rel_owner="$(rel_path "$owner_root")"
    if [[ "$rel_owner" == '.' ]]; then
      echo '- . -> lat-md/'
    else
      echo "- $rel_owner -> $rel_owner/lat-md/"
    fi
    echo '  files:'
    print_lattice_files "$owner_root"
  done
fi

echo

if [[ "$SHOW_REPO_TREE" == '1' ]]; then
  print_tree "$TARGET_ROOT" 'top-level:' 2
  echo
fi

if [[ "$SHOW_REPO_TREE" == '1' && "$VERBOSE" == '1' ]]; then
  for owner_root in "${owner_roots[@]}"; do
    rel_owner="$(rel_path "$owner_root")"
    [[ "$rel_owner" == '.' ]] && continue
    print_tree "$owner_root" "owned subtree: $rel_owner" 2
    echo
  done
fi

preferred_check_script() {
  local repo_wrapper="$TARGET_ROOT/check-all-lattices.sh"
  if [[ -x "$repo_wrapper" ]]; then
    printf 'bash %q' "$(rel_path "$repo_wrapper")"
    return 0
  fi
  printf 'bash %q' "$CHECK_SCRIPT"
}

echo 'verify:'
if [[ ${#owner_roots[@]} -eq 0 ]]; then
  echo '- no lattices discovered'
else
  check_cmd_base="$(preferred_check_script)"
  for owner_root in "${owner_roots[@]}"; do
    rel_owner="$(rel_path "$owner_root")"
    printf -- '- %s %q\n' "$check_cmd_base" "$rel_owner"
  done
fi
