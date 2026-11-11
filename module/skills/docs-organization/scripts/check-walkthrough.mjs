#!/usr/bin/env node
// Persona walkthroughs for /docs-audit Lane 6. A cold subagent per
// walkthrough persona reads the docs by following links only; this script
// makes every judgment the navigation graph (nav-graph.mjs) can make:
//
//   planWalks(root)          {graph, plan, edges}: where each persona starts,
//                            the site sidebar, and why walkthroughs are skipped
//   verifyWalk(ctx, reply)   {valid, rejected:[{at, reason}], opened}: every hop
//                            follows a link out of a file already opened (or,
//                            on a site, names a sidebar entry), and every
//                            answer sits in an opened doc file (a directory is
//                            never opened itself, only the pages it lands on;
//                            a hop may open a non-doc file such as LICENSE,
//                            but no answer can cite one); a stuck task's
//                            `last` must be an opened doc file
//   classifyLost(ctx, input) {findings, missed, rejected}: a WALKTHROUGH_LOST
//                            warning for each task the walk could not finish,
//                            from where the locate step found its answer
//
// plan: {mode, skipped, globalNav, personas:[{id, label, question, tasks,
// starts, door}], skippedPersonas:[{id, label, reason}]}. skipped is null, or why
// no walk can be verified (a site whose navigation routing does not read).
// edges: the graph's edges plus those out of every doc outside the page set
// that is a start or is linked from a reachable file.
//
// A walker's reply: {persona, hops:[{from, line, to} | {from: 'nav', to}],
// tasks:[{n, concrete, status: 'done', file, line} |
//        {n, concrete, status: 'stuck', last}]}, one entry per registry task,
// n from 1. Paths are relative to the repository root. A hop's line is the
// line of a link in `from` that reaches `to` (a link to `to` itself, to a
// directory `to` is a page of, or, when `to` is a directory, to a page directly
// inside it; a trailing slash is ignored).
//
// classify input: {persona, stuck:[n], located:[{n, concrete, last, file, line}]}:
// stuck lists the walk's stuck tasks; last from the walk, file and line from the
// locator (file null when no doc answers); last must be a doc file the reader
// could reach, and each n appears once. A stuck n with no located entry is
// rejected, so a dropped task never reads as clean; a located n not in stuck is
// rejected too. No file, or a file that is not a doc → absent; a doc no link
// (or sidebar entry) path from the starts reaches → unreachable; a doc a path
// reaches → missed (the walker gave up early; not a finding).
// Reach is one walk over the edges from the starts and the sidebar, through
// docs outside the page set. The walker's `concrete` text is collapsed to one
// line, backtick-free, and capped before it enters a message.
// WALKTHROUGH_LOST's file depends on the kind. unreachable (and missed, which
// is not a finding): the last file the walk reached, where a link to the answer
// would go. absent: the persona's door, where the new page belongs; the last
// file reached stays in the message. The door is the first entry, in registry
// order, that resolves to a single present doc file (a file entry, or a
// directory entry's index page); a directory with no index page is skipped, as
// its pages are no one door. With no such entry the door is the first start.
//
// CLI, inside the repository:
//   --plan      prints the plan as JSON, exit 0
//   --verify    reads a walker's reply on stdin, prints {valid, rejected,
//               opened}; exit 0 when valid, 1 when not (unparseable JSON is
//               a rejected reply, not an error)
//   --classify  reads classify input on stdin, prints {findings, missed,
//               rejected}; exit 1 when findings or rejected, else 0
// Exit 2 on a usage error, outside a git repository, on a malformed
// mkdocs.yml or antora.yml (a malformed antora-playbook.yml only supplies
// site.url, which walkthroughs never read, so it leaves the exit at 0), or for --verify or --classify when walkthroughs are skipped.

import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { PERSONAS } from './personas.mjs';
import { buildGraph, indexPage, landOn, loadOutsideEdges, present, reachable } from './nav-graph.mjs';
import { presentEntryPaths } from './check-routing.mjs';
import { repoRootOf } from './docs-mode.mjs';
import { formatFor } from './formats/index.mjs';
import { ConfigError } from './site-yaml.mjs';
import { isMain } from './is-main.mjs';

const WALKERS = PERSONAS.filter((p) => p.mechanism === 'walkthrough');

