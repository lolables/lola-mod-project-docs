#!/usr/bin/env node
// Reference integrity: a reference should be *followable*.
//
//   REF_BROKEN     a link, image, cross-reference, or include to a local path
//                  that resolves to nothing
//   REF_NOT_IN_GIT a link, image, cross-reference, or include to a file that
//                  exists but git does not track (gitignored/unstaged) —
//                  dangling for anyone who clones
//   UNLINKED_REF   a "§" section citation in prose with no link in the same
//                  inline block (paragraph, heading, or table cell) —
//                  a cheap, deterministic tell for a reference that points at
//                  something (often an external/internal spec) the reader can't
//                  follow. Info only: the fix is to LINK it (or confirm the
//                  target ships), never to strip the citation.
//   PARSE_WARNING  the format's parser warned about the file (an unterminated
//                  block, a malformed list). Info: reported here, once per
//                  file, because this lane already reads every doc.
//
// Design notes:
//   - Only links, images, cross-references, and includes written as such are
//     resolved (any registered format — formats/index.mjs). Their targets are
//     unambiguously doc-relative and express intent ("follow this"). Inline-code
//     mentions of source paths are deliberately NOT resolved — they are
//     repo-root-relative, riddled with placeholders (`<dir>/x.yaml`,
//     `pool/<blake3>.tar.zst`), and resolving them heuristically produces
//     mostly false positives. Stale
//     source citations are the content-drift lane's job.
//   - Each doc is checked in one of two modes, chosen per file from the git
//     work tree that contains it (if any):
//       git mode      the doc is tracked. Links resolve against the tracked
//                     file set; REF_NOT_IN_GIT applies.
//       on-disk mode  the doc is outside any git repo, or it was named as an
//                     explicit file argument and is untracked (a gitignored
//                     draft). Links resolve against the filesystem, anywhere
//                     on disk; REF_NOT_IN_GIT never fires, because a doc that
//                     isn't in git can't dangle for someone who clones.
//     An untracked doc found by *walking a directory* inside a repo is skipped:
//     a gitignored working doc (e.g. under docs/superpowers/) reached that way
//     is not a project deliverable and is out of audit scope.
//   - This does NOT demand every reference be committed — some are legitimately
//     private/external. It surfaces dangling references for the author to
//     resolve in /docs-update (link, commit, or mark external). Never auto-fixes.
//   - A symlinked doc is checked from *every* path it is reached by: a relative
//     link resolves from the path a reader opened, and an installed module is
//     read from the symlink's location. A broken/untracked-link finding on a
//     symlinked path names the canonical file. Content-only findings
//     (UNLINKED_REF, PARSE_WARNING) don't depend on which path they're read
//     from, so they are attributed to the canonical path (when it's in scope)
//     and reported once.
//
// Output: JSON {status, scanned, findings:[{code, severity, file, line, message}]}.
// `scanned` counts doc *paths* checked — a symlink and its target count
// separately. `file` is relative to the doc's repo root, or absolute for a
// doc outside any repo.
// Exit 0 = no findings, 1 = findings, 2 = internal error. Uses execFileSync
// (no shell) with fixed git arguments.

import { readFileSync, existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, dirname, join, resolve, relative } from 'node:path';
import { parseDoc } from './formats/index.mjs';
import { walkDocs } from './doc-files.mjs';
import { isMain } from './is-main.mjs';

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function isExternal(t) {
  return /^[a-z]+:\/\//i.test(t) || t.startsWith('mailto:') || t.startsWith('#') || t.startsWith('tel:')
    || /^data:/i.test(t);
}

// Targets can arrive percent-encoded (markdown-it encodes every href) — a literal
// space written inside `<...>`, or a non-ASCII byte written bare, comes out
// as `%20` / `%C3%A9` — so the target must be decoded before it can match a
// tracked filesystem path, and the decoded form is what findings report
// (closer to what the author actually wrote than the re-encoded href). A
// malformed escape (not a valid UTF-8 percent sequence) falls back to the
// raw string rather than throwing.
function decodeTarget(t) {
  try { return decodeURIComponent(t); }
  catch { return t; }
}

