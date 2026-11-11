import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// process.exit() right after a stdout write cuts the output at the 64 KB pipe
// buffer; scripts must set process.exitCode and return instead.
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SCRIPTS = join(ROOT, 'module/skills/docs-organization/scripts');
const PIPE_BUFFER = 65536;

const tmpDirs = [];
after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function sourceFiles() {
  return [SCRIPTS, join(SCRIPTS, 'formats')].flatMap((dir) =>
    readdirSync(dir).filter((n) => n.endsWith('.mjs')).map((n) => join(dir, n)));
}

test('no script calls process.exit() outside a comment', () => {
  const offenders = [];
  for (const file of sourceFiles()) {
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (line.replace(/\/\/.*$/, '').includes('process.exit(')) {
        offenders.push(`${relative(ROOT, file)}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(offenders, [], `use process.exitCode, not process.exit():\n${offenders.join('\n')}`);
});

test('check-prose delivers JSON larger than the pipe buffer intact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'no-exit-'));
  tmpDirs.push(dir);
  const paragraph = Array.from({ length: 150 }, (_, i) => `word${i}`).join(' ');
  const doc = '# Title\n\n' + Array.from({ length: 600 }, () => paragraph).join('\n\n') + '\n';
  const file = join(dir, 'big.md');
  writeFileSync(file, doc);
  const r = spawnSync(process.execPath, [join(SCRIPTS, 'check-prose.mjs'), file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(r.status, 1, r.stderr);
  assert.ok(r.stdout.length > PIPE_BUFFER, `stdout was only ${r.stdout.length} bytes`);
  const payload = JSON.parse(r.stdout);
  assert.equal(payload.status, 'findings');
  assert.equal(payload.findings.filter((f) => f.code === 'WALL_OF_TEXT').length, 600);
});
