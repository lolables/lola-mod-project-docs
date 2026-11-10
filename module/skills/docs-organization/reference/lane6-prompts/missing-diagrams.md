Read {{file}}. Identify sections where adding a mermaid diagram would clarify a complicated concept — not restate a simple list. A candidate must satisfy **both**: (a) the relationships are non-obvious from a linear top-to-bottom read (real branching, parallelism, state transitions, or non-trivial component interactions); and (b) the reader would have to mentally render a diagram anyway to follow the prose. Reject candidates that are linear procedures with at most one binary branch, already drawn as text (directory trees, install steps, tables), small matrices better served by a table, or three-item role lists framed as 'pipelines'. For each surviving candidate, return a `MISSING_DIAGRAM` finding with the section heading, fitting type (flowchart / sequenceDiagram / stateDiagram-v2 / erDiagram), and a one-sentence justification that names *what's non-obvious* the diagram would expose. Severity is info (never blocker). Reply in under 200 words. If no candidates exist, return an empty list — do not invent.

End your reply with one fenced json block holding only this object:
```json
{"findings": [{"section": "<heading>", "line": 12, "type": "flowchart", "why": "..."}]}
```
Use `{"findings": []}` when there is nothing to report.
