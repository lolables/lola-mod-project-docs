#!/usr/bin/env bash
# Normalise Markdown list markers to "-".
set -euo pipefail
find "${1:-.}" -name '*.md' -not -path '*/.git/*' -exec sed -i -E 's/^([[:space:]]*)[*+] /\1- /' {} +
