import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { parseDoc } from '../../../module/skills/docs-organization/scripts/formats/index.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { frontDoorFindings, statusFindings, doorFindings, gateFindings, entryPaths, analyzeRouting, THRESHOLDS } from '../../../module/skills/docs-organization/scripts/check-routing.mjs';
import { buildGraph } from '../../../module/skills/docs-organization/scripts/nav-graph.mjs';
import { GENV, commitAll, lines, removeTemp, tempDir, tempRepo, writeFiles, crosscodexFiles, writeSmallProject, mkdocsFiles, antoraFiles } from './routing-fixtures.mjs';

after(removeTemp);

const codes = (fs) => fs.map((f) => f.code);
const door = async (src, name = 'README.md') => frontDoorFindings(name, await parseDoc(name, src));
const only = (fs, code) => fs.filter((f) => f.code === code);

// Line layout: 1 title, 2 blank, 3..(2+n) filler, blank, heading.
test(`FRONT_DOOR_BLOCKED: ${THRESHOLDS.frontDoorLead} lines before Install pass, one more fires`, async () => {
  const at = (n) => `# P\n\n${lines(n)}\n\n## Install\n\nrun it\n`;
  assert.deepEqual(only(await door(at(THRESHOLDS.frontDoorLead - 2)), 'FRONT_DOOR_BLOCKED'), []);
  const hit = only(await door(at(THRESHOLDS.frontDoorLead - 1)), 'FRONT_DOOR_BLOCKED');
  assert.equal(hit.length, 1);
  assert.equal(hit[0].line, THRESHOLDS.frontDoorLead + 3);
  assert.equal(hit[0].file, 'README.md');
  assert.equal(hit[0].severity, 'warning');
  assert.match(hit[0].message, /"Install" starts 41 lines after the title/);
});

test('FRONT_DOOR_BLOCKED fires at the title when no getting-started heading exists', async () => {
  const hit = only(await door('intro\n\n# P\n\n## Usage\n\ntext\n'), 'FRONT_DOOR_BLOCKED');
  assert.equal(hit.length, 1);
  assert.equal(hit[0].line, 3);
  assert.match(hit[0].message, /no getting-started heading/);
});

test('getting-started headings: variants count, look-alikes do not', async () => {
  for (const h of ['🚀 Quick Start', 'Installation', 'Installing on Linux', 'Quickstart', 'Getting started', '1. Install', 'Get started', 'Setup', 'Set up']) {
    assert.deepEqual(only(await door(`# P\n\n## ${h}\n\nrun\n`), 'FRONT_DOOR_BLOCKED'), [], h);
  }
  for (const h of ['Installer flags', 'Starting the server', 'Reinstall', 'Settings', 'Setups']) {
    assert.equal(only(await door(`# P\n\n## ${h}\n\nrun\n`), 'FRONT_DOOR_BLOCKED').length, 1, h);
  }
});

test('getting-started heading: nested counts only under getting-started ancestors', async () => {
  const blocked = only(await door('# P\n\n## Contributing\n\n### Setup\n\nrun\n'), 'FRONT_DOOR_BLOCKED');
  assert.equal(blocked.length, 1);
  assert.match(blocked[0].message, /no getting-started heading/);
  assert.deepEqual(only(await door('# P\n\n## Getting started\n\n### Install\n\nrun\n'), 'FRONT_DOOR_BLOCKED'), []);
  assert.deepEqual(only(await door('# P\n\n## Install\n\nrun\n'), 'FRONT_DOOR_BLOCKED'), []);
});

test('MISPLACED_SECTION: a Setup nested under a long Contributing section does not exempt it', async () => {
  const src = `# P\n\n## Install\n\nrun\n\n## Contributing\n\n### Setup\n\n${lines(40)}\n`;
  assert.equal(only(await door(src), 'MISPLACED_SECTION').length, 1);
});

test('AsciiDoc README: == Quick start counts, and lead length is measured the same way', async () => {
  assert.deepEqual(await door('= P\n\n== Quick start\n\nrun\n', 'README.adoc'), []);
  const late = `= P\n\n${lines(THRESHOLDS.frontDoorLead)}\n\n== Quick start\n\nrun\n`;
  assert.deepEqual(codes(await door(late, 'README.adoc')), ['FRONT_DOOR_BLOCKED']);
});

// Install at line 3; body of n filler lines; next H2 at n + 6.
test(`LONG_QUICKSTART: a ${THRESHOLDS.quickstartLines}-line section passes, one more fires`, async () => {
  const qs = (n) => `# P\n\n## Install\n\n${lines(n)}\n\n## Next\n`;
  assert.deepEqual(only(await door(qs(THRESHOLDS.quickstartLines - 3)), 'LONG_QUICKSTART'), []);
  const hit = only(await door(qs(THRESHOLDS.quickstartLines - 2)), 'LONG_QUICKSTART');
  assert.equal(hit.length, 1);
  assert.equal(hit[0].line, 3);
  assert.match(hit[0].message, /docs\/usage\/getting-started\.md/);
});

test('LONG_QUICKSTART names the destination in the front door\'s own format', async () => {
  const adoc = `= P\n\n== Install\n\n${lines(THRESHOLDS.quickstartLines)}\n\n== Next\n`;
  const hit = only(await door(adoc, 'README.adoc'), 'LONG_QUICKSTART');
  assert.equal(hit.length, 1);
  assert.match(hit[0].message, /docs\/usage\/getting-started\.adoc/);
  assert.doesNotMatch(hit[0].message, /getting-started\.md/);
});

test('LONG_QUICKSTART reports a nested getting-started section once, at the outer one', async () => {
  const src = `# P\n\n## Install\n\n${lines(30)}\n\n### Quickstart\n\n${lines(70)}\n\n## Next\n`;
  const hit = only(await door(src), 'LONG_QUICKSTART');
  assert.deepEqual(hit.map((f) => f.line), [3]);
});

