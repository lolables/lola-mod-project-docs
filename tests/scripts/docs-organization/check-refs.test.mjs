import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, realpathSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeFile } from '../../../module/skills/docs-organization/scripts/check-refs.mjs';

// Every temp dir any test in this file creates is tracked here and removed
// once, after the whole file runs (matches check-staleness.test.mjs).
const tmpDirs = [];
after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function mktemp(prefix = 'check-refs-') {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tmpDirs.push(d);
  return d;
}

const GENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'check-refs-test',
  GIT_AUTHOR_EMAIL: 'check-refs-test@invalid',
  GIT_COMMITTER_NAME: 'check-refs-test',
  GIT_COMMITTER_EMAIL: 'check-refs-test@invalid',
};
const git = (root, ...args) => execFileSync('git', args, { cwd: root, env: GENV, encoding: 'utf8' });
const codes = (f) => f.map((x) => x.code);

function makeRepo(files, tracked, links = {}) {
  const root = mktemp();
  git(root, 'init', '-q');
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(root, p, '..'), { recursive: true });
    writeFileSync(join(root, p), body);
  }
  for (const [p, target] of Object.entries(links)) {
    mkdirSync(join(root, p, '..'), { recursive: true });
    symlinkSync(target, join(root, p));
  }
  for (const p of tracked) git(root, 'add', p);
  git(root, 'commit', '-q', '-m', 'init');
  const trackedSet = new Set(git(root, 'ls-files', '-z').split('\0').filter(Boolean));
  return { root, trackedSet };
}

test('a tracked link, an external URL, and an anchor are all clean', async () => {
  const doc = 'See [arch](docs/arch.md), the [site](https://example.com), and [top](#intro).';
  const { root, trackedSet } = makeRepo(
    { 'README.md': doc, 'docs/arch.md': '# arch\n' },
    ['README.md', 'docs/arch.md'],
  );
  assert.deepEqual(await analyzeFile(join(root, 'README.md'), root, trackedSet), []);
});

test('a link to a gitignored file flags REF_NOT_IN_GIT', async () => {
  const { root, trackedSet } = makeRepo(
    {
      '.gitignore': 'docs/private/\n',
      'README.md': 'See the [spec](docs/private/spec.md).',
      'docs/private/spec.md': '# secret\n',
    },
    ['.gitignore', 'README.md'],
  );
  assert.deepEqual(codes(await analyzeFile(join(root, 'README.md'), root, trackedSet)), ['REF_NOT_IN_GIT']);
});

test('a link to a nonexistent file flags REF_BROKEN', async () => {
  const { root, trackedSet } = makeRepo({ 'README.md': 'See [gone](docs/gone.md).' }, ['README.md']);
  assert.deepEqual(codes(await analyzeFile(join(root, 'README.md'), root, trackedSet)), ['REF_BROKEN']);
});

test('a leading horizontal rule is not front matter, so a broken link after it is still flagged REF_BROKEN', async () => {
  const { root, trackedSet } = makeRepo({ 'README.md': '---\n\n[broken](nope.md)\n\n---\n\nBody.\n' }, ['README.md']);
  assert.deepEqual(codes(await analyzeFile(join(root, 'README.md'), root, trackedSet)), ['REF_BROKEN']);
});

test('an inline-code source path is NOT flagged (mentions are not links)', async () => {
  // The repo has no such file, but `internal/x.go` is a mention, not a link.
  const { root, trackedSet } = makeRepo({ 'README.md': 'The entry point is `internal/x.go`.' }, ['README.md']);
  assert.deepEqual(await analyzeFile(join(root, 'README.md'), root, trackedSet), []);
});

test('a link to a tracked directory is followable (not flagged)', async () => {
  const { root, trackedSet } = makeRepo(
    { 'README.md': 'See the [agents](module/agents/).', 'module/agents/a.md': '# a\n' },
    ['README.md', 'module/agents/a.md'],
  );
  assert.deepEqual(await analyzeFile(join(root, 'README.md'), root, trackedSet), []);
});

test('a link to a gitignored directory flags REF_NOT_IN_GIT', async () => {
  const { root, trackedSet } = makeRepo(
    {
      '.gitignore': 'build/\n',
      'README.md': 'See the [output](build/).',
      'build/out.md': '# out\n',
    },
    ['.gitignore', 'README.md'],
  );
  assert.deepEqual(codes(await analyzeFile(join(root, 'README.md'), root, trackedSet)), ['REF_NOT_IN_GIT']);
});

