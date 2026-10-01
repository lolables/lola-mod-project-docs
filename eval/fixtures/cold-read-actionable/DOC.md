# recolor quickstart

recolor switches the color theme of the mermaid diagrams in a Markdown
file. Every recolor command takes the Markdown file as its last argument.

## Install

```bash
pipx install recolor
```

## Recolor a file

recolor rewrites the file in place:

```bash
recolor --theme dark docs/guide.md
```

recolor prints the recolored file to stdout and never modifies its input.

## Recolor one diagram

To change only the second diagram, pass its position:

```bash
recolor --only 2 --theme dark
```

## Themes

recolor ships `light` and `dark`; both pass the WCV check.
To make your own theme, see "Writing a theme" below.
