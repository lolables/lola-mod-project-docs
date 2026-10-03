#!/usr/bin/env bash
# Swap the palette on an existing diagram and print the result to stdout.
# Strips the current init header and the palette's own classDef lines, then
# re-applies the named palette via apply-palette.mjs.
#
# A doc file (any format formats/index.mjs registers) is swapped in place:
# every mermaid diagram — numbered the same way lint-mermaid does (or only
# --block N, the 1-based `block` field of a lint-mermaid --json finding) —
# gets the new palette and every byte outside those diagrams is left
# untouched. Any other file is taken as one whole diagram (.mmd).
#
# Usage: swap-palette.sh [--block N] <palette-name> <path/to/diagram.mmd|doc>
# Refusals (unknown palette, bad --block, no diagram body, an indented or
# nested block) print a reason on stderr and exit 2 with nothing on stdout.
set -euo pipefail

USAGE="usage: swap-palette.sh [--block N] <palette-name> <path/to/diagram.mmd|doc>"

# Unset (not empty) means "every diagram"; `--block ""` must still be refused.
unset BLOCK
while [[ $# -gt 0 && "$1" == --* ]]; do
  case "$1" in
    --block)
      if [[ $# -lt 2 ]]; then
        echo "$USAGE" >&2
        exit 2
      fi
      BLOCK="$2"
      shift 2
      ;;
    *)
      echo "unknown option: $1 — $USAGE" >&2
      exit 2
      ;;
  esac
done
if [[ $# -ne 2 ]]; then
  echo "$USAGE" >&2
  exit 2
fi
PALETTE="$1"
INPUT="$2"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PALETTE_DIR="$SCRIPT_DIR/../reference/palettes"
PALETTE_JSON="$PALETTE_DIR/${PALETTE}.json"

if [[ ! -f "$PALETTE_JSON" ]]; then
  AVAILABLE=()
  for p in "$PALETTE_DIR"/*.json; do
    [[ -e "$p" ]] || continue
    AVAILABLE+=("$(basename "$p" .json)")
  done
  echo "unknown palette: $PALETTE — available: $(IFS=,; echo "${AVAILABLE[*]}")" >&2
  exit 2
fi
if [[ ! -f "$INPUT" ]]; then
  echo "file not found: $INPUT" >&2
  exit 2
fi

SWAP_ARGS=(--swap "$PALETTE_JSON" "$INPUT")
if [[ -n "${BLOCK+set}" ]]; then
  if [[ ! "$BLOCK" =~ ^[1-9][0-9]*$ ]]; then
    echo "--block needs a positive integer (1 = first mermaid diagram), got: $BLOCK" >&2
    exit 2
  fi
  SWAP_ARGS+=("$BLOCK")
fi
node "$SCRIPT_DIR/apply-palette.mjs" "${SWAP_ARGS[@]}"