// Why no walk can be verified: hops need the navigation the reader sees.
function skipReason(graph) {
  if (graph.mode === 'repo' || graph.adapter !== 'links') return null;
  return graph.unreadable
    ? `hops cannot be verified without the site's navigation: ${graph.unreadable}`
    : `hops cannot be verified without the site's navigation, which routing does not read (${graph.mode})`;
}

// The new user starts at every front door (a site has two: its home page and
// the README). Every other persona starts at
// each entry point that exists (a directory's index page, or the pages
// directly inside it; in MkDocs mode the index is the page the site publishes;
// a file entry's doc files that are in the work tree and resolve inside the
// repo), else the first front door. The door is the first entry that resolves
// to one file (see the header), else the first start.
function startsFor(persona, graph) {
  const frontDoors = graph.frontDoors;
  if (persona.id === 'new-user') return { starts: frontDoors, door: frontDoors[0] };
  const pageSet = new Set(graph.pages);
  const out = [];
  let door;
  for (const entry of persona.entries) {
    if (entry.dir) {
      const index = indexPage(entry.dir, pageSet, graph.mkdocsPages);
      out.push(...(index ? [index] : graph.pages.filter((p) => posix.dirname(p) === entry.dir)));
      door ??= index ?? undefined;
    } else {
      const files = presentEntryPaths(entry, graph).filter(formatFor).sort();
      out.push(...files);
      door ??= files[0];
    }
  }
  const starts = out.length ? [...new Set(out)] : frontDoors;
  return { starts, door: door ?? starts[0] };
}

