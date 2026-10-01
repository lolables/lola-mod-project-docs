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

test('a tracked link, an external URL, and an anchor are all clean', () => {
  const doc = 'See [arch](docs/arch.md), the [site](https://example.com), and [top](#intro).';
  const { root, trackedSet } = makeRepo(
    { 'README.md': doc, 'docs/arch.md': '# arch\n' },
    ['README.md', 'docs/arch.md'],
  );
  assert.deepEqual(analyzeFile(join(root, 'README.md'), root, trackedSet), []);
});

test('a link to a gitignored file flags REF_NOT_IN_GIT', () => {
  const { root, trackedSet } = makeRepo(
    {
      '.gitignore': 'docs/private/\n',
      'README.md': 'See the [spec](docs/private/spec.md).',
      'docs/private/spec.md': '# secret\n',
    },
    ['.gitignore', 'README.md'],
  );
  assert.deepEqual(codes(analyzeFile(join(root, 'README.md'), root, trackedSet)), ['REF_NOT_IN_GIT']);
});

test('a link to a nonexistent file flags REF_BROKEN', () => {
  const { root, trackedSet } = makeRepo({ 'README.md': 'See [gone](docs/gone.md).' }, ['README.md']);
  assert.deepEqual(codes(analyzeFile(join(root, 'README.md'), root, trackedSet)), ['REF_BROKEN']);
});

test('an inline-code source path is NOT flagged (mentions are not links)', () => {
  // The repo has no such file, but `internal/x.go` is a mention, not a link.
  const { root, trackedSet } = makeRepo({ 'README.md': 'The entry point is `internal/x.go`.' }, ['README.md']);
  assert.deepEqual(analyzeFile(join(root, 'README.md'), root, trackedSet), []);
});

test('a link to a tracked directory is followable (not flagged)', () => {
  const { root, trackedSet } = makeRepo(
    { 'README.md': 'See the [agents](module/agents/).', 'module/agents/a.md': '# a\n' },
    ['README.md', 'module/agents/a.md'],
  );
  assert.deepEqual(analyzeFile(join(root, 'README.md'), root, trackedSet), []);
});

test('a link to a gitignored directory flags REF_NOT_IN_GIT', () => {
  const { root, trackedSet } = makeRepo(
    {
      '.gitignore': 'build/\n',
      'README.md': 'See the [output](build/).',
      'build/out.md': '# out\n',
    },
    ['.gitignore', 'README.md'],
  );
  assert.deepEqual(codes(analyzeFile(join(root, 'README.md'), root, trackedSet)), ['REF_NOT_IN_GIT']);
});

test('a bare § citation with no link flags UNLINKED_REF', () => {
  const { root, trackedSet } = makeRepo({ 'README.md': 'This follows spec §10.9 E-3.' }, ['README.md']);
  assert.deepEqual(codes(analyzeFile(join(root, 'README.md'), root, trackedSet)), ['UNLINKED_REF']);
});

test('a § inside a resolvable link is not flagged', () => {
  const { root, trackedSet } = makeRepo(
    { 'README.md': 'See [§10.9](docs/arch.md).', 'docs/arch.md': '# arch\n' },
    ['README.md', 'docs/arch.md'],
  );
  assert.deepEqual(analyzeFile(join(root, 'README.md'), root, trackedSet), []);
});

test('a § citation whose inline block also links a document is not flagged', () => {
  const { root, trackedSet } = makeRepo(
    { 'README.md': 'Per §3.2 of the [spec](spec.md), retries back off.', 'spec.md': '# spec\n' },
    ['README.md', 'spec.md'],
  );
  assert.deepEqual(analyzeFile(join(root, 'README.md'), root, trackedSet), []);
});

test('a § citation is still flagged when the only link is in a different block', () => {
  const doc = 'Per §3.2, retries back off.\n\nSee the [spec](spec.md).\n';
  const { root, trackedSet } = makeRepo({ 'README.md': doc, 'spec.md': '# spec\n' }, ['README.md', 'spec.md']);
  assert.deepEqual(lines(analyzeFile(join(root, 'README.md'), root, trackedSet)), [['UNLINKED_REF', 1]]);
});

// --- exact line numbers: markdown-it only maps whole blocks, so every
// finding used to report its block's first line (or null in a table). ---

