import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, symlinkSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintDiagram, extractMermaidBlocks, walk } from '../../../module/skills/docs-organization/scripts/lint-mermaid.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = fileURLToPath(new URL('../../../module/skills/docs-organization/scripts', import.meta.url));
const fixture = (name) =>
  readFileSync(join(here, '__fixtures__', name), 'utf8');

test('lintDiagram: good.mmd has no findings', async () => {
  const findings = await lintDiagram(fixture('good.mmd'));
  assert.deepEqual(findings, []);
});

test('lintDiagram: missing-header.mmd flags MISSING_HOUSE_STYLE_HEADER', async () => {
  const findings = await lintDiagram(fixture('missing-header.mmd'));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, 'MISSING_HOUSE_STYLE_HEADER');
});

test('lintDiagram: legacy-header.mmd flags LEGACY_HOUSE_STYLE_HEADER warning', async () => {
  const findings = await lintDiagram(fixture('legacy-header.mmd'));
  const legacy = findings.find((f) => f.code === 'LEGACY_HOUSE_STYLE_HEADER');
  assert.ok(legacy, 'expected LEGACY_HOUSE_STYLE_HEADER finding');
  assert.equal(legacy.severity, 'warning');
  assert.match(legacy.message, /clusterBkg/);
  assert.match(legacy.message, /primaryTextColor/);
});

// The syntax fixtures below carry a legacy header, so a LEGACY_HOUSE_STYLE_HEADER
// warning rides along now that a syntax error no longer hides the text-level
// checks. What they lock is that SYNTAX_ERROR is the one blocker.
const onlyBlocker = (findings) => findings.filter((f) => f.severity === 'blocker');

test('lintDiagram: bad-syntax.mmd flags SYNTAX_ERROR as its only blocker', async () => {
  const blockers = onlyBlocker(await lintDiagram(fixture('bad-syntax.mmd')));
  assert.deepEqual(blockers.map((f) => f.code), ['SYNTAX_ERROR']);
});

test('lintDiagram: inline-class.mmd flags INLINE_CLASS_NOT_SUPPORTED with fix suggestion', async () => {
  const findings = await lintDiagram(fixture('inline-class.mmd'));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, 'INLINE_CLASS_NOT_SUPPORTED');
  assert.equal(findings[0].severity, 'blocker');
  assert.match(findings[0].message, /class web sysA/);
  assert.equal(findings[0].line, 14);
});

// --- merval syntax constraints ---
// These fixtures lock the rules in reference/mermaid-house-style.md
// ("Syntax constraints") to enforced behavior. If merval bumps its grammar
// and one of these constraints disappears or changes, the test fails
// loudly instead of letting the documentation drift silently.

test('lintDiagram: unquoted-colon.mmd flags SYNTAX_ERROR (colons in [] need quoting)', async () => {
  const blockers = onlyBlocker(await lintDiagram(fixture('unquoted-colon.mmd')));
  assert.deepEqual(blockers.map((f) => f.code), ['SYNTAX_ERROR']);
});

test('lintDiagram: unquoted-comma.mmd flags SYNTAX_ERROR (commas in {} need quoting)', async () => {
  const blockers = onlyBlocker(await lintDiagram(fixture('unquoted-comma.mmd')));
  assert.deepEqual(blockers.map((f) => f.code), ['SYNTAX_ERROR']);
});

test('lintDiagram: stadium-shape.mmd flags SYNTAX_ERROR (([text]) shape unsupported)', async () => {
  const blockers = onlyBlocker(await lintDiagram(fixture('stadium-shape.mmd')));
  assert.deepEqual(blockers.map((f) => f.code), ['SYNTAX_ERROR']);
  assert.match(blockers[0].message, /merval does not support the stadium shape/);
});

test('lintDiagram: quoted-punctuation.mmd passes (quoted : , ( ) are accepted)', async () => {
  const findings = await lintDiagram(fixture('quoted-punctuation.mmd'));
  assert.deepEqual(findings, []);
});

test('lintDiagram: permissive-syntax.mmd passes (/, ?, <br/> work unquoted)', async () => {
  const findings = await lintDiagram(fixture('permissive-syntax.mmd'));
  assert.deepEqual(findings, []);
});

test('lintDiagram: extracts classDef entries from good.mmd', async () => {
  // Internal sanity check: the parser should see the sysA classDef.
  // We verify indirectly via a Task 5 test, but this test confirms
  // the diagram parses cleanly with no spurious findings.
  const findings = await lintDiagram(fixture('good.mmd'));
  assert.equal(findings.length, 0);
});

