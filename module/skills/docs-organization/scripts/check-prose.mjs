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
//   VOLATILE_DETAIL    a digit count, metric, popularity figure, or version (candidate)
//   TIME_ANCHORED      a phrase that dates the text: "currently", "as of v2" (candidate)
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
import { PERSONAS } from './personas.mjs';

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

// Where SPLIT_CANDIDATE sends each kind of content: the holds of every
// walkthrough reader except the new user, whose content stays (see
// reference/placement-rules.md).
const SPLIT_DESTINATIONS = PERSONAS
  .filter((p) => p.mechanism === 'walkthrough' && p.id !== 'new-user')
  .flatMap((p) => p.holds)
  .map((h) => `${h.what} → ${h.to}`)
  .join('; ');

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
// soft-wrapped line never glues two words). spans maps offsets back to lines;
// id is the inline block the fragments came from (as in model.links[].block).
export function proseBlocks(model) {
  const blocks = new Map();
  for (const t of model.texts) {
    if (!t.prose) continue;
    let b = blocks.get(t.block);
    if (!b) {
      b = { id: t.block, text: '', spans: [] };
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

// Volatile details: numbers that go stale as the project changes ("147 tests",
// "94% coverage", "1.2k stars", "markdown-it 14.1.0"). Every count, metric, and
// popularity pattern needs a trigger word after (or,
// for popularity and coverage, around) a digit number, so a bare number is
// never a candidate and spelled-out numbers ("six") are never scanned.
// "lines" is deliberately absent from the nouns: "100 lines" is as often a
// documented threshold as filler; "N lines of code" and "300-line" catch the
// filler. Rule sources: reference/rule-sources.md.
export const VOLATILE_NOUNS = new Set([
  'tests', 'assertions', 'specs', 'fixtures', 'files', 'rules', 'checks', 'lints', 'scripts',
  'modules', 'dependencies', 'packages', 'endpoints', 'contributors', 'commits', 'integrations',
  'plugins', 'languages', 'providers', 'commands',
]);
// A number right after one of these is a label or a pin ("Lane 4", "port
// 8080", "Python 3"), not a count.
export const LABEL_WORDS = new Set([
  'step', 'phase', 'lane', 'stage', 'part', 'version', 'v', 'port', 'exit', 'code', 'line',
  'section', 'chapter', 'page', 'rfc', 'issue', 'pr', 'python', 'node', 'node.js', 'java', 'go',
]);
// The label words that name software. A full version after one ("Node
// 20.11.0") is still a version candidate; the other labels are structural
// ("section 3.2.1") and skip it.
export const SOFTWARE_LABELS = new Set(['version', 'v', 'python', 'node', 'node.js', 'java', 'go']);
// A count may have one adjective between number and noun ("1,200 unit tests"),
// never a connective: "2 or more files" and "a SHA-256 per file" are not counts.
const COUNT_GAP_BLOCK = new Set(['of', 'or', 'and', 'per', 'to', 'in', 'at', 'on', 'for', 'from', 'with', 'by']);
const COMPARATIVES = new Set(['faster', 'slower', 'smaller', 'larger', 'fewer', 'less', 'more']);
const POPULARITY_NOUNS = new Set(['stars', 'forks', 'downloads', 'installs']);
const AUDIENCE_NOUNS = new Set(['users', 'teams', 'companies', 'organizations', 'projects']);
// Time anchors. A bare "now", "is now", "can now" marks a step in a sequence
// ("Now run the script"); "no longer" usually states a real deprecation; a bare
// "new" and "latest" are ordinary words. None of them is listed.
// '<version>' matches a version or a year: v2, 2.3.1, 2025.
export const TIME_PHRASES = [
  ['currently'], ['at', 'present'], ['at', 'the', 'moment'], ['at', 'the', 'time', 'of', 'writing'],
  ['as', 'of', '<version>'], ['new', 'in', '<version>'], ['now', 'supports'], ['now', 'has'],
  ['now', 'includes'], ['now', 'uses'], ['coming', 'soon'], ['for', 'now'], ['in', 'a', 'future', 'release'],
];
const VERSION_RE = /^(?:v\d+(?:\.\d+)*|\d+(?:\.\d+)+|\d{4})$/;
// A number (1,200 / 1.2k / 40+ / 94% / 3x / 300-line), a word (node.js and
// built-in stay whole), or one punctuation mark. No nested quantifier can
// overlap, so a long digit or separator run scans in linear time.
const VTOKEN_RE = /\d+(?:[,.]\d+)*(?:[kKmM](?![\p{L}\p{N}]))?(?:[+%×]|[xX](?![\p{L}\p{N}])|-\p{L}+)?[\p{L}\p{N}]*|\p{L}[\p{L}\p{N}]*(?:['’.-][\p{L}\p{N}]+)*|[^\s\p{L}\p{N}]/gu;
const NUMBER_RE = /^\d+(?:[,.]\d+)*[km]?(?:([+%×x])|-(\p{L}+))?$/u;
// A version at a token start: a core of dotted numbers, an optional
// pre-release ("-beta.1"), an optional minimum mark ("+"). VTOKEN_RE splits a
// numeric pre-release across tokens ("1.2.3-beta", ".", "1"), so this runs on
// the block text. Every part after the core is optional and no quantifier
// overlaps, so a match never backtracks and a long run scans in linear time.
const VERSION_AT_RE = /([vV]?)(\d+(?:\.\d+)*)(?:-[\p{L}\p{N}]+(?:\.[\p{L}\p{N}]+)*)?\+?/uy;
// A letter or digit (or a dot before one) right after the match: "1.2.3a", "v1.2.x".
const VERSION_TAIL_RE = /\.?[\p{L}\p{N}]/uy;

function lowerTokens(text) {
  return [...text.matchAll(VTOKEN_RE)].map((m) => ({ w: m[0].toLowerCase(), at: m.index, end: m.index + m[0].length }));
}

function volatileDetails(block) {
  const toks = lowerTokens(block.text);
  const word = (j) => (toks[j] && /^\p{L}/u.test(toks[j].w) ? toks[j].w : undefined);
  const nounEnd = (j) => {
    if (VOLATILE_NOUNS.has(word(j))) return j;
    if (word(j) === 'test' && word(j + 1) === 'cases') return j + 1;
    return -1;
  };
  const out = [];
  let lastEnd = -1;
  // The excerpt start and end offsets of a version at token i, or undefined.
  const versionAt = (i) => {
    if (!/^v?\d/.test(toks[i].w)) return undefined;
    VERSION_AT_RE.lastIndex = toks[i].at;
    const m = VERSION_AT_RE.exec(block.text);
    if (!m) return undefined;
    VERSION_TAIL_RE.lastIndex = VERSION_AT_RE.lastIndex;
    if (VERSION_TAIL_RE.test(block.text)) return undefined;
    const parts = m[2].split('.').length;
    const at = toks[i - 1]?.w === '@' && toks[i - 1].end === toks[i].at && toks[i - 2]?.end === toks[i - 1].at && word(i - 2);
    if (at && (m[1] || parts <= 3)) return { start: toks[i - 2].at, end: VERSION_AT_RE.lastIndex };
    if (m[1] ? parts < 2 : parts !== 3) return undefined;
    const label = word(toks[i - 1]?.w === '#' ? i - 2 : i - 1);
    if (LABEL_WORDS.has(label) && !SOFTWARE_LABELS.has(label)) return undefined;
    if (TIME_PHRASES.some((p) => p.includes('<version>') && phraseAt(toks, i - p.indexOf('<version>')) === p)) return undefined;
    const named = i - 1 > lastEnd && word(i - 1) && !COUNT_GAP_BLOCK.has(word(i - 1));
    return { start: toks[named ? i - 1 : i].at, end: VERSION_AT_RE.lastIndex };
  };
  for (let i = 0; i < toks.length; i++) {
    const ver = versionAt(i);
    if (ver) {
      out.push({
        code: 'VOLATILE_DETAIL',
        severity: 'info',
        line: lineAt(block, ver.start),
        message: `volatile version: "${excerpt(block.text.slice(ver.start, ver.end))}"; delete it or point to the command that reports it`,
      });
      while (toks[i + 1] && toks[i + 1].at < ver.end) i++;
      lastEnd = i;
      continue;
    }
    const num = NUMBER_RE.exec(toks[i].w);
    if (!num || LABEL_WORDS.has(word(toks[i - 1]?.w === '#' ? i - 2 : i - 1))) continue;
    const [, mark, hyphenWord] = num;
    let kind;
    let start = i;
    let end = -1;
    if (hyphenWord) {
      if (hyphenWord === 'line' || hyphenWord === 'loc') {
        kind = 'count';
        end = i;
      }
    } else if (mark === '%' || mark === 'x' || mark === '×') {
      if (COMPARATIVES.has(word(i + 1))) {
        kind = 'metric';
        end = i + 1;
      } else if (mark === '%') {
        const after = [i + 1, i + 2].find((j) => word(j) === 'coverage');
        const before = [i - 1, i - 2].find((j) => j > lastEnd && word(j) === 'coverage');
        if (after !== undefined) {
          kind = 'metric';
          end = after;
        } else if (before !== undefined) {
          kind = 'metric';
          start = before;
          end = i;
        }
      }
    } else if (POPULARITY_NOUNS.has(word(i + 1))) {
      kind = 'popularity';
      end = i + 1;
    } else if ((word(i - 2) === 'used' || word(i - 2) === 'trusted') && word(i - 1) === 'by' && AUDIENCE_NOUNS.has(word(i + 1))) {
      kind = 'popularity';
      start = i - 2;
      end = i + 1;
    } else if (word(i + 1) === 'loc') {
      kind = 'metric';
      end = i + 1;
    } else if (word(i + 1) === 'lines' && word(i + 2) === 'of' && word(i + 3) === 'code') {
      kind = 'metric';
      end = i + 3;
    } else {
      end = nounEnd(i + 1);
      if (end < 0 && word(i + 1) && !COUNT_GAP_BLOCK.has(word(i + 1))) end = nounEnd(i + 2);
      if (end >= 0) kind = 'count';
    }
    if (!kind) continue;
    out.push({
      code: 'VOLATILE_DETAIL',
      severity: 'info',
      line: lineAt(block, toks[start].at),
      message: `volatile ${kind}: "${excerpt(block.text.slice(toks[start].at, toks[end].end))}"; delete it or point to the command that reports it`,
    });
    i = end;
    lastEnd = end;
  }
  return out;
}

// The TIME_PHRASES entry that starts at token i, if any.
function phraseAt(toks, i) {
  return TIME_PHRASES.find((phrase) => phrase.every((w, k) => {
    const t = toks[i + k]?.w;
    return t !== undefined && (w === '<version>' ? VERSION_RE.test(t) : t === w);
  }));
}

function timeAnchors(block) {
  const toks = lowerTokens(block.text);
  const out = [];
  for (let i = 0; i < toks.length; i++) {
    const phrase = phraseAt(toks, i);
    if (!phrase) continue;
    const end = i + phrase.length - 1;
    out.push({
      code: 'TIME_ANCHORED',
      severity: 'info',
      line: lineAt(block, toks[i].at),
      message: `time-anchored: "${excerpt(block.text.slice(toks[i].at, toks[end].end))}"; describe the behavior without the time anchor`,
    });
    i = end;
  }
  return out;
}

function countWords(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

const PROSE_CONTEXTS = new Set(['top', 'callout']);

// Lines from heading i to the next heading at the same or a higher level, or
// to the end of the document (`lines` is the document's line count).
export function sectionSpan(headings, i, lines) {
  for (let j = i + 1; j < headings.length; j++) {
    if (headings[j].level <= headings[i].level) return headings[j].line - headings[i].line;
  }
  return lines + 1 - headings[i].line;
}

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
      message: `file is ${totalLines} lines (> ${THRESHOLDS.fileLines}); split it by reader (reference/personas.md): ${SPLIT_DESTINATIONS}. A SKILL.md moves detail into reference/ instead`,
    });
  }

  // Section spans: from each level-2 heading to the next heading of level <= 2.
  const { headings } = model;
  for (let i = 0; i < headings.length; i++) {
    if (headings[i].level !== 2) continue;
    const span = sectionSpan(headings, i, totalLines);
    if (span > THRESHOLDS.sectionLines) {
      findings.push({
        code: 'SPLIT_CANDIDATE',
        severity: 'info',
        line: headings[i].line,
        message: `section "${headings[i].title}" spans ~${span} lines (> ${THRESHOLDS.sectionLines}); move it to its reader's door (reference/personas.md): ${SPLIT_DESTINATIONS}`,
      });
    }
  }

  for (const block of proseBlocks(model)) {
    findings.push(...doubleNegatives(block), ...slashAlternatives(block), ...volatileDetails(block), ...timeAnchors(block));
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
