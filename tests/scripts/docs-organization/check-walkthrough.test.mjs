// Persona walkthroughs: the script half of /docs-audit's Lane 6 walkthrough
// step. Plans each persona's start, verifies a cold walker's reply against the
// navigation graph, and classifies what the walk could not finish.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planWalks, verifyWalk, classifyLost } from '../../../module/skills/docs-organization/scripts/check-walkthrough.mjs';
import { GENV, commitAll, removeTemp, tempDir, tempRepo, writeFiles, mkdocsFiles, antoraFiles, walkFiles } from './routing-fixtures.mjs';

after(removeTemp);

const SCRIPT = fileURLToPath(new URL('../../../module/skills/docs-organization/scripts/check-walkthrough.mjs', import.meta.url));
const starts = (plan) => Object.fromEntries(plan.personas.map((p) => [p.id, p.starts]));
const reply = (persona, hops, tasks) => ({ persona, hops, tasks });
const stuck = (count, last) => Array.from({ length: count }, (_, i) => ({ n: i + 1, concrete: `t${i + 1}`, status: 'stuck', last }));

test('plan: each walkthrough persona starts at its entry point; the new user at the front door', async () => {
  const { plan } = await planWalks(tempRepo(walkFiles()));
  assert.equal(plan.skipped, null);
  assert.deepEqual(starts(plan), {
    'new-user': ['README.md'], operator: ['docs/usage/README.md'], dev: ['docs/dev/README.md'], security: ['.github/SECURITY.md'],
  });
  assert.equal(plan.personas.find((p) => p.id === 'dev').tasks.length, 3);
  assert.deepEqual(plan.globalNav, []);
  assert.deepEqual(plan.skippedPersonas, []);
});

test('plan: a persona with no entry point starts at the front door; with no front door it is skipped', async () => {
  const { plan } = await planWalks(tempRepo({ 'README.md': '# P\n', 'CHANGELOG.md': '# Changes\n' }));
  assert.deepEqual(starts(plan), { 'new-user': ['README.md'], operator: ['CHANGELOG.md'], dev: ['README.md'], security: ['README.md'] });
  const bare = await planWalks(tempRepo({ 'src/main.c': 'int main;\n' }));
  assert.deepEqual(bare.plan.personas, []);
  assert.deepEqual(bare.plan.skippedPersonas.map((p) => p.id), ['new-user', 'operator', 'dev', 'security']);
  assert.match(bare.plan.skippedPersonas[0].reason, /no entry point and no front door/);
});

test('plan: an unsupported site or an unreadable MkDocs sidebar skips walkthroughs with the reason', async () => {
  const hugo = await planWalks(tempRepo({ 'README.md': '# P\n', 'hugo.toml': 'title = "p"\n' }));
  assert.match(hugo.plan.skipped, /hops cannot be verified.*site-unsupported:hugo/);
  assert.deepEqual(hugo.plan.personas, []);
  const inherit = await planWalks(tempRepo({ ...mkdocsFiles(), 'mkdocs.yml': 'INHERIT: base.yml\nsite_name: p\n', 'base.yml': 'site_name: b\n' }));
  assert.match(inherit.plan.skipped, /inherits from base\.yml/);
});

test('plan: a MkDocs site lists its sidebar and starts the new user at the home page and the README', async () => {
  const { plan } = await planWalks(tempRepo(mkdocsFiles()));
  assert.equal(plan.skipped, null);
  assert.deepEqual(plan.globalNav, ['docs/guide/a.md', 'docs/index.md']);
  assert.deepEqual(starts(plan)['new-user'], ['docs/index.md', 'README.md']);
});

test('plan: a malformed antora-playbook.yml, which walkthroughs never read, keeps the site plan and exits 0', async () => {
  const files = { ...antoraFiles(), 'antora-playbook.yml': 'site: [\n' };
  const { plan } = await planWalks(tempRepo(files));
  assert.equal(plan.skipped, null);
  assert.equal(plan.mode, 'site:antora');
  const run = spawnSync('node', [SCRIPT, '--plan'], { cwd: tempRepo(files), env: GENV, encoding: 'utf8' });
  assert.equal(run.status, 0);
  assert.equal(JSON.parse(run.stdout).skipped, null);
});

test('plan: in site mode every front door starts the new user, so a walk may begin at the README', async () => {
  const files = { ...mkdocsFiles(), 'README.md': '# relaybox\n\nMirrors reviews.\n\nSee [x](docs/x.md).\n', 'docs/x.md': '# X\n' };
  const ctx = await planWalks(tempRepo(files));
  assert.deepEqual(starts(ctx.plan)['new-user'], ['docs/index.md', 'README.md']);
  const n = ctx.plan.personas.find((p) => p.id === 'new-user').tasks.length;
  const r = verifyWalk(ctx, reply('new-user', [{ from: 'README.md', line: 5, to: 'docs/x.md' }], stuck(n, 'docs/x.md')));
  assert.deepEqual(r.rejected, []);
});