test('lintDiagram: low-contrast.mmd flags LOW_CONTRAST_TEXT and LOW_CONTRAST_DARK_BG', async () => {
  const findings = await lintDiagram(fixture('low-contrast.mmd'));
  const codes = findings.map((f) => f.code);
  assert.ok(codes.includes('LOW_CONTRAST_TEXT'),
    `expected LOW_CONTRAST_TEXT in ${codes.join(',')}`);
  assert.ok(codes.includes('LOW_CONTRAST_DARK_BG'),
    `expected LOW_CONTRAST_DARK_BG in ${codes.join(',')}`);
  const textFinding = findings.find((f) => f.code === 'LOW_CONTRAST_TEXT');
  assert.equal(textFinding.severity, 'blocker');
});

test('lintDiagram: wrong-classname.mmd flags UNAPPROVED_CLASSNAME', async () => {
  const findings = await lintDiagram(fixture('wrong-classname.mmd'));
  const unapproved = findings.find((f) => f.code === 'UNAPPROVED_CLASSNAME');
  assert.ok(unapproved, 'expected UNAPPROVED_CLASSNAME finding');
  assert.equal(unapproved.severity, 'warning');
  assert.match(unapproved.message, /myCustomClass/);
});

test('lintDiagram: borderline-contrast.mmd flags LOW_CONTRAST_TEXT just below AA', async () => {
  // Fixture uses fill #7a7a7a with white text.
  // text vs fill: 4.29:1, just below the AA threshold of 4.5 — fails.
  // fill vs light bg: 4.29:1, above the 3.0 threshold — passes.
  // fill vs dark bg: 3.88:1, above the 3.0 threshold — passes.
  // Only LOW_CONTRAST_TEXT should fire.
  const findings = await lintDiagram(fixture('borderline-contrast.mmd'));
  const codes = findings.map((f) => f.code);
  assert.ok(codes.includes('LOW_CONTRAST_TEXT'),
    `expected LOW_CONTRAST_TEXT (text just below AA), got ${codes.join(',')}`);
  assert.ok(!codes.includes('LOW_CONTRAST_LIGHT_BG'),
    `fill vs light bg passes 3.0; should not fire`);
  assert.ok(!codes.includes('LOW_CONTRAST_DARK_BG'),
    `fill vs dark bg passes 3.0; should not fire`);
});

// --- line numbers: every finding carries a 1-based line ---

// 1-based line of the first line in `text` containing `needle`.
const lineOf = (text, needle, from = 1) => {
  const lines = text.split('\n');
  for (let i = from - 1; i < lines.length; i++) if (lines[i].includes(needle)) return i + 1;
  throw new Error(`"${needle}" not found`);
};
const allMmdFixtures = readdirSync(join(here, '__fixtures__')).filter((f) => f.endsWith('.mmd'));

test('lintDiagram: every finding on every fixture has a 1-based integer line', async () => {
  for (const name of allMmdFixtures) {
    for (const f of await lintDiagram(fixture(name))) {
      assert.ok(Number.isInteger(f.line) && f.line >= 1, `${name} ${f.code}: line=${f.line}`);
    }
  }
});

test('lintDiagram: header findings point at the block start / init block', async () => {
  const missing = await lintDiagram(fixture('missing-header.mmd'));
  assert.equal(missing.find((f) => f.code === 'MISSING_HOUSE_STYLE_HEADER').line, 1);
  const legacy = await lintDiagram(fixture('legacy-header.mmd'));
  assert.equal(legacy.find((f) => f.code === 'LEGACY_HOUSE_STYLE_HEADER').line, 1);
});

test('lintDiagram: classDef findings point at the classDef line', async () => {
  const src = fixture('wrong-classname.mmd');
  const unapproved = (await lintDiagram(src)).find((f) => f.code === 'UNAPPROVED_CLASSNAME');
  assert.equal(unapproved.line, lineOf(src, 'classDef myCustomClass'));
  const low = fixture('low-contrast.mmd');
  for (const f of await lintDiagram(low)) {
    if (f.code.startsWith('LOW_CONTRAST')) assert.equal(f.line, lineOf(low, 'classDef sysA'), f.code);
  }
});

