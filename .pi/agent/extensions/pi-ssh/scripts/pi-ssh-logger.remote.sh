#!/usr/bin/env bash
set -euo pipefail

# If scp/sftp/rsync is using this key, don't wrap it or you'll corrupt the protocol.
if [[ -n "${SSH_ORIGINAL_COMMAND:-}" ]]; then
  case "$SSH_ORIGINAL_COMMAND" in
    scp\ *|sftp\ *|internal-sftp\ *|internal-sftp|rsync\ *|*sftp-server*)
      exec $SSH_ORIGINAL_COMMAND
      ;;
  esac
fi

umask 077

LOG_DIR="$HOME/ssh-session-logs/pi"
mkdir -p "$LOG_DIR"
chmod 700 "$LOG_DIR" 2>/dev/null || true

ts="$(date +%F_%H-%M-%S)"
remote_ip="${SSH_CONNECTION%% *}"
remote_ip="${remote_ip//:/_}"
log="$LOG_DIR/${ts}_${remote_ip}_pid$$.log"

: > "$log"
chmod 600 "$log" 2>/dev/null || true

echo "[pi-ssh-logger] logging to: $log" >&2

if [[ -n "${SSH_ORIGINAL_COMMAND:-}" ]]; then
  printf '[pi-ssh-logger] command: %s\n' "$SSH_ORIGINAL_COMMAND" >> "$log"

  tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/pi-ssh-logger.XXXXXX")"
  stdout_fifo="$tmp_dir/stdout"
  stderr_fifo="$tmp_dir/stderr"
  cleanup() {
    rm -rf "$tmp_dir"
  }
  trap cleanup EXIT

  mkfifo "$stdout_fifo" "$stderr_fifo"
  tee -a "$log" < "$stdout_fifo" &
  stdout_tee_pid=$!
  tee -a "$log" < "$stderr_fifo" >&2 &
  stderr_tee_pid=$!

  set +e
  "${SHELL:-/bin/bash}" -c "$SSH_ORIGINAL_COMMAND" > "$stdout_fifo" 2> "$stderr_fifo"
  exit_code=$?
  set -e

  wait "$stdout_tee_pid"
  wait "$stderr_tee_pid"
  exit "$exit_code"
fi

exec /usr/bin/script -q -f -e "$log" -c "${SHELL:-/bin/bash} -l"