test('a bare § citation with no link flags UNLINKED_REF', async () => {
  const { root, trackedSet } = makeRepo({ 'README.md': 'This follows spec §10.9 E-3.' }, ['README.md']);
  assert.deepEqual(codes(await analyzeFile(join(root, 'README.md'), root, trackedSet)), ['UNLINKED_REF']);
});

test('a § inside a resolvable link is not flagged', async () => {
  const { root, trackedSet } = makeRepo(
    { 'README.md': 'See [§10.9](docs/arch.md).', 'docs/arch.md': '# arch\n' },
    ['README.md', 'docs/arch.md'],
  );
  assert.deepEqual(await analyzeFile(join(root, 'README.md'), root, trackedSet), []);
});

test('a § citation whose inline block also links a document is not flagged', async () => {
  const { root, trackedSet } = makeRepo(
    { 'README.md': 'Per §3.2 of the [spec](spec.md), retries back off.', 'spec.md': '# spec\n' },
    ['README.md', 'spec.md'],
  );
  assert.deepEqual(await analyzeFile(join(root, 'README.md'), root, trackedSet), []);
});

test('a § citation is still flagged when the only link is in a different block', async () => {
  const doc = 'Per §3.2, retries back off.\n\nSee the [spec](spec.md).\n';
  const { root, trackedSet } = makeRepo({ 'README.md': doc, 'spec.md': '# spec\n' }, ['README.md', 'spec.md']);
  assert.deepEqual(lines(await analyzeFile(join(root, 'README.md'), root, trackedSet)), [['UNLINKED_REF', 1]]);
});

// --- exact line numbers: markdown-it only maps whole blocks, so every
// finding used to report its block's first line (or null in a table). ---

const lines = (f) => f.map((x) => [x.code, x.line]);

test('every finding reports the exact line its link or citation is on', async () => {
  const doc = [
    '# Title [h](gone-h.md)', //                     1
    '',
    'This paragraph wraps',
    'over several lines and',
    'links to [p](gone-p.md) here.', //             5
    '',
    '- item one',
    '  continues and links [li](gone-li.md)', //     8
    '  - nested item',
    '    wraps to [nested](gone-nested.md)', //     10
    '- lazy item',
    'continues lazily [lazy](gone-lazy.md)', //     12
    '',
    '> quoted text',
    '> wraps to [bq](gone-bq.md)', //               15
    '',
    '| a | b |',
    '|---|---|',
    '| r | [t1](gone-t1.md) |', //                  19
    '| s | [t2](gone-t2.md) |', //                  20
    '',
    'Code `spans',
    'wrap` too, then [cs](gone-cs.md).', //         23
    '',
    'Setext heading with',
    'a link [sx](gone-sx.md)', //                   26
    '===',
    '',
    'Hard break  ',
    '[hb](gone-hb.md)', //                          30
    '',
    '[ti](gone-ti.md "a title', //                  32
    'that wraps") then [after](gone-after.md)', //  33
    '',
    'Wrapped prose',
    'cites §4.1 here.', //                          36
    '',
  ].join('\n');
  const { root, trackedSet } = makeRepo({ 'README.md': doc }, ['README.md']);
  const B = 'REF_BROKEN';
  assert.deepEqual(lines(await analyzeFile(join(root, 'README.md'), root, trackedSet)), [
    [B, 1], [B, 5], [B, 8], [B, 10], [B, 12], [B, 15], [B, 19], [B, 20],
    [B, 23], [B, 26], [B, 30], [B, 32], [B, 33], ['UNLINKED_REF', 36],
  ]);
});

test('reference-style links and images report the line they are used on, not the definition', async () => {
  const doc = [
    'Intro.',
    '',
    'See [full][ref] and', //                3
    '[short] here, plus ![pic][img].', //    4
    '',
    '[ref]: gone-ref.md',
    '[short]: gone-short.md',
    '[img]: gone-img.png',
    '',
  ].join('\n');
  const { root, trackedSet } = makeRepo({ 'README.md': doc }, ['README.md']);
  const f = await analyzeFile(join(root, 'README.md'), root, trackedSet);
  assert.deepEqual(lines(f), [['REF_BROKEN', 3], ['REF_BROKEN', 4], ['REF_BROKEN', 4]]);
  assert.match(f[0].message, /gone-ref\.md/);
  assert.match(f[1].message, /gone-short\.md/);
  assert.match(f[2].message, /gone-img\.png/);
});