// Reference H2 at line 7; next H2 at 7 + n + 3.
test(`MISPLACED_SECTION: a ${THRESHOLDS.sectionLines}-line H2 passes, one more fires as a candidate`, async () => {
  const sec = (n) => `# P\n\n## Install\n\nrun it\n\n## Reference\n\n${lines(n)}\n\n## End\n`;
  assert.deepEqual(only(await door(sec(THRESHOLDS.sectionLines - 3)), 'MISPLACED_SECTION'), []);
  const hit = only(await door(sec(THRESHOLDS.sectionLines - 2)), 'MISPLACED_SECTION');
  assert.equal(hit.length, 1);
  assert.equal(hit[0].line, 7);
  assert.match(hit[0].message, /section "Reference" spans 31 lines/);
  assert.match(hit[0].message, /candidate/);
});

test('MISPLACED_SECTION skips getting-started sections', async () => {
  const src = `# P\n\n## Install\n\n### Quick start\n\n${lines(40)}\n\n## Quickstart\n\n${lines(40)}\n`;
  assert.deepEqual(only(await door(src), 'MISPLACED_SECTION'), []);
});

test('MISSING_STATUS: each status form passes; absence fires', async () => {
  const st = async (src, name = 'README.md') => statusFindings(name, await parseDoc(name, src));
  assert.deepEqual(await st('# P\n\n**Status:** beta, maintained\n'), []);
  assert.deepEqual(await st('# P\n\nStatus: alpha\n'), []);
  assert.deepEqual(await st('# P\n\nA tool.\nStatus: alpha\n'), []);
  assert.deepEqual(await st('# P\n\n## Status\n\nBeta.\n'), []);
  assert.deepEqual(await st('= P\n\n*Status:* beta\n', 'README.adoc'), []);
  assert.deepEqual(await st('# P\n\n## Project status\n\nBeta.\n'), []);
  assert.deepEqual(await st('# P\n\n- **Status:** beta\n- Docs: here\n'), []);
  assert.deepEqual(await st('= P\n\n* *Status:* beta\n', 'README.adoc'), []);
  assert.deepEqual(await st('# P\n\n**Status**: beta\n'), []);
  assert.deepEqual(await st('# P\n\n- **Status**: beta\n'), []);
  assert.deepEqual(await st('= P\n\n*Status*: beta\n', 'README.adoc'), []);
  for (const title of ['Development status', 'Maintenance status', 'Status and roadmap']) assert.deepEqual(await st(`# P\n\n## ${title}\n\nBeta.\n`), [], title);
  for (const title of ['Build status', 'Exit status codes']) assert.deepEqual(codes(await st(`# P\n\n## ${title}\n\nA tool.\n`)), ['MISSING_STATUS'], title);
  assert.deepEqual(codes(await st('# P\n\n## Statusbar widget\n\nA tool.\n')), ['MISSING_STATUS']);
  assert.deepEqual(codes(await st('# P\n\n- Statusbar: shown\n')), ['MISSING_STATUS']);
  const hit = await st('# P\n\nA tool.\n');
  assert.deepEqual(codes(hit), ['MISSING_STATUS']);
  assert.equal(hit[0].severity, 'info');
  assert.equal(hit[0].line, null);
});

const README = '# P\n\n## Install\n\nrun\n';
const doors = async (files) => doorFindings(await buildGraph(tempRepo(files)));
const gates = async (files) => gateFindings(await buildGraph(tempRepo(files)));

test('entryPaths: case, extensions, separators, and lookup directories', () => {
  const tracked = new Set(['LICENSE-MIT', 'license.txt', 'LICENSES/x', 'docs/LICENSE', '.github/SECURITY.md', 'CHANGELOGS.md']);
  assert.deepEqual(entryPaths({ file: ['LICENSE'], in: ['.'], variants: true }, tracked).sort(), ['LICENSE-MIT', 'license.txt']);
  assert.deepEqual(entryPaths({ file: ['SECURITY'], in: ['.', '.github'] }, tracked), ['.github/SECURITY.md']);
  assert.deepEqual(entryPaths({ file: ['CHANGELOG'], in: ['.'] }, tracked), []);
  assert.deepEqual(entryPaths({ dir: 'docs' }, tracked), ['docs/LICENSE']);
});

test('MISSING_DOOR: an entry point with no link from the README fires, naming the persona', async () => {
  const hit = await doors({ 'README.md': README, 'SECURITY.md': '# S\n' });
  assert.deepEqual(codes(hit), ['MISSING_DOOR']);
  assert.equal(hit[0].file, 'README.md');
  assert.equal(hit[0].severity, 'warning');
  assert.match(hit[0].message, /^Security: `SECURITY.md` exists/);
});

test('MISSING_DOOR: the message names the path that exists, not the lookup pattern', async () => {
  const hit = await doors({ 'README.md': README, '.github/SECURITY.md': '# S\n' });
  assert.deepEqual(codes(hit), ['MISSING_DOOR']);
  assert.match(hit[0].message, /^Security: `\.github\/SECURITY\.md` exists/);
});

test('MISSING_DOOR: a link to the file, its directory, or a page inside satisfies it', async () => {
  assert.deepEqual(await doors({ 'README.md': `${README}\n[s](SECURITY.md)\n`, 'SECURITY.md': '# S\n' }), []);
  assert.deepEqual(await doors({ 'README.md': `${README}\n[s](.github/SECURITY.md)\n`, '.github/SECURITY.md': '# S\n' }), []);
  assert.deepEqual(await doors({ 'README.md': `${README}\n[d](docs/dev/)\n`, 'docs/dev/arch.md': '# A\n' }), []);
  assert.deepEqual(await doors({ 'README.md': `${README}\n[d](docs/dev/arch.md)\n`, 'docs/dev/arch.md': '# A\n' }), []);
});

test('MISSING_DOOR: absent entry points and issue templates owe no door', async () => {
  assert.deepEqual(await doors({ 'README.md': `${README}\n[L](LICENSE)\n`, 'LICENSE': 'MIT\n' }), []);
  assert.deepEqual(await doors({ 'README.md': README, '.github/ISSUE_TEMPLATE/bug.yml': 'name: bug\n' }), []);
  assert.deepEqual(await doors({ 'README.md': README, 'AGENTS.md': '# rules\n' }), []);
});

test('MISSING_DOOR: a lowercase changelog is the operator entry point', async () => {
  const hit = await doors({ 'README.md': README, 'changelog.md': '# c\n' });
  assert.match(hit[0].message, /^Operator:/);
});