test('verify: a hop may open a non-doc file, but a done task must cite a doc', async () => {
  const ctx = await planWalks(tempRepo({ 'README.md': '# P\n\nSee [license](LICENSE) and [x](docs/x.md).\n', 'LICENSE': 'MIT\n', 'docs/x.md': '# X\n' }));
  const n = ctx.plan.personas.find((p) => p.id === 'new-user').tasks.length;
  const done = (file) => Array.from({ length: n }, (_, i) => ({ n: i + 1, concrete: `t${i + 1}`, status: 'done', file, line: 1 }));
  const hops = [{ from: 'README.md', line: 3, to: 'LICENSE' }, { from: 'README.md', line: 3, to: 'docs/x.md' }];
  const bad = verifyWalk(ctx, reply('new-user', hops, done('LICENSE')));
  assert.match(bad.rejected[0].reason, /task 1: answer file LICENSE is not a doc file/);
  assert.ok(bad.opened.includes('LICENSE'), 'the hop itself is allowed');
  assert.deepEqual(verifyWalk(ctx, reply('new-user', hops, done('docs/x.md'))).rejected, []);
});

test('verify: a walk that follows links is valid, and lists every file it opened', async () => {
  const ctx = await planWalks(tempRepo(walkFiles()));
  const r = verifyWalk(ctx, reply('dev', [
    { from: 'docs/dev/README.md', line: 3, to: 'docs/dev/architecture.md' },
    { from: 'docs/dev/README.md', line: 4, to: 'docs/dev/guides/' },
  ], [
    { n: 1, concrete: 'build offline', status: 'stuck', last: 'docs/dev/README.md' },
    { n: 2, concrete: 'run the unit tests', status: 'stuck', last: 'docs/dev/guides/one.md' },
    { n: 3, concrete: 'architecture', status: 'done', file: './docs/dev/architecture.md', line: 1 },
  ]));
  assert.deepEqual(r.rejected, []);
  assert.equal(r.valid, true);
  assert.deepEqual(r.opened, ['docs/dev/README.md', 'docs/dev/architecture.md', 'docs/dev/guides/one.md']);
  const direct = verifyWalk(ctx, reply('dev', [{ from: 'docs/dev/README.md', line: 4, to: 'docs/dev/guides/one.md' }], stuck(3, 'docs/dev/guides/one.md')));
  assert.deepEqual(direct.rejected, []);
});

test('verify rejects a fabricated hop, a hop from an unopened file, and an answer the walk never opened', async () => {
  const ctx = await planWalks(tempRepo(walkFiles()));
  const tasks = stuck(3, 'docs/dev/README.md');
  const fabricated = verifyWalk(ctx, reply('dev', [{ from: 'docs/dev/README.md', line: 3, to: 'docs/dev/testing.md' }], tasks));
  assert.equal(fabricated.valid, false);
  assert.match(fabricated.rejected[0].reason, /docs\/dev\/README\.md has no link to docs\/dev\/testing\.md/);
  const jump = verifyWalk(ctx, reply('dev', [{ from: 'docs/usage/README.md', line: 3, to: 'docs/usage/config.md' }], tasks));
  assert.match(jump.rejected[0].reason, /was not opened before this hop/);
  const answer = verifyWalk(ctx, reply('dev', [], [{ n: 1, concrete: 'x', status: 'done', file: 'docs/dev/testing.md', line: 3 }, tasks[1], tasks[2]]));
  assert.match(answer.rejected[0].reason, /which the walk did not open/);
});

test('verify: a hop\'s line must be a line of the link that justifies it', async () => {
  const ctx = await planWalks(tempRepo(walkFiles()));
  const hop = (line, to = 'docs/dev/architecture.md') => reply('dev', [{ from: 'docs/dev/README.md', line, to }], stuck(3, 'docs/dev/README.md'));
  assert.deepEqual(verifyWalk(ctx, hop(3)).rejected, []);
  assert.deepEqual(verifyWalk(ctx, hop(9999)).rejected.map((x) => x.reason), ['docs/dev/README.md:9999 → docs/dev/architecture.md: no link to it on line 9999 (links on line 3)']);
  assert.match(verifyWalk(ctx, hop(4)).rejected[0].reason, /no link to it on line 4/);
  assert.deepEqual(verifyWalk(ctx, hop(4, 'docs/dev/guides/one.md')).rejected, []);
});

