import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, writeFileSync, mkdirSync, realpathSync, readFileSync,
  cpSync, symlinkSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isSource } from '../../../module/skills/docs-organization/scripts/check-staleness.mjs';

const SCRIPTS_DIR = fileURLToPath(new URL('../../../module/skills/docs-organization/scripts', import.meta.url));
const SCRIPT = join(SCRIPTS_DIR, 'check-staleness.mjs');

const GENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'check-staleness-test',
  GIT_AUTHOR_EMAIL: 'check-staleness-test@invalid',
  GIT_COMMITTER_NAME: 'check-staleness-test',
  GIT_COMMITTER_EMAIL: 'check-staleness-test@invalid',
};

// Every temp dir any test creates is tracked here and removed once, after
// the whole file runs.
const tmpDirs = [];
after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function mktemp(prefix = 'check-staleness-') {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tmpDirs.push(d);
  return d;
}

const git = (root, ...args) => execFileSync('git', args, { cwd: root, env: GENV, encoding: 'utf8' });

function makeRepo() {
  const root = mktemp();
  git(root, 'init', '-q', '-b', 'main');
  return root;
}

function write(root, path, body) {
  mkdirSync(join(root, dirname(path)), { recursive: true });
  writeFileSync(join(root, path), body);
}

function commit(root, date, msg) {
  execFileSync('git', ['commit', '-q', '-m', msg], {
    cwd: root,
    env: { ...GENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    encoding: 'utf8',
  });
}

function runScriptAt(scriptPath, cwd, env = GENV) {
  try {
    return { code: 0, out: JSON.parse(execFileSync('node', [scriptPath], { cwd, env, encoding: 'utf8' })) };
  } catch (e) {
    if (e.status === 1) return { code: 1, out: JSON.parse(e.stdout) };
    throw e;
  }
}

function runCli(cwd, env = GENV) {
  return runScriptAt(SCRIPT, cwd, env);
}

// --- Unit: isSource ---

test('isSource: recognized languages across extensions and exact filenames are true', () => {
  for (const p of ['src/main.py', 'scripts/tools/run.py', 'app.ts', 'lib/x.rs', 'inc/a.h', 'Makefile', 'pkg/server.go', 'Main.java']) {
    assert.equal(isSource(p), true, p);
  }
});

test('isSource: prose and data files are not source', () => {
  for (const p of ['README.md', 'notes.txt', 'config.yml', 'data.json', 'docs/guide.md']) {
    assert.equal(isSource(p), false, p);
  }
});

test('isSource: vendored, generated, fixture, CI, and dot-directory paths are excluded despite a source extension', () => {
  for (const p of [
    'vendor/x.js',
    'node_modules/a/i.js',
    'dist/app.js',
    'web/app.min.js',
    'test/fixtures/a.py',
    'docs/examples/x.py',
    '.github/scripts/ci.js',
    'a/.hidden/b.py',
  ]) {
    assert.equal(isSource(p), false, p);
  }
});

test('isSource: a test-suffixed filename and a mixed-case extension are still recognized', () => {
  // src/foo.test.js: the first (longest) suffix tried, .test.js, is not in
  // EXTENSIONS, so the scan must fall back to the shorter .js suffix.
  // Main.PY: EXTENSIONS is lower-cased, so matching must lower-case first.
  assert.equal(isSource('src/foo.test.js'), true);
  assert.equal(isSource('Main.PY'), true);
});

test('isSource: a real multi-dot Linguist extension (.h.in) is recognized, not just the final .in', () => {
  // .h.in is a genuine vendored extension; .in alone is not, so this only
  // passes if the scan tries the longer multi-dot suffix before giving up.
  assert.equal(isSource('config.h.in'), true);
});

test('vendored linguist data: .md is not a source extension, and every excludePaths entry compiles as a RegExp', () => {
  const linguist = JSON.parse(readFileSync(join(SCRIPTS_DIR, 'vendor', 'linguist.json'), 'utf8'));
  assert.equal(linguist.extensions.includes('.md'), false);
  for (const pattern of linguist.excludePaths) {
    assert.doesNotThrow(() => new RegExp(pattern), `excludePaths entry failed to compile: ${pattern}`);
  }
});

// --- CLI ---

test('CLI: code newer than README triggers STALE_README, exit 1', () => {
  const root = makeRepo();
  write(root, 'README.md', '# old\n');
  git(root, 'add', 'README.md');
  commit(root, '2026-01-01T12:00:00', 'initial docs');
  write(root, 'src/main.js', 'function f() {}\n');
  git(root, 'add', 'src/main.js');
  commit(root, '2026-05-01T12:00:00', 'code change');
  const { code, out } = runCli(root);
  assert.equal(code, 1);
  assert.deepEqual(out.findings.map((f) => f.code), ['STALE_README']);
});

test('CLI: code and README updated in the same commit is ok', () => {
  const root = makeRepo();
  write(root, 'README.md', '# doc\n');
  write(root, 'src/main.js', 'function f() {}\n');
  git(root, 'add', 'README.md', 'src/main.js');
  commit(root, '2026-05-01T12:00:00', 'init');
  const { code, out } = runCli(root);
  assert.equal(code, 0);
  assert.equal(out.status, 'ok');
});

test('CLI: a docs-only repo cannot be assessed', () => {
  const root = makeRepo();
  write(root, 'README.md', '# doc\n');
  write(root, 'docs/a.md', '# a\n');
  write(root, 'docs/b.md', '# b\n');
  git(root, 'add', 'README.md', 'docs/a.md', 'docs/b.md');
  commit(root, '2026-05-01T12:00:00', 'docs only');
  const { code, out } = runCli(root);
  assert.equal(code, 1);
  assert.equal(out.status, 'findings');
  assert.deepEqual(out.findings.map((f) => f.code), ['STALENESS_NOT_ASSESSED']);
});

test('CLI: a repo with commits but only data files ever changed is not assessed', () => {
  const root = makeRepo();
  write(root, 'README.md', '# doc\n');
  git(root, 'add', 'README.md');
  commit(root, '2026-01-01T12:00:00', 'initial');
  write(root, 'config.yml', 'a: 1\n');
  write(root, 'data.json', '{}\n');
  git(root, 'add', 'config.yml', 'data.json');
  commit(root, '2026-05-01T12:00:00', 'data change');
  const { code, out } = runCli(root);
  assert.equal(code, 1);
  assert.deepEqual(out.findings.map((f) => f.code), ['STALENESS_NOT_ASSESSED']);
});

test('CLI: a source extension that only ever appears in an excluded path is not assessed', () => {
  // vendor/x.js is technically a .js file, but isSource() excludes vendor/
  // paths, so no commit ever counts as touching source.
  const root = makeRepo();
  write(root, 'README.md', '# doc\n');
  write(root, 'vendor/x.js', 'function v() {}\n');
  git(root, 'add', 'README.md', 'vendor/x.js');
  commit(root, '2026-05-01T12:00:00', 'init');
  const { code, out } = runCli(root);
  assert.equal(code, 1);
  assert.deepEqual(out.findings.map((f) => f.code), ['STALENESS_NOT_ASSESSED']);
});

test('CLI: Python outside src/ with no marker file still counts as source', () => {
  const root = makeRepo();
  write(root, 'README.md', '# old\n');
  git(root, 'add', 'README.md');
  commit(root, '2026-01-01T12:00:00', 'initial');
  write(root, 'scripts/tools/run.py', 'x = 1\n');
  git(root, 'add', 'scripts/tools/run.py');
  commit(root, '2026-05-01T12:00:00', 'code change');
  const { code, out } = runCli(root);
  assert.equal(code, 1);
  assert.deepEqual(out.findings.map((f) => f.code), ['STALE_README']);
});

test('CLI: Java, a language the old marker list missed, is recognized as source', () => {
  const root = makeRepo();
  write(root, 'README.md', '# old\n');
  git(root, 'add', 'README.md');
  commit(root, '2026-01-01T12:00:00', 'initial');
  write(root, 'Main.java', 'class Main {}\n');
  git(root, 'add', 'Main.java');
  commit(root, '2026-05-01T12:00:00', 'code change');
  const { code, out } = runCli(root);
  assert.equal(code, 1);
  assert.deepEqual(out.findings.map((f) => f.code), ['STALE_README']);
});

test('CLI: vendored JS newer than README does not trigger staleness when real source is unchanged', () => {
  const root = makeRepo();
  write(root, 'README.md', '# doc\n');
  write(root, 'src/main.js', 'function f() {}\n');
  git(root, 'add', 'README.md', 'src/main.js');
  commit(root, '2026-01-01T12:00:00', 'initial');
  write(root, 'vendor/lib.js', 'function v() {}\n');
  git(root, 'add', 'vendor/lib.js');
  commit(root, '2026-05-01T12:00:00', 'vendor bump');
  const { code, out } = runCli(root);
  assert.equal(code, 0);
  assert.equal(out.status, 'ok');
});

test('CLI: a commit that only deletes a source file still counts as a source change', () => {
  // Classification works on names, not on whether the file still exists at
  // HEAD, so deleting the last file of an extension must still surface the
  // deleting commit.
  const root = makeRepo();
  write(root, 'README.md', '# old\n');
  write(root, 'src/main.js', 'function f() {}\n');
  git(root, 'add', 'README.md', 'src/main.js');
  commit(root, '2026-01-01T12:00:00', 'initial');
  git(root, 'rm', '-q', 'src/main.js');
  commit(root, '2026-05-01T12:00:00', 'remove main.js');
  const { code, out } = runCli(root);
  assert.equal(code, 1);
  assert.deepEqual(out.findings.map((f) => f.code), ['STALE_README']);
});

test('CLI: a non-ASCII source path is discovered', () => {
  const root = makeRepo();
  write(root, 'README.md', '# old\n');
  git(root, 'add', 'README.md');
  commit(root, '2026-01-01T12:00:00', 'initial');
  write(root, 'café/x.go', 'package main\n');
  git(root, 'add', 'café/x.go');
  commit(root, '2026-05-01T12:00:00', 'code change');
  const { code, out } = runCli(root);
  assert.equal(code, 1);
  assert.deepEqual(out.findings.map((f) => f.code), ['STALE_README']);
});

test('CLI: a source edit made only as a merge conflict resolution is discovered (plain --name-only omits merge-commit diffs)', () => {
  // Every commit that git shows individually (root, feature, main) is dated
  // the same as README's own last touch, so none of them alone can trigger
  // STALE_README. Only the merge commit's own (much later) resolution edit
  // can — and that edit is invisible to `git log --name-only` without --cc,
  // which is exactly the bug: without --cc this test would see no source
  // change after README and wrongly report ok.
  const root = makeRepo();
  write(root, 'README.md', '# doc\n');
  write(root, 'src/a.js', 'v1\n');
  git(root, 'add', 'README.md', 'src/a.js');
  commit(root, '2026-01-01T12:00:00', 'initial');

  git(root, 'checkout', '-q', '-b', 'feature');
  write(root, 'src/a.js', 'v2 - feature\n');
  git(root, 'add', 'src/a.js');
  commit(root, '2026-01-01T12:00:00', 'feature change');

  git(root, 'checkout', '-q', 'main');
  write(root, 'src/a.js', 'v3 - main\n');
  git(root, 'add', 'src/a.js');
  commit(root, '2026-01-01T12:00:00', 'main change');

  // --no-commit always leaves the merge to be finished by hand, whether or
  // not the two sides actually conflict on disk.
  try {
    execFileSync('git', ['merge', '-q', '--no-ff', '--no-commit', 'feature'], { cwd: root, env: GENV, encoding: 'utf8' });
  } catch { /* conflicting merge exits non-zero; resolution follows below */ }
  write(root, 'src/a.js', 'v4 - resolved by merge\n');
  git(root, 'add', 'src/a.js');
  commit(root, '2026-05-01T12:00:00', 'merge feature, resolve conflict');

  const { code, out } = runCli(root);
  assert.equal(code, 1);
  assert.deepEqual(out.findings.map((f) => f.code), ['STALE_README']);
});

test('CLI: a root commit\'s source is discovered even when the caller\'s global git config sets log.showRoot=false', () => {
  const configDir = mktemp('check-staleness-cfg-');
  const configFile = join(configDir, 'gitconfig');
  writeFileSync(configFile, '[log]\n\tshowRoot = false\n');
  const env = { ...GENV, GIT_CONFIG_GLOBAL: configFile };

  const root = mktemp();
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env, encoding: 'utf8' });
  write(root, 'src/a.py', 'x = 1\n');
  execFileSync('git', ['add', 'src/a.py'], { cwd: root, env, encoding: 'utf8' });
  execFileSync('git', ['commit', '-q', '-m', 'root: add source only'], {
    cwd: root, env: { ...env, GIT_AUTHOR_DATE: '2026-01-01T12:00:00', GIT_COMMITTER_DATE: '2026-01-01T12:00:00' }, encoding: 'utf8',
  });
  write(root, 'README.md', '# doc\n');
  execFileSync('git', ['add', 'README.md'], { cwd: root, env, encoding: 'utf8' });
  execFileSync('git', ['commit', '-q', '-m', 'add readme'], {
    cwd: root, env: { ...env, GIT_AUTHOR_DATE: '2026-02-01T12:00:00', GIT_COMMITTER_DATE: '2026-02-01T12:00:00' }, encoding: 'utf8',
  });

  // If the root commit's src/a.py were invisible (log.showRoot=false, no
  // --root override), no commit would ever be found touching source, and
  // this would come back STALENESS_NOT_ASSESSED instead of ok.
  const { code, out } = runCli(root, env);
  assert.equal(code, 0);
  assert.equal(out.status, 'ok');
});

