#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
init-skill.sh

Create a new skill folder using the skill-authoring templates.

By default this prefers the shared skill location (~/.pi/agent/skills) and then
creates a symlink in the current vault at $PI_VAULT_ROOT/.pi/skills/<skill-name>
(when PI_VAULT_ROOT is set).

Usage:
  init-skill.sh <skill-name> [options]

Options:
  --shared                 Create under ~/.pi/agent/skills (shared across vaults)
  --vault                  Create directly under $PI_VAULT_ROOT/.pi/skills (local)
  --shared-root <path>     Override shared skills root (default: ~/.pi/agent/skills)
  --vault-root <path>      Override vault root (default: $PI_VAULT_ROOT or git root)
  --no-link                Do not create the vault symlink
  -h, --help               Show help

Examples:
  bash scripts/init-skill.sh my-new-skill
  bash scripts/init-skill.sh my-new-skill --shared
  bash scripts/init-skill.sh my-new-skill --vault

Notes:
- Skill names should be hyphen-case.
- This creates: SKILL.md, templates/, examples/, scripts/.
- Replace generated __FILL_ME__ markers before using the skill.
- Run validation afterwards:
    python scripts/quick_validate.py <skill-dir>
USAGE
}

NAME=""
MODE="auto" # auto|shared|vault
NO_LINK=0
SHARED_ROOT="${HOME}/.pi/agent/skills"
VAULT_ROOT="${PI_VAULT_ROOT:-}"

if [[ $# -lt 1 ]]; then
  usage
  exit 2
fi

NAME="$1"
shift

while [[ $# -gt 0 ]]; do
  case "$1" in
    --shared) MODE="shared"; shift;;
    --vault) MODE="vault"; shift;;
    --no-link) NO_LINK=1; shift;;
    --shared-root) SHARED_ROOT="$2"; shift 2;;
    --vault-root) VAULT_ROOT="$2"; shift 2;;
    -h|--help) usage; exit 0;;
    *) echo "Unknown arg: $1" >&2; usage; exit 2;;
  esac
done

if [[ ! "$NAME" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]]; then
  echo "Skill name must be hyphen-case without leading/trailing/doubled hyphens: $NAME" >&2
  exit 2
fi

# Best-effort vault root detection if not explicitly provided.
if [[ -z "${VAULT_ROOT}" ]]; then
  if git_root=$(git rev-parse --show-toplevel 2>/dev/null); then
    VAULT_ROOT="$git_root"
  fi
fi

SCRIPT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE_DIR="$(cd -- "${SCRIPT_DIR}/../templates" && pwd)"

choose_out_dir() {
  local mode="$1"

  if [[ "$mode" == "shared" ]]; then
    echo "${SHARED_ROOT}/${NAME}"
    return 0
  fi

  if [[ "$mode" == "vault" ]]; then
    if [[ -z "${VAULT_ROOT}" ]]; then
      echo "--vault requires PI_VAULT_ROOT or --vault-root" >&2
      return 2
    fi
    echo "${VAULT_ROOT}/.pi/skills/${NAME}"
    return 0
  fi

  # auto
  if [[ -d "${SHARED_ROOT}" && -w "${SHARED_ROOT}" ]]; then
    echo "${SHARED_ROOT}/${NAME}"
    return 0
  fi
  if [[ -n "${VAULT_ROOT}" && -d "${VAULT_ROOT}/.pi/skills" && -w "${VAULT_ROOT}/.pi/skills" ]]; then
    echo "${VAULT_ROOT}/.pi/skills/${NAME}"
    return 0
  fi

  echo "Could not determine output dir. Try: --shared or --vault-root <path> --vault" >&2
  return 2
}

SKILL_DIR="$(choose_out_dir "$MODE")" || exit $?

if [[ -e "$SKILL_DIR" ]]; then
  echo "Refusing to overwrite existing path: $SKILL_DIR" >&2
  exit 1
fi

mkdir -p "$SKILL_DIR" "$SKILL_DIR/templates" "$SKILL_DIR/examples" "$SKILL_DIR/scripts"

python "${SCRIPT_DIR}/render_skill_template.py" \
  --template "${TEMPLATE_DIR}/SKILL.md.template" \
  --output "${SKILL_DIR}/SKILL.md" \
  --name "${NAME}"

chmod 644 "$SKILL_DIR/SKILL.md" 2>/dev/null || true

LINK_PATH=""
LINK_STATUS="none"
if [[ "$NO_LINK" -eq 0 && -n "${VAULT_ROOT}" && -d "${VAULT_ROOT}/.pi/skills" ]]; then
  LINK_PATH="${VAULT_ROOT}/.pi/skills/${NAME}"

  if [[ "${SKILL_DIR}" == "${LINK_PATH}" ]]; then
    LINK_STATUS="direct"
  elif [[ -e "${LINK_PATH}" || -L "${LINK_PATH}" ]]; then
    LINK_STATUS="existing"
  else
    ln -s "${SKILL_DIR}" "${LINK_PATH}"
    LINK_STATUS="created"
  fi
fi

cat <<MSG
Created skill:
  ${SKILL_DIR}

Next:
  1) Replace __FILL_ME__ markers in ${SKILL_DIR}/SKILL.md
  2) python "${SCRIPT_DIR}/quick_validate.py" "${SKILL_DIR}"
MSG

case "$LINK_STATUS" in
  created)
    echo "Vault symlink created:"
    echo "  ${LINK_PATH}"
    ;;
  existing)
    echo "Vault path already exists, not touched:"
    echo "  ${LINK_PATH}"
    ;;
  direct)
    echo "Vault skill:"
    echo "  ${LINK_PATH}"
    ;;
esac