// Link-like references and unlinked "§" citations from a parsed doc.
// Reference-style links report the line they are *used* on (where the reader
// meets them), not the definition line — the adapter guarantees that.
//
// A "§" is skipped when it sits inside link text (texts never include link
// text), or when the same inline block (one paragraph, heading, list-item
// text, or table cell) holds a link — "§3.2 of [spec](spec.md)" already tells
// the reader where to go. Images and bare URLs don't count as that link: an
// image is not a pointer to read, and a bare URL was not written as one.
const CONTENT_ONLY = new Set(['UNLINKED_REF', 'PARSE_WARNING']);

function extract(model) {
  const links = model.links.filter((l) => !l.bare);
  const linked = new Set(links.filter((l) => l.kind !== 'image').map((l) => l.block));
  const sections = [];
  for (const t of model.texts) {
    if (linked.has(t.block) || !t.text.includes('§')) continue;
    const m = t.text.match(/§\s*[\w.\-]*/);
    sections.push({ line: t.line, snippet: (m ? m[0] : '§').slice(0, 24) });
  }
  return { links, sections };
}

const DESCRIBE = { image: 'image', include: 'include of', link: 'link to', xref: 'link to' };

// Every ancestor directory of a tracked file — git tracks files, not dirs, so a
// link to a real directory (`module/agents/`) would otherwise look untracked.
function trackedDirsOf(tracked) {
  const dirs = new Set();
  for (const f of tracked) {
    let d = dirname(f);
    while (d && d !== '.') { dirs.add(d); d = dirname(d); }
  }
  return dirs;
}

