# Personas

The fixed set of readers `/docs-audit` routes documentation to. Each brings
one question, starts from a known entry point, and is served by one
mechanism. The set is fixed in the module, not configured per project.

`scripts/personas.mjs` holds the same table as data, and a unit test keeps
the two equal. Run `node "$SKILL_DIR/scripts/personas.mjs"` for the JSON.

| Persona | Question | Entry points | Mechanism |
| --- | --- | --- | --- |
| New user | What is it, should I care, can I run it? | front door (README, or the site home page) | walkthrough |
| Operator | How do I do X, what does key Y do, what changed? Anyone who uses it repeatedly — including a library's API caller and an agent driving the CLI. | `docs/usage/`, `CHANGELOG` | walkthrough |
| Dev | How does it work, how do I build, test, contribute? | `docs/dev/`, `CONTRIBUTING` in the root, `.github/`, `docs/` | walkthrough |
| Security | Am I allowed to adopt it: threat model, data handled, vuln reporting? | `SECURITY` in the root, `.github/`, `docs/` | walkthrough |
| LLM | What are the rules, where is the authoritative fact? | `AGENTS` | placement rules |
| Lawyer | Can we use, modify, ship it? | `LICENSE` (or `LICENCE`, `COPYING`, `UNLICENSE`), `NOTICE`, `LICENSES/` | checklist |
| Support seeker | Where do I get help? | `SUPPORT` in the root, `.github/`, `docs/`, `ISSUE_TEMPLATE` in the root, `.github/`, `docs/`, `.github/ISSUE_TEMPLATE/`, `ISSUE_TEMPLATE/`, `docs/ISSUE_TEMPLATE/` | checklist |
| Project health | Is it alive, can we depend on it? | README `Status` line | checklist |

A file entry point matches its name in any letter case, bare or followed by
`.` and an extension. So `CHANGELOG.md` and `changelog.adoc` count;
`SECURITY-INSIGHTS.yml` is not a `SECURITY` file. The license entry also
accepts a `-` or `_` suffix, so `LICENSE-MIT` and `LICENSE_APACHE` count.

## Mechanisms

- **walkthrough.** The reader follows a path through several pages, so
  every hop must be a link. `MISSING_DOOR` checks the first hop from the
  front door; `ORPHAN_PAGE` and `NO_WAY_BACK` check the pages under
  `docs/`.
  `/docs-audit` also sends a cold reader through each task below,
  by links only, and reports `WALKTHROUGH_LOST` for a task it cannot
  finish.
- **placement rules.** The reader is an agent writing docs. It needs a rule
  for where each new fact goes: `reference/placement-rules.md`.
- **checklist.** The reader needs one file or line to exist:
  `MISSING_GATE_FILE` checks `LICENSE` (a `LICENSES/` directory of SPDX
  files also satisfies it), `SECURITY`, and `SUPPORT` (issue templates also
  satisfy support), and `MISSING_STATUS` checks the README
  `Status` line.

## Walkthrough tasks

The cold reader makes each task concrete from what it reads: it picks the
setting, names the command.

| Walkthrough persona | Task |
| --- | --- |
| New user | say what the project does and who it is for |
| New user | reach a first working command |
| Operator | find how to change one setting the docs mention |
| Operator | find what to do before upgrading |
| Dev | find how to build from source offline |
| Dev | find how to run the tests |
| Dev | find where the architecture is explained |
| Security | find how to report a vulnerability |
| Security | find what data the project stores or sends |
| Security | find where trust boundaries are described |

## Doors

A door is a link from a front door to one of a persona's entry points.
Operator, Dev, Security, Lawyer, and Support seeker need one whenever one of
their entry points exists. A project with only a README and a `LICENSE`
owes a door to the `LICENSE` and nothing else.

On a documentation site, a sidebar entry for an entry point counts as its
door, and the README needs a door to the site itself.

## Example

A README whose doors serve every reader the project has:

    ## Where to go next

    - **Using it:** [docs/usage/](docs/usage/) — how-tos and configuration.
    - **Upgrading:** [CHANGELOG.md](CHANGELOG.md)
    - **Contributing:** [docs/dev/](docs/dev/)
    - **Security:** [SECURITY.md](SECURITY.md)
    - **License:** [LICENSE](LICENSE)
    - **Getting help:** [SUPPORT.md](SUPPORT.md)