const lines = (f) => f.map((x) => [x.code, x.line]);

test('every finding reports the exact line its link or citation is on', () => {
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
  assert.deepEqual(lines(analyzeFile(join(root, 'README.md'), root, trackedSet)), [
    [B, 1], [B, 5], [B, 8], [B, 10], [B, 12], [B, 15], [B, 19], [B, 20],
    [B, 23], [B, 26], [B, 30], [B, 32], [B, 33], ['UNLINKED_REF', 36],
  ]);
});

test('reference-style links and images report the line they are used on, not the definition', () => {
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
  const f = analyzeFile(join(root, 'README.md'), root, trackedSet);
  assert.deepEqual(lines(f), [['REF_BROKEN', 3], ['REF_BROKEN', 4], ['REF_BROKEN', 4]]);
  assert.match(f[0].message, /gone-ref\.md/);
  assert.match(f[1].message, /gone-short\.md/);
  assert.match(f[2].message, /gone-img\.png/);
});

// --- images are references too: a broken `![](x.png)` renders as nothing. ---

test('an image with a missing src flags REF_BROKEN naming the src', () => {
  const { root, trackedSet } = makeRepo({ 'README.md': 'Intro.\n\n![](missing.png)\n' }, ['README.md']);
  const f = analyzeFile(join(root, 'README.md'), root, trackedSet);
  assert.deepEqual(lines(f), [['REF_BROKEN', 3]]);
  assert.match(f[0].message, /missing\.png/);
});

test('an image that exists but is gitignored flags REF_NOT_IN_GIT', () => {
  const { root, trackedSet } = makeRepo(
    { '.gitignore': '*.png\n', 'README.md': '![diagram](arch.png)', 'arch.png': 'png' },
    ['.gitignore', 'README.md'],
  );
  assert.deepEqual(codes(analyzeFile(join(root, 'README.md'), root, trackedSet)), ['REF_NOT_IN_GIT']);
});

test('a tracked image, a percent-encoded tracked image, an external image, and a data: URI are clean', () => {
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
  assert.deepEqual(analyzeFile(join(root, 'README.md'), root, trackedSet), []);
});

test('a broken image nested inside a working link is still flagged', () => {
  const { root, trackedSet } = makeRepo(
    { 'README.md': '[![badge](gone.svg)](docs/a.md)', 'docs/a.md': '# a\n' },
    ['README.md', 'docs/a.md'],
  );
  const f = analyzeFile(join(root, 'README.md'), root, trackedSet);
  assert.deepEqual(lines(f), [['REF_BROKEN', 1]]);
  assert.match(f[0].message, /gone\.svg/);
});

// --- percent-decoding: markdown-it percent-encodes every href it emits
// (literal chars outside `<...>`, spaces inside it, and non-ASCII bytes),
// so the raw href never matches a tracked filesystem path without decoding
// it first. ---

test('a percent-encoded space in a link target resolves against the tracked file', () => {
  const { root, trackedSet } = makeRepo(
    { 'README.md': 'See [x](my%20file.md).', 'my file.md': '# f\n' },
    ['README.md', 'my file.md'],
  );
  assert.deepEqual(analyzeFile(join(root, 'README.md'), root, trackedSet), []);
});

test('an angle-bracket link target with a literal space resolves against the tracked file', () => {
  const { root, trackedSet } = makeRepo(
    { 'README.md': 'See [x](<my file.md>).', 'my file.md': '# f\n' },
    ['README.md', 'my file.md'],
  );
  assert.deepEqual(analyzeFile(join(root, 'README.md'), root, trackedSet), []);
});

test('a non-ASCII link target resolves against the tracked file', () => {
  const { root, trackedSet } = makeRepo(
    { 'README.md': 'See [x](café.md).', 'café.md': '# c\n' },
    ['README.md', 'café.md'],
  );
  assert.deepEqual(analyzeFile(join(root, 'README.md'), root, trackedSet), []);
});

test('a percent-encoded UTF-8 link target resolves against the same tracked file', () => {
  const { root, trackedSet } = makeRepo(
    { 'README.md': 'See [x](caf%C3%A9.md).', 'café.md': '# c\n' },
    ['README.md', 'café.md'],
  );
  assert.deepEqual(analyzeFile(join(root, 'README.md'), root, trackedSet), []);
});