test('MISSING_GATE_FILE: README only reports license (warning), security and support (info)', async () => {
  const hit = await gates({ 'README.md': README });
  assert.deepEqual(hit.map((f) => [f.code, f.severity, f.message.split(':')[0]]), [
    ['MISSING_GATE_FILE', 'info', 'Security'],
    ['MISSING_GATE_FILE', 'warning', 'Lawyer'],
    ['MISSING_GATE_FILE', 'info', 'Support seeker'],
  ]);
  assert.ok(hit.every((f) => f.file === null && f.line === null));
});

test('MISSING_GATE_FILE: license variants and health-file locations satisfy it', async () => {
  const base = { 'README.md': README, 'docs/SECURITY.md': '# s\n', '.github/ISSUE_TEMPLATE/bug.yml': 'name: bug\n' };
  for (const lic of ['LICENSE-MIT', 'COPYING', 'license.txt', 'UNLICENSE', 'LICENCE']) {
    assert.deepEqual(await gates({ ...base, [lic]: 'x\n' }), [], lic);
  }
});

test('MISSING_GATE_FILE: a name that only starts with the stem is a different file', async () => {
  const base = { 'README.md': README, 'LICENSE': 'x\n', 'SECURITY.md': 's\n', 'SUPPORT.md': 's\n' };
  assert.deepEqual(await gates(base), []);
  const noSec = { ...base, 'SECURITY-INSIGHTS.yml': 'x: 1\n' };
  delete noSec['SECURITY.md'];
  assert.deepEqual((await gates(noSec)).map((f) => f.message.split(':')[0]), ['Security']);
  const noSup = { ...base, 'docs/SUPPORT_MATRIX.md': '# m\n' };
  delete noSup['SUPPORT.md'];
  assert.deepEqual((await gates(noSup)).map((f) => f.message.split(':')[0]), ['Support seeker']);
  assert.deepEqual(await gates({ ...base, 'CONTRIBUTING.md': 'c\n' }), []);
});

test('entryPaths: only entries marked `variants` take a - or _ suffix; any entry takes an extension', () => {
  const tracked = new Set(['LICENSE-MIT', 'LICENSE_APACHE', 'LICENSE.txt', 'SECURITY-INSIGHTS.yml', 'SUPPORT_MATRIX.md', 'SUPPORT.md']);
  assert.deepEqual(entryPaths({ file: ['LICENSE'], in: ['.'], variants: true }, tracked).sort(), ['LICENSE-MIT', 'LICENSE.txt', 'LICENSE_APACHE']);
  assert.deepEqual(entryPaths({ file: ['SECURITY'], in: ['.'] }, tracked), []);
  assert.deepEqual(entryPaths({ file: ['SUPPORT'], in: ['.'] }, tracked), ['SUPPORT.md']);
});

test('MISSING_GATE_FILE: a license outside the root does not count', async () => {
  const hit = await gates({ 'README.md': README, 'docs/LICENSE': 'x\n', 'SECURITY.md': 's\n', 'SUPPORT.md': 's\n' });
  assert.deepEqual(hit.map((f) => f.message.split(':')[0]), ['Lawyer']);
});

test('MISSING_GATE_FILE: a REUSE LICENSES/ directory with a file satisfies the license gate', async () => {
  const base = { 'README.md': README, 'SECURITY.md': 's\n', 'SUPPORT.md': 's\n' };
  assert.deepEqual(await gates({ ...base, 'LICENSES/MIT.txt': 'x\n' }), []);
  assert.deepEqual((await gates(base)).map((f) => f.message.split(':')[0]), ['Lawyer']);
  assert.deepEqual((await gates({ ...base, 'docs/LICENSES/MIT.txt': 'x\n' })).map((f) => f.message.split(':')[0]), ['Lawyer']);
});

test('MISSING_GATE_FILE: GitHub issue-template locations satisfy support; others do not', async () => {
  const base = { 'README.md': README, 'SECURITY.md': 's\n', 'LICENSE': 'x\n' };
  for (const t of ['.github/ISSUE_TEMPLATE.md', 'ISSUE_TEMPLATE.md', 'docs/issue_template.md', 'ISSUE_TEMPLATE/bug.yml', 'docs/ISSUE_TEMPLATE/bug.yml']) {
    assert.deepEqual(await gates({ ...base, [t]: 'x\n' }), [], t);
  }
  assert.deepEqual((await gates(base)).map((f) => f.message.split(':')[0]), ['Support seeker']);
  assert.deepEqual((await gates({ ...base, 'other/ISSUE_TEMPLATE.md': 'x\n' })).map((f) => f.message.split(':')[0]), ['Support seeker']);
});

test('entry points that are symlinks out of the repo are absent for gates and doors', async () => {
  const outside = tempDir();
  writeFileSync(join(outside, 'sec.md'), '# S\n');
  const root = tempDir();
  writeFiles(root, { 'README.md': README, 'LICENSE': 'x\n', 'SUPPORT.md': 's\n' });
  symlinkSync(join(outside, 'sec.md'), join(root, 'SECURITY.md'));
  commitAll(root);
  const graph = await buildGraph(root);
  assert.deepEqual(gateFindings(graph).map((f) => f.message.split(':')[0]), ['Security']);
  assert.ok(doorFindings(graph).every((f) => !f.message.startsWith('Security')));
});

test('MISSING_GATE_FILE: a license tracked but deleted from the work tree is absent', async () => {
  const root = tempRepo({ 'README.md': README, 'LICENSE': 'x\n', 'SECURITY.md': 's\n', 'SUPPORT.md': 's\n' });
  assert.deepEqual(gateFindings(await buildGraph(root)), []);
  rmSync(join(root, 'LICENSE'));
  assert.deepEqual(gateFindings(await buildGraph(root)).map((f) => f.message.split(':')[0]), ['Lawyer']);
});

test('MISSING_DOOR: a docs directory whose files are all deleted from the work tree is not named', async () => {
  const root = tempRepo({ 'README.md': README, 'docs/usage/a.md': '# A\n' });
  assert.match(doorFindings(await buildGraph(root))[0].message, /`docs\/usage\/` exists/);
  rmSync(join(root, 'docs/usage/a.md'));
  assert.deepEqual(doorFindings(await buildGraph(root)), []);
});

