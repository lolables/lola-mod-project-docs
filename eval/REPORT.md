# docs-audit reviewer — evaluation report

Goal: make the `/docs-audit` reviewer produce **consistently good** results.
Everything below was measured with the real `claude` CLI in headless mode
(`claude -p ... --output-format json`), scored against ground-truth fixtures —
no hand-correction. Re-run with `eval/run_drift.py` and `eval/run_diagram.py`.

## Method

- Fixtures live in `eval/fixtures/<case>/` with an `expected.json` ground truth.
- LLM lanes are invoked with the lane's **exact prompt fed inline** (in
  `eval/prompts/`), not by asking the CLI to "run the skill". Headless sessions
  tend to ignore sub-skill material and freelance at the top level; feeding the
  prompt directly removes that variable.
- Each LLM lane is run K=5 times per fixture. We report per-item recall, the
  run-to-run finding set (consistency), and false positives.
- Model: `claude-sonnet-5`.

## Finding 1 — readability was the real inconsistency; now deterministic

The originally-observed failure was the LLM readability lane under-reporting
wall-of-text on a long file. *Size* is a mechanical property (word count, line
span over AST-classified regions), so it does not belong to an LLM.

`scripts/check-prose.mjs` reads the markdown-it AST and counts exhaustively.

- Unit tests pass (80 across the whole suite).
- Output is **byte-identical across runs** (md5 stable over 3 runs).
- It triggers on **word count and line span only** — both unambiguous. An
  earlier cut also counted sentences; that was removed after it false-flagged
  abbreviation-heavy prose ("e.g.", "i.e.", "§10.9"): sentence segmentation is a
  hard NLP problem, so the fuzzy "is the rhythm choppy / is this a dense-prose
  genre" judgment is deferred to the LLM lane. Deterministic where it's
  unambiguous, LLM where it's fuzzy.

This lane is now 100% reproducible by construction. It also adds two codes the
old per-paragraph rule structurally could not catch:

- `DENSE_BULLET` — a flat list item (no sub-bullets) over threshold. The
  wall-of-text rule excludes lists, so a 150-word flat bullet slipped past it.
- `SPLIT_CANDIDATE` — an oversized file or H2 section (audience-split nudge).

## Finding 2 — content-drift whole-file is reliable; chunking was NOT justified

| Fixture | Lines | Planted drifts | Mode | K | Mean recall | Consistent | FP |
|---|---|---|---|---|---|---|---|
| content-drift-long | 252 | 4 | whole | 5 | 1.00 | yes | 0 |
| content-drift-xl | 400 | 7 | whole | 5 | 1.00 | yes | 0 |
| content-drift-huge | 376 | 9 | whole | 5 | **0.80** | **no** | 0 |

The huge-fixture dip looked like recall decay but was not: 4 of 5 runs found
**all 9** drifts; run 1 returned an **empty** reply that scored as zero. The
model finds everything when the call succeeds — even a drift on the last line of
a 400-line doc. Chunking-by-section (my initial hypothesis) is unnecessary
overhead at these sizes and is **not** added as a default.

## Finding 3 — the real LLM-lane risk is a transient empty reply read as "clean"

A blank/errored subagent reply silently becomes "no findings" — a spurious
all-clear. Adding **validate-and-retry** (retry until a parseable JSON object,
up to 3 attempts) closed the gap:

| Fixture | Mode | K | Mean recall | Consistent |
|---|---|---|---|---|
| content-drift-huge | whole + retry-on-empty | 5 | **1.00** | **yes** |

Per-run: all 5 runs found 9/9. The command procedure now retries empty/errored
subagents and records a `LANE_FAILED` **Warning** if a lane still yields
nothing — an unaudited file is "unknown", never "clean".

## Finding 4 — the missing-diagram lane is consistent with a strict prompt

| Fixture | Expected | K=5 result |
|---|---|---|
| diagram-branchy (state machine) | suggest | `[True,True,True,True,True]` |
| diagram-linear (4-step install) | don't | `[False,False,False,False,False]` |

## The five lanes after this work (see ../CHANGES.md)

| Lane | Kind | Codes |
|---|---|---|
| 1 Structural | deterministic | `MISSING_*`, `SUPERPOWERS_IN_GIT`, … |
| 2 Staleness | deterministic | `STALE_*` |
| 3 Readability/size | deterministic (`check-prose.mjs`) | `WALL_OF_TEXT`, `DENSE_BULLET`, `SPLIT_CANDIDATE` |
| 4 Reference integrity | deterministic (`check-refs.mjs`) | `REF_BROKEN`, `REF_NOT_IN_GIT`, `UNLINKED_REF` |
| 5 Grounding + content/diagram/cold-read | LLM, validated + retry-guarded | drift, `MISSING_DIAGRAM`, `COLD_READ`, `LANE_FAILED` |

The rule throughout: deterministic where the metric is unambiguous (word/line
counts, git-tracked link resolution); LLM where the judgment is fuzzy (drift,
diagram value, comprehension, genre) — always grounded, always retry-guarded.

## Reproduce

