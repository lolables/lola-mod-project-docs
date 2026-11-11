# docs-discipline

A [lola](https://lobstertrap.org/lola/) module with two skills for keeping
technical project documentation on track, current, and consistent. Nothing
auto-invokes — every behavior is reached through an explicit slash command.

**Status:** pre-1.0; see
[`CHANGELOG.md`](CHANGELOG.md) for releases. Maintained by the
[lolables](https://github.com/lolables) organization.

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
- **adr** — manages Architectural Decision Records in the
  [MADR 4.0](https://adr.github.io/madr/) format, with an inline
  self-review pass on creation and a review pass on demand, run by a
  context-isolated subagent.

Behavior reaches the agent only through six explicit slash commands:
`/docs-init`, `/docs-audit`, `/docs-update`, `/diagram-test`, `/adr-new`,
`/adr-review`.

## Install

Prerequisites: git, Node.js 20 or newer, bash 4 or newer, and
[`uv`](https://docs.astral.sh/uv/getting-started/installation/). If you lack
`uv`, install it with Astral's script:

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

1. Install [lola](https://lobstertrap.org/lola/) once:

   ```bash
   uv tool install git+https://github.com/LobsterTrap/lola@v0.7.0
   ```

2. Register and install this module:

   ```bash
   lola mod add -n docs-discipline https://github.com/lolables/lola-mod-project-docs.git
   lola install docs-discipline -a claude-code --scope user
   ```

That is the whole install: the module's npm dependencies ship pre-bundled,
so there is no `npm install` and no follow-up step. Version pins, macOS
bash, scripted installs, and uninstall are in
[Getting started](docs/usage/getting-started.md).

## Quickstart

In a project with the module installed, type these into your AI assistant's
prompt (they are slash commands, not shell commands):

1. `/docs-init` — scaffold README, `docs/`, and `.gitignore`.
2. `/docs-audit` — find drift between code and docs (read-only).
3. `/docs-update` — apply the audit's fixes interactively. An audit with
   more than 50 findings prints only its Blockers and saves the full list
   to a file; pass that path, as its `Full report:` line shows:
   `/docs-update /tmp/docs-audit-Hq2xZa`.
4. `/diagram-test` — lint every mermaid diagram.
5. `/adr-new "Use Postgres for primary storage"` — draft an ADR with an
   inline self-review. It writes an `NNNN-*.md` file under `docs/dev/adr/`
   (or `docs/adr/` if that directory already exists), numbered with the next
   free four digits.
6. `/adr-review 0001` — independent rubric review of that ADR; pass the
   number from its filename.

Everything else you can do, such as auditing one file, is in
[Getting started](docs/usage/getting-started.md).

Want a different diagram palette? See
[Diagram palettes](docs/usage/diagram-palettes.md).

## Conventions enforced

1. Top-level `README.md` always self-sufficient for basic user onboarding.
2. Developer documentation under `docs/dev/`.
3. `docs/superpowers/` — working specs and plans that planning skills
   such as superpowers write there — is in `.gitignore` and never committed
   (checked once a `docs/` tree exists; a repo without one isn't using it
   yet).
4. ADRs in `docs/dev/adr/` (or `docs/adr/` for legacy layouts).
5. Every mermaid diagram begins with the house-style init header (the
   `%%{init}%%` block for one of the four palettes in
   [Diagram palettes](docs/usage/diagram-palettes.md)) and uses palette
   classes with WCAG-verified contrast.
6. Every reader has a door. The README links each reader's entry point that
   exists (`docs/usage/`, `docs/dev/`, `SECURITY.md`, `LICENSE`, …), every
   page under `docs/` is reachable from the README and links back, and the
   README carries a `Status` line.

## Supported formats

Markdown and AsciiDoc, each with its own README name. Every check —
structure, staleness, readability, references, content-drift chunking,
citations, mermaid lint, and palette swap — runs on both. See
[`reference/supported-formats.md`](module/skills/docs-organization/reference/supported-formats.md)
for the exact extensions and README names each format claims.

In AsciiDoc, mermaid diagrams are `[mermaid]` or `[source,mermaid]` blocks,
and the scripts check `include::` targets exist but never read them.
`/docs-init` writes Markdown templates and leaves an existing `README.adoc`
alone.

## Where to go next

- **Using the module:** [Getting started](docs/usage/getting-started.md) and
  [Diagram palettes](docs/usage/diagram-palettes.md).
- **Maintainers and contributors:** [`docs/dev/architecture.md`](docs/dev/architecture.md)
  (how it works), [`docs/dev/maintaining.md`](docs/dev/maintaining.md)
  (procedures), [`docs/dev/vendoring.md`](docs/dev/vendoring.md)
  (bundled dependencies), and
  [`docs/dev/project-structure.md`](docs/dev/project-structure.md)
  (repository layout). [`AGENTS.md`](AGENTS.md) holds the house-voice rules
  and protected names for AI assistants.
- **Operators:** [`CHANGELOG.md`](CHANGELOG.md) lists what changed in each
  release.
- **Security:** [`SECURITY.md`](SECURITY.md) explains how to report a
  vulnerability.
- **Help:** [`SUPPORT.md`](SUPPORT.md) says where to ask questions and
  report bugs.
- **For the lola module format:** see <https://lobstertrap.org/lola/>
- **For MADR:** see <https://adr.github.io/madr/>

## License

Apache License 2.0. See [`LICENSE`](LICENSE).
