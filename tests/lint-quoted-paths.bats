setup() { REPO="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"; }

# module/**/*.md prompts tell an LLM to run shell commands such as
# `bash $SKILL_DIR/scripts/check-structure.sh` or (for diagram rendering)
# `mmdc ... --cssFile $SKILL_DIR/reference/palettes/er-overrides.css`.
# $SKILL_DIR / $ADR_DIR are resolved at runtime from an install path that
# can contain a space; unquoted, the shell word-splits it (rc 127 for
# `bash`/`node`/`mmdc`, "Cannot find module" for `node`).
#
# The house convention is to always quote the expansion:
#   bash "$SKILL_DIR/scripts/check-structure.sh"
#   mmdc ... --cssFile "$SKILL_DIR/reference/palettes/er-overrides.css"
#
# This matcher flags any `$SOMETHING_DIR/` that is not directly preceded by a
# double quote, single quote, or backtick. That catches an unquoted expansion
# after any command or flag (bash, node, mmdc, cp, --cssFile, ...), while prose
# that names a path inside a code span (`$SKILL_DIR/SKILL.md`) and quoted
# commands ("$SKILL_DIR/...") never match. Write non-command mentions as code
# spans so they stay out of the matcher.
UNQUOTED_DIR_EXPANSION='(^|[^"`'"'"'])\$[A-Za-z_]+_DIR/'

@test "no unquoted \$..._DIR expansion in shell commands under module/" {
  run grep -rnE "$UNQUOTED_DIR_EXPANSION" "$REPO/module" --include='*.md'
  [ "$status" -eq 1 ]
  [ -z "$output" ]
}
