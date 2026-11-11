import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, realpathSync, readFileSync, existsSync, symlinkSync, statSync, utimesSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { planRun, nextBatch, recordReply, collectRun, startSession, MAX_ATTEMPTS } from '../../../module/skills/docs-organization/scripts/lane6.mjs';

const dirs = [];
// Runs land under $XDG_CACHE_HOME/docs-audit; point it at a scratch dir so no test touches the real cache.
const cacheHome = realpathSync(mkdtempSync(join(tmpdir(), 'lane6-cache-')));
process.env.XDG_CACHE_HOME = cacheHome;
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  rmSync(cacheHome, { recursive: true, force: true });
});
function repo(files) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'lane6-repo-')));
  dirs.push(root);
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(root, p, '..'), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  return root;
}
const fence = (o) => '```json\n' + JSON.stringify(o) + '\n```\n';
const GROUND = (mode = 'how-to') => fence({ mode, audience: 'operators', outcome: 'sync tasks', mode_mixing: false });
const EMPTY = fence({ findings: [] });
const README = '# App\n\nRun `app sync --all` to sync.\n\n```mermaid\nflowchart LR\n  A-->B\n```\n';
const GUIDE = '# Guide\n\nIt is not uncommon to fail.\n';

async function planSweep(extra = {}) {
  const root = repo({ 'README.md': README, 'docs/guide.md': GUIDE });
  const res = await planRun({ scope: 'sweep', repoRoot: root, files: [join(root, 'README.md'), join(root, 'docs/guide.md')], ...extra });
  dirs.push(res.run);
  return { root, ...res };
}
const kinds = (jobs) => jobs.map((j) => j.kind);
const manifest = (run) => JSON.parse(readFileSync(join(run, 'manifest.json'), 'utf8'));
const replyFor = (j) => {
  if (j.kind === 'grounding') return GROUND(j.file.endsWith('README.md') ? 'landing' : 'how-to');
  if (j.kind === 'drift-extract') return fence({ claims: [] });
  return EMPTY;
};
async function drain(run, jobs, reply) {
  let batch = { status: 'dispatch', jobs };
  while (batch.status === 'dispatch') {
    for (const j of batch.jobs) recordReply(run, j.id, reply(j));
    batch = await nextBatch(run);
  }
  return batch;
}

test('plan: sweep creates wave-1 jobs per file; grounding first; prompt text inline', async () => {
  const { run, status, jobs } = await planSweep();
  assert.equal(status, 'dispatch');
  assert.equal(jobs[0].kind, 'grounding');
  assert.deepEqual(manifest(run).jobs.map((j) => j.kind).sort(), ['diagram-drift', 'drift-extract', 'drift-extract', 'grounding', 'grounding', 'plain-language', 'plain-language']);
  assert.match(jobs[0].prompt, /^Read-only:/);
  assert.equal(readFileSync(jobs[0].prompt_file, 'utf8'), jobs[0].prompt);
});

const sessionOf = (run) => dirname(run);
const projectOf = (run) => dirname(sessionOf(run));

test('plan: with no --session, the run lands in a new session under $XDG_CACHE_HOME/docs-audit/<project>, private to the user', async () => {
  const { run } = await planSweep();
  assert.equal(dirname(projectOf(run)), join(cacheHome, 'docs-audit'));
  assert.match(basename(projectOf(run)), /^[0-9a-f]{12}$/);
  assert.match(basename(sessionOf(run)), /^\d{8}-\d{6}-/);
  assert.match(basename(run), /^lane6-/);
  assert.equal(statSync(projectOf(run)).mode & 0o777, 0o700);
});

test('plan: a relative $XDG_CACHE_HOME is ignored; the run goes under $HOME/.cache', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'lane6-home-')));
  dirs.push(home);
  const saved = { XDG_CACHE_HOME: process.env.XDG_CACHE_HOME, HOME: process.env.HOME };
  process.env.XDG_CACHE_HOME = 'relative/cache';
  process.env.HOME = home;
  try {
    const { run } = await planSweep();
    assert.equal(dirname(projectOf(run)), join(home, '.cache', 'docs-audit'));
    assert.equal(existsSync('relative/cache'), false);
  } finally {
    Object.assign(process.env, saved);
  }
});