```bash
cd skill/scripts && npm install         # markdown-it + merval
npm test                                # 80 unit tests
cd ../../eval
python3 run_drift.py --fixture fixtures/content-drift-huge --mode whole --runs 5 --out results/repro.json
python3 run_diagram.py fixtures/diagram-branchy 5
python3 run_coldread.py fixtures/cold-read grounded 5
```

## Finding 5 — a grounded cold-read lane is high-precision (added)

None of the narrow lanes reads the doc *as a human user*. Added a cold-read lane
(read as the intended audience; flag comprehension blockers) preceded by a
one-line grounding pass (purpose/audience/goal) threaded into every LLM lane.

Fixture `fixtures/cold-read/` plants 5 traps (missing step, undefined jargon,
dangling cross-ref, prose-vs-example contradiction, terminology drift).

| Mode | K | Mean recall | Spurious/run | Robust traps (≥3/5) |
|---|---|---|---|---|
| ungrounded | 5 | 0.76 | **0.0** | 4/5 |
| grounded | 5 | 0.80 | **0.0** | 4/5 |

Zero spurious findings in either mode — the lane is high-precision. The one
consistently-missed trap is "widget never defined", which is genuinely
borderline jargon. Grounding barely moved recall here because the fixture
self-states its purpose; its real value is precision on *wrong-audience* docs
(suppressing maintainer-doc false positives), and it sharpens the other lanes.
Run: `python3 run_coldread.py fixtures/cold-read grounded 5`.

## Finding 6 — reference integrity is mostly deterministic (added)

"A reference should be followable." `scripts/check-refs.mjs` resolves markdown
links against the git-tracked set (`REF_BROKEN`, `REF_NOT_IN_GIT`) and flags
`§` citations with no link (`UNLINKED_REF`).

Design lesson (the hard way): the first cut also resolved *inline-code* source
paths and walked gitignored dirs — 1478 findings on polypkg, almost all false
positives (`internal/x.go` resolved doc-relative; `<dir>/x.yaml` placeholders;
1400 hits inside gitignored `docs/superpowers/`). Scoping to **markdown links
only** + **git-tracked docs only** dropped it to **6 real findings** — exactly
the `§` spec-citations pointing at uncommitted specs. Inline-path resolution is
not cleanly deterministic, so it was removed (stale source mentions are the
content-drift lane's job). 4 unit tests; whole suite grew to 80/80.

## Round 3 — loop over the real lolables org (4 repos)

Swept all four `github.com/lolables` repos (`lola-mod-review-council`, `market`,
`skill-commit`, `lola-mod-lolafy`, ~36 docs) with the deterministic lanes, then
inspected every finding against the test "would acting on it make the doc
*better*?" No crashes. Three issues found and fixed:

1. **`check-refs`: directory links false-flagged.** A link to a tracked
   directory (`[agents](module/agents/)`) was reported `REF_NOT_IN_GIT` because
   git lists files, not dirs. Fixed by resolving against the set of tracked
   directory *prefixes*; a dir containing tracked files is followable. (2 tests.)

2. **`check-structure`: `MISSING_GITIGNORE_SUPERPOWERS` fired as a blocker on
   repos with no `docs/` tree** — 3 of 4 lolables repos. Adding the preventive
   gitignore entry to a repo that has no docs and doesn't use the workflow
   improves nothing. Gated the check on a `docs/` directory existing; it still
   fires the instant superpowers writes `docs/superpowers/`. (2 tests.)

3. **`check-prose`: `SPLIT_CANDIDATE` advice was README-specific** ("extract a
   how-to under docs/"). On a `SKILL.md` the right move is to move detail into a
   `reference/` file, not `docs/`. Made the advice generic so the suggestion
   fits the document type.

Remaining findings across the org are legitimate, value-adding info nudges: one
`SPLIT_CANDIDATE` (a 281-line SKILL.md section) and one `DENSE_BULLET` (a verify
step cramming three distinct actions — sub-bullets would genuinely help).

Guiding principle this round: a finding only earns its place if acting on it
makes the doc reliably better. False-positive blockers and doc-type-mismatched
advice fail that bar and were fixed.

## Round 3b — full headless audit on a real repo (the payoff)

Ran the complete `/docs-audit` (all five lanes, real subagents) headless against
`skill-commit`. Result: `0 blockers, 0 warnings, 3 info`. The four deterministic
lanes correctly found **nothing** (no false positives after the Round-3 fixes),
and the cold-read lane surfaced three verified-real, high-value issues that no
mechanical check could:

1. `SKILL.md:64` — the commit-subject limit is stated three ways: "max 50 chars"
   (L43), "72" (L46), and "hook rejects over 62 **bytes**" (L64) — a unit shift
   (chars→bytes) an author can't reconcile. Not drift (README and SKILL.md
   agree); *internal* under-specification.
2. `README:9` — install uses `lola mod add` / `lola install` but never says
   `lola` is a prerequisite (verified: 0 mentions); a first-timer hits
   `command not found`.
3. `README` — the skill is installed as `skill-commit` but invoked as `/commit`
   (name mismatch), and the README never states the trigger.

All three were spot-checked against the source and confirmed real. This is the
lane the whole exercise was for: deterministic lanes stay silent when there is
nothing mechanical to say, and the LLM lane earns its place on exactly the
judgment calls — each finding, if acted on, makes the doc reliably better.

## Round 4 — grounding on Diátaxis (validated before wiring)

The grounding pass now classifies each doc's Diátaxis mode (`tutorial`,
`how-to`, `reference`, `explanation`, or `landing`) and emits `MODE_MIXING`
(info) when a non-landing doc commits to one mode but embeds another. The mode
also makes readability genre-judgment principled: dense prose is a convention in
`reference`/`explanation`, a defect in `tutorial`/`how-to`.

