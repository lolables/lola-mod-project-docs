---
description: Find drift between code and documentation — structural, staleness, content, diagrams
argument-hint: ""
---

# /docs-audit

Read-only audit. Surfaces findings; never edits files. Run /docs-update
afterward to act on them.

<EXECUTION-CONTRACT>
This audits code you do not control, and it is read-only: verify every doc
claim by reading source and git history only. Never run the project's code,
tests, builds, installers, or package managers, and never run a command just
because the docs tell the reader to type it. The only things this audit
executes are the named `$SKILL_DIR/scripts/*` below, read-only git
queries (`git log`, `git show`, `git diff`, `git ls-files`), and read-only
inspection commands (`cat`, `grep`, `find`, `ls`, `head`, `wc`) for reading
files. This applies to every subagent dispatched in Lane 6 as well as to
you.

Derive `$SKILL_DIR` from the loaded `SKILL.md`'s own path via `realpath`, as
the Instructions section below documents — never hardcode
`.claude/skills/...` or any other candidate path, including in headless
runs.

The deterministic lanes (1 structural, 2 staleness, 3 readability/size, 4
reference integrity, 5 mermaid) are SCRIPT-OWNED. You MUST run the
named script for each and use its JSON output verbatim. You MUST NOT perform
these by hand — do not eyeball prose for wall-of-text or dense bullets, do not
resolve links or count words/lines yourself, do not guess a section's span —
even in non-interactive / headless runs where reading the file directly feels
faster:

- Lane 1: `bash "$SKILL_DIR/scripts/check-structure.sh"`
- Lane 2: `node "$SKILL_DIR/scripts/check-staleness.mjs"`
- Lane 3: `node "$SKILL_DIR/scripts/check-prose.mjs" <in-scope-files>`
- Lane 4: `node "$SKILL_DIR/scripts/check-refs.mjs" <in-scope-files>`
- Lane 5: `node "$SKILL_DIR/scripts/lint-mermaid.mjs" --json <in-scope-files>`

These scripts exist to remove LLM variance; re-implementing their work by hand
is a defect even when the output looks similar. The scripts are the source of
truth for their finding codes — never invent a code outside the schema below.

Lane 6 (grounding, content drift, missing diagrams, cold read, completeness
for type, structure for procedures, hero demo) is the ONLY agent-owned lane,
because those judgments are irreducibly fuzzy. Even there the guardrail is
mandatory: validate every subagent reply, retry an empty/errored one up to
twice, and record a `LANE_FAILED` warning rather than reading empty as
clean.
</EXECUTION-CONTRACT>

## User-provided arguments

> $ARGUMENTS

## Instructions

### Activate the docs-organization skill

Invoke the `docs-organization` skill via your host's Skill tool. The skill's
`SKILL.md` defines `$SKILL_DIR` as the directory the host loaded it from
(`SKILL_DIR=$(dirname "$(realpath <loaded-skill-md>)")`). Reuse `$SKILL_DIR`
for every `scripts/...` and `reference/...` reference below — do not
hardcode `.claude/skills/...` or search candidate paths.

### Steps

1. Read `$SKILL_DIR/SKILL.md` for the invariants and principles this skill enforces. The procedure below is the source of truth for what to do.
2. **Lane 1 — Structural (fast):**
   - Run `bash "$SKILL_DIR/scripts/check-structure.sh"`.
   - Parse the JSON. Collect findings.
3. **Lane 2 — Staleness (fast):**
   - Run `node "$SKILL_DIR/scripts/check-staleness.mjs"`.
   - Parse JSON. Collect findings. A `STALENESS_NOT_ASSESSED` finding means
     the script recognized no source — no commit ever touched a file Linguist
     classifies as source — so staleness is **unknown**, not clean. Report
     it; never drop it to make the lane look green.
