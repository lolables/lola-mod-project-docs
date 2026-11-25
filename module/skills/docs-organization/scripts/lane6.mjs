#!/usr/bin/env node
// Script-driven dispatch for /docs-audit Lane 6 and Lane 3 adjudication.
//
// A run directory under $XDG_CACHE_HOME/docs-audit holds the whole state, so
// the orchestrator never decides what runs next; it dispatches what plan and
// next print and records what comes back:
//
//   manifest.json            files, jobs (kind, params, status, attempts), skipped,
//                            eof (this run's reply delimiter), unmatched (prose candidates)
//   prompts/<id>.md          the rendered prompt, given verbatim to one subagent
//   results/<id>.<n>.json    attempt n's result: {ok, payload} or {ok:false, reason, remediation}
//   results/<id>.<n>.raw.md  attempt n's reply as received
//
// Only planRun and nextBatch write manifest.json, under a lock file;
// recordReply writes only its own results files, so replies can be recorded
// in any order. A job is due, then dispatched, then ok, due again (retry), or
// failed after MAX_ATTEMPTS. collectRun turns every job that is not ok, and
// every job that never ran, into a LANE_FAILED warning for its file.
//
// Job kinds: lane6-kinds.mjs. Prompts: reference/lane6-prompts/<kind>.md.

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, openSync, closeSync, unlinkSync, realpathSync, readdirSync, statSync, rmSync, lstatSync, readlinkSync, utimesSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve, dirname, basename, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDoc, readmeNames } from './formats/index.mjs';
import { chunkDoc } from './doc-chunks.mjs';
import { KINDS, ADJUDICATED, extractJson, unjudged } from './lane6-kinds.mjs';
import { isMain } from './is-main.mjs';

export const BATCH_SIZE = 8;
// A transient empty reply (~1 run in 5) reads as a spurious all-clear, so a
// job gets one try plus two retries before it becomes LANE_FAILED.
export const MAX_ATTEMPTS = 3;
export const VERIFY_BATCH = 20;
export const SCOPES = ['sweep', 'path', 'document'];
const PROMPTS = fileURLToPath(new URL('../reference/lane6-prompts/', import.meta.url));
const CHUNKED = new Set(['plain-language', 'drift-extract']);
// Bump when a reply's meaning changes without a prompt change: a validator or
// toFindings that reads a payload differently.
export const CACHE_VERSION = 1;
const CACHE_NAME = 'lane6-cache';
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

export class UsageError extends Error {}

// Every audit artifact (run state, report, saved JSON) lives in one session
// directory, $XDG_CACHE_HOME/docs-audit/<project>/<timestamp>-<random>/, so a
// run can be inspected afterwards. The layout and pruning copy review-council's
// session cache. A relative XDG_CACHE_HOME is ignored per the XDG spec: the cwd
// is the audited repo, which must not receive our files.
const DEFAULT_SESSION_CAP = 20;

function auditCacheDir() {
  const xdg = process.env.XDG_CACHE_HOME;
  const base = xdg && isAbsolute(xdg) ? xdg : join(homedir(), '.cache');
  return join(base, 'docs-audit');
}

const sessionCap = () => (/^\d+$/.test(process.env.DOCS_AUDIT_SESSION_CACHE_MAX ?? '') ? Number(process.env.DOCS_AUDIT_SESSION_CACHE_MAX) : DEFAULT_SESSION_CAP);

