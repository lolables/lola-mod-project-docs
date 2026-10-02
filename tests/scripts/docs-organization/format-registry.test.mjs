import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FORMATS, formatFor, extensions, readmeNames, parseDoc } from '../../../module/skills/docs-organization/scripts/formats/index.mjs';

const CLI = fileURLToPath(new URL('../../../module/skills/docs-organization/scripts/formats/index.mjs', import.meta.url));

test('every adapter honors the contract shape', () => {
  for (const f of FORMATS) {
    assert.equal(typeof f.name, 'string');
    assert.ok(f.extensions.length > 0 && f.extensions.every((e) => /^\.[a-z0-9]+$/.test(e)), f.name);
    assert.ok(f.readmeNames.length > 0 && f.readmeNames.every((n) => n.startsWith('README.')), f.name);
    assert.equal(typeof f.parse, 'function');
  }
});

test('no extension is claimed by two formats', () => {
  const all = extensions();
  assert.equal(new Set(all).size, all.length);
});

test('formatFor matches by extension, case-insensitively, and rejects others', () => {
  assert.equal(formatFor('docs/a.md').name, 'markdown');
  assert.equal(formatFor('A.MARKDOWN').name, 'markdown');
  assert.equal(formatFor('x.mdx'), null);
  assert.equal(formatFor('x.mmd'), null);
  assert.equal(formatFor('notes.txt'), null);
  assert.equal(formatFor('md'), null);
});

test('readmeNames lists every format\'s README names', () => {
  assert.ok(readmeNames().includes('README.md'));
  assert.ok(readmeNames().includes('README.markdown'));
});

test('parseDoc dispatches by path and rejects unregistered files', async () => {
  const m = await parseDoc('x.md', '# T\n');
  assert.deepEqual(m.headings, [{ level: 1, line: 1, title: 'T' }]);
  await assert.rejects(parseDoc('x.txt', 'hi'), /not a registered document format/);
});

test('CLI: --extensions and --readmes print one entry per line', () => {
  assert.deepEqual(execFileSync('node', [CLI, '--extensions'], { encoding: 'utf8' }).trim().split('\n'), extensions());
  assert.deepEqual(execFileSync('node', [CLI, '--readmes'], { encoding: 'utf8' }).trim().split('\n'), readmeNames());
});

test('CLI: anything else exits 2 with usage', () => {
  for (const args of [[], ['--nope'], ['--extensions', 'extra']]) {
    try {
      execFileSync('node', [CLI, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      assert.fail(`expected exit 2 for ${args}`);
    } catch (e) {
      assert.equal(e.status, 2);
      assert.match(e.stderr, /usage/);
    }
  }
});

test('AsciiDoc is registered: extensions, README names, dispatch', async () => {
  assert.equal(formatFor('guide.adoc').name, 'asciidoc');
  assert.equal(formatFor('GUIDE.ASCIIDOC').name, 'asciidoc');
  assert.equal(formatFor('notes.asc'), null);
  assert.ok(readmeNames().includes('README.adoc'));
  const m = await parseDoc('x.adoc', '= T\n');
  assert.deepEqual(m.headings, [{ level: 1, line: 1, title: 'T' }]);
});