// --- images are references too: a broken `![](x.png)` renders as nothing. ---

test('an image with a missing src flags REF_BROKEN naming the src', async () => {
  const { root, trackedSet } = makeRepo({ 'README.md': 'Intro.\n\n![](missing.png)\n' }, ['README.md']);
  const f = await analyzeFile(join(root, 'README.md'), root, trackedSet);
  assert.deepEqual(lines(f), [['REF_BROKEN', 3]]);
  assert.match(f[0].message, /missing\.png/);
});

test('an image that exists but is gitignored flags REF_NOT_IN_GIT', async () => {
  const { root, trackedSet } = makeRepo(
    { '.gitignore': '*.png\n', 'README.md': '![diagram](arch.png)', 'arch.png': 'png' },
    ['.gitignore', 'README.md'],
  );
  assert.deepEqual(codes(await analyzeFile(join(root, 'README.md'), root, trackedSet)), ['REF_NOT_IN_GIT']);
});

test('a tracked image, a percent-encoded tracked image, an external image, and a data: URI are clean', async () => {
  const doc = [
    '![a](img/a.png)',
    '![b](img/my%20pic.png)',
    '![c](https://example.com/c.png)',
    '![d](data:image/png;base64,iVBORw0KGgo=)',
  ].join('\n\n');
  const { root, trackedSet } = makeRepo(
    { 'README.md': doc, 'img/a.png': 'a', 'img/my pic.png': 'b' },
    ['README.md', 'img/a.png', 'img/my pic.png'],
  );
  assert.deepEqual(await analyzeFile(join(root, 'README.md'), root, trackedSet), []);
});

test('a broken image nested inside a working link is still flagged', async () => {
  const { root, trackedSet } = makeRepo(
    { 'README.md': '[![badge](gone.svg)](docs/a.md)', 'docs/a.md': '# a\n' },
    ['README.md', 'docs/a.md'],
  );
  const f = await analyzeFile(join(root, 'README.md'), root, trackedSet);
  assert.deepEqual(lines(f), [['REF_BROKEN', 1]]);
  assert.match(f[0].message, /gone\.svg/);
});

// --- percent-decoding: markdown-it percent-encodes every href it emits
// (literal chars outside `<...>`, spaces inside it, and non-ASCII bytes),
// so the raw href never matches a tracked filesystem path without decoding
// it first. ---

test('a percent-encoded space in a link target resolves against the tracked file', async () => {
  const { root, trackedSet } = makeRepo(
    { 'README.md': 'See [x](my%20file.md).', 'my file.md': '# f\n' },
    ['README.md', 'my file.md'],
  );
  assert.deepEqual(await analyzeFile(join(root, 'README.md'), root, trackedSet), []);
});

test('an angle-bracket link target with a literal space resolves against the tracked file', async () => {
  const { root, trackedSet } = makeRepo(
    { 'README.md': 'See [x](<my file.md>).', 'my file.md': '# f\n' },
    ['README.md', 'my file.md'],
  );
  assert.deepEqual(await analyzeFile(join(root, 'README.md'), root, trackedSet), []);
});

test('a non-ASCII link target resolves against the tracked file', async () => {
  const { root, trackedSet } = makeRepo(
    { 'README.md': 'See [x](café.md).', 'café.md': '# c\n' },
    ['README.md', 'café.md'],
  );
  assert.deepEqual(await analyzeFile(join(root, 'README.md'), root, trackedSet), []);
});

test('a percent-encoded UTF-8 link target resolves against the same tracked file', async () => {
  const { root, trackedSet } = makeRepo(
    { 'README.md': 'See [x](caf%C3%A9.md).', 'café.md': '# c\n' },
    ['README.md', 'café.md'],
  );
  assert.deepEqual(await analyzeFile(join(root, 'README.md'), root, trackedSet), []);
});

