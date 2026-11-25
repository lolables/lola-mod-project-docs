import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KINDS, extractJson, unjudged } from '../../../module/skills/docs-organization/scripts/lane6-kinds.mjs';

const TEXT = '# Title\n\nRun `app sync --all` to sync.\nIt is not uncommon to fail.\nTasks live in `~/.app.json`.\n';
const ctx = (over = {}) => ({ file: 'doc.md', text: TEXT, lines: 5, start: 1, end: 5, ...over });
const job = (kind, params = {}) => ({ id: '001-' + kind, kind, file: 'doc.md', params });

// Observed in a smoke run: the orchestrator HTML-escaped `>` while copying a
// reply into the record heredoc, so a correct quote of "> Mirrors …" failed.
test('extractJson decodes HTML entities an orchestrator added while copying the reply', () => {
  assert.deepEqual(extractJson('```json\n{"quote":"&gt; a &lt;b&gt; &amp; \\&quot;c\\&quot; &#39;d&#39; &amp;gt;"}\n```'), { quote: '> a <b> & "c" \'d\' &gt;' });
  assert.deepEqual(extractJson('{&quot;a&quot;: 1}'), { a: 1 });
});

test('a quote matches the file whether the entity is in the reply or in the file', () => {
  const c = { kind: 'fact', line: '1', target: '?' };
  const text = '> Mirrors code between forges.\nTom &amp; Jerry\n';
  const cx = { file: 'doc.md', text, lines: 2, start: 1, end: 2 };
  assert.equal(KINDS['drift-extract'].validate({ claims: [{ ...c, quote: '> Mirrors code between forges.' }] }, cx).ok, true);
  assert.equal(KINDS['drift-extract'].validate({ claims: [{ ...c, line: '2', quote: 'Tom & Jerry' }] }, cx).ok, true);
  assert.equal(KINDS['drift-extract'].validate({ claims: [{ ...c, quote: 'Mirrors nothing' }] }, cx).ok, false);
});

// Observed on a real repo: subagents elide the middle of a long quote with
// "..." (10 of 43 drift-extract replies). Each fragment must appear in order.
test('a quote with an ellipsis in the middle matches when its fragments appear in order', () => {
  const c = { kind: 'fact', line: '1', target: '?' };
  const text = 'probe_timeout: 0  # seconds for the per-job model probe; 0 means llm.timeout (global-only)\n';
  const cx = { file: 'doc.md', text, lines: 1, start: 1, end: 1 };
  const ok = (quote) => KINDS['drift-extract'].validate({ claims: [{ ...c, quote }] }, cx).ok;
  assert.equal(ok('probe_timeout: 0  # seconds for the per-job model probe ... 0 means llm.timeout ... (global-only)'), true);
  assert.equal(ok('probe_timeout: 0 … llm.timeout'), true);
  assert.equal(ok('llm.timeout ... probe_timeout: 0'), false);
  assert.equal(ok('probe_timeout: 0 ... invented text'), false);
  assert.equal(ok('... ...'), false);
});

// Observed on a real repo: a quote that starts mid-sentence lower-cases the
// sentence's first word ("The archive query" quoted as "the archive query").
test('quote matching ignores case', () => {
  const cx = { file: 'doc.md', text: 'The archive query and\n  the purge plan match.\n', lines: 2, start: 1, end: 2 };
  const ok = (quote) => KINDS['drift-extract'].validate({ claims: [{ kind: 'fact', line: '1', target: '?', quote }] }, cx).ok;
  assert.equal(ok('the archive query and the purge plan match'), true);
  assert.equal(ok('the archive query matches'), false);
});

test('extractJson takes the last fenced json block, else the bare object', () => {
  assert.deepEqual(extractJson('x\n```json\n{"a":1}\n```\ny\n```json\n{"a":2}\n```\n'), { a: 2 });
  assert.deepEqual(extractJson('Here: {"a":3} done'), { a: 3 });
  assert.throws(() => extractJson('no json here'));
});

test('grounding: valid, bad mode, landing cannot mix, quote must be in the file, word cap', () => {
  const ok = { mode: 'how-to', audience: 'operators', outcome: 'sync tasks', mode_mixing: false };
  assert.equal(KINDS.grounding.validate(ok, ctx()).ok, true);
  assert.match(KINDS.grounding.validate({ ...ok, mode: 'guide' }, ctx()).reason, /mode "guide"/);
  const mix = { intruding: 'explanation', section: 'Title', quote: 'It is not uncommon to fail.' };
  assert.equal(KINDS.grounding.validate({ ...ok, mode_mixing: mix }, ctx()).ok, true);
  assert.match(KINDS.grounding.validate({ ...ok, mode: 'landing', mode_mixing: mix }, ctx()).reason, /landing/);
  assert.match(KINDS.grounding.validate({ ...ok, mode_mixing: { ...mix, quote: 'invented' } }, ctx()).reason, /quote/);
  assert.match(KINDS.grounding.validate({ ...ok, audience: 'word '.repeat(71) }, ctx()).reason, /70 words/);
});

