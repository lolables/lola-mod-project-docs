import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readAntora, loadComponent, resolveXref, resolveLink, antoraRefPolicy, readPlaybookUrl } from '../../../module/skills/docs-organization/scripts/antora.mjs';
import { ConfigError } from '../../../module/skills/docs-organization/scripts/site-yaml.mjs';

const TREE = new Set([
  'docs/antora.yml', 'docs/modules/ROOT/nav.adoc',
  'docs/modules/ROOT/pages/index.adoc', 'docs/modules/ROOT/pages/sub/deep.adoc', 'docs/modules/ROOT/pages/_draft.adoc',
  'docs/modules/ROOT/pages/_wip/x.adoc', 'docs/modules/ROOT/pages/.tmp.adoc', 'docs/modules/ROOT/partials/p.adoc',
  'docs/modules/usage/pages/config.adoc', 'docs/modules/usage/attachments/a.zip', 'README.adoc',
]);
const DESC = 'name: guide\nversion: ~\nnav:\n- modules/ROOT/nav.adoc\n';
const C = readAntora('docs/antora.yml', DESC, TREE);

test('readAntora: name, version, content root, nav files, published pages, start page', () => {
  assert.equal(C.name, 'guide');
  assert.equal(C.version, null);
  assert.equal(C.contentRoot, 'docs');
  assert.equal(C.prefix, 'docs/');
  assert.deepEqual(C.navFiles, ['docs/modules/ROOT/nav.adoc']);
  assert.deepEqual(C.pages, ['docs/modules/ROOT/pages/index.adoc', 'docs/modules/ROOT/pages/sub/deep.adoc', 'docs/modules/usage/pages/config.adoc']);
  assert.equal(C.startPage, 'docs/modules/ROOT/pages/index.adoc');
});

test('readAntora: version forms, start_page, and an antora.yml at the root', () => {
  assert.equal(readAntora('antora.yml', "name: g\nversion: '2.0'\n", new Set()).version, '2.0');
  assert.equal(readAntora('antora.yml', 'name: g\nversion: 3\n', new Set()).version, '3');
  assert.equal(readAntora('antora.yml', 'name: g\nversion: true\n', new Set()).version, null);
  const root = readAntora('antora.yml', 'name: g\nstart_page: usage:config.adoc\n', new Set(['modules/usage/pages/config.adoc']));
  assert.equal(root.prefix, '');
  assert.equal(root.startPage, 'modules/usage/pages/config.adoc');
  assert.equal(readAntora('antora.yml', 'name: g\n', new Set()).startPage, null, 'default start page not tracked');
});

test('readAntora: a missing name or a bad nav throws, naming the file', () => {
  assert.throws(() => readAntora('docs/antora.yml', 'version: 1\n', TREE), /docs\/antora\.yml: name must be a non-empty string/);
  assert.throws(() => readAntora('docs/antora.yml', 'name: g\nnav: modules/ROOT/nav.adoc\n', TREE), /nav must be a list of file paths/);
});

const R = (target, from = 'docs/modules/ROOT/pages/index.adoc') => resolveXref(target, from, C);

test('resolveXref: same module, subdirectory, ./, fragment, family', () => {
  assert.deepEqual(R('sub/deep.adoc'), { path: 'docs/modules/ROOT/pages/sub/deep.adoc' });
  assert.deepEqual(R('index.adoc', 'docs/modules/ROOT/pages/sub/deep.adoc'), { path: 'docs/modules/ROOT/pages/index.adoc' }, 'relative to pages/, not the current page');
  assert.deepEqual(R('./other.adoc', 'docs/modules/ROOT/pages/sub/deep.adoc'), { path: 'docs/modules/ROOT/pages/sub/other.adoc' });
  assert.deepEqual(R('sub/deep.adoc#part'), { path: 'docs/modules/ROOT/pages/sub/deep.adoc' });
  assert.deepEqual(R('inline.adoc#'), { path: 'docs/modules/ROOT/pages/inline.adoc' });
  assert.deepEqual(R('page$sub/deep.adoc'), { path: 'docs/modules/ROOT/pages/sub/deep.adoc' });
  assert.deepEqual(R('usage:attachment$a.zip'), { path: 'docs/modules/usage/attachments/a.zip' });
});

test('resolveXref: a page under a _ or . path segment is unpublished, so the xref is broken on the site', () => {
  assert.match(R('_drafts/plan.adoc').unpublished, /_drafts/);
  assert.equal(R('_drafts/plan.adoc').path, 'docs/modules/ROOT/pages/_drafts/plan.adoc');
  assert.match(R('_partial.adoc').unpublished, /_partial\.adoc/);
  assert.match(R('./_x.adoc', 'docs/modules/ROOT/pages/sub/deep.adoc').unpublished, /_x\.adoc/);
  assert.equal(R('sub/deep.adoc').unpublished, undefined);
  assert.equal(R('partial$_x.adoc').unpublished, undefined, 'only pages are unpublished by a _ name');
});