test('a broken link with a percent-encoded space reports the decoded target in the message', async () => {
  const { root, trackedSet } = makeRepo({ 'README.md': 'See [x](my%20file.md).' }, ['README.md']);
  const findings = await analyzeFile(join(root, 'README.md'), root, trackedSet);
  assert.deepEqual(codes(findings), ['REF_BROKEN']);
  assert.match(findings[0].message, /`my file\.md`/);
});

test('an invalid percent-escape (%zz) is treated literally and flagged REF_BROKEN, not crashed', async () => {
  const { root, trackedSet } = makeRepo({ 'README.md': 'See [x](bad%zz.md).' }, ['README.md']);
  assert.deepEqual(codes(await analyzeFile(join(root, 'README.md'), root, trackedSet)), ['REF_BROKEN']);
});

test('a percent-escape that is not valid UTF-8 falls back to the raw target without crashing', async () => {
  const { root, trackedSet } = makeRepo({ 'README.md': 'See [x](%FF%FE.md).' }, ['README.md']);
  assert.deepEqual(codes(await analyzeFile(join(root, 'README.md'), root, trackedSet)), ['REF_BROKEN']);
});

test('%2F in a link target decodes to a path separator, resolving against the nested tracked file', async () => {
  const { root, trackedSet } = makeRepo(
    { 'README.md': 'See [x](a%2Fb.md).', 'a/b.md': '# b\n' },
    ['README.md', 'a/b.md'],
  );
  assert.deepEqual(await analyzeFile(join(root, 'README.md'), root, trackedSet), []);
});

const SCRIPTS_DIR = fileURLToPath(new URL('../../../module/skills/docs-organization/scripts', import.meta.url));
const SCRIPT = join(SCRIPTS_DIR, 'check-refs.mjs');

function runCli(cwd, ...args) {
  try {
    return { code: 0, out: JSON.parse(execFileSync('node', [SCRIPT, ...args], { cwd, env: GENV, encoding: 'utf8' })) };
  } catch (e) {
    if (e.status === 1) return { code: 1, out: JSON.parse(e.stdout) };
    throw e;
  }
}

// canon/ref/a.md links voices/x.md, which exists only beside the canonical copy.
// mod/ref/a.md is a symlink to it, so the same link is broken from that path.
function aliasedRepo(body) {
  return makeRepo(
    { 'canon/ref/a.md': body, 'canon/ref/voices/x.md': '# x\n' },
    ['canon/ref/a.md', 'canon/ref/voices/x.md', 'mod/ref/a.md'],
    { 'mod/ref/a.md': '../../canon/ref/a.md' },
  );
}

test('CLI: a link broken only from the symlink path is flagged there, naming the canonical file', async () => {
  const { root } = aliasedRepo('See [x](voices/x.md).\n');
  const { code, out } = runCli(root, 'canon', 'mod');
  assert.equal(code, 1);
  assert.equal(out.scanned, 3); // canon/ref/a.md, canon/ref/voices/x.md, mod/ref/a.md
  assert.deepEqual(out.findings.map((f) => [f.code, f.file]), [['REF_BROKEN', 'mod/ref/a.md']]);
  assert.match(out.findings[0].message, /canon\/ref\/a\.md/);
});

test('CLI: a content-only finding (UNLINKED_REF) is reported once per real file', async () => {
  const { root } = aliasedRepo('Per §4.2 of the spec.\n');
  const { out } = runCli(root, 'canon', 'mod');
  assert.deepEqual(codes(out.findings), ['UNLINKED_REF']);
});

test('CLI: a content-only finding is attributed to the canonical path regardless of arg order', async () => {
  const { root } = aliasedRepo('Per §4.2 of the spec.\n');
  const { out } = runCli(root, 'mod', 'canon');
  assert.equal(out.findings.length, 1);
  assert.equal(out.findings[0].file, 'canon/ref/a.md');
  assert.doesNotMatch(out.findings[0].message, /must work from both/);
});

test('CLI: an untracked doc reached by walking a directory is skipped', async () => {
  const { root } = makeRepo({ 'README.md': '# r\n', 'drafts/notes.md': 'See [gone](gone.md).\n' }, ['README.md']);
  const { code, out } = runCli(root, 'drafts');
  assert.equal(code, 0);
  assert.equal(out.scanned, 0);
});

// --- on-disk mode: docs outside git, and explicit untracked docs ---

