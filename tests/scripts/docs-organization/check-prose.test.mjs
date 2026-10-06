import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeProse, THRESHOLDS } from '../../../module/skills/docs-organization/scripts/check-prose.mjs';
import { parseDoc } from '../../../module/skills/docs-organization/scripts/formats/index.mjs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, realpathSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Every temp dir any test in this file creates is tracked here and removed
// once, after the whole file runs (matches check-staleness.test.mjs).
const tmpDirs = [];
after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function mktemp(prefix = 'check-prose-') {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tmpDirs.push(d);
  return d;
}

const codes = (findings) => findings.map((f) => f.code);

const analyze = async (src, name = 'doc.md') => analyzeProse(await parseDoc(name, src));

test('clean short prose yields no findings', async () => {
  const md = `# Title\n\nA short paragraph. Two sentences only.\n\n- a tight bullet\n- another one\n`;
  assert.deepEqual(await analyze(md), []);
});

test('long top-level paragraph flags WALL_OF_TEXT with its line', async () => {
  const words = Array(THRESHOLDS.paragraphWords + 5).fill('word').join(' ');
  const md = `# Title\n\nintro line here\n\n${words}.\n`;
  const findings = await analyze(md);
  const wt = findings.filter((f) => f.code === 'WALL_OF_TEXT');
  assert.equal(wt.length, 1);
  assert.equal(wt[0].line, 5); // the long paragraph starts on line 5
});

test('flat dense bullet flags DENSE_BULLET', async () => {
  const body = Array(THRESHOLDS.bulletWords + 5).fill('word').join(' ');
  const md = `- **Lead.** ${body}.\n- short one\n`;
  const findings = await analyze(md);
  assert.deepEqual(codes(findings), ['DENSE_BULLET']);
  assert.equal(findings[0].line, 1);
});

test('a bullet broken into short sub-bullets is NOT flagged (the escape hatch)', async () => {
  const md =
    `- **Lead.** intro then details:\n` +
    `  - first point is short and scannable\n` +
    `  - second point is short and scannable\n` +
    `  - third point is short and scannable\n`;
  // The outer item holds a nested list (the desired shape) and its own text is
  // short; each inner item is short. No DENSE_BULLET.
  assert.deepEqual(await analyze(md), []);
});

test('a long sub-bullet is still flagged (nesting does not exempt inner prose)', async () => {
  const body = Array(THRESHOLDS.bulletWords + 20).fill('word').join(' ');
  const md = `- **Lead.** details:\n  - ${body}.\n  - a short sibling\n`;
  assert.deepEqual(codes(await analyze(md)), ['DENSE_BULLET']);
});

test('a short bullet with code spans is not flagged', async () => {
  const md = `- Uses \`v1.2.3\`, \`a.b.c\`, \`x.y.z\`, and \`p.q.r\` together.\n`;
  assert.deepEqual(await analyze(md), []);
});

test('abbreviation-heavy short prose is not flagged (no sentence counting)', async () => {
  // Peppered with abbreviations that would wreck any regex sentence counter.
  // Because we trigger on word count only, this ~45-word paragraph is clean —
  // the fuzzy sentence-rhythm judgment is the LLM lane's job, not ours.
  const md =
    'The pipeline has stages, e.g. fetch, verify, and emit. Configure it via ' +
    'flags, i.e. the documented ones, or via the file. Compare vs. the old ' +
    'tool. The U.S. deployment differs. See sec. 3.2 for details. It works.\n';
  assert.deepEqual(await analyze(md), []);
});

test('code fences and tables are excluded from prose counting', async () => {
  const longWords = Array(THRESHOLDS.paragraphWords + 30).fill('word').join(' ');
  const md =
    '# Title\n\n```\n' + longWords + '. ' + longWords + '.\n```\n\n' +
    '| col | ' + longWords + ' |\n|---|---|\n| a | b |\n';
  assert.deepEqual(await analyze(md), []);
});

test('a long blockquote is excluded like a list', async () => {
  const words = Array(THRESHOLDS.paragraphWords + 10).fill('word').join(' ');
  const md = `> ${words}.\n`;
  assert.deepEqual(await analyze(md), []);
});

test('a file over the line budget flags SPLIT_CANDIDATE at line 1', async () => {
  const md = '# Title\n\n' + Array(THRESHOLDS.fileLines + 5).fill('filler line').join('\n') + '\n';
  const findings = await analyze(md);
  const sc = findings.filter((f) => f.code === 'SPLIT_CANDIDATE' && f.line === 1);
  assert.equal(sc.length, 1);
});