test('session: two audits started together get distinct directories', () => {
  const a = startSession().session;
  const b = startSession().session;
  assert.notEqual(a, b);
  assert.equal(dirname(a), dirname(b));
});

test('plan: --session puts the run inside the given session, beside the audit report', async () => {
  const { session } = startSession();
  const root = repo({ 'a.md': README });
  const res = await planRun({ scope: 'document', files: [join(root, 'a.md')], session });
  assert.equal(dirname(res.run), session);
});

test('plan: --session outside the audit cache is a usage error', async () => {
  const root = repo({ 'a.md': README });
  for (const session of [tmpdir(), join(cacheHome, 'docs-audit', 'nope'), join(cacheHome, 'docs-audit', '..')]) {
    await assert.rejects(planRun({ scope: 'document', files: [join(root, 'a.md')], session }), /not a session directory/);
  }
});

test('session: keeps the newest DOCS_AUDIT_SESSION_CACHE_MAX sessions and never the one just made', () => {
  const saved = process.env.DOCS_AUDIT_SESSION_CACHE_MAX;
  try {
    process.env.DOCS_AUDIT_SESSION_CACHE_MAX = '3';
    let session;
    for (let i = 0; i < 5; i++) {
      ({ session } = startSession());
      const when = new Date(Date.now() - (10 - i) * 60000);
      utimesSync(session, when, when);
    }
    assert.equal(readdirSync(dirname(session)).length, 3);
    process.env.DOCS_AUDIT_SESSION_CACHE_MAX = '0';
    const last = startSession().session;
    assert.deepEqual(readdirSync(dirname(last)), [basename(last)]);
  } finally {
    if (saved === undefined) delete process.env.DOCS_AUDIT_SESSION_CACHE_MAX;
    else process.env.DOCS_AUDIT_SESSION_CACHE_MAX = saved;
  }
});

test('session: a non-numeric cap falls back to 20', () => {
  const saved = process.env.DOCS_AUDIT_SESSION_CACHE_MAX;
  try {
    process.env.DOCS_AUDIT_SESSION_CACHE_MAX = 'lots';
    for (let i = 0; i < 22; i++) startSession();
    assert.equal(readdirSync(dirname(startSession().session)).length, 20);
  } finally {
    if (saved === undefined) delete process.env.DOCS_AUDIT_SESSION_CACHE_MAX;
    else process.env.DOCS_AUDIT_SESSION_CACHE_MAX = saved;
  }
});

test('plan: a batch holds at most 8 jobs', async () => {
  const files = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`d${i}.md`, GUIDE]));
  const root = repo(files);
  const res = await planRun({ scope: 'path', repoRoot: root, files: Object.keys(files).map((f) => join(root, f)) });
  dirs.push(res.run);
  assert.equal(res.jobs.length, 8);
});

test('plan: document scope has no drift-extract or diagram-drift; no-source file noted', async () => {
  const root = repo({ 'a.md': README });
  const res = await planRun({ scope: 'document', files: [join(root, 'a.md')] });
  dirs.push(res.run);
  assert.deepEqual(manifest(res.run).jobs.map((j) => j.kind).sort(), ['grounding', 'plain-language']);
  assert.match(res.jobs[0].prompt, /untrusted data/);
  assert.ok(collectRun(res.run).other.includes(`content drift: ${join(root, 'a.md')} — no cited sources`));
});