test('CLI: STALE_DOC names an ordinary stale doc but excludes dot-directories, LLM-config filenames, and gitignored files', () => {
  const root = makeRepo();
  write(root, '.gitignore', 'docs/untracked.md\n');
  write(root, 'docs/regular.md', '# regular\n');
  write(root, 'docs/.hidden/legacy.md', '# legacy\n');
  write(root, 'docs/CLAUDE.md', '# claude\n');
  write(root, 'docs/AGENTS.md', '# agents\n');
  write(root, 'docs/GEMINI.md', '# gemini\n');
  write(root, 'docs/untracked.md', '# untracked\n');
  git(
    root, 'add',
    '.gitignore', 'docs/regular.md', 'docs/.hidden/legacy.md',
    'docs/CLAUDE.md', 'docs/AGENTS.md', 'docs/GEMINI.md',
  );
  commit(root, '2026-01-01T12:00:00', 'initial docs');
  write(root, 'src/main.js', 'function f() {}\n');
  git(root, 'add', 'src/main.js');
  commit(root, '2026-05-01T12:00:00', 'code change');
  const { code, out } = runCli(root);
  assert.equal(code, 1);
  const messages = out.findings.map((f) => f.message).join('\n');
  assert.match(messages, /docs\/regular\.md/);
  assert.doesNotMatch(messages, /docs\/\.hidden\/legacy\.md/);
  assert.doesNotMatch(messages, /docs\/CLAUDE\.md/);
  assert.doesNotMatch(messages, /docs\/AGENTS\.md/);
  assert.doesNotMatch(messages, /docs\/GEMINI\.md/);
  assert.doesNotMatch(messages, /docs\/untracked\.md/);
});