test('CLI: .md findings report file lines, offset past the fence and a leading blank', async () => {
  const md = fixturePath('fenced-blocks.md');
  const text = readFileSync(md, 'utf8');
  const { code, out } = runScript(scriptPath, md);
  assert.equal(code, 1);
  const got = JSON.parse(out).results.flatMap((r) =>
    r.findings.map((f) => ({ blockIndex: r.blockIndex, code: f.code, line: f.line })));
  const block1Start = lineOf(text, '```mermaid', 10) + 2; // skip the blank line
  assert.deepEqual(got, [
    { blockIndex: 0, code: 'MISSING_HOUSE_STYLE_HEADER', line: lineOf(text, 'flowchart LR') },
    { blockIndex: 1, code: 'SYNTAX_ERROR', line: lineOf(text, 'B[(store)]') },
    { blockIndex: 1, code: 'UNAPPROVED_CLASSNAME', line: lineOf(text, 'classDef myCustomClass') },
  ]);
  assert.equal(lineOf(text, '%%{init', block1Start), block1Start);
});

test('CLI: .adoc findings report file lines, offset past the delimiter and a leading blank', () => {
  const adoc = fixturePath('fenced-blocks.adoc');
  const text = readFileSync(adoc, 'utf8');
  const { code, out } = runScript(scriptPath, adoc);
  assert.equal(code, 1);
  const got = JSON.parse(out).results.flatMap((r) =>
    r.findings.map((f) => ({ block: r.block, code: f.code, line: f.line })));
  assert.deepEqual(got, [
    { block: 1, code: 'MISSING_HOUSE_STYLE_HEADER', line: lineOf(text, 'flowchart LR') },
    { block: 2, code: 'SYNTAX_ERROR', line: lineOf(text, 'B[(store)]') },
    { block: 2, code: 'UNAPPROVED_CLASSNAME', line: lineOf(text, 'classDef myCustomClass') },
  ]);
});

// --- messages cite paths that exist in an installed skill ---

test('lintDiagram: no message cites a repo-only module/ path', async () => {
  for (const name of allMmdFixtures) {
    for (const f of await lintDiagram(fixture(name))) {
      assert.doesNotMatch(f.message, /module\/skills/, `${name} ${f.code}`);
    }
  }
  const [missing] = await lintDiagram(fixture('missing-header.mmd'));
  assert.match(missing.message, /See reference\/mermaid-house-style\.md/);
});

// --- a syntax error does not hide the text-level checks ---

test('lintDiagram: SYNTAX_ERROR does not mask header, class-name, or contrast checks', async () => {
  const codes = (await lintDiagram(fixture('syntax-error-unmasked.mmd'))).map((f) => f.code);
  for (const c of ['SYNTAX_ERROR', 'MISSING_HOUSE_STYLE_HEADER', 'UNAPPROVED_CLASSNAME', 'LOW_CONTRAST_TEXT']) {
    assert.ok(codes.includes(c), `expected ${c} in ${codes.join(',')}`);
  }
});

test('lintDiagram: INLINE_CLASS_NOT_SUPPORTED does not mask the header check', async () => {
  const withHeader = fixture('inline-class.mmd');
  const src = withHeader.slice(withHeader.indexOf('}}}%%') + '}}}%%\n'.length);
  const codes = (await lintDiagram(src)).map((f) => f.code);
  assert.deepEqual(codes.sort(), ['INLINE_CLASS_NOT_SUPPORTED', 'MISSING_HOUSE_STYLE_HEADER']);
});

// --- flowchart shapes: lock merval's accept/reject set and the hint ---
// merval 1.0.7 (the vendored build) parses only [] () (()) {} and the
// slash-delimited parallelogram/trapezoid forms. The rest are valid mermaid it
// rejects with a misleading bracket error, so SYNTAX_ERROR names the shape.

const HEADER = fixture('good.mmd').split('\n').slice(0, 11).join('\n');
const flow = (body) => `${HEADER}\nflowchart LR\n  ${body}\n`;

