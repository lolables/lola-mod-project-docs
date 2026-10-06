// Document format registry: the one place that knows which formats exist.
//
// Each adapter is a default-exported object:
//   name         'markdown', 'asciidoc', …
//   extensions   lowercase file extensions it owns, e.g. ['.adoc', '.asciidoc']
//   readmeNames  README file names that satisfy the README rule
//   parse(text)  async; returns a DocModel:
//
//   lines        number of source lines (a trailing newline adds none)
//   headings     [{level, line, title}]   level 1 = document title, 2 = section …
//   paragraphs   [{line, text, context}]  context: top | list | quote | callout;
//                                         a list item's own text is a listItem
//   listItems    [{line, text, hasNestedList}]
//   links        [{kind, target, line, block, bare}]
//                kind: link | image | xref | include; block: inline-block id;
//                bare: a bare URL found by autodetection, not written as a link
//   texts        [{text, line, block, prose}]  plain text outside link text;
//                prose: true when the text belongs to a paragraphs or
//                listItems entry and is not inside a quotation at any
//                depth — running prose; false for headings, block titles,
//                simple table cells, quotations (and lists or paragraphs
//                nested in one), dlist terms, and a GFM alert's marker line
//   diagrams     [{startLine, source, blockStart, bodyStart, bodyEnd, swappable}]
//                mermaid only; offsets index the original text. startLine is
//                the first body line; blockStart is the offset of the
//                opening delimiter; [bodyStart, bodyEnd) is the body. These
//                offsets are exact only when swappable is true — swappable
//                means the block's delimiters sit at column 0 with no
//                enclosing prefix (no `>`, no list or admonition indent), so
//                the body can be spliced verbatim.
//   diagnostics  [{line, message}]         parser warnings
//
// Every line is 1-based. Checks read only the model, so a new format is one
// adapter file plus a line in FORMATS; tests/…/format-conformance.test.mjs
// holds every adapter to the same model for the same document.
//
// CLI (for the bash scripts): `node formats/index.mjs --extensions|--readmes`
// prints one entry per line.

import { basename } from 'node:path';
import markdown from './markdown.mjs';
import asciidoc from './asciidoc.mjs';
import { isMain } from '../is-main.mjs';

export const FORMATS = [markdown, asciidoc];

export function formatFor(path) {
  const name = basename(path).toLowerCase();
  return FORMATS.find((f) => f.extensions.some((ext) => name.length > ext.length && name.endsWith(ext))) ?? null;
}

export function extensions() {
  return FORMATS.flatMap((f) => f.extensions);
}

export function readmeNames() {
  return FORMATS.flatMap((f) => f.readmeNames);
}

export async function parseDoc(path, content) {
  const format = formatFor(path);
  if (!format) throw new Error(`${path}: not a registered document format (${extensions().join(', ')})`);
  return format.parse(content);
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const lists = { '--extensions': extensions, '--readmes': readmeNames };
  if (args.length !== 1 || !lists[args[0]]) {
    process.stderr.write('usage: formats/index.mjs --extensions|--readmes\n');
    process.exit(2);
  }
  process.stdout.write(lists[args[0]]().join('\n') + '\n');
}