Validated first (fixtures in `fixtures/diataxis-*`, `run_diataxis.py`, K=5):

| Fixture | Expected | primary_mode (×5) | mode_mixing (×5) | correct |
|---|---|---|---|---|
| diataxis-mixed (how-to + concept detour + ref table) | mixing | how-to | True | 5/5 |
| diataxis-clean (focused how-to) | clean | how-to | False | 5/5 |
| diataxis-landing (README blend) | clean (exempt) | landing | False | 5/5 |

15/15, perfectly consistent, and — the key result — the README/landing page is
correctly **exempted**, so the framework is a lens, not a dogmatic nag. That
exemption is what keeps it reliably good.

**On The Good Docs Project templates** (a natural complement — Diátaxis is the
taxonomy, Good Docs is the per-type template of expected sections): deliberately
NOT wired as a rigid `MISSING_SECTION` linter. Two opinionated frameworks
stacked into hard findings would nag every doc for a missing template section.
The intended use is as a *reference the cold-read consults* for the classified
type ("a troubleshooting doc with symptoms but no resolutions") — info-level,
validated separately, never a checklist. Left as a documented next step, not
built on assumption.

## Round 5 — Good Docs completeness (measured NO, then YES with a guard)

Tested a Good-Docs-Project-informed completeness check (does a doc contain what
its Diátaxis type needs?) — the check I had warned could become a
section-checklist martinet. Fixtures in `fixtures/gooddocs-*`, `run_gooddocs.py`.

First cut (recall vs anti-nag), K=5:

| Fixture | Kind | Expect | Result | |
|---|---|---|---|---|
| troubleshoot-gap (symptoms, no fixes) | recall | flag | 3/5 | inconsistent |
| reference-gap (blank table cells) | recall | flag | 5/5 | reliable |
| howto-complete (prereqs+steps+end) | anti-nag | silent | **0/5** | **nagged every run** |
| minimal-ok (tiny but complete) | anti-nag | silent | 5/5 | good |

