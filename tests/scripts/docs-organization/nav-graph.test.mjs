import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectMode, buildGraph, reachable, indexPage, makeResolve, landOn, edgesOutOf, loadOutsideEdges } from '../../../module/skills/docs-organization/scripts/nav-graph.mjs';
import { tempRepo, tempDir, removeTemp, writeFiles, commitAll, GENV, mkdocsFiles, antoraFiles } from './routing-fixtures.mjs';

after(removeTemp);

const SCRIPT = fileURLToPath(new URL('../../../module/skills/docs-organization/scripts/nav-graph.mjs', import.meta.url));
const mode = (...paths) => detectMode(new Set(paths));

test('no site config is repo mode', () => {
  assert.deepEqual(mode('README.md', 'docs/a.md'), { mode: 'repo', configs: [] });
});

test('MkDocs and Antora configs are site modes', () => {
  assert.equal(mode('mkdocs.yml').mode, 'site:mkdocs');
  assert.equal(mode('mkdocs.yaml').mode, 'site:mkdocs');
  assert.equal(mode('docs/antora.yml', 'docs/modules/ROOT/pages/index.adoc').mode, 'site:antora');
  assert.deepEqual(mode('antora.yml', 'modules/usage/pages/a.adoc').configs, [{ generator: 'antora', path: 'antora.yml' }]);
});

test('an antora.yml counts only beside tracked modules/*/pages/ files', () => {
  assert.equal(mode('tests/antora.yml').mode, 'repo', 'a fixture descriptor with no modules');
  assert.equal(mode('antora.yml', 'modules/ROOT/nav.adoc').mode, 'repo', 'nav alone is no page');
  assert.equal(mode('examples/antora.yml', 'docs/modules/ROOT/pages/index.adoc').mode, 'repo', 'pages belong to another directory');
  assert.equal(mode('tests/antora.yml', 'mkdocs.yml').mode, 'site:mkdocs', 'a fixture does not make it multiple');
});

test('other generators are site-unsupported', () => {
  assert.equal(mode('docusaurus.config.ts').mode, 'site-unsupported:docusaurus');
  assert.equal(mode('website/docusaurus.config.js').mode, 'site-unsupported:docusaurus');
  assert.equal(mode('docs/conf.py', 'docs/index.rst').mode, 'site-unsupported:sphinx');
  assert.equal(mode('docs/source/conf.py', 'docs/source/index.md').mode, 'site-unsupported:sphinx');
  assert.equal(mode('hugo.toml').mode, 'site-unsupported:hugo');
});

test('a Jekyll _config.yml is not a site config: its Markdown is published as written, so the repo is checked as a repo', () => {
  assert.equal(mode('_config.yml', 'docs/a.md').mode, 'repo');
  assert.equal(mode('docs/_config.yml', 'docs/a.md').mode, 'repo');
  assert.equal(mode('_config.yml', 'mkdocs.yml').mode, 'site:mkdocs', 'not multiple');
});

test('look-alikes are not site configs', () => {
  assert.equal(mode('conf.py').mode, 'repo', 'conf.py without an index is not Sphinx');
  assert.equal(mode('examples/site/hugo.toml').mode, 'repo', 'too deep');
  assert.equal(mode('.github/mkdocs.yml').mode, 'repo', 'dot-directory');
  assert.equal(mode('docs/mkdocs.yml').mode, 'repo', 'MkDocs config is root-only');
  assert.equal(mode('src/_config.yml').mode, 'repo');
});

test('two configs are site-unsupported:multiple, listing both', () => {
  assert.deepEqual(mode('mkdocs.yml', 'hugo.toml'), {
    mode: 'site-unsupported:multiple',
    configs: [{ generator: 'hugo', path: 'hugo.toml' }, { generator: 'mkdocs', path: 'mkdocs.yml' }],
  });
});

