#!/usr/bin/env bash
# Round 19 eval: three headless /docs-audit runs over one fixture, sharing one Lane 6 cache.
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
W=/tmp/smoke-cache
rm -rf "$W"; mkdir -p "$W"/{repo,lola,cfg,xdg,docs-discipline}
trap 'rm -rf "$W/cfg"' EXIT
install -m 600 "$HOME/.claude/.credentials.json" "$W/cfg/.credentials.json"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
export GIT_AUTHOR_NAME=smoke GIT_AUTHOR_EMAIL=smoke@invalid GIT_COMMITTER_NAME=smoke GIT_COMMITTER_EMAIL=smoke@invalid
export LOLA_HOME="$W/lola" XDG_CACHE_HOME="$W/xdg"
git -C "$SRC" archive HEAD | tar -x -C "$W/docs-discipline"
node "$SRC/tests/scripts/docs-organization/routing-fixtures.mjs" crosscodex "$W/repo"
cd "$W/repo"
(cd "$W/docs-discipline" && lola mod add -n docs-discipline ./ >/dev/null)
lola install docs-discipline -a claude-code --scope project . >/dev/null
printf '.claude/\n.lola/\n' >> .git/info/exclude
run() {
  local n=$1; local t0=$SECONDS
  CLAUDE_CONFIG_DIR="$W/cfg" claude -p "/docs-audit" --model sonnet --max-budget-usd 15 \
    --dangerously-skip-permissions --output-format stream-json --verbose > "$W/run$n.jsonl" 2> "$W/run$n.err" || echo "run $n exit $?"
  echo "run $n wall $((SECONDS - t0))s"
}
run 1
run 2
DOC=$(git ls-files '*.md' | grep -v '^README.md$' | head -1)
printf '\nThis paragraph was added after the first audit.\n' >> "$DOC"
echo "edited $DOC"
run 3