test('verify: a hop may name a directory the link names, on the link\'s line', async () => {
  const ctx = await planWalks(tempRepo(walkFiles()));
  const tasks = stuck(ctx.plan.personas.find((p) => p.id === 'new-user').tasks.length, 'README.md');
  const hop = (line, to) => reply('new-user', [{ from: 'README.md', line, to }, { from: 'docs/dev/README.md', line: 3, to: 'docs/dev/architecture.md' }], tasks);
  for (const to of ['docs/dev', 'docs/dev/']) {
    const r = verifyWalk(ctx, hop(12, to));
    assert.deepEqual(r.rejected, [], to);
    assert.ok(r.opened.includes('docs/dev/README.md'), 'the directory opens its landing pages');
  }
  assert.match(verifyWalk(ctx, hop(11, 'docs/dev')).rejected[0].reason, /no link to it on line 11 \(links on line 12\)/);
  assert.match(verifyWalk(ctx, hop(12, 'docs/security')).rejected[0].reason, /README\.md has no link to docs\/security/);
  assert.match(verifyWalk(ctx, hop(12, 'docs')).rejected[0].reason, /README\.md has no link to docs/);
});

test('verify: a directory hop opens only the pages the line\'s links land on, not unlinked siblings', async () => {
  const files = { ...walkFiles(), 'docs/usage/secret-howto.md': '# Secret\n\nUnlinked.\n' };
  const ctx = await planWalks(tempRepo(files));
  const n = ctx.plan.personas.find((p) => p.id === 'new-user').tasks.length;
  const line = files['README.md'].split('\n').findIndex((l) => l.includes('docs/usage/README.md')) + 1;
  const walk = (file) => reply('new-user', [{ from: 'README.md', line, to: 'docs/usage' }],
    [{ n: 1, concrete: 'x', status: 'done', file, line: 1 }, ...stuck(n, 'README.md').slice(1)]);
  assert.deepEqual(verifyWalk(ctx, walk('docs/usage/README.md')).rejected, []);
  const r = verifyWalk(ctx, walk('docs/usage/secret-howto.md'));
  assert.match(r.rejected[0].reason, /secret-howto\.md, which the walk did not open/);
  assert.ok(!r.opened.includes('docs/usage/secret-howto.md'));
});

test('a tracked doc deleted from the work tree is not opened or reachable', async () => {
  const repo = tempRepo(walkFiles());
  rmSync(join(repo, '.github/SECURITY.md'));
  const ctx = await planWalks(repo);
  const n = ctx.plan.personas.find((p) => p.id === 'new-user').tasks.length;
  const line = walkFiles()['README.md'].split('\n').findIndex((l) => l.includes('.github/SECURITY.md')) + 1;
  const r = verifyWalk(ctx, reply('new-user', [{ from: 'README.md', line, to: '.github/SECURITY.md' }],
    [{ n: 1, concrete: 'x', status: 'done', file: '.github/SECURITY.md', line: 1 }, ...stuck(n, 'README.md').slice(1)]));
  assert.ok(!r.opened.includes('.github/SECURITY.md'));
  assert.match(r.rejected[0].reason, /which the walk did not open/);
  const c = classifyLost(ctx, { persona: 'new-user', stuck: [1], located: [{ n: 1, concrete: 'x', last: '.github/SECURITY.md', file: null }] });
  assert.match(c.rejected[0].reason, /not a doc file the reader could reach/);
});

test('verify rejects malformed replies', async () => {
  const ctx = await planWalks(tempRepo(walkFiles()));
  const reasons = (r) => r.rejected.map((x) => x.reason).join('\n');
  assert.match(reasons(verifyWalk(ctx, null)), /not a JSON object/);
  assert.match(reasons(verifyWalk(ctx, reply('lawyer', [], []))), /not a walkthrough persona/);
  const one = { n: 1, concrete: 'say what it is', status: 'done', file: 'README.md', line: 3 };
  assert.match(reasons(verifyWalk(ctx, reply('new-user', [], [one]))), /task 2 has no entry/);
  assert.match(reasons(verifyWalk(ctx, reply('new-user', [], [one, one]))), /task 1 answered twice/);
  assert.match(reasons(verifyWalk(ctx, reply('new-user', [], [one, { ...one, n: 2, status: 'maybe' }]))), /status must be done or stuck/);
  assert.match(reasons(verifyWalk(ctx, reply('new-user', [], [one, { ...one, n: 2, concrete: '' }]))), /no concrete task/);
  assert.match(reasons(verifyWalk(ctx, reply('new-user', [{ from: 'README.md', to: 'docs/usage/README.md' }], [one, { ...one, n: 2 }]))), /no line number/);
  assert.match(reasons(verifyWalk(ctx, { persona: 'new-user', tasks: [one, { ...one, n: 2 }] })), /hops: not a list/);
});