test('resolve: relative, parent, root-relative, anchors, directories, misses', () => {
  const tracked = new Set(['README.md', 'LICENSE', 'docs/a.md', 'docs/my file.md', 'docs/dev/README.md', 'docs/dev/x.md', 'docs/raw/y.md']);
  const pages = new Set([...tracked].filter((p) => p.endsWith('.md')));
  const resolve = makeResolve(tracked, pages);
  assert.equal(resolve('docs/a.md', 'README.md'), 'docs/a.md');
  assert.equal(resolve('../README.md', 'docs/a.md'), 'README.md');
  assert.equal(resolve('/docs/a.md', 'docs/dev/x.md'), 'docs/a.md');
  assert.equal(resolve('a.md#part', 'docs/dev/../x.md'), 'docs/a.md');
  assert.equal(resolve('my%20file.md', 'docs/a.md'), 'docs/my file.md');
  assert.equal(resolve('dev/', 'docs/a.md'), 'docs/dev/README.md');
  assert.equal(resolve('raw', 'docs/a.md'), 'docs/raw');
  assert.equal(resolve('LICENSE', 'README.md'), 'LICENSE');
  assert.equal(resolve('../', 'docs/a.md'), 'README.md');
  assert.equal(resolve('gone.md', 'docs/a.md'), null);
  assert.equal(resolve('#top', 'README.md'), null);
  assert.equal(resolve('https://example.com/x.md', 'README.md'), null);
  assert.equal(resolve('../../outside.md', 'docs/a.md'), null);
  assert.equal(resolve('a.md?plain=1', 'docs/x.md'), 'docs/a.md');
  assert.equal(resolve('%2e%2e/%2e%2e/outside.md', 'docs/a.md'), null);
  assert.equal(resolve('b%zz.md', 'docs/a.md'), null);
});

test('indexPage prefers README over index', () => {
  assert.equal(indexPage('docs', new Set(['docs/index.md', 'docs/README.md'])), 'docs/README.md');
  assert.equal(indexPage('docs/adr', new Set(['docs/adr/index.md'])), 'docs/adr/index.md');
  assert.equal(indexPage('docs', new Set(['docs/a.md'])), null);
  assert.equal(indexPage('.', new Set(['README.adoc'])), 'README.adoc');
});

test('indexPage: with the MkDocs published set, a published index.md beats README.md', () => {
  const pages = new Set(['docs/index.md', 'docs/README.md', 'docs/adr/README.md']);
  assert.equal(indexPage('docs', pages, new Set(['docs/index.md'])), 'docs/index.md');
  assert.equal(indexPage('docs', pages, new Set()), 'docs/README.md');
  assert.equal(indexPage('docs/adr', pages, new Set(['docs/index.md'])), 'docs/adr/README.md');
  assert.equal(indexPage('.', new Set(['index.md', 'README.md']), new Set(['index.md'])), 'index.md');
});

test('buildGraph: tracked doc pages, navigable edges only, README front door', async () => {
  const root = tempRepo({
    '.gitignore': 'docs/superpowers/\n',
    'README.md': '# P\n\n[A](docs/a.md) ![logo](docs/logo.png) <https://example.com> [L](LICENSE) [gone](docs/gone.md)\n',
    'LICENSE': 'MIT\n',
    'docs/a.md': '# A\n\n[back](../README.md)\n',
    'docs/logo.png': 'png',
    'docs/superpowers/plan.md': '# draft\n',
    '.github/SECURITY.md': '# Security\n',
  });
  const g = await buildGraph(root);
  assert.equal(g.mode, 'repo');
  assert.equal(g.adapter, 'links');
  assert.deepEqual(g.frontDoors, ['README.md']);
  assert.deepEqual(g.pages, ['README.md', 'docs/a.md'], 'untracked and dot-directory docs are not pages');
  assert.deepEqual(g.globalNav, []);
  assert.ok(g.tracked.has('.github/SECURITY.md'));
  assert.ok(g.models.get('README.md').headings.length > 0);
  assert.deepEqual(
    g.edges.map((e) => `${e.from}:${e.line}->${e.to}`).sort(),
    ['README.md:3->LICENSE', 'README.md:3->docs/a.md', 'docs/a.md:3->README.md'],
  );
});

test('buildGraph: a tracked symlink resolving outside the repo is not a page', async () => {
  const elsewhere = tempDir();
  writeFiles(elsewhere, { 'secret.md': '# outside\n' });
  const root = tempDir();
  writeFiles(root, { 'docs/in.md': '# in\n' });
  symlinkSync(join(elsewhere, 'secret.md'), join(root, 'docs/out.md'));
  commitAll(root);
  const g = await buildGraph(root);
  assert.deepEqual(g.pages, ['docs/in.md']);
});

