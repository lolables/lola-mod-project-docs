---
description: Lint every mermaid diagram in the project — syntax, house-style header, palette, contrast
argument-hint: "[paths...]"
---

# /diagram-test

Validate mermaid diagrams. Walks the project (or the given paths) and runs
the lint checks documented in the docs-organization skill's mermaid
house-style reference.

## User-provided arguments

> $ARGUMENTS

## Instructions

### Activate the docs-organization skill

Invoke the `docs-organization` skill via your host's Skill tool. The skill's
`SKILL.md` defines `$SKILL_DIR` as the directory the host loaded it from
(`SKILL_DIR=$(dirname "$(realpath <loaded-skill-md>)")`). Reuse `$SKILL_DIR`
for every `scripts/...` and `reference/...` reference below — do not
hardcode `.claude/skills/...` or search candidate paths.

### Steps

1. Read `$SKILL_DIR/SKILL.md` for the invariants and principles this skill enforces. The procedure below is the source of truth for what to do.
2. Determine targets:
   - If `$ARGUMENTS` is non-empty, use those paths.
   - Otherwise, build the list from the git index, not a raw directory
     walk — a raw walk of `docs/` sweeps in gitignored content
     (`docs/superpowers/`) and fails outright when `README.md` doesn't
     exist yet. If the project is not a git repository, see Stop
     conditions below instead of guessing. Inside a git repo:
     1. Run `git -c core.quotePath=false ls-files --cached --others
        --exclude-standard` (tracked plus untracked-not-ignored;
        `core.quotePath=false` keeps non-ASCII names unquoted so they
        match below), and drop any path that no longer exists on disk
        (a deleted-but-tracked file would make the linter exit 2).
     2. Keep paths equal to `README.md`, or starting with `docs/`, that
        end in `.md` or `.mmd`.
     3. Drop anything starting with `docs/superpowers/` or with a
        dot-directory path component (`.git/`, `.claude/`, etc.).
     This naturally includes `README.md` only when it's actually
     present — nothing else to special-case there.
3. Run `node "$SKILL_DIR/scripts/lint-mermaid.mjs" --json <targets>`. The
   `--json` flag returns structured output for parsing; without it, the
   script emits a human-readable text report (useful when the user is
   running the script directly, but harder to parse here).
4. Parse the JSON output. Render findings to the user grouped by file,
   showing the rule code, message, and the finding's `line` (1-based in
   the file, fenced `.md` blocks included).
5. **Do not auto-fix.** Suggest /docs-update, which fixes each finding as
   follows:
   - `MISSING_HOUSE_STYLE_HEADER`: prepends a palette init header.
   - `LEGACY_HOUSE_STYLE_HEADER`, and `LOW_CONTRAST_*` on a `sysA`…`sysF`
     `classDef`: re-applies the diagram's palette with
     `swap-palette.sh <palette> <file>` — for a fenced block in a `.md`,
     `swap-palette.sh --block <block> <palette> <file>` (`<block>` is the
     `block` field from `lint-mermaid --json`), which changes only that
     fence. Output goes to `<file>.new`, then moves over
     `<file>`.
   - `UNAPPROVED_CLASSNAME`, `UNAPPROVED_STYLE`, and `LOW_CONTRAST_*` on a
     `style` statement or `classDef "edgeLabel"`: a judgment call — map the
     node to an approved class, or repair by hand per
     `$SKILL_DIR/reference/mermaid-house-style.md` **Repairing a palette
     by hand**.
   - `SYNTAX_ERROR`, `INLINE_CLASS_NOT_SUPPORTED`: a manual fix per the
     same file's **Syntax constraints**.

### Optional rendering

If the user asks for visual proof (e.g., "render and show me these
diagrams"), use `mmdc` (the mermaid CLI) to produce PNGs. **Always pass
`--cssFile "$SKILL_DIR/reference/palettes/er-overrides.css"`** — this CSS
overrides mermaid's hardcoded `rgba(0,0,0,0.5)` label background that
otherwise makes ER edge labels invisible on dark page backgrounds. Render
against both `white` and `#1e1e1e` for any palette except Parchment
(light-bg only):

```bash
mmdc -i <file>.mmd -o <file>.light.png -b white --cssFile "$SKILL_DIR/reference/palettes/er-overrides.css"
mmdc -i <file>.mmd -o <file>.dark.png  -b "#1e1e1e" --cssFile "$SKILL_DIR/reference/palettes/er-overrides.css"
```

The four palette JSONs live at `$SKILL_DIR/reference/palettes/{solar,
federation,citrus,parchment}.json` for reference.

## Stop conditions

- If `$ARGUMENTS` is empty and the project is not a git repository: warn
  that the default scope can't be determined without git and stop — ask
  the user to pass explicit paths instead of falling back to a raw
  directory walk, which would include ignored content.
- Exit 1 means findings (warnings alone are enough); render them as above.
  Group by `severity` when the user wants blockers first.
- If the script exits 2 (internal error): surface the error.
