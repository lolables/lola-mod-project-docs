#!/usr/bin/env node
// Deterministic prose checks over a document's DocModel: size, plus lexical plain-language candidates.
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
//   WALL_OF_TEXT       a top-level or callout paragraph over the density threshold
//   DENSE_BULLET       a flat list item (no sub-list) whose body is over threshold
//   SPLIT_CANDIDATE    the whole file, or one H2 section, over the size threshold
//   DOUBLE_NEGATIVE    a negator and a negative-meaning word in one clause (candidate)
//   SLASH_ALTERNATIVE  word/word in running prose (candidate)
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
// so those are all the size checks trigger on. A paragraph gets more slack
// than a bullet: a bullet is meant to be one scannable idea, so it trips
// sooner. The numbers are house conventions, set when this lane was
// introduced (commit fbfa536); they are not derived from an external style
// guide and no eval round tuned them (see reference/rule-sources.md).
// Sentence-boundary segmentation is a genuinely hard NLP problem
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

// Plain-language candidates. A lexical pass over running prose (texts with
// prose: true — inline code, link text, and link targets already removed by
// the format adapter) enumerates them exhaustively; /docs-audit's LLM step
// keeps or drops each one. Rule sources: reference/rule-sources.md.
//
// Negative-meaning words are a curated list, not raw un-/in-/dis- prefixes:
// "index", "install", "include", and "discuss" start with the same letters.
// neither/nor are deliberately absent: "does not support X nor Y" is a
// correlative, not a double negative.
// The two-word "other than" is matched in doubleNegatives alongside this list,
// and "no fewer than" / "no less than" are fixed phrases there too.
export const NEGATIVE_WORDS = new Set([
  'unless', 'except', 'without', 'until', 'void', 'insufficient',
  'fail', 'fails', 'failed', 'failing', 'prevent', 'prevents', 'prevented',
  'uncommon', 'unlikely', 'unusual', 'unlike', 'unable', 'unavailable', 'unsupported',
  'unknown', 'unclear', 'unnecessary', 'unimportant', 'unreasonable', 'unsafe',
  'invalid', 'incorrect', 'inactive', 'incomplete', 'inconsistent', 'insecure',
  'impossible', 'improbable', 'disabled', 'disallowed', 'dissimilar',
  'nonzero', 'non-zero', 'nonempty', 'non-empty',
]);
const NEGATOR_RE = /^(?:not|no|never|cannot)$|n['’]t$/i;
// Words, or a clause-ending mark. Sentence segmentation is not attempted (see
// THRESHOLDS): an abbreviation such as "e.g." can end a window early, which
// costs a missed candidate, never a false one.
const TOKEN_RE = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*|[.;:!?]/gu;
const CLAUSE_END_RE = /^[.;:!?]$/;
const NEGATION_WINDOW = 10;

// A block's prose fragments joined in order: no separator within a line (so
// "**not** uncommon" and "un*common*" rejoin), a newline between lines (so a
// soft-wrapped line never glues two words). spans maps offsets back to lines.
export function proseBlocks(model) {
  const blocks = new Map();
  for (const t of model.texts) {
    if (!t.prose) continue;
    let b = blocks.get(t.block);
    if (!b) {
      b = { text: '', spans: [] };
      blocks.set(t.block, b);
    }
    const last = b.spans[b.spans.length - 1];
    if (last && last.line !== t.line) b.text += '\n';
    b.spans.push({ start: b.text.length, line: t.line });
    b.text += t.text;
  }
  return [...blocks.values()];
}

export function lineAt(block, offset) {
  let line = block.spans[0].line;
  for (const s of block.spans) {
    if (s.start > offset) break;
    line = s.line;
  }
  return line;
}

const excerpt = (s) => s.replace(/\s+/g, ' ').trim().slice(0, 80);

function doubleNegatives(block) {
  const toks = [...block.text.matchAll(TOKEN_RE)].map((m) => ({ w: m[0].toLowerCase(), at: m.index, end: m.index + m[0].length }));
  const hits = [];
  for (let i = 0; i < toks.length; i++) {
    if (!NEGATOR_RE.test(toks[i].w)) continue;
    if (toks[i].w === 'no' && (toks[i + 1]?.w === 'fewer' || toks[i + 1]?.w === 'less') && toks[i + 2]?.w === 'than') {
      hits.push({ at: toks[i].at, end: toks[i + 2].end });
      i += 2;
      continue;
    }
    for (let j = i + 1, words = 0; j < toks.length && words < NEGATION_WINDOW; j++, words++) {
      if (CLAUSE_END_RE.test(toks[j].w)) break;
      const otherThan = toks[j].w === 'other' && toks[j + 1]?.w === 'than';
      if (NEGATIVE_WORDS.has(toks[j].w) || otherThan) {
        hits.push({ at: toks[i].at, end: otherThan ? toks[j + 1].end : toks[j].end });
        i = j;
        break;
      }
    }
  }
  return hits.map(({ at, end }) => ({
    code: 'DOUBLE_NEGATIVE',
    severity: 'info',
    line: lineAt(block, at),
    message: `double negative: "${excerpt(block.text.slice(at, end))}"; state it positively`,
  }));
}

// Established terms written with a slash. 24/7 and other numeric pairs are
// excluded by the letters-only segment rule, so they need no entry here.
export const SLASH_ALLOWLIST = new Set(['i/o', 'tcp/ip', 'ci/cd', 'a/b', 'n/a', 'ui/ux', 'read/write']);
const LEADING_PUNCT = new Set([...'("\'“‘[']);
const TRAILING_PUNCT = new Set([...')"\'”’].,;:!?…—–']);
const PATH_START_RE = /^(?:\/|\.{1,2}\/|~\/)/;
// A word: starts with a letter; letters, digits, hyphens after. Rejects
// numbers, file extensions (a dot), URL schemes (a colon), and empty segments.
const SLASH_SEGMENT_RE = /^\p{L}[\p{L}\p{N}-]*$/u;

// Index loops, not a regex: an alternation anchored at both ends backtracks
// quadratically on a long punctuation run, and audited docs may be untrusted.
function trimEdgePunct(token) {
  let start = 0;
  let end = token.length;
  while (start < end && LEADING_PUNCT.has(token[start])) start++;
  while (end > start && TRAILING_PUNCT.has(token[end - 1])) end--;
  return token.slice(start, end);
}

function slashAlternatives(block) {
  const out = [];
  for (const m of block.text.matchAll(/\S+/g)) {
    if (!m[0].includes('/')) continue;
    const tok = trimEdgePunct(m[0]);
    if (!tok.includes('/') || PATH_START_RE.test(tok) || tok.endsWith('/')) continue;
    const segments = tok.split('/');
    if (segments.length !== 2 || !segments.every((s) => SLASH_SEGMENT_RE.test(s))) continue;
    if (SLASH_ALLOWLIST.has(tok.toLowerCase())) continue;
    out.push({
      code: 'SLASH_ALTERNATIVE',
      severity: 'info',
      line: lineAt(block, m.index),
      message: `slash between alternatives: "${tok}"; use "or" or "and"`,
    });
  }
  return out;
}

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

  for (const block of proseBlocks(model)) findings.push(...doubleNegatives(block), ...slashAlternatives(block));
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
