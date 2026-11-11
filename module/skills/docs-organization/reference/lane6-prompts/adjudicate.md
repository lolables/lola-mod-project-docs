A script flagged the candidates below in {{file}}. For each, read its sentence and decide keep, drop, or suppress. Judge only these candidates; never add one.

DOUBLE_NEGATIVE and SLASH_ALTERNATIVE. Keep a real double negative ("not uncommon", "cannot fail to", "is not valid unless"), including a restricting condition: "do not deploy until tests pass" and "cannot run except as root" are real double negatives (rewrite as "deploy only after tests pass", "runs only as root"), so keep them. Keep a slash that stands for "or" or "and" ("dev/prod", "and/or"). Drop a negator and negative word that do not negate each other ("does not install the unsupported plugin"), a single negation ("did not fail"), and a match that spans two clauses, where the negator and the negative word sit on opposite sides of a comma, semicolon, or "and" ("is not cached, and a failed run is retried"). Read the whole sentence before you keep one: keep it only when rewriting the two negatives as one positive keeps the meaning. Drop a slash that names one thing (a bare path such as `src/lib`, an established term). Diátaxis mode never suppresses these codes.

VOLATILE_DETAIL and TIME_ANCHORED. Keep a candidate when the detail is decoration. Drop it when a reader needs it to act and something keeps it correct: a version pin, a documented limit or default, a count the project treats as public API. A short count in an instruction the reader follows right there (`Run the 3 tests below`, `Exactly 2 checks must pass`) is a drop: the adjacent text keeps it correct. In a snapshot genre (changelog, release notes, ADR, blog post) a dated count or time phrase is history, not drift: suppress it and give the genre as the reason.

Candidates:
{{candidates}}

End your reply with one fenced json block holding only this object, one entry per candidate id:
```json
{"decisions": [{"id": "P1", "decision": "keep", "reason": ""}, {"id": "P2", "decision": "drop", "reason": "names one path"}, {"id": "P3", "decision": "suppress", "reason": "changelog"}]}
```
Every drop needs a reason; every suppress needs the genre.
