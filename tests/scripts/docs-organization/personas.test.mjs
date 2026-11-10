// The persona registry is data (scripts/personas.mjs) with a human table
// (reference/personas.md). These tests hold the two equal, so neither can
// drift from the other.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PERSONAS, describeEntry } from '../../../module/skills/docs-organization/scripts/personas.mjs';

const REF = fileURLToPath(new URL('../../../module/skills/docs-organization/reference/', import.meta.url));

// Body rows of the first table whose header starts with `| <first> |`.
function tableRows(text, first) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`| ${first} |`));
  assert.ok(start >= 0, `no table headed "${first}"`);
  const rows = [];
  for (const l of lines.slice(start + 2)) {
    if (!l.startsWith('|')) break;
    rows.push(l.split('|').slice(1, -1).map((c) => c.trim()));
  }
  return rows;
}

const entryPoints = (p) => [p.entryNote, ...p.entries.map(describeEntry)].filter(Boolean).join(', ');

test('personas.md table equals the registry', () => {
  const rows = tableRows(readFileSync(REF + 'personas.md', 'utf8'), 'Persona');
  assert.deepEqual(rows, PERSONAS.map((p) => [p.label, p.question, entryPoints(p), p.mechanism]));
});

test('every persona has a known mechanism, unique id, and somewhere content goes', () => {
  const ids = new Set();
  for (const p of PERSONAS) {
    assert.ok(['walkthrough', 'placement rules', 'checklist'].includes(p.mechanism), `${p.id}: ${p.mechanism}`);
    assert.ok(!ids.has(p.id), `duplicate id ${p.id}`);
    ids.add(p.id);
    assert.ok(p.holds.length > 0, `${p.id} holds nothing`);
  }
});

test('a gate persona marks at least one gate entry and states why it matters', () => {
  for (const p of PERSONAS.filter((x) => x.gate)) {
    assert.ok(['warning', 'info'].includes(p.gate), `${p.id}: gate ${p.gate}`);
    assert.ok(p.entries.some((e) => e.gate), `${p.id} has a gate but no gate entry`);
    assert.ok(p.gateHint, `${p.id} has no gateHint`);
  }
});

test('describeEntry renders directories, aliases, and lookup directories', () => {
  assert.equal(describeEntry({ dir: 'docs/usage' }), '`docs/usage/`');
  assert.equal(describeEntry({ file: ['CHANGELOG'], in: ['.'] }), '`CHANGELOG`');
  assert.equal(
    describeEntry({ file: ['LICENSE', 'COPYING'], in: ['.'] }),
    '`LICENSE` (or `COPYING`)',
  );
  assert.equal(
    describeEntry({ file: ['SECURITY'], in: ['.', '.github', 'docs'] }),
    '`SECURITY` in the root, `.github/`, `docs/`',
  );
});

test('placement-rules.md table equals every persona\'s holds', () => {
  const rows = tableRows(readFileSync(REF + 'placement-rules.md', 'utf8'), 'Content');
  assert.deepEqual(rows, PERSONAS.flatMap((p) => p.holds.map((h) => [h.what, h.to, p.label])));
});

test('personas.md walkthrough tasks equal the registry; only walkthrough personas have tasks', () => {
  const rows = tableRows(readFileSync(REF + 'personas.md', 'utf8'), 'Walkthrough persona');
  assert.deepEqual(rows, PERSONAS.flatMap((p) => p.tasks.map((t) => [p.label, t])));
  for (const p of PERSONAS) assert.equal(p.tasks.length > 0, p.mechanism === 'walkthrough', p.id);
});
