import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isMain } from '../../../module/skills/docs-organization/scripts/is-main.mjs';

// process.argv[1] is read internally by isMain(); each test swaps it in and
// restores it so tests don't leak state into each other.
function withArgv1(value, fn) {
  const original = process.argv[1];
  process.argv[1] = value;
  try {
    fn();
  } finally {
    process.argv[1] = original;
  }
}

test('isMain: true when import.meta.url is the file:// URL of argv[1]', () => {
  const dir = mkdtempSync(join(tmpdir(), 'is-main-'));
  const file = join(dir, 'entry.mjs');
  writeFileSync(file, '');
  try {
    withArgv1(file, () => {
      assert.equal(isMain(pathToFileURL(file).href), true);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isMain: true when argv[1] contains a space (realpath resolution, not string compare)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'is-main-'));
  const spaceFile = join(dir, 'sp ace.mjs');
  writeFileSync(spaceFile, '');
  try {
    withArgv1(spaceFile, () => {
      assert.equal(isMain(pathToFileURL(spaceFile).href), true);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isMain: false when argv[1] is a different file than import.meta.url', () => {
  const dir = mkdtempSync(join(tmpdir(), 'is-main-'));
  const file = join(dir, 'entry.mjs');
  const other = join(dir, 'other.mjs');
  writeFileSync(file, '');
  writeFileSync(other, '');
  try {
    withArgv1(other, () => {
      assert.equal(isMain(pathToFileURL(file).href), false);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isMain: false when process.argv[1] is unset', () => {
  withArgv1(undefined, () => {
    assert.equal(isMain('file:///anything'), false);
  });
});

test('isMain: false, not throwing, when argv[1] does not exist on disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'is-main-'));
  const missing = join(dir, 'nonexistent.mjs');
  try {
    withArgv1(missing, () => {
      assert.doesNotThrow(() => isMain(pathToFileURL(missing).href));
      assert.equal(isMain(pathToFileURL(missing).href), false);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isMain: true when argv[1] is reached through a symlinked directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'is-main-'));
  const realFile = join(dir, 'entry.mjs');
  writeFileSync(realFile, '');
  const linkDir = join(dir, 'link');
  symlinkSync(dir, linkDir, 'dir');
  const linkedFile = join(linkDir, 'entry.mjs');
  try {
    withArgv1(linkedFile, () => {
      // import.meta.url for a module loaded through the symlink resolves to
      // the realpath — the same URL isMain() computes from argv[1]'s realpath.
      assert.equal(isMain(pathToFileURL(realFile).href), true);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