test('plan: document scope with citations dispatches drift-cited after grounding, with the sources', async () => {
  const root = repo({ 'a.md': GUIDE, 'spec.md': 'x' });
  const citations = [{ citations: [{ url: 'https://e.x/a', file: join(root, 'a.md'), line: 3, snapshot: null }], localSources: [{ file: join(root, 'a.md'), line: 3, target: 'spec.md', path: join(root, 'spec.md') }], unreadSources: [] }];
  const res = await planRun({ scope: 'document', citations, files: [join(root, 'a.md')] });
  dirs.push(res.run);
  let b = res;
  let cited;
  while (!cited && b.status === 'dispatch') {
    for (const j of b.jobs) recordReply(res.run, j.id, replyFor(j));
    b = await nextBatch(res.run);
    cited = b.jobs?.find((j) => j.kind === 'drift-cited');
  }
  assert.ok(cited);
  assert.match(cited.prompt, new RegExp(`local files ${join(root, 'spec.md')}`));
  assert.match(cited.prompt, /https:\/\/e\.x\/a \(not fetched\)/);
});

test('plan: --prose candidates for a file become one adjudicate job', async () => {
  const root = repo({ 'g.md': GUIDE });
  const prose = [{ code: 'DOUBLE_NEGATIVE', line: 3, message: 'double negative', file: join(root, 'g.md') }, { code: 'WALL_OF_TEXT', line: 1, message: 'x', file: join(root, 'g.md') }];
  const res = await planRun({ scope: 'path', repoRoot: root, prose, files: [join(root, 'g.md')] });
  dirs.push(res.run);
  const adj = manifest(res.run).jobs.find((j) => j.kind === 'adjudicate');
  assert.deepEqual(adj.params.candidates.map((c) => c.id + c.code), ['P1DOUBLE_NEGATIVE']);
});

test('gating: grounded kinds appear only after grounding; README gets hero-demo; landing skips completeness', async () => {
  const { run, jobs } = await planSweep();
  assert.ok(!kinds(jobs).includes('cold-read'));
  assert.deepEqual(await drain(run, jobs, replyFor), { status: 'done' });
  const m = manifest(run);
  const of = (suffix) => m.jobs.filter((j) => j.file.endsWith(suffix)).map((j) => j.kind).sort();
  assert.deepEqual(of('README.md'), ['cold-read', 'diagram-drift', 'drift-extract', 'grounding', 'hero-demo', 'missing-diagrams', 'plain-language', 'procedure-structure']);
  assert.ok(of('guide.md').includes('completeness'));
  assert.ok(!of('guide.md').includes('hero-demo'));
  const out = collectRun(run);
  assert.deepEqual(out.findings, []);
  assert.equal(out.modes[m.files[0].file], 'landing');
});

test('grounded prompt carries the grounding note', async () => {
  const { run, jobs } = await planSweep();
  let batch = { jobs };
  let cold;
  while (!cold) {
    for (const j of batch.jobs) recordReply(run, j.id, replyFor(j));
    batch = await nextBatch(run);
    cold = batch.jobs.find((j) => j.kind === 'cold-read');
  }
  assert.match(cold.prompt, /Diátaxis mode: (landing|how-to)/);
  assert.match(cold.prompt, /audience: operators/);
});

