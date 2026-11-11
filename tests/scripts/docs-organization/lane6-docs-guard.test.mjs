// The dispatch rules that keep an orchestrator from skipping Lane 6 jobs
// live in docs-audit.md; the prompts themselves live in lane6-prompts/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const doc = readFileSync(fileURLToPath(new URL('../../../module/commands/docs-audit.md', import.meta.url)), 'utf8');

test('docs-audit.md states the Lane 6 dispatch rules', () => {
  for (const s of [
    'node "$SKILL_DIR/scripts/lane6.mjs" plan',
    'node "$SKILL_DIR/scripts/lane6.mjs" record',
    'node "$SKILL_DIR/scripts/lane6.mjs" next',
    'node "$SKILL_DIR/scripts/lane6.mjs" collect',
    'delimiter is the `eof` from the dispatch output',
    'a line equal to the `eof`',
    'never batch, merge, skip, summarise, or write a reply yourself',
    'Cost is never a reason to skip',
    'Never edit a reply\n       before recording it',
  ]) assert.ok(doc.includes(s), `missing: ${s}`);
});

test('the prompt text no longer lives in docs-audit.md', () => {
  for (const s of ['List every specific, checkable claim', 'You are the intended audience from the grounding above', 'whether this landing page would be meaningfully improved']) {
    assert.ok(!doc.includes(s), `still inline: ${s}`);
  }
});
