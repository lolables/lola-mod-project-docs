// A large /docs-audit punch list is saved to a file and only the Blockers are
// printed; /docs-update must then read that file. Both halves of the contract
// live in Markdown, so this test keeps them from drifting apart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (p) => readFileSync(fileURLToPath(new URL(`../../../module/commands/${p}`, import.meta.url)), 'utf8');

test('docs-audit saves the full punch list and prints the Full report line past 50 findings', () => {
  const doc = read('docs-audit.md');
  for (const s of [
    'mktemp "${TMPDIR:-/tmp}/docs-audit-XXXXXX"',
    "host's file-write tool, never a shell\n     heredoc",
    '50 findings or fewer: print the whole punch list',
    'Full report: `/tmp/docs-audit-Hq2xZa` — run `/docs-update /tmp/docs-audit-Hq2xZa` to act on it.',
  ]) assert.ok(doc.includes(s), `docs-audit.md is missing: ${s}`);
});

test('docs-update reads the file a Full report line names, never the shortened reply', () => {
  const doc = read('docs-update.md');
  assert.ok(doc.includes('`` Full report: `<path>` ``'), 'docs-update.md does not look for the Full report line');
  assert.ok(doc.includes('never fall back to the shortened reply'), 'docs-update.md may fall back to the shortened reply');
});
