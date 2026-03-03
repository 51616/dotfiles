#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
pi-ssh-setup.sh

Set up a dedicated SSH key + server-side session logger for a target host.

Usage:
  pi-ssh-setup.sh --host <ssh-target> --key <key-path> --comment <comment>

Example:
  bash ~/.pi/agent/skills/pi-ssh/scripts/pi-ssh-setup.sh \
    --host internal-webserver-001 \
    --key ~/.ssh/pi_internal_webserver_001_ed25519 \
    --comment pi-internal-webserver-001

Notes:
- You must already be able to SSH to --host (bootstrap access).
- This updates (and backs up) ~/.ssh/authorized_keys on the remote.
- Only the provided key (matching --comment/pubkey) gets forced-logged.
USAGE
}

HOST=""
KEY=""
COMMENT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) HOST="$2"; shift 2;;
    --key) KEY="$2"; shift 2;;
    --comment) COMMENT="$2"; shift 2;;
    -h|--help) usage; exit 0;;
    *) echo "Unknown arg: $1" >&2; usage; exit 2;;
  esac
done

if [[ -z "$HOST" || -z "$KEY" || -z "$COMMENT" ]]; then
  echo "Missing required args." >&2
  usage
  exit 2
fi

KEY=${KEY/#\~/$HOME}

if [[ ! -f "$KEY" || ! -f "$KEY.pub" ]]; then
  echo "Generating key: $KEY" >&2
  if [[ -e "$KEY" || -e "$KEY.pub" ]]; then
    echo "Refusing to overwrite existing partial key files at $KEY" >&2
    exit 1
  fi
  mkdir -p "$(dirname "$KEY")"
  ssh-keygen -t ed25519 -f "$KEY" -C "$COMMENT" -N "" >/dev/null
fi

chmod 600 "$KEY"
chmod 644 "$KEY.pub"

# base64 encode pubkey (GNU: base64 -w0; BSD: no -w)
if base64 --help 2>/dev/null | grep -q -- "-w"; then
  PUB_B64=$(base64 -w0 "$KEY.pub")
else
  PUB_B64=$(base64 < "$KEY.pub" | tr -d '\n')
fi

# Install/update the remote logger + authorized_keys line.
# Note: SSH does NOT forward local env vars to the remote by default, so we inject
# PUB_B64/COMMENT by setting them in the remote command line.
COMMENT_ESC=${COMMENT//\'/\'"\'"\'}
ssh -o BatchMode=yes -o ConnectTimeout=20 "$HOST" "PUB_B64='$PUB_B64' COMMENT='$COMMENT_ESC' bash -s" <<'EOS'
set -euo pipefail

PUB_B64="${PUB_B64:?missing PUB_B64}"
COMMENT="${COMMENT:?missing COMMENT}"

# base64 decode (GNU base64 uses -d; BSD uses -D)
if base64 --help 2>/dev/null | grep -q -- "-d"; then
  PUBKEY="$(printf '%s' "$PUB_B64" | base64 -d)"
else
  PUBKEY="$(printf '%s' "$PUB_B64" | base64 -D)"
fi

USER_HOME="$HOME"
LOGGER="$USER_HOME/bin/pi-ssh-logger"
LOG_DIR="$USER_HOME/ssh-session-logs/pi"

mkdir -p "$USER_HOME/bin" "$LOG_DIR" "$USER_HOME/.ssh"
chmod 700 "$USER_HOME/bin" "$USER_HOME/ssh-session-logs" "$LOG_DIR" "$USER_HOME/.ssh" 2>/dev/null || true

# Install/update the logger.
cat > "$LOGGER" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

# If scp/sftp/rsync is using this key, don't wrap it (or you'll corrupt the protocol).
# Also: do not print anything in this mode.
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

# Unique, sortable filename.
ts="$(date +%F_%H-%M-%S)"
remote_ip="${SSH_CONNECTION%% *}"
remote_ip="${remote_ip//:/_}"

log="$LOG_DIR/${ts}_${remote_ip}_pid$$.log"

: > "$log"
chmod 600 "$log" 2>/dev/null || true

echo "[pi-ssh-logger] logging to: $log" >&2

if [[ -n "${SSH_ORIGINAL_COMMAND:-}" ]]; then
  exec /usr/bin/script -q -f "$log" -c "$SSH_ORIGINAL_COMMAND"
else
  exec /usr/bin/script -q -f "$log" -c "bash -l"
fi
EOF
chmod 700 "$LOGGER"

# Ensure authorized_keys exists.
AUTH_KEYS="$USER_HOME/.ssh/authorized_keys"
touch "$AUTH_KEYS"
chmod 600 "$AUTH_KEYS" 2>/dev/null || true

# Backup before editing.
ts="$(date +%F_%H-%M-%S)"
cp "$AUTH_KEYS" "$AUTH_KEYS.bak.$ts"

# Remove any prior line containing this comment or pubkey.
TMP="$AUTH_KEYS.tmp.$ts"
( grep -vF "$COMMENT" "$AUTH_KEYS" | grep -vF "$PUBKEY" ) > "$TMP" || true

# Append the restricted forced-command line.
printf '%s\n' "command=\"$LOGGER\",no-agent-forwarding,no-X11-forwarding $PUBKEY" >> "$TMP"

mv "$TMP" "$AUTH_KEYS"
chmod 600 "$AUTH_KEYS" 2>/dev/null || true

# Sanity checks.
command -v script >/dev/null

echo "pi-ssh-setup: installed logger=$LOGGER" >&2
EOS

# Reconnect once with the new key to confirm it works and to print the log path.
ssh -tt -o BatchMode=yes -o IdentitiesOnly=yes -o IdentityFile="$KEY" -o ConnectTimeout=20 "$HOST" \
  'echo "pi-ssh-setup: connected as $(whoami) on $(hostname)"; exit' 2>&1 | tr -d '\r'
