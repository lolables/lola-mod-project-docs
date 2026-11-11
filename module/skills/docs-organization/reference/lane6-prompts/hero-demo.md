Read {{file}}. Judge whether this landing page would be meaningfully improved by a DEMO — an animated terminal recording (asciinema / GIF) or a short screen capture — that shows the tool running. Emit a finding ONLY when ALL hold: (a) the project is a USER-FACING, RUNNABLE tool (a CLI, TUI, or app a person operates and can watch produce output) — a library / framework / SDK is not one (its demo is a code snippet the README already carries), nor is a spec / schema / docs-only repo; (b) this doc is the project's README / entry point; and (c) the README does NOT already show the tool in action — no embedded image (`![](...gif/png/svg/webp)`), `<img>` / `<video>`, asciinema / `.cast`, or linked screencast. If any visual demo or representative screenshot is already present, return empty — the job is done. At most ONE finding (the hero slot). When warranted, return a `MISSING_DEMO` finding (severity info) with a short SPEC: the happy-path command sequence to record, what the viewer should see that signals success, and a suggested format (asciinema + svg-term-cli, or VHS / charmbracelet, for a terminal; a screen capture for a GUI). When in doubt return empty — a false nag is worse than a miss. Reply in under 150 words.

End your reply with one fenced json block holding only this object:
```json
{"findings": [{"commands": ["..."], "success": "...", "format": "..."}]}
```
Use `{"findings": []}` when there is nothing to report.
At most one entry.