test('retry: invalid until MAX_ATTEMPTS → failed → LANE_FAILED names the kind and its skipped dependents', async () => {
  const { run, jobs } = await planSweep();
  const g = jobs.find((j) => j.kind === 'grounding');
  const bad = recordReply(run, g.id, 'not json');
  assert.equal(bad.status, 'invalid');
  assert.equal(bad.retry, true);
  for (let i = 1; i < MAX_ATTEMPTS; i++) {
    const b = await nextBatch(run);
    const again = b.jobs.find((j) => j.id === g.id);
    assert.ok(again, `attempt ${i + 1} re-dispatched`);
    assert.match(again.prompt, /Your previous reply was rejected: no JSON object/);
    for (const j of b.jobs) recordReply(run, j.id, j.id === g.id ? 'still not json' : replyFor(j));
  }
  assert.deepEqual(await nextBatch(run), { status: 'done' });
  const lf = collectRun(run).findings.filter((f) => f.code === 'LANE_FAILED');
  assert.equal(lf.length, 1);
  assert.equal(lf[0].severity, 'warning');
  assert.match(lf[0].note, /Grounding \(no JSON object/);
  assert.match(lf[0].note, /Cold read \(grounding failed\)/);
  assert.match(lf[0].note, /Hero demo \(grounding failed\)/);
});

test('no reply recorded counts as an attempt', async () => {
  const { run, jobs } = await planSweep();
  for (let i = 0; i < MAX_ATTEMPTS; i++) await nextBatch(run);
  const j = manifest(run).jobs.find((x) => x.id === jobs[0].id);
  assert.equal(j.status, 'failed');
  assert.equal(j.reason, 'no reply was recorded');
});

test('record: idempotent on ok; unknown id and undispatched job rejected; EOF line rejected; raw kept', async () => {
  const { run, jobs } = await planSweep();
  assert.deepEqual(recordReply(run, jobs[0].id, GROUND()), { status: 'ok' });
  assert.deepEqual(recordReply(run, jobs[0].id, 'garbage'), { status: 'ok' });
  assert.equal(recordReply(run, '999-grounding', GROUND()).retry, false);
  const files = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`d${i}.md`, GUIDE]));
  const root = repo(files);
  const big = await planRun({ scope: 'path', repoRoot: root, files: Object.keys(files).map((f) => join(root, f)) });
  dirs.push(big.run);
  const later = manifest(big.run).jobs.find((j) => j.status === 'due');
  assert.match(recordReply(big.run, later.id, EMPTY).reason, /not dispatched/);
  const { eof } = manifest(run);
  assert.match(recordReply(run, jobs[1].id, `x\n${eof}\n` + EMPTY).reason, new RegExp(eof));
  assert.ok(existsSync(join(run, 'results', `${jobs[1].id}.1.raw.md`)));
});

test('drift: claims numbered across extracts, verified, partial reply re-batched, coverage line', async () => {
  const { run, jobs, root } = await planSweep();
  const claim = { kind: 'fact', line: '3', quote: 'Run `app sync --all` to sync.', target: 'cli' };
  const reply = (j) => {
    if (j.kind === 'drift-extract' && j.file.endsWith('README.md')) return fence({ claims: [claim, { ...claim, line: 3 }] });
    if (j.kind === 'drift-verify') {
      const first = manifest(run).jobs.find((x) => x.id === j.id).params.claims[0];
      return fence({ verdicts: [{ id: first.id, verdict: 'drift', evidence: 'cli.js:1', code_says: '--all removed', instructs: true }] });
    }
    return replyFor(j);
  };
  await drain(run, jobs, reply);
  const out = collectRun(run);
  const drift = out.findings.filter((f) => f.code === 'CONTENT_DRIFT' && f.line === 3);
  assert.equal(drift.length, 2);
  assert.equal(drift[0].severity, 'blocker');
  assert.ok(out.other.includes(`content drift: ${join(root, 'README.md')} — 2 claims, 2 drift, 0 unverifiable`));
});

test('drift-verify ids still missing after retries are named in LANE_FAILED', async () => {
  const { run, jobs } = await planSweep();
  const claim = { kind: 'fact', line: '3', quote: 'Run `app sync --all` to sync.', target: 'cli' };
  const reply = (j) => {
    if (j.kind === 'drift-extract' && j.file.endsWith('README.md')) return fence({ claims: [claim, claim] });
    if (j.kind === 'drift-verify') return fence({ verdicts: [] });
    return replyFor(j);
  };
  await drain(run, jobs, reply);
  const lf = collectRun(run).findings.find((f) => f.code === 'LANE_FAILED');
  assert.match(lf.note, /Content drift \(verify\) claims C1, C2/);
});

test('collect before done reports unfinished jobs and never-created dependents', async () => {
  const { run } = await planSweep();
  const out = collectRun(run);
  const lf = out.findings.filter((f) => f.code === 'LANE_FAILED');
  assert.equal(lf.length, 2);
  assert.match(lf[0].note, /not finished before collect/);
  assert.match(lf[0].note, /Cold read \(never dispatched\)/);
  assert.ok(out.other.some((l) => l.startsWith('lane 6 run: ')));
});