test('verify: a start outside the page set (.github/SECURITY.md) still has its links', async () => {
  const ctx = await planWalks(tempRepo(walkFiles()));
  const r = verifyWalk(ctx, reply('security', [{ from: '.github/SECURITY.md', line: 3, to: 'docs/security/data.md' }], stuck(3, 'docs/security/data.md')));
  assert.deepEqual(r.rejected, []);
});

test('plan: a dot-directory doc is read only when a start or a reachable file links it', async () => {
  const template = '.github/PULL_REQUEST_TEMPLATE.md';
  const files = { ...walkFiles(), [template]: '# PR\n\nSee [config](../docs/usage/config.md).\n', 'docs/orphan.md': '# Orphan\n\nSee [PR template](../.github/PULL_REQUEST_TEMPLATE.md).\n' };
  const orphaned = await planWalks(tempRepo(files));
  assert.deepEqual(orphaned.edges.filter((e) => e.from === template), []);
  const linked = await planWalks(tempRepo({ ...files, 'docs/usage/README.md': '# Usage\n\n- [Configuration](config.md)\n- [PR template](../../.github/PULL_REQUEST_TEMPLATE.md)\n' }));
  assert.deepEqual(linked.edges.filter((e) => e.from === template).map((e) => e.to), ['docs/usage/config.md']);
});

test('verify: on a MkDocs site a dot-directory doc linked only from a sidebar page keeps its edges', async () => {
  const ctx = await planWalks(tempRepo({
    ...mkdocsFiles(),
    'docs/guide/a.md': '# A\n\n[howto](../../.github/HOWTO.md)\n',
    '.github/HOWTO.md': '# How to\n\n[dev](../docs/dev/x.md)\n',
    'docs/dev/x.md': '# X\n',
  }));
  const r = verifyWalk(ctx, reply('new-user', [
    { from: 'nav', to: 'docs/guide/a.md' },
    { from: 'docs/guide/a.md', line: 3, to: '.github/HOWTO.md' },
    { from: '.github/HOWTO.md', line: 3, to: 'docs/dev/x.md' },
  ], stuck(2, 'docs/dev/x.md')));
  assert.deepEqual(r.rejected, []);
});

test('verify: on a MkDocs site a sidebar hop must name a nav entry; a repo has no sidebar', async () => {
  const site = await planWalks(tempRepo(mkdocsFiles()));
  assert.equal(verifyWalk(site, reply('new-user', [{ from: 'nav', to: 'docs/guide/a.md' }], stuck(2, 'docs/guide/a.md'))).valid, true);
  assert.match(verifyWalk(site, reply('new-user', [{ from: 'nav', to: 'docs/guide/lost.md' }], stuck(2, 'docs/index.md'))).rejected[0].reason, /not a sidebar entry/);
  const repo = await planWalks(tempRepo(walkFiles()));
  assert.match(verifyWalk(repo, reply('new-user', [{ from: 'nav', to: 'docs/usage/README.md' }], stuck(2, 'README.md'))).rejected[0].reason, /no sidebar/);
});

test('classify: an answer no link reaches is unreachable; no answer is absent; a reachable one is missed', async () => {
  const ctx = await planWalks(tempRepo(walkFiles()));
  const r = classifyLost(ctx, { persona: 'dev', stuck: [1, 2, 3], located: [
    { n: 2, concrete: 'run the unit tests', last: 'docs/dev/README.md', file: 'docs/dev/testing.md', line: 3 },
    { n: 1, concrete: 'build offline', last: 'docs/dev/README.md', file: null },
    { n: 3, concrete: 'architecture', last: 'docs/dev/README.md', file: 'docs/dev/architecture.md', line: 1 },
  ] });
  assert.deepEqual(r.rejected, []);
  assert.deepEqual(r.findings.map((f) => [f.code, f.severity, f.kind, f.file, f.line, f.persona, f.n]), [
    ['WALKTHROUGH_LOST', 'warning', 'unreachable', 'docs/dev/README.md', null, 'dev', 2],
    ['WALKTHROUGH_LOST', 'warning', 'absent', 'docs/dev/README.md', null, 'dev', 1],
  ]);
  assert.equal(r.findings[0].message, 'Dev: "run the unit tests" (find how to run the tests) — last reached `docs/dev/README.md`; unreachable: the answer is at `docs/dev/testing.md:3`, and no link path from `docs/dev/README.md` reaches it; link it from `docs/dev/README.md`');
  assert.equal(r.findings[1].message, 'Dev: "build offline" (find how to build from source offline) — last reached `docs/dev/README.md`; absent: no doc page answers it');
  assert.deepEqual(r.missed, [{ persona: 'dev', label: 'Dev', n: 3, concrete: 'architecture', file: 'docs/dev/architecture.md', line: 1 }]);
});