test('CLI: a stale doc under docs/superpowers/ is never reported, but a sibling doc is', () => {
  const root = makeRepo();
  write(root, 'docs/real.md', '# real\n');
  write(root, 'docs/superpowers/x.md', '# superpowers\n');
  git(root, 'add', 'docs/real.md', 'docs/superpowers/x.md');
  commit(root, '2026-01-01T12:00:00', 'initial docs');
  write(root, 'src/main.js', 'function f() {}\n');
  git(root, 'add', 'src/main.js');
  commit(root, '2026-05-01T12:00:00', 'code change');
  const { code, out } = runCli(root);
  assert.equal(code, 1);
  const messages = out.findings.map((f) => f.message).join('\n');
  assert.match(messages, /docs\/real\.md/);
  assert.doesNotMatch(messages, /docs\/superpowers\/x\.md/);
});

test('CLI: an empty repo (no commits) reports STALENESS_NOT_ASSESSED, not a crash', () => {
  const root = makeRepo();
  const { code, out } = runCli(root);
  assert.equal(code, 1);
  assert.deepEqual(out.findings.map((f) => f.code), ['STALENESS_NOT_ASSESSED']);
});

test('CLI: a non-git directory exits 2 with an error JSON payload', () => {
  const root = mktemp();
  assert.throws(
    () => runCli(root),
    (e) => {
      assert.equal(e.status, 2);
      const out = JSON.parse(e.stdout);
      assert.equal(out.status, 'error');
      return true;
    },
  );
});

