# Diagram palettes

Four contrast-validated mermaid palettes ship with the skill:

- **Solar** (default — the palette the house-style templates use, and the
  one `/docs-update` falls back to when it can't tell a diagram's palette) —
  cool jewel tones, outlined clusters, both light and
  dark backgrounds
- **Federation** — cool balanced, outlined clusters, both backgrounds
- **Citrus** — warm earth tones, outlined clusters, both backgrounds
- **Parchment** — filled beige clusters for high-impact light-bg rendering

Every palette covers every mermaid diagram type (flowchart, sequence,
class, state, ER, journey, gantt, pie, sankey, gitgraph, mindmap,
timeline, xychart, block, kanban, packet, quadrant, requirement, C4,
architecture, radar). See
[`mermaid-house-style.md`](../../module/skills/docs-organization/reference/mermaid-house-style.md)
for templates and its "Switching palette" section for moving between them.

There is no project-wide palette setting: each diagram carries its palette
in its own `%%{init}%%` header. After install, `/diagram-test` lints every
diagram for syntax, a current palette header, approved class names, and
contrast.

To swap an existing diagram to a different palette, run the skill's
`swap-palette.sh` directly. It prints the result to stdout and never edits
in place. **Never redirect onto the input file** — the shell empties it
before the script reads it.

1. Find the script. The examples use a Claude Code project-scope install,
   `.claude/skills/docs-organization/scripts/`. A Claude Code user-scope
   install lives under `~/.claude/skills/` instead; other assistants use
   their own directories, chosen by `lola` at install time.
2. Write the swapped output to a new file:

   ```bash
   bash .claude/skills/docs-organization/scripts/swap-palette.sh citrus path/to/diagram.mmd > path/to/diagram.mmd.new
   ```

3. Move it into place:

   ```bash
   mv path/to/diagram.mmd.new path/to/diagram.mmd
   ```

The script also takes a doc file in any supported format (see
[Supported formats](../../README.md#supported-formats)). It prints the whole document with
every mermaid diagram swapped and every byte outside those diagrams
unchanged, so use the same write-then-move. `--block N` swaps only the N-th
diagram (1-based):

```bash
bash .claude/skills/docs-organization/scripts/swap-palette.sh --block 2 citrus docs/guide.md > docs/guide.md.new
mv docs/guide.md.new docs/guide.md
```

**For contributors to this repo** (not needed to use the installed
module): `task render -- path/to/diagram.mmd` renders a `.mmd` to PNG on
light and dark backgrounds (needs `mmdc`, not vendored — install
`@mermaid-js/mermaid-cli` separately), and `task palette -- citrus
path/to/diagram.mmd` runs the same `swap-palette.sh` through Task from the
repo root; both are `task`-only, so they require the full dev checkout.