test('buildGraph: an AsciiDoc README is the front door; no README means none', async () => {
  const adoc = await buildGraph(tempRepo({ 'README.adoc': '= P\n\nxref:docs/a.adoc[A]\n', 'docs/a.adoc': '= A\n' }));
  assert.deepEqual(adoc.frontDoors, ['README.adoc']);
  assert.deepEqual(adoc.edges.map((e) => e.to), ['docs/a.adoc']);
  const none = await buildGraph(tempRepo({ 'docs/a.md': '# A\n' }));
  assert.deepEqual(none.frontDoors, []);
});

test('reachable follows cycles once and lands on a directory listing', async () => {
  const g = await buildGraph(tempRepo({
    'README.md': '# P\n\n[a](docs/a.md) [raw](docs/raw/)\n',
    'docs/a.md': '[b](b.md)\n',
    'docs/b.md': '[a](a.md)\n',
    'docs/raw/x.md': '# x\n',
    'docs/raw/deep/y.md': '# y\n',
    'docs/lost.md': '# lost\n',
  }));
  assert.deepEqual([...reachable(g, g.frontDoors)].sort(), ['README.md', 'docs/a.md', 'docs/b.md', 'docs/raw/x.md']);
});

test('CLI --mode prints the mode and never runs repository code', () => {
  const root = tempRepo({
    'README.md': '# P\n',
    'docusaurus.config.js': "require('fs').writeFileSync(__dirname + '/MARKER', 'ran');\n",
    'sidebars.js': "require('fs').writeFileSync(__dirname + '/MARKER', 'ran');\n",
  });
  const out = JSON.parse(execFileSync('node', [SCRIPT, '--mode'], { cwd: root, encoding: 'utf8', env: GENV }));
  assert.deepEqual(out, { mode: 'site-unsupported:docusaurus', configs: [{ generator: 'docusaurus', path: 'docusaurus.config.js' }] });
  assert.ok(!existsSync(join(root, 'MARKER')), 'a site config was executed');
});

test('CLI exits 2 outside git and on bad arguments', () => {
  const dir = tempDir();
  const outside = spawnSync('node', [SCRIPT, '--mode'], { cwd: dir, encoding: 'utf8', env: { ...GENV, GIT_CEILING_DIRECTORIES: dir } });
  assert.equal(outside.status, 2);
  assert.match(outside.stderr, /not a git repository/);
  const bad = spawnSync('node', [SCRIPT], { cwd: tempDir(), encoding: 'utf8', env: GENV });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /usage/);
});

test('MkDocs graph: site pages, sidebar, home + README front doors, site URL', async () => {
  const g = await buildGraph(tempRepo(mkdocsFiles()));
  assert.equal(g.mode, 'site:mkdocs');
  assert.equal(g.adapter, 'mkdocs');
  assert.equal(g.readme, 'README.md');
  assert.deepEqual(g.frontDoors, ['docs/index.md', 'README.md']);
  assert.deepEqual(g.sitePages, ['docs/guide/a.md', 'docs/guide/b.md', 'docs/guide/lost.md', 'docs/index.md']);
  assert.deepEqual(g.globalNav, ['docs/guide/a.md', 'docs/index.md']);
  assert.equal(g.home, 'docs/index.md');
  assert.equal(g.siteUrl, 'https://example.org/relaybox/');
  assert.equal(g.unreadable, null);
  assert.deepEqual(g.unresolved, []);
});

test('Antora graph: a link: to a page .html makes an edge to its source; link: to a .adoc path does not', async () => {
  const lost = 'docs/modules/usage/pages/lost.adoc';
  const files = { ...antoraFiles(), [lost]: '= Lost\n\nlink:config.html[Config]\n\nlink:config.adoc[wrong]\n' };
  const g = await buildGraph(tempRepo(files));
  assert.deepEqual(g.edges.filter((e) => e.from === lost), [{ from: lost, line: 3, to: 'docs/modules/usage/pages/config.adoc' }]);
});