const ROUTING = fileURLToPath(new URL('../../../module/skills/docs-organization/scripts/check-routing.mjs', import.meta.url));
const route = async (files) => analyzeRouting(tempRepo(files));
const filesOf = (r, code) => r.findings.filter((f) => f.code === code).map((f) => f.file).sort();
const BACK = '# Page\n\n[Back](../README.md)\n';

test('MkDocs: a nav entry starting with / is a link, so the page it names is still orphaned', async () => {
  const files = mkdocsFiles();
  files['mkdocs.yml'] = files['mkdocs.yml'].replace('  - Source:', '  - Other: /other.md\n  - Source:');
  files['docs/other.md'] = '# Other\n';
  assert.ok(filesOf(await route(files), 'ORPHAN_PAGE').includes('docs/other.md'));
});

test('MISSING_DOOR: a site without a README runs the persona door check from the site home', async () => {
  const files = mkdocsFiles();
  delete files['README.md'];
  files['CONTRIBUTING.md'] = '# Contributing\n';
  const hit = (await route(files)).findings.filter((f) => f.code === 'MISSING_DOOR' && f.message.startsWith('Dev:'));
  assert.deepEqual(hit.map((f) => f.file), ['docs/index.md']);
});

test('MISSING_DOOR: with no front door at all the persona door check is skipped, not passed', async () => {
  const r = await route({ 'CONTRIBUTING.md': '# Contributing\n', 'docs/a.md': '# A\n' });
  assert.ok(r.skipped.some((s) => s.code === 'MISSING_DOOR' && /MISSING_README/.test(s.reason)));
});

test('ORPHAN_PAGE: a docs page no link path reaches fires; a reached one does not', async () => {
  const r = await route({ 'README.md': `${README}\n[A](docs/a.md)\n`, 'docs/a.md': BACK, 'docs/b.md': BACK });
  assert.deepEqual(filesOf(r, 'ORPHAN_PAGE'), ['docs/b.md']);
  assert.equal(r.findings.find((f) => f.code === 'ORPHAN_PAGE').severity, 'warning');
  assert.match(r.findings.find((f) => f.code === 'ORPHAN_PAGE').message, /link it from `README\.md`$/);
});

test('ORPHAN_PAGE: reach follows chains, anchors, and stops at cycles', async () => {
  const r = await route({
    'README.md': `${README}\n[dev](docs/dev/README.md) [a](docs/a.md#part)\n`,
    'docs/dev/README.md': '# Dev\n\n[back](../../README.md) [x](x.md)\n',
    'docs/dev/x.md': '# X\n\n[back](README.md)\n',
    'docs/a.md': BACK,
    'docs/c1.md': '# C1\n\n[c2](c2.md) [back](../README.md)\n',
    'docs/c2.md': '# C2\n\n[c1](c1.md) [back](../README.md)\n',
  });
  assert.deepEqual(filesOf(r, 'ORPHAN_PAGE'), ['docs/c1.md', 'docs/c2.md']);
});

test('ORPHAN_PAGE: reach follows a link through a dot-directory doc; a page only an unreached dot-directory doc links is still an orphan', async () => {
  const r = await route({
    'README.md': `${README}\n[contributing](.github/CONTRIBUTING.md)\n`,
    '.github/CONTRIBUTING.md': '# Contributing\n\n[build](../docs/dev/build.md)\n',
    'docs/dev/build.md': BACK,
    '.github/STALE.md': '# Stale\n\n[old](../docs/old.md)\n',
    'docs/old.md': BACK,
  });
  assert.deepEqual(filesOf(r, 'ORPHAN_PAGE'), ['docs/old.md']);
});

test('ORPHAN_PAGE: ADRs count as reached through a reached index; an unreached index orphans both', async () => {
  const files = (linkIndex) => ({
    'README.md': `${README}\n[dev](docs/dev/README.md)\n`,
    'docs/dev/README.md': `# Dev\n\n[back](../../README.md)${linkIndex ? ' [ADRs](adr/index.md)' : ''}\n`,
    'docs/dev/adr/index.md': '# Architectural Decision Records\n\nNo ADRs yet.\n',
    'docs/dev/adr/0001-use-x.md': '# 1. Use X\n',
  });
  const reached = await route(files(true));
  assert.deepEqual(filesOf(reached, 'ORPHAN_PAGE'), []);
  assert.deepEqual(filesOf(reached, 'NO_WAY_BACK'), [], 'ADR files are exempt from NO_WAY_BACK');
  const lost = await route(files(false));
  assert.deepEqual(filesOf(lost, 'ORPHAN_PAGE'), ['docs/dev/adr/0001-use-x.md', 'docs/dev/adr/index.md']);
});

test('ORPHAN_PAGE: broken links and pages outside docs/ are not routing findings', async () => {
  const r = await route({ 'README.md': `${README}\n[gone](docs/gone.md)\n`, 'module/notes.md': '# n\n' });
  assert.deepEqual(r.findings.filter((f) => /gone|module/.test(`${f.file} ${f.message}`)), []);
});

test('NO_WAY_BACK: links to the README, the directory index, or the parent index all count', async () => {
  const r = await route({
    'README.md': `${README}\n[u](docs/usage/README.md) [d](docs/README.md) [n](docs/none.md)\n`,
    'docs/README.md': '# Docs\n\n[back](../README.md)\n',
    'docs/usage/README.md': '# Usage\n\n[up](../README.md) [how](how.md)\n',
    'docs/usage/how.md': '# How\n\n[back](README.md)\n',
    'docs/none.md': '# None\n\nNo links here.\n',
  });
  assert.deepEqual(filesOf(r, 'NO_WAY_BACK'), ['docs/none.md']);
  const f = r.findings.find((x) => x.code === 'NO_WAY_BACK');
  assert.equal(f.severity, 'info');
  assert.match(f.message, /`README\.md`/);
});

const pages = (n, linked) => {
  const files = { 'README.md': `${README}\n${Array.from({ length: linked }, (_, i) => `[p${i}](docs/p${i}.md)`).join('\n')}\n` };
  for (let i = 0; i < n; i++) files[`docs/p${i}.md`] = BACK;
  return files;
};