test('an oversized H2 section flags SPLIT_CANDIDATE at the heading', async () => {
  const filler = Array(THRESHOLDS.sectionLines + 10).fill('filler line').join('\n');
  const md = `# Doc\n\n## Big Section\n\n${filler}\n\n## Small Section\n\ndone.\n`;
  const findings = await analyze(md);
  const sc = findings.find((f) => f.code === 'SPLIT_CANDIDATE' && f.message.includes('Big Section'));
  assert.ok(sc, 'expected a SPLIT_CANDIDATE naming the Big Section');
  assert.equal(sc.line, 3);
});

test('a long GFM alert or admonition is the author\'s prose and flags WALL_OF_TEXT', async () => {
  const words = Array(THRESHOLDS.paragraphWords + 5).fill('word').join(' ');
  const alert = await analyze(`> [!NOTE]\n> ${words}.\n`);
  assert.deepEqual(alert.map((f) => [f.code, f.line]), [['WALL_OF_TEXT', 1]]);
  const admon = await analyze(`!!! note\n    ${words}.\n`);
  assert.deepEqual(admon.map((f) => [f.code, f.line]), [['WALL_OF_TEXT', 2]]);
});

test('a long second paragraph inside a list item is not a WALL_OF_TEXT (the item owns it)', async () => {
  const words = Array(THRESHOLDS.paragraphWords + 5).fill('word').join(' ');
  const findings = await analyze(`- short item\n\n  ${words}.\n`);
  assert.deepEqual(codes(findings), ['DENSE_BULLET']);
});

test('front matter does not count toward a section or paragraph', async () => {
  const findings = await analyze('---\ntitle: x\n---\n# T\n\nShort.\n');
  assert.deepEqual(findings, []);
});

test('AsciiDoc: a long paragraph or NOTE flags WALL_OF_TEXT; a quote block does not', async () => {
  const words = Array(THRESHOLDS.paragraphWords + 5).fill('word').join(' ');
  const src = `= T\n\n${words}.\n\nNOTE: ${words}.\n\n____\n${words}.\n____\n`;
  const findings = await analyze(src, 'doc.adoc');
  assert.deepEqual(findings.map((f) => [f.code, f.line]), [['WALL_OF_TEXT', 3], ['WALL_OF_TEXT', 5]]);
});

test('AsciiDoc: a dense flat list item flags DENSE_BULLET; a nested one does not', async () => {
  const words = Array(THRESHOLDS.bulletWords + 5).fill('word').join(' ');
  const findings = await analyze(`* ${words}\n* parent ${words}\n** child\n`, 'doc.adoc');
  assert.deepEqual(findings.map((f) => [f.code, f.line]), [['DENSE_BULLET', 1]]);
});

test('AsciiDoc: an oversized == section flags SPLIT_CANDIDATE at its heading', async () => {
  const filler = Array(THRESHOLDS.sectionLines + 10).fill('filler line').join('\n');
  const findings = await analyze(`= Doc\n\n== Big Section\n\n${filler}\n\n== Small\n\ndone.\n`, 'doc.adoc');
  const sc = findings.find((f) => f.code === 'SPLIT_CANDIDATE' && f.message.includes('Big Section'));
  assert.equal(sc.line, 3);
});

const SCRIPTS_DIR = fileURLToPath(new URL('../../../module/skills/docs-organization/scripts', import.meta.url));
const SCRIPT = join(SCRIPTS_DIR, 'check-prose.mjs');

// Runs the CLI; exit 1 (findings) is a normal result, anything else throws.
function runCli(cwd, ...args) {
  try {
    return { code: 0, out: JSON.parse(execFileSync('node', [SCRIPT, ...args], { cwd, encoding: 'utf8' })) };
  } catch (e) {
    if (e.status === 1) return { code: 1, out: JSON.parse(e.stdout) };
    throw e;
  }
}

// canonical/a.md holds one WALL_OF_TEXT paragraph; alias/a.md is a symlink to it.
function makeAliasedTree() {
  const root = mktemp();
  const words = Array(THRESHOLDS.paragraphWords + 5).fill('word').join(' ');
  mkdirSync(join(root, 'canonical'));
  mkdirSync(join(root, 'alias'));
  writeFileSync(join(root, 'canonical', 'a.md'), `# A\n\n${words}.\n`);
  symlinkSync('../canonical/a.md', join(root, 'alias', 'a.md'));
  return root;
}

test('CLI: a symlink and its target are one document, reported at the canonical path', async () => {
  const root = makeAliasedTree();
  const { code, out } = runCli(root, 'canonical', 'alias');
  assert.equal(code, 1);
  assert.equal(out.scanned, 1);
  assert.deepEqual(out.findings.map((f) => [f.code, f.file]), [['WALL_OF_TEXT', 'canonical/a.md']]);
});