test('resolveXref: other modules, ROOT shorthand, own component and version', () => {
  assert.deepEqual(R('usage:config.adoc'), { path: 'docs/modules/usage/pages/config.adoc' });
  assert.deepEqual(R('guide::index.adoc', 'docs/modules/usage/pages/config.adoc'), { path: 'docs/modules/ROOT/pages/index.adoc' });
  assert.deepEqual(R('guide:usage:config.adoc'), { path: 'docs/modules/usage/pages/config.adoc' });
  assert.deepEqual(R('index.adoc', 'docs/modules/usage/pages/config.adoc'), { path: 'docs/modules/usage/pages/index.adoc' }, 'same module as the source');
  assert.deepEqual(R('index.adoc', 'docs/antora.yml'), { path: 'docs/modules/ROOT/pages/index.adoc' }, 'outside a module: ROOT');
  const v2 = readAntora('docs/antora.yml', "name: guide\nversion: '2.0'\n", TREE);
  assert.deepEqual(resolveXref('2.0@guide:usage:config.adoc', 'docs/modules/ROOT/pages/index.adoc', v2), { path: 'docs/modules/usage/pages/config.adoc' });
});

test('resolveXref: what this repo cannot hold is unresolvable, not broken', () => {
  assert.match(R('other:mod:page.adoc').unresolvable, /component other/);
  assert.match(R('other::page.adoc').unresolvable, /component other/);
  assert.match(R('1.0@guide::index.adoc').unresolvable, /version 1\.0/);
  assert.match(R('index.adoc', 'docs/modules/ROOT/partials/p.adoc').unresolvable, /partial/);
  assert.deepEqual(resolveXref('x.png', 'docs/modules/ROOT/partials/p.adoc', C, 'image'), { path: 'docs/modules/ROOT/images/x.png' }, 'only a page xref depends on the including page');
  assert.deepEqual(R('partial$q.adoc', 'docs/modules/ROOT/partials/p.adoc'), { path: 'docs/modules/ROOT/partials/q.adoc' });
  assert.match(R('../../escape.adoc').unresolvable, /leaves/);
  assert.match(R('a:b:c:d.adoc').unresolvable, /not an Antora resource ID/);
  assert.match(R('weird$x.adoc').unresolvable, /family weird/);
  assert.match(R('./x.adoc', 'docs/antora.yml').unresolvable, /\.\//);
});

test('resolveXref: an author error is flagged invalid; what the repo merely cannot hold is not', () => {
  for (const t of ['../b.adoc', 'typo$b.adoc', 'a:b:c:d.adoc', '..:x.adoc']) assert.equal(R(t).invalid, true, t);
  for (const t of ['other::x.adoc', '1.0@guide::index.adoc']) assert.equal(R(t).invalid, undefined, t);
  assert.equal(R('index.adoc', 'docs/modules/ROOT/partials/p.adoc').invalid, undefined);
  assert.equal(R('./x.adoc', 'docs/antora.yml').invalid, undefined);
});

test('resolveXref: external targets and pure anchors are not resource references', () => {
  assert.equal(R('https://example.com/x.adoc'), null);
  assert.equal(R('#section'), null);
  assert.equal(R('mailto:a@example.com'), null);
  assert.equal(R(''), null);
});

test('readPlaybookUrl', () => {
  assert.equal(readPlaybookUrl('antora-playbook.yml', 'site:\n  url: https://docs.example.org\n'), 'https://docs.example.org');
  assert.equal(readPlaybookUrl('antora-playbook.yml', 'site:\n  title: x\n'), null);
  assert.equal(readPlaybookUrl('antora-playbook.yml', 'content: {}\n'), null);
  assert.throws(() => readPlaybookUrl('antora-playbook.yml', 'site: [\n'), /antora-playbook\.yml: malformed YAML/);
});

test('component and module coordinates cannot leave modules/', () => {
  for (const t of ['../../../../etc:passwd', '..:x.adoc', 'a/b:x.adoc', 'a\\b:x.adoc', '.:x.adoc', 'guide:..:x.adoc', 'guide:a/b:x.adoc']) {
    const r = R(t);
    assert.match(r.unresolvable, /invalid module or component name/, t);
  }
});

test('resolveXref: an inherited object key is an unknown family, not a family directory', () => {
  for (const family of ['constructor', '__proto__', 'toString']) {
    assert.deepEqual(R(`${family}$x.adoc`), { unresolvable: `unknown resource family ${family}$`, invalid: true }, family);
  }
});

test('resolveXref: an extensionless target with no module, family, or fragment is an in-document anchor', () => {
  assert.equal(R('install-steps'), null);
  assert.deepEqual(R('install.adoc'), { path: 'docs/modules/ROOT/pages/install.adoc' });
  assert.ok(R('other:install-steps').path);
});

test('resolveXref: a page target with a fragment and no extension names the .adoc page', () => {
  assert.deepEqual(R('install#prereqs'), { path: 'docs/modules/ROOT/pages/install.adoc' });
  assert.deepEqual(R('install.adoc#x'), { path: 'docs/modules/ROOT/pages/install.adoc' });
  assert.deepEqual(R('usage:config#x'), { path: 'docs/modules/usage/pages/config.adoc' });
  assert.equal(R('install-steps'), null);
});

test('loadComponent: reads the tracked antora.yml; a malformed one throws, or is returned as configError when tolerated', () => {
  const dir = mkdtempSync(join(tmpdir(), 'antora-load-'));
  try {
    mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'docs/antora.yml'), DESC);
    assert.equal(loadComponent(dir, TREE, 'docs/antora.yml', false).component.name, 'guide');
    writeFileSync(join(dir, 'docs/antora.yml'), 'name: [\n');
    assert.throws(() => loadComponent(dir, TREE, 'docs/antora.yml', false), ConfigError);
    const tolerated = loadComponent(dir, TREE, 'docs/antora.yml', true);
    assert.equal(tolerated.component, undefined);
    assert.match(tolerated.configError, /docs\/antora\.yml/);
    assert.throws(() => loadComponent(dir, TREE, 'docs/missing.yml', true), { code: 'ENOENT' }, 'only a ConfigError is tolerated');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveXref: an absolute image target is outside the repo (null); a ../ one is invalid', () => {
  const I = (t) => resolveXref(t, 'docs/modules/ROOT/pages/index.adoc', C, 'image');
  assert.equal(I('/assets/logo.png'), null);
  assert.equal(I('../x.png').invalid, true);
});

