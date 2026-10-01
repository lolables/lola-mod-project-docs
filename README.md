# docs-discipline

A [lola](https://lobstertrap.org/lola/) module with two skills for keeping
technical project documentation on track, current, and consistent. Nothing
auto-invokes — every behavior is reached through an explicit slash command.

----

> 🤖 LLM/AI WARNING 🤖
>
> This project was written with LLM (AI) assistance.

----

## What this is

`docs-discipline` ships two independent skills for AI coding assistants:

- **docs-organization** — manages README and `docs/` layout, detects drift
  between code and documentation, validates mermaid diagrams against a
  house style (palette + WCAG contrast).
- **adr** — manages Architectural Decision Records (MADR 4.0) with an
  inline self-review pass on creation and a context-isolated subagent
  review pass on demand.

Behavior reaches the agent only through six explicit slash commands:
`/docs-init`, `/docs-audit`, `/docs-update`, `/diagram-test`, `/adr-new`,
`/adr-review`.

## Install

Install [lola](https://lobstertrap.org/lola/) once:

```bash
uv tool install git+https://github.com/LobsterTrap/lola@v0.7.0
```

Register and install this module:

```bash
lola mod add -n docs-discipline https://github.com/lolables/lola-mod-project-docs.git
lola install docs-discipline -a claude-code --scope user
```

`lola install` prompts for assistant and scope when you omit them. Scripted:

```bash
lola install docs-discipline -a opencode --scope user -f
lola install docs-discipline -a claude-code --scope project -f
```

Uninstall mirrors it, for whichever scope you installed. For `--scope
project`, name the project path — omitting it uninstalls from every
project-scope installation `lola` knows about, not just the one you are
standing in:

```bash
lola uninstall docs-discipline -a claude-code --scope user -f
lola uninstall docs-discipline -a claude-code --scope project -f .
lola mod rm -f docs-discipline
```

That is the whole install. The skill's two npm dependencies
(`@aj-archipelago/merval` for mermaid validation, `markdown-it` for the
`/docs-audit` prose and reference lanes) and GitHub Linguist's vendored
language data (used by the staleness lane) ship pre-bundled inside the
module, so there is no `npm install`, no network access needed after `lola
install`, and no follow-up step.

Requirements: git, Node.js ≥ 20, bash ≥ 4, lola ≥ 0.7.0 (matching the
pinned install line above).

On macOS, the system bash is 3.2, which is not supported. Install a
current one with `brew install bash`, and check that `bash --version`
reports 5.x. If it still reports 3.2, Homebrew's `bin` directory is
behind `/bin` on your `PATH`.

## Quickstart

In a project with the module installed:

```bash
/docs-init                                        # scaffold README, docs/, .gitignore
/docs-audit                                       # find drift between code and docs (read-only)
/docs-update                                      # apply fixes interactively
/diagram-test                                     # lint every mermaid diagram
/adr-new "Use Postgres for primary storage"       # draft an ADR with inline self-review
/adr-review 0001                                  # independent rubric review via subagent
```

## Diagram palettes

Four contrast-validated mermaid palettes ship with the skill:

- **Solar** (default) — cool jewel tones, outlined clusters, both light and
  dark backgrounds
- **Federation** — cool balanced, outlined clusters, both backgrounds
- **Citrus** — warm earth tones, outlined clusters, both backgrounds
- **Parchment** — filled beige clusters for high-impact light-bg rendering

Every palette covers every mermaid diagram type (flowchart, sequence,
class, state, ER, journey, gantt, pie, sankey, gitgraph, mindmap,
timeline, xychart, block, kanban, packet, quadrant, requirement, C4,
architecture, radar). See
`module/skills/docs-organization/reference/mermaid-house-style.md` for
templates and the deltas table for switching between them.

After install, `/diagram-test` lints every diagram against the active
palette. To swap an existing diagram to a different palette, run the
skill's `swap-palette.sh` directly — it prints the swapped diagram to
stdout, so redirect it:

```bash
bash .claude/skills/docs-organization/scripts/swap-palette.sh citrus path/to/diagram.mmd > path/to/diagram.mmd.new
mv path/to/diagram.mmd.new path/to/diagram.mmd
```

That path is for a project-scope install; a user-scope install lives under
`~/.claude/skills/`. Write to a new file and move it into place — redirecting
straight onto the input empties it before the script reads it.

Given a `.md`, the script swaps every ` ```mermaid ` fence in place and leaves
the rest of the file byte-for-byte unchanged; `--block N` swaps only the
N-th fence (1-based), e.g. `swap-palette.sh --block 2 citrus docs/guide.md`.

(Path shown is a Claude Code project-scope install; other hosts and scopes
use different directories, chosen by `lola` — see `lola install --help` for
the full list of supported assistants.)

**For contributors to this repo** (not needed to use the installed
module): `task render -- path/to/diagram.mmd` renders a `.mmd` to PNG on
light and dark backgrounds (needs `mmdc`, not vendored — install
`@mermaid-js/mermaid-cli` separately), and `task palette -- citrus
path/to/diagram.mmd` runs the same `swap-palette.sh` through Task from the
repo root; both are `task`-only, so they require the full dev checkout.

## Conventions enforced

1. Top-level `README.md` always self-sufficient for basic user onboarding.
2. Developer documentation under `docs/dev/`.
3. `docs/superpowers/` is in `.gitignore` and never committed (checked
   once a `docs/` tree exists; a repo without one isn't using it yet).
4. ADRs in `docs/dev/adr/` (or `docs/adr/` for legacy layouts).
5. Every mermaid diagram begins with the house-style init header and uses
   palette classes with WCAG-verified contrast.

## Project structure

```text
module/AGENTS.md                            module instructions, injected at install
module/skills/docs-organization/SKILL.md    the docs-organization skill
module/skills/docs-organization/scripts/    node + bash helpers (lint-mermaid.mjs, check-structure.sh, …)
module/skills/docs-organization/scripts/vendor/  pre-built MIT dependency bundles that ship with the skill
module/skills/docs-organization/reference/  house-style references, README/docs templates, palettes
module/skills/adr/SKILL.md                  the adr skill
module/skills/adr/scripts/adr-index.sh      regenerates the ADR index
module/skills/adr/reference/                MADR 4.0 template + review rubric
module/commands/                            the six slash commands
Taskfile.yml                                developer workflow
.taskfiles/scripts/                         shared quality-gate scripts
.taskfiles/vendor/                          npm toolchain that `task vendor` builds vendor/ with
tests/diagrams/                             mermaid fixtures, one per diagram type
tests/scripts/                              unit tests + fixtures for each skill's scripts/
tests/e2e/                                  Venom end-to-end suite
tests/fixtures/                             deliberately-broken modules for the structural linter
tests/lint-structure.bats                   tests for the structural linter
tests/verify-oracle.bats                    tests for the install oracle
eval/                                       /docs-audit lane evaluation (maintainer research)
.github/workflows/                          CI and release
```

Unit tests live in `tests/scripts/<skill>/`, not beside the code they cover:
lola ships every tracked file under `module/`, so anything development-only
stays outside it.

## Where to go next

- **For maintainers/contributors:** `AGENTS.md` at the repo root.
- **For the lola module format:** see <https://lobstertrap.org/lola/>
- **For MADR:** see <https://adr.github.io/madr/>

## License

See `LICENSE`.
