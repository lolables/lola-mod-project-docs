---
description: Bootstrap or extend project documentation structure (README, docs/, .gitignore)
argument-hint: ""
---

# /docs-init

Scaffold a project's documentation structure following the docs-organization
skill's conventions. Idempotent — safe to run on an existing project; will
not overwrite files that already have content.

## User-provided arguments

> $ARGUMENTS

## Instructions

### Activate the docs-organization skill

Invoke the `docs-organization` skill via your host's Skill tool. The skill's
`SKILL.md` defines `$SKILL_DIR` as the directory the host loaded it from
(`SKILL_DIR=$(dirname "$(realpath <loaded-skill-md>)")`). Reuse `$SKILL_DIR`
for every `scripts/...` and `reference/...` reference below — do not
hardcode `.claude/skills/...` or search candidate paths.

If step 3 or step 4 below will create `docs/dev/README.md` from the
template (the greenfield path, or the existing-project path when
`docs/dev/` is missing), additionally activate the companion `adr` skill
and bind `$ADR_DIR` from its loaded `SKILL.md` location the same way —
`docs/dev/README.md` links `adr/index.md`, and that link must resolve.
Skip the `adr` activation otherwise.

### Steps

1. Read `$SKILL_DIR/SKILL.md` for the invariants and principles this skill enforces. The procedure below is the source of truth for what to do.
2. Detect current state:
   - Does a README exist (any name `node "$SKILL_DIR/scripts/formats/index.mjs" --readmes` prints — `README.md`, `README.adoc`, …)? Is it non-empty?
   - Does `docs/` exist? Is `docs/dev/` populated?
   - Does `.gitignore` contain `docs/superpowers/`?
3. **Greenfield path** (no README, no docs/):
   - Read `$SKILL_DIR/reference/readme-template.md`.
     Write `README.md` using that template, filling project name from the
     repo's directory name and asking the user one question for the
     one-sentence description. Templates are Markdown; an existing README
     in another format (for example `README.adoc`) counts as the README,
     so never add a `README.md` beside it.
   - Read `$SKILL_DIR/reference/docs-tree-template.md`.
     Create `docs/dev/README.md`, `docs/dev/architecture.md`,
     `docs/dev/contributing.md` with their template contents. The
     `architecture.md` template includes a starter mermaid block so authors
     have a visible nudge to keep the diagram current. Do not create
     `docs/usage/` — it appears later when /docs-audit recommends a split.
   - Create `docs/dev/diagrams/` containing a `README.md` with this content:

     ```markdown
     # Diagrams

     `.mmd` files referenced from `docs/dev/*.md`. See the
     docs-organization skill's mermaid house-style reference for when to
     add a diagram and how to style it.
     ```

     Add a diagram when relationships are hard to follow in prose — an
     architecture overview, a state machine, a branching decision. See the
     mermaid house-style reference for when one earns its place.
4. **Existing-project path** (README exists, docs/ may or may not):
   - Read the current README. If it contains substantial usage detail
     (heuristic: more than 200 lines, or sections labeled "Configuration",
     "Advanced usage", "API reference"), ask the user: "Your README is
     dense. Keep it self-sufficient (no migration), or split detailed
     sections into docs/usage/ now?" Wait for the answer before proceeding.
   - If `docs/dev/` is missing, create it from the template.
   - Never overwrite an existing file with non-empty content. If a file
     exists but is empty, the template content is acceptable.
5. **Always:**
   - Append `docs/superpowers/` to `.gitignore` if not present (preserve
     existing entries).
   - If step 3 or step 4 created `docs/dev/README.md` from the template,
     its `adr/index.md` link needs a target: create `docs/dev/adr/` if it
     doesn't already exist, then run
     `bash "$ADR_DIR/scripts/adr-index.sh" docs/dev/adr` to generate the
     index (an empty ADR dir produces the "No ADRs yet" stub — still a
     valid link target).
   - Run `bash "$SKILL_DIR/scripts/check-structure.sh"`
     to verify the structural invariants now hold. Surface any remaining
     findings.
6. **Show what was created, then ask before committing:**
   - List every file created or modified (new files created, existing
     files appended to — e.g. `.gitignore`).
   - Stage those files by name (never `git add .`/`-A`) and show the user
     `git diff --staged`.
   - Ask: "Commit this scaffolding?" On yes, commit with a conventional
     message: `docs: scaffold documentation structure`. On no, or no
     response, leave the changes staged-but-uncommitted and say so —
     do not commit automatically.

## Stop conditions

- If the project is not a git repo: print a warning and exit without
  writing. The skill assumes git is in use.
- If the user declines a destructive prompt (e.g., refuses the README
  split), apply only the non-destructive changes (.gitignore, missing
  docs/dev/ files).
- If the user declines the commit prompt in step 6, leave the scaffolding
  staged and uncommitted; do not retry the prompt or commit on a later
  invocation without being asked again.
