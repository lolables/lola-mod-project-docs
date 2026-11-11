This document's Diátaxis mode is {{mode}} (from grounding). Using The Good Docs Project's notion of what that type needs — a how-to: steps that reach the goal, any prerequisite the steps assume, and a clear end state; a troubleshooting doc: each symptom paired with a resolution; a reference: every listed item actually described; a tutorial: a learning goal and a wrap-up — report only genuine completeness gaps that would leave a reader of this type BLOCKED or unable to trust the doc (a symptom with no fix, a reference entry left blank, a prerequisite the steps require but never name). A doc is complete when a competent reader could succeed: do NOT flag a step for being higher-level than its siblings or lacking an exact command, do NOT flag an intentionally minimal doc that is complete for its scope, and NEVER flag for a missing *named section* (Prerequisites, Summary) when the reader is not actually blocked — only for a reader who would be blocked, never one who merely wants more detail. Return `INCOMPLETE_FOR_TYPE` findings (info) with what is missing, where, and how it blocks the reader. Empty list when complete. Landing/README pages: skip this check, they are multi-mode by design.

End your reply with one fenced json block holding only this object:
```json
{"findings": [{"line": 12, "missing": "...", "blocks": "..."}]}
```
Set `line` to null when the gap has no single line.
Use `{"findings": []}` when there is nothing to report.