test('CLI: a directory of symlinks is walked and reports canonical paths', async () => {
  const root = makeAliasedTree();
  const { out } = runCli(root, 'alias');
  assert.equal(out.scanned, 1);
  assert.deepEqual(out.findings.map((f) => f.file), ['canonical/a.md']);
});

test('CLI: a symlinked directory is not descended', async () => {
  const root = mktemp();
  mkdirSync(join(root, 'outside'));
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'outside', 'b.md'), '# B\n');
  symlinkSync('../outside', join(root, 'docs', 'linked'));
  const { code, out } = runCli(root, 'docs');
  assert.equal(code, 0);
  assert.equal(out.scanned, 0);
});

test('CLI: scanned counts every clean document read', async () => {
  const root = mktemp();
  writeFileSync(join(root, 'one.md'), '# One\n\nShort.\n');
  writeFileSync(join(root, 'two.md'), '# Two\n\nShort.\n');
  const { code, out } = runCli(root, 'one.md', 'two.md');
  assert.equal(code, 0);
  assert.equal(out.status, 'ok');
  assert.equal(out.scanned, 2);
});

test('CLI: a dangling .md symlink fails loudly (exit 2), not silently skipped', async () => {
  const root = mktemp();
  mkdirSync(join(root, 'docs'));
  symlinkSync('../missing.md', join(root, 'docs', 'x.md'));
  assert.throws(() => runCli(root, 'docs'), (e) => e.status === 2);
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
    return { code: 0, out: JSON.parse(execFileSync('node', [...nodeFlags, scriptPath, ...args], { cwd, encoding: 'utf8' })) };
  } catch (e) {
    if (e.status === 1) return { code: 1, out: JSON.parse(e.stdout) };
    throw e;
  }
}

function fixtureRoot() {
  const root = mktemp();
  const words = Array(THRESHOLDS.paragraphWords + 5).fill('word').join(' ');
  writeFileSync(join(root, 'a.md'), `# A\n\n${words}.\n`);
  return root;
}

test('CLI: invocable via a script path containing a space', async () => {
  const spaceParent = mktemp();
  const targetDir = join(spaceParent, 'sp ace');
  copyScriptsDirTo(targetDir);

  const { code, out } = runScriptAt(join(targetDir, 'check-prose.mjs'), fixtureRoot(), ['a.md']);
  assert.equal(code, 1);
  assert.deepEqual(codes(out.findings), ['WALL_OF_TEXT']);
});

test('CLI: invocable through a symlinked directory', async () => {
  const parent = mktemp();
  const linkDir = join(parent, 'link');
  symlinkSync(SCRIPTS_DIR, linkDir, 'dir');

  const { code, out } = runScriptAt(join(linkDir, 'check-prose.mjs'), fixtureRoot(), ['a.md']);
  assert.equal(code, 1);
  assert.deepEqual(codes(out.findings), ['WALL_OF_TEXT']);
});

// node --preserve-symlinks-main leaves import.meta.url as the symlink path
// instead of resolving it — the mirror image of the plain symlinked-directory
// case above. A guard that only resolves one side of the comparison passes
// one of these two cases and silently fails the other.
test('CLI: invocable through a symlinked directory under node --preserve-symlinks-main', async () => {
  const parent = mktemp();
  const linkDir = join(parent, 'link');
  symlinkSync(SCRIPTS_DIR, linkDir, 'dir');

  const { code, out } = runScriptAt(join(linkDir, 'check-prose.mjs'), fixtureRoot(), ['a.md'], ['--preserve-symlinks-main']);
  assert.equal(code, 1);
  assert.deepEqual(codes(out.findings), ['WALL_OF_TEXT']);
});

const only = (code) => async (src, name) => (await analyze(src, name)).filter((f) => f.code === code);
const dn = only('DOUBLE_NEGATIVE');

test('DOUBLE_NEGATIVE: a negator then a negative-meaning word in one clause', async () => {
  for (const [src, phrase] of [
    ['This is not uncommon.', 'not uncommon'],
    ['You cannot fail to notice it.', 'cannot fail'],
    ['A key is not valid unless it is signed.', 'not valid unless'],
    ["It doesn't prevent writes.", "doesn't prevent"],
    ['An application does not become void unless the applicant fails.', 'not become void'],
    ['Do not deploy without a backup.', 'not deploy without'],
    ['Use no fewer than three nodes.', 'no fewer than'],
    ['Keep no less than 10 GB free.', 'no less than'],
    ['Do not use any tool other than the CLI.', 'not use any tool other than'],
  ]) {
    const f = await dn(`${src}\n`);
    assert.equal(f.length, 1, src);
    assert.ok(f[0].message.includes(`"${phrase}"`), `${src}: ${f[0].message}`);
    assert.equal(f[0].severity, 'info');
    assert.equal(f[0].line, 1);
  }
});

