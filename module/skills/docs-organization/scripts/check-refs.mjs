#!/usr/bin/env node
// Reference integrity: a reference should be *followable*.
//
//   REF_BROKEN     a markdown link or image to a local path that resolves to nothing
//   REF_NOT_IN_GIT a markdown link or image to a file that exists but git does not track
//                  (gitignored/unstaged) — dangling for anyone who clones
//   UNLINKED_REF   a "§" section citation in prose with no link in the same
//                  inline block (paragraph, heading, or table cell) —
//                  a cheap, deterministic tell for a reference that points at
//                  something (often an external/internal spec) the reader can't
//                  follow. Info only: the fix is to LINK it (or confirm the
//                  target ships), never to strip the citation.
//
// Design notes:
//   - Only *markdown links and images* are resolved. Their targets are
//     unambiguously doc-relative and express intent ("follow this"). Inline-code
//     mentions of source paths are deliberately NOT resolved — they are
//     repo-root-relative, riddled with placeholders (`<dir>/x.yaml`,
//     `pool/<blake3>.tar.zst`), and resolving them heuristically produces
//     mostly false positives. Stale
//     source citations are the content-drift lane's job.
//   - Only *git-tracked* docs are scanned. A gitignored working doc (e.g. under
//     docs/superpowers/) is not a project deliverable and is out of audit scope.
//   - This does NOT demand every reference be committed — some are legitimately
//     private/external. It surfaces dangling references for the author to
//     resolve in /docs-update (link, commit, or mark external). Never auto-fixes.
//   - A symlinked doc is checked from *every* path it is reached by: a relative
//     link resolves from the path a reader opened, and an installed module is
//     read from the symlink's location. A broken/untracked-link finding on a
//     symlinked path names the canonical file. Content-only findings
//     (UNLINKED_REF) don't depend on which path they're read from, so they are
//     attributed to the canonical path (when it's in scope) and reported once.
//
// Output: JSON {status, scanned, findings:[{code, severity, file, line, message}]}.
// `scanned` counts tracked doc *paths* checked — a symlink and its target
// count separately.
// Exit 0 = no findings, 1 = findings, 2 = internal error. Uses execFileSync
// (no shell) with fixed git arguments.

import MarkdownIt from './vendor/markdown-it.mjs';
import { readFileSync, existsSync, lstatSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve, relative } from 'node:path';
import { walkMarkdown } from './md-files.mjs';
import { isMain } from './is-main.mjs';

const md = new MarkdownIt();

// Exact line numbers. markdown-it maps only *blocks* to source lines; inline
// tokens carry no position. An inline token's `content` is its block's source
// lines joined by "\n" (indent and `>` markers stripped, line count kept), so
// a token's line within the block is the number of "\n" before the position
// it starts at. Counting softbreak tokens instead would miss newlines a single
// token swallows (a wrapped code span, a link title spanning two lines).
//
// So every inline rule is wrapped: when it matches (non-silent), each token it
// created that is not yet stamped gets the line of the rule's start position.
// Nested rules (link text) run first and stamp their own tokens. Pending text
// flushed by the rule's first push ends exactly where the rule starts and
// contains no "\n" (the newline rule always flushes first), so it shares that
// line. The one flush outside any rule — trailing text at the end of the
// top-level tokenize — is stamped by a post-process rule with the last line.
const tokenLine = new WeakMap();
const lineAt = (src, pos) => {
  let n = 0;
  for (let i = src.indexOf('\n'); i !== -1 && i < pos; i = src.indexOf('\n', i + 1)) n++;
  return n;
};
function stampNew(state, from, line) {
  for (let i = from; i < state.tokens.length; i++) {
    if (!tokenLine.has(state.tokens[i])) tokenLine.set(state.tokens[i], line);
  }
}
for (const rule of [...md.inline.ruler.__rules__]) {
  const orig = rule.fn;
  md.inline.ruler.at(rule.name, (state, silent) => {
    const start = state.pos;
    const from = state.tokens.length;
    const ok = orig(state, silent);
    if (ok && !silent) stampNew(state, from, lineAt(state.src, start));
    return ok;
  }, { alt: rule.alt });
}
md.inline.ruler2.before('balance_pairs', 'stamp_trailing_text', (state) => {
  stampNew(state, 0, lineAt(state.src, state.src.length));
});

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function isExternal(t) {
  return /^[a-z]+:\/\//i.test(t) || t.startsWith('mailto:') || t.startsWith('#') || t.startsWith('tel:')
    || /^data:/i.test(t);
}

// markdown-it percent-encodes every href before we ever see it — a literal
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