test('resolveLink: a link: target is a published-URL path, mapped to a repo file only where unambiguous', () => {
  const L = (t, from = 'docs/modules/ROOT/pages/index.adoc') => resolveLink(t, from, C);
  assert.deepEqual(L('deep.html', 'docs/modules/ROOT/pages/sub/other.adoc'), { path: 'docs/modules/ROOT/pages/sub/deep.adoc' });
  assert.deepEqual(L('sub/deep.html#top'), { path: 'docs/modules/ROOT/pages/sub/deep.adoc' });
  assert.deepEqual(L('../_attachments/a.zip', 'docs/modules/usage/pages/config.adoc'), { path: 'docs/modules/usage/attachments/a.zip' });
  assert.deepEqual(L('{attachmentsdir}/a.zip'), { path: 'docs/modules/ROOT/attachments/a.zip' });
  for (const t of ['../other.html', 'file.zip', 'install.adoc', '_attachments/../../x']) assert.ok(L(t).unresolvable, t);
  assert.ok(L('x.html', 'docs/modules/ROOT/partials/p.adoc').unresolvable);
  assert.equal(L('https://example.org/x.html'), null);
  assert.equal(L('#top'), null);
});

test('resolveLink: the published URL space puts ROOT at the component root and other modules in subdirectories', () => {
  const L = (t, from) => resolveLink(t, from, C);
  const ROOT = 'docs/modules/ROOT/pages/index.adoc';
  const USAGE = 'docs/modules/usage/pages/config.adoc';
  assert.deepEqual(L('usage/config.html', ROOT), { path: 'docs/modules/usage/pages/config.adoc' });
  assert.deepEqual(L('usage/missing.html', ROOT), { path: 'docs/modules/usage/pages/missing.adoc' });
  assert.deepEqual(L('../index.html', USAGE), { path: 'docs/modules/ROOT/pages/index.adoc' });
  assert.deepEqual(L('../sub/deep.html', USAGE), { path: 'docs/modules/ROOT/pages/sub/deep.adoc' });
  assert.deepEqual(L('other.html', USAGE), { path: 'docs/modules/usage/pages/other.adoc' });
  assert.deepEqual(L('../usage/config.html', USAGE), { path: 'docs/modules/usage/pages/config.adoc' });
  assert.ok(L('../../index.html', USAGE).unresolvable, 'leaves the component');
});

test('resolveLink: a ROOT subdirectory named like a module is ambiguous and skipped', () => {
  const tree = new Set([...TREE, 'docs/modules/ROOT/pages/usage/x.adoc']);
  const c = readAntora('docs/antora.yml', DESC, tree);
  assert.ok(resolveLink('usage/x.html', 'docs/modules/ROOT/pages/index.adoc', c).unresolvable);
});

test('antoraRefPolicy: AsciiDoc under the modules prefix gets Antora rules; everything else is a plain path', () => {
  const P = (path, kind, target = 'x', prefix = 'docs/modules/') => antoraRefPolicy(path, { kind, target }, prefix);
  const page = 'docs/modules/ROOT/pages/a.adoc';
  assert.equal(P(page, 'xref'), 'resource');
  assert.equal(P(page, 'image'), 'resource');
  assert.equal(P(page, 'include', 'partial$p.adoc'), 'resource');
  assert.equal(P(page, 'include', 'p.adoc'), 'path');
  assert.equal(P(page, 'link'), 'link');
  assert.equal(P('docs/modules/ROOT/pages/a.md', 'xref'), 'path');
  assert.equal(P('docs/modules/ROOT/pages/a.md', 'link'), 'path');
  assert.equal(P('README.adoc', 'link'), 'path');
  assert.equal(P(page, 'link', 'x', ''), 'link');
});