test('note cells escape pipes and newlines', async () => {
  const { run, jobs } = await planSweep();
  const reply = (j) => (j.kind === 'cold-read' && j.file.endsWith('guide.md')
    ? fence({ findings: [{ line: 3, quote: 'It is not uncommon to fail.', why: 'a | b\nc', actionable: false }] })
    : replyFor(j));
  await drain(run, jobs, reply);
  const f = collectRun(run).findings.find((x) => x.code === 'COLD_READ');
  assert.equal(f.note, '"It is not uncommon to fail." — a \\| b c');
});

test('eof: random per run, in plan and next output, in no rendered prompt', async () => {
  const a = await planSweep();
  const b = await planSweep();
  assert.match(a.eof, /^LANE6_EOF_[0-9a-f]{16}$/);
  assert.notEqual(a.eof, b.eof);
  assert.equal(manifest(a.run).eof, a.eof);
  assert.equal((await nextBatch(a.run)).eof, a.eof);
  for (const j of a.jobs) assert.ok(!j.prompt.includes(a.eof));
});

test('symlink and its target in a sweep are one set of jobs, under the real path', async () => {
  const root = repo({ 'docs/guide.md': GUIDE });
  symlinkSync(join(root, 'docs/guide.md'), join(root, 'link.md'));
  const res = await planRun({ scope: 'sweep', repoRoot: root, files: [join(root, 'link.md'), join(root, 'docs/guide.md'), join(root, 'docs/guide.md')] });
  dirs.push(res.run);
  const m = manifest(res.run);
  assert.deepEqual(m.files.map((f) => f.file), [join(root, 'docs/guide.md')]);
  assert.equal(m.jobs.filter((j) => j.kind === 'grounding').length, 1);
  assert.ok(m.jobs.every((j) => j.file === join(root, 'docs/guide.md')));
});

test('document scope keeps the given path but dedupes by realpath', async () => {
  const root = repo({ 'a.md': GUIDE });
  symlinkSync(join(root, 'a.md'), join(root, 'link.md'));
  const res = await planRun({ scope: 'document', files: [join(root, 'link.md'), join(root, 'a.md')] });
  dirs.push(res.run);
  assert.deepEqual(manifest(res.run).files.map((f) => f.file), [join(root, 'link.md')]);
});

test('prose filed under a symlink target matches a symlink-only list; citations match by realpath', async () => {
  const root = repo({ 'docs/guide.md': GUIDE });
  symlinkSync(join(root, 'docs/guide.md'), join(root, 'link.md'));
  const prose = [{ code: 'DOUBLE_NEGATIVE', line: 3, message: 'double negative', file: join(root, 'docs/guide.md') }];
  const res = await planRun({ scope: 'path', repoRoot: root, prose, files: [join(root, 'link.md')] });
  dirs.push(res.run);
  const m = manifest(res.run);
  assert.equal(m.jobs.find((j) => j.kind === 'adjudicate').params.candidates.length, 1);
  assert.deepEqual(m.unmatched, []);
  const citations = [{ citations: [{ url: 'https://e.x/a', file: join(root, 'docs/guide.md'), line: 3, snapshot: null }], localSources: [], unreadSources: [] }];
  const doc = await planRun({ scope: 'document', citations, files: [join(root, 'link.md')] });
  dirs.push(doc.run);
  assert.deepEqual(manifest(doc.run).files[0].sources.unread, ['https://e.x/a (not fetched)']);
});

test('a prose candidate for an unplanned file is emitted unjudged with a LANE_FAILED', async () => {
  const root = repo({ 'g.md': GUIDE, 'other.md': GUIDE });
  const prose = [{ code: 'DOUBLE_NEGATIVE', line: 3, message: 'double negative', file: join(root, 'other.md') }];
  const res = await planRun({ scope: 'path', repoRoot: root, prose, files: [join(root, 'g.md')] });
  dirs.push(res.run);
  const out = collectRun(res.run);
  const f = out.findings.find((x) => x.code === 'DOUBLE_NEGATIVE');
  assert.equal(f.file, join(root, 'other.md'));
  assert.equal(f.note, 'double negative (not adjudicated)');
  const lf = out.findings.find((x) => x.code === 'LANE_FAILED' && x.file === join(root, 'other.md'));
  assert.match(lf.note, /Lane 3 adjudication \(file not in the Lane 6 plan\)/);
});