test('SITE_CANDIDATE: 31 pages fire, 30 do not', async () => {
  assert.equal(filesOf(await route(pages(THRESHOLDS.sitePages, THRESHOLDS.sitePages)), 'SITE_CANDIDATE').length, 0);
  const r = await route(pages(THRESHOLDS.sitePages + 1, THRESHOLDS.sitePages + 1));
  const f = r.findings.find((x) => x.code === 'SITE_CANDIDATE');
  assert.equal(f.severity, 'info');
  assert.match(f.message, /31 pages under docs\/ besides ADRs/);
});

test('SITE_CANDIDATE: navigation strain at a quarter of at least 10 pages', async () => {
  const strain = (await route(pages(12, 9))).findings.find((x) => x.code === 'SITE_CANDIDATE');
  assert.match(strain.message, /navigation strain: 3 of 12/);
  assert.equal(filesOf(await route(pages(12, 10)), 'SITE_CANDIDATE').length, 0, '2 of 12');
  assert.equal(filesOf(await route(pages(8, 0)), 'SITE_CANDIDATE').length, 0, 'below the 10-page floor');
});

test('SITE_CANDIDATE: a persona index linking more than 15 pages fires', async () => {
  const files = (n) => {
    const f = {
      'README.md': `${README}\n[dev](docs/dev/README.md)\n`,
      'docs/dev/README.md': `# Dev\n\n[back](../../README.md)\n${Array.from({ length: n }, (_, i) => `[p${i}](p${i}.md)`).join('\n')}\n`,
    };
    for (let i = 0; i < n; i++) f[`docs/dev/p${i}.md`] = '# P\n\n[back](README.md)\n';
    return f;
  };
  assert.equal(filesOf(await route(files(THRESHOLDS.indexLinks)), 'SITE_CANDIDATE').length, 0);
  const f = (await route(files(THRESHOLDS.indexLinks + 1))).findings.find((x) => x.code === 'SITE_CANDIDATE');
  assert.match(f.message, /`docs\/dev\/README\.md` links 16 pages/);
});

test('a Jekyll repo is checked as a repo: an orphan page is reported', async () => {
  const r = await route({ 'README.md': '# P\n\nNo start here.\n', '_config.yml': 'title: p\n', 'docs/lost.md': '# lost\n' });
  assert.equal(r.mode, 'repo');
  assert.deepEqual(filesOf(r, 'ORPHAN_PAGE'), ['docs/lost.md']);
});

test('site modes skip page reachability with the reason; README checks still run', async () => {
  for (const [config, generator, extra] of [['hugo.toml', 'hugo', {}], ['docs/conf.py', 'sphinx', { 'docs/index.rst': 'Index\n=====\n' }]]) {
    const r = await route({ 'README.md': '# P\n\nNo start here.\n', [config]: 'x: 1\n', 'docs/lost.md': '# lost\n', ...extra });
    assert.equal(filesOf(r, 'ORPHAN_PAGE').length, 0, config);
    assert.equal(filesOf(r, 'NO_WAY_BACK').length, 0, config);
    assert.deepEqual(r.skipped.map((s) => s.code), ['ORPHAN_PAGE', 'NO_WAY_BACK', 'SITE_CANDIDATE', 'MISSING_DOOR', 'FRONT_DOOR_BLOCKED']);
    assert.ok(r.skipped.every((s) => s.reason.length > 0));
    assert.match(r.skipped[0].reason, new RegExp(generator));
    assert.ok(r.findings.some((f) => f.code === 'FRONT_DOOR_BLOCKED'), `${config}: README checks must still run`);
  }
  const multi = await route({ 'README.md': README, 'mkdocs.yml': 'x\n', 'hugo.toml': 'x\n' });
  assert.equal(multi.mode, 'site-unsupported:multiple');
  assert.match(multi.skipped[0].reason, /several site configs/);
});

test('no README: MISSING_DOOR and ORPHAN_PAGE are skipped, not passed', async () => {
  const r = await route({ 'docs/a.md': '# A\n' });
  assert.deepEqual(r.skipped.map((s) => s.code), ['MISSING_DOOR', 'ORPHAN_PAGE']);
  assert.match(r.skipped[0].reason, /MISSING_README/);
  assert.match(r.skipped[1].reason, /MISSING_README/);
  assert.equal(r.findings.filter((f) => ['FRONT_DOOR_BLOCKED', 'MISSING_DOOR', 'MISSING_STATUS'].includes(f.code)).length, 0);
});

test('CLI: findings exit 1 with the full envelope; a clean repo exits 0', () => {
  const dirty = tempRepo({ 'README.md': '# P\n' });
  const run = spawnSync('node', [ROUTING], { cwd: dirty, env: GENV, encoding: 'utf8' });
  assert.equal(run.status, 1);
  const out = JSON.parse(run.stdout);
  assert.deepEqual(Object.keys(out), ['status', 'mode', 'configs', 'scanned', 'skipped', 'unresolved', 'findings']);
  assert.equal(out.status, 'findings');
  const clean = tempRepo({
    'README.md': '# P\n\n**Status:** beta\n\n## Install\n\nrun\n\n[L](LICENSE) [S](SECURITY.md) [H](SUPPORT.md)\n',
    'LICENSE': 'MIT\n', 'SECURITY.md': '# S\n', 'SUPPORT.md': '# H\n',
  });
  const ok = JSON.parse(execFileSync('node', [ROUTING], { cwd: clean, env: GENV, encoding: 'utf8' }));
  assert.equal(ok.status, 'ok');
  assert.deepEqual(ok.findings, []);
});

test('CLI exits 2 outside git and with arguments', () => {
  const dir = tempDir();
  const outside = spawnSync('node', [ROUTING], { cwd: dir, env: { ...GENV, GIT_CEILING_DIRECTORIES: dir }, encoding: 'utf8' });
  assert.equal(outside.status, 2);
  assert.match(outside.stderr, /not a git repository/);
  assert.equal(spawnSync('node', [ROUTING, 'README.md'], { cwd: tempDir(), env: GENV, encoding: 'utf8' }).status, 2);
});