test('classify: reach counts a dot-directory start and a site sidebar; non-doc and untracked locations', async () => {
  const repo = await planWalks(tempRepo({ ...walkFiles(), 'src/store.c': 'int tokens;\n' }));
  const sec = classifyLost(repo, { persona: 'security', stuck: [1, 2, 3], located: [
    { n: 2, concrete: 'data stored', last: '.github/SECURITY.md', file: 'docs/security/data.md', line: 1 },
    { n: 3, concrete: 'trust', last: '.github/SECURITY.md', file: 'src/store.c', line: 1 },
    { n: 1, concrete: 'report', last: '.github/SECURITY.md', file: 'docs/nowhere.md', line: 1 },
  ] });
  assert.deepEqual(sec.missed.map((m) => m.n), [2]);
  assert.deepEqual(sec.findings.map((f) => f.kind), ['absent']);
  assert.match(sec.findings[0].message, /found only in `src\/store\.c`, which is not a doc file/);
  assert.match(sec.rejected[0].reason, /docs\/nowhere\.md is not a tracked file/);
  const site = await planWalks(tempRepo(mkdocsFiles()));
  const op = classifyLost(site, { persona: 'operator', stuck: [1, 2], located: [
    { n: 2, concrete: 'upgrade', last: 'docs/index.md', file: 'docs/guide/lost.md', line: 1 },
    { n: 1, concrete: 'setting', last: 'docs/index.md', file: 'docs/guide/b.md', line: 1 },
  ] });
  assert.deepEqual(op.findings.map((f) => f.kind), ['unreachable']);
  assert.match(op.findings[0].message, /no link or sidebar path/);
  assert.deepEqual(op.missed.map((m) => m.file), ['docs/guide/b.md']);
});

test('classify: an absent answer is filed against the persona\'s entry door, not where the walker wandered', async () => {
  const ctx = await planWalks(tempRepo(walkFiles()));
  const user = classifyLost(ctx, { persona: 'new-user', stuck: [1], located: [{ n: 1, concrete: 'first command', last: 'docs/usage/README.md', file: null }] });
  assert.deepEqual(user.rejected, []);
  assert.equal(user.findings[0].file, 'README.md');
  assert.match(user.findings[0].message, /last reached `docs\/usage\/README\.md`; absent/);
  const sec = classifyLost(ctx, { persona: 'security', stuck: [1], located: [{ n: 1, concrete: 'report', last: 'docs/security/data.md', file: null }] });
  assert.deepEqual(sec.rejected, []);
  assert.equal(sec.findings[0].file, '.github/SECURITY.md');
  const lost = classifyLost(ctx, { persona: 'security', stuck: [1], located: [{ n: 1, concrete: 'data', last: 'docs/security/data.md', file: 'docs/dev/testing.md', line: 3 }] });
  assert.equal(lost.findings[0].file, 'docs/security/data.md');
});

test('classify: an answer in a tracked file deleted from the work tree is absent, not unreachable', async () => {
  const repo = tempRepo(walkFiles());
  rmSync(join(repo, 'docs/dev/testing.md'));
  const ctx = await planWalks(repo);
  const r = classifyLost(ctx, { persona: 'dev', stuck: [2], located: [{ n: 2, concrete: 'tests', last: 'docs/dev/README.md', file: 'docs/dev/testing.md', line: 3 }] });
  assert.deepEqual(r.findings.map((f) => f.kind), ['absent']);
  assert.deepEqual(r.rejected, []);
});

