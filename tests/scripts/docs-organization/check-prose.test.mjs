import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeProse, THRESHOLDS, VOLATILE_NOUNS, LABEL_WORDS, SOFTWARE_LABELS, TIME_PHRASES } from '../../../module/skills/docs-organization/scripts/check-prose.mjs';
import { parseDoc } from '../../../module/skills/docs-organization/scripts/formats/index.mjs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, realpathSync, cpSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { walkDocs } from '../../../module/skills/docs-organization/scripts/doc-files.mjs';
import { fileURLToPath } from 'node:url';
import { scalingRatio, LINEAR_LIMIT } from './linearity.mjs';

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

const analyze = async (src, name = 'doc.md') => analyzeProse(await parseDoc(name, src), name);

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
  assert.match(sc.message, /A SKILL\.md moves detail into reference\/ instead/);
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
  const scan = async (n) => {
    const run = ')'.repeat(n);
    await sa(`${run}a\n`);
    await sa(`${run}dev/prod\n`);
    return sa(`${'('.repeat(n)}dev/prod${run}\n`);
  };
  const ratio = await scalingRatio(scan, 40000);
  assert.ok(ratio < LINEAR_LIMIT, `4x input cost ${ratio.toFixed(1)}x`);
  const run = ')'.repeat(50000);
  assert.deepEqual(await sa(`${run}a\n`), []);
  assert.deepEqual(await sa(`${run}dev/prod\n`), []);
  const f = await sa(`${'('.repeat(50000)}dev/prod${run}\n`);
  assert.equal(f.length, 1);
  assert.ok(f[0].message.includes('"dev/prod"'));
});


const vd = only('VOLATILE_DETAIL');
const ta = only('TIME_ANCHORED');

test('VOLATILE_DETAIL: counts, metrics, and popularity figures are candidates', async () => {
  for (const [src, kind, phrase] of [
    ['The suite has 147 tests.', 'count', '147 tests'],
    ['It ships 40+ built-in checks.', 'count', '40+ built-in checks'],
    ['We have 1,200 unit tests.', 'count', '1,200 unit tests'],
    ['It has 147 test cases.', 'count', '147 test cases'],
    ['A 300-line script.', 'count', '300-line'],
    ['A 2k-LOC module.', 'count', '2k-LOC'],
    ['Over 50 integrations.', 'count', '50 integrations'],
    ['The CLI provides approximately 22 commands.', 'count', '22 commands'],
    ['It supports 12 languages.', 'count', '12 languages'],
    ['It finds 3 `.md` files.', 'count', '3 files'],
    ['We hit 94% coverage.', 'metric', '94% coverage'],
    ['Line coverage is 94% today.', 'metric', 'coverage is 94%'],
    ['It is 3x faster.', 'metric', '3x faster'],
    ['It is 3× faster.', 'metric', '3× faster'],
    ['It is 3X faster.', 'metric', '3X faster'],
    ['It is 40% faster.', 'metric', '40% faster'],
    ['About ~2k LOC.', 'metric', '2k LOC'],
    ['Only 500 lines of code.', 'metric', '500 lines of code'],
    ['The repo has 1.2k stars.', 'popularity', '1.2k stars'],
    ['It has 10,000 downloads.', 'popularity', '10,000 downloads'],
    ['It is used by 50+ teams.', 'popularity', 'used by 50+ teams'],
  ]) {
    const f = await vd(`${src}\n`);
    assert.equal(f.length, 1, src);
    assert.ok(f[0].message.startsWith(`volatile ${kind}: "${phrase}"`), `${src}: ${f[0].message}`);
    assert.equal(f[0].severity, 'info');
    assert.equal(f[0].line, 1);
  }
});

test('VOLATILE_DETAIL: every listed noun is a count after a number', async () => {
  for (const noun of VOLATILE_NOUNS) assert.equal((await vd(`It has 12 ${noun}.\n`)).length, 1, noun);
});

