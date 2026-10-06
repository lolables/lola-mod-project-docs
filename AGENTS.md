# docs-discipline — agent context for working on this repo

This repo is the source of the `docs-discipline`
[lola](https://lobstertrap.org/lola/) module — two independent skills
(`docs-organization`, `adr`) and six explicit slash commands
(`/docs-init`, `/docs-audit`, `/docs-update`, `/diagram-test`,
`/adr-new`, `/adr-review`). The installable surface lives under
`module/`. The root `Taskfile.yml` drives the quality gates: structural
and content lint, diagram lint, and the bash, node, bats, Venom, and
sandboxed-install suites.

## Repo layout

| Path | What it is |
| --- | --- |
| `module/AGENTS.md` | Lola module manifest (injected into the host's AGENTS.md / CLAUDE.md at install time) |
| `module/skills/docs-organization/SKILL.md` | Skill prompt — invariants, drift detection, diagram authoring |
| `module/skills/docs-organization/scripts/` | `check-structure.sh`, `check-staleness.mjs`, `check-prose.mjs`, `check-refs.mjs`, `doc-files.mjs`, `doc-chunks.mjs`, `formats/` (format registry and adapters), `fetch-citations.mjs`, `lint-mermaid.mjs`, `apply-palette.mjs`, `css-named-colors.mjs`, `validate-palette.mjs`, `swap-palette.sh`, `contrast.mjs`, and `vendor/` |
| `module/skills/docs-organization/reference/` | `mermaid-house-style.md`, `readme-template.md`, `docs-tree-template.md`, `supported-formats.md`, `scripts.md`, `rule-sources.md`, palette assets |
| `module/skills/adr/SKILL.md` | Skill prompt — MADR 4.0 workflow, status transitions |
| `module/skills/adr/scripts/adr-index.sh` | Regenerates `index.md` whenever a new ADR is added or its status changes |
| `module/skills/adr/reference/` | `madr-template.md`, `review-rubric.md` |
| `module/commands/{docs-init,docs-audit,docs-update,diagram-test,adr-new,adr-review}.md` | The six slash commands |
| `Taskfile.yml` + `.taskfiles/scripts/` | Task automation and the shared quality-gate scripts |
| `.taskfiles/vendor/` | npm toolchain (`package.json`, lockfile, `node_modules/`) that `task vendor` uses to build `scripts/vendor/`; never shipped |
| `tests/scripts/<skill>/` | Unit tests (`*.test.mjs`, `*.test.sh`) and `__fixtures__/` for each skill's `scripts/`; kept out of `module/` so they never ship |
| `tests/` | Structural-linter fixtures and bats suites, mermaid fixtures, Venom e2e |
| `docs/dev/architecture.md` | How the skills and gates work internally |
| `docs/dev/vendoring.md` | How the npm bundles and Linguist data are built, pinned, licensed, and shipped |
| `docs/dev/maintaining.md` | Maintainer procedures: adding a document format, bumping the Linguist data |
| `eval/` | Headless `/docs-audit` lane evaluation (maintainer research; not installed, not in `task test`). See `eval/README.md`. |
| `.github/workflows/` | CI and release |

## Working with this module

- **The module ships two skills, six commands, no autonomous behavior.**
  Every action requires an explicit `/...` invocation. Both skill
  descriptions carry the `DO NOT AUTO-INVOKE.` prefix. Do not add
  auto-trigger keywords to either one.
- **The slash commands activate the skill, then use `$SKILL_DIR`.**
  Each command file invokes the relevant skill via the host's Skill
  tool. The skill's SKILL.md defines `$SKILL_DIR` (the directory the
  host loaded it from). Reuse `$SKILL_DIR` for every `scripts/...` /
  `reference/...` reference — do not hardcode `.claude/skills/...` or
  search candidate paths. `docs/dev/architecture.md` explains why.

## House voice (for maintainers and AI assistants editing these docs)

These docs are edited by AI assistants. Left unchecked, generated prose drifts
toward a recognizable register. Hold the line on the following.

**Show, don't tell.** A worked example beats a description. If a command
produces output, show a realistic sample of it. If a template gets filled in,
ship one filled-in example, not just the blank.

**Readability — the "four ideas" test.** A paragraph that enumerates several
mechanisms or rules forces the reader to hold them all at once. Break it into
sub-bullets, or add vertical whitespace at the topic seams, so the eye lands on
one beat at a time. This is broader than whitespace-only reflow — restructuring
into bullets is expected when a paragraph lists several distinct points.

**Cut the tells.** Prefer plain verbs and concrete nouns. Watch for and remove:

- Booster adverbs and brochure verbs: "actively", "simply", "seamlessly",
  "leverage", "robust", "comprehensive", "powerful", "effortlessly".
- Formulaic scaffolds: "It's worth noting that…", "In order to…" (use "to"),
  "X — but only when Y" as a section title.
- Uniform rhythm: several same-length sentences in a row, or an em-dash in
  every sentence. Vary it.

**Never touch on a voice edit:** technical claims, code blocks, commands, file
paths, exact finding codes, and error strings. Voice work changes register and
rhythm, not facts. When in doubt, preserve verbatim.

## Install via lola

This repo does not wrap `lola`. Install and uninstall are documented in the
README as raw `lola` commands, because lola already owns scope selection,
assistant targeting, and force prompts — wrapping it here would shadow that
flag surface and drift the moment lola adds a flag.

End users need no prerequisites at all: the skill's two npm dependencies and
GitHub Linguist's vendored language data ship pre-bundled under
`scripts/vendor/`, so a fresh install works offline with no follow-up step.

`task vendor` is the contributor-only path — it installs the build toolchain
and regenerates those bundles. Run it after any dependency bump, and commit the
result: CI reruns it and fails on a non-empty `git diff vendor/`.
`task deps:bump` moves every npm pin and the Linguist pin to latest, then runs
`task vendor`; see `docs/dev/maintaining.md#bump-dependencies`.

`task clean` removes derived state (`.test-output/` and
`.taskfiles/vendor/node_modules/`). It
deliberately leaves `vendor/` alone — those bundles are committed source of
record that ships to users, not scratch.

`.lola/`, `.claude/`, `.opencode/`, `.cursor/`, `.gemini/`, `.openclaw/`,
`/CLAUDE.md`, and `/GEMINI.md` are gitignored — they are install destinations
that land in the working tree during local install testing.

## Testing

```bash
task check              # every gate — this is the bar
task lint               # structural lint of module/
task lint:content       # skillsaw --strict
task lint:diagrams      # mermaid lint of the module's own docs
task test               # all suites
task test:unit          # node:test, tests/scripts/
task test:bash          # bash script tests
task test:gates         # bats, covering the shared lint and verify scripts
task test:install       # sandboxed lola install, both scopes, claude-code + opencode
task test:e2e           # Venom
task test:diagrams      # lint + render every mermaid fixture
task cleanroom          # install verify inside a fresh UBI10 container
```

Add `MODE=llm` to any gate for errors-only output.

Nothing is done until `task check` is green.

## Conventions enforced by the skills

1. Top-level `README.md` always self-sufficient for basic user onboarding.
2. Developer documentation under `docs/dev/`.
3. `docs/superpowers/` is in `.gitignore` and never committed.
4. ADRs in `docs/dev/adr/` (or `docs/adr/` for legacy layouts).
5. Every mermaid diagram begins with the house-style init header and uses
   palette classes with WCAG-verified contrast (text/fill ≥ 4.5:1,
   fill/background ≥ 3.0:1 on both light and dark reference backgrounds).

## Exemplars & references

Reference material for future refinement — patterns worth borrowing, not text
worth copying. Cite the idea in your own words. External links rot; re-check
them when you touch this section.

- [MADR](https://adr.github.io/madr/) — the decision-record template `/adr-new`
  instantiates; the canonical shape for "Considered Options" and "Consequences".
- [Nygard, "Documenting Architecture Decisions"](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions)
  — why lightweight, per-decision records beat a monolithic design doc.
- [Diátaxis](https://diataxis.fr/) — the four-mode model (tutorial / how-to /
  reference / explanation) behind keeping the README task-focused and pushing
  architecture into `docs/dev/`.
- [Write the Docs](https://www.writethedocs.org/) — a working community's
  conventions for docs that stay maintained.
- [Mermaid](https://mermaid.js.org/) — full diagram grammar; the house style is
  a strict subset (see the mermaid house-style reference).
- [lola](https://lobstertrap.org/lola/) — the cross-host module format this
  ships as.

## What NOT to change without explicit user direction

- The six slash-command names — these are the documented public API.
- The two skill names (`docs-organization`, `adr`).
- The MADR 4.0 template structure under
  `module/skills/adr/reference/madr-template.md` — `/adr-new` and
  `/adr-review` both depend on its sections.
- The four palette names + the palette-class naming (`sysA`…`sysF`,
  `edgeLabel`) — every diagram in every project that uses the module
  references them by name.
