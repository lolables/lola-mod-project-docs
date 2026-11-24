# References should be followable

Design rationale for the reference-integrity checks in `check-refs.mjs`: why a
reference the reader cannot follow is a defect, which danglers the script
surfaces, and which references it leaves alone. The operative procedure —
finding emission and the fixes `/docs-update` offers — lives in the script and
in the `/docs-audit` and `/docs-update` commands. This file explains the
reasoning behind it, and is loaded on demand rather than at skill activation.

A reference the reader cannot follow is a defect, and much of it is
deterministic: `check-refs.mjs` resolves every *link* (and AsciiDoc
cross-reference and include) against the
git-tracked file set. A link to a missing path (`REF_BROKEN`) or to a real but
gitignored/unstaged file (`REF_NOT_IN_GIT`) dangles for anyone who clones. It
also surfaces `§` section citations that carry no link (`UNLINKED_REF`) — a
cheap tell for a prose reference (often to an internal spec) the reader can't
follow. It likewise flags stock pointer phrases with no link in the same
block — "contact the maintainers", "see the contributing guide", "open an
issue" (`UNLINKED_POINTER`) — because a reader must never have to search
the docs for clarifying or relevant information. The fix is a link, or the
content included in place; naming where to look does not count. The rule is "a reference should be followable", not "everything
referenced must be committed": some references are legitimately private or
external, so the script only surfaces danglers and the author resolves them in
`/docs-update` (link, commit, or mark external — never strip a `§` citation).
Inline-code mentions of source paths are intentionally *not* resolved — they are
repo-root-relative and full of placeholders, so a heuristic there is mostly
false positives.