test('VOLATILE_DETAIL: pins, labels, limits, and spelled-out counts are not candidates', async () => {
  for (const src of [
    'There are six slash commands.',
    'Requires Node.js ≥ 20.',
    'Uses MADR 4.0 format.',
    'Listen on port 8080.',
    'It returns exit 2 on error.',
    'Go to step 3 next.',
    'See RFC 2119 for terms.',
    'Pass 2 arguments.',
    'Lane 4 checks whenever.',
    'Python 3 scripts work.',
    'Split 2 or more files.',
    'It stores a SHA-256 per file.',
    'Keep 100 lines (one range at 150 lines or fewer).',
    'Text needs WCAG 4.5:1.',
    '2 users must approve.',
    'It times out after 30 seconds.',
    'It has 12 tests-to-be.',
    'Supports 3rd-party plugins.',
    'The 2nd-level checks run.',
    'Store 0x1F files.',
    'Took 100ms tests.',
    'It has 147tests.',
    'Use PR #12 tests.',
    'See issue #12 checks.',
  ]) {
    assert.deepEqual(await vd(`${src}\n`), [], src);
  }
});

test('VOLATILE_DETAIL: one coverage word yields one finding', async () => {
  assert.equal((await vd('We hit 94% coverage 95% of the time.\n')).length, 1);
});

test('VOLATILE_DETAIL: a label word before the number skips it', async () => {
  for (const label of LABEL_WORDS) assert.deepEqual(await vd(`See ${label} 3 checks.\n`), [], label);
});

test('VOLATILE_DETAIL: software versions are candidates', async () => {
  for (const [src, phrase] of [
    ['It uses markdown-it 14.1.0 today.', 'markdown-it 14.1.0'],
    ['Data from 2025.01.15 onward.', '2025.01.15'],
    ['Upgrade to v2.1 first.', 'v2.1'],
    ['Tag v1.2.3 ships it.', 'Tag v1.2.3'],
    ['Tag V1.2.3 ships it.', 'Tag V1.2.3'],
    ['Install markdown-it@14.1.0 globally.', 'markdown-it@14.1.0'],
    ['Pin actions/checkout@v4 in CI.', 'checkout@v4'],
    ['Install @scope/pkg@1.0.0 first.', 'pkg@1.0.0'],
    ['Try 1.2.3-beta.1 builds.', 'Try 1.2.3-beta.1'],
    ['Ship 2.0.0-rc1 soon.', 'Ship 2.0.0-rc1'],
    ['Try v2.1-beta.2 builds.', 'Try v2.1-beta.2'],
    ['Needs lola 0.7.0+ installed.', 'lola 0.7.0+'],
    ['Requires Node 20.11.0 or later.', 'Node 20.11.0'],
    ['Set version 2.3.1 here.', 'version 2.3.1'],
    ['It ships 2.3.1.', 'ships 2.3.1'],
  ]) {
    const f = await vd(`${src}\n`);
    assert.equal(f.length, 1, src);
    assert.equal(f[0].message, `volatile version: "${phrase}"; delete it or point to the command that reports it`, src);
    assert.equal(f[0].severity, 'info');
    assert.equal(f[0].line, 1);
  }
});

test('VOLATILE_DETAIL: IPs, short numbers, bare v-labels, ranges, and slugs are not versions', async () => {
  for (const src of [
    'Bind to 127.0.0.1 locally.',
    'Requires Node 20.',
    'Python 3.12 works.',
    'It took 1.5 seconds.',
    'Ship v2 first.',
    'Use v1.2.x ranges.',
    'Match 1.2.3a builds.',
    'A foo-1.2.3 slug.',
    'Ping me @ v4 today.',
    'Run `npm i markdown-it@14.1.0` once.',
    'Run ssh root@10.0.0.1 now.',
  ]) {
    assert.deepEqual(await vd(`${src}\n`), [], src);
  }
  assert.deepEqual(await vd('# Release 14.1.0\n'), []);
});

test('VOLATILE_DETAIL: a structural label skips a version, a software label does not', async () => {
  for (const label of LABEL_WORDS) {
    const got = (await vd(`See ${label} 3.2.1 now.\n`)).length;
    assert.equal(got, SOFTWARE_LABELS.has(label) ? 1 : 0, label);
  }
});