test('grounding maps mode_mixing to MODE_MIXING info', () => {
  const p = { mode: 'how-to', audience: 'a', outcome: 'b', mode_mixing: { intruding: 'explanation', section: 'Why', quote: 'x' } };
  const { findings } = KINDS.grounding.toFindings(p, job('grounding'));
  assert.deepEqual(findings.map((f) => [f.code, f.severity]), [['MODE_MIXING', 'info']]);
  assert.equal(KINDS.grounding.toFindings({ ...p, mode_mixing: false }, job('grounding')).findings.length, 0);
});

test('plain-language: line outside chunk, missing quote, bad code, no array are invalid', () => {
  const f = { code: 'NOUN_STRING', line: 3, quote: 'Run app sync --all to sync.', why: 'w', rewrite: 'r' };
  assert.equal(KINDS['plain-language'].validate({ findings: [f] }, ctx({ start: 3, end: 4 })).ok, true);
  assert.match(KINDS['plain-language'].validate({ findings: [{ ...f, line: 5 }] }, ctx({ start: 3, end: 4 })).reason, /outside lines 3-4/);
  assert.match(KINDS['plain-language'].validate({ findings: [{ ...f, quote: 'nope' }] }, ctx()).reason, /not in the file/);
  assert.match(KINDS['plain-language'].validate({ findings: [{ ...f, code: 'X' }] }, ctx()).reason, /code "X"/);
  assert.match(KINDS['plain-language'].validate({}, ctx()).reason, /no "findings" array/);
});

test('drift-extract: ranges start inside the chunk and end inside the file; kind enum', () => {
  const c = { kind: 'set', line: '3-5', quote: 'Run `app sync --all` to sync.', target: 'cli' };
  assert.equal(KINDS['drift-extract'].validate({ claims: [c] }, ctx({ start: 3, end: 4 })).ok, true);
  assert.equal(KINDS['drift-extract'].validate({ claims: [] }, ctx()).ok, true);
  assert.match(KINDS['drift-extract'].validate({ claims: [{ ...c, line: '1' }] }, ctx({ start: 3, end: 4 })).reason, /line "1"/);
  assert.match(KINDS['drift-extract'].validate({ claims: [{ ...c, line: '4-9' }] }, ctx()).reason, /line "4-9"/);
  assert.match(KINDS['drift-extract'].validate({ claims: [{ ...c, kind: 'opinion' }] }, ctx()).reason, /kind "opinion"/);
});

test('drift-verify: unknown or duplicate id invalid; partial reply valid; drift needs instructs', () => {
  const claims = [{ id: 'C1', kind: 'fact', line: '3', quote: 'app sync --all', target: 'cli' }, { id: 'C2', kind: 'fact', line: '5', quote: '~/.app.json', target: 'cfg' }];
  const v = (o) => ({ id: 'C1', verdict: 'match', evidence: 'cli.js:1', ...o });
  assert.equal(KINDS['drift-verify'].validate({ verdicts: [v()] }, ctx({ claims })).ok, true);
  assert.match(KINDS['drift-verify'].validate({ verdicts: [v({ id: 'C9' })] }, ctx({ claims })).reason, /names no listed claim/);
  assert.match(KINDS['drift-verify'].validate({ verdicts: [v(), v()] }, ctx({ claims })).reason, /two verdicts/);
  assert.match(KINDS['drift-verify'].validate({ verdicts: [v({ verdict: 'drift', code_says: 'x' })] }, ctx({ claims })).reason, /instructs/);
});

test('drift-verify maps drift by instructs: blocker or warning', () => {
  const allClaims = [{ id: 'C1', kind: 'fact', line: '3', quote: 'app sync --all', target: 'cli' }, { id: 'C2', kind: 'set', line: '5-6', quote: 'x', target: 't' }];
  const verdicts = [
    { id: 'C1', verdict: 'drift', evidence: 'cli.js:9', code_says: '--all removed', instructs: true },
    { id: 'C2', verdict: 'drift', evidence: 'cfg.js:2', code_says: 'moved', instructs: false },
  ];
  const { findings } = KINDS['drift-verify'].toFindings({ verdicts }, job('drift-verify', { allClaims }));
  assert.deepEqual(findings.map((f) => [f.code, f.severity, f.line]), [['CONTENT_DRIFT', 'blocker', 3], ['CONTENT_DRIFT', 'warning', 5]]);
});

