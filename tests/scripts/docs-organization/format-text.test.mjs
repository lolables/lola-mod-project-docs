import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitLines, countLines, lineStarts } from '../../../module/skills/docs-organization/scripts/formats/text.mjs';

test('countLines: empty is 0, a trailing newline adds no line', () => {
  assert.equal(countLines(''), 0);
  assert.equal(countLines('a'), 1);
  assert.equal(countLines('a\n'), 1);
  assert.equal(countLines('a\nb'), 2);
  assert.equal(countLines('a\n\n'), 2);
});

test('LF, CRLF, and CR-only content count and split the same way', () => {
  for (const nl of ['\n', '\r\n', '\r']) {
    const s = ['one', 'two', 'three'].join(nl) + nl;
    assert.equal(countLines(s), 3, JSON.stringify(nl));
    assert.deepEqual(splitLines(s), ['one', 'two', 'three', ''], JSON.stringify(nl));
  }
});

test('lineStarts gives the offset each 0-based line starts at', () => {
  assert.deepEqual(lineStarts('ab\ncd\r\nef\rg'), [0, 3, 7, 10]);
  assert.deepEqual(lineStarts(''), [0]);
  assert.deepEqual(lineStarts('x\n'), [0, 2]);
});