test('drift-verify retry may repeat answered ids; first answer wins, no duplicate findings', async () => {
  const { run, jobs } = await planSweep();
  const claim = { kind: 'fact', line: '3', quote: 'Run `app sync --all` to sync.', target: 'cli' };
  const v = (id, instructs) => ({ id, verdict: 'drift', evidence: 'cli.js:1', code_says: 'gone', instructs });
  let verifies = 0;
  const reply = (j) => {
    if (j.kind === 'drift-extract' && j.file.endsWith('README.md')) return fence({ claims: [claim, claim] });
    if (j.kind === 'drift-verify') return fence({ verdicts: verifies++ === 0 ? [v('C1', true)] : [v('C1', false), v('C2', false)] });
    return replyFor(j);
  };
  await drain(run, jobs, reply);
  assert.equal(manifest(run).jobs.find((j) => j.kind === 'drift-verify').status, 'ok');
  const out = collectRun(run);
  const drift = out.findings.filter((f) => f.code === 'CONTENT_DRIFT');
  assert.equal(drift.length, 2);
  assert.equal(drift[0].severity, 'blocker');
  assert.ok(!out.findings.some((f) => f.code === 'LANE_FAILED'));
});

test('collect settles a dispatched job whose reply was recorded, without writing the manifest', async () => {
  const root = repo({ 'g.md': GUIDE });
  const res = await planRun({ scope: 'document', files: [join(root, 'g.md')] });
  dirs.push(res.run);
  const g = res.jobs.find((j) => j.kind === 'grounding');
  recordReply(res.run, g.id, GROUND());
  const before = readFileSync(join(res.run, 'manifest.json'), 'utf8');
  const out = collectRun(res.run);
  assert.equal(out.modes[join(root, 'g.md')], 'how-to');
  assert.ok(!out.findings.some((f) => f.code === 'LANE_FAILED' && /Grounding/.test(f.note)));
  assert.equal(readFileSync(join(res.run, 'manifest.json'), 'utf8'), before);
});

test('no coverage line when no drift-extract job for the file ended ok', async () => {
  const { run, jobs, root } = await planSweep();
  const reply = (j) => (j.kind === 'drift-extract' ? 'garbage' : replyFor(j));
  await drain(run, jobs, reply);
  const out = collectRun(run);
  assert.ok(!out.other.some((l) => l.startsWith(`content drift: ${join(root, 'README.md')}`)));
  assert.match(out.findings.find((f) => f.code === 'LANE_FAILED' && f.file === join(root, 'README.md')).note, /Content drift \(extract\)/);
});

test('document scope: a mermaid block and a .mmd file plan no diagram-drift and no LANE_FAILED', async () => {
  const root = repo({ 'a.md': README, 'd.mmd': 'flowchart LR\n  A-->B\n' });
  const res = await planRun({ scope: 'document', files: [join(root, 'a.md'), join(root, 'd.mmd')] });
  dirs.push(res.run);
  await drain(res.run, res.jobs, replyFor);
  assert.ok(!manifest(res.run).jobs.some((j) => j.kind === 'diagram-drift'));
  assert.ok(!collectRun(res.run).findings.some((f) => f.code === 'LANE_FAILED'));
});

test('{{mode}} in a file name or candidate message stays literal in the prompt', async () => {
  const root = repo({ 'a{{mode}}.md': GUIDE });
  const file = join(root, 'a{{mode}}.md');
  const prose = [{ code: 'DOUBLE_NEGATIVE', line: 3, message: 'says {{mode}} twice', file }];
  const res = await planRun({ scope: 'path', repoRoot: root, prose, files: [file] });
  dirs.push(res.run);
  let b = res;
  let adj;
  while (!adj && b.status === 'dispatch') {
    for (const j of b.jobs) recordReply(res.run, j.id, replyFor(j));
    b = await nextBatch(res.run);
    adj = b.jobs?.find((j) => j.kind === 'adjudicate');
  }
  assert.ok(adj.prompt.includes('says {{mode}} twice'));
  assert.ok(adj.prompt.includes('a{{mode}}.md'));
});

