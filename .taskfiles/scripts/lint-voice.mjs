#!/usr/bin/env node
// House-voice lint: flags the banned words and phrases from AGENTS.md
// ("Cut the tells"). RULES below is the single source of truth for that list.
//
// Usage: lint-voice.mjs [--mode human|llm] <file>...
// Exit 0 = no findings, 1 = findings, 2 = usage or internal error.
//
// Only running prose is scanned. The module's format adapter (parseDoc) marks
// each text fragment with `prose`; code blocks, inline code, link text and
// targets, and front matter never reach us as prose, so they cannot match.
// Dev-only: lives outside module/ so it never ships.

import { readFileSync } from 'node:fs';
import { parseDoc } from '../../module/skills/docs-organization/scripts/formats/index.mjs';
import { proseBlocks, lineAt } from '../../module/skills/docs-organization/scripts/check-prose.mjs';

// Each pattern needs a letter/digit boundary on both sides (whole word only),
// and uses \s+ between words so a phrase wrapped across lines still matches.
const RULES = [
  { re: /actively|simply|seamlessly|robust|comprehensive|powerful|effortlessly/, reason: 'booster adverb; delete it or use a plain word' },
  { re: /leverag(?:e|es|ed|ing)/, reason: 'brochure verb; use "use"' },
  { re: /it(?:['’]s|\s+is)\s+worth\s+noting/, reason: 'formulaic scaffold; state the point directly' },
  { re: /in\s+order\s+to/, reason: 'wordy; use "to"' },
].map(({ re, reason }) => ({
  re: new RegExp(`(?<![\\p{L}\\p{N}])(?:${re.source})(?![\\p{L}\\p{N}])`, 'giu'),
  reason,
}));

export function voiceFindings(model) {
  const findings = [];
  for (const block of proseBlocks(model)) {
    for (const { re, reason } of RULES) {
      for (const m of block.text.matchAll(re)) {
        findings.push({ line: lineAt(block, m.index), text: m[0].replace(/\s+/g, ' '), reason });
      }
    }
  }
  return findings.sort((a, b) => a.line - b.line);
}

function usage(message) {
  process.stderr.write(`lint-voice: ${message}\n`);
  process.exit(2);
}

async function main(argv) {
  let mode = 'human';
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--mode') {
      if (i + 1 >= argv.length) usage('--mode requires a value');
      mode = argv[++i];
    } else {
      files.push(argv[i]);
    }
  }
  if (mode !== 'human' && mode !== 'llm') usage('--mode must be human or llm');
  if (files.length === 0) {
    process.stderr.write('usage: lint-voice.mjs [--mode human|llm] <file>...\n');
    process.exit(2);
  }

  let total = 0;
  for (const file of files) {
    let content;
    try {
      content = readFileSync(file, 'utf8');
    } catch (e) {
      usage(`cannot read ${file}: ${e.message}`);
    }
    for (const f of voiceFindings(await parseDoc(file, content))) {
      process.stdout.write(`${file}:${f.line}: "${f.text}" — ${f.reason}\n`);
      total++;
    }
  }

  if (total > 0) {
    process.stdout.write(`lint-voice: ${total} finding${total === 1 ? '' : 's'}\n`);
  } else if (mode === 'human') {
    const ok = process.stdout.isTTY ? '\x1b[32mOK\x1b[0m' : 'OK';
    process.stdout.write(`lint-voice: ${ok} (${files.length} file${files.length === 1 ? '' : 's'})\n`);
  }
  process.exit(total === 0 ? 0 : 1);
}

main(process.argv.slice(2)).catch((e) => {
  process.stderr.write('lint-voice: internal error: ' + (e && e.stack ? e.stack : e) + '\n');
  process.exit(2);
});