test('DOUBLE_NEGATIVE: lone negations, prefix lookalikes, and split clauses are not flagged', async () => {
  for (const src of [
    'This is not supported.',
    'Retry unless it is done.',
    'Do not install the index.',
    'It does not include tests.',
    'It is not here. Unless you ask, it stays.',
    'It is not here; unless you ask, it stays.',
    'It is not one two three four five six seven eight nine ten unless.',
    'Neither the CLI nor the API changes.',
  ]) {
    assert.deepEqual(await dn(`${src}\n`), [], src);
  }
});

test('DOUBLE_NEGATIVE: reports the negator line, across emphasis and a soft wrap', async () => {
  assert.equal((await dn('# T\n\nIntro.\n\nThis is **not** uncommon.\n'))[0].line, 5);
  const wrapped = await dn('It is not\nuncommon to wrap.\n');
  assert.equal(wrapped.length, 1);
  assert.equal(wrapped[0].line, 1);
});

test('DOUBLE_NEGATIVE: headings, code, tables, and quotations are not prose; alerts and list items are', async () => {
  const skipped = [
    '# Not uncommon title',
    '',
    '```',
    'not uncommon',
    '```',
    '',
    'Uses `not uncommon` inline.',
    '',
    '| a | b |',
    '|---|---|',
    '| not uncommon | x |',
    '',
    '> This is not uncommon.',
    '',
  ].join('\n');
  assert.deepEqual(await dn(skipped), []);
  const counted = await dn('> [!NOTE]\n> This is not uncommon.\n\n- also not unusual\n');
  assert.deepEqual(counted.map((f) => f.line), [2, 4]);
});

test('AsciiDoc: DOUBLE_NEGATIVE in a paragraph, not in a quote block', async () => {
  const adoc = 'This is not uncommon.\n\n____\nNot uncommon in a quote.\n____\n';
  const f = await dn(adoc, 'doc.adoc');
  assert.equal(f.length, 1);
  assert.equal(f[0].line, 1);
});

const sa = only('SLASH_ALTERNATIVE');

test('SLASH_ALTERNATIVE: a slash between two words in prose', async () => {
  for (const [src, pair] of [
    ['Pick dev/prod now.', 'dev/prod'],
    ['Use and/or here.', 'and/or'],
    ['Toggle enable/disable (rarely).', 'enable/disable'],
    ['Pick dev/prod… then go.', 'dev/prod'],
    ['Pick dev/prod— then go.', 'dev/prod'],
    ['Pick dev/prod– then go.', 'dev/prod'],
    ['“dev/prod” is ambiguous.', 'dev/prod'],
  ]) {
    const f = await sa(`${src}\n`);
    assert.equal(f.length, 1, src);
    assert.ok(f[0].message.includes(`"${pair}"`), `${src}: ${f[0].message}`);
    assert.equal(f[0].severity, 'info');
  }
});

test('SLASH_ALTERNATIVE: code, links, URLs, paths, numbers, and established terms are not flagged', async () => {
  for (const src of [
    'Write `a/b` here.',
    'See [the docs](src/lib).',
    'Go to https://example.com/a/b now.',
    'Use src/lib/ and ./x/y and ../up and ~/foo and /etc/hosts.',
    'Nest a/b/c deep.',
    'Edit config/app.yaml first.',
    'Handles I/O, TCP/IP, CI/CD, A/B, N/A, UI/UX, read/write, 24/7.',
    'Half is 1/2 on 10/06.',
  ]) {
    assert.deepEqual(await sa(`${src}\n`), [], src);
  }
});

test('SLASH_ALTERNATIVE: a bare two-segment path is a candidate (adjudication drops it)', async () => {
  assert.equal((await sa('Bare src/lib here.\n')).length, 1);
});

test('AsciiDoc: SLASH_ALTERNATIVE in a paragraph, not in inline code or a link macro', async () => {
  const f = await sa('Pick dev/prod, not `a/b` or link:src/lib[docs].\n', 'doc.adoc');
  assert.deepEqual(f.map((x) => x.message.match(/"([^"]+)"/)[1]), ['dev/prod']);
});

test('SLASH_ALTERNATIVE: a long run of edge punctuation completes without quadratic cost', async () => {
  const run = ')'.repeat(50000);
  const started = performance.now();
  assert.deepEqual(await sa(`${run}a\n`), []);
  assert.deepEqual(await sa(`${run}dev/prod\n`), []);
  const f = await sa(`${'('.repeat(50000)}dev/prod${run}\n`);
  assert.equal(f.length, 1);
  assert.ok(f[0].message.includes('"dev/prod"'));
  // node:test's timeout option cannot interrupt synchronous work, so measure.
  assert.ok(performance.now() - started < 2000, 'slash scan took 2s or more');
});
