#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
pi-ssh-logger-setup.sh

Install or repair the remote forced-command logger used by *-pi-agent SSH aliases.

Usage:
  pi-ssh-logger-setup.sh --host <ssh-target> [--remote-bin <path>] [--no-verify]

Options:
  --host <ssh-target>   SSH target to update, for example gcp_slurm_sakana_eu-pi-agent
  --remote-bin <path>   Remote absolute path for the logger script
                        default: ~/bin/pi-ssh-logger
  --no-verify           Skip post-install behavior checks
  -h, --help            Show this help

What it does:
  1) uploads scripts/pi-ssh-logger.remote.sh
  2) backs up the current remote logger beside it with a timestamp suffix
  3) installs the new logger and chmod 700
  4) verifies noninteractive SSH semantics unless --no-verify is set

Verification checks:
  - `ssh <host> "printf %s ok"` must return exit 0 with stdout exactly `ok`
  - `ssh <host> "ls /definitely-missing"` must return nonzero and keep the
    missing-file message on stderr
USAGE
}

HOST=""
REMOTE_BIN='~/bin/pi-ssh-logger'
VERIFY=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host)
      HOST="${2:-}"
      shift 2
      ;;
    --remote-bin)
      REMOTE_BIN="${2:-}"
      shift 2
      ;;
    --no-verify)
      VERIFY=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown arg: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$HOST" ]]; then
  echo "Missing --host" >&2
  usage >&2
  exit 2
fi

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
LOCAL_LOGGER="$SCRIPT_DIR/pi-ssh-logger.remote.sh"
if [[ ! -f "$LOCAL_LOGGER" ]]; then
  echo "Missing local logger template: $LOCAL_LOGGER" >&2
  exit 1
fi

REMOTE_HOME=$(ssh "$HOST" 'printf %s "$HOME"')
if [[ -z "$REMOTE_HOME" || "$REMOTE_HOME" != /* ]]; then
  echo "Failed to resolve remote HOME on $HOST" >&2
  exit 1
fi
if [[ "$REMOTE_BIN" == "~/"* ]]; then
  REMOTE_BIN_PATH="$REMOTE_HOME/${REMOTE_BIN:2}"
elif [[ "$REMOTE_BIN" == /* ]]; then
  REMOTE_BIN_PATH="$REMOTE_BIN"
else
  echo "--remote-bin must be an absolute path or start with ~/ : $REMOTE_BIN" >&2
  exit 2
fi

BACKUP_SUFFIX="$(date +%F_%H-%M-%S)"
REMOTE_TMP_PATH="${REMOTE_BIN_PATH}.new"

echo "==> Creating remote parent dir on $HOST"
ssh "$HOST" "mkdir -p -- \"\$(dirname -- \"$REMOTE_BIN_PATH\")\""

echo "==> Uploading logger template to $HOST:$REMOTE_TMP_PATH"
scp -q -O "$LOCAL_LOGGER" "$HOST:$REMOTE_TMP_PATH"

echo "==> Installing remote logger at $HOST:$REMOTE_BIN_PATH"
ssh "$HOST" "set -euo pipefail; remote_bin=$REMOTE_BIN_PATH; remote_tmp=$REMOTE_TMP_PATH; backup_suffix=$BACKUP_SUFFIX; if [[ -f \"\$remote_bin\" ]]; then cp \"\$remote_bin\" \"\${remote_bin}.bak-\$backup_suffix\"; fi; mv \"\$remote_tmp\" \"\$remote_bin\"; chmod 700 \"\$remote_bin\"; printf 'installed=%s\n' \"\$remote_bin\"; if [[ -f \"\${remote_bin}.bak-\$backup_suffix\" ]]; then printf 'backup=%s\n' \"\${remote_bin}.bak-\$backup_suffix\"; fi"

if [[ "$VERIFY" != "1" ]]; then
  echo "==> Skipping verification (--no-verify)"
  exit 0
fi

ok_out=$(mktemp)
ok_err=$(mktemp)
fail_out=$(mktemp)
fail_err=$(mktemp)
cleanup() {
  rm -f "$ok_out" "$ok_err" "$fail_out" "$fail_err"
}
trap cleanup EXIT

echo "==> Verifying success-path stdout/exit semantics"
if ! ssh "$HOST" "printf %s ok" >"$ok_out" 2>"$ok_err"; then
  echo "Verification failed: success-path command returned nonzero" >&2
  echo "--- stdout ---" >&2
  cat "$ok_out" >&2 || true
  echo "--- stderr ---" >&2
  cat "$ok_err" >&2 || true
  exit 1
fi
if [[ "$(cat "$ok_out")" != "ok" ]]; then
  echo "Verification failed: expected stdout 'ok' from success-path command" >&2
  echo "--- stdout ---" >&2
  cat "$ok_out" >&2 || true
  echo "--- stderr ---" >&2
  cat "$ok_err" >&2 || true
  exit 1
fi

echo "==> Verifying failure-path stderr/exit semantics"
if ssh "$HOST" "ls /definitely-missing" >"$fail_out" 2>"$fail_err"; then
  echo "Verification failed: failure-path command unexpectedly returned exit 0" >&2
  echo "--- stdout ---" >&2
  cat "$fail_out" >&2 || true
  echo "--- stderr ---" >&2
  cat "$fail_err" >&2 || true
  exit 1
fi
if [[ -s "$fail_out" ]]; then
  echo "Verification failed: failure-path command leaked content to stdout" >&2
  echo "--- stdout ---" >&2
  cat "$fail_out" >&2 || true
  echo "--- stderr ---" >&2
  cat "$fail_err" >&2 || true
  exit 1
fi
if ! grep -q 'No such file or directory' "$fail_err"; then
  echo "Verification failed: failure-path stderr did not include the missing-file message" >&2
  echo "--- stdout ---" >&2
  cat "$fail_out" >&2 || true
  echo "--- stderr ---" >&2
  cat "$fail_err" >&2 || true
  exit 1
fi

echo "==> Verification passed"