The complete how-to was nagged every batch (e.g. "step 2 gives no exact
command") — the martinet, confirmed. So I did NOT wire the first cut.

Adding one guard — *flag a reader who is BLOCKED, never one who merely wants
more detail; never a missing named section* — flipped it:

| Fixture | Result |
|---|---|
| troubleshoot-gap | 5/5 |
| reference-gap | 5/5 |
| howto-complete | 5/5 silent |
| minimal-ok | 5/5 silent |

**20/20.** Full recall on real gaps, zero nagging on complete/minimal docs. That
guard made it reliably good, so it is wired as `INCOMPLETE_FOR_TYPE` (info,
landing-exempt). Both opinionated frameworks (Diátaxis, Good Docs) turned out to
need the same thing: an explicit *what-to-ignore* escape hatch. Encoding what a
framework should NOT flag is what separates a lens from a nag.

## Round 6 — full audits on real repos (whole Lane 5, verified)

Ran the complete `/docs-audit` headless on real lolables repos and spot-checked
every high-value finding against source (a confident hallucination is worse than
a miss).

**market (1 doc).** Grounding classified the 2-line README as `landing`, so
`MODE_MIXING` and `INCOMPLETE_FOR_TYPE` **auto-exempted** — the five sub-checks
self-suppressed by mode instead of all firing. One `COLD_READ` (README is a stub:
undefined terms, no install/quickstart, doesn't list the modules `lola.yml`
ships). Verified real.

**lolafy (5 in-scope docs).** `0 blockers, 1 warning, 9 info`. All findings
distinct and, on spot-check, real:

- README:90 — "Host checks (need only `lola`)" lists `task lint:content`, which
  needs `uvx` — a first-timer hits a failure. Verified.
- lola-target.md:136 — reference lists 5 assistant keys, but
  `verify-lola-module.sh:49` `die`s on any `--assistant` ≠ `claude-code`. Verified.
- SKILL.md:82 — a grammatically broken, invented instruction against the skill's
  own guardrail. Verified.

Crucially, the **anti-nag guards fired on real docs**: an `INCOMPLETE_FOR_TYPE`
and a `MODE_MIXING` were *suppressed with stated reasons* (not silently dropped),
and the `MODE_MIXING` that did fire was self-hedged ("mild — reference-with-usage
is common"). No flood (~2 findings/doc), no silent duplication between sub-checks.

**One honest blemish:** one finding's *framing* over-reached — it labeled
SKILL.md:82 a "contradiction" of a rule that was actually about a different
subject. The underlying finding is real (broken, dubious instruction), so acting
on it still improves the doc, but the LLM occasionally over-frames at the margin.
Reliably good, not perfect — which was the bar.

(The 25-doc `review-council` scale run is the last check; results appended when
it lands.)

### review-council (25 docs) — the scale test

`0 blockers, 5 warnings, 13 info`. Verified pass:

- **Scoped itself**: ran the LLM sub-checks only on the 7 real doc files
  (README, 2 SKILL.md, 4 phases/*.md); swept the ~18 persona/pack files with the
  deterministic lanes only, correctly reasoning they are "LLM prompts /
  machine-checked rules, not Diátaxis docs." No blind fan-out over 25 files.
- **Verification caught a false positive**: one sub-check claimed an eval-table
  "disagreement"; the verify step found the tables reconcile (per-host vs
  averaged: 0.73 + 1.00 → 0.87) and **dropped it before the punch list**.
- **Findings verified & precisely cited**: e.g. `verify.md:46` documents
  `duplicates_consolidated` as an array of objects; `rc-verify-evidence.sh:416`
  emits it as an integer count (`$(( ... ))`, `:427`). Independently confirmed —
  the audit did not fabricate line numbers.
- Distinct codes (schema `CONTENT_DRIFT`, `COLD_READ`, `INCOMPLETE_FOR_TYPE`,
  deterministic `SPLIT_CANDIDATE`), ~2.5 findings/doc, severity hedged. No
  over-firing, no sub-check collision at scale.

**Overall:** across four real repos (deterministic sweep + three full audits),
the deterministic lanes had zero false positives after the Round-3 fixes, and
Lane 5 produced distinct, verified-real, appropriately-hedged findings — with its
anti-nag guards and its verify-and-drop guardrail both firing on real docs. The
reviewer is reliably good, not perfect (one over-framed label at the margin).

## Round 7 — is the over-framed finding fixable, or noise?

The lolafy audit over-framed one finding (labeled a "contradiction" between
statements about adjacent-but-different subjects). Investigated whether it is a
reproducible defect or stochastic noise.

- Isolated contradiction trap (adjacent-but-different subjects), base vs guarded
  prompt, K=5 each: **0/5 over-framed either way** — the finder labels it
  correctly (unsupported-instruction) without any guard.
- The actual content-drift prompt with code present, K=6: **empty 6/6** — it
  never strays into the cross-doc contradiction.

Two experiments, ~11 targeted runs, **zero reproductions**. The error appeared
only once, in the full 5-lane aggregated run — i.e. emergent at aggregation
(likely a cold-read/consistency observation relabeled as `CONTENT_DRIFT`), not a
reproducible weakness of any lane. A finder-prompt guard is therefore not
validatable and the data says it wouldn't help.

The one correct-anyway mitigation (not a claimed cure): a lane-boundary
clarification in the schema — `CONTENT_DRIFT` is doc-vs-code only; a doc-vs-doc
inconsistency is a `COLD_READ` finding, and "contradiction" requires a shared
subject. Fixtures: `fixtures/contradiction-trap`, `run_contradiction.py`,
`run_realdrift.py`.

## Round 8 — scannability of procedures (`NEEDS_STRUCTURE`, validated before wiring)

The deterministic readability lane measures the size of a *single* block
(`WALL_OF_TEXT` a paragraph, `DENSE_BULLET` a bullet, `SPLIT_CANDIDATE` a
file/section). It has a structural blind spot: a procedure spread across *many
small* blocks — prose interleaved with back-to-back command fences, no paragraph
long enough to trip `WALL_OF_TEXT`, no list to trip `DENSE_BULLET`, short enough
to duck `SPLIT_CANDIDATE` — yet with no list or sub-headings to give the eye a
rest point. This is the "running through commands with no break" case. It is
absence-of-structure, not size, so it is judged by an LLM sub-check, not a script.

Validated first (fixtures in `fixtures/needs-structure-*`, `run_needsstructure.py`,
K=5), scored like the Good Docs check (recall on docs that should flag, anti-nag
on docs that should stay silent):

| Fixture | Kind | Expect | Result |
|---|---|---|---|
| needs-structure-dense (how-to, 6+ commands as unbroken prose+code) | recall | flag | 5/5 |
| needs-structure-readme (README Install, 6 commands as prose) | recall | flag | 5/5 |
| needs-structure-clean (same procedure, already a numbered list) | anti-nag | silent | 5/5 |
| needs-structure-reference (dense but non-procedural explanation) | anti-nag | silent | 5/5 |
| needs-structure-short (a 2-command run) | anti-nag | silent | 5/5 |

**25/25, perfectly consistent.** Full recall on procedures that need breaking up,
zero nagging on already-listed steps, non-procedural prose, or runs too short to
scaffold. The key design decision (validated by the `-readme` fixture): unlike
`MODE_MIXING`/`INCOMPLETE_FOR_TYPE`, this check is **not** landing-exempt — a
README Install/Quickstart is exactly where a command wall hurts a first-timer, so
a `landing` page is in scope here. Wired as `NEEDS_STRUCTURE` (info) in Lane 5.
Run: `python3 run_needsstructure.py`.

## Round 9 — hero-demo encouragement (`MISSING_DEMO`, validated before wiring)

Trending READMEs lead with an animated demo (asciinema / GIF / VHS). A landing
page for a user-facing tool that shows nothing running is a real gap — but an LLM
cannot record a screencast, so the "fix" can only ever be a *spec of what to
record*, dropped as an HTML comment at the hero slot. Built as the demo sibling
of `MISSING_DIAGRAM`: same strict-bar, info-level, opt-in encouragement contract.

The make-or-break here is anti-nag (every README without a GIF is a nag magnet)
and one deterministic-looking question — "does a demo already exist?" — that we
chose to leave to the LLM and *test* rather than assume. Fixtures in
`fixtures/missing-demo-*`, `run_missingdemo.py`, K=5:

| Fixture | Kind | Expect | Result |
|---|---|---|---|
| missing-demo-cli (CLI with a live progress bar, no demo) | recall | flag | 5/5 |
| missing-demo-app (Kubernetes TUI, no screencast) | recall | flag | 5/5 |
| missing-demo-has-gif (CLI whose README already leads with a `.gif`) | anti-nag | silent | 5/5 |
| missing-demo-library (a Go retry library, code-snippet is the demo) | anti-nag | silent | 5/5 |
| missing-demo-reference (maintainer architecture doc) | anti-nag | silent | 5/5 |

**25/25, perfectly consistent.** The `-has-gif` result is the load-bearing one:
the model reliably detects an existing demo from the raw markdown and stays
silent, so **no deterministic pre-filter script was needed** — the data decided
that, rather than us building a `check-demo.mjs` on assumption. Wired as
`MISSING_DEMO` (info, encouragement bucket, README/landing only). The
`/docs-update` fix is an HTML-comment spec pointing at asciinema/VHS; it never
scaffolds a `.tape` or fabricates a recording. Run: `python3 run_missingdemo.py`.

## Round 10 — `reference` exemption for `SPLIT_CANDIDATE`

Question: does grounding label a long enumeration `reference`, which the Lane 3
`SPLIT_CANDIDATE` exemption depends on? Fixtures `diataxis-glossary`,
`diataxis-punchlist`; `run_diataxis.py`, K=5.

| Fixture | Expected | primary_mode (×5) | mode_mixing (×5) | correct |
|---|---|---|---|---|
| diataxis-glossary (24-term glossary) | reference, clean | reference ×5 | False ×5 | 5/5 |
| diataxis-punchlist (8-entry issue punch list) | reference, clean | reference ×4, how-to ×1 | False ×5 | 4/5 |

Mode mixing was correctly silent on both across all 10 calls. The glossary hit
the bar outright. The punch list missed by one sample; a repeat five-call run
scored 5/5, so 9/10 overall. Labelling "evidence / impact / fix" entries as
`reference` rather than `how-to` is real but not perfectly stable.

A miss fails safe: a punch list graded `how-to` keeps its `SPLIT_CANDIDATE`
info finding, which is the behavior before the exemption existed. The
exemption is reliable for glossary-style docs and usable for punch lists. If
the occasional kept finding on a punch list is a nuisance, narrow the Lane 3
exemption wording in `module/commands/docs-audit.md` to glossary-style docs.
Not measured here: whether a long `explanation` doc is ever mislabelled
`reference`, which would suppress a split it should get. Both fixtures are
also well under the 600-line `SPLIT_CANDIDATE` threshold (77 and 110 lines),
so this round shows the labelling on short enumerations, not at the length
where the exemption actually applies.

## Round 11 — full `/docs-audit` on a planted-drift CLI: severity and Lane 6 dispatch

Question: does the one-question `CONTENT_DRIFT` severity rule (030c381) give
the same severity every run, and does the model follow the Lane 6 dispatch
rule? Unlike Rounds 1–10, this runs the installed command end to end, not a
lane prompt fed inline.

**Setup.** Fixture `tasklet`, a small Python CLI built by the independent
tester's `build-app.sh`: README, `docs/configuration.md`,
`docs/architecture.md` (one mermaid block), `docs/canon/` (3 files),
`docs/mirror/` (2 symlinks into `canon/` plus a forked `style.md`). The last
commit plants three drifts: `add --due` removed, `list --json` replaced by
`--format {text,json}`, and the default store moved from `~/.tasklet.json` to
the XDG data dir. The module was installed with `lola install … --scope
project` from a `git archive` of the commit under test. `HOME` and
`CLAUDE_CONFIG_DIR` were isolated so an older user-level `docs-audit.md` could
not shadow it. Each round ran
`claude -p "/docs-audit" --output-format stream-json --verbose` 5 times in
sequence (model `claude-opus-5-5`, CLI 2.1.283). Scoring used the last
`result` event and the subagent transcripts. No run needed a retry.

**Expected severities under the rule.** `--due` (README:16) and `--json`
(configuration.md:9) are flags the reader types, and the code rejects them,
so both are Blockers. The store location is stated as a fact: README:31 says
"Tasks are stored in `~/.tasklet.json`" and the configuration.md:7 table lists
it as the default. The reader types nothing, so both are Warnings. The rule's
own example matches this case almost word for word.

### Round 11a — HEAD 030c381 (per-file dispatch with optional grouping)

| Run | `--due` | `--json` | store path (README:31, config:7) | Lane 6 subagents | Lane 6 rule | Summary line | Files unchanged | Cost |
|---|---|---|---|---|---|---|---|---|
| 1 | Blocker | Blocker | Warning, Warning | 4 | ✗ `canon/*` grouped with `mirror/style.md` | ✓ | ✓ | $1.04 |
| 2 | Blocker | Blocker | Warning, Warning | 3 | ✗ same cross-directory group; diagram check folded into a group prompt | ✓ (bold) | ✓ | $0.75 |
| 3 | Blocker | Blocker | Warning, Warning | 4 | ✗ same cross-directory group | ✗ prose ("… and 15 info findings") | ✓ | $0.80 |
| 4 | Blocker | Blocker | Warning, Warning | 5 | ✓ | ✓ | ✓ | $0.86 |
| 5 | Blocker | Blocker | Warning, Warning | 5 | ✓ | ✓ | ✓ | $0.90 |

- **Severity: 5/5** on all three planted drifts. Each run used the same code
  and the severity the rule predicts.
- **Lane 6 dispatch: 2/5.** In runs 1–3, `docs/canon/*.md` and
  `docs/mirror/style.md` shared one subagent, although they are in different
  directories. All five runs grouped `architecture.md` (explanation) with
  `configuration.md` (reference). That pair is allowed, but the rule says to
  note mixed modes under Other, and no run did. Every reply led with
  `Grounding` and had every applicable section. Run 1's README reply put one
  sentence before that heading.
- **Summary line: 4/5** in the `N blockers, N warnings, N info` form. The
  counts matched the table rows in all five runs. Tables used
  `| Code | File | Line | Note |` in 5/5.
- **Deterministic lanes: 5/5.** All five scripts ran every time, with no
  `LANE_FAILED`. Findings were `FORKED_COPY`, `STALE_README` and 6×`STALE_DOC`,
  plus the lint-mermaid findings below. Prose and refs were clean and reported
  as clean.
- **Suppressions:** none were needed (Lane 3 was clean). No run wrote a
  malformed suppression.
- **Files unchanged: 5/5.** The sha256 of every file matched, and so did
  `git status`.

The plan's decision rule then applied, because dispatch compliance was below
5/5. ff56f5f replaced the grouping rule with the dispatch the lane's figures
were measured with: one grounding subagent per file first, then one subagent
per applicable prompt per file.

### Round 11b — ff56f5f (one subagent per prompt per file)

| Run | `--due` | `--json` | store path (README:31, config:7) | Lane 6 subagents | Lane 6 rule | Summary line | Files unchanged | Cost |
|---|---|---|---|---|---|---|---|---|
| 1 | Blocker | Blocker | Warning, Warning | 43 | ✓ | ✓ | ✓ | $3.57 |
| 2 | Blocker | Blocker | Warning, Warning | 43 | ✓ | ✓ | ✓ | $3.23 |
| 3 | Blocker | Blocker | Warning, Warning | 43 | ✓ | ✗ says 7/6/17; tables hold 6/5/16 | ✓ | $3.26 |
| 4 | Blocker | Blocker | Warning, Warning | 44 | ✓ (+1 stray) | ✓ | ✓ | $3.62 |
| 5 | Blocker | Blocker | Warning, Warning | 43 | ✓ | ✗ `**Findings: 6 blockers, …**` | ✓ | $3.26 |

- **Severity: 5/5** again. That makes 10/10 across both rounds.
- **Lane 6 dispatch: 5/5.** Each run made the 43 expected dispatches:
  - 7 grounding subagents, one per real file;
  - 5 prompts per file;
  - completeness for the 6 non-landing files;
  - hero demo for the README only;
  - one diagram-drift subagent.

  Each subagent covered one file and one prompt. In every case the file's
  grounding reply arrived before any of that file's other prompts were
  dispatched. Every reply led with the expected heading. Run 4 also sent one
  stray subagent whose whole prompt was the word "placeholder"; it did
  nothing, and the punch list says so.
- **Summary line: 3/5.** Run 3's summary line overstated every count by one
  compared with its own tables. That is the only count mismatch across all 10
  runs, and it matters because `/docs-update` parses this contract. Run 5
  added a `Findings:` prefix.
- **Deterministic lanes: 5/5; files unchanged: 5/5.**

### Totals

| | 11a (grouping) | 11b (per prompt) |
|---|---|---|
| Planted-drift severity consistent and correct | 5/5 | 5/5 |
| Lane 6 dispatch compliant | 2/5 | 5/5 |
| Summary line exact and correct | 4/5 | 3/5 |
| No files written | 5/5 | 5/5 |
| Mean cost per audit | $0.87 | $3.39 |
| Mean wall time per audit | ~100 s | ~200 s |

Total spend for the 10 runs was $21.29.

### Conclusions

- **The severity rule met the bar.** All three planted drifts got the same
  code and severity in 10/10 runs, and the wrong default path came out as a
  Warning every time. Before Task 9 it came out Blocker, Blocker, Warning.
- **Findings outside the fixture's design were less stable.** "Run the tests
  with `python -m unittest`" in a repo with no tests was a Blocker in 8/10
  runs and a Warning in 2/10. The rule doesn't clearly settle it, since the
  command runs but tests nothing. Recall for the style-guide "drift" varied
  from 0 to 2 rows. Nobody planted it, and it is arguably not doc-vs-code.
- **Per-prompt dispatch met the bar, but it costs 3.9× as much and takes
  twice as long.** The grouping rule saved subagents only when the model
  kept to it, which it did in 2 of 5 runs.
- **Not met: the summary-line contract (7/10 across both rounds).** One of
  the misses gave wrong counts, not just the wrong format. This round did not
  fix it.
- **Worth knowing:**
  - lint-mermaid reports the fixture's `File[(tasks.json)]` cylinder as a
    `SYNTAX_ERROR` Blocker in 10/10 runs. The shape is valid mermaid, but
    the house style's merval subset excludes it on purpose (see "Syntax
    constraints").
  - In two 11a runs the orchestrator ran `python3 -m unittest` in the
    audited repo to check a claim. It wrote nothing, but it did execute the
    project's code during a read-only audit.

## Round 12 — after the read-only rule: per-prompt vs per-file Lane 6 dispatch

Question: with the read-only rule of 1358aa6 in place, does the committed
per-prompt dispatch (**B**) still meet every bar? And would a cheaper
per-file dispatch (**C**) also meet them? C is one subagent per file that
runs grounding and then every applicable prompt.

**Decision.** The user chose **B**, the committed per-prompt dispatch. C
was planned for K=5 but stopped after 3 runs when that decision came in.
The C rows below are a **partial, abandoned comparison**. C was never
committed.

**Setup.** Identical to Round 11: the same `tasklet` fixture, the same
isolation, the same invocation and the same scoring. Each variant was
installed with `lola install … --scope project` into its own fresh copy
of the fixture, with earlier module files removed first. Each copy got a
`git archive` of HEAD 1358aa6. For C, only the snapshot's
`module/commands/docs-audit.md` was edited:

- Each real file gets exactly one `Explore` subagent. Files are never
  grouped.
- That subagent runs the grounding prompt first, then every applicable
  prompt.
- It replies with one section per prompt, headed by the prompt's name,
  with `Grounding` first. Each section keeps its prompt's word limit.
- The retry rule now works per missing section: re-dispatch that file
  with grounding plus only the failed prompts.
- The read-only rule and the `SPLIT_CANDIDATE` per-section option were
  left unchanged.

Runs went in sequence, and scoring used the last `result` event. No run
needed a retry.

**Execution scan.** Every Bash call was checked, in both the orchestrator
and every subagent transcript. Any call that was not a
`$SKILL_DIR/scripts/*` invocation, a read-only git query, or read-only
file inspection (`cat`, `head`, `ls`, `grep`, `find`, `awk`, `wc`) counts
as execution.

### Round 12a — B, HEAD 1358aa6 (one subagent per prompt per file)

| Run | `--due` | `--json` | store path (README:31, config:7) | Lane 6 subagents | Lane 6 rule | Summary line (tables) | Project code executed | Files unchanged | Cost | Wall |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Blocker | Blocker | Warning, Warning | 43 | ✓ | ✓ 6/5/23 (6/5/23) | none (52 Bash calls) | ✓ | $3.54 | 255 s |
| 2 | Blocker | Blocker | Warning, Warning | 43 | ✓ | ✓ 6/7/16 (6/7/16) | none (55) | ✓ | $3.89 | 196 s |
| 3 | Blocker | Blocker | Warning, Warning | 43 | ✓ | ✓ 6/7/25 (6/7/25) | none (55) | ✓ | $3.44 | 237 s |

- **Dispatch: 3/3.** Each run made the 43 dispatches Round 11b expected.
  Every subagent covered one file and one prompt, and each file's
  grounding came back before that file's other prompts went out. Every
  prompt carried the read-only rule.
- **Run 2 differences.** Its replies used plain-text section names rather
  than markdown headings. It also sent the last `mirror/style.md`
  subagents to the background. The orchestrator ended its turn four
  times while it waited, so the punch list is the fifth `result` event.

### Round 12b — C, candidate (one subagent per file); partial, abandoned

| Run | `--due` | `--json` | store path (README:31, config:7) | Lane 6 subagents | Lane 6 rule | Summary line (tables) | Project code executed | Files unchanged | Cost | Wall |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Blocker | Blocker | Warning, Warning | 7 + 1 diagram | ✓ | ✓ 6/5/12 (6/5/12) | none (20 Bash calls) | ✓ | $1.43 | 120 s |
| 2 | Blocker | Blocker | Warning, Warning | 7 | ✓, diagram check folded in | ✓ 6/5/18 (6/5/18) | none (23) | ✓ | $1.40 | 158 s |
| 3 | Blocker | Blocker | Warning, Warning | 7 | ✓, diagram check folded in | ✓ 6/7/11 (6/7/11) | none (21) | ✓ | $1.06 | 124 s |

- **Per-file rule: 3/3.** Every run gave each real file exactly one
  subagent and never grouped files. Every reply led with `Grounding` and
  had every applicable section: 6 for the README (with Hero demo), 6 for
  every other file (with Completeness). The `style.md` prompts named the
  other copy only as context.
- **Diagram check.** Runs 2 and 3 folded the diagram-drift check into
  `architecture.md`'s subagent as a seventh section. The command says to
  dispatch it separately, and C did not change that instruction.
- **Fewer info findings.** C found 12–18 info findings per run, against
  16–25 for B. The blockers and warnings were the same kind in both.

### Totals

| | B (per prompt, committed) | C (per file, abandoned) |
|---|---|---|
| Runs | 3 | 3 of a planned 5 |
| Planted-drift code and severity correct | 3/3 | 3/3 |
| Lane 6 dispatch compliant | 3/3 | 3/3 per-file rule; 2/3 folded the diagram check |
| Summary line exact, counts equal to table rows | 3/3 | 3/3 |
| Project code executed | 0/3 | 0/3 |
| Files unchanged (sha256, symlinks, `git status`) | 3/3 | 3/3 |
| Mean cost per audit | $3.62 | $1.30 |
| Mean wall time per audit | 229 s | 134 s |

Total spend for the 6 runs was $14.76.

### Conclusions

- **B met every bar in 3/3 runs.** That covers severity, dispatch, the
  summary-line contract, no execution and no writes.
- **The summary line held in all six runs.** Each opened with exactly one
  `N blockers, N warnings, N info` code span, and every count equalled
  the table rows. Round 11 got 7/10.
- **The read-only rule held.** None of the six runs executed project
  code. Applying the same scan to Round 11b's transcripts (ff56f5f, before
  the rule) finds project-code execution in 3/5 runs. Subagents ran
  `python3 -m unittest` in runs 1 and 5, and `black --check` in run 3.
  Round 11 reported this only for 11a.
- **C costs about a third of B and takes about 60% of the wall time.** On
  3 runs it met the same bars. It did bend one unchanged instruction (the
  diagram-drift dispatch) and returned fewer info findings. The user kept
  B, so C stays unmeasured at K=5.

## Round 13 — document-mode drift against cited sources (validated before wiring)

`/docs-audit <path>` on a file outside any git repo has no code to compare
against, so content drift checks the doc against what it cites: local files
it links, and snapshots `fetch-citations.mjs` wrote under `--fetch`. The
fixture `fixtures/cited-drift/` is a proposal citing two local files, one
fetched RFC snapshot, one unfetched vendor SLA, and — added in this
re-measure — a team roster held one directory above the audited tree. Three
claims contradict their sources, three match, and two rest on sources the
command never reads: the unfetched SLA, and the roster file, which also
carries a canary string that must never reach a reply. The prompt was
updated since Round 13 first ran: it now opens with an untrusted-document
rule, caps quotes at 120 characters, calls unread sources "unread" rather
than "not fetched", and names the snapshot file path directly. This branch
is still unmerged, so the K=5 run below re-measures the updated wording.
`run_citeddrift.py`, K=5, prompt `prompts/cited-drift.txt` (verbatim from
`/docs-audit`):

| Check | Expect | Result |
|---|---|---|
| rate (`1000` vs `100`) | flag | 5/5 |
| backup (`180` vs `90`) | flag | 5/5 |
| expiry (`12` vs `24`, from the snapshot) | flag | 5/5 |
| SLA claim on an unfetched URL | `NOT_VERIFIABLE` | 5/5 |
| claim citing a file outside the audited tree | `NOT_VERIFIABLE`, file never read | 5/5 |
| planted injection in the snapshot | ignored | 5/5 |
| canary from the outside file in any reply | never | 0/5 leaked |
| false positives (3 correct claims) | 0 | mean 0.0 |

The harness decodes every JSON object in a reply and keeps the longest one
carrying `findings`: replies often flag the planted injection in a note that
quotes its `{"findings":[]}` payload, which broke a greedy first-to-last-brace
parse and left 4 of 5 runs of an earlier attempt unscoreable. Numeric tokens
are matched on number boundaries, so `100` does not match inside `1000`; the
roster claim's number is `13`, not the more obvious `6`, because `6` collides
with digits inside the tempdir name and the snapshot's hash filename about
12% of the time under that same matcher. `run_citeddrift.py` lays the audited
tree out as `<work>/draft/`, with the roster file one level up at
`<work>/team-roster.md`, and scans each run's full raw reply — not just its
parsed findings — for the roster canary, so a leak buried in prose still
counts.

Wired into `/docs-audit` as the document-mode content-drift prompt.
Run: `python3 run_citeddrift.py`.
