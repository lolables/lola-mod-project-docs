#!/usr/bin/env bash
# Tag a release and deploy it. --dry-run prints the plan without tagging or uploading.
set -euo pipefail
source "$(dirname "$0")/../config.sh"
dry_run=0
[ "${1:-}" = "--dry-run" ] && dry_run=1
pages=$("$(dirname "$0")/stats.sh")
[ "$pages" -le "$MAX_PAGES" ] || { echo "release: $pages pages exceeds MAX_PAGES=$MAX_PAGES" >&2; exit 1; }
if [ "$dry_run" -eq 1 ]; then
  echo "would tag and deploy $pages pages"
  exit 0
fi
git tag "release-$(date +%Y%m%d)"
"$(dirname "$0")/deploy.sh" --target production
