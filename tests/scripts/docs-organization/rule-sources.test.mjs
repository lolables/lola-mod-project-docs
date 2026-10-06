// Every writing-quality finding code must name the rule it enforces — an
// external source the reader can open, or "house convention" with its
// provenance — in reference/rule-sources.md. Codes are discovered from the
// /docs-audit schema and the scripts' `code: '...'` literals, so a new code cannot ship without
// a row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const read = (p) => readFileSync(ROOT + p, 'utf8');
// Finding codes are assumed to contain an underscore (MISSING_README, not README).
const CODE_RE = /`([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)`/g;

// Tool-correctness codes enforce the module's own conventions or factual
// accuracy, not a writing rule, so they have no row (the intro of
// reference/rule-sources.md lists these categories).
const TOOL_CORRECTNESS = new Set([
  // structure
  'MISSING_README', 'MISSING_GITIGNORE_SUPERPOWERS', 'SUPERPOWERS_IN_GIT', 'MISSING_ADR_INDEX', 'FORKED_COPY',
  // staleness
  'STALENESS_NOT_ASSESSED', 'STALE_README', 'STALE_DOC',
  // references
  'REF_BROKEN', 'REF_NOT_IN_GIT', 'UNLINKED_REF', 'PARSE_WARNING',
  // mermaid syntax, house style, palette classes
  'SYNTAX_ERROR', 'INLINE_CLASS_NOT_SUPPORTED', 'MISSING_HOUSE_STYLE_HEADER', 'LEGACY_HOUSE_STYLE_HEADER',
  'UNAPPROVED_CLASSNAME', 'UNAPPROVED_STYLE',
  // accuracy and citations
  'CONTENT_DRIFT', 'NOT_VERIFIABLE', 'CITATION_BLOCKED', 'CITATION_FETCH_FAILED', 'CITATION_LIMIT',
  'CITATIONS_NOT_FETCHED',
  'LANE_FAILED',
]);

function schemaCodes() {
  const audit = read('module/commands/docs-audit.md');
  const start = audit.indexOf('`Code` is the finding code');
  const end = audit.indexOf('- `File`:', start);
  assert.ok(start >= 0 && end > start, 'finding-code schema not found in docs-audit.md');
  const codes = new Set([...audit.slice(start, end).matchAll(CODE_RE)].map((m) => m[1]));
  assert.ok(codes.size > 0, 'no finding codes discovered in the docs-audit.md schema');
  return codes;
}

const SCRIPTS_DIR = 'module/skills/docs-organization/scripts/';

function scriptCodes() {
  const codes = new Set();
  for (const f of readdirSync(ROOT + SCRIPTS_DIR).filter((n) => n.endsWith('.mjs'))) {
    for (const m of read(SCRIPTS_DIR + f).matchAll(/code: '([A-Z_]+)'/g)) codes.add(m[1]);
  }
  assert.ok(codes.size > 0, 'no finding codes discovered in the scripts');
  return codes;
}

const RULE_SOURCES = 'module/skills/docs-organization/reference/rule-sources.md';
const tableRows = (text) => text.split('\n').filter((l) => l.startsWith('| `'));

function anchoredCodes() {
  const codes = new Set(
    tableRows(read(RULE_SOURCES)).flatMap((r) => [...r.split('|')[1].matchAll(CODE_RE)].map((m) => m[1])),
  );
  assert.ok(codes.size > 0, 'no codes discovered in rule-sources.md rows');
  return codes;
}

test('every code a script emits is in the /docs-audit schema', () => {
  const schema = schemaCodes();
  for (const c of scriptCodes()) assert.ok(schema.has(c), `${c} missing from docs-audit.md schema`);
});

test('every writing-quality code has a rule-sources row', () => {
  const anchored = anchoredCodes();
  const missing = [...schemaCodes(), ...scriptCodes()].filter((c) => !TOOL_CORRECTNESS.has(c) && !anchored.has(c));
  assert.deepEqual([...new Set(missing)], []);
});

test('every rule-sources row names a current writing-quality code', () => {
  const schema = schemaCodes();
  for (const c of anchoredCodes()) {
    assert.ok(schema.has(c), `${c} has a row but is not in the docs-audit.md schema`);
    assert.ok(!TOOL_CORRECTNESS.has(c), `${c} is a tool-correctness code and should have no row`);
  }
});

test('the tool-correctness list names only real codes', () => {
  const schema = schemaCodes();
  for (const c of TOOL_CORRECTNESS) assert.ok(schema.has(c), `${c} in TOOL_CORRECTNESS but not in the schema`);
});

test('external rows cite a URL and house-convention rows say so', () => {
  const [external, house] = read(RULE_SOURCES).split('## House conventions');
  assert.ok(house !== undefined, 'rule-sources.md has no "## House conventions" heading');
  const cells = (row) => row.split('|').map((c) => c.trim());
  for (const r of tableRows(external)) assert.ok(cells(r)[4].includes('https://'), `no URL in Source cell: ${r.slice(0, 60)}`);
  for (const r of tableRows(house)) assert.ok(cells(r)[2].includes('house convention'), `Authority is not "house convention": ${r.slice(0, 60)}`);
});
