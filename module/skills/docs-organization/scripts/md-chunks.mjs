#!/usr/bin/env node
// Deterministic heading-aligned chunker for long markdown docs.
//
// /docs-audit's Lane 6 content-drift subagent under-reports on long docs: one
// subagent call over a 700-line file surfaces 1-2 findings, not the dozen
// that are actually there. Splitting the file into smaller pieces and running
// one subagent per piece finds far more drift (see eval/REPORT.md). The
// command's execution contract forbids the LLM from guessing section spans
// itself, so this script computes them: a small, testable, deterministic
// function instead of a model's best guess at where sections start and end.
//
// CLI: `node md-chunks.mjs <file.md>` prints JSON
// `{"file": "<as given>", "lines": N, "chunks": [{"start": 1, "end": 42}, ...]}`
// — 1-based inclusive line ranges, contiguous, covering lines 1..N exactly.
//
// A doc at or under LONG_DOC_LINES is short enough for one subagent call, so
// it stays a single chunk. Past that, chunk boundaries are the start lines of
// H2 and H3 headings (ATX or setext) as markdown-it's block parser sees them
// — never a per-line regex, so a `## ` inside a fenced code block is not
// mistaken for a boundary. H1 is a document title, not a section seam; H4+ is
// detail inside a section, not a seam either. Consecutive sections are then
// coalesced greedily up to MAX_CHUNK_LINES so short adjacent sections share a
// subagent call; a single section already longer than that is never split
// mid-section, so it ships alone even though it exceeds the cap.
//
// Line counting splits on the same rule markdown-it's normalize core rule
// uses internally (/\r\n?|\n/) rather than a bare `\n`, so CR-only and
// CRLF files get correct `lines` and ranges, matching the line numbers
// markdown-it's own token maps report. A YAML front matter block
// (`---\nk: v\n---`) has no dedicated handling here: markdown-it's default
// parser (no front-matter plugin) sees it as a setext H2, which adds a
// harmless extra boundary near the top of the file — coalescing always
// absorbs it into the first chunk, so it never changes the final ranges.

import MarkdownIt from './vendor/markdown-it.mjs';
import { readFileSync } from 'node:fs';
import { isMain } from './is-main.mjs';

export const LONG_DOC_LINES = 150;
export const MAX_CHUNK_LINES = 100;

const md = new MarkdownIt();

// Same line-break rule markdown-it's normalize core rule applies to state.src
// before parsing (lib/rules_core/normalize.mjs), so line numbers here match
// the ones its heading tokens report.
const NEWLINES_RE = /\r\n?|\n/;

function countLines(text) {
  if (text === '') return 0;
  const parts = text.split(NEWLINES_RE);
  if (parts[parts.length - 1] === '') parts.pop(); // trailing newline adds no line
  return parts.length;
}

export function chunkMarkdown(text) {
  const lines = countLines(text);
  if (lines === 0) return { lines: 0, chunks: [] };
  if (lines <= LONG_DOC_LINES) return { lines, chunks: [{ start: 1, end: lines }] };

  const tokens = md.parse(text, {});
  const boundarySet = new Set([1]);
  for (const tok of tokens) {
    if (tok.type !== 'heading_open') continue;
    const level = Number(tok.tag.slice(1));
    if (level === 2 || level === 3) boundarySet.add(tok.map[0] + 1);
  }
  const boundaries = [...boundarySet].sort((a, b) => a - b);
  const sections = boundaries.map((start, i) => ({
    start,
    end: i + 1 < boundaries.length ? boundaries[i + 1] - 1 : lines,
  }));

  const chunks = [];
  let group = null;
  for (const section of sections) {
    if (group === null) {
      group = { start: section.start, end: section.end };
      continue;
    }
    if (section.end - group.start + 1 <= MAX_CHUNK_LINES) {
      group.end = section.end;
    } else {
      chunks.push(group);
      group = { start: section.start, end: section.end };
    }
  }
  chunks.push(group);

  return { lines, chunks };
}

function main(argv) {
  const args = argv.slice(2);
  if (args.length !== 1) {
    process.stderr.write('usage: md-chunks.mjs <file.md>\n');
    process.exit(2);
  }
  const file = args[0];
  const content = readFileSync(file, 'utf8');
  const { lines, chunks } = chunkMarkdown(content);
  process.stdout.write(JSON.stringify({ file, lines, chunks }) + '\n');
}

if (isMain(import.meta.url)) {
  try {
    main(process.argv);
  } catch (e) {
    process.stderr.write('md-chunks: internal error: ' + (e && e.stack ? e.stack : e) + '\n');
    process.exit(2);
  }
}
