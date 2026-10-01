import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, realpathSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const tmpDirs = [];
after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

const SCRIPT = fileURLToPath(new URL('../../../module/skills/docs-organization/scripts/md-files.mjs', import.meta.url));

function cli(cwd, ...args) {
  try {
    return { code: 0, out: JSON.parse(execFileSync('node', [SCRIPT, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) };
  } catch (e) {
    return { code: e.status, stderr: e.stderr };
  }
}

// dir/
//   .issue-draft/ISSUE.md, .issue-draft/notes.txt, .issue-draft/.cache/x.md
//   CLAUDE.md
function tree() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'md-files-')));
  tmpDirs.push(dir);
  mkdirSync(join(dir, '.issue-draft', '.cache'), { recursive: true });
  writeFileSync(join(dir, '.issue-draft', 'ISSUE.md'), '# i\n');
  writeFileSync(join(dir, '.issue-draft', 'notes.txt'), 'n\n');
  writeFileSync(join(dir, '.issue-draft', '.cache', 'x.md'), '# x\n');
  writeFileSync(join(dir, 'CLAUDE.md'), '# c\n');
  return dir;
}

test('CLI: a dot-directory given as the root is walked; nested dot-dirs are not', () => {
  const dir = tree();
  assert.deepEqual(cli(dir, '.issue-draft'), { code: 0, out: [join('.issue-draft', 'ISSUE.md')] });
});

test('CLI: an explicit markdown file is listed even when it is an LLM-config file', () => {
  const dir = tree();
  assert.deepEqual(cli(dir, 'CLAUDE.md'), { code: 0, out: ['CLAUDE.md'] });
});

test('CLI: an explicit non-markdown file yields nothing', () => {
  const dir = tree();
  assert.deepEqual(cli(dir, join('.issue-draft', 'notes.txt')), { code: 0, out: [] });
});

test('CLI: results follow argument order', () => {
  const dir = tree();
  assert.deepEqual(cli(dir, 'CLAUDE.md', '.issue-draft').out, ['CLAUDE.md', join('.issue-draft', 'ISSUE.md')]);
});

test('CLI: a missing path exits 2', () => {
  const dir = tree();
  const r = cli(dir, 'nope.md');
  assert.equal(r.code, 2);
  assert.match(r.stderr, /ENOENT/);
});

test('CLI: no arguments exits 2 with usage', () => {
  const r = cli(tree());
  assert.equal(r.code, 2);
  assert.match(r.stderr, /usage:/);
});

// --- entry guard: the script must run as the main module from any install
// path, not just one with no spaces and no symlinks in it. ---

const SCRIPTS_DIR = fileURLToPath(new URL('../../../module/skills/docs-organization/scripts', import.meta.url));

// Copies the whole (runtime-only) scripts directory rather than a
// hand-picked file list, so a script gaining a new sibling import can't
// silently break this test.
function copyScriptsDirTo(destDir) {
  cpSync(SCRIPTS_DIR, destDir, { recursive: true });
}

function runScriptAt(scriptPath, cwd, args, nodeFlags = []) {
  try {
    return { code: 0, out: JSON.parse(execFileSync('node', [...nodeFlags, scriptPath, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) };
  } catch (e) {
    return { code: e.status, stderr: e.stderr };
  }
}

test('CLI: invocable via a script path containing a space', () => {
  const spaceParent = tree();
  const targetDir = join(spaceParent, 'sp ace');
  copyScriptsDirTo(targetDir);

  const { code, out } = runScriptAt(join(targetDir, 'md-files.mjs'), tree(), ['.issue-draft']);
  assert.equal(code, 0);
  assert.deepEqual(out, [join('.issue-draft', 'ISSUE.md')]);
});

test('CLI: invocable through a symlinked directory', () => {
  const parent = tree();
  const linkDir = join(parent, 'link');
  symlinkSync(SCRIPTS_DIR, linkDir, 'dir');

  const { code, out } = runScriptAt(join(linkDir, 'md-files.mjs'), tree(), ['.issue-draft']);
  assert.equal(code, 0);
  assert.deepEqual(out, [join('.issue-draft', 'ISSUE.md')]);
});

// node --preserve-symlinks-main leaves import.meta.url as the symlink path
// instead of resolving it — the mirror image of the plain symlinked-directory
// case above. A guard that only resolves one side of the comparison passes
// one of these two cases and silently fails the other.
test('CLI: invocable through a symlinked directory under node --preserve-symlinks-main', () => {
  const parent = tree();
  const linkDir = join(parent, 'link');
  symlinkSync(SCRIPTS_DIR, linkDir, 'dir');

  const { code, out } = runScriptAt(join(linkDir, 'md-files.mjs'), tree(), ['.issue-draft'], ['--preserve-symlinks-main']);
  assert.equal(code, 0);
  assert.deepEqual(out, [join('.issue-draft', 'ISSUE.md')]);
});