test('CLI: a doc filename containing a double quote still produces valid JSON', () => {
  const root = makeRepo();
  const weirdName = 'docs/weird"name.md';
  write(root, weirdName, '# weird\n');
  git(root, 'add', weirdName);
  commit(root, '2026-01-01T12:00:00', 'initial docs');
  write(root, 'src/main.js', 'function f() {}\n');
  git(root, 'add', 'src/main.js');
  commit(root, '2026-05-01T12:00:00', 'code change');
  const { code, out } = runCli(root);
  assert.equal(code, 1);
  assert.ok(out.findings.some((f) => f.message.includes(weirdName)));
});

test('CLI: invocable via a script path containing a space', () => {
  const spaceParent = mktemp();
  const targetDir = join(spaceParent, 'sp ace');
  mkdirSync(targetDir, { recursive: true });
  cpSync(SCRIPT, join(targetDir, 'check-staleness.mjs'));
  cpSync(join(SCRIPTS_DIR, 'is-main.mjs'), join(targetDir, 'is-main.mjs'));
  cpSync(join(SCRIPTS_DIR, 'vendor'), join(targetDir, 'vendor'), { recursive: true });
  cpSync(join(SCRIPTS_DIR, 'formats'), join(targetDir, 'formats'), { recursive: true });

  const root = makeRepo();
  write(root, 'README.md', '# old\n');
  git(root, 'add', 'README.md');
  commit(root, '2026-01-01T12:00:00', 'initial');
  write(root, 'src/main.js', 'function f() {}\n');
  git(root, 'add', 'src/main.js');
  commit(root, '2026-05-01T12:00:00', 'code change');

  const { code, out } = runScriptAt(join(targetDir, 'check-staleness.mjs'), root);
  assert.equal(code, 1);
  assert.deepEqual(out.findings.map((f) => f.code), ['STALE_README']);
});