// Pull link and image targets and unlinked "§" citations from a file, each
// with its exact 1-based line. Reference-style links/images report the line
// they are *used* on (where the reader meets them), not the definition line.
//
// A "§" is skipped when it sits inside link text, or when the same inline
// block (one paragraph, heading, list-item paragraph, or table cell) contains
// any link — "§3.2 of [spec](spec.md)" already tells the reader where to go.
// A link in a different paragraph or a sibling table cell does not count.
function extract(content) {
  const tokens = md.parse(content, {});
  const links = [];
  const sections = [];
  let rowStart = null; // table cells have no map; their row (tr_open) does
  for (const b of tokens) {
    if (b.type === 'tr_open') rowStart = b.map[0];
    if (b.type !== 'inline' || !b.children) continue;
    const base = b.map ? b.map[0] : rowStart;
    const lineOf = (tok) => base + tokenLine.get(tok) + 1;
    const blockSections = [];
    let linkDepth = 0;
    let hasLink = false;
    for (const c of b.children) {
      if (c.type === 'link_open') {
        linkDepth++;
        hasLink = true;
        const href = c.attrGet('href');
        if (href) links.push({ kind: 'link', target: href, line: lineOf(c) });
      } else if (c.type === 'link_close') {
        linkDepth = Math.max(0, linkDepth - 1);
      } else if (c.type === 'image') {
        const src = c.attrGet('src');
        if (src) links.push({ kind: 'image', target: src, line: lineOf(c) });
      } else if (c.type === 'text' && linkDepth === 0 && c.content.includes('§')) {
        const m = c.content.match(/§\s*[\w.\-]*/);
        blockSections.push({ line: lineOf(c), snippet: (m ? m[0] : '§').slice(0, 24) });
      }
    }
    if (!hasLink) sections.push(...blockSections);
  }
  return { links, sections };
}

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

export function analyzeFile(file, root, tracked) {
  const content = readFileSync(file, 'utf8');
  const findings = [];
  const seen = new Set();
  const trackedDirs = trackedDirsOf(tracked);
  const { links, sections } = extract(content);
  for (const ref of links) {
    const target = ref.target;
    if (!target || isExternal(target)) continue;
    const stripped = target.replace(/[#].*$/, '');
    if (!stripped) continue; // pure anchor
    const cleaned = decodeTarget(stripped);
    const abs = resolve(dirname(file), cleaned);
    const rel = relative(root, abs);
    if (rel.startsWith('..')) continue;
    const key = 'L' + rel + '@' + ref.line;
    // A tracked file, or a directory that contains tracked files, is followable.
    if (seen.has(key) || tracked.has(rel) || trackedDirs.has(rel)) continue;
    seen.add(key);
    if (existsSync(abs)) {
      findings.push({
        code: 'REF_NOT_IN_GIT', severity: 'warning', line: ref.line,
        message: `${ref.kind === 'image' ? 'image' : 'link to'} \`${cleaned}\` — exists but is NOT git-tracked (gitignored/unstaged); commit it, or make it an explicit external link if intentionally private`,
      });
    } else {
      findings.push({
        code: 'REF_BROKEN', severity: 'warning', line: ref.line,
        message: `${ref.kind === 'image' ? 'image' : 'link to'} \`${cleaned}\` — no such file in the repo; fix the path or link the real target`,
      });
    }
  }
  for (const s of sections) {
    findings.push({
      code: 'UNLINKED_REF', severity: 'info', line: s.line,
      message: `section citation "${s.snippet}" has no link — verify the referenced section is followable and add a link (keep the citation)`,
    });
  }
  findings.sort((a, b) => (a.line || 0) - (b.line || 0));
  return findings;
}

function main(argv) {
  const targets = argv.slice(2);
  if (targets.length === 0) {
    process.stderr.write('usage: check-refs.mjs <file-or-dir>...\n');
    process.exit(2);
  }
  const root = git(['rev-parse', '--show-toplevel']).trim();
  // -z: git quotes non-ASCII/special filenames in plain `ls-files` output
  // (core.quotePath default) — NUL-delimited output is unquoted, matching
  // what decodeTarget() produces from a percent-encoded link target.
  const tracked = new Set(git(['ls-files', '-z'], root).split('\0').filter(Boolean));

  // Collect every tracked doc path first, then process non-symlink paths
  // before symlink paths (stable order within each group). That way a
  // content-only finding lands on the canonical path whenever it's in scope,
  // regardless of the order targets were given on the command line.
  const paths = [];
  for (const t of targets) for (const f of walkMarkdown(t)) {
    const rel = relative(root, f);
    if (!tracked.has(rel)) continue; // only audit tracked docs (skips gitignored)
    paths.push(f);
  }
  const scanned = paths.length;
  const ordered = [
    ...paths.filter((f) => !lstatSync(f).isSymbolicLink()),
    ...paths.filter((f) => lstatSync(f).isSymbolicLink()),
  ];

  const findings = [];
  const seenReal = new Set();
  for (const f of ordered) {
    const rel = relative(root, f);
    const real = realpathSync(f);
    const firstVisit = !seenReal.has(real);
    seenReal.add(real);
    const canonical = lstatSync(f).isSymbolicLink() ? relative(root, real) : null;
    for (const x of analyzeFile(f, root, tracked)) {
      if (x.code === 'UNLINKED_REF' && !firstVisit) continue; // same text, already reported
      if (canonical && x.code !== 'UNLINKED_REF') {
        x.message += ` (this path is a symlink to \`${canonical}\`; the link must work from both locations)`;
      }
      findings.push({ ...x, file: rel });
    }
  }
  process.stdout.write(JSON.stringify({ status: findings.length ? 'findings' : 'ok', scanned, findings }, null, 2) + '\n');
  process.exit(findings.length ? 1 : 0);
}

if (isMain(import.meta.url)) {
  try { main(process.argv); }
  catch (e) { process.stderr.write('check-refs: internal error: ' + (e && e.stack ? e.stack : e) + '\n'); process.exit(2); }
}
