#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
pi-ssh-readlog.sh

Helpers for listing/reading/copying pi SSH session logs on a host.

Usage:
  pi-ssh-readlog.sh --host <ssh-target> --ls
  pi-ssh-readlog.sh --host <ssh-target> --latest
  pi-ssh-readlog.sh --host <ssh-target> --cat <remote-log-filename>
  pi-ssh-readlog.sh --host <ssh-target> --copy-latest <local-path>

Notes:
- Logs live at: ~/ssh-session-logs/pi/
- Any ssh-based read will itself create a new log entry (expected).
USAGE
}

HOST=""
MODE=""
ARG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) HOST="$2"; shift 2;;
    --ls|--latest) MODE="$1"; shift;;
    --cat|--copy-latest) MODE="$1"; ARG="$2"; shift 2;;
    -h|--help) usage; exit 0;;
    *) echo "Unknown arg: $1" >&2; usage; exit 2;;
  esac
done

if [[ -z "$HOST" || -z "$MODE" ]]; then
  echo "Missing required args." >&2
  usage
  exit 2
fi

case "$MODE" in
  --ls)
    ssh -o BatchMode=yes -o ConnectTimeout=20 "$HOST" 'ls -1t ~/ssh-session-logs/pi 2>/dev/null | head -n 30'
    ;;

  --latest)
    ssh -o BatchMode=yes -o ConnectTimeout=20 "$HOST" 'set -euo pipefail; f=$(ls -1t ~/ssh-session-logs/pi | head -n 1); echo "FILE=$f"; echo "---"; sed -n "1,200p" ~/ssh-session-logs/pi/$f'
    ;;

  --cat)
    if [[ -z "$ARG" ]]; then
      echo "--cat requires a remote filename" >&2
      exit 2
    fi
    ssh -o BatchMode=yes -o ConnectTimeout=20 "$HOST" "sed -n '1,200p' ~/ssh-session-logs/pi/$ARG"
    ;;

  --copy-latest)
    if [[ -z "$ARG" ]]; then
      echo "--copy-latest requires a local destination path" >&2
      exit 2
    fi
    REMOTE_FILE=$(ssh -o BatchMode=yes -o ConnectTimeout=20 "$HOST" 'set -euo pipefail; ls -1t ~/ssh-session-logs/pi | head -n 1')
    echo "remote=$REMOTE_FILE" >&2
    # -O makes scp use the legacy protocol, which is more robust under forced-command setups.
    scp -O -q -o BatchMode=yes -o ConnectTimeout=20 "$HOST":~/ssh-session-logs/pi/"$REMOTE_FILE" "$ARG"
    echo "copied_to=$ARG" >&2
    ;;

  *)
    echo "Unknown mode: $MODE" >&2
    usage
    exit 2
    ;;
esac