test('CLI: invocable through a symlinked directory', () => {
  const parent = mktemp();
  const linkDir = join(parent, 'link');
  symlinkSync(SCRIPTS_DIR, linkDir, 'dir');

  const root = makeRepo();
  write(root, 'README.md', '# old\n');
  git(root, 'add', 'README.md');
  commit(root, '2026-01-01T12:00:00', 'initial');
  write(root, 'src/main.js', 'function f() {}\n');
  git(root, 'add', 'src/main.js');
  commit(root, '2026-05-01T12:00:00', 'code change');

  const { code, out } = runScriptAt(join(linkDir, 'check-staleness.mjs'), root);
  assert.equal(code, 1);
  assert.deepEqual(out.findings.map((f) => f.code), ['STALE_README']);
});

// --- Ancestry-based staleness (Task 5) ---

test('CLI: README and source committed in the same second, README first, is STALE_README (timestamp tie must not hide it)', () => {
  const root = makeRepo();
  write(root, 'README.md', '# doc\n');
  git(root, 'add', 'README.md');
  commit(root, '2026-05-01T12:00:00', 'add readme');
  write(root, 'src/main.js', 'function f() {}\n');
  git(root, 'add', 'src/main.js');
  commit(root, '2026-05-01T12:00:00', 'code change');
  const { code, out } = runCli(root);
  assert.equal(code, 1);
  assert.deepEqual(out.findings.map((f) => f.code), ['STALE_README']);
});

test('CLI: clock-skewed committer dates (source commit dated earlier than README, but later in history) still trigger STALE_README', () => {
  const root = makeRepo();
  write(root, 'README.md', '# doc\n');
  git(root, 'add', 'README.md');
  commit(root, '2026-06-01T12:00:00', 'add readme');
  write(root, 'src/main.js', 'function f() {}\n');
  git(root, 'add', 'src/main.js');
  // Dated *before* README's commit despite coming after it in the DAG —
  // a timestamp comparison would wrongly call this "not stale".
  commit(root, '2026-01-01T12:00:00', 'code change');
  const { code, out } = runCli(root);
  assert.equal(code, 1);
  assert.deepEqual(out.findings.map((f) => f.code), ['STALE_README']);
});

test('CLI: a commit that touches both a doc under docs/ and source in one commit is not stale', () => {
  const root = makeRepo();
  write(root, 'README.md', '# doc\n');
  write(root, 'docs/notes.md', '# notes\n');
  write(root, 'src/main.js', 'function f() {}\n');
  git(root, 'add', 'README.md', 'docs/notes.md', 'src/main.js');
  commit(root, '2026-05-01T12:00:00', 'init');
  const { code, out } = runCli(root);
  assert.equal(code, 0);
  assert.equal(out.status, 'ok');
});