test('a broken link with a percent-encoded space reports the decoded target in the message', () => {
  const { root, trackedSet } = makeRepo({ 'README.md': 'See [x](my%20file.md).' }, ['README.md']);
  const findings = analyzeFile(join(root, 'README.md'), root, trackedSet);
  assert.deepEqual(codes(findings), ['REF_BROKEN']);
  assert.match(findings[0].message, /`my file\.md`/);
});

test('an invalid percent-escape (%zz) is treated literally and flagged REF_BROKEN, not crashed', () => {
  const { root, trackedSet } = makeRepo({ 'README.md': 'See [x](bad%zz.md).' }, ['README.md']);
  assert.deepEqual(codes(analyzeFile(join(root, 'README.md'), root, trackedSet)), ['REF_BROKEN']);
});

test('a percent-escape that is not valid UTF-8 falls back to the raw target without crashing', () => {
  const { root, trackedSet } = makeRepo({ 'README.md': 'See [x](%FF%FE.md).' }, ['README.md']);
  assert.deepEqual(codes(analyzeFile(join(root, 'README.md'), root, trackedSet)), ['REF_BROKEN']);
});

test('%2F in a link target decodes to a path separator, resolving against the nested tracked file', () => {
  const { root, trackedSet } = makeRepo(
    { 'README.md': 'See [x](a%2Fb.md).', 'a/b.md': '# b\n' },
    ['README.md', 'a/b.md'],
  );
  assert.deepEqual(analyzeFile(join(root, 'README.md'), root, trackedSet), []);
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

test('CLI: a link broken only from the symlink path is flagged there, naming the canonical file', () => {
  const { root } = aliasedRepo('See [x](voices/x.md).\n');
  const { code, out } = runCli(root, 'canon', 'mod');
  assert.equal(code, 1);
  assert.equal(out.scanned, 3); // canon/ref/a.md, canon/ref/voices/x.md, mod/ref/a.md
  assert.deepEqual(out.findings.map((f) => [f.code, f.file]), [['REF_BROKEN', 'mod/ref/a.md']]);
  assert.match(out.findings[0].message, /canon\/ref\/a\.md/);
});

test('CLI: a content-only finding (UNLINKED_REF) is reported once per real file', () => {
  const { root } = aliasedRepo('Per §4.2 of the spec.\n');
  const { out } = runCli(root, 'canon', 'mod');
  assert.deepEqual(codes(out.findings), ['UNLINKED_REF']);
});

test('CLI: a content-only finding is attributed to the canonical path regardless of arg order', () => {
  const { root } = aliasedRepo('Per §4.2 of the spec.\n');
  const { out } = runCli(root, 'mod', 'canon');
  assert.equal(out.findings.length, 1);
  assert.equal(out.findings[0].file, 'canon/ref/a.md');
  assert.doesNotMatch(out.findings[0].message, /must work from both/);
});

test('CLI: scanned is 0 when no tracked doc was given', () => {
  const { root } = makeRepo({ 'README.md': '# r\n', 'notes.md': '# n\n' }, ['README.md']);
  const { code, out } = runCli(root, 'notes.md');
  assert.equal(code, 0);
  assert.equal(out.scanned, 0);
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

test('CLI: invocable via a script path containing a space', () => {
  const spaceParent = mktemp();
  const targetDir = join(spaceParent, 'sp ace');
  copyScriptsDirTo(targetDir);

  const { code, out } = runScriptAt(join(targetDir, 'check-refs.mjs'), brokenRefRepo(), ['README.md']);
  assert.equal(code, 1);
  assert.deepEqual(codes(out.findings), ['REF_BROKEN']);
});

test('CLI: invocable through a symlinked directory', () => {
  const parent = mktemp();
  const linkDir = join(parent, 'link');
  symlinkSync(SCRIPTS_DIR, linkDir, 'dir');

  const { code, out } = runScriptAt(join(linkDir, 'check-refs.mjs'), brokenRefRepo(), ['README.md']);
  assert.equal(code, 1);
  assert.deepEqual(codes(out.findings), ['REF_BROKEN']);
});
