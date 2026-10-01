#!/usr/bin/env bash
# Print the number of pages in the site.
set -euo pipefail
find "${1:-docs}" -name '*.md' | wc -l