4. **Lane 3 — Readability and size (fast, deterministic):**
   - Enumerate project documentation files per the scope rules in
     `$SKILL_DIR/SKILL.md` (§ "Scope of audit"): `README.md`, every `.md`
     under `docs/`, and (for lola module repos) project-shipped docs under
     `module/`. **Exclude** `.gitignore`-matched paths, dot-directories
     (`.git/`, `.claude/`, `.opencode/`, `.lola/`, etc.), and LLM-config
     files (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.cursorrules`). Prefer
     the host's built-in Glob tool; if the host has none, use `git -c
     core.quotePath=false ls-files --cached --others --exclude-standard`
     (never bare `find`, which ignores `.gitignore`; without
     `core.quotePath=false`, non-ASCII names come back quoted and never
     match) and drop any path that no longer exists on disk. Keep
     symlinked paths in the list — see the scope rules on symlinks.
   - Run `node "$SKILL_DIR/scripts/check-prose.mjs" <in-scope-file>...` and
     parse the JSON. Collect its findings:
     - `WALL_OF_TEXT` — a top-level paragraph over ~120 words unbroken; split
       at a topic seam.
     - `DENSE_BULLET` — a *flat* list item (no sub-bullets) over ~90 words;
       fix by decomposing into a short lead-in plus nested sub-bullets. This
       is the class the per-paragraph rule misses because it excludes lists.
     - `SPLIT_CANDIDATE` — the whole file, or one H2 section, over the size
       budget; consider extracting an audience-specific how-to under `docs/`.
   - This lane is **deterministic**: it counts words and line spans over a real
     markdown AST (fenced code, tables, blockquotes, and nested lists are
     distinguished by node type), so it enumerates every violation
     exhaustively and returns byte-identical results every run. Do **not**
     ask an LLM to hunt for wall-of-text or dense bullets — an LLM
     under-reports on long files (its recall fades toward the end) and the
     result is not reproducible.
   - Check `scanned` in the JSON: the number of distinct documents the script
     read. If it is `0` while you passed at least one in-scope file, the lane
     did not run — record a `LANE_FAILED` **Warning** (lane `check-prose`)
     instead of reporting those files as clean. A count below the number of
     paths passed is expected *only* when two paths are one document (a
     symlink and its target) — report any other shortfall.
   - The script triggers on word count and line span only — both unambiguous.
     It deliberately does **not** count sentences (segmentation is a hard NLP
     problem that false-flags abbreviation-heavy prose).
   - **Fuzzy judgment (LLM, only for files this lane flags):** on the candidates
     the script surfaces, judge by the file's Diátaxis mode (from Lane 6
     grounding). Dense unbroken prose is a convention in `reference` and
     `explanation` (and formal specs/legal/academic text) — you may suppress
     `WALL_OF_TEXT` there; it is a real defect in `tutorial`/`how-to`, where the
     reader is mid-task. Likewise, for a `reference` doc whose job is to
     enumerate (a glossary, changelog, catalog, rule list, or punch list) you
     may suppress `SPLIT_CANDIDATE`: splitting an enumeration into linked
     sub-documents makes lookup worse. Never extend that to `explanation`,
     `tutorial`, or `how-to` docs, and never suppress `DENSE_BULLET`. You may
     also note choppy sentence rhythm the word count can't see. State every
     suppression under "Other" as `suppressed: <code> — <file> (<Diátaxis
     mode>); not for /docs-update` — never drop a finding silently.

5. **Lane 4 — Reference integrity (fast, deterministic):**
   - Run `node "$SKILL_DIR/scripts/check-refs.mjs" <in-scope-file>...` (same scope
     as Lane 3) and parse the JSON. Collect its findings:
     - `REF_BROKEN` — a markdown link or image to a local path that resolves to nothing.
       **Warning.** Fix the path or link the real target.
     - `REF_NOT_IN_GIT` — a markdown link or image to a file that exists but git does not
       track (gitignored/unstaged), so it dangles for anyone who clones.
       **Warning.** Commit it, or make it an explicit external link if it is
       intentionally private.
     - `UNLINKED_REF` — a `§` section citation in prose with no link in the same
       paragraph, heading, or table cell. **Info.**
       A cheap deterministic tell for a reference (often to an external/internal
       spec) the reader can't follow. The fix is to *link* it or confirm the
       target ships — **never strip the citation**.
   - The rule is "a reference should be *followable*", not "everything
     referenced must be committed" — some references are legitimately private or
     external. The script only surfaces danglers; the author resolves them (link,
     commit, or mark external) in `/docs-update`.
   - Check `scanned`: the number of git-tracked docs checked. If it is `0`
     while you passed at least one tracked in-scope file, record a
     `LANE_FAILED` **Warning** (lane `check-refs`). Untracked files are skipped
     by design and do not count.
   - Lane 4 gets **every** path, symlinks included (see the scope rules). A
     finding whose message says the path is a symlink is broken from that
     path only; the fix still goes in the canonical file it names.
   - Only markdown links are resolved (unambiguous, doc-relative). Inline-code
     mentions of source paths are deliberately not resolved — they are
     repo-root-relative and riddled with placeholders, so resolving them
     heuristically is mostly false positives; stale source citations are Lane 6's
     content-drift job.

6. **Lane 5 — Mermaid (fast, deterministic):**
   - Enumerate every `.mmd` file and fenced ```mermaid block within the
     in-scope documentation files (same scope as Lane 3).
   - Run `node "$SKILL_DIR/scripts/lint-mermaid.mjs" --json <in-scope-files>`
     and parse the JSON. Collect each finding by its `severity` and `line`
     (1-based; a fenced block's line is relative to the containing `.md`
     file, an `.mmd` file's line is relative to itself).
   - Codes this lane emits: `SYNTAX_ERROR` and `INLINE_CLASS_NOT_SUPPORTED`
     (blocker — the diagram fails validation), `MISSING_HOUSE_STYLE_HEADER`
     (blocker — no `%%{init}%%` block), `LEGACY_HOUSE_STYLE_HEADER` (warning
     — a pre-palette-update header that makes some labels invisible),
     `UNAPPROVED_CLASSNAME` (warning — a `classDef` outside `sysA`…`sysF`,
     `edgeLabel`), `UNAPPROVED_STYLE` (warning — a `style <node>` statement
     that sets colors instead of using a palette class), and
     `LOW_CONTRAST_TEXT` / `LOW_CONTRAST_LIGHT_BG` / `LOW_CONTRAST_DARK_BG`
     (blocker — an approved `classDef`'s or a `style` statement's
     fill/text, hex or CSS named color, fails the WCAG ratio against text,
     the light reference background, or the dark reference background
     respectively).
   - A `SYNTAX_ERROR` never suppresses the other checks: the header,
     class-name, and contrast checks run against the raw source even when
     merval rejects the diagram (see Stop conditions for the exit-code
     contract).

7. **Lane 6 — Grounding, content, diagram, and cold-read (slow, subagent-driven):**
   - **Grounding first (one short subagent per file).** Before
     the narrow checks, establish what the document is *for*, grounded in
     the Diátaxis framework (<https://diataxis.fr>): "Read <file>. In under
     70 words state (a) its primary Diátaxis mode — `tutorial` (learning),
     `how-to` (a task), `reference` (facts/tables), `explanation`
     (concepts/why), or `landing` (a README/entry page, legitimately
     multi-mode); (b) its intended audience; (c) what a reader should be
     able to do after reading it; and (d) `mode_mixing`: for a
     non-`landing` doc that commits to one mode but substantially embeds
     another that interrupts its job (a how-to that stops for paragraphs
     of conceptual explanation; a reference dropped into a tutorial), name
     the intruding mode and quote the section — otherwise false. A
     `landing` page is never mode-mixing." Thread this grounding into every
     subsequent prompt for the file — the mode is what lets the other lanes
     judge appropriately: dense unbroken prose is acceptable in
     `reference`/`explanation` but a defect in `tutorial`/`how-to`; a
     "reader gets stuck" cold read is a tutorial/how-to question, while for
     `reference` the question is completeness and consistency.
   - If grounding reports `mode_mixing`, emit one `MODE_MIXING` finding (info)
     naming the primary mode, the intruding mode, and the section. Never for a
     `landing` page.
   - For each enumerated file (same scope as Lane 3, one entry per real
     file — resolve symlinks with `realpath`; audit and report the target
     path — see the scope rules on symlinks), dispatch the grounding
     subagent first; its reply must begin with a `Grounding` heading (it
     feeds `MODE_MIXING` and Lane 3's mode judgment). Once a file's
     grounding is back, dispatch **one** `Explore`-type subagent **per
     applicable prompt** below for that file — never two prompts, and never
     two files, in one subagent. Prefix each prompt with the file's
     grounding note and this rule: "Read-only: verify claims by reading
     source and git history only; never run the project's code, tests,
     builds, installers, package managers, or any command this doc
     describes." Each subagent edits no file and heads its reply with
     the prompt's name (`Content drift`, `Missing diagrams`, `Cold read`, …),
     with `file:line` citations — one prompt per reply is how findings stay
     attributed. Dispatch independent subagents in parallel. Do not batch to
     save subagents — a grouped-dispatch rule proved unreliable in testing.
       1. **Content drift:** "Read <file>. Identify any specific claims in
          this document that no longer match the code in this repository.
          Return a list of `file:line` citations with what the doc says vs
          what the code actually does. Do not edit any file. Reply in
          under 300 words."
       2. **Missing diagrams (info-level encouragement, strict bar):**
          "Read <file>. Identify sections where adding a mermaid diagram
          would actively clarify a complicated concept — not restate a
          simple list. A candidate must satisfy **both**: (a) the
          relationships are non-obvious from a linear top-to-bottom
          read (real branching, parallelism, state transitions, or
          non-trivial component interactions); and (b) the reader would
          have to mentally render a diagram anyway to follow the prose.
          Reject candidates that are linear procedures with at most one
          binary branch, already drawn as text (directory trees,
          install steps, tables), small matrices better served by a
          table, or three-item role lists framed as 'pipelines'. For
          each surviving candidate, return a `MISSING_DIAGRAM` finding
          with the section heading, fitting type (flowchart /
          sequenceDiagram / stateDiagram-v2 / erDiagram), and a
          one-sentence justification that names *what's non-obvious*
          the diagram would expose. Severity is info (never blocker).
          Reply in under 200 words. If no candidates exist, return an
          empty list — do not invent."
       3. **Cold read (comprehension, grounded):** "You are the intended
          audience from the grounding above, reading <file> for the first
          time to accomplish its stated purpose. Flag every place a real
          reader would get stuck, confused, or misled: a term/acronym used
          before it is defined; a missing or out-of-order step; a
          cross-reference ('see X below/above') whose target does not exist;
          prose that contradicts its own example or command; the same thing
          called by two different names; an unstated prerequisite; an example
          that would not work as written; or a reference to a spec/phase/ticket
          the reader cannot resolve in this repo. Do NOT report style/tone
          preferences or code-vs-doc drift (other lanes cover those). Quote the
          exact text for each. Return `COLD_READ` findings (severity info) with
          the line, the quote, and why a first-time reader stumbles. Reply in
          under 250 words; empty list if genuinely clear."
       4. **Completeness for type (Good Docs, grounded):** "This document's
          Diátaxis mode is <mode> (from grounding). Using The Good Docs Project's
          notion of what that type needs — a how-to: steps that reach the goal,
          any prerequisite the steps assume, and a clear end state; a
          troubleshooting doc: each symptom paired with a resolution; a
          reference: every listed item actually described; a tutorial: a
          learning goal and a wrap-up — report only genuine completeness gaps
          that would leave a reader of this type BLOCKED or unable to trust the
          doc (a symptom with no fix, a reference entry left blank, a
          prerequisite the steps require but never name). A doc is complete when
          a competent reader could succeed: do NOT flag a step for being
          higher-level than its siblings or lacking an exact command, do NOT
          flag an intentionally minimal doc that is complete for its scope, and
          NEVER flag for a missing *named section* (Prerequisites, Summary) when
          the reader is not actually blocked — only for a reader who would be
          blocked, never one who merely wants more detail. Return
          `INCOMPLETE_FOR_TYPE` findings (info) with what is missing, where, and
          how it blocks the reader. Empty list when complete. Landing/README
          pages: skip this check, they are multi-mode by design."
       5. **Structure for procedures (scannability, grounded):** "Read <file>.
          Flag any PROCEDURAL run — a stretch that walks the reader through a
          sequence of commands or actions (install / setup / configuration / a
          command-by-command walkthrough) presented as continuous prose and/or
          back-to-back fenced code blocks with NO numbered list, NO bullet list,
          and NO sub-headings breaking it into rest points. Roughly three or more
          distinct commands/steps crammed together unbroken is the target — the
          reader has no visual anchor for where one step ends and the next begins.
          This applies to any document with a procedure, INCLUDING a README /
          landing page whose Install or Quickstart section walks through commands
          (this check is **not** landing-exempt — the others are). Do NOT flag: a
          procedure already broken into a list or sub-headings (that is the desired
          shape — never re-flag it); conceptual/explanatory prose or a reference
          table that is not a procedure (prose density there is Lane 3's
          `WALL_OF_TEXT` concern, not this one); a one- or two-command run (too
          short to need scaffolding); or style/tone/drift (other lanes). For each
          run, return a `NEEDS_STRUCTURE` finding (severity info) with the section
          heading or first line of the run, roughly how many steps are crammed
          together, and why the reader loses their place. Reply in under 200 words;
          empty list if every procedure is already broken into rest points."
       6. **Hero demo (README/landing only, info-level encouragement, strict
          bar):** Run this ONLY for the repository README or a doc grounding
          classified as `landing`; skip every other file. "Read <file>. Judge
          whether this landing page would be meaningfully improved by a DEMO — an
          animated terminal recording (asciinema / GIF) or a short screen capture
          — that shows the tool running. Emit a finding ONLY when ALL hold: (a) the
          project is a USER-FACING, RUNNABLE tool (a CLI, TUI, or app a person
          operates and can watch produce output) — a library / framework / SDK is
          not one (its demo is a code snippet the README already carries), nor is
          a spec / schema / docs-only repo; (b) this doc is the project's README /
          entry point; and (c) the README does NOT already show the tool in action
          — no embedded image (`![](...gif/png/svg/webp)`), `<img>` / `<video>`,
          asciinema / `.cast`, or linked screencast. If any visual demo or
          representative screenshot is already present, return empty — the job is
          done. At most ONE finding (the hero slot). When warranted, return a
          `MISSING_DEMO` finding (severity info) with a short SPEC: the happy-path
          command sequence to record, what the viewer should see that signals
          success, and a suggested format (asciinema + svg-term-cli, or VHS /
          charmbracelet, for a terminal; a screen capture for a GUI). When in
          doubt return empty — a false nag is worse than a miss. Reply in under
          150 words."
   - For each `.mmd` file or fenced ```mermaid block found within the
     enumerated documentation files (same scope rules apply):
     - Dispatch an `Explore`-type subagent: "Read-only: verify by reading
       source only, never by running the project's code. Read this diagram
       and the code it depicts. Identify nodes/edges that reference
       subsystems no longer in the code. Reply in under 200 words."
   - **Never read an empty result as "clean."** A subagent that returns
     nothing, errors, or times out is a *failed* lane, not a passing one.
     Per reply: an empty list under the prompt's heading means no
     findings; a missing heading, or a truncated reply, means that prompt
     failed for that file (roughly 1 run in 5 returns empty transiently,
     which otherwise reads as a spurious all-clear). Re-dispatch that
     prompt for that file, including its
     grounding note; if the grounding reply itself lacks its `Grounding`
     heading, re-run grounding first. Re-dispatch up to
     **twice**; if it still yields nothing parseable, record a
     `LANE_FAILED` **Warning** naming the file and lane rather
     than reporting the file as clean.
   - Whole-file content-drift is reliable for files up to several hundred
     lines. For a file that *also*
     triggers `SPLIT_CANDIDATE`, you may run the content-drift prompt once
     per top-level section — as separate subagents, one per section, each
     running only the content-drift prompt — and union the findings:
     insurance for very large files, not required for ordinary ones.
8. Aggregate findings from all six lanes and present a structured
   punch list. **This format is the contract `/docs-update` parses** from
   conversation context, so it must be regular. Build it in this order —
   tables first, summary last — so the summary can only ever agree with
   the tables:
   - For each non-empty severity, a markdown table with these columns:
     `| Code | File | Line | Note |` where:
     - `Code` is the finding code — one of, by lane (this is the full
       schema; never invent a code outside it):
       - Lane 1: `MISSING_README`, `MISSING_GITIGNORE_SUPERPOWERS`,
         `SUPERPOWERS_IN_GIT`, `MISSING_ADR_INDEX`, `FORKED_COPY`.
       - Lane 2: `STALENESS_NOT_ASSESSED`, `STALE_README`, `STALE_DOC`.
       - Lane 3: `WALL_OF_TEXT`, `DENSE_BULLET`, `SPLIT_CANDIDATE`.
       - Lane 4: `REF_BROKEN`, `REF_NOT_IN_GIT`, `UNLINKED_REF`.
       - Lane 5: `SYNTAX_ERROR`, `INLINE_CLASS_NOT_SUPPORTED`,
         `MISSING_HOUSE_STYLE_HEADER`, `LEGACY_HOUSE_STYLE_HEADER`,
         `UNAPPROVED_CLASSNAME`, `UNAPPROVED_STYLE`, `LOW_CONTRAST_TEXT`,
         `LOW_CONTRAST_LIGHT_BG`, `LOW_CONTRAST_DARK_BG`.
       - Lane 6: `MISSING_DIAGRAM`, `CONTENT_DRIFT`, `COLD_READ`,
         `MODE_MIXING`, `INCOMPLETE_FOR_TYPE`, `NEEDS_STRUCTURE`,
         `MISSING_DEMO`.
       - Any lane: `LANE_FAILED`.
     - `File` is the repo-relative path, or `—` for a finding that covers a
       whole lane rather than one file (`STALENESS_NOT_ASSESSED`, a
       `LANE_FAILED` from a deterministic lane).
     - `Line` is the relevant line number, or `—` if not applicable.
     - `Note` carries the data `/docs-update` needs to act on the
       finding:
       - `MISSING_DIAGRAM`: section heading, suggested diagram type
         (`flowchart` / `sequenceDiagram` / `stateDiagram-v2` /
         `erDiagram`), and the one-sentence justification.
       - `CONTENT_DRIFT` (content or diagram drift): what the doc claims vs.
         what the code shows, with a code citation. Severity is one question:
         does the doc tell the reader to **type, pass, set, create, or edit**
         something (a command, subcommand, flag, install step, config key,
         env var, or a file they must write) that the code rejects, lacks, or
         ignores? Yes → **Blocker**. Anything else is a statement of fact the
         reader does not act on directly → **Warning**, however surprising.
         Examples:
         - `app sync --all`, and `--all` was removed → Blocker.
         - "Set `APP_HOME` to relocate data", and nothing reads it → Blocker.
         - "Run the tests with `python -m unittest`", and the repo has no
           tests → Blocker (the instruction does nothing).
         - `app sync --all`, and `--all` is a kept alias → Warning.
         - "Tasks are stored in `~/.app.json`", and the default moved →
           Warning (a fact, not an instruction).
         - "Retries are unbounded", and the code caps them → Warning.
         - Any diagram drift → Warning (nobody executes a diagram).
         `CONTENT_DRIFT` is
         **doc-vs-code only** —
         a doc contradicting another doc (or its own guardrail) is a `COLD_READ`
         consistency finding, not drift; and only call something a
         *contradiction* when both statements make a claim about the **same
         subject** and disagree on it (adjacent-but-different subjects are not a
         contradiction).
       - `WALL_OF_TEXT`: start line and approximate word count (from
         `check-prose`). Info-level nudge; never a blocker.
       - `DENSE_BULLET`: start line and approximate word count; the fix is to
         decompose the flat bullet into a lead-in plus nested sub-bullets. Info.
       - `SPLIT_CANDIDATE`: the file (or the named H2 section) and its line
         span; the fix is to extract an audience-specific how-to under
         `docs/` and leave a pointer. Info.
       - `REF_BROKEN` / `REF_NOT_IN_GIT`: the link target and whether it is
         missing or merely untracked. Warning. Fix is author's call in
         `/docs-update` (repoint, commit, or make it an explicit external link).
       - `UNLINKED_REF`: the `§` citation snippet. Info. Fix is to add a link
         to the referenced section — never strip the citation.
       - `SYNTAX_ERROR`: merval's error message and line/column, plus a hint
         naming the likely unsupported shape when one is detected. Blocker.
         Fix requires rewriting the diagram source; consult
         `reference/mermaid-house-style.md`'s Syntax constraints.
       - `INLINE_CLASS_NOT_SUPPORTED`: the node id and class name from an
         inline `:::className` on a node with an explicit shape. Blocker.
         Fix is to declare the node, then assign the class with a separate
         `class <nodeId> <className>` statement, as the message specifies.
       - `MISSING_HOUSE_STYLE_HEADER`: the diagram has no `%%{init}%%` block.
         Blocker. Fix is to prepend one of the four palette headers.
       - `LEGACY_HOUSE_STYLE_HEADER`: which required signal is missing
         (`clusterBkg`) or wrong (`primaryTextColor` white). Warning. Fix is
         to replace the header with a current palette header.
       - `UNAPPROVED_CLASSNAME`: the `classDef` name used and the approved
         set (`sysA`…`sysF`, `edgeLabel`). Warning. Fix needs a judgment
         call — which approved class the flagged system maps to.
       - `UNAPPROVED_STYLE`: the node whose `style` statement sets colors.
         Warning. Fix needs a judgment call — replace the statement with
         `class <node> <sysX>` for the approved class it maps to.
       - `LOW_CONTRAST_TEXT` / `LOW_CONTRAST_LIGHT_BG` / `LOW_CONTRAST_DARK_BG`:
         the rule (`classDef "sysA"` or `style "A"`, as the message begins),
         the measured ratio, and what it needs (≥4.5:1 for text/fill, ≥3.0:1
         for fill/background). Blocker. Fix for a `classDef` is to restore
         the class's `fill`/`color` to its palette's validated values; for a
         `style` statement, replace it with a palette class.
       - `COLD_READ`: the quoted text and why a first-time reader stumbles
         (undefined term, missing step, dangling reference, contradiction,
         terminology drift, unstated prerequisite). Info.
       - `MODE_MIXING`: the primary Diátaxis mode, the intruding mode, and the
         section. Info. Fix is to move the intruding content to its own doc
         (e.g. a how-to's conceptual detour → an `explanation` doc, linked).
         Never fires for a `landing`/README entry page.
       - `INCOMPLETE_FOR_TYPE`: what a reader of this Diátaxis type needs but the
         doc lacks (a symptom with no fix, a blank reference entry, an unnamed
         prerequisite the steps assume), and how it blocks the reader. Info.
         Only reader-blocking gaps — never a missing *named section*.
       - `NEEDS_STRUCTURE`: the procedural run (section heading or first line) and
         roughly how many commands/steps are crammed together unbroken. Info. The
         fix is to break the run into a numbered list and/or per-step sub-headings,
         keeping every command verbatim. Fires on procedures only (including a
         README Install/Quickstart) — never on already-listed steps or on
         non-procedural prose (that density is `WALL_OF_TEXT`).
       - `MISSING_DEMO`: the demo spec — the command sequence to record, what the
         viewer should see, and a suggested format (asciinema / VHS / screenshot).
         Info, encouragement bucket. `/docs-update` drops an HTML-comment demo
         spec at the hero slot; it never produces the recording (an LLM can't).
         README/landing pages for user-facing tools only — never a library or a
         README that already shows a demo.
       - `MISSING_README`: — (no extra detail). Blocker. Not fixable by
         `/docs-update` directly — it tells the user to run `/docs-init`,
         which owns README scaffolding.
       - `MISSING_GITIGNORE_SUPERPOWERS`: — (no extra detail). Blocker, only
         checked when `docs/` exists — a repo with no `docs/` tree isn't
         using the workflow yet, so this check is skipped there. Fix is to
         append `docs/superpowers/` to `.gitignore`.
       - `SUPERPOWERS_IN_GIT`: the tracked path(s) under `docs/superpowers/`.
         Blocker. Fix is `git rm --cached` each one, then confirm the
         `.gitignore` entry is present.
       - `MISSING_ADR_INDEX`: the ADR directory (`docs/dev/adr/` or
         `docs/adr/`). Warning. Fix is to regenerate `index.md` via
         `adr-index.sh`.
       - `FORKED_COPY`: the regular file, plus the same-named tracked twin
         found in the directory its ≥2 sibling symlinks point into, once its
         content has diverged from that twin (from `check-structure`;
         byte-identical copies are not flagged). Warning. The fix is to diff
         the two, then replace the copy with a symlink or record why it
         differs.
       - `STALE_README`: the latest source commit's short SHA, the source
         path it touched, and how many commits separate README's last
         commit from it (`sourceCommit`, `sourcePath`, `commitsSince`).
         Warning. The README is older than the latest classified source
         change; re-read it for drift (pairs with a `CONTENT_DRIFT` finding
         when one exists).
       - `STALE_DOC`: the same detail as `STALE_README` — the latest source
         commit's short SHA, the source path it touched, and how many
         commits separate the doc's last commit from it. Info. Same fix as
         `STALE_README` — re-read for drift — but info because the doc is
         not the project's entry point.
       - `STALENESS_NOT_ASSESSED`: Lane 2 recognized no source, so no doc was
         checked for staleness. Warning — "unknown", not "clean". Not fixable
         by `/docs-update`.
       - `LANE_FAILED`: which file (or `—` for a whole deterministic lane) and
         which lane could not be audited — after retries for a Lane 6
         subagent; immediately for a deterministic script. Warning — it means
         "unknown", not "clean".
   - If a finding doesn't fit the schema, list it under a separate
     "Other" subsection rather than mangling the table. "Other" also lists
     stated suppressions (`suppressed: <code> — <file> (<mode>); not for
     /docs-update`), which `/docs-update` skips.
   - Once every table is built, count each table's rows and print the
     summary as the first line of the punch list, in exactly this form —
     a single code span, nothing before or after it, no bold: `` `N
     blockers, N warnings, N info` ``. The three counts MUST equal their
     tables' row counts; if they don't, recount from the tables rather
     than trusting arithmetic done along the way.
9. **Do not write any files.** Offer: "Run /docs-update to fix these
   findings interactively."

## Example output

A run against a small project part-way through cleanup might report:

`3 blockers, 4 warnings, 11 info`

### Blockers

| Code | File | Line | Note |
|------|------|------|------|
| `MISSING_GITIGNORE_SUPERPOWERS` | `.gitignore` | — | add `docs/superpowers/` |
| `MISSING_HOUSE_STYLE_HEADER` | `docs/dev/diagrams/pipeline.mmd` | 1 | prepend the Solar init header |
| `CONTENT_DRIFT` | `README.md` | 22 | says `app sync --all`; `--all` was removed (`cmd/sync.go:41`), so the documented command errors |

### Warnings

| Code | File | Line | Note |
|------|------|------|------|
| `STALE_README` | `README.md` | — | `src/api/index.js` changed 14 commits since (latest `a1b2c3d`); re-read for drift |
| `REF_BROKEN` | `docs/dev/architecture.md` | 84 | link to `internal/gone.go` — no such file; repoint or link real target |
| `REF_NOT_IN_GIT` | `README.md` | 30 | link to `docs/private/spec.md` — exists but gitignored; commit or mark external |
| `CONTENT_DRIFT` | `docs/dev/architecture.md` | 57 | says retries are unbounded; `internal/queue/retry.go:12` caps them at 5 |

### Info

| Code | File | Line | Note |
|------|------|------|------|
| `STALE_DOC` | `docs/dev/architecture.md` | — | `src/api/index.js` changed 14 commits since (latest `a1b2c3d`); re-read for drift |
| `MISSING_DIAGRAM` | `docs/dev/architecture.md` | 30 | "Data flow" — `flowchart`; three services fan out to one queue, non-obvious from the prose |
| `WALL_OF_TEXT` | `README.md` | 42 | ~180 words unbroken; split at a topic seam |
| `DENSE_BULLET` | `docs/dev/architecture.md` | 88 | flat bullet ~150 words; break into sub-bullets |
| `SPLIT_CANDIDATE` | `README.md` | 1 | file is 820 lines (> 600); extract a how-to under `docs/` |
| `UNLINKED_REF` | `docs/dev/architecture.md` | 202 | `§10.9` citation, no link; link the section (keep the citation) |
| `COLD_READ` | `README.md` | 12 | "run `sync`" — first-time reader must authenticate first, never stated |
| `MODE_MIXING` | `docs/how-to-rotate-keys.md` | 14 | `how-to` interrupted by an `explanation` detour ("Why signing works…"); move it to a linked concept doc |
| `INCOMPLETE_FOR_TYPE` | `docs/troubleshooting.md` | 8 | `troubleshooting`: 3 symptoms listed with causes but no resolutions — reader can't fix anything |
| `NEEDS_STRUCTURE` | `README.md` | 14 | "Install" — ~6 commands run together as unbroken prose; break into a numbered list |
| `MISSING_DEMO` | `README.md` | 1 | user-facing CLI, no demo; record `init → sync --dry-run → sync` as an asciinema/VHS clip at the top |

Then: "Run /docs-update to fix these findings interactively."

## Stop conditions

- If `check-structure.sh` or `check-staleness.mjs` exits 2 (internal error):
  surface the error to the user; do not proceed.
- If `check-prose.mjs` or `check-refs.mjs` errors (exit 2): surface it and
  skip that deterministic lane rather than falling back to an LLM pass — the
  whole point is reproducibility. Their dependencies ship pre-bundled under
  `scripts/vendor/`, so there is nothing to install; an exit 2 is a real defect
  (or a dangling symlinked doc, named in the error). They need Node.js ≥20,
  and `check-refs.mjs` must run inside a git repo. Also record a
  `LANE_FAILED` **Warning** with `File` `—` naming the lane (`check-prose` /
  `check-refs`), so a crashed lane never reads as clean.
- `lint-mermaid.mjs` exits 1 whenever it reports a finding, warnings
  included; that is a result, not a failure. File each finding under its own
  `severity` (`blocker` / `warning`) with its `line`. Only exit 2 is an
  error: surface it and record a `LANE_FAILED` **Warning** with `File` `—`
  naming the `lint-mermaid` lane.
- A deterministic lane that exits cleanly but reports `scanned: 0` although at
  least one in-scope (for check-refs: tracked) file was passed, or a
  `STALENESS_NOT_ASSESSED` finding, did not inspect anything. Report it as
  such (see Lanes 2–4); never present it as a pass.
- If a Lane 6 subagent fails or returns empty
  (timeout, structural error, or a transient blank reply): re-dispatch up to
  twice, then record a `LANE_FAILED` Warning naming the file and lane.
  **Never** let an empty subagent reply collapse into a silent all-clear —
  that is the failure this guardrail exists to prevent.
