# Scripts

What each script under `scripts/` checks, reports, and requires.

Scripts print JSON (lint-mermaid: with `--json`). Exit code:
0 = no findings, 1 = findings, 2 = internal error.

- `scripts/check-structure.sh` — file presence, `.gitignore`, ADR index,
  forked copies in symlinked doc trees (`FORKED_COPY`).
- `scripts/check-routing.mjs` — whether each reader can find their door:
  - `FRONT_DOOR_BLOCKED` (getting-started heading too far down, or none),
    `LONG_QUICKSTART`, and `MISPLACED_SECTION` (a long README section; a
    candidate the LLM assigns to a persona);
  - `MISSING_DOOR` (an entry point no front door, README or site home,
    links; listed in `skipped` when there is neither),
    `ORPHAN_PAGE`, and `NO_WAY_BACK` (pages under `docs/`);
  - `MISSING_GATE_FILE`, `MISSING_STATUS`, and `SITE_CANDIDATE`.

  Page reachability covers MkDocs and Antora navigation (`site:mkdocs`,
  `site:antora`). A MkDocs nav entry that
  names a directory (`- Dev: dev-guide/`) lists that directory's index page only;
  literate-nav and awesome-pages expansion is not evaluated.

  Needs git. Its JSON adds `mode`, `configs`, `skipped` (codes not
  assessed, with the reason; in a site mode this includes
  `FRONT_DOOR_BLOCKED`'s pass for linking the published site), and
  `unresolved` (Antora xrefs the repo cannot resolve, with the `reason`,
  and nav files `antora.yml` lists that git does not track; listed, never
  findings).
- `scripts/check-walkthrough.mjs` — the script half of `/docs-audit`'s
  persona walkthroughs: `--plan` names where each walkthrough persona starts
  and the site sidebar, `--verify` checks a cold reader's recorded hops
  against the navigation graph, and `--classify` turns each task the walk
  could not finish into `WALKTHROUGH_LOST` (`unreachable` or `absent`).
- `scripts/lane6.mjs` — the dispatcher for `/docs-audit`'s Lane 6 prompts
  and Lane 3 adjudication. `session` prints a new audit session directory,
  where the report and every saved JSON also go. `plan` writes a run
  directory (`lane6-XXXXXX`) in it (`--session`; a new session when omitted) and
  prints the first batch of at most 8 jobs and the run's `eof`, a random
  `LANE6_EOF_<16 hex>` heredoc delimiter that `next` prints again;
  `record <run> <id>` checks one reply (stdin, through `<<'<eof>'`)
  against its kind's schema and rejects a reply with a line equal to the `eof`; `next <run>` retries invalid or
  missing replies (three attempts per job) and prints the next batch, or
  `{"status": "done"}`; `collect <run>` prints `findings`, `other`, and
  `modes`. The jobs:

  | Kind | One per | Scope | Waits for |
  |---|---|---|---|
  | `grounding` | file | all | — |
  | `adjudicate` | file with Lane 3 candidates | all | — |
  | `plain-language` | chunk (`doc-chunks.mjs`) | all | — |
  | `drift-extract` | chunk | sweep, path | — |
  | `drift-verify` | 20 claims | sweep, path | the file's extracts |
  | `drift-cited` | file with cited sources | document | grounding |
  | `diagram-drift` | `.mmd` file or mermaid block | sweep, path | — |
  | `missing-diagrams`, `cold-read`, `procedure-structure` | file | all | grounding |
  | `completeness` | file not graded `landing` | all | grounding |
  | `hero-demo` | root README; in a sweep also a `landing` page | sweep, path | grounding |

  Sweep and path scopes audit and report each file's real path (symlinks
  resolved, a symlink and its target planned once); document scope keeps
  the path it was given and dedupes by real path. A Lane 3 candidate
  whose file is not in the plan is not lost: `collect` reports it as
  `(not adjudicated)` and adds a `LANE_FAILED` for the file.

  A job that ends without a valid reply, or never runs because its
  grounding failed, becomes one `LANE_FAILED` warning per file:

  ```text
  Lane 6: Grounding (no JSON object (Unexpected token 'n')), Cold read (grounding failed) did not run; unknown, not clean
  ```
- `scripts/nav-graph.mjs` — the docs mode (`--mode`: `repo`, `site:<generator>`,
  `site-unsupported:<generator>`, `site-unsupported:multiple`) from site-config file names, and the link
  graph `check-routing.mjs` reads. It reads `mkdocs.yml`, `antora.yml`, and
  a root `antora-playbook.yml` as data.
- `scripts/site-yaml.mjs` — loads a site config as inert data; a malformed
  one exits 2 naming the file.
- `scripts/mkdocs.mjs` — reads `mkdocs.yml` into a site layout.
- `scripts/antora.mjs` — reads `antora.yml` into a site layout, resolves
  xref page IDs and `link:` targets, and reads the playbook's site URL.
- `scripts/personas.mjs` — the persona registry as JSON
  (`reference/personas.md`).
- `scripts/check-staleness.mjs` — git log delta between docs and source;
  source is classified with GitHub Linguist's vendored language data, and
  `STALENESS_NOT_ASSESSED` reports when no commit ever touched source.
- `scripts/check-prose.mjs` — readability and size over the parsed doc:
  `WALL_OF_TEXT` (dense top-level or callout paragraph), `DENSE_BULLET` (fat
  flat list item with no sub-bullets), `SPLIT_CANDIDATE` (oversized file or
  level-2 section; skipped for changelog and release-notes files), and plain-language candidates for the LLM to adjudicate:
  `DOUBLE_NEGATIVE` (negator plus negative-meaning word in one clause),
  `SLASH_ALTERNATIVE` (`word/word` in prose), `VOLATILE_DETAIL` (a digit
  count, metric, popularity figure, or software version), and
  `TIME_ANCHORED` (a phrase that dates the text).
- `scripts/check-refs.mjs` — `REF_NOT_IN_GIT`, `REF_BROKEN` (untracked docs:
  checked on disk), `UNLINKED_REF` (bare `§`), `UNLINKED_POINTER` (stock phrase such as "contact the
  maintainers" with no link), `PARSE_WARNING` (parser
  warned; AsciiDoc only — Markdown never produces it). In a `site:antora`
  repo it resolves xrefs by Antora page ID (AsciiDoc files only) and
  reports an xref to an unpublished `_` page, and a malformed one
  (`xref:../b.adoc[]`, `xref:typo$b.adoc[]`, `xref:a:b:c:d.adoc[]`), as
  `REF_BROKEN`. An xref to another component or version is skipped, as is an
  image target starting with `/`. A `link:` target is a published-URL path:
  ROOT pages publish at the component root and module `M` under `M/`, so
  `x.html` maps to the page the published URL names (from a ROOT page,
  `usage/x.html` is `modules/usage/pages/x.adoc`; from `usage`, `../x.html`
  is the ROOT page), `_attachments/x` to `attachments/x`, and any other
  relative target is skipped. `antora.mjs` `antoraRefPolicy` decides, for both
  scripts, which refs take Antora rules (AsciiDoc under `modules/` only). `nav-graph.mjs`
  applies the same mapping, so `ORPHAN_PAGE` agrees. An `antora.yml` beside
  `modules/*/pages/` that `site:antora` does not cover (several components, a
  deeper one, or one next to `mkdocs.yml`) is an unsupported layout, as is a
  malformed `antora.yml`: its AsciiDoc files skip component refs (`link:`
  macros included), listed on stderr, rather than report
  them `REF_BROKEN`.
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