const REJECTED_SHAPES = [
  ['stadium', 'A([text]) --> B[b]', '([…])'],
  ['subroutine', 'A[[text]] --> B[b]', '[[…]]'],
  ['cylinder', 'A[(text)] --> B[b]', '[(…)]'],
  ['asymmetric', 'A>text] --> B[b]', '>…]'],
  ['hexagon', 'A{{text}} --> B[b]', '{{…}}'],
  ['double circle', 'A(((text))) --> B[b]', '(((…)))'],
  ['expanded-syntax', 'A@{ shape: cyl, label: "x" } --> B[b]', '@{ shape: … }'],
];
for (const [shape, body, syntax] of REJECTED_SHAPES) {
  test(`lintDiagram: ${shape} shape gets a SYNTAX_ERROR naming the shape`, async () => {
    const findings = await lintDiagram(flow(body));
    assert.deepEqual(findings.map((f) => f.code), ['SYNTAX_ERROR']);
    assert.ok(findings[0].message.includes(`merval does not support the ${shape} shape \`${syntax}\``),
      findings[0].message);
    assert.match(findings[0].message, /reference\/mermaid-house-style\.md/);
    assert.equal(findings[0].line, 13);
  });
}

for (const body of ['A[text] --> B[b]', 'A(text) --> B[b]', 'A((text)) --> B[b]', 'A{text} --> B[b]',
  'A[/text/] --> B[b]', 'A[\\text\\] --> B[b]', 'A[/text\\] --> B[b]', 'A[\\text/] --> B[b]']) {
  test(`lintDiagram: merval accepts ${body.split(' ')[0]}`, async () => {
    assert.deepEqual(await lintDiagram(flow(body)), []);
  });
}

test('lintDiagram: no shape hint for errors unrelated to shape', async () => {
  for (const name of ['bad-syntax.mmd', 'unquoted-colon.mmd', 'unquoted-comma.mmd']) {
    const err = (await lintDiagram(fixture(name))).find((f) => f.code === 'SYNTAX_ERROR');
    assert.doesNotMatch(err.message, /merval does not support/, name);
  }
});

test('lintDiagram: no shape hint when the shape text is inside a quoted label', async () => {
  const [err] = await lintDiagram(flow('A["see [(db)] and [[x]]"] --> B[x: y]'));
  assert.equal(err.code, 'SYNTAX_ERROR');
  assert.doesNotMatch(err.message, /merval does not support/);
});

test('lintDiagram: no shape hint for an asymmetric look-alike in an edge label', async () => {
  const [err] = await lintDiagram(flow('A -->|x>y]| B[b: c]'));
  assert.equal(err.code, 'SYNTAX_ERROR');
  assert.doesNotMatch(err.message, /merval does not support/);
});

test('lintDiagram: no shape hint for an HTML tag in an unquoted label', async () => {
  const [err] = await lintDiagram(flow('A[<b>bold</b>] --> B[b: c]'));
  assert.equal(err.code, 'SYNTAX_ERROR');
  assert.doesNotMatch(err.message, /merval does not support/);
});

test('lintDiagram: no shape hint outside flowchart/graph diagrams', async () => {
  const [err] = await lintDiagram(`${HEADER}\nsequenceDiagram\n  A->>B: hi\n  loop poll[(db)]\n`);
  assert.equal(err.code, 'SYNTAX_ERROR');
  assert.doesNotMatch(err.message, /merval does not support/);
});

test('extractMermaidBlocks: returns whole file for .mmd', async () => {
  const blocks = await extractMermaidBlocks('flowchart LR\n  A --> B', 'foo.mmd');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].source, 'flowchart LR\n  A --> B');
});

test('extractMermaidBlocks: pulls fenced blocks from .md', async () => {
  const md = [
    '# Doc',
    '',
    'Some prose.',
    '',
    '```mermaid',
    'flowchart LR',
    '  A --> B',
    '```',
    '',
    'More prose.',
    '',
    '```mermaid',
    'sequenceDiagram',
    '  A->>B: hi',
    '```',
  ].join('\n');
  const blocks = await extractMermaidBlocks(md, 'foo.md');
  assert.equal(blocks.length, 2);
  assert.match(blocks[0].source, /flowchart LR/);
  assert.match(blocks[1].source, /sequenceDiagram/);
});

test('extractMermaidBlocks: returns empty for .md with no mermaid blocks', async () => {
  assert.deepEqual(await extractMermaidBlocks('# Just prose\nNo diagrams.', 'foo.md'), []);
});

// --- CommonMark tilde fences (`~~~mermaid`), same status as ```mermaid ---

test('extractMermaidBlocks: recognizes ~~~mermaid fences', async () => {
  const md = [
    '# Doc',
    '',
    '~~~mermaid',
    'flowchart LR',
    '  A --> B',
    '~~~',
  ].join('\n');
  const blocks = await extractMermaidBlocks(md, 'foo.md');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].block, 1);
  assert.match(blocks[0].source, /flowchart LR/);
});

