#!/usr/bin/env node
// Staleness: the README (any registered README name) and doc files in any
// registered format under docs/ whose last commit is a strict ancestor, in
// the actual commit graph, of the project's latest source commit.
//
// Staleness is judged by ancestry (`git merge-base --is-ancestor <doc-sha>
// <source-sha>`), not by comparing `%ct` timestamps: two commits landing in
// the same wall-clock second compare equal, and a committer date can be
// skewed (rebased, backdated, clock drift) relative to where the commit
// actually sits in history. Ancestry answers the question staleness is
// actually asking — "did this doc's content predate that source change?" —
// directly from the graph. Three cases fall out of comparing SHAs instead of
// times:
//   - the same commit touches both doc and source: SHAs are equal, so it's
//     never stale, regardless of what any parser makes of the timestamp;
//   - a doc last changed on a branch that merged in *after* the source
//     change: the doc's commit is not an ancestor of the (pre-merge) source
//     commit, so it's not stale, even though its author date can be earlier;
//   - a doc newer than source is, by definition, never an ancestor of an
//     earlier source commit, so it's never stale.
//
// "Source" comes from GitHub Linguist's data (vendor/linguist.json, built by
// `task vendor` at a pinned Linguist tag): a path is source if its extension or
// exact filename belongs to a programming or markup language (the rule is in
// .taskfiles/scripts/build-linguist-data.mjs), and it is not vendored,
// documentation, or under a dot-directory. A dot-directory *path component* is
// excluded (e.g. .git/, .github/), but a dotfile itself (e.g. .eslintrc.js) is
// classified like any other file — only the directories above it are checked.
// Classification works on names, so a commit that deletes source still counts
// as a source change.
//
// The latest-source-commit scan walks the full history, newest-first, and
// stops at the first commit that touches a source path, recording that
// commit's SHA (`%H`) rather than its timestamp. This is a plain `git log`,
// not pathspec-restricted: a pathspec glob like `**/*.ext` (tried and
// measured) forces git to evaluate the glob against every changed path in
// every commit instead of a cheap unfiltered diff, which came out 2-4x
// *slower* than the full walk on a real-world history. Stopping at the first
// match keeps the full walk's worst case (a repo whose only source commit is
// the very first one) to about 1s per ~35k commits of history (measured on
// django), and far less whenever source was touched recently.
//
// The scan also passes `--root` (a caller's `log.showRoot=false` would
// otherwise hide the initial commit's files), `--cc` (surfaces a source edit
// made only to resolve a merge conflict — plain `--name-only` omits
// merge-commit diffs entirely), and `-c log.showSignature=false` (a caller's
// signing config could otherwise inject extra lines into the porcelain
// output this script parses).
//
// When no commit ever touched source (a docs-only repo, an empty repo), staleness
// cannot be judged: emit STALENESS_NOT_ASSESSED rather than a clean pass.
//
// STALE_DOC resolves each candidate doc's realpath before checking or
// reporting it: a symlink and its target collapse into a single finding,
// reported once at the target's canonical path relative to the repo root —
// the same dedupe Lanes 3 and 4 (check-prose.mjs, check-refs.mjs) apply to
// symlinked docs. ADRs under docs/dev/adr/ or docs/adr/ are dated records,
// not descriptions that drift, so they are excluded from STALE_DOC (this
// does not apply to STALE_README, which only ever names the README).
//
// Output: JSON {status, findings:[{code, severity, file, message}]} on
// stdout. STALE_README and STALE_DOC findings also carry sourceCommit (the
// latest source commit's short SHA), sourcePath (the first source path that
// commit touched), and commitsSince (`git rev-list --count <doc>..<source>`)
// — enough detail to act on without re-deriving it by hand.
// Exit 0 = no findings, 1 = findings, 2 = internal error. Uses git with fixed
// arguments and no shell.

import { readFileSync, realpathSync } from 'node:fs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './is-main.mjs';
import { formatFor, readmeNames } from './formats/index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const LINGUIST = JSON.parse(readFileSync(join(HERE, 'vendor', 'linguist.json'), 'utf8'));
const EXTENSIONS = new Set(LINGUIST.extensions);
const FILENAMES = new Set(LINGUIST.filenames);
const EXCLUDE = LINGUIST.excludePaths.map((p) => new RegExp(p));
const LLM_CONFIG = new Set(['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', '.cursorrules']);

export function isSource(path) {
  const parts = path.split('/');
  if (parts.slice(0, -1).some((d) => d.startsWith('.'))) return false;
  if (EXCLUDE.some((re) => re.test(path))) return false;
  const name = parts[parts.length - 1];
  if (FILENAMES.has(name)) return true;
  const lower = name.toLowerCase();
  for (let i = lower.indexOf('.', 1); i !== -1; i = lower.indexOf('.', i + 1)) {
    if (EXTENSIONS.has(lower.slice(i))) return true;
  }
  return false;
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function hasCommits(root) {
  try { git(['rev-parse', '--verify', '-q', 'HEAD'], root); return true; }
  catch { return false; }
}

// Newest-first scan of the full history; stops at the first commit that
// touches a source path. Returns { sha, path } for that commit and the
// first source path the parser saw in it (or null if none found).
function latestSourceCommit(root) {
  return new Promise((resolvePromise, reject) => {
    const args = [
      '-c', 'log.showSignature=false',
      'log', '-z', '--root', '--cc', '--no-renames',
      '--format=%x01%H', '--name-only',
    ];
    const child = spawn('git', args, { cwd: root });
    let buf = '';
    let sha = null;
    let found = null;
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (found !== null) return;
      buf += chunk;
      const tokens = buf.split('\0');
      buf = tokens.pop();
      for (const tok of tokens) {
        if (tok.startsWith('\x01')) { sha = tok.slice(1); continue; }
        const name = tok.replace(/^\n/, '');
        if (name && isSource(name)) { found = { sha, path: name }; child.kill(); break; }
      }
    });
    child.on('close', (code) => {
      if (found !== null) return resolvePromise(found);
      if (code !== 0) return reject(new Error(`git log failed (${code}): ${stderr.trim()}`));
      resolvePromise(null);
    });
    child.on('error', reject);
  });
}