test('VOLATILE_DETAIL: a version in a TIME_ANCHORED slot yields only the time anchor', async () => {
  for (const src of ['As of v2.1.0 it works.', 'As of 2.3.1 it works.', 'New in 1.4.0: export.']) {
    assert.deepEqual(await vd(`${src}\n`), [], src);
    assert.equal((await ta(`${src}\n`)).length, 1, src);
  }
  const rc = 'As of 2.0.0-rc1 it works.\n';
  assert.equal((await vd(rc)).length, 1);
  assert.deepEqual(await ta(rc), []);
});

test('VOLATILE_DETAIL: a version excerpt never reuses the previous finding\'s words', async () => {
  const f = await vd('We had 94% coverage 1.2.3 now.\n');
  assert.deepEqual(f.map((x) => x.message.match(/"([^"]+)"/)[1]), ['94% coverage', '1.2.3']);
});

test('TIME_ANCHORED: point-in-time phrases are candidates', async () => {
  for (const [src, phrase] of [
    ['It currently supports X.', 'currently'],
    ['At present it works.', 'At present'],
    ['At the moment it works.', 'At the moment'],
    ['At the time of writing it works.', 'At the time of writing'],
    ['As of v2 it works.', 'As of v2'],
    ['As of 2.3.1 it works.', 'As of 2.3.1'],
    ['As of 2025 it works.', 'As of 2025'],
    ['New in 2.3: export.', 'New in 2.3'],
    ['It now supports X.', 'now supports'],
    ['It now has X.', 'now has'],
    ['It now includes X.', 'now includes'],
    ['It now uses X.', 'now uses'],
    ['Export is coming soon.', 'coming soon'],
    ['Skip it for now.', 'for now'],
    ['It ships in a future release.', 'in a future release'],
  ]) {
    const f = await ta(`${src}\n`);
    assert.equal(f.length, 1, src);
    assert.ok(f[0].message.startsWith(`time-anchored: "${phrase}"`), `${src}: ${f[0].message}`);
    assert.equal(f[0].severity, 'info');
  }
});

test('TIME_ANCHORED: every listed phrase is a candidate', async () => {
  for (const phrase of TIME_PHRASES) {
    const src = phrase.map((w) => (w === '<version>' ? 'v2' : w)).join(' ');
    assert.equal((await ta(`Note: ${src} here.\n`)).length, 1, src);
  }
});

test('TIME_ANCHORED: sequencing, deprecation, and recency words are not candidates', async () => {
  for (const src of [
    'Create a new branch.',
    'Now run the script.',
    'The file is now ready.',
    'You can now open localhost:8080.',
    'Install the latest release.',
    'The code no longer exists.',
    'Open the newly created branch.',
    'Files touched recently.',
    'As of then, it works.',
    'New in this guide: a section.',
    'It runs as of 10 seconds.',
  ]) {
    assert.deepEqual(await ta(`${src}\n`), [], src);
  }
});

test('VOLATILE_DETAIL and TIME_ANCHORED: headings, code, tables, quotations, and link text are not prose', async () => {
  const skipped = [
    '# Has 147 tests currently',
    '',
    '```',
    'has 147 tests currently',
    '```',
    '',
    'Uses `147 tests currently` inline.',
    '',
    '| a | b |',
    '|---|---|',
    '| 147 tests | currently |',
    '',
    '> It has 147 tests currently.',
    '',
    'See [147 tests currently](x.md).',
    '',
  ].join('\n');
  assert.deepEqual(await vd(skipped), []);
  assert.deepEqual(await ta(skipped), []);
  const md = '> [!NOTE]\n> It has 147 tests.\n\n- currently fine\n';
  assert.deepEqual((await vd(md)).map((f) => f.line), [2]);
  assert.deepEqual((await ta(md)).map((f) => f.line), [4]);
});

test('VOLATILE_DETAIL and TIME_ANCHORED: line across emphasis and a soft wrap', async () => {
  const bold = await vd('# T\n\nIntro.\n\nThe suite has **147** tests.\n');
  assert.equal(bold.length, 1);
  assert.equal(bold[0].line, 5);
  assert.ok(bold[0].message.includes('"147 tests"'), bold[0].message);
  const wrapped = await vd('It is used by\n50+ teams.\n');
  assert.equal(wrapped.length, 1);
  assert.equal(wrapped[0].line, 1);
  assert.ok(wrapped[0].message.includes('"used by 50+ teams"'), wrapped[0].message);
  const time = await ta('It works at the\ntime of writing.\n');
  assert.equal(time.length, 1);
  assert.equal(time[0].line, 1);
});

test('AsciiDoc: VOLATILE_DETAIL and TIME_ANCHORED in a paragraph, not in a quote block', async () => {
  const adoc = 'It currently has 147 tests.\n\n____\nIt currently has 147 tests.\n____\n';
  assert.deepEqual((await vd(adoc, 'doc.adoc')).map((f) => f.line), [1]);
  assert.deepEqual((await ta(adoc, 'doc.adoc')).map((f) => f.line), [1]);
});

test('VOLATILE_DETAIL and TIME_ANCHORED: adversarial runs complete without quadratic cost', async () => {
  const scan = async (n) => {
    await vd(`${'1,'.repeat(n)}1 tests\n`);
    await vd(`${'step 1 '.repeat(n)}\n`);
    await vd(`${'12 unit '.repeat(n)}\n`);
    await vd(`1${'-a'.repeat(n)} tests\n`);
    await vd(`1${'k'.repeat(n)} tests\n`);
    await vd(`${'1.'.repeat(n)}1\n`);
    await vd(`v${'1.'.repeat(n)}1\n`);
    await vd(`${'1.1-a.'.repeat(n)}1\n`);
    await vd(`1-${'a.'.repeat(n)}a\n`);
    await vd(`${'x@1 '.repeat(n)}\n`);
    return ta(`${'at the time of '.repeat(n)}\n`);
  };
  const ratio = await scalingRatio(scan, 5000);
  assert.ok(ratio < LINEAR_LIMIT, `4x input cost ${ratio.toFixed(1)}x`);
});

const FIXTURES = fileURLToPath(new URL('./__fixtures__/', import.meta.url));
const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const VOLATILE_CODES = new Set(['VOLATILE_DETAIL', 'TIME_ANCHORED']);
const volatileOf = (findings) => findings.filter((f) => VOLATILE_CODES.has(f.code));
const quoted = (f) => f.message.match(/"([^"]+)"/)[1];