test('on-disk mode (tracked = null): an existing target is clean, a missing one is REF_BROKEN', async () => {
  const dir = mktemp();
  writeFileSync(join(dir, 'doc.md'), 'See [here](here.md), [gone](gone.md), and [up](../).\n');
  writeFileSync(join(dir, 'here.md'), '# here\n');
  const findings = await analyzeFile(join(dir, 'doc.md'), null, null);
  assert.deepEqual(codes(findings), ['REF_BROKEN']);
  assert.match(findings[0].message, /`gone\.md` — no such file on disk/);
});

test('CLI: a doc outside any git repo is checked on disk, reported by absolute path', async () => {
  const dir = mktemp();
  mkdirSync(join(dir, '.issue-draft'));
  const doc = join(dir, '.issue-draft', 'ISSUE.md');
  writeFileSync(doc, 'See [spec](spec.md) and [gone](gone.md).\n\nPer §4.2 of the RFC.\n');
  writeFileSync(join(dir, '.issue-draft', 'spec.md'), '# spec\n');
  const { code, out } = runCli(dir, join(dir, '.issue-draft'));
  assert.equal(code, 1);
  assert.equal(out.scanned, 2);
  assert.deepEqual(out.findings.map((f) => [f.code, f.file]), [['REF_BROKEN', doc], ['UNLINKED_REF', doc]]);
});

test('CLI: outside git, a link to a file that exists never flags REF_NOT_IN_GIT', async () => {
  const dir = mktemp();
  writeFileSync(join(dir, 'doc.md'), 'See [x](x.md).\n');
  writeFileSync(join(dir, 'x.md'), '# x\n');
  const { code, out } = runCli(dir, 'doc.md');
  assert.equal(code, 0);
  assert.equal(out.scanned, 1);
});

// Runs the CLI without the runCli success/status-1 assumptions, so a fatal
// (status 2) git failure can be inspected instead of rethrown.
function runCliRaw(cwd, env, ...args) {
  try {
    execFileSync(process.execPath, [SCRIPT, ...args], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: 0, stderr: '' };
  } catch (e) {
    return { status: e.status, stderr: e.stderr };
  }
}

test('CLI: a corrupted git config exits 2 with the git error, not silently treated as outside git', async () => {
  const { root } = makeRepo({ 'README.md': 'See [gone](gone.md).\n' }, ['README.md']);
  writeFileSync(join(root, '.git', 'config'), '[broken\n', { flag: 'a' });
  const { status, stderr } = runCliRaw(root, GENV, 'README.md');
  assert.equal(status, 2);
  assert.match(stderr, /bad config/);
});

test('CLI: a missing git binary exits 2 rather than silently checking on disk', async () => {
  const dir = mktemp();
  writeFileSync(join(dir, 'doc.md'), 'See [gone](gone.md).\n');
  const fakeBin = mktemp('check-refs-fakebin-');
  symlinkSync(process.execPath, join(fakeBin, 'node'));
  const { status } = runCliRaw(dir, { ...GENV, PATH: fakeBin }, 'doc.md');
  assert.equal(status, 2);
});

test('CLI: an explicit gitignored doc in a repo is checked on disk, reported repo-relative', async () => {
  const { root } = makeRepo(
    {
      '.gitignore': 'drafts/\n',
      'README.md': '# r\n',
      'drafts/ISSUE.md': 'See [readme](../README.md), [sib](sib.md), and [gone](gone.md).\n',
      'drafts/sib.md': '# untracked sibling\n',
    },
    ['.gitignore', 'README.md'],
  );
  const { code, out } = runCli(root, 'drafts/ISSUE.md');
  assert.equal(code, 1);
  assert.equal(out.scanned, 1);
  assert.deepEqual(out.findings.map((f) => [f.code, f.file]), [['REF_BROKEN', 'drafts/ISSUE.md']]);
});

test('CLI: an explicit doc outside the cwd repo is judged by its own location', async () => {
  const { root } = makeRepo({ 'README.md': '# r\n' }, ['README.md']);
  const outside = mktemp();
  writeFileSync(join(outside, 'doc.md'), 'See [gone](gone.md).\n');
  const { code, out } = runCli(root, join(outside, 'doc.md'));
  assert.equal(code, 1);
  assert.deepEqual(out.findings.map((f) => [f.code, f.file]), [['REF_BROKEN', join(outside, 'doc.md')]]);
});

