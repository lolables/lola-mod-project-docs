# docs-discipline — agent context for working on this repo

## Rules

- **No autonomous behavior.** Both skill descriptions keep the
  `DO NOT AUTO-INVOKE.` prefix. Do not add auto-trigger keywords to either.
- **Use `$SKILL_DIR` for every `scripts/...` / `reference/...` path** in
  skill and command files. Never hardcode `.claude/skills/...` or search
  candidate paths.
- **Unit tests go in `tests/scripts/<skill>/`, never under `module/`** —
  everything in `module/` ships to users.
- **Do not wrap `lola`** in Taskfile tasks; the README documents raw `lola`
  commands.
- **`scripts/vendor/` is generated.** Never hand-edit or delete it. After any
  dependency bump, run `task vendor` and commit the result — CI fails on a
  non-empty `git diff` there, and `task check` does not catch it locally.
- Before adding a document format or bumping npm/Linguist pins, read
  `docs/dev/maintaining.md`. Before touching `scripts/vendor/` or
  `.taskfiles/vendor/`, read `docs/dev/vendoring.md`.

## Done means `task check` is green

Add `MODE=llm` to any `task check` gate for errors-only output.

## House voice (applies to every Markdown file you edit)

**Show, don't tell.** A worked example beats a description. If a command
produces output, show a realistic sample of it. If a template gets filled in,
ship one filled-in example, not just the blank.

**Readability — the "four ideas" test.** A paragraph that enumerates several
mechanisms or rules forces the reader to hold them all at once. Break it into
sub-bullets, or add vertical whitespace at the topic seams, so the eye lands on
one beat at a time. Restructuring into bullets is expected when a paragraph
lists several distinct points.

**Cut the tells.** Prefer plain verbs and concrete nouns. Watch for and remove:

- Banned words and phrases (booster adverbs, brochure verbs, `worth noting`
  and `in order to` scaffolds): `task lint:voice` enforces them;
  `.taskfiles/scripts/lint-voice.mjs` is the list. Write a mention of a
  banned word as inline code.
- "X — but only when Y" as a section title.
- Uniform rhythm: several same-length sentences in a row, or an em-dash in
  every sentence. Vary it.

**Never touch on a voice edit:** technical claims, code blocks, commands, file
paths, exact finding codes, and error strings. Voice work changes register and
rhythm, not facts. When in doubt, preserve verbatim.

## What NOT to change without explicit user direction

- The six slash-command names — these are the documented public API.
- The two skill names (`docs-organization`, `adr`).
- The MADR 4.0 template structure under
  `module/skills/adr/reference/madr-template.md` — `/adr-new` and
  `/adr-review` both depend on its sections.
- The four palette names + the palette-class naming (`sysA`…`sysF`,
  `edgeLabel`) — every diagram in every project that uses the module
  references them by name.
