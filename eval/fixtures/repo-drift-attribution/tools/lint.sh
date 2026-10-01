#!/usr/bin/env bash
# Fail on trailing whitespace in Markdown files.
set -euo pipefail
if grep -rnE '[[:space:]]+$' --include='*.md' "${1:-.}"; then
  echo "lint: trailing whitespace found" >&2
  exit 1
fi