// git reports the physical repo root; a repo reached through a symlinked
// directory (a symlinked workspace, macOS /tmp) must still match the tracked set.
function repoViaSymlinkedDir() {
  const { root } = makeRepo(
    {
      '.gitignore': 'docs/private/\n',
      'docs/guide.md': 'See the [spec](private/spec.md).\n',
      'docs/private/spec.md': '# secret\n',
    },
    ['.gitignore', 'docs/guide.md'],
  );
  const link = join(mktemp('check-refs-link-'), 'repo');
  symlinkSync(root, link, 'dir');
  return { root, link };
}

test('CLI: a tracked doc reached through a symlinked directory is checked in git mode', async () => {
  const { root, link } = repoViaSymlinkedDir();
  const viaReal = runCli(root, join(root, 'docs', 'guide.md'));
  const viaLink = runCli(root, join(link, 'docs', 'guide.md'));
  assert.equal(viaLink.code, 1);
  assert.deepEqual(viaLink.out.findings.map((f) => [f.code, f.file]), [['REF_NOT_IN_GIT', 'docs/guide.md']]);
  assert.deepEqual(viaLink.out, viaReal.out);
});

test('CLI: a directory argument through a symlinked directory scans the tracked docs', async () => {
  const { root, link } = repoViaSymlinkedDir();
  const { code, out } = runCli(root, join(link, 'docs'));
  assert.equal(code, 1);
  assert.equal(out.scanned, 1);
  assert.deepEqual(out.findings.map((f) => [f.code, f.file]), [['REF_NOT_IN_GIT', 'docs/guide.md']]);
});

test('CLI: a symlinked doc outside git names its canonical absolute path', async () => {
  const dir = mktemp();
  mkdirSync(join(dir, 'canon'));
  mkdirSync(join(dir, 'mod'));
  writeFileSync(join(dir, 'canon', 'a.md'), 'See [x](x.md).\n');
  writeFileSync(join(dir, 'canon', 'x.md'), '# x\n');
  symlinkSync('../canon/a.md', join(dir, 'mod', 'a.md'));
  const { out } = runCli(dir, join(dir, 'mod', 'a.md'));
  assert.deepEqual(out.findings.map((f) => [f.code, f.file]), [['REF_BROKEN', join(dir, 'mod', 'a.md')]]);
  assert.match(out.findings[0].message, new RegExp(`symlink to \`${join(dir, 'canon', 'a.md').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\``));
});

// Outside git, `../` resolves from the path the doc was reached by, as a
// reader's viewer does and as fetch-citations.mjs does. Only git mode needs
// the physical directory (git reports the physical root).
test('CLI: outside git, a doc reached through a symlinked directory resolves ../ from that path', async () => {
  const dir = mktemp();
  mkdirSync(join(dir, 'A', 'real'), { recursive: true });
  mkdirSync(join(dir, 'B'));
  writeFileSync(join(dir, 'A', 'real', 'd.md'), 'See [sib](../sib.md).\n');
  writeFileSync(join(dir, 'B', 'sib.md'), '# sib\n');
  symlinkSync('../A/real', join(dir, 'B', 'link'), 'dir');
  const { code, out } = runCli(dir, join(dir, 'B', 'link', 'd.md'));
  assert.equal(code, 0);
  assert.equal(out.scanned, 1);
});

// --- entry guard: the script must run as the main module from any install
// path, not just one with no spaces and no symlinks in it. ---


// Copies the whole (runtime-only) scripts directory rather than a
// hand-picked file list, so a script gaining a new sibling import can't
// silently break this test.
function copyScriptsDirTo(destDir) {
  cpSync(SCRIPTS_DIR, destDir, { recursive: true });
}

function runScriptAt(scriptPath, cwd, args, nodeFlags = []) {
  try {
    return { code: 0, out: JSON.parse(execFileSync('node', [...nodeFlags, scriptPath, ...args], { cwd, env: GENV, encoding: 'utf8' })) };
  } catch (e) {
    if (e.status === 1) return { code: 1, out: JSON.parse(e.stdout) };
    throw e;
  }
}

