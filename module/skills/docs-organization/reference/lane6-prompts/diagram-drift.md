Read the mermaid diagram in {{file}} that starts at line {{line}}, and the code it depicts in the repository at {{repo_root}}. Identify nodes and edges that reference subsystems no longer in the code. Reply in under 200 words.

End your reply with one fenced json block holding only this object:
```json
{"findings": [{"element": "<node or edge as written>", "code_says": "...", "evidence": "file:line"}]}
```
Use `{"findings": []}` when there is nothing to report.
