# Rule sources for writing-quality findings

Which published rule each writing-quality finding code enforces, or whether
it is a house convention of this module. `/docs-audit` prints a **Rule
sources** list from this file, so an author can open the rule a finding
holds them to and argue with it. Text in quotation marks is verbatim from
the source; unquoted text summarises it.

Tool-correctness codes have no row. They enforce the module's own
conventions or factual accuracy, not a writing rule: structure, staleness,
references, mermaid syntax and palette classes, content drift, citations,
and `LANE_FAILED`.

## External rules

| Code | Authority | Rule | Source |
| --- | --- | --- | --- |
| `DOUBLE_NEGATIVE` | Google developer documentation style guide, Write for a global audience | "Avoid negative constructions when possible." This check enforces only the double case. | <https://developers.google.com/style/translation> |
| `SLASH_ALTERNATIVE` | Google developer documentation style guide, Slashes | "Don't use slashes to separate alternatives." | <https://developers.google.com/style/slashes> |
| `NOUN_STRING` | Google developer documentation style guide, Write for a global audience | "don't use more than two nouns as modifiers of another noun" | <https://developers.google.com/style/translation> |
| `HIDDEN_VERB` | digital.gov plain-language guide, Writing | "A hidden verb (or nominalization) is a verb converted into a noun. It often needs an extra verb to make sense." | <https://digital.gov/guides/plain-language/writing> |
| `NEEDS_STRUCTURE` | Google developer documentation style guide, Procedures | "A procedure is a sequence of numbered steps for accomplishing a task." | <https://developers.google.com/style/procedures> |
| `COLD_READ` | Google developer documentation style guide, Jargon and Abbreviations — the undefined term or acronym category only | "define the term in plain language on the first occurrence"; "Spell out abbreviations on first reference." | <https://developers.google.com/style/jargon>, <https://developers.google.com/style/abbreviations> |
| `MODE_MIXING` | Diátaxis | Four documentation modes (tutorial, how-to, reference, explanation), each serving one reader need; a document that commits to one should not interrupt it with another. | <https://diataxis.fr> |
| `INCOMPLETE_FOR_TYPE` | The Good Docs Project | Each document type must contain what its reader needs; the project's templates define those parts. | <https://www.thegooddocsproject.dev> |
| `LOW_CONTRAST_TEXT` | WCAG 2.2, SC 1.4.3 Contrast (Minimum) | Text needs "a contrast ratio of at least 4.5:1". | <https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html> |
| `LOW_CONTRAST_LIGHT_BG`, `LOW_CONTRAST_DARK_BG` | WCAG 2.2, SC 1.4.11 Non-text Contrast | Graphical objects need "a contrast ratio of at least 3:1 against adjacent color(s)". | <https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html> |

## House conventions

| Code | Authority | Rule | Source |
| --- | --- | --- | --- |
| `WALL_OF_TEXT`, `DENSE_BULLET`, `SPLIT_CANDIDATE` | house convention | A paragraph of 120+ words, a flat bullet of 90+ words, a file over 600 lines, or a level-2 section over 250 lines. Set when the lane was first written; not derived from an external standard or tuned against test runs. | `THRESHOLDS` in `scripts/check-prose.mjs` |
| `COLD_READ` | house convention — every category except an undefined term or acronym | A missing or out-of-order step, a dangling cross-reference, prose contradicting its own example, two names for one thing, an unstated prerequisite, an example that would not work as written, or an unresolvable spec reference. | The cold-read prompt in `/docs-audit`; `reference/diataxis-grounding.md` |
| `MISSING_DIAGRAM` | house convention (encouragement) | A section whose relationships a reader must draw in their head to follow. | The missing-diagram prompt in `/docs-audit` |
| `MISSING_DEMO` | house convention (encouragement) | A user-facing tool's README with no demo of the tool running. | The hero-demo prompt in `/docs-audit` |

Google's Lists page covers list choice and parallel structure, not item
length, so it is not cited for the length thresholds.

## Why these sources

- **Google developer documentation style guide.** Maintained, CC BY 4.0,
  and written for technical documentation. Its negation and noun-modifier
  rules sit under "Write for a global audience", which frames them around
  non-native readers and machine translation — the readers these rules
  protect most.
- **digital.gov plain-language guide.** US government work in the public
  domain, and the live successor to the Federal Plain Language Guidelines.
  It covers hidden verbs, which Google does not.
- **Not the 2011 Federal Plain Language Guidelines.** `plainlanguage.gov`
  now redirects to digital.gov, whose pages no longer carry the
  double-negative or noun-string rules; the 2011 text survives only in web
  archives.
- **Not ISO 24495-1:2023** (Plain language — Part 1). It is the umbrella
  international standard, but it is paywalled and states principles rather
  than sentence rules, so a finding cannot link a reader to its text.

External pages move. Re-check every URL and quote in this file whenever you
edit it.
