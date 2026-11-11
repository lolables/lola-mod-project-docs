# Changelog

All notable changes to this module are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Upgrading

No upgrade steps are required between releases so far; 0.1.0 is the only
release. When a release needs one, its steps will appear under that
release's entry below.

## [Unreleased]

### Added

- **Persona routing** (`/docs-audit` Lane 1). `check-routing.mjs` checks
  that each of eight fixed readers can find their door:
  - `FRONT_DOOR_BLOCKED`, `LONG_QUICKSTART`, and `MISPLACED_SECTION` for a
    README that buries the first run;
  - `MISSING_DOOR`, `ORPHAN_PAGE`, and `NO_WAY_BACK` for unlinked entry
    points and pages;
  - `MISSING_GATE_FILE`, `MISSING_STATUS`, and `SITE_CANDIDATE`.

  The audit detects site generators by config file name and reports the
  page-reachability checks of unsupported ones as skipped.
  `/docs-update` gains a fix for each
  code, and `/docs-init` offers placement rules for `AGENTS.md`. The README
  template gains a `Status` line and one door per reader.
  - MkDocs and Antora sites are routed through their navigation:
    `ORPHAN_PAGE` covers pages missing from the sidebar, and the README
    needs a door to the site. `check-refs` resolves Antora xrefs by page ID,
    and an xref to another component is listed as unresolvable, never
    broken. Site configs are read as data; `js-yaml` is now bundled.
    Still skipped with a reason: `INHERIT` or `exclude_docs` in
    `mkdocs.yml`, and `MISSING_DOOR` when a site has no home page and no
    known URL.
- **Persona walkthroughs** (`/docs-audit` Lane 6). `/docs-audit` walks each
  reader's path through the docs (new user, operator, dev, security) by
  links only and reports `WALKTHROUGH_LOST` when a task cannot be finished,
  naming whether the answer is unreachable or absent. `/docs-update` links
  an unreachable answer.
- **AsciiDoc support.** Every check — structure, staleness, readability,
  references, content-drift chunking, citations, mermaid lint, and palette
  swap — runs on `.adoc`/`.asciidoc` files, and `README.adoc` satisfies the
  README rule. Asciidoctor parses in `secure` mode, so `include::` targets
  are checked but never read.
- **Broader Markdown.** `.markdown`, `.mdown`, `.mkd`, and `.mkdn` files are
  audited. Front matter is skipped, not audited. Footnotes, GFM alerts,
  MkDocs `!!!` admonitions, and `:::` containers are understood, so links
  and diagrams inside them are checked.
- **`UNLINKED_POINTER`** (info, `/docs-audit` Lane 4) flags stock phrases
  that send a reader somewhere with no link in the same block — "contact the
  maintainers", "see the contributing guide", "open an issue". The fix is a
  link or the content included in place, never a reworded location. The
  cold-read prompt also reports unlinked pointers the phrase list misses.
- **`PARSE_WARNING`** (info, `/docs-audit` Lane 4, AsciiDoc only) reports
  parser warnings such as an unterminated block — Markdown never produces
  it.
- **`VOLATILE_DETAIL` and `TIME_ANCHORED`** (info, `/docs-audit` Lane 3)
  flag details that go stale — counts ("147 tests"), metrics ("94%
  coverage"), popularity figures ("1.2k stars"), software versions
  ("markdown-it 14.1.0") — and phrases that date the text ("currently",
  "as of v2"). The LLM drops a candidate the reader needs, such as a version
  pin, and suppresses both in changelogs, release notes, and ADRs. The fix
  deletes the detail or points to the command that reports it.
- **Script-driven Lane 6** (`lane6.mjs`). The script plans every judgment
  job, renders each prompt from `reference/lane6-prompts/`, checks each
  reply, and retries it up to three times. A job that never finishes is a
  `LANE_FAILED` warning the script writes, so an orchestrator can no longer
  skip prompts to save cost. Lane 3's candidate adjudication runs through it
  too.
- **Report file.** `/docs-audit` saves the full punch list to a `mktemp`
  file every run. Past 50 findings it prints only the Blockers and a
  `Full report:` line, and `/docs-update` reads that file.

### Changed

- `/docs-audit` keeps every run artifact (report, saved script JSON, `--fetch`
  snapshots, Lane 6 run directories) in one session directory,
  `$XDG_CACHE_HOME/docs-audit/<project>/<timestamp>-<random>/`, instead of
  `/tmp`, so a past run can be inspected. `lane6.mjs session` creates it and
  `plan --session` uses it. Every audit ends by printing where its report
  was saved. Each project keeps its newest 20 sessions
  (`DOCS_AUDIT_SESSION_CACHE_MAX`). A relative `XDG_CACHE_HOME` is ignored.
- A repo sweep audits only docs written for people: the root README and
  `docs/`. Skills, slash commands, agent prompts, and other docs written for
  an AI assistant are skipped unless named as a path; a lola module's
  `module/` was swept before.
- The plain-language, drift, and adjudication prompts report fewer false
  positives: noun strings count modifiers, not the head noun; a
  prerequisite or UI step is never a drift Blocker. A cold read judges as
  the doc's audience and reports about a third fewer findings.

- `md-files.mjs` and `md-chunks.mjs` are now `doc-files.mjs` and
  `doc-chunks.mjs`.
- `WALL_OF_TEXT` now also checks callouts (GFM alerts, admonitions); plain
  quotations are still exempt.
- `SPLIT_CANDIDATE`'s file size, and now its section spans too, no longer
  count a trailing newline as a line.
- Front matter is no longer audited; links and URLs inside it were checked
  before.
- Doc extensions match case-insensitively (`GUIDE.MD` is audited).
- `MISSING_README` names every accepted README file.

### Fixed

- `check-refs` no longer reports Antora `image::` targets and
  `include::partial$…` resource IDs as broken paths.
- Script JSON over 64 KB is no longer cut short when read through a pipe.

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