test('extractMermaidBlocks: mixed ``` and ~~~ fences number consistently', async () => {
  const md = [
    '# Doc',
    '',
    '```mermaid',
    'flowchart LR',
    '  A --> B',
    '```',
    '',
    '~~~mermaid',
    'flowchart LR',
    '  C --> D',
    '~~~',
  ].join('\n');
  const blocks = await extractMermaidBlocks(md, 'foo.md');
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].block, 1);
  assert.match(blocks[0].source, /A --> B/);
  assert.equal(blocks[1].block, 2);
  assert.match(blocks[1].source, /C --> D/);
});

test('extractMermaidBlocks: a 4-backtick fence around a ```mermaid example is not mermaid', async () => {
  // A doc explaining how to fence mermaid, demonstrated inside a wider
  // backtick fence so the example's own ``` markers stay literal. The
  // outer fence has no "mermaid" info string, so nothing here is a
  // diagram — the inner ```mermaid must not be picked up as a block.
  const md = [
    '# Doc',
    '',
    '````',
    '```mermaid',
    'flowchart LR',
    '  A --> B',
    '```',
    '````',
  ].join('\n');
  assert.deepEqual(await extractMermaidBlocks(md, 'foo.md'), []);
});

test('extractMermaidBlocks: a ~~~ fence is not closed by ```', async () => {
  const md = [
    '# Doc',
    '',
    '~~~mermaid',
    'flowchart LR',
    '  A --> B',
    '```',
    '  C --> D',
    '~~~',
  ].join('\n');
  const blocks = await extractMermaidBlocks(md, 'foo.md');
  assert.equal(blocks.length, 1);
  // The stray ``` line inside is literal body content, not a closer.
  assert.match(blocks[0].source, /A --> B[\s\S]*```[\s\S]*C --> D/);
});

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';

// Every temp dir the entry-guard tests below create is tracked here and
// removed once, after the whole file runs (matches check-staleness.test.mjs).
const tmpDirs = [];
after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function mktemp(prefix = 'lint-mermaid-') {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tmpDirs.push(d);
  return d;
}

// --- scope: walk() excludes agent-runtime spaces ---
// Per docs-organization SKILL.md ("Scope of audit"), directory traversal
// must skip dot-directories, node_modules, and LLM-configuration files
// (CLAUDE.md, AGENTS.md, GEMINI.md, .cursorrules).
test('walk: skips LLM-config files and agent-runtime dirs in directory mode', async () => {
  const work = mkdtempSync(join(tmpdir(), 'walk-scope-test-'));
  try {
    writeFileSync(join(work, 'guide.md'), '# guide');
    writeFileSync(join(work, 'CLAUDE.md'), '# claude');
    writeFileSync(join(work, 'AGENTS.md'), '# agents');
    writeFileSync(join(work, 'GEMINI.md'), '# gemini');
    writeFileSync(join(work, '.cursorrules'), 'rules');
    mkdirSync(join(work, '.hidden'));
    writeFileSync(join(work, '.hidden', 'sneaky.md'), '# sneaky');
    mkdirSync(join(work, 'node_modules'));
    writeFileSync(join(work, 'node_modules', 'evil.md'), '# evil');

    const files = walk(work).map((p) => p.replace(work + '/', '')).sort();
    assert.deepEqual(files, ['guide.md'],
      `expected only guide.md, got: ${files.join(', ')}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('walk: skips __fixtures__ during directory traversal', async () => {
  // Test fixtures intentionally include broken diagrams. They are test
  // inputs, not project documentation, so directory traversal must skip
  // them — same principle as node_modules and dot-directories.
  const work = mkdtempSync(join(tmpdir(), 'walk-fixtures-test-'));
  try {
    writeFileSync(join(work, 'real-doc.md'), '# real');
    mkdirSync(join(work, '__fixtures__'));
    writeFileSync(join(work, '__fixtures__', 'broken.mmd'), 'intentionally broken');

    const files = walk(work).map((p) => p.replace(work + '/', '')).sort();
    assert.deepEqual(files, ['real-doc.md'],
      `expected only real-doc.md, got: ${files.join(', ')}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('walk: still returns explicit file even if its basename is LLM-config', async () => {
  // When a user explicitly names a file, we lint it. The scope filter
  // applies during directory traversal, not when a single file is given.
  const work = mkdtempSync(join(tmpdir(), 'walk-explicit-test-'));
  try {
    const explicit = join(work, 'CLAUDE.md');
    writeFileSync(explicit, '# explicitly requested');
    const files = walk(explicit);
    assert.deepEqual(files, [explicit]);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

// --- entry guard: the script must run as the main module from any install
// path, not just one with no spaces and no symlinks in it. ---

// Copies the whole (runtime-only) scripts directory rather than a
// hand-picked file list, so a script gaining a new sibling import can't
// silently break this test.
function copyScriptsDirTo(destDir) {
  cpSync(SCRIPTS_DIR, destDir, { recursive: true });
}

function runScript(scriptPath, diagramFile) {
  try {
    return { code: 0, out: execFileSync('node', [scriptPath, '--json', diagramFile], { encoding: 'utf8' }) };
  } catch (e) {
    if (e.status === 1) return { code: 1, out: e.stdout };
    throw e;
  }
}

function findsInlineClass(out) {
  const parsed = JSON.parse(out);
  assert.equal(parsed.status, 'findings');
  assert.ok(parsed.results.some((r) => r.findings.some((f) => f.code === 'INLINE_CLASS_NOT_SUPPORTED')));
}

// --- exit-code contract (SKILL.md): 0 = no findings, 1 = findings of any
// severity, 2 = internal error. A blockers-only gate reads `blockerCount`
// from --json instead of relying on the exit code. ---
const scriptPath = join(SCRIPTS_DIR, 'lint-mermaid.mjs');
const fixturePath = (name) => join(here, '__fixtures__', name);

test('CLI: exits 0 with status ok when there are no findings', async () => {
  const { code, out } = runScript(scriptPath, fixturePath('good.mmd'));
  assert.equal(code, 0);
  assert.equal(JSON.parse(out).status, 'ok');
});

test('CLI: exits 1 when the only findings are warnings', async () => {
  const { code, out } = runScript(scriptPath, fixturePath('legacy-header.mmd'));
  const parsed = JSON.parse(out);
  assert.equal(parsed.status, 'findings');
  assert.equal(parsed.blockerCount, 0);
  assert.ok(parsed.results[0].findings.every((f) => f.severity === 'warning'));
  assert.equal(code, 1);
});

test('CLI: exits 1 on blocker findings', async () => {
  const { code, out } = runScript(scriptPath, fixturePath('low-contrast.mmd'));
  assert.equal(code, 1);
  assert.ok(JSON.parse(out).blockerCount > 0);
});

test('CLI: exits 2 on internal error (missing target)', async () => {
  assert.throws(
    () => execFileSync('node', [scriptPath, '--json', join(here, 'no-such-file.mmd')], { stdio: 'pipe' }),
    (e) => e.status === 2,
  );
});

test('CLI: human summary counts distinct files, not blocks', async () => {
  const dir = mktemp();
  const md = join(dir, 'two-blocks.md');
  const block = '```mermaid\nflowchart LR\n  A[a] --> B[b]\n```\n';
  writeFileSync(md, `# Two\n\n${block}\nProse.\n\n${block}`);
  let out;
  try {
    execFileSync('node', [scriptPath, md], { encoding: 'utf8' });
    assert.fail('expected exit 1');
  } catch (e) {
    assert.equal(e.status, 1);
    out = e.stdout;
  }
  assert.match(out, /^lint-mermaid: 2 blockers in 2 blocks across 1 file\.$/m);
});

test('CLI: a ~~~mermaid fence is linted, not skipped — low contrast is flagged', async () => {
  const dir = mktemp();
  const md = join(dir, 'tilde.md');
  const text = [
    '# Doc',
    '',
    '~~~mermaid',
    "%%{init: {'theme': 'base', 'themeVariables': {",
    "  'primaryColor': '#3e6fa0',",
    "  'primaryTextColor': '#ffffff',",
    "  'primaryBorderColor': '#7c8ba1',",
    "  'lineColor': '#7c8ba1',",
    "  'edgeLabelBackground': '#f5f5f5',",
    "  'clusterBkg': '#eef2f8',",
    "  'fontFamily': 'system-ui, sans-serif'",
    '}}}%%',
    'flowchart LR',
    '  A[Input] --> B[Output]',
    '  classDef sysA fill:#333333,color:#444444,stroke:#7c8ba1',
    '  class A,B sysA',
    '~~~',
    '',
  ].join('\n');
  writeFileSync(md, text);
  const { code, out } = runScript(scriptPath, md);
  assert.equal(code, 1);
  const parsed = JSON.parse(out);
  assert.equal(parsed.status, 'findings');
  const result = parsed.results[0];
  assert.equal(result.block, 1);
  const finding = result.findings.find((f) => f.code === 'LOW_CONTRAST_TEXT');
  assert.ok(finding, `expected LOW_CONTRAST_TEXT, got: ${result.findings.map((f) => f.code)}`);
  const wantLine = text.split('\n').findIndex((l) => l.includes('classDef sysA')) + 1;
  assert.equal(finding.line, wantLine);
});

test('CLI: invocable via a script path containing a space', async () => {
  const spaceParent = mktemp();
  const targetDir = join(spaceParent, 'sp ace');
  copyScriptsDirTo(targetDir);
  const diagramFile = join(spaceParent, 'inline-class.mmd');
  writeFileSync(diagramFile, fixture('inline-class.mmd'));

  const { code, out } = runScript(join(targetDir, 'lint-mermaid.mjs'), diagramFile);
  assert.equal(code, 1);
  findsInlineClass(out);
});

test('CLI: invocable through a symlinked directory', async () => {
  const parent = mktemp();
  const linkDir = join(parent, 'link');
  symlinkSync(SCRIPTS_DIR, linkDir, 'dir');
  const diagramFile = join(parent, 'inline-class.mmd');
  writeFileSync(diagramFile, fixture('inline-class.mmd'));

  const { code, out } = runScript(join(linkDir, 'lint-mermaid.mjs'), diagramFile);
  assert.equal(code, 1);
  findsInlineClass(out);
});

// --- contrast: `style` statements and CSS named colors ---

const codesOf = (findings) => findings.map((f) => f.code).sort();

test('lintDiagram: a style statement with low-contrast hex colors is a LOW_CONTRAST blocker', async () => {
  const src = flow('A[a] --> B[b]\n  style A fill:#ffff00,color:#ffffff');
  const findings = await lintDiagram(src);
  assert.deepEqual(codesOf(findings),
    ['LOW_CONTRAST_LIGHT_BG', 'LOW_CONTRAST_TEXT', 'UNAPPROVED_STYLE']);
  for (const f of findings) assert.equal(f.line, lineOf(src, 'style A'), f.code);
  const text = findings.find((f) => f.code === 'LOW_CONTRAST_TEXT');
  assert.equal(text.severity, 'blocker');
  assert.match(text.message, /^style "A": text #ffffff on fill #ffff00 is 1\.07:1/);
});

test('lintDiagram: a style statement that sets colors is an UNAPPROVED_STYLE warning', async () => {
  const src = flow('A[a] --> B[b]\n  style A fill:#2f6dab,color:#ffffff,stroke:#7c8ba1');
  const findings = await lintDiagram(src);
  assert.deepEqual(codesOf(findings), ['UNAPPROVED_STYLE']);
  assert.equal(findings[0].severity, 'warning');
  assert.match(findings[0].message, /class A sysA/);
});

test('lintDiagram: a style statement without colors, and linkStyle, are not flagged', async () => {
  const src = flow('A[a] --> B[b]\n  style A stroke-width:4px,stroke-dasharray: 5 5\n  linkStyle 0 stroke:#ff0000');
  assert.deepEqual(await lintDiagram(src), []);
});

test('lintDiagram: CSS named colors in a classDef are contrast-checked', async () => {
  const src = flow('A[a] --> B[b]\n  classDef sysA fill:yellow,color:White\n  class A sysA');
  const findings = await lintDiagram(src);
  assert.deepEqual(codesOf(findings), ['LOW_CONTRAST_LIGHT_BG', 'LOW_CONTRAST_TEXT']);
  const text = findings.find((f) => f.code === 'LOW_CONTRAST_TEXT');
  assert.match(text.message, /^classDef "sysA": text White \(#ffffff\) on fill yellow \(#ffff00\)/);
});

test('lintDiagram: CSS named colors in a style statement are contrast-checked', async () => {
  const src = flow('A[a] --> B[b]\n  style B fill:yellow');
  assert.deepEqual(codesOf(await lintDiagram(src)), ['LOW_CONTRAST_LIGHT_BG', 'UNAPPROVED_STYLE']);
});

test('lintDiagram: a passing named color and an unresolvable color raise no contrast finding', async () => {
  const src = flow('A[a] --> B[b]\n  classDef sysA fill:teal,color:white\n  classDef sysB fill:transparent,color:#abcd\n  class A sysA\n  class B sysB');
  assert.deepEqual(await lintDiagram(src), []);
});

test('CLI: a named-color style statement in a fenced .md reports file lines', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lint-mermaid-style-'));
  tmpDirs.push(dir);
  const md = join(dir, 'doc.md');
  const text = `# Title\n\n\`\`\`mermaid\n${flow('A[a] --> B[b]\n  style A fill:yellow,color:#ffffff')}\`\`\`\n`;
  writeFileSync(md, text);
  const { code, out } = runScript(scriptPath, md);
  assert.equal(code, 1);
  const got = JSON.parse(out).results[0].findings.map((f) => [f.code, f.line]).sort();
  const at = lineOf(text, 'style A');
  assert.deepEqual(got, [['LOW_CONTRAST_LIGHT_BG', at], ['LOW_CONTRAST_TEXT', at], ['UNAPPROVED_STYLE', at]]);
});

// --- `block`: the 1-based fence number swap-palette.sh --block expects ---

test('extractMermaidBlocks: .md blocks carry a 1-based block, .mmd a null one', async () => {
  const md = '```mermaid\nflowchart LR\n  A --> B\n```\n\n```mermaid\nflowchart LR\n  C --> D\n```\n';
  assert.deepEqual((await extractMermaidBlocks(md, 'x.md')).map((b) => b.block), [1, 2]);
  assert.equal((await extractMermaidBlocks('flowchart LR\n  A --> B', 'x.mmd'))[0].block, null);
});

test('CLI --json: each .md result and finding carries block = blockIndex + 1', async () => {
  const { out } = runScript(scriptPath, fixturePath('fenced-blocks.md'));
  const results = JSON.parse(out).results;
  assert.deepEqual(results.map((r) => [r.blockIndex, r.block]), [[0, 1], [1, 2]]);
  for (const r of results) for (const f of r.findings) assert.equal(f.block, r.block, f.code);
  const unapproved = results.flatMap((r) => r.findings).find((f) => f.code === 'UNAPPROVED_CLASSNAME');
  assert.equal(unapproved.block, 2);
});

test('CLI --json: an .mmd result has block null', async () => {
  const { out } = runScript(scriptPath, fixturePath('low-contrast.mmd'));
  const [r] = JSON.parse(out).results;
  assert.equal(r.block, null);
  for (const f of r.findings) assert.equal(f.block, null, f.code);
});

test('CLI human output labels every .md fence by its 1-based block', async () => {
  let out;
  try {
    execFileSync('node', [scriptPath, fixturePath('fenced-blocks.md')], { encoding: 'utf8' });
    assert.fail('expected exit 1');
  } catch (e) {
    assert.equal(e.status, 1);
    out = e.stdout;
  }
  assert.match(out, /fenced-blocks\.md \(block 1\):/);
  assert.match(out, /fenced-blocks\.md \(block 2\):/);
  assert.doesNotMatch(out, /\(block 0\)/);
});

test('extractMermaidBlocks: a fence inside an admonition is found and marked not swappable', async () => {
  const md = '# Doc\n\n!!! note\n    ```mermaid\n    flowchart LR\n      A --> B\n    ```\n';
  const blocks = await extractMermaidBlocks(md, 'foo.md');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].startLine, 5);
  assert.equal(blocks[0].source, 'flowchart LR\n  A --> B');
  assert.equal(blocks[0].swappable, false);
});

test('extractMermaidBlocks: a non-doc, non-.mmd file has no blocks', async () => {
  assert.deepEqual(await extractMermaidBlocks('```mermaid\ngraph LR\n```\n', 'notes.txt'), []);
});

test('extractMermaidBlocks: [mermaid] paragraphs and [source,mermaid] listings in .adoc', async () => {
  const blocks = await extractMermaidBlocks('[mermaid]\ngraph LR\n\n[source,mermaid]\n----\ngraph TD\n----\n', 'x.adoc');
  assert.deepEqual(blocks.map((b) => [b.block, b.startLine, b.swappable]), [[1, 2, false], [2, 6, true]]);
});

test('walk: picks up every registered doc extension and .mmd, nothing else', () => {
  const dir = mktemp();
  for (const n of ['a.md', 'b.markdown', 'c.mmd', 'd.txt', 'e.mdx']) writeFileSync(join(dir, n), 'x\n');
  assert.deepEqual(walk(dir).map((p) => p.slice(dir.length + 1)).sort(), ['a.md', 'b.markdown', 'c.mmd']);
});
