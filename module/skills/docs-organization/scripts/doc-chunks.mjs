#!/usr/bin/env node
// Deterministic heading-aligned chunker for long docs (any registered format).
//
// /docs-audit's Lane 6 content-drift subagent under-reports on long docs: one
// subagent call over a 700-line file surfaces 1-2 findings, not the dozen
// that are actually there. Splitting the file into smaller pieces and running
// one subagent per piece finds far more drift (see eval/REPORT.md). The
// command's execution contract forbids the LLM from guessing section spans
// itself, so this script computes them: a small, testable, deterministic
// function instead of a model's best guess at where sections start and end.
//
// CLI: `node doc-chunks.mjs <file>` prints JSON
// `{"file": "<as given>", "lines": N, "chunks": [{"start": 1, "end": 42}, ...]}`
// — 1-based inclusive line ranges, contiguous, covering lines 1..N exactly.
//
// A doc at or under LONG_DOC_LINES is short enough for one subagent call, so
// it stays a single chunk. Past that, chunk boundaries are the start lines of
// level-2 and level-3 headings as the file's format adapter reports them
// (formats/index.mjs) — never a per-line regex, so a heading-looking line
// inside a code block is not a boundary. Level 1 is a document title, not a
// section seam; level 4+ is detail inside a section, not a seam either.
// Consecutive sections are then coalesced greedily up to MAX_CHUNK_LINES so
// short adjacent sections share a subagent call; a single section already
// longer than that is never split mid-section, so it ships alone even though
// it exceeds the cap. Line counting is the adapters' shared rule
// (formats/text.mjs), so CR-only and CRLF files get correct ranges, and front
// matter is blanked by the Markdown adapter, so it adds no boundary.

import { readFileSync } from 'node:fs';
import { parseDoc } from './formats/index.mjs';
import { isMain } from './is-main.mjs';

export const LONG_DOC_LINES = 150;
export const MAX_CHUNK_LINES = 100;

export function chunkDoc(model) {
  const { lines } = model;
  if (lines === 0) return { lines: 0, chunks: [] };
  if (lines <= LONG_DOC_LINES) return { lines, chunks: [{ start: 1, end: lines }] };

  const boundarySet = new Set([1]);
  for (const h of model.headings) {
    if (h.level === 2 || h.level === 3) boundarySet.add(h.line);
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

async function main(argv) {
  const args = argv.slice(2);
  if (args.length !== 1) {
    process.stderr.write('usage: doc-chunks.mjs <file>\n');
    process.exit(2);
  }
  const file = args[0];
  const content = readFileSync(file, 'utf8');
  const { lines, chunks } = chunkDoc(await parseDoc(file, content));
  process.stdout.write(JSON.stringify({ file, lines, chunks }) + '\n');
}

if (isMain(import.meta.url)) {
  main(process.argv).catch((e) => {
    process.stderr.write('doc-chunks: internal error: ' + (e && e.message ? e.message : e) + '\n');
    process.exit(2);
  });
}