test('CLI: a doc updated on a branch merged in after the source change is not stale', () => {
  const root = makeRepo();
  write(root, 'README.md', '# doc\n');
  write(root, 'src/main.js', 'v1\n');
  git(root, 'add', 'README.md', 'src/main.js');
  commit(root, '2026-01-01T12:00:00', 'initial');

  git(root, 'checkout', '-q', '-b', 'docbranch');
  write(root, 'docs/notes.md', '# notes\n');
  git(root, 'add', 'docs/notes.md');
  commit(root, '2026-02-01T12:00:00', 'add notes on branch');

  git(root, 'checkout', '-q', 'main');
  write(root, 'src/main.js', 'v2\n');
  git(root, 'add', 'src/main.js');
  commit(root, '2026-03-01T12:00:00', 'source change on main');

  git(root, 'merge', '-q', '--no-ff', 'docbranch', '-m', 'merge docbranch');

  const { code, out } = runCli(root);
  // README (last touched at the initial commit, an ancestor of the later
  // source change) is expected to be stale; docs/notes.md must not be.
  assert.equal(code, 1);
  const messages = out.findings.map((f) => f.message).join('\n');
  assert.doesNotMatch(messages, /docs\/notes\.md/);
});

test('CLI: a symlinked doc reports STALE_DOC exactly once, at the canonical (target) path', () => {
  const root = makeRepo();
  write(root, 'README.md', '# doc\n');
  write(root, 'docs/target.md', '# target\n');
  git(root, 'add', 'README.md', 'docs/target.md');
  commit(root, '2026-01-01T12:00:00', 'add docs');
  symlinkSync('target.md', join(root, 'docs', 'alias.md'));
  git(root, 'add', 'docs/alias.md');
  commit(root, '2026-01-01T12:30:00', 'add alias symlink');
  write(root, 'src/main.js', 'function f() {}\n');
  git(root, 'add', 'src/main.js');
  commit(root, '2026-05-01T12:00:00', 'code change');
  const { code, out } = runCli(root);
  assert.equal(code, 1);
  const staleDocs = out.findings.filter((f) => f.code === 'STALE_DOC');
  assert.equal(staleDocs.length, 1);
  assert.match(staleDocs[0].message, /docs\/target\.md/);
  assert.doesNotMatch(staleDocs[0].message, /docs\/alias\.md/);
});

