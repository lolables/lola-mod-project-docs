import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError } from '../../../module/skills/docs-organization/scripts/site-yaml.mjs';
import { readMkdocs } from '../../../module/skills/docs-organization/scripts/mkdocs.mjs';

const T = (...p) => new Set(p);
const TREE = T('mkdocs.yml', 'README.md', 'docs/index.md', 'docs/guide/a.md', 'docs/guide/b.md', 'docs/notes.adoc',
  'docs/.hidden/x.md', 'docs/templates/t.md', 'docs/sub/templates/kept.md', 'site/other.md');

test('default docs_dir: Markdown pages only, dot-paths and top-level templates/ excluded', () => {
  const m = readMkdocs('mkdocs.yml', 'site_name: P\n', TREE);
  assert.equal(m.docsDir, 'docs');
  assert.deepEqual(m.pages, ['docs/guide/a.md', 'docs/guide/b.md', 'docs/index.md', 'docs/sub/templates/kept.md']);
  assert.equal(m.nav, null, 'no nav key: the sidebar is the directory tree');
  assert.equal(m.home, 'docs/index.md');
  assert.equal(m.siteUrl, null);
  assert.equal(m.unreadable, null);
});

test('nav forms: bare path, titled path, nested section; external entries skipped', () => {
  const nav = 'nav:\n  - index.md\n  - Guide:\n    - First: guide/a.md\n    - guide/b.md\n  - Source: https://example.com/src\n  - Mail: mailto:x@example.com\n';
  assert.deepEqual(readMkdocs('mkdocs.yml', nav, TREE).nav, ['docs/index.md', 'docs/guide/a.md', 'docs/guide/b.md']);
});

test('custom docs_dir, README.md as home, and site_url', () => {
  const tree = T('mkdocs.yml', 'site/README.md', 'site/x.md');
  const m = readMkdocs('mkdocs.yml', 'docs_dir: site/\nsite_url: https://example.org/p/\n', tree);
  assert.equal(m.docsDir, 'site');
  assert.deepEqual(m.pages, ['site/README.md', 'site/x.md']);
  assert.equal(m.home, 'site/README.md');
  assert.equal(m.siteUrl, 'https://example.org/p/');
});

test('a tagged site_url is unknown, not a URL', () => {
  assert.equal(readMkdocs('mkdocs.yml', 'site_url: !ENV SITE_URL\n', TREE).siteUrl, null);
});

test('INHERIT and exclude_docs make the sidebar unreadable, with the reason', () => {
  assert.match(readMkdocs('mkdocs.yml', 'INHERIT: base.yml\n', TREE).unreadable, /mkdocs\.yml inherits from base\.yml/);
  assert.match(readMkdocs('mkdocs.yml', 'exclude_docs: |\n  drafts/\n', TREE).unreadable, /exclude_docs/);
});

test('an empty nav key is no nav; a nav that is not a list throws', () => {
  assert.equal(readMkdocs('mkdocs.yml', 'nav:\n', TREE).nav, null);
  assert.throws(() => readMkdocs('mkdocs.yml', 'nav: index.md\n', TREE), /mkdocs\.yml: nav must be a list/);
});

test('docs_dir outside the repository throws', () => {
  assert.throws(() => readMkdocs('mkdocs.yml', 'docs_dir: ../elsewhere\n', TREE), /mkdocs\.yml: docs_dir .* outside the repository/);
  assert.throws(() => readMkdocs('mkdocs.yml', 'docs_dir: /abs\n', TREE), /outside the repository/);
  assert.throws(() => readMkdocs('mkdocs.yml', 'docs_dir: 7\n', TREE), /docs_dir must be a string/);
});

test('a self-referencing nav alias is read once, not recursed forever', () => {
  const m = readMkdocs('mkdocs.yml', 'nav: &a [*a, index.md]\n', T('mkdocs.yml', 'docs/index.md'));
  assert.deepEqual(m.nav, ['docs/index.md']);
});

test('a non-string INHERIT is named as such', () => {
  const m = readMkdocs('mkdocs.yml', 'INHERIT: [a, b]\n', T('mkdocs.yml'));
  assert.match(m.unreadable, /inherits from a non-string INHERIT value/);
});

test('README.md beside a tracked index.md is not a page; alone it is', () => {
  const m = readMkdocs('mkdocs.yml', 'site_name: x\n', T('mkdocs.yml', 'docs/index.md', 'docs/README.md', 'docs/g/README.md', 'docs/h/index.md', 'docs/h/README.md'));
  assert.deepEqual(m.pages, ['docs/g/README.md', 'docs/h/index.md', 'docs/index.md']);
});

test('docs_dir !ENV [VAR, default] resolves to the default, never the process environment', () => {
  const tree = T('mkdocs.yml', 'docs/a.md', 'other/b.md');
  process.env.DOCS_DIR = 'other';
  try {
    const m = readMkdocs('mkdocs.yml', 'docs_dir: !ENV [DOCS_DIR, docs]\n', tree);
    assert.equal(m.docsDir, 'docs');
    assert.deepEqual(m.pages, ['docs/a.md']);
  } finally {
    delete process.env.DOCS_DIR;
  }
});

test('docs_dir !ENV with no string default throws a ConfigError naming !ENV', () => {
  for (const yml of ['docs_dir: !ENV DOCS_DIR\n', 'docs_dir: !ENV [DOCS_DIR]\n', 'docs_dir: !ENV [DOCS_DIR, 5]\n']) {
    assert.throws(() => readMkdocs('mkdocs.yml', yml, TREE), (e) => e instanceof ConfigError && /mkdocs\.yml: docs_dir uses !ENV without a string default/.test(e.message), yml);
  }
});

test('config errors are ConfigError', () => {
  assert.throws(() => readMkdocs('mkdocs.yml', 'nav: 1\n', T('mkdocs.yml')), ConfigError);
});

test('nav entries starting with / are links, not pages', () => {
  const m = readMkdocs('mkdocs.yml', 'nav:\n  - Home: index.md\n  - Other: /other.md\n  - Blog: /blog/\n', T('mkdocs.yml', 'docs/index.md', 'docs/other.md'));
  assert.deepEqual(m.nav, ['docs/index.md']);
});
