# Placement rules

Where a new fact goes, keyed to the reader who will look for it (see
`personas.md`). `/docs-init` offers to append these rules to a project's
`AGENTS.md`, so an agent that writes docs puts each fact behind the right
door.

## Rules

| Content | Goes to | Reader |
| --- | --- | --- |
| what it is, who it is for, install, the first working command | the front door | New user |
| how-tos, flags, configuration keys | `docs/usage/` | Operator |
| upgrade notes, changes between releases | `CHANGELOG.md` | Operator |
| architecture, design rationale | `docs/dev/`, or an ADR | Dev |
| dev setup, build, tests, the contribution workflow | `docs/dev/` or `CONTRIBUTING.md` | Dev |
| vulnerability reporting, data handled, trust boundaries | `SECURITY.md` | Security |
| rules for agents that work in the repo | `AGENTS.md` | LLM |
| license terms, third-party notices | `LICENSE`, `NOTICE` | Lawyer |
| where to get help | `SUPPORT.md` | Support seeker |
| maturity and maintenance status | the README `Status` line | Project health |

## Linking a new page in a repo

Every new page under `docs/` gets two links:

- one **to** it, from its reader's index page (`docs/usage/README.md`,
  `docs/dev/README.md`);
- one **back**, in its opening line, which also says who it is for:

      For operators. Back to the [usage docs](README.md).

A reader who lands on the page from a search result then still finds the
way in.

## Linking a new page on a documentation site

Every new page gets a navigation entry instead. The sidebar is the way back,
so the page needs no back link.

- MkDocs: a `nav:` line in `mkdocs.yml`. When `mkdocs.yml` has no `nav:`
  key, MkDocs builds the sidebar from the directory tree. Put the page in
  the right directory and add no `nav:` key, because one would replace the
  whole tree with a hand list.
- Antora: an `* xref:<page>.adoc[]` line in the module's `nav.adoc`.