test('CLI: a stale ADR under docs/dev/adr/ or docs/adr/ is never reported, but a sibling doc is', () => {
  const root = makeRepo();
  write(root, 'docs/dev/adr/0001-decision.md', '# decision\n');
  write(root, 'docs/adr/0002-legacy-decision.md', '# legacy decision\n');
  write(root, 'docs/dev/other.md', '# other\n');
  git(root, 'add', 'docs/dev/adr/0001-decision.md', 'docs/adr/0002-legacy-decision.md', 'docs/dev/other.md');
  commit(root, '2026-01-01T12:00:00', 'initial docs');
  write(root, 'src/main.js', 'function f() {}\n');
  git(root, 'add', 'src/main.js');
  commit(root, '2026-05-01T12:00:00', 'code change');
  const { code, out } = runCli(root);
  assert.equal(code, 1);
  const messages = out.findings.map((f) => f.message).join('\n');
  assert.doesNotMatch(messages, /docs\/dev\/adr\//);
  assert.doesNotMatch(messages, /docs\/adr\//);
  assert.match(messages, /docs\/dev\/other\.md/);
});

// --- Finding detail (R3) ---

test('CLI: STALE_README carries file, sourceCommit, sourcePath, and a commitsSince > 1, all reflected in the message', () => {
  const root = makeRepo();
  write(root, 'README.md', '# doc\n');
  git(root, 'add', 'README.md');
  commit(root, '2026-01-01T12:00:00', 'add readme');
  write(root, 'src/a.js', 'v1\n');
  git(root, 'add', 'src/a.js');
  commit(root, '2026-02-01T12:00:00', 'first source change');
  write(root, 'src/b.js', 'v1\n');
  git(root, 'add', 'src/b.js');
  commit(root, '2026-03-01T12:00:00', 'second source change');
  const { code, out } = runCli(root);
  assert.equal(code, 1);
  const finding = out.findings.find((f) => f.code === 'STALE_README');
  assert.ok(finding, 'expected a STALE_README finding');
  assert.equal(finding.file, 'README.md');
  assert.match(finding.sourceCommit, /^[0-9a-f]{4,}$/);
  assert.equal(finding.sourcePath, 'src/b.js');
  assert.equal(finding.commitsSince, 2);
  assert.match(finding.message, /README\.md/);
  assert.match(finding.message, /src\/b\.js/);
  assert.match(finding.message, new RegExp(finding.sourceCommit));
  assert.match(finding.message, /2 commits/);
});

test('CLI: STALE_DOC carries file, sourceCommit, sourcePath, and commitsSince, and a doc path with a space and a non-ASCII character still yields valid JSON', () => {
  const root = makeRepo();
  const docPath = 'docs/café notes.md';
  write(root, docPath, '# notes\n');
  git(root, 'add', docPath);
  commit(root, '2026-01-01T12:00:00', 'add docs');
  write(root, 'src/main.js', 'function f() {}\n');
  git(root, 'add', 'src/main.js');
  commit(root, '2026-05-01T12:00:00', 'code change');
  const { code, out } = runCli(root);
  assert.equal(code, 1);
  const finding = out.findings.find((f) => f.code === 'STALE_DOC');
  assert.ok(finding, 'expected a STALE_DOC finding');
  assert.equal(finding.file, docPath);
  assert.equal(finding.sourcePath, 'src/main.js');
  assert.match(finding.sourceCommit, /^[0-9a-f]{4,}$/);
  assert.equal(finding.commitsSince, 1);
  assert.match(finding.message, /café notes\.md/);
  assert.match(finding.message, /src\/main\.js/);
  assert.match(finding.message, /1 commit\b/);
});

test('entry guard: importing the module with a nonexistent argv[1] does not crash (realpathSync would throw ENOENT)', () => {
  const nonexistentArgv1 = join(mktemp(), 'nonexistent-argv1');
  const specifier = JSON.stringify(pathToFileURL(SCRIPT).href);
  const out = execFileSync('node', ['-e', `import(${specifier})`, nonexistentArgv1], { encoding: 'utf8' });
  assert.equal(out, '');
});

test('CLI: a stale README.markdown triggers STALE_README naming that file', () => {
  const root = makeRepo();
  write(root, 'README.markdown', '# old\n');
  git(root, 'add', 'README.markdown');
  commit(root, '2026-01-01T12:00:00', 'initial docs');
  write(root, 'src/main.js', 'function f() {}\n');
  git(root, 'add', 'src/main.js');
  commit(root, '2026-05-01T12:00:00', 'code change');
  const { code, out } = runCli(root);
  assert.equal(code, 1);
  assert.deepEqual(out.findings.map((f) => [f.code, f.file]), [['STALE_README', 'README.markdown']]);
});

test('CLI: a stale docs/guide.markdown triggers STALE_DOC; docs/notes.txt is not a doc', () => {
  const root = makeRepo();
  write(root, 'README.md', '# readme\n');
  write(root, 'docs/guide.markdown', '# guide\n');
  write(root, 'docs/notes.txt', 'notes\n');
  git(root, 'add', 'README.md', 'docs/guide.markdown', 'docs/notes.txt');
  commit(root, '2026-01-01T12:00:00', 'initial docs');
  write(root, 'src/main.js', 'function f() {}\n');
  write(root, 'README.md', '# readme, refreshed\n');
  git(root, 'add', 'src/main.js', 'README.md');
  commit(root, '2026-05-01T12:00:00', 'code change');
  const { code, out } = runCli(root);
  assert.equal(code, 1);
  assert.deepEqual(out.findings.map((f) => [f.code, f.file]), [['STALE_DOC', 'docs/guide.markdown']]);
});

test('CLI: a stale README.adoc and docs/guide.adoc are reported', () => {
  const root = makeRepo();
  write(root, 'README.adoc', '= old\n');
  write(root, 'docs/guide.adoc', '= guide\n');
  git(root, 'add', 'README.adoc', 'docs/guide.adoc');
  commit(root, '2026-01-01T12:00:00', 'initial docs');
  write(root, 'src/main.js', 'function f() {}\n');
  git(root, 'add', 'src/main.js');
  commit(root, '2026-05-01T12:00:00', 'code change');
  const { code, out } = runCli(root);
  assert.equal(code, 1);
  assert.deepEqual(out.findings.map((f) => [f.code, f.file]), [['STALE_README', 'README.adoc'], ['STALE_DOC', 'docs/guide.adoc']]);
});