test('Antora graph: link: edges follow the published URL space between ROOT and other modules', async () => {
  const root = 'docs/modules/ROOT/pages/hub.adoc';
  const usage = 'docs/modules/usage/pages/back.adoc';
  const files = {
    ...antoraFiles(),
    [root]: '= Hub\n\nlink:usage/config.html[Config]\n\nlink:usage/missing.html[Missing]\n',
    [usage]: '= Back\n\nlink:../index.html[Home]\n\nlink:config.html[Sibling]\n',
  };
  const g = await buildGraph(tempRepo(files));
  assert.deepEqual(g.edges.filter((e) => e.from === root), [{ from: root, line: 3, to: 'docs/modules/usage/pages/config.adoc' }]);
  assert.deepEqual(g.edges.filter((e) => e.from === usage), [
    { from: usage, line: 3, to: 'docs/modules/ROOT/pages/index.adoc' },
    { from: usage, line: 5, to: 'docs/modules/usage/pages/config.adoc' },
  ]);
});

test('Antora graph: a Markdown file under modules/ keeps plain path resolution for its links', async () => {
  const md = 'docs/modules/ROOT/pages/notes.md';
  const files = { ...antoraFiles(), [md]: '# Notes\n\n[sibling](other.md) and [page](usage/config.html)\n', 'docs/modules/ROOT/pages/other.md': '# Other\n' };
  const g = await buildGraph(tempRepo(files));
  assert.deepEqual(g.edges.filter((e) => e.from === md).map((e) => e.to), ['docs/modules/ROOT/pages/other.md']);
});

test('MkDocs without nav: every site page is in the sidebar', async () => {
  const files = { ...mkdocsFiles(), 'mkdocs.yml': 'site_name: relaybox\n' };
  const g = await buildGraph(tempRepo(files));
  assert.deepEqual(g.globalNav, g.sitePages);
  assert.equal(g.siteUrl, null);
});

const dirNav = (extra) => ({ 'README.md': '# R\n', 'mkdocs.yml': 'nav:\n  - Home: index.md\n  - Dev: dev-guide/\n', 'docs/index.md': '# Home\n', ...extra });

test('MkDocs directory nav entry contributes its README.md index page', async () => {
  const g = await buildGraph(tempRepo(dirNav({ 'docs/dev-guide/README.md': '# Dev\n', 'docs/dev-guide/api.md': '# API\n' })));
  assert.deepEqual(g.globalNav, ['docs/dev-guide/README.md', 'docs/index.md']);
});

test('MkDocs directory nav entry prefers index.md over README.md', async () => {
  const g = await buildGraph(tempRepo(dirNav({ 'docs/dev-guide/README.md': '# Dev\n', 'docs/dev-guide/index.md': '# Dev\n' })));
  assert.deepEqual(g.globalNav, ['docs/dev-guide/index.md', 'docs/index.md']);
});

test('MkDocs directory nav entry without an index page adds nothing', async () => {
  const g = await buildGraph(tempRepo(dirNav({ 'docs/dev-guide/api.md': '# API\n' })));
  assert.deepEqual(g.globalNav, ['docs/index.md']);
});

test('MkDocs INHERIT keeps the links adapter, with the reason', async () => {
  const g = await buildGraph(tempRepo({ ...mkdocsFiles(), 'mkdocs.yml': 'INHERIT: base.yml\n' }));
  assert.equal(g.mode, 'site:mkdocs');
  assert.equal(g.adapter, 'links');
  assert.match(g.unreadable, /inherits from base\.yml/);
});

test('Antora graph: xref edges, sidebar from nav.adoc, unresolved cross-component xref', async () => {
  const g = await buildGraph(tempRepo(antoraFiles()));
  assert.equal(g.adapter, 'antora');
  assert.equal(g.readme, 'README.adoc');
  assert.deepEqual(g.frontDoors, ['docs/modules/ROOT/pages/index.adoc', 'README.adoc']);
  assert.deepEqual(g.sitePages, [
    'docs/modules/ROOT/pages/index.adoc', 'docs/modules/ROOT/pages/install.adoc',
    'docs/modules/usage/pages/config.adoc', 'docs/modules/usage/pages/lost.adoc',
  ]);
  assert.deepEqual(g.globalNav, ['docs/modules/ROOT/pages/index.adoc', 'docs/modules/usage/pages/config.adoc']);
  assert.ok(g.edges.some((e) => e.from === 'docs/modules/ROOT/pages/index.adoc' && e.to === 'docs/modules/ROOT/pages/install.adoc'));
  assert.equal(g.siteUrl, 'https://docs.example.org');
  assert.deepEqual(g.unresolved.map((u) => [u.from, u.target]).sort(), [
    ['docs/modules/ROOT/pages/index.adoc', 'other::intro.adoc'],
    ['docs/modules/ROOT/partials/note.adoc', 'index.adoc'],
  ]);
  assert.match(g.unresolved.find((u) => u.target === 'other::intro.adoc').reason, /component other/);
});