test('classify rejects malformed input', async () => {
  const ctx = await planWalks(tempRepo(walkFiles()));
  assert.match(classifyLost(ctx, {}).rejected[0].reason, /expected \{persona, stuck: \[\.\.\.\], located/);
  assert.match(classifyLost(ctx, { persona: 'llm', stuck: [], located: [] }).rejected[0].reason, /not a walkthrough persona/);
  const bad = classifyLost(ctx, { persona: 'dev', stuck: [1, 2], located: [
    { n: 9, last: 'docs/dev/README.md', file: null },
    { n: 1, last: 'docs/gone.md', file: null },
    { n: 2, last: 'docs/dev/README.md', file: 'docs/dev/testing.md' },
  ] });
  assert.deepEqual(bad.rejected.map((x) => x.at), ['located[0]', 'located[1]', 'located[2]']);
  assert.deepEqual(bad.findings, []);
});

test('CLI: --plan prints the plan; --verify reads stdin and exits 0 or 1; bad arguments exit 2', () => {
  const root = tempRepo(walkFiles());
  const run = (args, input) => spawnSync('node', [SCRIPT, ...args], { cwd: root, env: GENV, encoding: 'utf8', input });
  const plan = run(['--plan']);
  assert.equal(plan.status, 0);
  assert.equal(JSON.parse(plan.stdout).personas.length, 4);
  assert.equal(run(['--verify'], JSON.stringify(reply('new-user', [], stuck(2, 'README.md')))).status, 0);
  const bad = run(['--verify'], 'not json');
  assert.equal(bad.status, 1);
  assert.match(JSON.parse(bad.stdout).rejected[0].reason, /not JSON/);
  assert.equal(run([]).status, 2);
  assert.equal(run(['--plan', 'x']).status, 2);
  const lost = run(['--classify'], JSON.stringify({ persona: 'dev', stuck: [2], located: [{ n: 2, concrete: 'tests', last: 'docs/dev/README.md', file: 'docs/dev/testing.md', line: 3 }] }));
  assert.equal(lost.status, 1);
  assert.equal(JSON.parse(lost.stdout).findings[0].kind, 'unreachable');
  const clean = run(['--classify'], JSON.stringify({ persona: 'dev', stuck: [], located: [] }));
  assert.equal(clean.status, 0);
});

test('CLI: exits 2 outside git, on a malformed site config, and for --verify when walkthroughs are skipped', () => {
  const dir = tempDir();
  assert.equal(spawnSync('node', [SCRIPT, '--plan'], { cwd: dir, env: { ...GENV, GIT_CEILING_DIRECTORIES: dir }, encoding: 'utf8' }).status, 2);
  const broken = spawnSync('node', [SCRIPT, '--plan'], { cwd: tempRepo({ ...mkdocsFiles(), 'mkdocs.yml': 'nav: [\n' }), env: GENV, encoding: 'utf8' });
  assert.equal(broken.status, 2);
  assert.match(broken.stderr, /mkdocs\.yml/);
  assert.doesNotMatch(broken.stderr, /internal error/);
  assert.match(JSON.parse(broken.stdout).skipped, /hops cannot be verified.*mkdocs\.yml/, 'the plan is still emitted, skipped with the config error');
  const hugo = spawnSync('node', [SCRIPT, '--verify'], { cwd: tempRepo({ 'README.md': '# P\n', 'hugo.toml': 'title = "p"\n' }), env: GENV, encoding: 'utf8', input: '{}' });
  assert.equal(hugo.status, 2);
  assert.match(hugo.stderr, /walkthroughs are skipped/);
});

test('plan: a start symlinked out of the repo is not a start; the persona falls back to the front door', async () => {
  const outside = tempDir();
  writeFileSync(join(outside, 'evil.md'), '# Evil\n');
  const root = tempDir();
  writeFiles(root, { 'README.md': '# P\n', 'docs/x.md': '# X\n' });
  mkdirSync(join(root, '.github'));
  symlinkSync(join(outside, 'evil.md'), join(root, '.github/SECURITY.md'));
  commitAll(root);
  const { plan } = await planWalks(root);
  assert.deepEqual(starts(plan).security, ['README.md']);
});

test('plan: in MkDocs mode a directory entry starts at the published index.md, not README.md', async () => {
  const files = { ...mkdocsFiles(), 'docs/usage/README.md': '# R\n', 'docs/usage/index.md': '# I\n' };
  const { plan } = await planWalks(tempRepo(files));
  assert.deepEqual(starts(plan).operator, ['docs/usage/index.md']);
  const { plan: repo } = await planWalks(tempRepo({ 'README.md': '# P\n', 'docs/usage/README.md': '# R\n', 'docs/usage/index.md': '# I\n' }));
  assert.deepEqual(starts(repo).operator, ['docs/usage/README.md']);
});

test('verify: a hop can pass through a linked doc outside the page set (.github/CODE_OF_CONDUCT.md)', async () => {
  const ctx = await planWalks(tempRepo({
    'README.md': '# P\n\n[conduct](.github/CODE_OF_CONDUCT.md)\n',
    '.github/CODE_OF_CONDUCT.md': '# Conduct\n\n[x](../docs/x.md)\n',
    'docs/x.md': '# X\n',
  }));
  const r = verifyWalk(ctx, reply('new-user', [
    { from: 'README.md', line: 3, to: '.github/CODE_OF_CONDUCT.md' },
    { from: '.github/CODE_OF_CONDUCT.md', line: 3, to: 'docs/x.md' },
  ], [{ n: 1, concrete: 'a', status: 'done', file: 'docs/x.md', line: 1 }, ...stuck(2, 'docs/x.md').slice(1)]));
  assert.deepEqual(r.rejected, []);
});

test('verify: a directory is not an answer or a last file', async () => {
  const ctx = await planWalks(tempRepo(walkFiles()));
  const hop = { from: 'docs/dev/README.md', line: 4, to: 'docs/dev/guides/' };
  const done = verifyWalk(ctx, reply('dev', [hop], [{ n: 1, concrete: 'x', status: 'done', file: 'docs/dev/guides', line: 1 }, ...stuck(3, 'docs/dev/README.md').slice(1)]));
  assert.match(done.rejected[0].reason, /which the walk did not open/);
  const last = verifyWalk(ctx, reply('dev', [hop], [{ n: 1, concrete: 'x', status: 'stuck', last: 'docs/dev/guides' }, ...stuck(3, 'docs/dev/README.md').slice(1)]));
  assert.match(last.rejected[0].reason, /was not opened/);
});

test('verify: pinned checks (done without a line, stuck with an unopened last, tasks not a list)', async () => {
  const ctx = await planWalks(tempRepo(walkFiles()));
  const rest = stuck(3, 'docs/dev/README.md').slice(1);
  const noLine = verifyWalk(ctx, reply('dev', [], [{ n: 1, concrete: 'x', status: 'done', file: 'docs/dev/README.md' }, ...rest]));
  assert.deepEqual(noLine.rejected.map((x) => x.reason), ['task 1: no line number']);
  const unopened = verifyWalk(ctx, reply('dev', [], [{ n: 1, concrete: 'x', status: 'stuck', last: 'docs/dev/testing.md' }, ...rest]));
  assert.match(unopened.rejected[0].reason, /last file docs\/dev\/testing\.md was not opened/);
  const notList = verifyWalk(ctx, { persona: 'dev', hops: [], tasks: 'x' });
  assert.ok(notList.rejected.some((x) => x.reason === 'tasks: not a list'));
});

test('verify: a stuck task\'s last file must be a doc file, and so is a done answer file', async () => {
  const ctx = await planWalks(tempRepo({ 'README.md': '# P\n\n[license](LICENSE)\n', LICENSE: 'MIT\n' }));
  const hop = { from: 'README.md', line: 3, to: 'LICENSE' };
  const rest = stuck(2, 'README.md').slice(1);
  const last = verifyWalk(ctx, reply('new-user', [hop], [{ n: 1, concrete: 'x', status: 'stuck', last: 'LICENSE' }, ...rest]));
  assert.deepEqual(last.rejected.map((x) => x.reason), ['task 1: last file LICENSE is not a doc file']);
  const done = verifyWalk(ctx, reply('new-user', [hop], [{ n: 1, concrete: 'x', status: 'done', file: 'LICENSE', line: 1 }, ...rest]));
  assert.deepEqual(done.rejected.map((x) => x.reason), ['task 1: answer file LICENSE is not a doc file']);
});

test('classify: a page two hops past a dot-directory start is missed, not lost', async () => {
  const files = walkFiles();
  files['docs/security/data.md'] += '\n[more](more.md)\n';
  files['docs/security/more.md'] = '# More\n';
  const ctx = await planWalks(tempRepo(files));
  const r = classifyLost(ctx, { persona: 'security', stuck: [1], located: [{ n: 1, concrete: 'c', last: '.github/SECURITY.md', file: 'docs/security/more.md', line: 1 }] });
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.missed.map((m) => m.file), ['docs/security/more.md']);
});