test('corpus: the filler README yields exactly its volatile details', async () => {
  const src = readFileSync(join(FIXTURES, 'volatile-filler.md'), 'utf8');
  const got = volatileOf(await analyze(src)).map((f) => `${f.line} ${f.code} ${quoted(f)}`);
  assert.deepEqual(got.sort(), [
    '3 VOLATILE_DETAIL 1.2k stars',
    '3 VOLATILE_DETAIL used by 50+ teams',
    '8 VOLATILE_DETAIL 3x faster',
    '9 VOLATILE_DETAIL 94% coverage',
    '9 VOLATILE_DETAIL 1,200 unit tests',
    '10 VOLATILE_DETAIL 8k LOC',
    '10 VOLATILE_DETAIL 4 dependencies',
    '11 VOLATILE_DETAIL 12 languages',
    '11 VOLATILE_DETAIL 40+ built-in checks',
    '11 TIME_ANCHORED currently',
    '15 TIME_ANCHORED As of v2.1',
    '18 VOLATILE_DETAIL markdown-it 14.1.0',
    '18 VOLATILE_DETAIL fastgrid@2.0.0-rc1',
    '15 TIME_ANCHORED now supports',
    '15 TIME_ANCHORED coming soon',
    '16 VOLATILE_DETAIL 30 contributors',
    '16 VOLATILE_DETAIL 2,400 commits',
  ].sort());
});

test('corpus: a number-heavy doc of pins, limits, and labels yields no volatile details', async () => {
  const src = readFileSync(join(FIXTURES, 'volatile-clean.md'), 'utf8');
  assert.deepEqual(volatileOf(await analyze(src)), []);
});

