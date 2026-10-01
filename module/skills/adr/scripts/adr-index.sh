#!/usr/bin/env bash
set -euo pipefail

# Regenerates the ADR index at <adr-dir>/index.md.
# Usage: adr-index.sh <adr-dir>

dir="${1:-}"
if [ -z "$dir" ] || [ ! -d "$dir" ]; then
  echo "usage: adr-index.sh <adr-dir>" >&2
  exit 2
fi

out="$dir/index.md"

read_field() {
  local file="$1" field="$2"
  awk -v key="$field:" '
    /^---/ { if (in_fm) exit; in_fm=1; next }
    in_fm {
      if ($1 == key) {
        sub(/^[^:]+:[[:space:]]*/, "")
        print
        exit
      }
    }
  ' "$file"
}

read_title() {
  local file="$1"
  awk '
    /^---/ { if (in_fm) { in_fm=0; next }; in_fm=1; next }
    !in_fm && /^# / {
      sub(/^# /, "")
      print
      exit
    }
  ' "$file"
}

# Make a front-matter or heading value safe as a markdown table cell: drop a
# CRLF file's trailing \r (awk's default record separator is \n, so a CRLF
# line leaves \r stuck to the last field), strip one matching pair of
# surrounding quotes from a quoted YAML scalar (`status: "accepted"`), then
# escape any literal `|` so it can't be read as a column separator.
sanitize_cell() {
  local val="$1"
  val="${val%$'\r'}"
  local len=${#val}
  if [ "$len" -ge 2 ]; then
    local first="${val:0:1}" last="${val: -1}"
    if { [ "$first" = '"' ] && [ "$last" = '"' ]; } || { [ "$first" = "'" ] && [ "$last" = "'" ]; }; then
      val="${val:1:len-2}"
    fi
  fi
  printf '%s' "${val//|/\\|}"
}

# Percent-encode spaces in a link target so a filename containing one
# produces a valid markdown link destination (CommonMark forbids a literal
# space in an unbracketed destination) that check-refs.mjs's decodeTarget()
# resolves back to the real file.
encode_link_target() {
  printf '%s' "${1// /%20}"
}

shopt -s nullglob
adr_glob=("$dir"/[0-9][0-9][0-9][0-9]-*.md)
shopt -u nullglob
mapfile -t files < <(printf "%s\n" "${adr_glob[@]}" | sort)

if [ "${#adr_glob[@]}" -eq 0 ]; then
  cat > "$out" <<'INDEX_EOF'
# Architectural Decision Records

No ADRs yet. Use /adr-new to create one.
INDEX_EOF
  exit 0
fi

{
  echo "# Architectural Decision Records"
  echo ""
  echo "| ID | Title | Status | Date |"
  echo "|----|-------|--------|------|"
  for f in "${files[@]}"; do
    base=$(basename "$f")
    id="${base:0:4}"
    title=$(sanitize_cell "$(read_title "$f")")
    [ -z "$title" ] && title="(no title)"
    status=$(sanitize_cell "$(read_field "$f" status)")
    [ -z "$status" ] && status="unknown"
    date=$(sanitize_cell "$(read_field "$f" date)")
    [ -z "$date" ] && date="unknown"
    link=$(encode_link_target "$base")
    echo "| [$id]($link) | $title | $status | $date |"
  done
} > "$out"
