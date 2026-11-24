You are the audience the grounding above names, reading all of {{file}} to reach the outcome it names. Flag sentences and short passages that do not serve that reader. Two failures count.

1. PROVENANCE_NARRATION: the text tells how the author learned a fact (a run, a test session, a benchmark, a date, a person, "we saw") when the reader needs only the fact. The reader has to strip the history to find the fact, and the history goes stale.
   Flagged: "In the last measured run the import took 20 seconds." Rewrite: "The import takes about 20 seconds."
   Paraphrase counts too: "When Sam tried it on staging, the sync finished in under a minute" narrates a session just as "last run" does.
2. OFF_AUDIENCE: detail the grounded audience does not need to reach the outcome: internal implementation, maintainer history, or design rationale in a doc for operators, users, or evaluators. Rule (Google Technical Writing One, Audience): "make sure your document provides the information that your audience needs but doesn't already have."
   Flagged, in an operator how-to: "Internally the scheduler keeps a min-heap keyed on next-run time, which we chose over a timer wheel in 2024." Destination: `docs/dev/` (Dev persona).
   Name the destination by the reader who needs the passage: architecture, internals, and design rationale go to `docs/dev/` or an ADR (Dev persona); upgrade notes and changes between releases go to `CHANGELOG.md` (Operator persona).

Do NOT flag:
- anything in a snapshot genre: changelog, release notes, ADR, blog post, benchmark or eval report. There, provenance is the content ("In 2.3 we cut import time by half" in a changelog is a record, not a finding);
- detail that serves the grounded audience when that audience is maintainers or contributors ("The scheduler keeps a min-heap" in `docs/dev/architecture.md`);
- a measurement condition the reader needs to reproduce or judge a number: "On a 4-core runner, the import takes about 20 seconds" names hardware, which is a condition; "last run" is history;
- a documented limit, default, or guarantee ("By default it retries 3 times");
- a short note that sends the reader to the changelog for what changed ("`app sync` replaces `app pull`; see the changelog");
- a "we" sentence that gives the reader an instruction ("We recommend a dry run first");
- text inside code blocks, inline code, commands, or file paths, including logs with timestamps.

Stay in this lane. Do not report confusing text (the cold read covers it), stale numbers or time phrases such as `currently` (Lane 3 covers them), or a whole section in the wrong Diátaxis mode (grounding covers it).

For each finding give its code, the line, the exact quoted text (at most 120 characters), and why this audience does not need it. For PROVENANCE_NARRATION add a rewrite that keeps every number, unit, flag, and path verbatim. For OFF_AUDIENCE add the destination. Reply in under 300 words.

End your reply with one fenced json block holding only this object:
```json
{"findings": [{"code": "PROVENANCE_NARRATION", "line": 12, "quote": "<exact text>", "why": "...", "rewrite": "..."}, {"code": "OFF_AUDIENCE", "line": 30, "quote": "<exact text>", "why": "...", "destination": "docs/dev/ (Dev persona)"}]}
```
Use `{"findings": []}` when there is nothing to report.
