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
//   UNLINKED_POINTER  a stock phrase that sends the reader somewhere ("contact
//                  the maintainers", "see the contributing guide", "open an
//                  issue") with no link in the same inline block — the reader
//                  must hunt for the destination. Info only; the fix is to
//                  LINK the destination (or include its content in place), or
//                  to create it if the repo has none. Naming where to look
//                  ("see the Security section") is not a fix.
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
//   - In a repo whose docs mode is `site:antora` (docs-mode.mjs), an xref in a
//     file under the component's `modules/` is an Antora page ID, resolved by
//     antora.mjs. So is an image target (family defaults to `image$`) and an
//     include target that names a family (`partial$x.adoc`); a plain include
//     stays a path relative to the including file. An xref to another component or version, or one inside a
//     partial, is skipped: this repo cannot hold its target, so it is not
//     broken.
//   - This does NOT demand every reference be committed — some are legitimately
//     private/external. It surfaces dangling references for the author to
//     resolve in /docs-update (link, commit, or mark external). Never auto-fixes.
//   - A symlinked doc is checked from *every* path it is reached by: a relative
//     link resolves from the path a reader opened, and an installed module is
//     read from the symlink's location. A broken/untracked-link finding on a
//     symlinked path names the canonical file. Content-only findings
//     (UNLINKED_REF, UNLINKED_POINTER, PARSE_WARNING) don't depend on which path they're read
//     from, so they are attributed to the canonical path (when it's in scope)
//     and reported once.
//
// Output: JSON {status, scanned, findings:[{code, severity, file, line, message}]}.
// `scanned` counts doc *paths* checked — a symlink and its target count
// separately. `file` is relative to the doc's repo root, or absolute for a
// doc outside any repo.
// Exit 0 = no findings, 1 = findings, 2 = internal error or a malformed
// antora.yml. In the latter case every file is still checked and counted in
// `scanned`, except the refs that need the component (xrefs, images, resource-ID
// includes in AsciiDoc under its `modules/`); stderr names the config error and,
// per file, how many such refs went unchecked. An antora.yml with
// modules/*/pages/ beside it that site:antora does not cover (several
// components, a deeper one, one next to mkdocs.yml) gets the same unchecked
// treatment under "unsupported Antora layout", without changing the exit code.
// Uses execFileSync
// (no shell) with fixed git arguments.

import { readFileSync, existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, posix, resolve, relative } from 'node:path';
import { parseDoc } from './formats/index.mjs';
import { proseBlocks, lineAt } from './check-prose.mjs';
import { walkDocs } from './doc-files.mjs';
import { isMain } from './is-main.mjs';
import { ConfigError } from './site-yaml.mjs';
import { isExternal, decodeTarget, trackedDirsOf } from './link-targets.mjs';
import { detectMode, hasPages, inDotDir, gitTracked, repoRootOf } from './docs-mode.mjs';
import { loadComponent, resolveXref, resolveLink, antoraRefPolicy } from './antora.mjs';

// Link-like references and unlinked "§" citations from a parsed doc.
// Reference-style links report the line they are *used* on (where the reader
// meets them), not the definition line — the adapter guarantees that.
//
// A "§" is skipped when it sits inside link text (texts never include link
// text), or when the same inline block (one paragraph, heading, list-item
// text, or table cell) holds a link — "§3.2 of [spec](spec.md)" already tells
// the reader where to go. Images and bare URLs don't count as that link: an
// image is not a pointer to read, and a bare URL was not written as one.
const CONTENT_ONLY = new Set(['UNLINKED_REF', 'UNLINKED_POINTER', 'PARSE_WARNING']);

