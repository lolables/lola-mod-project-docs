# Project structure

```text
module/skills/docs-organization/SKILL.md    the docs-organization skill
module/skills/docs-organization/scripts/    node + bash helpers (doc-files.mjs, doc-chunks.mjs, lint-mermaid.mjs, check-structure.sh, fetch-citations.mjs, …)
module/skills/docs-organization/scripts/formats/  format registry and adapters (markdown.mjs, asciidoc.mjs)
module/skills/docs-organization/scripts/vendor/  pre-built MIT dependency bundles that ship with the skill
module/skills/docs-organization/reference/  house-style references, README/docs templates, palettes
module/skills/adr/SKILL.md                  the adr skill
module/skills/adr/scripts/adr-index.sh      regenerates the ADR index
module/skills/adr/reference/                MADR 4.0 template + review rubric
module/commands/                            the six slash commands
Taskfile.yml                                developer workflow
.taskfiles/scripts/                         shared quality-gate scripts
.taskfiles/vendor/                          npm toolchain that `task vendor` builds scripts/vendor/ with
tests/diagrams/                             mermaid fixtures, one per diagram type
tests/scripts/                              unit tests + fixtures for each skill's scripts/
tests/e2e/                                  Venom end-to-end suite
tests/fixtures/                             deliberately-broken modules for the structural linter
tests/lint-structure.bats                   tests for the structural linter
tests/lint-quoted-paths.bats                checks that $SKILL_DIR/$ADR_DIR expansions in module/ prompts are quoted
tests/verify-oracle.bats                    tests for the install oracle
tests/quiet-gate.bats                       tests for the errors-only gate wrapper (quiet-gate.sh)
tests/module-policy.bats                    checks the public names and explicit-invocation contract of module/
tests/lint-voice.bats                       tests for the house-voice word lint (lint-voice.mjs)
eval/                                       /docs-audit lane evaluation (maintainer research)
.github/workflows/                          CI and release
```

Unit tests live in `tests/scripts/<skill>/`, not beside the code they cover:
lola ships every tracked file under `module/`, so anything development-only
stays outside it.
