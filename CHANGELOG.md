# Changelog

All notable changes to this module are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `check-prose.mjs` and `check-refs.mjs` JSON output gained a `scanned`
  field, so an empty result can be told apart from a lane that read nothing.
- `/docs-audit` gained a documented `CONTENT_DRIFT` code with a
  Blocker/Warning rule, a `FORKED_COPY` structural finding
  (`check-structure.sh`), and a `LANE_FAILED` finding when `scanned: 0` or a
  deterministic script crashes. Lane 6 (the LLM lane) now dispatches a
  grounding subagent per file, then one subagent per applicable prompt per
  file — never grouped. File enumeration falls back to
  `git ls-files --cached --others --exclude-standard` when the host has no
  Glob tool.
  `reference`-mode enumerations (glossaries, changelogs, punch lists) may
  suppress `SPLIT_CANDIDATE` — stated under "Other", never silent.
  `/docs-update` gained fix procedures for `CONTENT_DRIFT` and
  `FORKED_COPY`.
- Symlinked docs are now audited correctly: `check-prose.mjs` audits a
  symlink and its target once, reported at the target's path;
  `check-refs.mjs` checks links from every path a doc is reached by
  (symlinks included) and names the canonical file in its findings.
- **The skill's npm dependencies now ship with it.** `@aj-archipelago/merval`
  and `markdown-it` are vendored as pre-built bundles under
  `module/skills/docs-organization/scripts/vendor/` (330K, both MIT), alongside
  `vendor/linguist.json` (GitHub Linguist's language, vendor, and
  documentation data, trimmed to what the staleness lane needs). Installing
  the module is now two `lola` commands with no prerequisites — no `npm
  install`, no network, no follow-up step.
- `task vendor` rebuilds those bundles from the versions `package.json` pins
  (the Linguist tag and SHA-256 hashes are pinned separately in
  `.taskfiles/scripts/build-linguist-data.mjs`), and CI fails if a committed
  bundle has drifted from them.
- Sandboxed install verification (`task test:install`), covering both scopes and
  both `claude-code` and `opencode`. It redirects `HOME` and `LOLA_HOME` into a
  temporary directory, so it runs locally without touching a real assistant
  install. It asserts that every file a skill ships actually arrives, which is
  what would catch a future lola filtering `vendor/` out in transit.
- `task check` as the single gate: structural lint, content lint, diagram lint,
  and every test suite.
- `task cleanroom` repeats the install verification inside a fresh UBI10
  container.
- MegaLinter in CI (markdownlint, yamllint, shellcheck, betterleaks, trivy,
  secretlint) and the skillsaw content gate (`task lint:content`).
- Dependabot for GitHub Actions, the `Containerfile`, and the pinned `merval`
  and `markdown-it` dependencies.
- Tag-triggered GitHub releases.
- `docs/dev/architecture.md`, the maintainer-facing companion to `AGENTS.md`.
- `MODE=llm` on the lint and verify gates for errors-only output.

### Changed

- Unit tests, their fixtures, and the npm build toolchain no longer ship
  in the installed skill; they moved to `tests/scripts/` and
  `.taskfiles/vendor/`.
- **BREAKING:** bash ≥ 4 is now the stated requirement. macOS's bundled
  bash 3.2 is not supported; the README tells Mac users to
  `brew install bash`.
- **BREAKING:** The staleness script is now `check-staleness.mjs`, run with
  `node`. Source is classified from GitHub Linguist's language, vendor, and
  documentation data, instead of assuming source lives in `src/`, `lib/`,
  `cmd/`, `app/`, `internal/`, or `pkg/`: any programming or markup language
  counts, anywhere in the repo, outside vendored, documentation, and
  dot-directory paths; data files (`.json`, `.yml`, `.toml`, and the like)
  never count as source. Some repos will see more staleness findings than
  before — source is now found anywhere, and markup like `.html`/`.css`
  counts. A repo where no source is recognized — a docs-only repo, say —
  reports a `STALENESS_NOT_ASSESSED` warning with status `findings` and exit
  1, instead of status `ok` and exit 0; the old `note` field is gone.
- **BREAKING:** `task lint` now runs the structural module lint. The mermaid
  diagram linter moved to `task lint:diagrams`.
- **BREAKING:** `task install`, `task uninstall`, and their subtargets are
  removed. lola owns installation; the README documents `lola mod add` and
  `lola install` directly. `install:scripts` becomes `task vendor`, and
  `uninstall:scripts` folds into `task clean`, which now removes every derived
  artifact — but never `vendor/`, which is committed and shipped.
- `@aj-archipelago/merval` and `markdown-it` moved from `dependencies` to
  `devDependencies`. They are build inputs for the vendored bundles now, not
  runtime imports.
- `scripts/` moved to `.taskfiles/scripts/`. `scripts/lint-module.sh` is
  replaced by the shared `lint-structure.sh`.
- Both skill descriptions now carry the `DO NOT AUTO-INVOKE.` prefix, matching
  the convention other lola modules use and letting the structural linter
  verify that each explicit skill is reachable from a command.
- Documentation says "module" rather than "pack", and links to
  <https://lobstertrap.org/lola/>.

### Fixed

- `README.md` and `AGENTS.md` described a `.taskfiles/` directory that did not
  exist, and described `tests/` as holding unit tests that actually live beside
  the scripts they cover.
- CI asserted opencode installs at `~/.opencode/`, a path lola moved to
  `~/.config/opencode/`.
- `/docs-audit`'s stop conditions still advised running `npm install` to
  recover from a missing dependency; the dependencies are vendored, so
  there is nothing to install.

### Removed

- The `MERVAL_NOT_INSTALLED` finding, its detection branch, and its two test
  cases. It reported that the mermaid linter's dependency was absent from an
  installed skill; with dependencies vendored, that state cannot occur.
