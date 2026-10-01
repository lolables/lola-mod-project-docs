# docs-discipline internals

The maintainer-facing companion to the root `AGENTS.md`. Where `AGENTS.md` says
what to do, this says how the machinery works, so a future maintainer can
change it without breaking something subtle.

## Skill-relative helper paths

Both skills ship executable helpers next to their `SKILL.md`. The install
destination varies by host and scope — `~/.claude/skills/`,
`~/.config/opencode/skills/`, `<project>/.opencode/skills/`, and more — so no
helper path can be hardcoded.

Each `SKILL.md` opens with a "Helper paths" preamble telling the agent to
anchor on the file it was loaded from:

```bash
SKILL_DIR=$(dirname "$(realpath <skill-md>)")
bash "$SKILL_DIR/scripts/check-structure.sh"
cat "$SKILL_DIR/reference/mermaid-house-style.md"
```

Every `scripts/…` and `reference/…` reference is written as `"$SKILL_DIR/…"`.
The structural linter enforces this: any skill shipping helper files must
contain a `SKILL_DIR` anchor instruction, or `task lint` fails.

When `/docs-update` hits a `MISSING_ADR_INDEX` finding, it activates the `adr`
skill as well and binds `$ADR_DIR` from that skill's loaded location the same
way.

## Six commands, two skills

The commands are not one-per-skill. `/docs-init`, `/docs-audit`,
`/docs-update`, and `/diagram-test` all front `docs-organization`; `/adr-new`
and `/adr-review` front `adr`; `/docs-update` reaches both.

This is why the shared structural linter binds commands to skills **by
reference** rather than by filename. A command is valid if its filename matches
a skill directory or its body names one; an explicit skill is valid if any
command names it. The template's original linter required a one-to-one
filename match and rejected this module outright.

## The `/docs-audit` lanes

`/docs-audit` splits into deterministic script-owned lanes and model-owned
judgement. The command file marks the split with an `<EXECUTION-CONTRACT>`
block, and the contract is strict: the agent must run the named script and use
its JSON verbatim rather than eyeballing the file, even when reading directly
would be faster.

| Lane | Script | Finds |
| --- | --- | --- |
| 1 structural | `check-structure.sh` | missing or empty README, ungitignored `docs/superpowers/`, superpowers drafts tracked in git, an ADR directory with no `index.md`, a forked copy in a symlinked doc tree (`FORKED_COPY`) |
| 2 staleness | `check-staleness.mjs` | docs older than the code they describe; reports `STALENESS_NOT_ASSESSED` when no commit ever touched a file Linguist classifies as source |
| 3 readability | `check-prose.mjs` | wall-of-text, dense bullets, unscannable procedures |
| 4 reference integrity | `check-refs.mjs` | broken links and file references |
| 5 mermaid | `lint-mermaid.mjs` | syntax, init header, palette classes, contrast |
| 6 LLM | — (subagent-driven) | content drift, missing diagrams/demo, cold-read comprehension, mode mixing, completeness for type |

Lane 6 is the model-owned exception: a grounding subagent classifies each
file's Diátaxis mode first, then a separate subagent runs each applicable
prompt for that file — never grouped across files or prompts, per the
dispatch measurements in `eval/REPORT.md`.