test('Antora: an xref to an unpublished _ page is unresolved with a reason, never an edge', async () => {
  const files = {
    ...antoraFiles(),
    'docs/modules/ROOT/pages/_drafts/plan.adoc': '= Plan\n',
    'docs/modules/ROOT/pages/guide.adoc': '= Guide\n\nxref:_drafts/plan.adoc[Plan]\n',
  };
  const g = await buildGraph(tempRepo(files));
  const u = g.unresolved.find((x) => x.target === '_drafts/plan.adoc');
  assert.match(u.reason, /not publish/);
  assert.ok(!g.edges.some((e) => e.to === 'docs/modules/ROOT/pages/_drafts/plan.adoc' && e.from.endsWith('guide.adoc')));
});

test('Antora: a nav file antora.yml lists but git does not track is unresolved', async () => {
  const files = { ...antoraFiles(), 'docs/antora.yml': 'name: relaybox\nnav:\n- modules/ROOT/nav.adoc\n- modules/usage/nav.adoc\n' };
  const g = await buildGraph(tempRepo(files));
  assert.ok(g.unresolved.some((u) => u.from === 'docs/antora.yml' && u.target === 'docs/modules/usage/nav.adoc' && /not tracked/.test(u.reason)));
});

test('Antora: a tracked nav file deleted from the work tree is unresolved without claiming it is untracked', async () => {
  const root = tempRepo(antoraFiles());
  rmSync(join(root, 'docs/modules/ROOT/nav.adoc'));
  const g = await buildGraph(root);
  const u = g.unresolved.find((x) => x.from === 'docs/antora.yml' && x.target === 'docs/modules/ROOT/nav.adoc');
  assert.equal(u.reason, 'nav file listed in antora.yml is tracked but missing from the work tree');
});

test('Antora: a tracked nav file under a hidden directory is unresolved as not read', async () => {
  const files = { ...antoraFiles(), 'docs/antora.yml': 'name: relaybox\nnav:\n- modules/.hidden/nav.adoc\n', 'docs/modules/.hidden/nav.adoc': '* xref:index.adoc[Home]\n' };
  const g = await buildGraph(tempRepo(files));
  const u = g.unresolved.find((x) => x.target === 'docs/modules/.hidden/nav.adoc');
  assert.match(u.reason, /is tracked but not read: under a hidden directory, outside the repo, or not a doc file/);
});

test('malformed site configs reject, naming the file', async () => {
  await assert.rejects(buildGraph(tempRepo({ ...mkdocsFiles(), 'mkdocs.yml': 'nav: [\n' })), /mkdocs\.yml: malformed YAML/);
  await assert.rejects(buildGraph(tempRepo({ ...antoraFiles(), 'docs/antora.yml': 'version: 1\n' })), /docs\/antora\.yml: name must be/);
});

test('a tracked site config deleted from the work tree is absent: repo mode, no crash', async () => {
  for (const [files, config] of [[mkdocsFiles(), 'mkdocs.yml'], [antoraFiles(), 'docs/antora.yml']]) {
    const root = tempRepo(files);
    rmSync(join(root, config));
    const g = await buildGraph(root);
    assert.equal(g.mode, 'repo', config);
    assert.deepEqual(g.configs, [], config);
    assert.equal(g.adapter, 'links', config);
  }
});

test('Antora: a tracked playbook deleted from the work tree gives no site URL, no crash', async () => {
  const root = tempRepo(antoraFiles());
  rmSync(join(root, 'antora-playbook.yml'));
  const g = await buildGraph(root);
  assert.equal(g.mode, 'site:antora');
  assert.equal(g.siteUrl, null);
});

test('repo mode: readme is set and site fields are empty', async () => {
  const g = await buildGraph(tempRepo({ 'README.md': '# P\n' }));
  assert.equal(g.readme, 'README.md');
  assert.deepEqual([g.sitePages, g.globalNav, g.unresolved, g.home, g.siteUrl, g.unreadable], [[], [], [], null, null, null]);
});

