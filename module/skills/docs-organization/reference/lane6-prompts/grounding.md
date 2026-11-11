Read {{file}}. In under 70 words state (a) its primary Diátaxis mode — `tutorial` (learning), `how-to` (a task), `reference` (facts/tables), `explanation` (concepts/why), or `landing` (a README/entry page, legitimately multi-mode); (b) its intended audience; (c) what a reader should be able to do after reading it; and (d) `mode_mixing`: for a non-`landing` doc that commits to one mode but substantially embeds another that interrupts its job (a how-to that stops for paragraphs of conceptual explanation; a reference dropped into a tutorial), name the intruding mode and quote the section — otherwise false. A `landing` page is never mode-mixing.

End your reply with one fenced json block holding only this object:
```json
{"mode": "how-to", "audience": "...", "outcome": "...", "mode_mixing": false}
```
When the doc mixes modes, set `"mode_mixing": {"intruding": "explanation", "section": "<heading>", "quote": "<one line of that section, exactly as written>"}`. Keep `audience` and `outcome` under 70 words each.
