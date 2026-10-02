// The contract that makes a new format cheap: the same document, written in
// each registered format, must produce the same DocModel projection. Raw text
// and character offsets are syntax-specific, so they are left out; everything
// a check decides on (lines, levels, contexts, link kinds and targets, which
// § citations are linked, diagram bodies) must match exactly.
//
// Adding a format: write __fixtures__/formats/sample.<ext> as the same
// document, line for line, and this test covers it automatically.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FORMATS } from '../../../module/skills/docs-organization/scripts/formats/index.mjs';

const FIXTURES = fileURLToPath(new URL('./__fixtures__/formats/', import.meta.url));

function project(m) {
  const linkedBlocks = new Set(m.links.filter((l) => l.kind !== 'image' && !l.bare).map((l) => l.block));
  const citations = m.texts.filter((t) => t.text.includes('§'));
  return {
    lines: m.lines,
    headings: m.headings.map(({ level, line, title }) => ({ level, line, title })),
    paragraphs: m.paragraphs.map(({ line, context }) => ({ line, context })),
    listItems: m.listItems.map(({ line, hasNestedList }) => ({ line, hasNestedList })),
    links: m.links.map(({ kind, target, line, bare }) => ({ kind, target, line, bare })),
    citations: citations.map((t) => ({ line: t.line, linked: linkedBlocks.has(t.block) })),
    diagrams: m.diagrams.map(({ startLine, source, swappable }) => ({ startLine, source, swappable })),
    diagnostics: m.diagnostics,
  };
}

const sampleFor = (format) => `sample${format.extensions[0]}`;

test('every registered format has a conformance sample', () => {
  for (const f of FORMATS) {
    assert.doesNotThrow(() => readFileSync(FIXTURES + sampleFor(f)), `missing __fixtures__/formats/${sampleFor(f)}`);
  }
});

test('the reference projection is what the sample says it is', async () => {
  const [reference] = FORMATS;
  const p = project(await reference.parse(readFileSync(FIXTURES + sampleFor(reference), 'utf8')));
  assert.deepEqual(p.headings.map((h) => [h.level, h.line]), [[1, 1], [2, 5], [2, 11], [3, 26]]);
  assert.deepEqual(p.paragraphs, [
    { line: 3, context: 'top' }, { line: 14, context: 'quote' }, { line: 18, context: 'callout' }, { line: 28, context: 'top' },
    { line: 30, context: 'callout' },
  ]);
  assert.deepEqual(p.listItems, [
    { line: 7, hasNestedList: true }, { line: 8, hasNestedList: false }, { line: 9, hasNestedList: false },
  ]);
  assert.deepEqual(p.citations, [{ line: 3, linked: true }, { line: 28, linked: false }]);
  assert.deepEqual(p.diagrams, [{ startLine: 22, source: 'flowchart LR\n  A --> B', swappable: true }]);
});

for (const format of FORMATS.slice(1)) {
  test(`${format.name} matches ${FORMATS[0].name} on the shared sample`, async () => {
    const [reference] = FORMATS;
    const want = project(await reference.parse(readFileSync(FIXTURES + sampleFor(reference), 'utf8')));
    const got = project(await format.parse(readFileSync(FIXTURES + sampleFor(format), 'utf8')));
    assert.deepEqual(got, want);
  });
}
