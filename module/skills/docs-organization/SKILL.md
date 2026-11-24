---
name: docs-organization
description: DO NOT AUTO-INVOKE. Use ONLY when the user explicitly invokes /docs-init, /docs-audit, /docs-update, or /diagram-test. Not triggered by conversation about documentation, README files, docs structure, or diagrams.
---

# docs-organization

> **Helper paths.** Every `scripts/<x>` and `reference/<x>` reference in this
> file is relative to the directory that contains this `SKILL.md`. Anchor on
> the loaded path (`SKILL_DIR=$(dirname "$(realpath <skill-md>)")`) and
> resolve every helper as `"$SKILL_DIR/scripts/<x>"` or
> `"$SKILL_DIR/reference/<x>"`. Do not hardcode `.claude/skills/...` or
> search candidate paths — the install destination varies by host and scope,
> but helpers are always next to the loaded `SKILL.md`.

This skill keeps a project's documentation organized and current. It is
**never auto-invoked**. All behavior is reached through one of four slash
commands:

- `/docs-init` — bootstrap or extend project doc structure
- `/docs-audit` — find drift between code and docs (read-only)
- `/docs-update` — apply fixes for drift findings
- `/diagram-test` — lint every mermaid diagram

## Invariants this skill enforces

1. **The README is always self-sufficient.** Even after detailed usage docs
   move to `docs/usage/`, the README must provide enough Install +
   Quickstart for a new user to get started.
2. **`docs/superpowers/` is never committed.** It contains specs and plans
   that are working artifacts, not project deliverables. Enforced via
   `.gitignore` and via `check-structure.sh`'s `SUPERPOWERS_IN_GIT` check.
3. **Developer docs live under `docs/dev/`** when a project has them.
   `docs/dev/adr/` (or `docs/adr/` for legacy layouts) holds ADRs.
4. **Every mermaid diagram passes the house-style lint:** init header
   present, classDef names in the approved palette, text/fill contrast
   ≥ 4.5:1 (AA) and fill/background contrast ≥ 3.0:1 (graphical objects)
   for both light and dark reference backgrounds.

## Scope of audit

The skill audits **project-centric documentation written for people** —
content that describes the project to a reader. When enumerating
documentation files (in `/docs-audit` and any command that re-runs its
lanes), include:

- The README at the repository root (any registered README name).
- Every doc file under `docs/` (see "Supported formats").

**Exclude unconditionally:**

- Any path matched by `.gitignore` (e.g., `docs/superpowers/`,
  `node_modules/`, build artifacts).
- Any directory whose name starts with `.`. These are tool/agent-runtime
  spaces (`.git/`, `.claude/`, `.opencode/`, `.lola/`, `.gemini/`,
  `.cursor/`) and never contain project documentation. A single
  structural rule covers existing and future agent hosts without an
  enumerated allowlist.
- LLM-configuration files at any level: `CLAUDE.md`, `AGENTS.md`,
  `GEMINI.md`, `.cursorrules`. These describe agent behavior; they drift
  with prompt-engineering iteration rather than with code, so auditing
  them for code drift produces noise.
- Docs written for an LLM, wherever they live (skills, commands, agent
  prompts; e.g. a lola module's `module/`). Judge from context:
  frontmatter, text addressed to an assistant, where the files ship.

**Explicit paths override these rules:** `/docs-audit <path>...` audits
exactly what the user names (`/docs-audit module/` included).

**Symlinks:** a doc tree can be a directory of symlinks into a canonical copy.
Content judgments (Lanes 3 and 6) run once per real file and report the
canonical path — editing a symlink writes through to its target anyway;
`check-prose.mjs` does this dedupe itself. Reference integrity (Lane 4) is the
exception: a relative link resolves from the path a reader opened, and an
installed module is read from the symlink's location, so Lane 4 gets every
path. A tracked regular file sitting among at least two symlinks into a
directory that has a diverged, tracked same-named twin is flagged by
`check-structure.sh` as `FORKED_COPY` (a README or `index.<ext>` is exempt).

**Tooling preference:** when enumerating files, prefer the agent host's
built-in glob/search tools (e.g., Claude Code's `Glob` and `Grep`) over shell
`find` / `grep`. Built-ins are faster, portable across platforms, and return
structured output without shell-escaping concerns. When the host has none,
use `git -c core.quotePath=false ls-files --cached --others
--exclude-standard` (drop deleted paths) — tracked plus
untracked-not-ignored, i.e., Glob minus `.gitignore` — and apply the
remaining exclusions to its output. Shell tools are still appropriate for
the deterministic scripts under `scripts/`, which run outside the agent.

## Supported formats

Markdown and AsciiDoc; per-format extensions, README names, and mermaid
block syntax are in `reference/supported-formats.md`.

## When a diagram earns its place

Diagram and demo nudges are info-level, never blockers. The concept-to-diagram
type table and the skip rule are in `reference/mermaid-house-style.md`; the bar
each nudge must clear is in its prompt under `reference/lane6-prompts/`.

## Tools this skill uses

Every check is a script under `scripts/` that prints JSON and exits 0 (no
findings), 1 (findings), or 2 (internal error). What each script checks and
reports is in `reference/scripts.md`.

## References

- `reference/mermaid-house-style.md` — palette, init header, examples,
  and **merval syntax constraints** (the strict-subset gotchas every
  diagram in this project must follow; consult before scaffolding).
- `reference/diataxis-grounding.md` — why the grounded Lane 6 checks are
  shaped as they are.
- `reference/deterministic-vs-llm.md` — why each readability signal is owned
  by `check-prose.mjs` or by an LLM lane, and the guards on each.
- `reference/followable-references.md` — why a reference must be followable,
  and which danglers `check-refs.mjs` surfaces.
- `reference/rule-sources.md` — the published rule (or house convention)
  behind each writing-quality finding code; `/docs-audit` cites it.
- `reference/readme-template.md` — minimum acceptable README structure.
- `reference/docs-tree-template.md` — `docs/dev/` and `docs/usage/` scaffold.
- `reference/personas.md` — the eight fixed readers and the door each needs
  from the front door; `check-routing.mjs` checks them.
- `reference/placement-rules.md` — where a new fact goes; `/docs-init`
  offers it for `AGENTS.md`.

## Cross-skill

This skill does not touch ADRs directly. The companion `adr` skill (same
module) owns `docs/dev/adr/` content via `/adr-new` and `/adr-review`.
The two skills share knowledge of the `docs/` layout but have separate
responsibilities.
