#!/usr/bin/env node
// Deterministic prose-scannability checks over a document's DocModel.
//
// Replaces the LLM "readability" lane's job of *enumerating* violations: an
// LLM reading a 700-line file against a fuzzy word/size bar under-reports, and
// its recall degrades toward the end of long files. Counting words and line
// spans over structural regions is mechanical, so a parser does it exhaustively
// and reproducibly. The LLM is left only the judgment call it is actually good
// at (is this a genre where dense prose is the convention?). Sentence counting
// was tried and removed — segmentation is a hard NLP problem (see THRESHOLDS).
//
// Findings (all severity info — nudges, never blockers):
//   WALL_OF_TEXT    a top-level or callout paragraph over the density threshold
//   DENSE_BULLET    a flat list item (no sub-list) whose body is over threshold
//   SPLIT_CANDIDATE the whole file, or one H2 section, over the size threshold
//
// Output: JSON {status, scanned, findings:[{code, severity, file, line, message}]}
// on stdout. `scanned` is the number of distinct documents read, so an empty
// result can be told apart from a run that read nothing. A symlinked file and
// its target are one document, reported at the target's path. Exit 0 = no
// findings, 1 = findings, 2 = internal error. Matches the contract of
// check-structure.sh / check-staleness.mjs.
//
// Structure comes from the file's format adapter (formats/index.mjs), never
// from per-line regexes: code blocks, tables, quotations, and nested lists
// are distinguished by the parser, so wrapped list bodies and indented code
// never masquerade as paragraphs (the false-positive class a hand-rolled
// scanner hits). A callout (GFM alert, admonition) is the author's own prose
// and is checked; a quotation is someone else's and is not.

import { readFileSync, realpathSync, lstatSync } from 'node:fs';
import { relative } from 'node:path';
import { walkDocs } from './doc-files.mjs';
import { parseDoc } from './formats/index.mjs';
import { isMain } from './is-main.mjs';

// Thresholds. Word count and line span are the only *unambiguous* size metrics,
// so those are all this deterministic pass triggers on. A paragraph gets more
// slack than a bullet: a bullet is meant to be one scannable idea, so it trips
// sooner. Sentence-boundary segmentation is a genuinely hard NLP problem
// (abbreviations, decimals, initials, ellipses), so we deliberately do NOT
// count sentences here — that fuzzy "is the rhythm choppy / is this a
// dense-prose genre" judgment is deferred to the LLM lane, which only ever
// adjudicates the candidates this pass surfaces.
export const THRESHOLDS = {
  paragraphWords: 120,
  bulletWords: 90,
  fileLines: 600,
  sectionLines: 250,
};

function countWords(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

const PROSE_CONTEXTS = new Set(['top', 'callout']);

export function analyzeProse(model) {
  const findings = [];
  for (const p of model.paragraphs) {
    if (!PROSE_CONTEXTS.has(p.context)) continue;
    const words = countWords(p.text);
    if (words >= THRESHOLDS.paragraphWords) {
      findings.push({
        code: 'WALL_OF_TEXT',
        severity: 'info',
        line: p.line,
        message: `paragraph ~${words} words unbroken; split at a topic seam`,
      });
    }
  }
  // Only a flat item is flagged: one carrying its whole load as prose with no
  // sub-bullets to break it up. An item that already nests a list is exactly
  // the shape we want, however long.
  for (const item of model.listItems) {
    if (item.hasNestedList) continue;
    const words = countWords(item.text);
    if (words >= THRESHOLDS.bulletWords) {
      findings.push({
        code: 'DENSE_BULLET',
        severity: 'info',
        line: item.line,
        message: `flat bullet ~${words} words; break into sub-bullets`,
      });
    }
  }

  // Size heuristics. Whole file first, then any oversized level-2 section.
  const totalLines = model.lines;
  if (totalLines > THRESHOLDS.fileLines) {
    findings.push({
      code: 'SPLIT_CANDIDATE',
      severity: 'info',
      line: 1,
      message: `file is ${totalLines} lines (> ${THRESHOLDS.fileLines}); consider extracting detail into a linked sub-document (a README into docs/, a SKILL.md into reference/)`,
    });
  }

  // Section spans: from each level-2 heading to the next heading of level <= 2.
  const { headings } = model;
  for (let i = 0; i < headings.length; i++) {
    if (headings[i].level !== 2) continue;
    let end = totalLines + 1;
    for (let j = i + 1; j < headings.length; j++) {
      if (headings[j].level <= 2) { end = headings[j].line; break; }
    }
    const span = end - headings[i].line;
    if (span > THRESHOLDS.sectionLines) {
      findings.push({
        code: 'SPLIT_CANDIDATE',
        severity: 'info',
        line: headings[i].line,
        message: `section "${headings[i].title}" spans ~${span} lines (> ${THRESHOLDS.sectionLines}); consider extracting it into a linked sub-document`,
      });
    }
  }

  findings.sort((a, b) => (a.line || 0) - (b.line || 0));
  return findings;
}

async function main(argv) {
  const targets = argv.slice(2);
  if (targets.length === 0) {
    process.stderr.write('usage: check-prose.mjs <file-or-dir>...\n');
    process.exit(2);
  }
  const findings = [];
  const seen = new Set();
  const cwd = realpathSync(process.cwd());
  for (const target of targets) {
    for (const file of walkDocs(target)) {
      const real = realpathSync(file);
      if (seen.has(real)) continue; // a symlink and its target are one document
      seen.add(real);
      // Keep the caller's spelling for ordinary files; name the target for symlinks.
      const shown = lstatSync(file).isSymbolicLink() ? relative(cwd, real) : file;
      const content = readFileSync(real, 'utf8');
      for (const f of analyzeProse(await parseDoc(file, content))) findings.push({ ...f, file: shown });
    }
  }
  const payload = {
    status: findings.length === 0 ? 'ok' : 'findings',
    scanned: seen.size,
    findings,
  };
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  process.exit(findings.length === 0 ? 0 : 1);
}

if (isMain(import.meta.url)) {
  main(process.argv).catch((e) => {
    process.stderr.write('check-prose: internal error: ' + (e && e.stack ? e.stack : e) + '\n');
    process.exit(2);
  });
}
