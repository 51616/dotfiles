#!/usr/bin/env bash
set -euo pipefail

# If a real scp/sftp/rsync server is using this key, don't wrap it or the
# logger will corrupt its binary protocol. Match a fixed executable and its
# server-mode grammar; substring matching here would be a general audit bypass.
if [[ -n "${SSH_ORIGINAL_COMMAND:-}" ]]; then
  read -r -a transfer_argv <<< "$SSH_ORIGINAL_COMMAND"
  transfer_kind=""
  transfer_executable=""
  case "${transfer_argv[0]:-}" in
    scp|/usr/bin/scp|/bin/scp)
      transfer_kind="scp"
      for candidate in /usr/bin/scp /bin/scp; do
        if [[ -x "$candidate" ]]; then transfer_executable="$candidate"; break; fi
      done
      ;;
    rsync|/usr/bin/rsync|/bin/rsync)
      transfer_kind="rsync"
      for candidate in /usr/bin/rsync /bin/rsync; do
        if [[ -x "$candidate" ]]; then transfer_executable="$candidate"; break; fi
      done
      ;;
    sftp-server|internal-sftp|/usr/lib/openssh/sftp-server|/usr/lib/ssh/sftp-server|/usr/libexec/openssh/sftp-server|/usr/libexec/sftp-server)
      transfer_kind="sftp"
      for candidate in /usr/lib/openssh/sftp-server /usr/lib/ssh/sftp-server /usr/libexec/openssh/sftp-server /usr/libexec/sftp-server; do
        if [[ -x "$candidate" ]]; then transfer_executable="$candidate"; break; fi
      done
      ;;
  esac

  transfer_server_mode=0
  if [[ "$transfer_kind" == "sftp" && -n "$transfer_executable" ]]; then
    transfer_server_mode=1
  elif [[ "$transfer_kind" == "scp" && -n "$transfer_executable" ]]; then
    scp_mode_count=0
    scp_operand_count=0
    scp_options_done=0
    scp_after_separator=0
    scp_argv_valid=1
    for argument in "${transfer_argv[@]:1}"; do
      if [[ "$scp_options_done" == "1" ]]; then
        if [[ "$scp_after_separator" != "1" && "$argument" == -* ]]; then scp_argv_valid=0; fi
        scp_operand_count=$((scp_operand_count + 1))
      elif [[ "$argument" == "--" ]]; then
        if [[ "$scp_mode_count" != "1" ]]; then scp_argv_valid=0; fi
        scp_options_done=1
        scp_after_separator=1
      elif [[ "$argument" == -* && "$argument" != "-" ]]; then
        option_characters="${argument#-}"
        if [[ -z "$option_characters" ]]; then scp_argv_valid=0; fi
        for ((index = 0; index < ${#option_characters}; index += 1)); do
          option_character="${option_characters:index:1}"
          case "$option_character" in
            f|t) scp_mode_count=$((scp_mode_count + 1)) ;;
            d|p|q|r|v) ;;
            *) scp_argv_valid=0 ;;
          esac
        done
      else
        scp_options_done=1
        scp_operand_count=$((scp_operand_count + 1))
      fi
    done
    if [[ "$scp_argv_valid" == "1" && "$scp_mode_count" == "1" && "$scp_operand_count" -ge 1 ]]; then
      transfer_server_mode=1
    fi
  elif [[ "$transfer_kind" == "rsync" && -n "$transfer_executable" && "${transfer_argv[1]:-}" == "--server" ]]; then
    rsync_argv_valid=1
    rsync_seen_path_separator=0
    rsync_path_count=0
    rsync_secluded_args=0
    for argument in "${transfer_argv[@]:2}"; do
      if [[ "$rsync_seen_path_separator" == "1" ]]; then
        rsync_path_count=$((rsync_path_count + 1))
      elif [[ "$argument" == "." ]]; then
        rsync_seen_path_separator=1
      else
        case "$argument" in
          -e*|--rsh|--rsh=*|--rsync-path|--rsync-path=*|--server|--|-[^-]*/*) rsync_argv_valid=0 ;;
          --sender|--*) ;;
          -*)
            if [[ "$argument" == *e* ]]; then
              without_protocol_e="${argument/e./}"
              if [[ "$without_protocol_e" == "$argument" || "$without_protocol_e" == *e* ]]; then
                rsync_argv_valid=0
              elif [[ "${argument%%e.*}" == *s* ]]; then
                rsync_secluded_args=1
              fi
            fi
            ;;
          *) rsync_argv_valid=0 ;;
        esac
      fi
    done
    if [[ "$rsync_argv_valid" == "1" ]]; then
      if [[ "$rsync_seen_path_separator" == "1" && "$rsync_path_count" -ge 1 ]]; then
        transfer_server_mode=1
      elif [[ "$rsync_seen_path_separator" == "0" && "$rsync_path_count" == "0" && "$rsync_secluded_args" == "1" ]]; then
        # With -s/--secluded-args rsync sends path arguments over its binary
        # protocol, so a valid server command intentionally has no `.`/path argv.
        transfer_server_mode=1
      fi
    fi
  fi

  if [[ "$transfer_server_mode" == "1" ]]; then
    transfer_argv[0]="$transfer_executable"
    exec "${transfer_argv[@]}"
  fi
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

# The persistent file worker carries framed file bytes on stdout. Logging that
# stream would both duplicate private file contents onto NFS and corrupt binary
# frames if the logger ever transformed them. Keep stdout direct, and retain
# only the worker's structured stderr metrics.
file_worker_prefix='PI_SSH_FILE_WORKER_PROTOCOL=1; export PI_SSH_FILE_WORKER_PROTOCOL; '
expected_file_worker_command_sha256='__PI_SSH_FILE_WORKER_COMMAND_SHA256__'
if [[ "${SSH_ORIGINAL_COMMAND:-}" == "$file_worker_prefix"* ]]; then
  if ! command -v sha256sum >/dev/null 2>&1; then
    printf '[pi-ssh-logger] rejected file-worker marker: sha256sum is unavailable\n' | tee -a "$log" >&2
    exit 127
  fi
  actual_file_worker_command_sha256=$(printf '%s' "$SSH_ORIGINAL_COMMAND" | sha256sum | awk '{print $1}')
  if [[ ! "$expected_file_worker_command_sha256" =~ ^[0-9a-f]{64}$ || "$actual_file_worker_command_sha256" != "$expected_file_worker_command_sha256" ]]; then
    printf '[pi-ssh-logger] rejected file-worker marker: launcher hash mismatch\n' | tee -a "$log" >&2
    exit 126
  fi

  printf '[pi-ssh-logger] command: pi-ssh-file-worker protocol=1 sha256=%s\n' "$actual_file_worker_command_sha256" >> "$log"

  tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/pi-ssh-logger.XXXXXX")"
  stderr_fifo="$tmp_dir/stderr"
  cleanup() {
    rm -rf "$tmp_dir"
  }
  trap cleanup EXIT

  mkfifo "$stderr_fifo"
  tee -a "$log" < "$stderr_fifo" >&2 &
  stderr_tee_pid=$!

  set +e
  "${SHELL:-/bin/bash}" -c "$SSH_ORIGINAL_COMMAND" 2> "$stderr_fifo"
  exit_code=$?
  set -e

  wait "$stderr_tee_pid"
  exit "$exit_code"
fi

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
