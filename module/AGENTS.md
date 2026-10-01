# docs-discipline

A lola module with two skills for keeping technical project documentation
on track, current, and consistent. Nothing in this module auto-invokes —
every behavior is reached through an explicit slash command.

## When to use this module

- **Starting a new project:** `/docs-init` scaffolds README, docs/dev/, and
  the `.gitignore` entry for `docs/superpowers/`.
- **Catching drift:** `/docs-audit` (read-only) surfaces structural,
  staleness, and content drift. `/docs-update` applies fixes
  interactively.
- **Authoring diagrams:** `/diagram-test` validates every mermaid diagram
  against the house style (syntax, init header, palette, contrast). Four
  contrast-validated palettes ship with the skill — Solar (default),
  Federation, Citrus, Parchment. To swap an existing diagram to a
  different palette, run `scripts/swap-palette.sh <name> <file>` from the
  installed skill directory (for a `.md` it swaps each mermaid fence in
  place; `--block N` picks one) — it prints the result to stdout, so
  redirect it to a new file and move that over the original (redirecting
  onto the input file empties it first).
- **Recording decisions:** `/adr-new <title>` drafts an MADR-format
  Architectural Decision Record. `/adr-review <NNNN>` runs an
  independent rubric pass via a context-isolated subagent.

## Two skills in this module

- **docs-organization** — README and `docs/` layout, drift detection,
  mermaid authoring and testing. See `skills/docs-organization/SKILL.md`.
- **adr** — ADR lifecycle, MADR 4.0 template, review rubric. See
  `skills/adr/SKILL.md`.

The skills are independent. Use one without the other if you prefer.

## Conventions this module enforces

1. Top-level `README.md` is always self-sufficient for basic user
   onboarding.
2. Developer documentation lives under `docs/dev/`.
3. `docs/superpowers/` is in `.gitignore` and never committed (checked
   once a `docs/` tree exists; a repo without one isn't using it yet).
4. ADRs live in `docs/dev/adr/` (or `docs/adr/` for legacy layouts).
5. Every mermaid diagram begins with the required `%%{init}%%` header
   from one of the four shipped palettes (Solar is the default) and uses
   palette classes (`sysA` … `sysF`, `edgeLabel`) with WCAG-verified
   contrast.

## Requirements

- Git (the module assumes you are operating in a git repository).
- Node.js ≥20 for the staleness, prose, reference, mermaid, and palette scripts.
- Bash ≥ 4 for the structure, palette-swap, and ADR-index scripts. macOS
  ships bash 3.2, which is not supported; install a current one with
  `brew install bash`.

## Notes for AI assistants

Each skill's `SKILL.md` carries a "Helper paths" preamble instructing the
agent to anchor on the loaded SKILL.md path
(`SKILL_DIR=$(dirname "$(realpath <skill-md>)")`) and reference every
`scripts/<x>` and `reference/<x>` helper as `"$SKILL_DIR/..."`. The slash
commands (`/docs-init`, `/docs-audit`, `/docs-update`, `/diagram-test`,
`/adr-new`, `/adr-review`) each activate the relevant skill via the
host's Skill tool and reuse `$SKILL_DIR` from there. Do not hardcode
`.claude/skills/...` or search candidate paths — the install destination
varies by host (Claude Code, OpenCode, Cursor, Gemini CLI) and scope, but
helpers are always next to the loaded `SKILL.md`.

When `/docs-update` triggers a `MISSING_ADR_INDEX` finding, it
additionally activates the `adr` skill and binds `$ADR_DIR` from its
loaded `SKILL.md` location the same way.