// Stock phrases that name a destination without saying where it is. A short,
// high-precision list: a phrase here nearly always needs a link, and wording
// outside it is left to the cold-read lane. Whole-word matches only; \s+ lets a
// phrase wrap across lines.
const POINTER_PHRASES = [
  String.raw`(?:contact|ask|email|ping|message)\s+(?:the|our|your)\s+(?:project\s+)?maintainers?`,
  String.raw`(?:see|read|check|consult|refer\s+to)\s+(?:the|our)\s+(?:contributing|security|support|governance|architecture|code\s+of\s+conduct)\s+(?:guide|guidelines|docs?|documentation|file|policy|page|section)`,
  String.raw`(?:see|read|check|consult|refer\s+to)\s+(?:the|our)\s+(?:docs|documentation|readme)`,
  String.raw`(?:open|file|raise|submit|create)\s+an?\s+issue`,
  String.raw`report\s+(?:a\s+|any\s+)?(?:security\s+)?(?:vulnerabilit(?:y|ies)|bugs?)`,
];
const POINTER_RE = new RegExp(`(?<![\\p{L}\\p{N}])(?:${POINTER_PHRASES.join('|')})(?![\\p{L}\\p{N}])`, 'giu');

function extract(model) {
  const links = model.links.filter((l) => !l.bare);
  const linked = new Set(links.filter((l) => l.kind !== 'image').map((l) => l.block));
  const sections = [];
  for (const t of model.texts) {
    if (linked.has(t.block) || !t.text.includes('§')) continue;
    const m = t.text.match(/§\s*[\w.\-]*/);
    sections.push({ line: t.line, snippet: (m ? m[0] : '§').slice(0, 24) });
  }
  const pointers = [];
  for (const block of proseBlocks(model)) {
    if (linked.has(block.id)) continue;
    for (const m of block.text.matchAll(POINTER_RE)) {
      pointers.push({ line: lineAt(block, m.index), phrase: m[0].replace(/\s+/g, ' ') });
    }
  }
  return { links, sections, pointers };
}