Lane 2 classifies source with GitHub Linguist's language, vendor, and
documentation data (vendored at a pinned tag as `scripts/vendor/linguist.json`)
rather than a hand-maintained marker list. `.taskfiles/scripts/build-linguist-data.mjs`
derives the exact rule: an extension counts if a programming or markup
language claims it, no prose language also claims it (`.md` is out — Markdown
claims it), and no data language lists it as that language's primary
extension (`.sql` is out — SQL's primary extension). A filename counts only
if every language that lists it is programming or markup. A path is never
source if it is vendored, documentation, or under a dot-directory.

`check-staleness.mjs` classifies by path name, so a commit that deletes a
source file, or only resolves a merge conflict in one (surfaced via `--cc`),
still counts as a source change. When no commit ever touched a source path,
staleness is unknown, not clean — the script reports `STALENESS_NOT_ASSESSED`
rather than a silent pass.

A doc is judged stale by commit ancestry, not by comparing commit
timestamps: the script records the SHA of the latest source commit, and a
doc is stale iff its own last-commit SHA differs from that SHA and is its
ancestor (`git merge-base --is-ancestor`). Two commits landing in the same
second compare equal under a timestamp, and a committer date can be
skewed relative to where a commit actually sits in history — ancestry
answers "did this doc predate that source change?" directly from the
graph instead. `STALE_DOC` also resolves each doc's realpath before
reporting, collapsing a symlink and its target into one finding at the
target's canonical path (the same dedupe Lane 3 applies below), and
excludes ADRs (`docs/dev/adr/`, `docs/adr/`) — they're dated records, not
descriptions that drift.

The scan walks `git log` newest-first and stops at the first commit that
touches a source path, rather than restricting by pathspec — a pathspec glob
forces git to evaluate it against every changed path in every commit, which
measured 2-4x slower than the unfiltered walk. Stopping at the first match
keeps the worst case (a repo whose only source commit is the first one) to
about 1s per ~35k commits of history (measured on django), and far less
whenever source was touched recently.

Lanes 3 and 4 walk the documentation tree with the shared `md-files.mjs`
helper, which is symlink-aware: a symlinked `.md` file is included, a
symlinked directory is not descended. Lane 3 dedupes a symlink and its
target into one document, reported at the target's path; Lane 4 checks
links from every path a doc is reached by, symlinks included, so a
relative link is verified from wherever a reader actually opens it. Both
report `scanned` in their JSON, so an empty result can be told apart from a
lane that read nothing.

Convention 2 in `AGENTS.md` — developer documentation under `docs/dev/` — is
model-owned, not script-owned. Lane 1 does not check for it.

Splitting it this way is what makes the audit reproducible. The `eval/`
harness measures each lane's recall and false-positive rate against fixtures
with known ground truth; `eval/REPORT.md` records the results that justified
wiring each lane in.

## The palette system

Four palettes ship in `reference/palettes/`: Solar (default), Federation,
Citrus, and Parchment. Each covers every mermaid diagram type, so switching
palettes never leaves a diagram type unstyled.

Contrast is verified, not assumed. `contrast.mjs` computes WCAG ratios and
`validate-palette.mjs` asserts every palette meets text-on-fill ≥ 4.5:1 and
fill-on-background ≥ 3.0:1 against both light and dark reference backgrounds.
`lint-mermaid.mjs` enforces that every diagram carries the house-style
`%%{init}%%` header and uses palette classes (`sysA`…`sysF`, `edgeLabel`)
rather than inline colours. It contrast-checks approved `classDef`s and
`style` statements; `resolveColor` in `contrast.mjs` accepts hex and the 148
CSS named colors, whose table (`css-named-colors.mjs`) is extracted from CSS
Color Module Level 4 §6.1 rather than typed by hand.

Only the syntax verdict comes from merval's parse. The header, class-name and
contrast checks are regexes over the diagram text, so they run even when
merval rejects the block. merval's flowchart grammar knows four bracket shapes
(`[]`, `()`, `(())`, `{}`), so it rejects valid shapes such as the cylinder
`[(…)]` with a misleading bracket error. `lint-mermaid.mjs` recognises those
shapes on the error line and names them in the `SYNTAX_ERROR` message. The
fixture tests pin merval's accept/reject set, so a merval bump that widens the
grammar fails loudly instead of leaving the hint and the house-style table
stale.

`apply-palette.mjs` and `swap-palette.sh` rewrite an existing diagram to a
different palette. For a `.md`, `apply-palette.mjs --swap` finds fences with
`lint-mermaid.mjs`'s own `extractMermaidBlocks` and splices by its offsets, so
`--block N` addresses exactly the block a finding's 1-based `block` field
names and no byte outside a swapped fence changes. Indented fences are
refused: re-indenting generated lines is where a silent corruption would hide.
ER diagrams need a CSS override that mermaid's init block cannot express,
which is why `er-overrides.css` exists and why `task render` passes it to
`mmdc`.

Palette class names are load-bearing. Every diagram in every project using this
module references them by name, so renaming one is a breaking change.

## The install oracle

`task test:install` runs `.taskfiles/scripts/verify-lola-module.sh`, which:

- redirects `HOME` and `LOLA_HOME` into a fresh `mktemp -d`, so a user-scope
  install never touches your real `~/.claude`;
- installs from a copy of `module/` inside that sandbox, so a project-scope
  install — which writes into the current directory — lands in the sandbox
  rather than this checkout;
- **discovers** what to assert from `module/skills/*/` and
  `module/commands/*.md`, then looks for each under the scope root;
- asserts the `lola:module:docs-discipline` managed-section marker was
  injected into some context file;
- removes the sandbox via an `EXIT` trap, and dumps the tree on failure.

The discovery matters. lola moves install destinations between releases —
opencode's user-scope path moved from `~/.opencode/` to
`~/.config/opencode/` — and the CI workflow this replaced had a hardcoded
assertion that silently went stale. Skill directories are also named after the
skill, not the module, so asserting `skills/docs-discipline/` would never have
matched anything here.

## Why there is no `task install`

lola owns installation. It already has scope selection, assistant targeting,
and force prompts, and wrapping those in Task means shadowing a flag surface
that drifts the moment lola adds a flag. The README documents the `lola`
commands directly.

There is nothing left to wrap. Install is two `lola` commands with no
prerequisites — see the next section.

## Vendored dependencies

The skill shells out to two npm packages: `@aj-archipelago/merval` for mermaid
validation, and `markdown-it` for the `/docs-audit` prose and reference lanes.
Neither would survive an install as npm packages — lola strips any directory
named `node_modules` from the copy it ships. The staleness lane also needs
GitHub Linguist's language, vendor, and documentation data; that isn't an npm
package but a build-time fetch, trimmed to what `check-staleness.mjs` needs.
Both land in `vendor/`, which lola ships verbatim.

The name is the entire constraint. `ALWAYS_IGNORE` matches that one directory
name, not dependencies in general, so a `vendor/` directory ships verbatim at
any depth. The npm packages are MIT and bundle cleanly, and Linguist's data
(also MIT) is trimmed to what `check-staleness.mjs` needs, so all three ship
pre-built:

```text
scripts/vendor/merval.mjs        90K   @aj-archipelago/merval, no deps
scripts/vendor/markdown-it.mjs  240K   markdown-it + 6 transitive deps
scripts/vendor/linguist.json     19K   extensions, filenames, exclude patterns from GitHub Linguist
scripts/vendor/LICENSES.md             MIT texts for all eight packages plus Linguist
```

`.taskfiles/vendor/package.json` keeps the two npm packages as
`devDependencies` — they are
build inputs, not runtime imports — alongside a pinned `esbuild` and `js-yaml`
(used only to convert Linguist's YAML sources to JSON at build time).
`task vendor` installs that toolchain and regenerates all four files. CI
reruns it and fails on a non-empty `git diff vendor/`, so a committed bundle
can never drift from the version `package.json` pins. A Dependabot bump
therefore arrives red until the bundles are rebuilt, which is the intended
signal.

That toolchain, and the scripts' unit tests and fixtures (under
`tests/scripts/<skill>/`), live outside `module/` on purpose. lola copies every
git-tracked file under the module and ignores only `.gitignore` plus its fixed
`ALWAYS_IGNORE` set, so anything development-only left in a skill's `scripts/`
lands in the user's `.claude/skills/`. esbuild resolves bare specifiers from
the entry file's directory, so `build-vendor.sh` writes its temporary entry
points inside `.taskfiles/vendor/`. The bundles embed each module's path
relative to the repo root (`.taskfiles/vendor/node_modules/...`), so moving the
toolchain again means rerunning `task vendor` and committing the result.

GitHub Linguist's data is pinned separately: `.taskfiles/scripts/build-linguist-data.mjs`
hardcodes the fetched tag (`TAG`) and a SHA-256 per file (`PINNED`). Bumping
it means editing `TAG` and every hash in `PINNED`, then running `task vendor`
— Dependabot's `npm` entry only covers the two npm packages, so it never
opens a bump PR for the Linguist fetch. `task vendor`, which CI also runs,
now needs network access to `raw.githubusercontent.com`, not just the npm
registry.

`LICENSES.md` is assembled by `build-vendor.sh` from the installed packages'
own metadata and licence files, because esbuild only preserves `/*! */` legal
comments and neither package uses them. The list of packages to walk is
hardcoded in that script, so a new transitive dependency has to be added there
by hand.

Two consequences worth knowing. `MERVAL_NOT_INSTALLED` no longer exists — the
gap it reported cannot occur. And the install oracle asserts that every file
under a source skill directory arrives in the installed copy, which is what
would catch lola widening `ALWAYS_IGNORE` to swallow `vendor/`.

The alternative was a `module/lola.yaml` `post-install` hook running `npm
install` at the destination. It is blocked anyway: in lola v0.7.0 the hook
runner passes an empty `cwd` at user scope, so the hook dies with
`FileNotFoundError` and lola misreports it as "script is not executable".
Hooks work at project scope. Even fixed, a hook would need network and npm at
every install; vendoring needs neither.
