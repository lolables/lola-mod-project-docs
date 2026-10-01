#!/usr/bin/env bash
# Fail when a source file lacks an SPDX license header.
set -euo pipefail
status=0
while IFS= read -r f; do
  head -n 3 "$f" | grep -q 'SPDX-License-Identifier:' || { echo "headers: missing SPDX in $f" >&2; status=1; }
done < <(find "${1:-.}" -name '*.sh' -not -path '*/.git/*')
exit "$status"
