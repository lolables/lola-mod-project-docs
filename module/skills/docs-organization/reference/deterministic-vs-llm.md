# Deterministic where it's unambiguous, LLM where it's fuzzy

Design rationale for the split between what `check-prose.mjs` measures and what
the `/docs-audit` LLM lanes judge: which readability signals are mechanical
enough for a script to enumerate, which are not, and why each remaining check
sits on the side it does. The operative procedure — thresholds, prompts,
finding emission — lives in the script and in the `/docs-audit` command. This
file explains the reasoning behind it, and is loaded on demand rather than at
skill activation.

## Size is mechanical, so the script enumerates it

Size is a mechanical property: a paragraph's *word count*, a bullet's word count,
a file's or section's *line span*. Those are exact and reproducible, so
`check-prose.mjs` triggers on them alone — reading the markdown-it AST (fenced
code, tables, blockquotes, and nested lists distinguished by node type, not
regex) and enumerating byte-identically every run. An LLM asked to *enumerate*
readability problems under-reports on long files (recall fades toward the end)
and two runs disagree, so enumeration is the script's job.

The thresholds themselves are house conventions: they were set when the lane
was introduced and no eval round tuned them (`reference/rule-sources.md`).

## Sentence segmentation is not, so the LLM adjudicates it

What the script deliberately does **not** do is count sentences. Sentence
segmentation is a genuinely hard NLP problem — abbreviations (`e.g.`, `i.e.`,
`vs.`), decimals, initials, ellipses — that no regex gets right; a sentence
counter false-flags abbreviation-heavy technical prose. So the fuzzy judgments
are deferred to the LLM lane, which only ever adjudicates the candidates the
script surfaces: is the rhythm choppy, and is this a dense-prose *genre*
(academic paper, legal text, formal spec) where a `WALL_OF_TEXT` finding
should be suppressed, or a `reference` enumeration (glossary, changelog,
punch list) where `SPLIT_CANDIDATE` may be. Deterministic backbone; LLM for
the judgment residue.

## `DENSE_BULLET` covers the shape `WALL_OF_TEXT` excludes

`DENSE_BULLET` exists because the wall-of-text rule deliberately excludes lists,
so a 150-word flat bullet slips past it. A bullet already broken into
sub-bullets is the desired shape and is never flagged, however long overall.

## `NEEDS_STRUCTURE` measures absence of structure, not size

Every deterministic check above measures the size of a *single* block. The
complementary axis is a procedure spread across *many small* blocks — prose
interleaved with back-to-back command fences, no paragraph long enough to trip
`WALL_OF_TEXT`, no list to trip `DENSE_BULLET`, short enough to duck
`SPLIT_CANDIDATE` — yet with no list or sub-headings to give the eye a rest
point. That is absence-of-structure, not size, so it is judged by the grounded
`NEEDS_STRUCTURE` sub-check in Lane 6 rather than by `check-prose.mjs`. It fires
only on procedural runs (a command-by-command walkthrough, including a README
Install/Quickstart — this one is **not** landing-exempt), and never on
already-listed steps, a short one-or-two-command run, or non-procedural prose.

## Plain language: lexical candidates, LLM judgment

Two plain-language failures are lexical enough to enumerate. A double
negative is a negator (`not`, `no`, `never`, `cannot`, `n't`) followed in
the same clause by a word from a curated negative list, or a fixed phrase
such as `no fewer than`. A slash alternative is `word/word` in running
prose. `check-prose.mjs` finds every candidate on every run.

It reads the DocModel's prose `texts`, so inline code, link text and
targets, headings, simple table cells, and quotations never reach it.

Neither pattern is a verdict. "Does not install the unsupported plugin"
pairs a negator with a negative word that it does not negate, and a bare
`src/lib` looks exactly like `dev/prod`. So the LLM keeps or drops each
candidate and lists the drops, the same split as size: script for recall,
model for judgment.

Noun strings ("shared dev/prod applies") and hidden verbs ("make a
determination") are not lexical. Telling a stack of noun modifiers from an
established compound needs part-of-speech tagging, which would add an NLP
dependency to a module that installs offline with none. A chunked Lane 6
prompt judges them instead. It is chunked for the same reason content drift
is: a whole-document judge under-reports on long files (Rounds 14-15 in
`eval/REPORT.md`). Round 16 measured the chunked prompt.