test('cold-read: actionable is warning with prefix, else info', () => {
  const f = { line: 3, quote: 'Run `app sync --all` to sync.', why: 'w', actionable: true };
  assert.equal(KINDS['cold-read'].validate({ findings: [f] }, ctx()).ok, true);
  assert.match(KINDS['cold-read'].validate({ findings: [{ ...f, actionable: 'yes' }] }, ctx()).reason, /actionable/);
  const out = KINDS['cold-read'].toFindings({ findings: [f, { ...f, actionable: false }] }, job('cold-read')).findings;
  assert.deepEqual(out.map((x) => x.severity), ['warning', 'info']);
  assert.match(out[0].note, /^actionable: /);
});

const PROV = { code: 'PROVENANCE_NARRATION', line: 4, quote: 'It is not uncommon to fail', why: 'the reader needs the rate, not the history', rewrite: 'It often fails.' };
const OFF = { code: 'OFF_AUDIENCE', line: 5, quote: 'Tasks live in ~/.app.json', why: 'an operator never edits it', destination: 'docs/dev/ (Dev persona)' };

test('audience-fit: code, line, quote, why, and the per-code rewrite or destination', () => {
  const v = (f) => KINDS['audience-fit'].validate({ findings: [f] }, ctx());
  assert.equal(KINDS['audience-fit'].validate({ findings: [PROV, OFF] }, ctx()).ok, true);
  assert.equal(v({ ...PROV, destination: undefined }).ok, true);
  assert.equal(v({ ...OFF, rewrite: undefined }).ok, true);
  assert.match(v({ ...PROV, code: 'COLD_READ' }).reason, /code "COLD_READ"/);
  assert.match(v({ ...PROV, line: 0 }).reason, /outside lines 1-5/);
  assert.match(v({ ...PROV, line: 6 }).reason, /outside lines 1-5/);
  assert.match(v({ ...PROV, quote: 'never said' }).reason, /not in the file/);
  assert.match(v({ ...PROV, quote: undefined }).reason, /not in the file/);
  assert.match(v({ ...PROV, line: '4' }).reason, /outside lines 1-5/);
  assert.match(v({ ...OFF, destination: 42 }).reason, /OFF_AUDIENCE without a destination/);
  assert.match(v({ ...PROV, why: ' ' }).reason, /no why/);
  assert.match(v({ ...PROV, rewrite: undefined }).reason, /PROVENANCE_NARRATION without a rewrite/);
  assert.match(v({ ...OFF, destination: '' }).reason, /OFF_AUDIENCE without a destination/);
  assert.match(KINDS['audience-fit'].validate({}, ctx()).reason, /no "findings" array/);
});

test('audience-fit maps both codes to info with their note formats', () => {
  assert.deepEqual(KINDS['audience-fit'].toFindings({ findings: [PROV, OFF] }, job('audience-fit')), {
    findings: [
      { code: 'PROVENANCE_NARRATION', severity: 'info', file: 'doc.md', line: 4, note: '"It is not uncommon to fail" — the reader needs the rate, not the history; rewrite: "It often fails."' },
      { code: 'OFF_AUDIENCE', severity: 'info', file: 'doc.md', line: 5, note: '"Tasks live in ~/.app.json" — an operator never edits it; move to: docs/dev/ (Dev persona)' },
    ],
    other: [],
  });
  assert.equal(KINDS['audience-fit'].groundingNote, true);
  assert.equal(KINDS['audience-fit'].label, 'Audience fit');
});

test('missing-diagrams type enum; hero-demo at most one; completeness line may be null; steps positive', () => {
  assert.match(KINDS['missing-diagrams'].validate({ findings: [{ section: 'S', line: 1, type: 'pie', why: 'w' }] }, ctx()).reason, /type "pie"/);
  const demo = { commands: ['app sync'], success: 's', format: 'asciinema' };
  assert.equal(KINDS['hero-demo'].validate({ findings: [demo] }, ctx()).ok, true);
  assert.match(KINDS['hero-demo'].validate({ findings: [demo, demo] }, ctx()).reason, /at most one/);
  assert.equal(KINDS.completeness.validate({ findings: [{ line: null, missing: 'm', blocks: 'b' }] }, ctx()).ok, true);
  assert.match(KINDS['procedure-structure'].validate({ findings: [{ line: 1, run: 'r', steps: 0, why: 'w' }] }, ctx()).reason, /steps/);
});

