import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chunkMarkdown, LONG_DOC_LINES, MAX_CHUNK_LINES } from '../../../module/skills/docs-organization/scripts/md-chunks.mjs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const tmpDirs = [];
after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function mktemp(prefix = 'md-chunks-') {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tmpDirs.push(d);
  return d;
}

// Builds an N-line document, trailing newline included, with specific lines
// overridden (1-based line number -> text), everything else filler.
function buildDoc(n, headings = new Map()) {
  const lines = [];
  for (let i = 1; i <= n; i++) {
    lines.push(headings.has(i) ? headings.get(i) : `filler text ${i}`);
  }
  return lines.join('\n') + '\n';
}

const SCRIPT = fileURLToPath(new URL('../../../module/skills/docs-organization/scripts/md-chunks.mjs', import.meta.url));

function cli(...args) {
  try {
    return { code: 0, out: JSON.parse(execFileSync('node', [SCRIPT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) };
  } catch (e) {
    return { code: e.status, stderr: e.stderr };
  }
}

test('a short doc (<= LONG_DOC_LINES) collapses to a single chunk', () => {
  const doc = buildDoc(10);
  assert.deepEqual(chunkMarkdown(doc), { lines: 10, chunks: [{ start: 1, end: 10 }] });
});

test('an empty file has zero lines and no chunks', () => {
  assert.deepEqual(chunkMarkdown(''), { lines: 0, chunks: [] });
});

test('a trailing newline does not count as an extra line', () => {
  assert.equal(chunkMarkdown('a\nb\nc\n').lines, 3);
  assert.equal(chunkMarkdown('a\nb\nc').lines, 3);
});

test('exactly LONG_DOC_LINES lines collapses to a single chunk', () => {
  assert.ok(LONG_DOC_LINES === 150, 'constant changed; update this test\'s expectations');
  const doc = buildDoc(150);
  assert.deepEqual(chunkMarkdown(doc), { lines: 150, chunks: [{ start: 1, end: 150 }] });
});

test('LONG_DOC_LINES + 1 lines with no H2/H3 headings is still a single chunk', () => {
  const doc = buildDoc(151);
  assert.deepEqual(chunkMarkdown(doc), { lines: 151, chunks: [{ start: 1, end: 151 }] });
});

test('LONG_DOC_LINES + 1 lines with a heading splits into chunks', () => {
  const doc = buildDoc(151, new Map([[100, '## Section B']]));
  const result = chunkMarkdown(doc);
  assert.equal(result.lines, 151);
  assert.deepEqual(result.chunks, [
    { start: 1, end: 99 },
    { start: 100, end: 151 },
  ]);
});

test('a CRLF file produces the same ranges as its LF version', () => {
  const headings = new Map([[31, '## Section B'], [111, '## Section C']]);
  const lf = buildDoc(200, headings);
  const crlf = lf.replace(/\n/g, '\r\n');
  const lfResult = chunkMarkdown(lf);
  const crlfResult = chunkMarkdown(crlf);
  assert.equal(crlfResult.lines, lfResult.lines);
  assert.deepEqual(crlfResult.chunks, lfResult.chunks);
});

test('a CR-only file counts lines the same way as its LF version', () => {
  const headings = new Map([[31, '## Section B'], [111, '## Section C']]);
  const lf = buildDoc(200, headings);
  const cr = lf.replace(/\n/g, '\r');
  const lfResult = chunkMarkdown(lf);
  const crResult = chunkMarkdown(cr);
  assert.equal(crResult.lines, lfResult.lines);
  assert.deepEqual(crResult.chunks, lfResult.chunks);
});

test('a YAML front-matter block\'s harmless extra boundary does not change the final ranges', () => {
  const total = 170;
  const lines = ['---', 'k: v', '---'];
  for (let i = 4; i <= total; i++) lines.push(i === 100 ? '## Section B' : `filler text ${i}`);
  const doc = lines.join('\n') + '\n';
  const result = chunkMarkdown(doc);
  assert.equal(result.lines, total);
  assert.deepEqual(result.chunks, [
    { start: 1, end: 99 },
    { start: 100, end: total },
  ]);
});

test('a long doc is split at H2/H3 boundaries and coalesced into <=100-line groups', () => {
  assert.ok(LONG_DOC_LINES === 150 && MAX_CHUNK_LINES === 100, 'constants changed; update this test\'s expectations');
  const headings = new Map([
    [31, '## Section B'],
    [111, '## Section C'],
    [141, '### Section D'],
    [161, '## Section E'],
  ]);
  const doc = buildDoc(280, headings);
  const result = chunkMarkdown(doc);
  assert.equal(result.lines, 280);
  assert.deepEqual(result.chunks, [
    { start: 1, end: 30 },
    { start: 31, end: 110 },
    { start: 111, end: 160 },
    { start: 161, end: 280 },
  ]);
});

test('a single section longer than MAX_CHUNK_LINES stays whole, never split', () => {
  const doc = buildDoc(160, new Map([[21, '## Long section']]));
  const result = chunkMarkdown(doc);
  assert.deepEqual(result.chunks, [
    { start: 1, end: 20 },
    { start: 21, end: 160 },
  ]);
});

test('"## " inside a fenced ``` block and a ~~~ block is not a section boundary', () => {
  const headings = new Map([
    [10, '```'],
    [11, '## fake heading inside fence'],
    [12, 'code line'],
    [13, '```'],
    [20, '~~~'],
    [21, '### fake heading inside tilde fence'],
    [22, 'code line two'],
    [23, '~~~'],
  ]);
  const doc = buildDoc(160, headings);
  const result = chunkMarkdown(doc);
  // No real heading anywhere: the whole 160-line file is one section, and a
  // single section longer than MAX_CHUNK_LINES stays whole.
  assert.deepEqual(result.chunks, [{ start: 1, end: 160 }]);
});

test('a setext H2 heading is a section boundary', () => {
  // A blank line precedes it so "Promoted" starts its own paragraph at line
  // 61 instead of being swallowed as a lazy continuation of line 60's text
  // (which would move the heading's start line up to wherever that
  // paragraph began).
  const doc = buildDoc(170, new Map([[60, ''], [61, 'Promoted'], [62, '------']]));
  const result = chunkMarkdown(doc);
  assert.deepEqual(result.chunks, [
    { start: 1, end: 60 },
    { start: 61, end: 170 },
  ]);
});

test('an H4 heading is not a section boundary', () => {
  const doc = buildDoc(170, new Map([[61, '## Section'], [90, '#### Sub thing']]));
  const result = chunkMarkdown(doc);
  assert.deepEqual(result.chunks, [
    { start: 1, end: 60 },
    { start: 61, end: 170 },
  ]);
});

test('CLI: prints {file, lines, chunks} JSON for a short doc', () => {
  const dir = mktemp();
  const file = join(dir, 'doc.md');
  writeFileSync(file, buildDoc(5));
  const { code, out } = cli(file);
  assert.equal(code, 0);
  assert.deepEqual(out, { file, lines: 5, chunks: [{ start: 1, end: 5 }] });
});

test('CLI: a missing file exits 2', () => {
  const dir = mktemp();
  const r = cli(join(dir, 'nope.md'));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /ENOENT/);
});

test('CLI: no arguments exits 2 with usage', () => {
  const r = cli();
  assert.equal(r.code, 2);
  assert.match(r.stderr, /usage:/);
});

test('CLI: more than one argument exits 2 with usage', () => {
  const dir = mktemp();
  const a = join(dir, 'a.md');
  const b = join(dir, 'b.md');
  writeFileSync(a, buildDoc(1));
  writeFileSync(b, buildDoc(1));
  const r = cli(a, b);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /usage:/);
});