export async function planWalks(root) {
  const graph = await buildGraph(root, { tolerateConfigErrors: true });
  const plan = { mode: graph.mode, skipped: skipReason(graph), globalNav: graph.globalNav, personas: [], skippedPersonas: [] };
  if (plan.skipped) return { graph, plan, edges: graph.edges };
  for (const p of WALKERS) {
    const { starts, door } = startsFor(p, graph);
    if (starts.length === 0) {
      plan.skippedPersonas.push({ id: p.id, label: p.label, reason: 'no entry point and no front door to start from' });
      continue;
    }
    plan.personas.push({ id: p.id, label: p.label, question: p.question, tasks: p.tasks, starts, door });
  }
  // Docs outside the page set (a dot-directory) have no edges in the graph:
  // read those a walk from the seeds reaches, as routing does.
  await loadOutsideEdges(graph, [...plan.personas.flatMap((p) => p.starts), ...graph.globalNav]);
  const edges = [...graph.edges, ...[...graph.outsideEdges.values()].flat()];
  return { graph, plan, edges };
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isLine = (v) => Number.isInteger(v) && v > 0;
// A reply path as the graph writes it: no leading ./, no trailing /.
const clean = (p) => (typeof p === 'string' && p.trim() ? posix.normalize(p.trim().replace(/^\.\//, '')).replace(/\/+$/, '') : null);

export function verifyWalk({ graph, plan, edges }, reply) {
  if (!isObj(reply)) return { valid: false, rejected: [{ at: 'reply', reason: 'not a JSON object' }], opened: [] };
  const persona = plan.personas.find((p) => p.id === reply.persona);
  if (!persona) {
    return { valid: false, rejected: [{ at: 'persona', reason: `not a walkthrough persona in this plan: ${JSON.stringify(reply.persona)}` }], opened: [] };
  }
  const rejected = [];
  const reject = (at, reason) => { rejected.push({ at, reason }); };
  const nav = new Set(graph.globalNav);
  const opened = new Set(persona.starts);
  const byFrom = new Map();
  for (const e of edges) {
    if (!byFrom.has(e.from)) byFrom.set(e.from, []);
    byFrom.get(e.from).push({ e, landed: landOn(graph, e.to) });
  }
  if (!Array.isArray(reply.hops)) reject('hops', 'hops: not a list');
  (Array.isArray(reply.hops) ? reply.hops : []).forEach((hop, i) => {
    const at = `hops[${i}]`;
    if (!isObj(hop)) return reject(at, 'not an object');
    const to = clean(hop.to);
    if (!to) return reject(at, 'no `to` path');
    if (hop.from === 'nav') {
      if (!nav.has(to)) return reject(at, nav.size ? `nav → ${to}: not a sidebar entry` : `nav → ${to}: this docs mode has no sidebar`);
      opened.add(to);
      return;
    }
    const from = clean(hop.from);
    if (!from) return reject(at, 'no `from` path');
    if (!isLine(hop.line)) return reject(at, `${from} → ${to}: no line number`);
    if (!opened.has(from)) return reject(at, `${from}:${hop.line} → ${to}: ${from} was not opened before this hop`);
    // An edge serves the hop when it targets `to`, lands on `to`, or lands on a
    // page directly inside `to` (a link that names a directory).
    const serving = (byFrom.get(from) ?? []).filter(({ e, landed }) => e.to === to || landed.includes(to) || landed.some((p) => posix.dirname(p) === to));
    if (serving.length === 0) return reject(at, `${from}:${hop.line} → ${to}: ${from} has no link to ${to}`);
    const lines = [...new Set(serving.map(({ e }) => e.line))].sort((a, b) => a - b);
    if (!lines.includes(hop.line)) return reject(at, `${from}:${hop.line} → ${to}: no link to it on line ${hop.line} (links on line ${lines.join(', ')})`);
    for (const { e, landed } of serving) if (e.line === hop.line) for (const p of landed) if (p === to || posix.dirname(p) === to) opened.add(p);
    if (present(graph, to)) opened.add(to);
  });
  const seen = new Set();
  if (!Array.isArray(reply.tasks)) reject('tasks', 'tasks: not a list');
  (Array.isArray(reply.tasks) ? reply.tasks : []).forEach((t, i) => {
    const at = `tasks[${i}]`;
    if (!isObj(t) || !Number.isInteger(t.n) || t.n < 1 || t.n > persona.tasks.length) return reject(at, `n must be 1..${persona.tasks.length}`);
    if (seen.has(t.n)) return reject(at, `task ${t.n} answered twice`);
    seen.add(t.n);
    if (typeof t.concrete !== 'string' || !t.concrete.trim()) return reject(at, `task ${t.n}: no concrete task`);
    if (t.status === 'done') {
      const file = clean(t.file);
      if (!file || !opened.has(file)) return reject(at, `task ${t.n}: answer in ${file ?? 'no file'}, which the walk did not open`);
      if (!formatFor(file)) return reject(at, `task ${t.n}: answer file ${file} is not a doc file`);
      if (!isLine(t.line)) return reject(at, `task ${t.n}: no line number`);
    } else if (t.status === 'stuck') {
      const last = clean(t.last);
      if (!last || !opened.has(last)) return reject(at, `task ${t.n}: last file ${last ?? '(none)'} was not opened`);
      if (!formatFor(last)) reject(at, `task ${t.n}: last file ${last} is not a doc file`);
    } else {
      reject(at, `task ${t.n}: status must be done or stuck`);
    }
  });
  for (let n = 1; n <= persona.tasks.length; n++) if (!seen.has(n)) reject('tasks', `task ${n} has no entry`);
  return { valid: rejected.length === 0, rejected, opened: [...opened].sort() };
}

// The walker's own words go into a finding message: one line, no backticks,
// at most 120 characters.
const tidy = (text) => {
  const one = text.replace(/\s+/g, ' ').replace(/`/g, "'").trim();
  return one.length > 120 ? `${one.slice(0, 119)}…` : one;
};

export function classifyLost({ graph, plan, edges }, input) {
  const findings = [];
  const missed = [];
  const rejected = [];
  if (!isObj(input) || !Array.isArray(input.located) || !Array.isArray(input.stuck)) {
    return { findings, missed, rejected: [{ at: 'input', reason: 'expected {persona, stuck: [...], located: [...]}' }] };
  }
  const persona = plan.personas.find((p) => p.id === input.persona);
  if (!persona) return { findings, missed, rejected: [{ at: 'persona', reason: `not a walkthrough persona in this plan: ${JSON.stringify(input.persona)}` }] };
  const reach = reachable(graph, [...persona.starts, ...graph.globalNav], { outsidePages: true });
  const from = persona.starts.map((s) => `\`${s}\``).join(', ');
  const path = graph.globalNav.length ? 'link or sidebar' : 'link';
  const seen = new Set();
  input.located.forEach((l, i) => {
    const at = `located[${i}]`;
    if (!isObj(l) || !Number.isInteger(l.n) || l.n < 1 || l.n > persona.tasks.length) return rejected.push({ at, reason: `n must be 1..${persona.tasks.length}` });
    if (!input.stuck.includes(l.n)) return rejected.push({ at, reason: `task ${l.n} is not stuck` });
    if (seen.has(l.n)) return rejected.push({ at, reason: `task ${l.n} located twice` });
    seen.add(l.n);
    const last = clean(l.last);
    if (!last || !formatFor(last) || !reach.has(last)) return rejected.push({ at, reason: `last file ${last ?? '(none)'} is not a doc file the reader could reach` });
    const task = persona.tasks[l.n - 1];
    const concrete = (typeof l.concrete === 'string' ? tidy(l.concrete) : '') || task;
    const head = `${persona.label}: "${concrete}" (${task}) — last reached \`${last}\``;
    const base = { code: 'WALKTHROUGH_LOST', severity: 'warning', file: last, line: null, persona: persona.id, n: l.n };
    const absent = { ...base, file: persona.door, kind: 'absent' };
    if (l.file === null) return findings.push({ ...absent, message: `${head}; absent: no doc page answers it` });
    const file = clean(l.file);
    if (!file || !graph.tracked.has(file)) return rejected.push({ at, reason: `${file ?? 'file'} is not a tracked file` });
    if (!isLine(l.line)) return rejected.push({ at, reason: `${file}: no line number` });
    if (!present(graph, file)) {
      return findings.push({ ...absent, message: `${head}; absent: no doc page answers it (found only in \`${file}\`, which is not in the work tree)` });
    }
    if (!formatFor(file)) {
      return findings.push({ ...absent, message: `${head}; absent: no doc page answers it (found only in \`${file}\`, which is not a doc file)` });
    }
    if (reach.has(file)) return missed.push({ persona: persona.id, label: persona.label, n: l.n, concrete, file, line: l.line });
    findings.push({ ...base, kind: 'unreachable', message: `${head}; unreachable: the answer is at \`${file}:${l.line}\`, and no ${path} path from ${from} reaches it; link it from \`${last}\`` });
  });
  input.stuck.forEach((n, i) => {
    if (!Number.isInteger(n) || n < 1 || n > persona.tasks.length) rejected.push({ at: `stuck[${i}]`, reason: `n must be 1..${persona.tasks.length}` });
    else if (!seen.has(n)) rejected.push({ at: 'located', reason: `task ${n} is stuck and has no located entry` });
  });
  return { findings, missed, rejected };
}

const MODES = ['--plan', '--verify', '--classify'];
const USAGE = 'usage: check-walkthrough.mjs --plan | --verify | --classify (JSON on stdin for the last two; run it inside the repository)\n';

async function main(args) {
  if (args.length !== 1 || !MODES.includes(args[0])) {
    process.stderr.write(USAGE);
    process.exitCode = 2;
    return;
  }
  const root = repoRootOf(process.cwd());
  if (!root) {
    process.stderr.write('check-walkthrough: not a git repository; walkthroughs read the tracked file list\n');
    process.exitCode = 2;
    return;
  }
  const ctx = await planWalks(root);
  if (args[0] === '--plan') {
    process.stdout.write(JSON.stringify(ctx.plan, null, 2) + '\n');
    if (ctx.plan.skipped && ctx.graph.configError) {
      process.stderr.write(`check-walkthrough: ${ctx.graph.configError}\n`);
      process.exitCode = 2;
    }
    return;
  }
  if (ctx.plan.skipped) {
    process.stderr.write(`check-walkthrough: walkthroughs are skipped: ${ctx.plan.skipped}\n`);
    process.exitCode = 2;
    return;
  }
  let input;
  let parseError = null;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch (e) {
    parseError = e.message;
  }
  if (args[0] === '--classify') {
    const result = parseError ? { findings: [], missed: [], rejected: [{ at: 'input', reason: `not JSON: ${parseError}` }] } : classifyLost(ctx, input);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exitCode = result.findings.length || result.rejected.length ? 1 : 0;
    return;
  }
  const result = parseError ? { valid: false, rejected: [{ at: 'reply', reason: `not JSON: ${parseError}` }], opened: [] } : verifyWalk(ctx, input);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exitCode = result.valid ? 0 : 1;
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    process.stderr.write(e instanceof ConfigError ? `check-walkthrough: ${e.message}\n` : 'check-walkthrough: internal error: ' + (e && e.stack ? e.stack : e) + '\n');
    process.exitCode = 2;
  });
}
