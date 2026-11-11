#!/usr/bin/env node
// Persona registry: the fixed set of readers /docs-audit routes content to.
// The one source check-routing.mjs (doors, gate files) and check-prose.mjs
// (SPLIT_CANDIDATE destinations) read, and — through the CLI — /docs-audit,
// /docs-init, and /docs-update. reference/personas.md and
// reference/placement-rules.md are the human tables; personas.test.mjs holds
// them equal to this data. The set is fixed in the module, not configured
// per project.
//
// A persona:
//   id, label, question  who the reader is and what they ask
//   entryNote            an entry point that is not a file (the front door,
//                        the README Status line), or null
//   entries              files and directories the reader starts from:
//                          {dir}           a directory; present when git
//                                          tracks a file under it
//                          {file, in}      any name in `file` (case-insensitive;
//                                          bare, or followed by `.` and an
//                                          extension) in any directory of
//                                          `in` ('.' is the repo root)
//                                          `variants: true` also accepts a
//                                          `-` or `_` suffix (`LICENSE-MIT`)
//                        Either form may carry `gate: true` (its absence is
//                        MISSING_GATE_FILE) or `door: false` (needs no link
//                        from the front door and does not count as one).
//   door                 true when a front door must link one of the
//                        entries that exist (MISSING_DOOR)
//   gate, gateHint       MISSING_GATE_FILE severity and why the file matters,
//                        or null for no gate check
//   mechanism            how the reader is served: walkthrough (follows a path
//                        of links), placement rules (writes docs), checklist
//                        (needs a file or line to exist)
//   holds                [{what, to}] content that belongs to this reader and
//                        where it goes (reference/placement-rules.md)
//   tasks                what a walkthrough reader sets out to do; /docs-audit's
//                        cold walker makes each one concrete from the docs it
//                        reads ([] for the other mechanisms)
//
// CLI: `node personas.mjs` prints PERSONAS as JSON.

import { isMain } from './is-main.mjs';

// GitHub's lookup locations for community health files.
const HEALTH_DIRS = ['.', '.github', 'docs'];

export const PERSONAS = [
  {
    id: 'new-user',
    label: 'New user',
    question: 'What is it, should I care, can I run it?',
    entryNote: 'front door (README, or the site home page)',
    entries: [],
    door: false,
    gate: null,
    gateHint: null,
    mechanism: 'walkthrough',
    holds: [{ what: 'what it is, who it is for, install, the first working command', to: 'the front door' }],
    tasks: ['say what the project does and who it is for', 'reach a first working command'],
  },
  {
    id: 'operator',
    label: 'Operator',
    question: "How do I do X, what does key Y do, what changed? Anyone who uses it repeatedly — including a library's API caller and an agent driving the CLI.",
    entryNote: null,
    entries: [{ dir: 'docs/usage' }, { file: ['CHANGELOG'], in: ['.'] }],
    door: true,
    gate: null,
    gateHint: null,
    mechanism: 'walkthrough',
    holds: [
      { what: 'how-tos, flags, configuration keys', to: '`docs/usage/`' },
      { what: 'upgrade notes, changes between releases', to: '`CHANGELOG.md`' },
    ],
    tasks: ['find how to change one setting the docs mention', 'find what to do before upgrading'],
  },
  {
    id: 'dev',
    label: 'Dev',
    question: 'How does it work, how do I build, test, contribute?',
    entryNote: null,
    entries: [{ dir: 'docs/dev' }, { file: ['CONTRIBUTING'], in: HEALTH_DIRS }],
    door: true,
    gate: null,
    gateHint: null,
    mechanism: 'walkthrough',
    holds: [
      { what: 'architecture, design rationale', to: '`docs/dev/`, or an ADR' },
      { what: 'dev setup, build, tests, the contribution workflow', to: '`docs/dev/` or `CONTRIBUTING.md`' },
    ],
    tasks: ['find how to build from source offline', 'find how to run the tests', 'find where the architecture is explained'],
  },
  {
    id: 'security',
    label: 'Security',
    question: 'Am I allowed to adopt it: threat model, data handled, vuln reporting?',
    entryNote: null,
    entries: [{ file: ['SECURITY'], in: HEALTH_DIRS, gate: true }],
    door: true,
    gate: 'info',
    gateHint: 'a reporter has no private channel for a vulnerability',
    mechanism: 'walkthrough',
    holds: [{ what: 'vulnerability reporting, data handled, trust boundaries', to: '`SECURITY.md`' }],
    tasks: ['find how to report a vulnerability', 'find what data the project stores or sends', 'find where trust boundaries are described'],
  },
  {
    id: 'llm',
    label: 'LLM',
    question: 'What are the rules, where is the authoritative fact?',
    entryNote: null,
    entries: [{ file: ['AGENTS'], in: ['.'] }],
    door: false,
    gate: null,
    gateHint: null,
    mechanism: 'placement rules',
    holds: [{ what: 'rules for agents that work in the repo', to: '`AGENTS.md`' }],
    tasks: [],
  },
  {
    id: 'lawyer',
    label: 'Lawyer',
    question: 'Can we use, modify, ship it?',
    entryNote: null,
    entries: [
      { file: ['LICENSE', 'LICENCE', 'COPYING', 'UNLICENSE'], in: ['.'], variants: true, gate: true },
      { file: ['NOTICE'], in: ['.'] },
      { dir: 'LICENSES', gate: true, door: false },
    ],
    door: true,
    gate: 'warning',
    gateHint: 'without a license, nobody else may use, change, or ship the code',
    mechanism: 'checklist',
    holds: [{ what: 'license terms, third-party notices', to: '`LICENSE`, `NOTICE`' }],
    tasks: [],
  },
  {
    id: 'support',
    label: 'Support seeker',
    question: 'Where do I get help?',
    entryNote: null,
    entries: [
      { file: ['SUPPORT'], in: HEALTH_DIRS, gate: true },
      { file: ['ISSUE_TEMPLATE'], in: HEALTH_DIRS, gate: true, door: false },
      { dir: '.github/ISSUE_TEMPLATE', gate: true, door: false },
      { dir: 'ISSUE_TEMPLATE', gate: true, door: false },
      { dir: 'docs/ISSUE_TEMPLATE', gate: true, door: false },
    ],
    door: true,
    gate: 'info',
    gateHint: 'a user with a question has nowhere to ask',
    mechanism: 'checklist',
    holds: [{ what: 'where to get help', to: '`SUPPORT.md`' }],
    tasks: [],
  },
  {
    id: 'health',
    label: 'Project health',
    question: 'Is it alive, can we depend on it?',
    entryNote: 'README `Status` line',
    entries: [],
    door: false,
    gate: null,
    gateHint: null,
    mechanism: 'checklist',
    holds: [{ what: 'maturity and maintenance status', to: 'the README `Status` line' }],
    tasks: [],
  },
];

// One entry as Markdown, for finding messages and reference/personas.md.
export function describeEntry(entry) {
  if (entry.dir) return `\`${entry.dir}/\``;
  const [first, ...aliases] = entry.file.map((n) => `\`${n}\``);
  let text = aliases.length ? `${first} (or ${aliases.join(', ')})` : first;
  if (entry.in.length > 1) {
    text += ` in ${entry.in.map((d) => (d === '.' ? 'the root' : `\`${d}/\``)).join(', ')}`;
  }
  return text;
}

if (isMain(import.meta.url)) process.stdout.write(JSON.stringify(PERSONAS, null, 2) + '\n');
