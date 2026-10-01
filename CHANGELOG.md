# Changelog

All notable changes to this module are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-01

Initial release.

### Added

- **Two skills, six slash commands, no auto-invocation.** `docs-organization`
  covers README and `docs/` layout, code-to-docs drift, and mermaid diagrams;
  `adr` covers MADR 4.0 decision records. Each is reached only through an
  explicit command — `/docs-init`, `/docs-audit`, `/docs-update`,
  `/diagram-test`, `/adr-new`, `/adr-review` — and both skill descriptions
  carry the `DO NOT AUTO-INVOKE.` prefix.
- **`/docs-audit`** reports structural, staleness, and content drift:
  - `check-structure.sh` checks layout invariants, including a
    `FORKED_COPY` finding for a regular file, sitting among symlinks,
    that has diverged from its tracked twin.
  - `check-staleness.mjs` classifies source with GitHub Linguist's
    language, vendor, and documentation data, so source is found anywhere
    in the repo rather than only in conventional directories. Data files
    (`.json`, `.yml`, `.toml`, and the like) never count. A repo with no
    recognized source reports a `STALENESS_NOT_ASSESSED` warning.
  - `check-prose.mjs` and `check-refs.mjs` report a `scanned` count, so an
    empty result can be told apart from a lane that read nothing. Symlinked
    docs are audited once, at the target's path, and links are checked from
    every path a doc is reached by.
  - Content drift is checked as a claim ledger. `md-chunks.mjs` splits each
    doc into heading-aligned ranges; an extract subagent lists every
    checkable claim per range, and verify subagents return one verdict per
    claim. Drift — including a step credited to the wrong component, or an
    item missing from a list that names its items — is `CONTENT_DRIFT`.
    "Other" carries one coverage line per file. Measured in
    `eval/REPORT.md` Round 15: 13 of 25 real drifts found, at about $4.50
    per 350-line doc.
  - Cold-read findings carry an `actionable` tag: a command, flag, or step
    that fails as written is a **Warning**; other `COLD_READ` findings are
    Info.
  - A lane that reads nothing or crashes reports `LANE_FAILED` rather than
    passing silently.
- **`/docs-update`** applies `/docs-audit` fixes one at a time, with
  confirmation, including procedures for `CONTENT_DRIFT` and `FORKED_COPY`.
- **`/diagram-test`** lints every mermaid diagram for syntax, the house-style
  init header, palette classes, and WCAG contrast. Four contrast-validated
  palettes ship — Solar (default), Federation, Citrus, Parchment — and
  `swap-palette.sh` moves a diagram between them.
- **`/adr-new`** drafts an MADR 4.0 record with an inline self-review;
  **`/adr-review`** runs an independent rubric review in a context-isolated
  subagent. `adr-index.sh` regenerates the ADR index.
- **No-prerequisite install.** `@aj-archipelago/merval`, `markdown-it`, and
  trimmed Linguist data ship pre-built under
  `module/skills/docs-organization/scripts/vendor/` (330K; MIT, except two
  bundled transitive deps, argparse and entities — see `vendor/LICENSES.md`).
  Installing is two `lola` commands: no `npm install`, no network access.
  Requires git, Node.js ≥ 20, and bash ≥ 4; macOS users need
  `brew install bash`, since the system bash 3.2 is not supported.
- **Contributor tooling:**
  - `task check` runs every gate: structural lint, content lint
    (skillsaw), diagram lint, and the unit, bash, bats, Venom, and
    install suites. `MODE=llm` gives errors-only output.
  - `task test:install` verifies a sandboxed lola install across both
    scopes and both `claude-code` and `opencode`, asserting that every
    shipped file arrives. `task cleanroom` repeats it in a fresh UBI10
    container.
  - `task vendor` rebuilds the vendored bundles from pinned versions, and
    CI fails if a committed bundle drifts from them. `task clean` removes
    derived state but never `vendor/`.
  - CI runs MegaLinter (markdownlint, yamllint, shellcheck, betterleaks,
    trivy, secretlint); Dependabot tracks Actions, the `Containerfile`,
    and the pinned npm dependencies; pushing a `v*` tag creates a GitHub
    release.
  - `docs/dev/architecture.md` documents how the skills and gates work.

[Unreleased]: https://github.com/lolables/lola-mod-project-docs/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/lolables/lola-mod-project-docs/releases/tag/v0.1.0