const CLI = fileURLToPath(new URL('../../../module/skills/docs-organization/scripts/lane6.mjs', import.meta.url));
const cli = (args, input) => spawnSync(process.execPath, [CLI, ...args], { input, encoding: 'utf8' });

test('CLI: plan → record → next → collect round trip', () => {
  const root = repo({ 'docs/a.md': GUIDE });
  const prose = join(root, 'prose.json');
  writeFileSync(prose, JSON.stringify({ status: 'findings', scanned: 1, findings: [{ code: 'DOUBLE_NEGATIVE', line: 3, message: 'm', file: join(root, 'docs/a.md') }] }));
  const plan = cli(['plan', '--scope', 'path', '--repo-root', root, '--prose', prose, join(root, 'docs/a.md')]);
  assert.equal(plan.status, 0, plan.stderr);
  const { run, jobs } = JSON.parse(plan.stdout);
  dirs.push(run);
  const rec = cli(['record', run, jobs[0].id], 'nope');
  assert.equal(rec.status, 1);
  assert.equal(JSON.parse(rec.stdout).status, 'invalid');
  assert.equal(cli(['next', run]).status, 0);
  const col = cli(['collect', run]);
  assert.equal(col.status, 0);
  assert.equal(JSON.parse(col.stdout).status, 'collected');
});

// Observed on a real repo: collect's 151 KB of JSON reached a pipe cut at
// 64 KB, because process.exit() ran before stdout drained. The orchestrator
// reads every subcommand through a pipe, and a batch of prompts can pass 64 KB.
test('CLI: output larger than a pipe buffer arrives whole', () => {
  const root = repo({ 'docs/a.md': GUIDE });
  const prose = join(root, 'prose.json');
  const findings = Array.from({ length: 1500 }, (_, i) => ({ code: 'DOUBLE_NEGATIVE', line: 3, message: `double negative number ${i}: "not uncommon"; state it positively`, file: join(root, 'docs/a.md') }));
  writeFileSync(prose, JSON.stringify({ status: 'findings', scanned: 1, findings }));
  const plan = cli(['plan', '--scope', 'path', '--repo-root', root, '--prose', prose, join(root, 'docs/a.md')]);
  assert.equal(plan.status, 0, plan.stderr);
  assert.ok(plan.stdout.length > 65536, `plan printed only ${plan.stdout.length} bytes; the test needs more than a pipe buffer`);
  const { run } = JSON.parse(plan.stdout);
  dirs.push(run);
  const col = cli(['collect', run]);
  assert.equal(col.status, 0, col.stderr);
  assert.ok(col.stdout.length > 65536, `collect printed only ${col.stdout.length} bytes`);
  assert.equal(JSON.parse(col.stdout).findings.filter((f) => f.code === 'DOUBLE_NEGATIVE').length, 1500);
});

test('CLI: a stale lock makes next exit 2', async () => {
  const { run } = await planSweep();
  writeFileSync(join(run, '.lock'), '');
  const r = cli(['next', run]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /another lane6 plan or next is running/);
});

test('CLI: session prints a fresh session directory; extra arguments are a usage error', () => {
  const r = cli(['session']);
  assert.equal(r.status, 0);
  const { status, session } = JSON.parse(r.stdout);
  assert.equal(status, 'session');
  assert.ok(statSync(session).isDirectory());
  assert.equal(cli(['session', 'extra']).status, 2);
});

test('CLI: usage errors exit 2', () => {
  assert.equal(cli([]).status, 2);
  assert.equal(cli(['plan', '--scope', 'nope', 'x.md']).status, 2);
  assert.equal(cli(['plan', '--scope', 'sweep', 'x.md']).status, 2);
  assert.equal(cli(['plan', '--scope', 'path', '--repo-root']).status, 2);
  assert.equal(cli(['next', '/nonexistent-run']).status, 2);
  assert.equal(cli(['record', tmpdir(), '../../etc'], '').status, 2);
});
