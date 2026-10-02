# Supported formats

The scripts under `scripts/` read any file a registered format adapter
owns. This is the current registry.

| Format | Extensions | README names | Mermaid blocks |
| --- | --- | --- | --- |
| Markdown (CommonMark + GFM tables, footnotes, front matter, GFM alerts, `!!!` admonitions, `:::` containers) | `.md` `.markdown` `.mdown` `.mkd` `.mkdn` | `README.md`, `README.markdown` | ` ```mermaid ` or `~~~mermaid` fences |
| AsciiDoc (parsed by Asciidoctor in `secure` mode — `include::` targets are checked, never read) | `.adoc` `.asciidoc` | `README.adoc`, `README.asciidoc` | `[mermaid]` or `[source,mermaid]` on a `....`/`----` block |

A leading YAML or TOML front-matter block (Markdown only) is skipped, not
audited: nothing inside it is checked.

`.mdx` is not audited: Linguist classifies it as source, and its JSX does not
parse as Markdown. `.asc` is not claimed: it is also the extension for
PGP-armored signatures and keys; name AsciiDoc files `.adoc`.
`node "$SKILL_DIR/scripts/formats/index.mjs" --extensions` (or `--readmes`)
prints the live list.
