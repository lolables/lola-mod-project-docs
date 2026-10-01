import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, symlinkSync, cpSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyPalette, initHeader, classDefs } from '../../../module/skills/docs-organization/scripts/apply-palette.mjs';
import { contrastRatio } from '../../../module/skills/docs-organization/scripts/contrast.mjs';

const SCRIPTS_DIR = fileURLToPath(new URL('../../../module/skills/docs-organization/scripts', import.meta.url));
const palettesDir = join(SCRIPTS_DIR, '..', 'reference', 'palettes');
const palettes = readdirSync(palettesDir)
  .filter(f => f.endsWith('.json'))
  .map(f => ({ name: f.replace(/\.json$/, ''), data: JSON.parse(readFileSync(join(palettesDir, f), 'utf8')) }));

// Every temp dir the entry-guard tests below create is tracked here and
// removed once, after the whole file runs (matches check-staleness.test.mjs).
const tmpDirs = [];
after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function mktemp(prefix = 'apply-palette-') {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tmpDirs.push(d);
  return d;
}

const LIGHT = '#ffffff';
const DARK = '#1e1e1e';

test('all four palette JSONs load and parse', () => {
  assert.equal(palettes.length, 4);
  const names = palettes.map(p => p.name).sort();
  assert.deepEqual(names, ['citrus', 'federation', 'parchment', 'solar']);
});

for (const { name, data: palette } of palettes) {
  test(`palette ${name}: node fills clear AA against node text`, () => {
    for (const [classname, def] of Object.entries(palette.nodes)) {
      const ratio = contrastRatio(def.fill, def.text);
      assert.ok(ratio >= 4.5, `${classname} text vs fill = ${ratio.toFixed(2)}:1, need ≥ 4.5:1`);
    }
  });

  const mode = palette.mode || 'both';
  if (mode === 'both' || mode === 'light') {
    test(`palette ${name}: node fills clear 3:1 vs light bg`, () => {
      for (const [classname, def] of Object.entries(palette.nodes)) {
        const ratio = contrastRatio(def.fill, LIGHT);
        assert.ok(ratio >= 3.0, `${classname} fill vs light bg = ${ratio.toFixed(2)}:1, need ≥ 3:1`);
      }
    });
  }
  if (mode === 'both' || mode === 'dark') {
    test(`palette ${name}: node fills clear 3:1 vs dark bg`, () => {
      for (const [classname, def] of Object.entries(palette.nodes)) {
        const ratio = contrastRatio(def.fill, DARK);
        assert.ok(ratio >= 3.0, `${classname} fill vs dark bg = ${ratio.toFixed(2)}:1, need ≥ 3:1`);
      }
    });
  }

  test(`palette ${name}: edge label text clears AA vs edge label bg`, () => {
    const ratio = contrastRatio(palette.edgeLabel.bg, palette.edgeLabel.text);
    assert.ok(ratio >= 4.5, `edge label = ${ratio.toFixed(2)}:1`);
  });

  test(`palette ${name}: initHeader emits required theme variables and themeCSS`, () => {
    const header = initHeader(palette);
    assert.match(header, /'primaryColor':/);
    assert.match(header, /'clusterBkg':/);
    assert.match(header, /'edgeLabelBackground':/);
    assert.match(header, /'themeCSS':/);
    assert.match(header, /\.node \.nodeLabel\{color:#ffffff!important;fill:#ffffff!important;\}/);
  });
}

test('classDefs emits nothing when body references no palette names', () => {
  const palette = palettes[0].data;
  const body = 'sequenceDiagram\n  A->>B: hi';
  assert.equal(classDefs(palette, body), '');
});

test('classDefs emits only referenced names', () => {
  const palette = palettes.find(p => p.name === 'solar').data;
  const body = 'flowchart LR\n  A --> B\n  class A,B sysA';
  const defs = classDefs(palette, body);
  assert.match(defs, /classDef sysA fill:#2f6dab/);
  assert.doesNotMatch(defs, /classDef sysB/);
});

test('applyPalette wraps body with header and (when needed) classDefs', () => {
  const palette = palettes.find(p => p.name === 'solar').data;
  const body = 'flowchart LR\n  A --> B\n  class A sysA';
  const out = applyPalette(palette, body);
  assert.match(out, /^%%\{init:/);
  assert.match(out, /flowchart LR/);
  assert.match(out, /classDef sysA/);
});

// --- entry guard: the script must run as the main module from any install
// path, not just one with no spaces and no symlinks in it. ---

// Copies the whole (runtime-only) scripts directory rather than a
// hand-picked file list, so a script gaining a new sibling import can't
// silently break this test.
function copyScriptsDirTo(destDir) {
  cpSync(SCRIPTS_DIR, destDir, { recursive: true });
}

function makeInputs(dir) {
  const paletteFile = join(dir, 'solar.json');
  const bodyFile = join(dir, 'body.mmd');
  writeFileSync(paletteFile, JSON.stringify(palettes.find(p => p.name === 'solar').data));
  writeFileSync(bodyFile, 'flowchart LR\n  A --> B\n  class A sysA\n');
  return { paletteFile, bodyFile };
}

test('CLI: invocable via a script path containing a space', () => {
  const spaceParent = mktemp();
  const targetDir = join(spaceParent, 'sp ace');
  copyScriptsDirTo(targetDir);
  const { paletteFile, bodyFile } = makeInputs(spaceParent);

  const out = execFileSync('node', [join(targetDir, 'apply-palette.mjs'), paletteFile, bodyFile], { encoding: 'utf8' });
  assert.match(out, /^%%\{init:/);
  assert.match(out, /classDef sysA/);
});

test('CLI: invocable through a symlinked directory', () => {
  const parent = mktemp();
  const linkDir = join(parent, 'link');
  symlinkSync(SCRIPTS_DIR, linkDir, 'dir');
  const { paletteFile, bodyFile } = makeInputs(parent);

  const out = execFileSync('node', [join(linkDir, 'apply-palette.mjs'), paletteFile, bodyFile], { encoding: 'utf8' });
  assert.match(out, /^%%\{init:/);
  assert.match(out, /classDef sysA/);
});