test('drift-cited: NOT_VERIFIABLE is info; CONTENT_DRIFT needs source_says and instructs', () => {
  const nv = { code: 'NOT_VERIFIABLE', line: 3, claim: 'c', source: 'https://x' };
  const cd = { code: 'CONTENT_DRIFT', line: 3, claim: 'c', source: 'spec.md', source_says: 's', instructs: false };
  assert.equal(KINDS['drift-cited'].validate({ findings: [nv, cd] }, ctx()).ok, true);
  assert.match(KINDS['drift-cited'].validate({ findings: [{ ...cd, instructs: undefined }] }, ctx()).reason, /instructs/);
  const out = KINDS['drift-cited'].toFindings({ findings: [nv, cd] }, job('drift-cited')).findings;
  assert.deepEqual(out.map((f) => [f.code, f.severity]), [['NOT_VERIFIABLE', 'info'], ['CONTENT_DRIFT', 'warning']]);
});

test('diagram-drift is always a CONTENT_DRIFT warning at the diagram line', () => {
  const out = KINDS['diagram-drift'].toFindings({ findings: [{ element: 'A-->B', code_says: 'B gone', evidence: 'b.js:1' }] }, job('diagram-drift', { startLine: 40 })).findings;
  assert.deepEqual(out.map((f) => [f.code, f.severity, f.line]), [['CONTENT_DRIFT', 'warning', 40]]);
});

test('adjudicate: every id once; suppress only volatile/time; maps keep/drop/suppress; unjudged fallback', () => {
  const candidates = [
    { id: 'P1', code: 'DOUBLE_NEGATIVE', line: 4, message: 'double negative: "not uncommon"' },
    { id: 'P2', code: 'SLASH_ALTERNATIVE', line: 3, message: 'slash' },
    { id: 'P3', code: 'VOLATILE_DETAIL', line: 5, message: 'volatile' },
  ];
  const c = ctx({ candidates });
  const d = [{ id: 'P1', decision: 'keep', reason: '' }, { id: 'P2', decision: 'drop', reason: 'a path' }, { id: 'P3', decision: 'suppress', reason: 'changelog' }];
  assert.equal(KINDS.adjudicate.validate({ decisions: d }, c).ok, true);
  assert.match(KINDS.adjudicate.validate({ decisions: d.slice(0, 2) }, c).reason, /no decision for P3/);
  assert.match(KINDS.adjudicate.validate({ decisions: [d[0], { id: 'P2', decision: 'suppress', reason: 'x' }, d[2]] }, c).reason, /cannot be suppressed/);
  assert.match(KINDS.adjudicate.validate({ decisions: [d[0], { id: 'P2', decision: 'drop', reason: '' }, d[2]] }, c).reason, /no reason/);
  const out = KINDS.adjudicate.toFindings({ decisions: d }, job('adjudicate', { candidates }));
  assert.deepEqual(out.findings.map((f) => f.code), ['DOUBLE_NEGATIVE']);
  assert.deepEqual(out.other, [
    'dropped: SLASH_ALTERNATIVE — doc.md:3 — a path; not for /docs-update',
    'suppressed: VOLATILE_DETAIL — doc.md (changelog); not for /docs-update',
  ]);
  assert.match(unjudged(job('adjudicate', { candidates }))[0].note, /\(not adjudicated\)$/);
});

test('every kind has a label and the two hooks', () => {
  assert.deepEqual(Object.keys(KINDS).sort(), ['adjudicate', 'audience-fit', 'cold-read', 'completeness', 'diagram-drift', 'drift-cited', 'drift-extract', 'drift-verify', 'grounding', 'hero-demo', 'missing-diagrams', 'plain-language', 'procedure-structure']);
  for (const k of Object.values(KINDS)) {
    assert.equal(typeof k.label, 'string');
    assert.equal(typeof k.groundingNote, 'boolean');
    assert.equal(typeof k.validate, 'function');
    assert.equal(typeof k.toFindings, 'function');
  }
});

test('every kind declares what its reply reads beyond the doc', () => {
  for (const [k, v] of Object.entries(KINDS)) assert.ok(['doc', 'repo', 'sources'].includes(v.reads), k);
  const by = (r) => Object.keys(KINDS).filter((k) => KINDS[k].reads === r).sort();
  assert.deepEqual(by('repo'), ['cold-read', 'diagram-drift', 'drift-verify', 'hero-demo']);
  assert.deepEqual(by('sources'), ['drift-cited']);
});