// Newest first. lane6-cache/ sits beside the sessions and is not one.
function sessionsByAge(project) {
  return readdirSync(project, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== CACHE_NAME)
    .map((e) => ({ path: join(project, e.name), mtime: statSync(join(project, e.name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
}

// Keep the newest DOCS_AUDIT_SESSION_CACHE_MAX sessions of one project (a cap
// of 0 still keeps `keep`: the run that owns it has to finish). Without this a
// cache nobody inspects grows by one directory per audit, forever.
function pruneSessions(project, keep) {
  for (const { path } of sessionsByAge(project).slice(sessionCap())) if (path !== keep) rmSync(path, { recursive: true, force: true });
}

// The project key is a hash of the cwd (the audited repo), as review-council
// keys on $PWD: a short directory name, not an integrity check. The directory
// is made by mkdtemp so two audits started in the same second cannot share one.
export function startSession() {
  const project = join(auditCacheDir(), createHash('sha256').update(process.cwd()).digest('hex').slice(0, 12));
  mkdirSync(project, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/\.\d+Z$/, '').replace(/[-:]/g, '').replace('T', '-');
  const session = mkdtempSync(join(project, `${stamp}-`));
  pruneSessions(project, session);
  return { status: 'session', session };
}

// A session given on the command line must be one startSession made, so a
// mistyped or hostile --session cannot make plan write elsewhere.
function checkedSession(session) {
  const cache = auditCacheDir();
  const real = existsSync(session) ? realpathSync(session) : null;
  const root = existsSync(cache) ? realpathSync(cache) : null;
  if (!real || !root || !real.startsWith(root + '/') || !statSync(real).isDirectory()) throw new UsageError(`--session ${session}: not a session directory under ${cache}`);
  return real;
}

const atomicWrite = (path, data) => {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
};
const loadManifest = (run) => JSON.parse(readFileSync(join(run, 'manifest.json'), 'utf8'));
const saveManifest = (run, m) => atomicWrite(join(run, 'manifest.json'), JSON.stringify(m, null, 2) + '\n');
const resultPath = (run, job) => join(run, 'results', `${job.id}.${job.attempts}.json`);
const promptPath = (run, job) => join(run, 'prompts', `${job.id}.md`);
const cacheDir = (run) => join(dirname(dirname(run)), CACHE_NAME);
const entryPath = (run, key) => join(cacheDir(run), `${key}.json`);

// A cache entry lives as long as the sessions pruneSessions keeps: one last
// used before the oldest kept session began goes. A session's start is the
// UTC stamp startSession puts in its name, not its mtime: writing the report
// moves a session's mtime past its own entries.
const STAMP_RE = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-/;
function pruneCache(run) {
  const session = dirname(run);
  const kept = [session, ...sessionsByAge(dirname(session)).slice(0, sessionCap()).map((s) => s.path)];
  const starts = kept.map((p) => STAMP_RE.exec(basename(p))).filter(Boolean).map((s) => {
    const [y, mo, d, h, mi, se] = s.slice(1).map(Number);
    return Date.UTC(y, mo - 1, d, h, mi, se);
  });
  if (!starts.length) return;
  const oldest = Math.min(...starts);
  for (const name of readdirSync(cacheDir(run))) {
    const st = statSync(join(cacheDir(run), name), { throwIfNoEntry: false });
    if (st?.isFile() && st.mtimeMs < oldest) rmSync(join(cacheDir(run), name), { force: true });
  }
}
const ended = (job) => job.status === 'ok' || job.status === 'failed';
// A file's identity: symlinks resolved. A path that cannot be resolved (a stale
// prose entry) keeps its absolute spelling and so matches nothing planned.
function real(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}
const countLines = (text) => (text === '' ? 0 : text.replace(/(\r\n|\r|\n)$/, '').split(/\r\n|\r|\n/).length);

function withLock(run, fn) {
  const lock = join(run, '.lock');
  let fd;
  try {
    fd = openSync(lock, 'wx');
  } catch (e) {
    if (e.code === 'EEXIST') throw new UsageError(`another lane6 plan or next is running on ${run} (remove ${lock} if it is stale)`);
    throw e;
  }
  try {
    return fn();
  } finally {
    closeSync(fd);
    unlinkSync(lock);
  }
}

function addJob(m, kind, file, wave, params) {
  m.seq += 1;
  m.jobs.push({ id: `${String(m.seq).padStart(3, '0')}-${kind}`, kind, file, wave, params, status: 'due', attempts: 0, reason: null, remediation: null, payload: null, key: null, cached: false });
}

// One file's sources from fetch-citations.mjs outputs (spec: document mode).
function citedSources(citations, file) {
  const mine = (key) => citations.flatMap((c) => c[key] ?? []).filter((e) => real(e.file) === real(file));
  const cites = mine('citations');
  const local = mine('localSources').map((e) => e.path);
  const snapshots = cites.filter((e) => e.snapshot).map((e) => e.snapshot);
  const unread = [...cites.filter((e) => !e.snapshot).map((e) => `${e.url} (not fetched)`), ...mine('unreadSources').map((e) => `${e.target} (${e.reason})`)];
  return local.length || snapshots.length || unread.length ? { local, snapshots, unread } : null;
}

// Grounding-dependent kinds for one doc file. mode is null when grounding
// failed or has not ended: then every kind that could apply is listed.
function groundedKinds(scope, f, mode) {
  const kinds = ['missing-diagrams', 'cold-read', 'procedure-structure', 'audience-fit'];
  if (mode !== 'landing') kinds.push('completeness');
  if (scope !== 'document' && (f.rootReadme || (scope === 'sweep' && mode === 'landing'))) kinds.push('hero-demo');
  if (f.sources) kinds.push('drift-cited');
  return kinds;
}

// What a repo-reading reply could have read: the index plus every working-tree
// file git would show. The diff is against the index, not HEAD, so a repo with
// no commits works; the index entries already carry staged changes.
function repoFingerprint(repoRoot) {
  const git = (...args) => {
    // Everything but rev-parse runs from the toplevel, so a --repo-root below it still fingerprints the whole repo.
    const cwd = args[0] === 'rev-parse' ? repoRoot : top;
    try {
      return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      throw new UsageError(`git ${args[0]} in ${cwd} failed: ${String(e.stderr || e.message).trim()}`);
    }
  };
  const top = git('rev-parse', '--show-toplevel').trim();
  const paths = (out) => out.split('\0').filter(Boolean).sort();
  // Git records a symlink as its target text, so the fingerprint does too.
  const onDisk = (p) => {
    const abs = join(top, p);
    const st = lstatSync(abs, { throwIfNoEntry: false });
    if (!st) return 'deleted';
    if (st.isSymbolicLink()) return `link:${readlinkSync(abs)}`;
    return st.isFile() ? sha256(readFileSync(abs)) : 'not-a-file';
  };
  const index = git('ls-files', '-s', '-z');
  const modified = paths(git('diff', '--name-only', '-z')).map((p) => [p, onDisk(p)]);
  const untracked = paths(git('ls-files', '--others', '--exclude-standard', '--full-name', '-z')).map((p) => [p, onDisk(p)]);
  return sha256(JSON.stringify([index, modified, untracked]));
}

export async function planRun({ scope, repoRoot = null, citations = [], prose = [], files, session = null, cache = true }) {
  if (!SCOPES.includes(scope)) throw new UsageError(`--scope must be one of ${SCOPES.join(', ')}`);
  if (scope !== 'document' && !repoRoot) throw new UsageError('--repo-root is required for the sweep and path scopes');
  if (!files.length) throw new UsageError('no files to plan');
  // Before the run directory exists, so a git failure leaves nothing behind.
  const fingerprint = cache && scope !== 'document' ? repoFingerprint(repoRoot) : null;
  const run = mkdtempSync(join(session ? checkedSession(session) : startSession().session, 'lane6-'));
  mkdirSync(join(run, 'prompts'));
  mkdirSync(join(run, 'results'));
  if (cache) {
    mkdirSync(cacheDir(run), { recursive: true, mode: 0o700 });
    pruneCache(run);
  }
  const m = { version: 1, scope, repoRoot, cache, fingerprint, eof: `LANE6_EOF_${randomBytes(8).toString('hex')}`, seq: 0, files: [], jobs: [], skipped: [], other: [], unmatched: [] };
  const readmes = new Set(readmeNames());
  // Sweep and path scopes audit and report the real path (check-prose.mjs does
  // the same); document scope keeps the path it was given. Either way a
  // symlink and its target are one file.
  const seenReal = new Set();
  const planned = [];
  for (const given of files) {
    const r = real(given);
    if (seenReal.has(r)) continue;
    seenReal.add(r);
    planned.push({ given, file: scope === 'document' ? given : r, real: r });
  }
  const adjudicated = prose.filter((p) => ADJUDICATED.includes(p.code)).map((p) => ({ ...p, real: real(p.file) }));
  for (const { given, file, real: fileReal } of planned) {
    const text = readFileSync(file, 'utf8');
    if (file.endsWith('.mmd')) {
      m.files.push({ file, lines: countLines(text), diagramOnly: true });
      if (scope !== 'document') addJob(m, 'diagram-drift', file, 1, { startLine: 1 });
      continue;
    }
    const model = await parseDoc(file, text);
    const f = {
      file,
      lines: model.lines,
      rootReadme: scope !== 'document' && [given, file].some((p) => real(dirname(p)) === real(repoRoot)) && readmes.has(basename(given)),
      sources: scope === 'document' ? citedSources(citations, file) : null,
      expanded: { grounding: false, verify: false },
      claims: 0,
    };
    m.files.push(f);
    addJob(m, 'grounding', file, 1, {});
    const { chunks } = chunkDoc(model);
    for (const c of chunks) addJob(m, 'plain-language', file, 1, { start: c.start, end: c.end });
    if (scope !== 'document') {
      for (const c of chunks) addJob(m, 'drift-extract', file, 1, { start: c.start, end: c.end });
      for (const d of model.diagrams) addJob(m, 'diagram-drift', file, 1, { startLine: d.startLine });
    }
    const candidates = adjudicated
      .filter((p) => p.real === fileReal)
      .map((p, i) => ({ id: `P${i + 1}`, code: p.code, line: p.line, message: p.message }));
    if (candidates.length) addJob(m, 'adjudicate', file, 1, { candidates });
    if (scope === 'document' && !f.sources) m.other.push(`content drift: ${file} — no cited sources`);
  }
  const orphans = new Map();
  for (const p of adjudicated.filter((x) => !seenReal.has(x.real))) {
    orphans.set(p.file, [...(orphans.get(p.file) ?? []), { code: p.code, line: p.line, message: p.message }]);
  }
  m.unmatched = [...orphans].map(([file, candidates]) => ({ file, candidates }));
  saveManifest(run, m);
  return { run, ...withLock(run, () => advance(run)) };
}

export async function nextBatch(run) {
  return withLock(run, () => advance(run));
}

// What a validator checks a payload against: the doc as it is now.
function validationCtx(m, job) {
  const f = m.files.find((x) => x.file === job.file);
  return {
    file: job.file,
    text: readFileSync(job.file, 'utf8'),
    lines: f.lines,
    start: job.params.start ?? 1,
    end: job.params.end ?? f.lines,
    claims: job.params.allClaims ?? job.params.claims,
    candidates: job.params.candidates,
  };
}

// Everything a reply depends on: its first-attempt prompt (no retry note),
// the doc's bytes, and what KINDS[kind].reads names beyond the doc. Computed
// once, before the first dispatch: a drift-verify retry narrows its claims.
function cacheKey(m, job, docHash) {
  const reads = KINDS[job.kind].reads;
  let extra = null;
  if (reads === 'repo') extra = m.fingerprint;
  else if (reads === 'sources') {
    const { local, snapshots } = job.params.sources;
    extra = [...local, ...snapshots].sort().map((p) => {
      const st = statSync(p, { throwIfNoEntry: false });
      return [p, st?.isFile() ? sha256(readFileSync(p)) : st ? 'not-a-file' : 'missing'];
    });
  }
  return sha256(JSON.stringify([CACHE_VERSION, job.kind, render(m, job), docHash, extra]));
}

// An entry is untrusted: it is used only if it passes the kind's validator on
// the doc as it is now. A drift-verify reply may omit claims and be retried
// for them, so its entry, the merged reply, must answer every claim. An entry
// that fails, or cannot be read or parsed, is deleted.
function lookup(run, m, job) {
  job.docHash = sha256(readFileSync(job.file));
  job.key = cacheKey(m, job, job.docHash);
  const path = entryPath(run, job.key);
  if (!existsSync(path)) return false;
  let entry;
  try {
    entry = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    entry = null;
  }
  const ok = entry?.version === CACHE_VERSION && entry.kind === job.kind
    && KINDS[job.kind].validate(entry.payload, validationCtx(m, job)).ok
    && (job.kind !== 'drift-verify' || entry.payload.verdicts.length === job.params.allClaims.length);
  if (!ok) {
    rmSync(path, { force: true });
    return false;
  }
  Object.assign(job, { status: 'ok', payload: entry.payload, cached: true });
  const now = new Date();
  try {
    utimesSync(path, now, now);
  } catch (e) {
    // A concurrent audit's prune may have deleted the entry since it was read.
    if (e.code !== 'ENOENT') throw e;
  }
  return true;
}

// Only a job that ended ok is stored, with its final payload. A job has a key
// only when the run caches. The key was fixed before the reply was read, so a
// doc or repo that changed since may have been what the reply saw: skip then.
function store(run, m, job, repoNow) {
  if (!job.key || sha256(readFileSync(job.file)) !== job.docHash) return;
  if (KINDS[job.kind].reads === 'repo' && m.scope !== 'document' && repoNow() !== m.fingerprint) return;
  atomicWrite(entryPath(run, job.key), JSON.stringify({ version: CACHE_VERSION, kind: job.kind, file: job.file, payload: job.payload }) + '\n');
}

function settle(run, m, job, repoNow) {
  const path = resultPath(run, job);
  const r = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { ok: false, reason: 'no reply was recorded', remediation: null };
  if (r.ok && job.kind === 'drift-verify') {
    const answered = new Set((job.payload?.verdicts ?? []).map((v) => v.id));
    job.payload = { verdicts: [...(job.payload?.verdicts ?? []), ...r.payload.verdicts.filter((v) => !answered.has(v.id))] };
    for (const v of job.payload.verdicts) answered.add(v.id);
    job.params.claims = job.params.claims.filter((c) => !answered.has(c.id));
    if (!job.params.claims.length) {
      job.status = 'ok';
      store(run, m, job, repoNow);
      return;
    }
    const ids = job.params.claims.map((c) => c.id).join(', ');
    Object.assign(r, { ok: false, reason: `no verdict for ${ids}`, remediation: `Return one verdict for each of ${ids}.` });
  } else if (r.ok) {
    job.status = 'ok';
    job.payload = r.payload;
    store(run, m, job, repoNow);
    return;
  }
  job.reason = r.reason;
  job.remediation = r.remediation;
  job.status = job.attempts < MAX_ATTEMPTS ? 'due' : 'failed';
}

function expand(m) {
  for (const f of m.files) {
    if (f.diagramOnly) continue;
    const g = m.jobs.find((j) => j.kind === 'grounding' && j.file === f.file);
    if (!f.expanded.grounding && ended(g)) {
      f.expanded.grounding = true;
      const ok = g.status === 'ok';
      const kinds = groundedKinds(m.scope, f, ok ? g.payload.mode : null);
      if (ok) for (const k of kinds) addJob(m, k, f.file, 2, k === 'drift-cited' ? { sources: f.sources } : {});
      else m.skipped.push({ file: f.file, kinds });
    }
    const extracts = m.jobs.filter((j) => j.kind === 'drift-extract' && j.file === f.file);
    if (!f.expanded.verify && extracts.length && extracts.every(ended)) {
      f.expanded.verify = true;
      const claims = extracts.filter((j) => j.status === 'ok').flatMap((j) => j.payload.claims).map((c, i) => ({ ...c, id: `C${i + 1}` }));
      f.claims = claims.length;
      for (let i = 0; i < claims.length; i += VERIFY_BATCH) {
        const batch = claims.slice(i, i + VERIFY_BATCH);
        addJob(m, 'drift-verify', f.file, 2, { claims: batch, allClaims: batch });
      }
    }
  }
}

// The repo as it is now, fingerprinted at most once per advance or collect.
function lazyFingerprint(m) {
  let now;
  return () => (now ??= repoFingerprint(m.repoRoot));
}

function advance(run) {
  const m = loadManifest(run);
  const repoNow = lazyFingerprint(m);
  for (const job of m.jobs) if (job.status === 'dispatched') settle(run, m, job, repoNow);
  // A cache hit ends a job, which can release wave-2 jobs, which can hit in turn.
  let n;
  let hits;
  do {
    n = m.jobs.length;
    hits = 0;
    if (m.cache) for (const job of m.jobs) if (job.status === 'due' && !job.key && lookup(run, m, job)) hits += 1;
    expand(m);
  } while (hits || m.jobs.length !== n);
  const due = m.jobs.filter((j) => j.status === 'due').slice(0, BATCH_SIZE);
  const out = [];
  for (const job of due) {
    job.status = 'dispatched';
    job.attempts += 1;
    const prompt = render(m, job);
    writeFileSync(promptPath(run, job), prompt);
    out.push({ id: job.id, kind: job.kind, file: job.file, description: describe(job), prompt, prompt_file: promptPath(run, job) });
  }
  saveManifest(run, m);
  if (!out.length) return { status: 'done' };
  return { status: 'dispatch', run, eof: m.eof, wave: Math.min(...due.map((j) => j.wave)), jobs: out };
}

function describe(job) {
  const p = job.params;
  const where = CHUNKED.has(job.kind) ? ` ${p.start}-${p.end}` : job.kind === 'diagram-drift' ? ` @${p.startLine}` : '';
  return `${KINDS[job.kind].label}: ${basename(job.file)}${where}`;
}

function fill(name, vars, job) {
  const tpl = readFileSync(join(PROMPTS, `${name}.md`), 'utf8');
  return tpl.replace(/\{\{([a-z_]+)\}\}/g, (_, k) => {
    if (vars[k] === undefined || vars[k] === null) throw new Error(`prompt ${name}.md uses {{${k}}}, which job ${job.id} does not supply`);
    return String(vars[k]);
  });
}

const list = (xs) => (xs.length ? xs.join(', ') : 'none');

function render(m, job) {
  const g = m.jobs.find((j) => j.kind === 'grounding' && j.file === job.file && j.status === 'ok')?.payload;
  const p = job.params;
  const vars = {
    file: job.file,
    repo_root: m.repoRoot,
    start: p.start,
    end: p.end,
    line: p.startLine,
    mode: g?.mode,
    audience: g?.audience,
    outcome: g?.outcome,
    claims: p.claims?.map((c) => `${c.id} (${c.kind}, line ${c.line}): "${c.quote}" — target: ${c.target}`).join('\n'),
    candidates: p.candidates?.map((c) => `${c.id} (${c.code}, line ${c.line}): ${c.message}`).join('\n'),
    local_sources: p.sources && list(p.sources.local),
    snapshots: p.sources && list(p.sources.snapshots),
    unread_sources: p.sources && list(p.sources.unread),
  };
  const parts = [fill('_read-only', vars, job)];
  if (m.scope === 'document') parts.push(fill('_untrusted', vars, job));
  if (KINDS[job.kind].groundingNote) parts.push(fill('_grounding-note', vars, job));
  parts.push(fill(job.kind, vars, job));
  if (job.remediation) parts.push(`Your previous reply was rejected: ${job.reason}. ${job.remediation}\n`);
  return parts.join('\n');
}

function judge(m, job, reply) {
  if (reply.split(/\r?\n/).includes(m.eof)) return { ok: false, reason: `the reply contains a line ${m.eof}`, remediation: `Never write a line ${m.eof}.` };
  let payload;
  try {
    payload = extractJson(reply);
  } catch (e) {
    return { ok: false, reason: `no JSON object (${e.message})`, remediation: 'End the reply with one fenced json block holding the JSON object the prompt asks for.' };
  }
  return KINDS[job.kind].validate(payload, validationCtx(m, job));
}

export function recordReply(run, id, reply) {
  const m = loadManifest(run);
  const job = m.jobs.find((j) => j.id === id);
  if (!job) return { status: 'invalid', reason: `no job ${id} in this run`, remediation: 'Record only ids that plan or next dispatched.', retry: false };
  if (job.status === 'ok') return { status: 'ok' };
  if (job.status !== 'dispatched') return { status: 'invalid', reason: `job ${id} is ${job.status}, not dispatched`, remediation: 'Record a reply only for a job in the current batch.', retry: false };
  const path = resultPath(run, job);
  let r;
  if (existsSync(path)) {
    r = JSON.parse(readFileSync(path, 'utf8'));
  } else {
    writeFileSync(join(run, 'results', `${job.id}.${job.attempts}.raw.md`), reply);
    r = judge(m, job, reply);
    atomicWrite(path, JSON.stringify(r) + '\n');
  }
  return r.ok ? { status: 'ok' } : { status: 'invalid', reason: r.reason, remediation: r.remediation, retry: job.attempts < MAX_ATTEMPTS };
}

const cell = (s) => s.replace(/\r\n|\r|\n/g, ' ').replace(/\|/g, '\\|');

function partName(job) {
  const p = job.params;
  let where = '';
  if (CHUNKED.has(job.kind)) where = ` lines ${p.start}-${p.end}`;
  else if (job.kind === 'drift-verify') where = ` claims ${p.claims.map((c) => c.id).join(', ')}`;
  else if (job.kind === 'diagram-drift') where = ` diagram at line ${p.startLine}`;
  const why = job.status === 'failed' ? job.reason : 'not finished before collect';
  return `${KINDS[job.kind].label}${where} (${why})`;
}

export function collectRun(run) {
  const m = loadManifest(run);
  const repoNow = lazyFingerprint(m);
  // Replies recorded after the last next still count. Settling here never writes
  // the manifest; it may store cache entries.
  for (const job of m.jobs) if (job.status === 'dispatched' && existsSync(resultPath(run, job))) settle(run, m, job, repoNow);
  const findings = [];
  const other = [...m.other];
  const failed = new Map();
  const fail = (file, part) => failed.set(file, [...(failed.get(file) ?? []), part]);
  for (const job of m.jobs) {
    if (job.status === 'ok') {
      const r = KINDS[job.kind].toFindings(job.payload, job);
      findings.push(...r.findings);
      other.push(...r.other);
      continue;
    }
    fail(job.file, partName(job));
    if (job.kind === 'adjudicate') findings.push(...unjudged(job));
    if (job.kind === 'drift-verify' && job.payload) findings.push(...KINDS['drift-verify'].toFindings(job.payload, job).findings);
  }
  for (const u of m.unmatched ?? []) {
    findings.push(...unjudged({ file: u.file, params: { candidates: u.candidates } }));
    fail(u.file, 'Lane 3 adjudication (file not in the Lane 6 plan)');
  }
  for (const s of m.skipped) for (const k of s.kinds) fail(s.file, `${KINDS[k].label} (grounding failed)`);
  for (const f of m.files) {
    if (f.diagramOnly) continue;
    if (!f.expanded.grounding) for (const k of groundedKinds(m.scope, f, null)) fail(f.file, `${KINDS[k].label} (never dispatched)`);
    const hasExtract = m.jobs.some((j) => j.kind === 'drift-extract' && j.file === f.file);
    if (hasExtract && !f.expanded.verify) fail(f.file, `${KINDS['drift-verify'].label} (never dispatched)`);
    if (f.expanded.verify && m.jobs.some((j) => j.kind === 'drift-extract' && j.file === f.file && j.status === 'ok')) {
      const verdicts = m.jobs.filter((j) => j.kind === 'drift-verify' && j.file === f.file).flatMap((j) => j.payload?.verdicts ?? []);
      const n = (v) => verdicts.filter((x) => x.verdict === v).length;
      other.push(`content drift: ${f.file} — ${f.claims} claims, ${n('drift')} drift, ${n('unverifiable')} unverifiable`);
    }
  }
  for (const [file, parts] of failed) {
    findings.push({ code: 'LANE_FAILED', severity: 'warning', file, line: null, note: `Lane 6: ${parts.join(', ')} did not run; unknown, not clean` });
  }
  const modes = {};
  for (const j of m.jobs) if (j.kind === 'grounding' && j.status === 'ok') modes[j.file] = j.payload.mode;
  other.push(`lane 6 run: ${run}`);
  return { status: 'collected', jobs: m.jobs.length, cached: m.jobs.filter((j) => j.cached).length, findings: findings.map((f) => ({ ...f, note: cell(f.note) })), other, modes };
}

const USAGE = `usage:
  lane6.mjs plan --scope sweep|path|document [--repo-root <dir>] [--citations <json>]... [--prose <json>] [--session <dir>] [--no-cache] <file>...
  lane6.mjs session              (print a new session directory for this audit's artifacts)
  lane6.mjs record <run> <id>    (reply on stdin, through <<'<eof>' with the eof from plan or next)
  lane6.mjs next <run>
  lane6.mjs collect <run>`;
const ID_RE = /^\d{3,}-[a-z-]+$/;

function runDir(arg) {
  if (!existsSync(join(arg, 'manifest.json'))) throw new UsageError(`${arg}: not a lane6 run directory`);
  if (loadManifest(arg).version !== 1) throw new UsageError(`${arg}: unsupported manifest version`);
  return arg;
}

function readJsonFile(path, option) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new UsageError(`${option} ${path}: ${e.message}`);
  }
}

function parsePlanArgs(args) {
  const opts = { scope: null, repoRoot: null, citations: [], prose: [], files: [], cache: true };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const value = () => {
      if (i + 1 >= args.length) throw new UsageError(`${a} needs a value`);
      return args[++i];
    };
    if (a === '--scope') opts.scope = value();
    else if (a === '--repo-root') opts.repoRoot = value();
    else if (a === '--citations') opts.citations.push(readJsonFile(value(), '--citations'));
    else if (a === '--session') opts.session = value();
    else if (a === '--prose') opts.prose = readJsonFile(value(), '--prose').findings ?? [];
    else if (a === '--no-cache') opts.cache = false;
    else if (a.startsWith('--')) throw new UsageError(`unknown option ${a}`);
    else opts.files.push(a);
  }
  return opts;
}

async function main(args) {
  const [cmd, ...rest] = args;
  let out;
  if (cmd === 'session' && rest.length === 0) out = startSession();
  else if (cmd === 'plan') out = await planRun(parsePlanArgs(rest));
  else if (cmd === 'next' && rest.length === 1) out = await nextBatch(runDir(rest[0]));
  else if (cmd === 'collect' && rest.length === 1) out = collectRun(runDir(rest[0]));
  else if (cmd === 'record' && rest.length === 2) {
    if (!ID_RE.test(rest[1])) throw new UsageError(`${rest[1]}: not a job id`);
    out = recordReply(runDir(rest[0]), rest[1], readFileSync(0, 'utf8'));
  } else throw new UsageError(USAGE);
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  // exitCode, not exit(): on a pipe, stdout is written asynchronously, and
  // process.exit() would cut the JSON at the pipe buffer (64 KB).
  process.exitCode = out.status === 'invalid' ? 1 : 0;
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    process.stderr.write(e instanceof UsageError ? `lane6: ${e.message}\n` : 'lane6: internal error: ' + (e && e.stack ? e.stack : e) + '\n');
    process.exitCode = 2;
  });
}