function brokenRefRepo() {
  return makeRepo({ 'README.md': 'See [gone](docs/gone.md).' }, ['README.md']).root;
}

test('CLI: invocable via a script path containing a space', async () => {
  const spaceParent = mktemp();
  const targetDir = join(spaceParent, 'sp ace');
  copyScriptsDirTo(targetDir);

  const { code, out } = runScriptAt(join(targetDir, 'check-refs.mjs'), brokenRefRepo(), ['README.md']);
  assert.equal(code, 1);
  assert.deepEqual(codes(out.findings), ['REF_BROKEN']);
});

test('CLI: invocable through a symlinked directory', async () => {
  const parent = mktemp();
  const linkDir = join(parent, 'link');
  symlinkSync(SCRIPTS_DIR, linkDir, 'dir');

  const { code, out } = runScriptAt(join(linkDir, 'check-refs.mjs'), brokenRefRepo(), ['README.md']);
  assert.equal(code, 1);
  assert.deepEqual(codes(out.findings), ['REF_BROKEN']);
});

test('a bare URL does not count as a link for a § citation in the same paragraph', async () => {
  const { root, trackedSet } = makeRepo({ 'README.md': 'See §2 at https://example.com/spec.\n' }, ['README.md']);
  assert.deepEqual(codes(await analyzeFile(join(root, 'README.md'), root, trackedSet)), ['UNLINKED_REF']);
});

test('a link inside a GFM alert or admonition is resolved', async () => {
  const doc = '> [!NOTE]\n> See [gone](gone.md).\n\n!!! tip\n    Also [missing](missing.md).\n';
  const { root, trackedSet } = makeRepo({ 'README.md': doc }, ['README.md']);
  const findings = await analyzeFile(join(root, 'README.md'), root, trackedSet);
  assert.deepEqual(findings.map((f) => [f.code, f.line]), [['REF_BROKEN', 2], ['REF_BROKEN', 5]]);
});

test('a link in front matter is not a reference', async () => {
  const { root, trackedSet } = makeRepo({ 'README.md': '---\nsee: "[x](gone.md)"\n---\n# T\n' }, ['README.md']);
  assert.deepEqual(await analyzeFile(join(root, 'README.md'), root, trackedSet), []);
});

test('a .markdown file is checked like a .md file', async () => {
  const { root, trackedSet } = makeRepo({ 'guide.markdown': '[x](gone.md)\n' }, ['guide.markdown']);
  assert.deepEqual(codes(await analyzeFile(join(root, 'guide.markdown'), root, trackedSet)), ['REF_BROKEN']);
});

test('AsciiDoc: links, includes, and xrefs resolve; anchors, unresolved attributes are skipped; parse warnings surface', async () => {
  const doc = [
    '= Project',                                                   // 1
    ':docs: docs/',                                                // 2
    '',
    'See link:{docs}guide.adoc[the guide] and link:gone.adoc[gone].', // 4
    '',
    'include::partials/missing.adoc[]',                            // 6
    '',
    'Jump to xref:other.adoc#setup[setup] or <<local-anchor>>.',   // 8
    '',
    'Unresolved link:{nope}x.adoc[x] is skipped.',                 // 10
    '',
    'Spec §4.1 has no link here.',                                 // 12
    '',
    '----',                                                        // 14
    'unterminated',
  ].join('\n');
  const { root, trackedSet } = makeRepo(
    { 'README.adoc': doc, 'docs/guide.adoc': '= Guide\n', 'other.adoc': '= Other\n' },
    ['README.adoc', 'docs/guide.adoc', 'other.adoc'],
  );
  const findings = await analyzeFile(join(root, 'README.adoc'), root, trackedSet);
  assert.deepEqual(findings.map((f) => [f.code, f.line]), [
    ['REF_BROKEN', 4], ['REF_BROKEN', 6], ['UNLINKED_REF', 12], ['PARSE_WARNING', 14],
  ]);
  assert.match(findings[1].message, /include of `partials\/missing\.adoc`/);
});

test('AsciiDoc: an include of an absolute path outside the repo is neither read nor flagged', async () => {
  const { root, trackedSet } = makeRepo({ 'README.adoc': 'include::/etc/passwd[]\n' }, ['README.adoc']);
  assert.deepEqual(await analyzeFile(join(root, 'README.adoc'), root, trackedSet), []);
});
