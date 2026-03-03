#!/usr/bin/env bash
set -euo pipefail

ROOT="."
DESC=""
TYPE="feature"

usage() {
  cat <<'EOF'
Usage: new-track.sh --desc "<description>" [--type feature|bug|chore|refactor] [--root <path>]

Creates a new Conductor-style track:
  conductor/tracks/<track_id>/{spec.md,plan.md,resume.md,metadata.json,index.md}
And appends an entry to:
  conductor/tracks.md

Track id format (default): <slug>_YYYYMMDD
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --root)
      ROOT="${2:-}"; shift 2 ;;
    --desc)
      DESC="${2:-}"; shift 2 ;;
    --type)
      TYPE="${2:-}"; shift 2 ;;
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

[[ -n "$DESC" ]] || usage_die "--desc is required"

ROOT="$(cd -- "$ROOT" >/dev/null 2>&1 && pwd)" || usage_die "root not found: $ROOT"

if [[ ! -d "$ROOT/conductor/tracks" ]]; then
  usage_die "missing $ROOT/conductor/tracks (run setup.sh first)"
fi

slug="$(slugify "$DESC")"
datepart="$(date +%Y%m%d)"
track_id="${slug}_${datepart}"
track_dir="$ROOT/conductor/tracks/$track_id"

if [[ -e "$track_dir" ]]; then
  usage_die "track already exists: conductor/tracks/$track_id"
fi

mkdir -p "$track_dir"

TDIR="$(templates_dir)"

render_tpl() {
  local src="$1"
  local dst="$2"
  local desc_esc
  local id_esc
  desc_esc="$(escape_sed_repl "$DESC")"
  id_esc="$(escape_sed_repl "$track_id")"

  sed -e "s/<track_description>/${desc_esc}/g" -e "s/<track_id>/${id_esc}/g" "$src" > "$dst"
}

render_tpl "$TDIR/track/spec.md" "$track_dir/spec.md"
render_tpl "$TDIR/track/plan.md" "$track_dir/plan.md"
render_tpl "$TDIR/track/resume.md" "$track_dir/resume.md"

now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
cat >"$track_dir/metadata.json" <<EOF
{
  "track_id": "${track_id}",
  "type": "${TYPE}",
  "status": "new",
  "created_at": "${now}",
  "updated_at": "${now}",
  "description": "${DESC}"
}
EOF

cat >"$track_dir/index.md" <<EOF
# Track ${track_id} Context

- [Resume (start here when resuming)](./resume.md)
- [Specification](./spec.md)
- [Implementation Plan](./plan.md)
- [Metadata](./metadata.json)
EOF

tracks_file="$ROOT/conductor/tracks.md"

if [[ ! -f "$tracks_file" ]]; then
  mkdir -p "$(dirname -- "$tracks_file")"
  cp "$TDIR/tracks.md" "$tracks_file"
fi

# Append entry.
cat >>"$tracks_file" <<EOF

---

- [ ] **Track: ${DESC}**
  *Link: [./tracks/${track_id}/](./tracks/${track_id}/)*
EOF

echo "ok: created track ${track_id}"