test('landOn: a page lands on itself, a directory with no index on its direct pages, a non-doc file nowhere', async () => {
  const graph = await buildGraph(tempRepo({ 'README.md': '# P\n', 'LICENSE': 'MIT\n', 'docs/g/a.md': '# A\n', 'docs/g/sub/b.md': '# B\n' }));
  assert.deepEqual(landOn(graph, 'README.md'), ['README.md']);
  assert.deepEqual(landOn(graph, 'docs/g'), ['docs/g/a.md']);
  assert.deepEqual(landOn(graph, 'LICENSE'), []);
});

test('edgesOutOf: a doc in a dot-directory gets its links; a page reuses its edges; a symlink out of the repo gets none', async () => {
  const root = tempRepo({ 'README.md': '# P\n\n[x](docs/x.md)\n', 'docs/x.md': '# X\n', '.github/SECURITY.md': '# S\n\n[x](../docs/x.md)\n' });
  const graph = await buildGraph(root);
  assert.deepEqual(await edgesOutOf(graph, '.github/SECURITY.md'), [{ from: '.github/SECURITY.md', line: 3, to: 'docs/x.md' }]);
  assert.deepEqual(await edgesOutOf(graph, 'README.md'), [{ from: 'README.md', line: 3, to: 'docs/x.md' }]);
  assert.deepEqual(await edgesOutOf(graph, 'nope.md'), []);
  const outside = tempDir();
  writeFileSync(join(outside, 'evil.md'), '[x](docs/x.md)\n');
  const linked = tempDir();
  writeFiles(linked, { 'README.md': '# P\n', 'docs/x.md': '# X\n' });
  mkdirSync(join(linked, '.github'));
  symlinkSync(join(outside, 'evil.md'), join(linked, '.github/SECURITY.md'));
  commitAll(linked);
  assert.deepEqual(await edgesOutOf(await buildGraph(linked), '.github/SECURITY.md'), []);
});

test('MkDocs: a directory link resolves to index.md, which MkDocs publishes over README.md; repo mode keeps README first', async () => {
  const files = { ...mkdocsFiles(), 'README.md': '# P\n\n[Docs](docs/)\n', 'docs/README.md': '# Readme\n' };
  const site = await buildGraph(tempRepo(files));
  assert.deepEqual(site.edges.filter((e) => e.from === 'README.md').map((e) => e.to), ['docs/index.md']);
  const repo = await buildGraph(tempRepo({ 'README.md': '# P\n\n[Docs](docs/)\n', 'docs/README.md': '# R\n', 'docs/index.md': '# I\n' }));
  assert.deepEqual(repo.edges.filter((e) => e.from === 'README.md').map((e) => e.to), ['docs/README.md']);
});

test('MkDocs: a tracked index.md deleted from the work tree no longer hides README.md, which MkDocs then publishes as the index', async () => {
  const root = tempRepo({ ...mkdocsFiles(), 'README.md': '# P\n\n[Docs](docs/)\n', 'docs/README.md': '# Readme\n' });
  rmSync(join(root, 'docs/index.md'));
  const g = await buildGraph(root);
  assert.equal(g.home, 'docs/README.md');
  assert.deepEqual(g.edges.filter((e) => e.from === 'README.md').map((e) => e.to), ['docs/README.md']);
  assert.ok(g.mkdocsPages.has('docs/README.md'));
  assert.ok(!g.mkdocsPages.has('docs/index.md'));
});

test('loadOutsideEdges: reachable follows a chain of dot-directory docs only after they are loaded, and never reads an unreached one', async () => {
  const g = await buildGraph(tempRepo({
    'README.md': '# P\n\n[a](.github/A.md)\n',
    '.github/A.md': '# A\n\n[b](B.md)\n',
    '.github/B.md': '# B\n\n[x](../docs/x.md)\n',
    '.github/C.md': '# C\n\n[y](../docs/y.md)\n',
    'docs/x.md': '# X\n',
    'docs/y.md': '# Y\n',
  }));
  assert.deepEqual([...reachable(g, g.frontDoors, { outsidePages: true })].sort(), ['.github/A.md', 'README.md']);
  await loadOutsideEdges(g, g.frontDoors);
  assert.deepEqual([...reachable(g, g.frontDoors, { outsidePages: true })].sort(), ['.github/A.md', '.github/B.md', 'README.md', 'docs/x.md']);
  assert.deepEqual([...g.outsideEdges.keys()].sort(), ['.github/A.md', '.github/B.md']);
});
