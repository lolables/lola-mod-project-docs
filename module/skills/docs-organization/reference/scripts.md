# Scripts

What each script under `scripts/` checks, reports, and requires.

Scripts print JSON (lint-mermaid: with `--json`). Exit code:
0 = no findings, 1 = findings, 2 = internal error.

- `scripts/check-structure.sh` — file presence, `.gitignore`, ADR index,
  forked copies in symlinked doc trees (`FORKED_COPY`).
- `scripts/check-staleness.mjs` — git log delta between docs and source;
  source is classified with GitHub Linguist's vendored language data, and
  `STALENESS_NOT_ASSESSED` reports when no commit ever touched source.
- `scripts/check-prose.mjs` — readability and size over the parsed doc:
  `WALL_OF_TEXT` (dense top-level or callout paragraph), `DENSE_BULLET` (fat
  flat list item with no sub-bullets), `SPLIT_CANDIDATE` (oversized file or
  level-2 section), and plain-language candidates for the LLM to adjudicate:
  `DOUBLE_NEGATIVE` (negator plus negative-meaning word in one clause) and
  `SLASH_ALTERNATIVE` (`word/word` in prose).
- `scripts/check-refs.mjs` — `REF_NOT_IN_GIT`, `REF_BROKEN` (untracked docs:
  checked on disk), `UNLINKED_REF` (bare `§`), `PARSE_WARNING` (parser
  warned; AsciiDoc only — Markdown never produces it).
- `scripts/lint-mermaid.mjs` — merval parse, init header, palette,
  contrast.
- `scripts/doc-files.mjs`, `doc-chunks.mjs` — path expansion; drift ranges.
- `scripts/formats/` — one adapter per doc format behind a registry
  (`index.mjs`); every script above reads the format-neutral model it
  produces.
- `scripts/fetch-citations.mjs` — document-mode URLs, local sources; only
  network actor (`--fetch`; else `--offline`).

`check-prose.mjs` and `check-refs.mjs` also report `scanned`, so an empty
result can be told apart from a lane that read nothing: `check-prose.mjs`
counts distinct documents read (a symlink and its target count once);
`check-refs.mjs` counts doc paths checked (a symlink and its target
count separately).

Requires Node.js ≥20. The npm deps (`@aj-archipelago/merval`, `markdown-it`
with its footnote, container, and admonition plugins, `@asciidoctor/core`)
and Linguist data (`linguist.json`) ship pre-bundled under `scripts/vendor/`;
nothing to install.