test('ORPHAN_PAGE names the index to link from: the directory index, or the parent of an unreached index', async () => {
  const r = await route({
    'README.md': README,
    'docs/dev/README.md': '# Dev\n\n[back](../../README.md)\n',
    'docs/dev/x.md': '# X\n\n[back](README.md)\n',
    'docs/dev/adr/index.md': '# ADRs\n',
    'docs/dev/adr/0001-a.md': '# 1\n',
  });
  const msg = (file) => r.findings.find((f) => f.code === 'ORPHAN_PAGE' && f.file === file)?.message;
  assert.match(msg('docs/dev/x.md'), /link it from `docs\/dev\/README\.md`$/);
  assert.match(msg('docs/dev/README.md'), /link it from `README\.md`$/);
  assert.match(msg('docs/dev/adr/0001-a.md'), /link it from `docs\/dev\/adr\/index\.md`$/);
  assert.match(msg('docs/dev/adr/index.md'), /link it from `docs\/dev\/README\.md`$/);
});

test('SITE_CANDIDATE: an index counts only pages in its own subtree', async () => {
  const n = THRESHOLDS.indexLinks;
  const f = {
    'README.md': `${README}\n[dev](docs/dev/README.md)\n`,
    'docs/README.md': '# Docs\n\n[dev](dev/README.md)\n',
    'docs/usage/x.md': '# X\n\n[back](../../README.md)\n',
    'docs/dev/README.md': `# Dev\n\n[back](../../README.md) [up](../README.md) [u](../usage/x.md)\n${Array.from({ length: n }, (_, i) => `[p${i}](p${i}.md)`).join('\n')}\n`,
  };
  for (let i = 0; i < n; i++) f[`docs/dev/p${i}.md`] = '# P\n\n[back](README.md)\n';
  assert.equal(filesOf(await route(f), 'SITE_CANDIDATE').length, 0);
});

test('FRONT_DOOR_BLOCKED: a README with no H1 reports at line 1', async () => {
  const hit = only(await door('intro\n\n## Usage\n\ntext\n'), 'FRONT_DOOR_BLOCKED');
  assert.equal(hit.length, 1);
  assert.equal(hit[0].line, 1);
});

test('FRONT_DOOR_BLOCKED: with no H1, every line before the heading counts', async () => {
  const at = (n) => `${Array.from({ length: n }, (_, i) => `prose ${i}`).join('\n')}\n## Install\n\nrun\n`;
  assert.deepEqual(only(await door(at(THRESHOLDS.frontDoorLead)), 'FRONT_DOOR_BLOCKED'), []);
  const hit = only(await door(at(THRESHOLDS.frontDoorLead + 1)), 'FRONT_DOOR_BLOCKED');
  assert.equal(hit.length, 1);
  assert.equal(hit[0].line, THRESHOLDS.frontDoorLead + 2);
  assert.match(hit[0].message, /starts 41 lines after the title/);
});

test('crosscodex-shaped repo: every routing problem is named', async () => {
  const r = await route(crosscodexFiles());
  assert.deepEqual(codes(r.findings).sort(), [
    'FRONT_DOOR_BLOCKED', 'LONG_QUICKSTART',
    'MISPLACED_SECTION', 'MISPLACED_SECTION', 'MISPLACED_SECTION', 'MISPLACED_SECTION',
    'MISSING_DOOR', 'MISSING_GATE_FILE', 'MISSING_STATUS', 'ORPHAN_PAGE',
  ]);
  const titles = r.findings.filter((f) => f.code === 'MISPLACED_SECTION').map((f) => f.message.match(/"([^"]+)"/)[1]);
  assert.deepEqual(titles, ['Upgrading from 1.x', 'Configuration reference', 'Security internals', 'Administration']);
  assert.match(r.findings.find((f) => f.code === 'MISSING_DOOR').message, /^Security:/);
  assert.deepEqual(filesOf(r, 'ORPHAN_PAGE'), ['docs/dev/release.md']);
});

test('template-shaped small project: no routing findings', async () => {
  const root = tempDir();
  writeSmallProject(root);
  const r = await analyzeRouting(root);
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.skipped, []);
});

test('MkDocs: a page missing from nav and unlinked is ORPHAN_PAGE; no NO_WAY_BACK or SITE_CANDIDATE', async () => {
  const r = await route(mkdocsFiles());
  assert.equal(r.mode, 'site:mkdocs');
  assert.deepEqual(filesOf(r, 'ORPHAN_PAGE'), ['docs/guide/lost.md']);
  assert.match(r.findings.find((f) => f.code === 'ORPHAN_PAGE').message, /`nav:` line in `mkdocs\.yml`/);
  assert.deepEqual(filesOf(r, 'NO_WAY_BACK'), []);
  assert.deepEqual(filesOf(r, 'SITE_CANDIDATE'), []);
  assert.deepEqual(r.skipped, []);
  assert.deepEqual(r.unresolved, []);
});

test('MkDocs: an unpublished page linking its directory counts the published index.md as the way back', async () => {
  const files = mkdocsFiles();
  files['docs/guide/README.md'] = '# Guide readme\n\n[guide](./)\n';
  files['docs/guide/index.md'] = '# Guide\n';
  files['docs/guide/extra.adoc'] = '= Extra\n\nback to link:./[the guide]\n';
  const r = await route(files);
  assert.equal(r.mode, 'site:mkdocs');
  assert.deepEqual(filesOf(r, 'NO_WAY_BACK'), []);
});

test('MkDocs without nav: no ORPHAN_PAGE', async () => {
  const r = await route({ ...mkdocsFiles(), 'mkdocs.yml': 'site_name: relaybox\nsite_url: https://example.org/relaybox/\n' });
  assert.deepEqual(filesOf(r, 'ORPHAN_PAGE'), []);
});