// A target worth resolving: not empty, external, or an anchor in the same document.
const checkable = (target) => Boolean(target) && !isExternal(target) && target.replace(/#.*$/, '') !== '';
const DESCRIBE = { image: 'image', include: 'include of', link: 'link to', xref: 'link to' };

// `tracked` is the repo's tracked-path set (git mode), or null (on-disk mode,
// where `root` is unused). `antora` is the repo's Antora component
// (antora.mjs) in a site:antora repo, else null; xrefs, images, and
// resource-ID includes in AsciiDoc files under its `modules/` then resolve by
// Antora rules (Antora never processes Markdown, so other formats keep path
// resolution; a `link:` macro maps through resolveLink), and a reference to what this repo does
// not hold is skipped, never broken. `unchecked` is an array when the file's
// component failed to load: AsciiDoc refs that need it are skipped and pushed
// to `unchecked`, and every other check still runs.
export async function analyzeFile(file, root, tracked, antora = null, unchecked = null) {
  const content = readFileSync(file, 'utf8');
  const model = await parseDoc(file, content);
  const findings = [];
  const seen = new Set();
  const trackedDirs = tracked ? trackedDirsOf(tracked) : null;
  const { links, sections, pointers } = extract(model);
  for (const ref of links) {
    let where; // repo-relative path when `tracked`, else absolute
    let abs;
    let what;
    let missing; // why the target is reported
    let unpublished = false; // the file may exist, but Antora never publishes it
    const rel = tracked ? relative(root, file) : '';
    // `unchecked` is only set for files already known to sit under modules/, hence the empty prefix.
    const policy = unchecked ? antoraRefPolicy(file, ref, '') : antora && tracked ? antoraRefPolicy(rel, ref, `${antora.prefix}modules/`) : 'path';
    if (unchecked && policy !== 'path') {
      if (checkable(ref.target)) unchecked.push(ref);
      continue;
    }
    if (policy !== 'path') {
      const r = policy === 'link' ? resolveLink(ref.target, rel, antora) : resolveXref(ref.target, rel, antora, ref.kind === 'image' ? 'image' : 'page');
      if (r === null || (r.unresolvable && !r.invalid)) continue; // external, an anchor, or outside this repo: never broken
      if (r.invalid) {
        findings.push({ code: 'REF_BROKEN', severity: 'warning', line: ref.line, message: `${DESCRIBE[ref.kind]} \`${ref.target}\` — ${r.unresolvable}; fix the reference` });
        continue;
      }
      where = r.path;
      abs = join(root, where);
      unpublished = Boolean(r.unpublished);
      what = ref.kind === 'xref' || unpublished
        ? `link to Antora xref \`${ref.target}\` (\`${where}\`)`
        : `${DESCRIBE[ref.kind]} \`${ref.target}\` (Antora resource \`${where}\`)`;
      if (unpublished) missing = `not published: ${r.unpublished}; link a published page or rename the target`;
      else if (tracked.has(where)) continue;
      else if (ref.kind === 'xref') missing = 'no such page in the repo; fix the page ID or create the page';
      else if (ref.kind === 'link') missing = 'no such source file in the repo; fix the link or add the file';
      else missing = 'no such file in the repo; fix the resource ID or add the file';
    } else {
      const target = ref.target;
      if (!checkable(target)) continue;
      const stripped = target.replace(/#.*$/, '');
      const cleaned = decodeTarget(stripped);
      abs = resolve(dirname(file), cleaned);
      where = abs;
      if (tracked) {
        where = relative(root, abs);
        if (where.startsWith('..')) continue;
        // A tracked file, or a directory that contains tracked files, is followable.
        if (tracked.has(where) || trackedDirs.has(where)) continue;
      } else if (existsSync(abs)) continue;
      what = `${DESCRIBE[ref.kind]} \`${cleaned}\``;
      missing = `no such file ${tracked ? 'in the repo' : 'on disk'}; fix the path or link the real target`;
    }
    const key = 'L' + where + '@' + ref.line;
    if (seen.has(key)) continue;
    seen.add(key);
    if (tracked && !unpublished && existsSync(abs)) {
      findings.push({
        code: 'REF_NOT_IN_GIT', severity: 'warning', line: ref.line,
        message: `${what} — exists but is NOT git-tracked (gitignored/unstaged); commit it, or make it an explicit external link if intentionally private`,
      });
    } else {
      findings.push({ code: 'REF_BROKEN', severity: 'warning', line: ref.line, message: `${what} — ${missing}` });
    }
  }
  for (const s of sections) {
    findings.push({
      code: 'UNLINKED_REF', severity: 'info', line: s.line,
      message: `section citation "${s.snippet}" has no link — verify the referenced section is followable and add a link (keep the citation)`,
    });
  }
  for (const p of pointers) {
    findings.push({
      code: 'UNLINKED_POINTER', severity: 'info', line: p.line,
      message: `"${p.phrase}" names a destination without a link — link it, or include the content here; a reader must never have to search for it (if the repo has no such page, create it)`,
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

async function main(argv) {
  const targets = argv.slice(2);
  if (targets.length === 0) {
    process.stderr.write('usage: check-refs.mjs <file-or-dir>...\n');
    process.exitCode = 2;
    return;
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
      trackedOf.set(root, gitTracked(root));
    }
    return root;
  };

  // The Antora component per repo root, read once; null outside site:antora.
  // A malformed antora.yml must not stop the run: it is recorded in
  // `configErrors` (reported on stderr, exit 2) and `brokenModules` holds the
  // `modules/` prefix whose AsciiDoc pages are checked without the component.
  const componentOf = new Map();
  const configErrors = [];
  const brokenModules = new Map();
  const unsupportedModules = new Map(); // root -> `modules/` prefixes of components Antora resolution does not cover
  const antoraOf = (root, tracked) => {
    if (!componentOf.has(root)) {
      const { mode, configs } = detectMode(tracked, root);
      let component = null;
      if (mode === 'site:antora') {
        const loaded = loadComponent(root, tracked, configs[0].path, true);
        component = loaded.component ?? null;
        if (loaded.configError !== undefined) {
          configErrors.push(loaded.configError);
          const dir = dirname(configs[0].path);
          brokenModules.set(root, `${dir === '.' ? '' : `${dir}/`}modules/`);
        }
      }
      componentOf.set(root, component);
      // Real components (antora.yml beside modules/*/pages/) that the site
      // layer above did not pick up: their refs cannot be resolved, so they
      // are listed rather than reported broken.
      const active = mode === 'site:antora' ? configs[0].path : null;
      unsupportedModules.set(root, [...tracked]
        .filter((p) => posix.basename(p) === 'antora.yml' && p !== active && !inDotDir(p) && existsSync(join(root, p)) && hasPages(posix.dirname(p), tracked))
        .map((p) => `${posix.dirname(p) === '.' ? '' : `${posix.dirname(p)}/`}modules/`));
    }
    return componentOf.get(root);
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
  const ordered = [
    ...docs.filter((d) => !lstatSync(d.f).isSymbolicLink()),
    ...docs.filter((d) => lstatSync(d.f).isSymbolicLink()),
  ];
  const shown = (root, p) => (root ? relative(root, p) : resolve(p));

  const findings = [];
  const seenReal = new Set();
  const uncheckedFiles = []; // [file, count of refs that needed the failed component]
  const unsupportedFiles = []; // same, for pages of a component in an unsupported layout
  for (const { f, phys, root, tracked } of ordered) {
    const real = realpathSync(f);
    const firstVisit = !seenReal.has(real);
    seenReal.add(real);
    const canonical = lstatSync(f).isSymbolicLink() ? shown(root, real) : null;
    const component = tracked ? antoraOf(root, tracked) : null;
    const rel = tracked ? relative(root, phys) : null;
    const isBroken = tracked && rel.startsWith(brokenModules.get(root) ?? '\0');
    const isUnsupported = tracked && unsupportedModules.get(root).some((prefix) => rel.startsWith(prefix));
    const unchecked = isBroken || isUnsupported ? [] : null;
    const found = await analyzeFile(tracked ? phys : f, root, tracked, component, unchecked);
    if (unchecked?.length) (isBroken ? uncheckedFiles : unsupportedFiles).push([rel, unchecked.length]);
    for (const x of found) {
      if (CONTENT_ONLY.has(x.code) && !firstVisit) continue; // same text, already reported
      if (canonical && !CONTENT_ONLY.has(x.code)) {
        x.message += ` (this path is a symlink to \`${canonical}\`; the link must work from both locations)`;
      }
      findings.push({ ...x, file: shown(root, root ? phys : f) });
    }
  }
  process.stdout.write(JSON.stringify({ status: findings.length ? 'findings' : 'ok', scanned: docs.length, findings }, null, 2) + '\n');
  const listOf = (files) => files.map(([file, n]) => `${file} (${n} ref${n === 1 ? '' : 's'})`).join(', ');
  if (unsupportedFiles.length) {
    process.stderr.write(`check-refs: Antora refs not checked (unsupported Antora layout): ${listOf(unsupportedFiles)}\n`);
  }
  if (configErrors.length) {
    for (const m of configErrors) process.stderr.write(`check-refs: ${m}\n`);
    process.stderr.write(`check-refs: Antora refs not checked (component unavailable): ${listOf(uncheckedFiles) || 'none'}\n`);
    process.exitCode = 2;
    return;
  }
  process.exitCode = findings.length ? 1 : 0;
}

if (isMain(import.meta.url)) {
  main(process.argv).catch((e) => {
    process.stderr.write(e instanceof ConfigError ? `check-refs: ${e.message}\n` : 'check-refs: internal error: ' + (e && e.stack ? e.stack : e) + '\n');
    process.exitCode = 2;
  });
}
