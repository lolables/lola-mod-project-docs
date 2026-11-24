// SKILL.md loads with every command, so it holds only what a command needs
// while it runs (AGENTS.md, "SKILL.md holds only..."). Lane job kinds and
// finding codes are discovered from lane6-kinds.mjs, so a new lane is covered
// without editing this test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { KINDS } from '../../../module/skills/docs-organization/scripts/lane6-kinds.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const read = (p) => readFileSync(ROOT + p, 'utf8');

// Kinds match only as code spans: `grounding` is also an ordinary word.
const KIND_NAMES = Object.keys(KINDS);
const CODES = [...new Set(
  [...read('module/skills/docs-organization/scripts/lane6-kinds.mjs')
    .matchAll(/'([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)'/g)].map((m) => m[1]),
)];

function forbiddenNames(text) {
  const hits = KIND_NAMES.filter((k) => text.includes('`' + k + '`')).map((k) => '`' + k + '`');
  return hits.concat(CODES.filter((c) => new RegExp(`\\b${c}\\b`).test(text)));
}

test('discovery finds the lane kinds and finding codes', () => {
  assert.ok(KIND_NAMES.length >= 10, `only ${KIND_NAMES.length} kinds discovered`);
  assert.ok(CODES.length >= 10, `only ${CODES.length} codes discovered`);
});

test('matcher reports a kind code span and a code, not a bare word', () => {
  assert.deepEqual(forbiddenNames('Run `cold-read`, which emits COLD_READ.'), ['`cold-read`', 'COLD_READ']);
  assert.deepEqual(forbiddenNames('A grounding pass and a cold-read come first.'), []);
  assert.deepEqual(forbiddenNames('XCOLD_READ and COLD_READS are other names.'), []);
});

test('SKILL.md names no lane kind or finding code', () => {
  const hits = forbiddenNames(read('module/skills/docs-organization/SKILL.md'));
  assert.deepEqual(hits, [], `SKILL.md names ${hits.join(', ')}. Document lanes and codes in docs-audit.md, rule-sources.md, and reference/ (AGENTS.md rule).`);
});
