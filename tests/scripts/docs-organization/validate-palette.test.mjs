import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, symlinkSync, cpSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from '../../../module/skills/docs-organization/scripts/validate-palette.mjs';

// Every temp dir the entry-guard tests below create is tracked here and
// removed once, after the whole file runs (matches check-staleness.test.mjs).
const tmpDirs = [];
after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function mktemp(prefix = 'validate-palette-') {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tmpDirs.push(d);
  return d;
}

const SOLAR = {
  name: 'Solar',
  nodes: {
    sysA: { fill: '#2f6dab', text: '#ffffff' },
    sysB: { fill: '#1d7848', text: '#ffffff' },
    sysC: { fill: '#7457b8', text: '#ffffff' },
    sysD: { fill: '#2d747e', text: '#ffffff' },
    sysE: { fill: '#4d68c4', text: '#ffffff' },
    sysF: { fill: '#5c6a82', text: '#ffffff' },
  },
  cluster: { fill: 'transparent', title: '#7c8ba1', border: '#7c8ba1' },
  canvasText: '#7c8ba1',
  edgeLabel: { bg: '#eef2f8', text: '#1e1e1e' },
};

test('validate: a well-formed cross-bg palette passes every check', () => {
  const results = validate(SOLAR);
  const fails = results.filter((r) => !r.pass);
  assert.equal(fails.length, 0, `unexpected failures: ${fails.map((f) => f.label).join(', ')}`);
});

test('validate: low-contrast node text vs fill fails the AA check', () => {
  const broken = structuredClone(SOLAR);
  broken.nodes.sysA = { fill: '#444444', text: '#222222' };  // ~1.2:1
  const fails = validate(broken).filter((r) => !r.pass);
  assert.ok(fails.some((f) => f.label === 'node.sysA text vs fill'));
});

test('validate: too-dark fill fails the dark-bg graphical check', () => {
  const broken = structuredClone(SOLAR);
  broken.nodes.sysA = { fill: '#1a1a1a', text: '#ffffff' };  // ~1:1 vs dark bg
  const fails = validate(broken).filter((r) => !r.pass);
  assert.ok(fails.some((f) => f.label === 'node.sysA fill vs dark bg'));
});

test('validate: mode=light skips the dark-bg checks', () => {
  const lightOnly = structuredClone(SOLAR);
  lightOnly.mode = 'light';
  // Use a fill that would fail vs dark bg but works vs light.
  lightOnly.nodes.sysA = { fill: '#1a1a1a', text: '#ffffff' };
  const fails = validate(lightOnly).filter((r) => !r.pass);
  assert.ok(!fails.some((f) => f.label.includes('vs dark bg')),
    'dark-bg checks should be skipped under mode=light');
});

test('validate: filled cluster runs the title-vs-fill contrast check', () => {
  const filled = structuredClone(SOLAR);
  filled.cluster = { fill: '#ebe7df', title: '#3a342c', border: '#8d8475' };
  const results = validate(filled);
  assert.ok(results.some((r) => r.label === 'cluster title vs cluster fill'),
    'expected filled-cluster contrast check');
  // And the fill-vs-node-fill differentiation checks
  assert.ok(results.some((r) => r.label === 'cluster fill vs node.sysA fill'),
    'expected cluster-vs-node differentiation check');
});

test('validate: transparent cluster runs title-vs-bg checks instead', () => {
  const results = validate(SOLAR);
  assert.ok(results.some((r) => r.label === 'cluster title vs light bg'));
  assert.ok(results.some((r) => r.label === 'cluster title vs dark bg'));
});

test('validate: edge label contrast is enforced at AA', () => {
  const broken = structuredClone(SOLAR);
  broken.edgeLabel = { bg: '#eef2f8', text: '#bbbbbb' };  // pale gray on near-white
  const fails = validate(broken).filter((r) => !r.pass);
  assert.ok(fails.some((f) => f.label === 'edge label text vs edge label bg'));
});

// --- entry guard: the script must run as the main module from any install
// path, not just one with no spaces and no symlinks in it. ---

const SCRIPTS_DIR = fileURLToPath(new URL('../../../module/skills/docs-organization/scripts', import.meta.url));

// A palette that fails a check (low-contrast node text vs fill), so the CLI's
// exit code and non-empty FAIL output actually prove the run happened.
const BROKEN_SOLAR = structuredClone(SOLAR);
BROKEN_SOLAR.name = 'Broken Solar';
BROKEN_SOLAR.nodes.sysA = { fill: '#444444', text: '#222222' };

// Copies the whole (runtime-only) scripts directory rather than a
// hand-picked file list, so a script gaining a new sibling import can't
// silently break this test.
function copyScriptsDirTo(destDir) {
  cpSync(SCRIPTS_DIR, destDir, { recursive: true });
}

function runScript(scriptPath, paletteFile) {
  try {
    return { code: 0, out: execFileSync('node', [scriptPath, paletteFile], { encoding: 'utf8' }) };
  } catch (e) {
    if (e.status === 1) return { code: 1, out: e.stdout };
    throw e;
  }
}

test('CLI: invocable via a script path containing a space', () => {
  const spaceParent = mktemp();
  const targetDir = join(spaceParent, 'sp ace');
  copyScriptsDirTo(targetDir);
  const paletteFile = join(spaceParent, 'broken.json');
  writeFileSync(paletteFile, JSON.stringify(BROKEN_SOLAR));

  const { code, out } = runScript(join(targetDir, 'validate-palette.mjs'), paletteFile);
  assert.equal(code, 1);
  assert.match(out, /\[FAIL\]/);
});

test('CLI: invocable through a symlinked directory', () => {
  const parent = mktemp();
  const linkDir = join(parent, 'link');
  symlinkSync(SCRIPTS_DIR, linkDir, 'dir');
  const paletteFile = join(parent, 'broken.json');
  writeFileSync(paletteFile, JSON.stringify(BROKEN_SOLAR));

  const { code, out } = runScript(join(linkDir, 'validate-palette.mjs'), paletteFile);
  assert.equal(code, 1);
  assert.match(out, /\[FAIL\]/);
});