test('classify: a sidebar-only page and the start itself are missed', async () => {
  const site = await planWalks(tempRepo(mkdocsFiles()));
  const r = classifyLost(site, { persona: 'new-user', stuck: [1, 2], located: [
    { n: 1, concrete: 'c', last: 'docs/index.md', file: 'docs/guide/a.md', line: 1 },
    { n: 2, concrete: 'c', last: 'docs/index.md', file: 'docs/index.md', line: 1 },
  ] });
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.missed.map((m) => m.file), ['docs/guide/a.md', 'docs/index.md']);
});

test('classify: last must be a doc file the reader could reach; a repeated n is rejected', async () => {
  const ctx = await planWalks(tempRepo({ ...walkFiles(), 'src/main.c': 'int main;\n' }));
  const r = classifyLost(ctx, { persona: 'dev', stuck: [1, 2, 3], located: [
    { n: 1, concrete: 'c', last: 'src/main.c', file: null },
    { n: 2, concrete: 'c', last: 'docs/dev/testing.md', file: null },
    { n: 3, concrete: 'c', last: 'docs/dev/README.md', file: null },
    { n: 3, concrete: 'c', last: 'docs/dev/README.md', file: null },
  ] });
  assert.deepEqual(r.rejected.map((x) => x.at), ['located[0]', 'located[1]', 'located[3]']);
  assert.match(r.rejected[0].reason, /src\/main\.c/);
  assert.match(r.rejected[2].reason, /task 3 located twice/);
  assert.equal(r.findings.length, 1);
});