test('CLI: the filler fixture reports volatile findings with file paths', async () => {
  const { code, out } = runCli(REPO, join(FIXTURES, 'volatile-filler.md'));
  assert.equal(code, 1);
  assert.equal(out.status, 'findings');
  assert.equal(out.scanned, 1);
  for (const c of VOLATILE_CODES) {
    const hits = out.findings.filter((f) => f.code === c);
    assert.ok(hits.length >= 1, `no ${c} finding`);
    assert.ok(hits.every((f) => f.file), `${c} finding lacks file`);
  }
});

// The repo must pass its own audit. Each entry is a candidate a reviewer
// judged intentional; it is keyed on the quoted excerpt, never the line, so
// unrelated edits do not break it. A new candidate fails this test: fix the
// prose, put a literal example in inline code, or add an entry with a reason.
const SELF_SCAN_ALLOWED = [
  // Names the lola release whose hook-runner bug the rationale describes (history).
  ['docs/dev/vendoring.md', 'VOLATILE_DETAIL', 'lola v0.7.0'],
  // An ADR is a snapshot genre; its context section describes the time of the decision.
  ['module/skills/adr/reference/example-adr.md', 'TIME_ANCHORED', 'currently'],
];

test('self-scan: this repo\'s docs have only the allowed volatile details', async () => {
  // The same scope /docs-audit sweeps in a lola module repo: README, docs/
  // (docs/superpowers/ is gitignored scratch, so only docs/dev), and module/.
  const files = ['README.md', 'docs/dev', 'module'].flatMap((t) => [...walkDocs(join(REPO, t))]);
  assert.ok(files.length > 10, `self-scan found only ${files.length} docs`);
  const got = [];
  for (const file of files) {
    for (const f of volatileOf(analyzeProse(await parseDoc(file, readFileSync(file, 'utf8'))))) {
      got.push(`${relative(REPO, file)} ${f.code} ${quoted(f)}`);
    }
  }
  assert.deepEqual(got.sort(), SELF_SCAN_ALLOWED.map((e) => e.join(' ')).sort());
});

const bigDoc = (lines, extra = '') => `# T\n\n${extra}${Array(lines).fill('line').join('\n')}\n`;

test('SPLIT_CANDIDATE: a changelog or release-notes file is a ledger, never split', async () => {
  const size = THRESHOLDS.fileLines + 5;
  for (const name of ['CHANGELOG.md', 'changelog.adoc', 'docs/about/release-notes.md', 'HISTORY.md', 'NEWS.md']) {
    const src = name.endsWith('.adoc') ? `= T\n\n${Array(size).fill('line').join('\n')}\n` : bigDoc(size);
    assert.deepEqual((await analyze(src, name)).filter((f) => f.code === 'SPLIT_CANDIDATE'), [], name);
  }
  const section = `# T\n\n## Big\n\n${Array(THRESHOLDS.sectionLines + 5).fill('line').join('\n')}\n`;
  assert.deepEqual((await analyze(section, 'CHANGELOG.md')).filter((f) => f.code === 'SPLIT_CANDIDATE'), []);
});

test('SPLIT_CANDIDATE: a file that is itself a destination is not told to move content into itself', async () => {
  const sc = (await analyze(bigDoc(THRESHOLDS.fileLines + 5), 'SECURITY.md')).find((f) => f.code === 'SPLIT_CANDIDATE');
  assert.ok(!sc.message.includes('`SECURITY.md`'), sc.message);
  assert.ok(sc.message.includes('`CHANGELOG.md`'), sc.message);
});

test('SPLIT_CANDIDATE names the persona destinations from the registry', async () => {
  const md = `# T\n\n${Array(THRESHOLDS.fileLines + 5).fill('line').join('\n')}\n`;
  const sc = (await analyze(md)).find((f) => f.code === 'SPLIT_CANDIDATE' && f.line === 1);
  for (const dest of ['`docs/usage/`', '`CHANGELOG.md`', '`docs/dev/`', '`SECURITY.md`']) {
    assert.ok(sc.message.includes(dest), `missing ${dest}: ${sc.message}`);
  }
  assert.match(sc.message, /SKILL\.md/);
});