function shortSha(root, sha) {
  return git(['rev-parse', '--short', sha], root).trim();
}

// Commits between a doc's last commit and the source commit it's compared
// against — one `git rev-list --count` per stale doc, not per commit walked.
function commitsSince(root, docSha, sourceSha) {
  return parseInt(git(['rev-list', '--count', `${docSha}..${sourceSha}`], root).trim(), 10);
}

function lastCommitShaFor(root, path) {
  const out = git(['log', '-n', '1', '--format=%H', '--', path], root).trim();
  return out || null;
}

// True iff `ancestorSha` is a (non-strict) ancestor of `descendantSha` per
// `git merge-base --is-ancestor`: exit 0 = ancestor, 1 = not an ancestor,
// anything else is a real error (bad SHA, corrupt repo, ...) and throws.
function isAncestor(root, ancestorSha, descendantSha) {
  const result = spawnSync('git', ['merge-base', '--is-ancestor', ancestorSha, descendantSha], { cwd: root, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(`git merge-base --is-ancestor failed (${result.status}): ${(result.stderr || '').trim()}`);
}

// A doc is stale iff its last commit differs from the latest source commit
// and predates it in the commit graph (see the ancestry note at the top of
// this file for why timestamps can't answer this).
function isStale(root, docSha, sourceSha) {
  if (docSha === null) return false;
  if (docSha === sourceSha) return false;
  return isAncestor(root, docSha, sourceSha);
}

function isAdr(path) {
  return path.startsWith('docs/dev/adr/') || path.startsWith('docs/adr/');
}

function emit(findings) {
  const status = findings.length ? 'findings' : 'ok';
  process.stdout.write(JSON.stringify({ status, findings }, null, 2) + '\n');
  process.exit(findings.length ? 1 : 0);
}

async function main() {
  let root;
  try { root = git(['rev-parse', '--show-toplevel'], process.cwd()).trim(); }
  catch {
    process.stdout.write(JSON.stringify({ status: 'error', message: 'not a git repo' }) + '\n');
    process.exit(2);
  }
  const latestSource = hasCommits(root) ? await latestSourceCommit(root) : null;
  if (latestSource === null) {
    return emit([{
      code: 'STALENESS_NOT_ASSESSED', severity: 'warning',
      message: `No source recognized: no commit touches a file that GitHub Linguist (${LINGUIST.source}) classifies as programming- or markup-language source outside vendored, documentation, and dot-directory paths. The README and docs/ were NOT checked for staleness.`,
    }]);
  }
  const { sha: sourceSha, path: sourcePath } = latestSource;
  const sourceShort = shortSha(root, sourceSha);
  const findings = [];
  const readmes = readmeNames();
  const tracked = git(['ls-files', '-z', '--', ...readmes, 'docs/'], root).split('\0').filter(Boolean);
  for (const readme of readmes) {
    if (!tracked.includes(readme)) continue;
    const docSha = lastCommitShaFor(root, readme);
    if (isStale(root, docSha, sourceSha)) {
      const since = commitsSince(root, docSha, sourceSha);
      findings.push({
        code: 'STALE_README', severity: 'warning', file: readme,
        sourceCommit: sourceShort, sourcePath, commitsSince: since,
        message: `${readme} last touched before latest source change: ${sourcePath} changed ${since} commit${since === 1 ? '' : 's'} since (latest ${sourceShort}). Re-read for drift.`,
      });
    }
  }
  const rootReal = realpathSync(root);
  const seenDocs = new Set();
  for (const f of tracked) {
    if (!f.startsWith('docs/') || !formatFor(f)) continue;
    if (f.startsWith('docs/superpowers/')) continue;
    const parts = f.split('/');
    if (parts.slice(0, -1).some((d) => d.startsWith('.'))) continue;
    if (LLM_CONFIG.has(parts[parts.length - 1])) continue;
    if (isAdr(f)) continue;
    // Resolve a symlinked doc to its target and report once, at the
    // target's canonical repo-relative path.
    const canonical = relative(rootReal, realpathSync(join(root, f)));
    if (seenDocs.has(canonical)) continue;
    seenDocs.add(canonical);
    const docSha = lastCommitShaFor(root, canonical);
    if (isStale(root, docSha, sourceSha)) {
      const since = commitsSince(root, docSha, sourceSha);
      findings.push({
        code: 'STALE_DOC', severity: 'info', file: canonical,
        sourceCommit: sourceShort, sourcePath, commitsSince: since,
        message: `${canonical} last touched before latest source change: ${sourcePath} changed ${since} commit${since === 1 ? '' : 's'} since (latest ${sourceShort}). Re-read for drift.`,
      });
    }
  }
  emit(findings);
}

if (isMain(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write('check-staleness: internal error: ' + (e && e.stack ? e.stack : e) + '\n');
    process.exit(2);
  });
}