test('classify: concrete is untrusted; whitespace collapses, backticks go, length is capped', async () => {
  const ctx = await planWalks(tempRepo(walkFiles()));
  const r = classifyLost(ctx, { persona: 'dev', stuck: [1, 2], located: [
    { n: 1, concrete: 'a\n\n`b`   c', last: 'docs/dev/README.md', file: null },
    { n: 2, concrete: 'x'.repeat(500), last: 'docs/dev/README.md', file: null },
  ] });
  assert.match(r.findings[0].message, /^Dev: "a 'b' c" /);
  const quoted = r.findings[1].message.match(/^Dev: "([^"]*)"/)[1];
  assert.equal(quoted.length, 120);
  assert.ok(quoted.endsWith('…'));
});

test('classify: a stuck task with no located entry is rejected, not silently dropped', async () => {
  const ctx = await planWalks(tempRepo(walkFiles()));
  const r = classifyLost(ctx, { persona: 'dev', stuck: [1, 3], located: [
    { n: 1, concrete: 'build offline', last: 'docs/dev/README.md', file: null },
  ] });
  assert.deepEqual(r.rejected, [{ at: 'located', reason: 'task 3 is stuck and has no located entry' }]);
  assert.equal(r.findings.length, 1);
  const bad = classifyLost(ctx, { persona: 'dev', stuck: [0, 9, 'x'], located: [] });
  assert.deepEqual(bad.rejected.map((x) => x.at), ['stuck[0]', 'stuck[1]', 'stuck[2]']);
  assert.match(bad.rejected[0].reason, /n must be 1\.\.3/);
  assert.match(classifyLost(ctx, { persona: 'dev', located: [] }).rejected[0].reason, /expected \{persona, stuck: \[\.\.\.\], located/);
});

test('classify: a located entry for a task the walker finished is rejected', async () => {
  const ctx = await planWalks(tempRepo(walkFiles()));
  const r = classifyLost(ctx, { persona: 'dev', stuck: [1], located: [
    { n: 1, concrete: 'build offline', last: 'docs/dev/README.md', file: null },
    { n: 2, concrete: 'run tests', last: 'docs/dev/README.md', file: null },
  ] });
  assert.deepEqual(r.rejected, [{ at: 'located[1]', reason: 'task 2 is not stuck' }]);
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].n, 1);
});

test('a tracked doc symlinked out of the repo is not opened or reachable', async () => {
  const outside = tempDir();
  writeFileSync(join(outside, 'notes.md'), '# Notes\n');
  const root = tempDir();
  writeFiles(root, { 'README.md': '# P\n\n[notes](docs/x.md)\n' });
  mkdirSync(join(root, 'docs'));
  symlinkSync(join(outside, 'notes.md'), join(root, 'docs/x.md'));
  commitAll(root);
  const ctx = await planWalks(root);
  const n = ctx.plan.personas.find((p) => p.id === 'new-user').tasks.length;
  const r = verifyWalk(ctx, reply('new-user', [{ from: 'README.md', line: 3, to: 'docs/x.md' }],
    [{ n: 1, concrete: 'x', status: 'done', file: 'docs/x.md', line: 1 }, ...stuck(n, 'README.md').slice(1)]));
  assert.ok(!r.opened.includes('docs/x.md'));
  assert.match(r.rejected[0].reason, /which the walk did not open/);
  const c = classifyLost(ctx, { persona: 'new-user', stuck: [1], located: [{ n: 1, concrete: 'x', last: 'README.md', file: 'docs/x.md', line: 1 }] });
  assert.deepEqual(c.missed, []);
  assert.deepEqual(c.findings.map((f) => f.kind), ['absent']);
});

const absentFile = async (files, persona) => {
  const ctx = await planWalks(tempRepo(files));
  const r = classifyLost(ctx, { persona, stuck: [1], located: [{ n: 1, concrete: 'x', last: ctx.plan.personas.find((p) => p.id === persona).starts[0], file: null }] });
  assert.deepEqual(r.rejected, []);
  return r.findings[0].file;
};

test('classify: an absent answer is filed against the first entry that is a single file, skipping an index-less directory', async () => {
  const noIndex = { ...walkFiles(), 'CONTRIBUTING.md': '# Contributing\n' };
  delete noIndex['docs/dev/README.md'];
  assert.equal(await absentFile(noIndex, 'dev'), 'CONTRIBUTING.md');
  assert.equal(await absentFile({ ...walkFiles(), 'CONTRIBUTING.md': '# Contributing\n' }, 'dev'), 'docs/dev/README.md');
  assert.equal(await absentFile(walkFiles(), 'new-user'), 'README.md');
});

test('classify: with no entry resolving to a single file, an absent answer falls back to the persona\'s first start', async () => {
  const noIndex = walkFiles();
  delete noIndex['docs/dev/README.md'];
  assert.equal(await absentFile(noIndex, 'dev'), 'docs/dev/architecture.md');
});