test('site door: a README that links neither the home page nor the URL gets MISSING_DOOR (Site)', async () => {
  const files = { ...mkdocsFiles(), 'README.md': '# relaybox\n\n**Status:** beta\n\n## Install\n\nrun it\n' };
  const f = (await route(files)).findings.filter((x) => x.code === 'MISSING_DOOR');
  assert.equal(f.length, 1);
  assert.match(f[0].message, /^Site: .*neither its home page `docs\/index\.md` nor its URL https:\/\/example\.org\/relaybox\//);
  const viaSource = { ...files, 'README.md': `${files['README.md']}\n[Docs](docs/index.md)\n` };
  assert.deepEqual((await route(viaSource)).findings.filter((x) => x.code === 'MISSING_DOOR'), []);
});

test('site door: with only a URL or only a home page, the message says which is not linked', async () => {
  const bare = '# relaybox\n\n**Status:** beta\n\n## Install\n\nrun it\n';
  const urlOnly = { ...mkdocsFiles(), 'README.md': bare };
  delete urlOnly['docs/index.md'];
  const u = (await route(urlOnly)).findings.find((x) => x.code === 'MISSING_DOOR');
  assert.match(u.message, /^Site: the README does not link its URL https:\/\/example\.org\/relaybox\/;/);
  const homeOnly = { ...mkdocsFiles(), 'README.md': bare, 'mkdocs.yml': 'site_name: relaybox\n' };
  const h = (await route(homeOnly)).findings.find((x) => x.code === 'MISSING_DOOR');
  assert.match(h.message, /^Site: the README does not link its home page `docs\/index\.md`;/);
});

test('site door: scheme and host case do not matter; the path matches on a segment boundary', async () => {
  const base = { ...mkdocsFiles(), 'mkdocs.yml': 'site_name: p\nsite_url: http://example.github.io/proj/\n' };
  delete base['docs/index.md'];
  const bare = '# p\n\n**Status:** beta\n\n## Install\n\nrun it\n';
  const doorOf = async (link) => (await route({ ...base, 'README.md': `${bare}\n[Docs](${link})\n` })).findings.filter((x) => x.code === 'MISSING_DOOR');
  assert.deepEqual(await doorOf('https://Example.github.io/proj/'), []);
  assert.deepEqual(await doorOf('https://example.github.io/proj/guide/'), []);
  assert.equal((await doorOf('https://example.github.io/project2')).length, 1);
  assert.equal((await doorOf('https://other.example.org/proj/')).length, 1);
});

test('site door: a link to docs/ lands on index.md, not the unpublished docs/README.md', async () => {
  const files = { ...mkdocsFiles(), 'mkdocs.yml': 'site_name: relaybox\n', 'README.md': '# relaybox\n\n**Status:** beta\n\n## Install\n\nrun it\n\nSee the [docs](docs/).\n', 'docs/README.md': '# Readme\n' };
  const r = await route(files);
  assert.equal(r.findings.some((x) => x.code === 'MISSING_DOOR'), false);
});

test('site door: unknown home page and URL is skipped, not passed', async () => {
  const files = { ...mkdocsFiles(), 'mkdocs.yml': 'site_name: relaybox\n' };
  delete files['docs/index.md'];
  const r = await route(files);
  assert.deepEqual(r.skipped.map((s) => s.code), ['MISSING_DOOR']);
  assert.match(r.skipped[0].reason, /no home page and no known URL/);
});

test('site mode: a README that links the site passes FRONT_DOOR_BLOCKED; the home page is still checked', async () => {
  const files = { ...mkdocsFiles(), 'README.md': '# relaybox\n\n**Status:** beta\n\nSee <https://example.org/relaybox/>.\n', 'docs/index.md': '# Home\n\nNo start here.\n' };
  const r = await route(files);
  assert.deepEqual(filesOf(r, 'FRONT_DOOR_BLOCKED'), ['docs/index.md']);
});

test('site mode: a persona entry point the sidebar lists counts as a door', async () => {
  const files = {
    ...mkdocsFiles(),
    'mkdocs.yml': 'site_name: relaybox\nsite_url: https://example.org/relaybox/\nnav:\n  - index.md\n  - Dev: dev/arch.md\n',
    'docs/dev/arch.md': '# Arch\n',
  };
  const doors = (await route(files)).findings.filter((x) => x.code === 'MISSING_DOOR');
  assert.ok(!doors.some((f) => /^Dev:/.test(f.message)), JSON.stringify(doors));
});

test('Antora: a page in no nav file and unlinked is ORPHAN_PAGE; cross-component xrefs are unresolved, not findings', async () => {
  const r = await route(antoraFiles());
  assert.equal(r.mode, 'site:antora');
  assert.deepEqual(filesOf(r, 'ORPHAN_PAGE'), ['docs/modules/usage/pages/lost.adoc']);
  assert.match(r.findings.find((f) => f.code === 'ORPHAN_PAGE').message, /nav\.adoc/);
  assert.deepEqual(r.findings.filter((f) => f.code === 'MISSING_DOOR'), [], 'README links the playbook site.url');
  assert.ok(r.unresolved.some((u) => u.target === 'other::intro.adoc'));
});

test('site mode: an unpublished docs page no link path reaches is ORPHAN_PAGE; a README link reaches it', async () => {
  const antora = { ...antoraFiles(), 'docs/dev/architecture.adoc': '= Architecture\n' };
  const lost = await route(antora);
  assert.deepEqual(filesOf(lost, 'ORPHAN_PAGE'), ['docs/dev/architecture.adoc', 'docs/modules/usage/pages/lost.adoc']);
  const orphan = lost.findings.find((f) => f.file === 'docs/dev/architecture.adoc');
  assert.doesNotMatch(orphan.message, /nav\.adoc/, 'the published-page remedy does not apply to it');
  assert.deepEqual(filesOf(lost, 'SITE_CANDIDATE'), []);
  const linked = await route({ ...antora, 'README.adoc': antora['README.adoc'] + '\nxref:docs/dev/architecture.adoc[Architecture]\n' });
  assert.deepEqual(filesOf(linked, 'ORPHAN_PAGE'), ['docs/modules/usage/pages/lost.adoc']);
});

test('Antora: only the component\'s own modules/ is the site\'s; a modules/ directory elsewhere is a repo-mode page', async () => {
  const stray = { ...antoraFiles(), 'docs/dev/modules/overview.md': '# Overview\n' };
  assert.deepEqual(filesOf(await route(stray), 'ORPHAN_PAGE'), ['docs/dev/modules/overview.md', 'docs/modules/usage/pages/lost.adoc']);
  const root = {
    ...antoraFiles(),
    'antora.yml': 'name: relaybox\nversion: ~\nnav:\n- modules/ROOT/nav.adoc\n',
    'modules/ROOT/nav.adoc': '* xref:index.adoc[Home]\n',
    'modules/ROOT/pages/index.adoc': '= Home\n',
    'modules/ROOT/partials/note.adoc': 'a partial\n',
    'docs/dev/modules/overview.md': '# Overview\n',
  };
  delete root['docs/antora.yml'];
  const orphans = filesOf(await route(root), 'ORPHAN_PAGE');
  assert.ok(orphans.includes('docs/dev/modules/overview.md'), JSON.stringify(orphans));
  assert.ok(!orphans.some((f) => f.startsWith('modules/')), JSON.stringify(orphans));
});

test('site mode: pages outside the MkDocs docs_dir get repo-mode orphan checks; published pages keep the nav remedy', async () => {
  const files = {
    ...mkdocsFiles(),
    'mkdocs.yml': mkdocsFiles()['mkdocs.yml'].replace('nav:', 'docs_dir: site\nnav:'),
    'site/index.md': '# Home\n', 'site/guide/a.md': '# A\n', 'site/guide/lost.md': '# Lost\n',
    'docs/dev/arch.md': '# Arch\n',
  };
  for (const p of ['docs/index.md', 'docs/guide/a.md', 'docs/guide/b.md', 'docs/guide/lost.md']) delete files[p];
  const r = await route(files);
  assert.deepEqual(filesOf(r, 'ORPHAN_PAGE'), ['docs/dev/arch.md', 'site/guide/lost.md']);
  assert.match(r.findings.find((f) => f.file === 'site/guide/lost.md').message, /`nav:` line/);
  const linked = await route({ ...files, 'README.md': files['README.md'] + '\n[Arch](docs/dev/arch.md)\n' });
  assert.deepEqual(filesOf(linked, 'ORPHAN_PAGE'), ['site/guide/lost.md']);
});

test('site door: an image of the site URL is not a link to the site', async () => {
  const readme = (ref) => `# relaybox\n\n**Status:** beta\n\n## Install\n\nrun it\n\n${ref}\n`;
  const img = await route({ ...mkdocsFiles(), 'mkdocs.yml': 'site_name: relaybox\nsite_url: https://proj.io/\n', 'README.md': readme('![logo](https://proj.io/img/logo.png)') });
  assert.equal(only(img.findings, 'MISSING_DOOR').length, 1);
  const link = await route({ ...mkdocsFiles(), 'mkdocs.yml': 'site_name: relaybox\nsite_url: https://proj.io/\n', 'README.md': readme('[docs](https://proj.io/)') });
  assert.equal(only(link.findings, 'MISSING_DOOR').length, 0);
});

test('MkDocs INHERIT: page reachability is skipped with the reason', async () => {
  const r = await route({ ...mkdocsFiles(), 'mkdocs.yml': 'INHERIT: base.yml\n' });
  assert.ok(r.skipped.some((s) => s.code === 'ORPHAN_PAGE' && /inherits from base\.yml/.test(s.reason)));
  assert.deepEqual(filesOf(r, 'ORPHAN_PAGE'), []);
});

const NO_START = '# relaybox\n\n**Status:** beta\n\n## Usage\n\ntext\n';

test('CLI: a malformed mkdocs.yml or antora.yml degrades: README findings on stdout, config error on stderr, exit 2', () => {
  const broken = [
    [{ ...mkdocsFiles(), 'mkdocs.yml': 'nav: [\n', 'README.md': NO_START }, /mkdocs\.yml/, 'site:mkdocs'],
    [{ ...antoraFiles(), 'docs/antora.yml': '{\n', 'README.adoc': '= relaybox\n\n*Status:* beta\n\n== Usage\n\ntext\n' }, /docs\/antora\.yml/, 'site:antora'],
  ];
  for (const [files, name, mode] of broken) {
    const run = spawnSync('node', [ROUTING], { cwd: tempRepo(files), encoding: 'utf8', env: GENV });
    assert.equal(run.status, 2);
    assert.match(run.stderr, name);
    assert.doesNotMatch(run.stderr, /internal error/);
    const out = JSON.parse(run.stdout);
    assert.equal(out.mode, mode);
    assert.ok(codes(out.findings).includes('FRONT_DOOR_BLOCKED'), 'README-only checks still run');
    assert.deepEqual(codes(out.findings).filter((c) => c === 'ORPHAN_PAGE' || c === 'NO_WAY_BACK'), []);
    assert.ok(out.skipped.some((s) => s.code === 'ORPHAN_PAGE' && name.test(s.reason)), 'the config error is the skip reason');
  }
});

test('CLI: a malformed antora-playbook.yml only loses the site URL: site checks still run, exit 2', () => {
  const files = { ...antoraFiles(), 'antora-playbook.yml': 'site: [\n' };
  const run = spawnSync('node', [ROUTING], { cwd: tempRepo(files), encoding: 'utf8', env: GENV });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /antora-playbook\.yml/);
  assert.doesNotMatch(run.stderr, /internal error/);
  const out = JSON.parse(run.stdout);
  assert.deepEqual(out.findings.filter((f) => f.code === 'ORPHAN_PAGE').map((f) => f.file), ['docs/modules/usage/pages/lost.adoc']);
  assert.deepEqual(out.findings.filter((f) => f.code === 'MISSING_DOOR'), [], 'no door verdict without the site URL');
  assert.ok(out.skipped.some((s) => s.code === 'MISSING_DOOR' && /antora-playbook\.yml/.test(s.reason)));
});

test('a malformed antora-playbook.yml still checks that the README links the home page; only the URL half is unknown', async () => {
  const home = 'docs/modules/ROOT/pages/index.adoc';
  const door = async (readme) => (await route({ ...antoraFiles(), 'antora-playbook.yml': 'site: [\n', 'README.adoc': readme })).findings.filter((f) => f.code === 'MISSING_DOOR');
  const body = '= relaybox\n\n*Status:* beta\n\n== Install\n\nrun it\n\n';
  assert.deepEqual(await door(`${body}link:${home}[Documentation]\n`), [], 'README links the home page');
  const missing = await door(`${body}No docs link.\n`);
  assert.equal(missing.length, 1, 'README links neither the home page nor any URL');
  assert.match(missing[0].message, /does not link its home page `docs\/modules\/ROOT\/pages\/index\.adoc`.*site URL is unknown/);
});
