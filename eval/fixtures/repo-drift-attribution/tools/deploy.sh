#!/usr/bin/env bash
# Upload the built site to a named target.
set -euo pipefail
target=""
while [ $# -gt 0 ]; do
  case "$1" in
    --target) target="$2"; shift 2 ;;
    *) echo "deploy: unknown option: $1" >&2; exit 2 ;;
  esac
done
[ -n "$target" ] || { echo "deploy: --target is required" >&2; exit 2; }
echo "uploading to $target"