// `tracked` is the repo's tracked-path set (git mode), or null (on-disk mode,
// where `root` is unused).
export async function analyzeFile(file, root, tracked) {
  const content = readFileSync(file, 'utf8');
  const model = await parseDoc(file, content);
  const findings = [];
  const seen = new Set();
  const trackedDirs = tracked ? trackedDirsOf(tracked) : null;
  const { links, sections } = extract(model);
  for (const ref of links) {
    const target = ref.target;
    if (!target || isExternal(target)) continue;
    const stripped = target.replace(/[#].*$/, '');
    if (!stripped) continue; // pure anchor
    const cleaned = decodeTarget(stripped);
    const abs = resolve(dirname(file), cleaned);
    let where = abs;
    if (tracked) {
      where = relative(root, abs);
      if (where.startsWith('..')) continue;
      // A tracked file, or a directory that contains tracked files, is followable.
      if (tracked.has(where) || trackedDirs.has(where)) continue;
    } else if (existsSync(abs)) continue;
    const key = 'L' + where + '@' + ref.line;
    if (seen.has(key)) continue;
    seen.add(key);
    const what = `${DESCRIBE[ref.kind]} \`${cleaned}\``;
    if (tracked && existsSync(abs)) {
      findings.push({
        code: 'REF_NOT_IN_GIT', severity: 'warning', line: ref.line,
        message: `${what} — exists but is NOT git-tracked (gitignored/unstaged); commit it, or make it an explicit external link if intentionally private`,
      });
    } else {
      findings.push({
        code: 'REF_BROKEN', severity: 'warning', line: ref.line,
        message: `${what} — no such file ${tracked ? 'in the repo' : 'on disk'}; fix the path or link the real target`,
      });
    }
  }
  for (const s of sections) {
    findings.push({
      code: 'UNLINKED_REF', severity: 'info', line: s.line,
      message: `section citation "${s.snippet}" has no link — verify the referenced section is followable and add a link (keep the citation)`,
    });
  }
  for (const d of model.diagnostics) {
    findings.push({
      code: 'PARSE_WARNING', severity: 'info', line: d.line,
      message: `parser warning: ${d.message} — the rendered doc may not match what checks read; fix the markup`,
    });
  }
  findings.sort((a, b) => (a.line || 0) - (b.line || 0));
  return findings;
}

// The git work tree containing `dir`, or null when git itself says `dir` is
// not inside a repository — docs there are checked on disk. Any other git
// failure (corrupt config, a safe.directory refusal, git not installed) is
// not "outside git" and propagates so the caller exits 2 with git's message.
function repoRootOf(dir) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: dir,
      env: { ...process.env, LC_ALL: 'C' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (e) {
    if (typeof e.status === 'number' && /not a git repository/.test(e.stderr || '')) return null;
    if (typeof e.status === 'number') throw new Error(`git rev-parse --show-toplevel: ${(e.stderr || '').trim()}`);
    throw e;
  }
}

async function main(argv) {
  const targets = argv.slice(2);
  if (targets.length === 0) {
    process.stderr.write('usage: check-refs.mjs <file-or-dir>...\n');
    process.exit(2);
  }
  const rootOfDir = new Map();
  const trackedOf = new Map();
  const repoOf = (f) => {
    const dir = dirname(resolve(f));
    if (!rootOfDir.has(dir)) rootOfDir.set(dir, repoRootOf(dir));
    const root = rootOfDir.get(dir);
    // -z: git quotes non-ASCII/special filenames in plain `ls-files` output
    // (core.quotePath default) — NUL-delimited output is unquoted, matching
    // what decodeTarget() produces from a percent-encoded link target.
    if (root && !trackedOf.has(root)) {
      trackedOf.set(root, new Set(git(['ls-files', '-z'], root).split('\0').filter(Boolean)));
    }
    return root;
  };

  // Collect every doc to check first, then process non-symlink paths before
  // symlink paths (stable order within each group). That way a content-only
  // finding lands on the canonical path whenever it's in scope, regardless of
  // the order targets were given on the command line.
  const docs = [];
  for (const t of targets) {
    const explicitFile = statSync(t).isFile();
    for (const f of walkDocs(t)) {
      const root = repoOf(f);
      const tracked = root ? trackedOf.get(root) : null;
      // git reports the physical root, so match against the doc's physical
      // directory; the basename stays unresolved so a symlinked doc keeps
      // being judged from the path it was reached by.
      const phys = join(realpathSync(dirname(resolve(f))), basename(f));
      if (tracked && tracked.has(relative(root, phys))) docs.push({ f, phys, root, tracked });
      else if (!root || explicitFile) docs.push({ f, phys, root, tracked: null });
    }
  }
  const scanned = docs.length;
  const ordered = [
    ...docs.filter((d) => !lstatSync(d.f).isSymbolicLink()),
    ...docs.filter((d) => lstatSync(d.f).isSymbolicLink()),
  ];
  const shown = (root, p) => (root ? relative(root, p) : resolve(p));

  const findings = [];
  const seenReal = new Set();
  for (const { f, phys, root, tracked } of ordered) {
    const real = realpathSync(f);
    const firstVisit = !seenReal.has(real);
    seenReal.add(real);
    const canonical = lstatSync(f).isSymbolicLink() ? shown(root, real) : null;
    for (const x of await analyzeFile(tracked ? phys : f, root, tracked)) {
      if (CONTENT_ONLY.has(x.code) && !firstVisit) continue; // same text, already reported
      if (canonical && !CONTENT_ONLY.has(x.code)) {
        x.message += ` (this path is a symlink to \`${canonical}\`; the link must work from both locations)`;
      }
      findings.push({ ...x, file: shown(root, root ? phys : f) });
    }
  }
  process.stdout.write(JSON.stringify({ status: findings.length ? 'findings' : 'ok', scanned, findings }, null, 2) + '\n');
  process.exit(findings.length ? 1 : 0);
}

if (isMain(import.meta.url)) {
  main(process.argv).catch((e) => {
    process.stderr.write('check-refs: internal error: ' + (e && e.stack ? e.stack : e) + '\n');
    process.exit(2);
  });
}
