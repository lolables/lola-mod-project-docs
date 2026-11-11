import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSiteYaml, Inert, ConfigError } from '../../../module/skills/docs-organization/scripts/site-yaml.mjs';

test('plain YAML loads as data', () => {
  assert.deepEqual(loadSiteYaml('mkdocs.yml', 'site_name: P\nnav:\n  - Home: index.md\n'), { site_name: 'P', nav: [{ Home: 'index.md' }] });
});

test('Python and MkDocs tags load as inert values of every node kind', () => {
  const doc = loadSiteYaml('mkdocs.yml', [
    'a: !!python/name:material.extensions.emoji.twemoji',
    'b: !!python/object/apply:builtins.print ["hi"]',
    'c: !!python/object:pkg.Cls {x: 1}',
    'd: !ENV [API_KEY, fallback]',
    'e: !relative $config_dir',
    '',
  ].join('\n'));
  for (const k of 'abcde') assert.ok(doc[k] instanceof Inert, k);
  assert.equal(doc.a.tag, 'tag:yaml.org,2002:python/name:material.extensions.emoji.twemoji');
  assert.equal(doc.a.value, '');
  assert.deepEqual(doc.b.value, ['hi']);
  assert.deepEqual(doc.c.value, { x: 1 });
  assert.deepEqual([doc.d.tag, doc.d.value], ['!ENV', ['API_KEY', 'fallback']]);
  assert.deepEqual([doc.e.tag, doc.e.value], ['!relative', '$config_dir']);
});

test('an empty file is an empty mapping', () => {
  assert.deepEqual(loadSiteYaml('antora.yml', ''), {});
  assert.deepEqual(loadSiteYaml('antora.yml', '# only a comment\n'), {});
  assert.deepEqual(loadSiteYaml('antora.yml', '\n\n'), {});
  assert.deepEqual(loadSiteYaml('antora.yml', '  # indented comment\n'), {});
});

test('malformed YAML and non-mapping documents throw, naming the file', () => {
  assert.throws(() => loadSiteYaml('docs/antora.yml', 'a: [1, 2\nb: c\n'), /^Error: docs\/antora\.yml: malformed YAML: /);
  assert.throws(() => loadSiteYaml('mkdocs.yml', '- a\n- b\n'), /mkdocs\.yml: expected a mapping at the top level/);
  assert.throws(() => loadSiteYaml('mkdocs.yml', 'just text\n'), /mkdocs\.yml: expected a mapping/);
});

test('an alias bomb throws an Error naming the file, not a RangeError', () => {
  const lines = ['a0: &a0 [x,x,x,x,x,x,x,x,x,x]'];
  for (let i = 1; i < 10; i++) lines.push(`a${i}: &a${i} [${Array(10).fill(`*a${i - 1}`).join(',')}]`);
  assert.throws(() => loadSiteYaml('mkdocs.yml', `${lines.join('\n')}\n`), (e) => e instanceof ConfigError && /mkdocs\.yml: malformed YAML: .*maxAliases/.test(e.message));
});
