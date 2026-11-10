#!/usr/bin/env node
// Navigation graph: which doc pages a reader can reach, and from where. The
// seam every routing check reads (check-routing.mjs); no check parses links
// or navigation itself. detectMode and gitTracked live in docs-mode.mjs and
// are re-exported here.
//
// buildGraph(root) returns:
//   mode, configs  from detectMode
//   adapter        what built the edges: 'links' (relative links between doc
//                  files), 'mkdocs', or 'antora' (xrefs inside the component's
//                  modules/ resolve by antora.mjs). Checks that need a site's
//                  navigation run only when the adapter reads the mode.
//   readme         the root README, or null
//   frontDoors     [home page, README] in site mode, else [README]; a missing
//                  one is left out
//   pages          every tracked doc file outside dot-directories, sorted
//   edges          [{from, line, to}], one per link, xref, or cross-reference
//                  that resolves to any tracked file (including non-doc files
//                  such as LICENSE) or directory (images, includes, bare URLs
//                  are not navigation)
//   globalNav      pages a site sidebar reaches from anywhere: MkDocs `nav`
//                  (every site page when absent) and Antora nav-file xrefs;
//                  [] for links
//   sitePages      pages the site publishes; [] outside a read site
//   home           the site's home page, or null
//   siteUrl        the published URL (site_url, playbook site.url), or null
//   unreadable     why the sidebar cannot be read (mkdocs.yml INHERIT or
//                  exclude_docs, or with { tolerateConfigErrors } a malformed
//                  site config), or null
//   configError    with { tolerateConfigErrors }: the ConfigError message of a
//                  malformed site config or playbook, or null
//   unresolved     [{from, line, target, reason}]: Antora xrefs to what this
//                  repo does not hold (other component or version, partials)
//                  and nav files antora.yml lists that git does not track or
//                  this checkout does not read (deleted, hidden, outside the repo)
//   tracked        the tracked path set (gate files live in dot-directories)
//   models         Map page -> DocModel
//   pagesByDir     Map directory -> its direct pages (what landOn reads)
//   resolve        (target, fromPage) -> a tracked file, a directory's index
//                  page, a tracked directory with no index page, or null
//                  (external, anchor-only, missing, or outside the repo).
//                  A leading `/` is repo-root-relative, as forges render it.
//                  In MkDocs site mode a directory's index.md beats its README.md.
//   mkdocsPages    the MkDocs published set indexPage reads for that rule; null
//                  outside MkDocs site mode (pass it as indexPage's third argument)
// present(graph, f)          f is tracked, in the work tree, and inside the repo
// reachable(graph, starts, opts)  the one walk: pages (and with `outsidePages`,
//                            docs outside the page set) a reader reaches
// landOn(graph, to)          the pages a reader lands on from an edge target
// edgesOutOf(graph, f) edges out of any tracked doc file, including
//                            one outside `pages` (a dot-directory)
// loadOutsideEdges(graph, starts)  reads the edges out of every doc outside
//                            `pages` that a walk from `starts` reaches into
//                            graph.outsideEdges (Map doc -> edges), which
//                            reachable follows with `outsidePages`
//
// CLI: `node nav-graph.mjs --mode` prints {mode, configs} as JSON for the
// repository containing the current directory. Exit 0, or 2 on a usage
// error, outside a git repository, or on a git failure.

import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { join, posix, sep } from 'node:path';
import { formatFor, parseDoc, readmeNames, extensions } from './formats/index.mjs';
import { isExternal, decodeTarget, trackedDirsOf } from './link-targets.mjs';
import { detectMode, gitTracked, inDotDir, repoRootOf } from './docs-mode.mjs';
import { readMkdocs } from './mkdocs.mjs';
import { loadComponent, resolveXref, resolveLink, antoraRefPolicy, readPlaybookUrl } from './antora.mjs';
import { ConfigError } from './site-yaml.mjs';
import { isMain } from './is-main.mjs';

export { detectMode, gitTracked } from './docs-mode.mjs';

// A directory's index page: README.<ext> first (what a forge renders under
// the listing), then index.<ext>; null when it has neither. `mkdocsPages`
// (MkDocs site mode only) are the published pages: MkDocs serves a directory's
// index.md and drops its README.md, so a published index.md comes first there.
export function indexPage(dir, pageSet, mkdocsPages = null) {
  const prefix = dir === '.' ? '' : `${dir}/`;
  if (mkdocsPages?.has(`${prefix}index.md`)) return `${prefix}index.md`;
  for (const name of [...readmeNames(), ...extensions().map((e) => `index${e}`)]) {
    if (pageSet.has(prefix + name)) return prefix + name;
  }
  return null;
}

// `mkdocsPages`: see indexPage; a directory link lands on its index page.
export function makeResolve(tracked, pageSet, mkdocsPages = null) {
  const dirs = trackedDirsOf(tracked);
  return function resolve(target, fromPage) {
    if (!target || isExternal(target)) return null;
    const bare = decodeTarget(target.replace(/[?#].*$/, ''));
    if (!bare) return null;
    const joined = bare.startsWith('/') ? bare.slice(1) : posix.join(posix.dirname(fromPage), bare);
    const path = posix.normalize(joined).replace(/\/+$/, '') || '.';
    if (path === '..' || path.startsWith('../')) return null;
    if (tracked.has(path)) return path;
    if (path === '.' || dirs.has(path)) return indexPage(path, pageSet, mkdocsPages) ?? path;
    return null;
  };
}

const PLAYBOOKS = ['antora-playbook.yml', 'antora-playbook.yaml'];

// The site a supported generator publishes, from its config: which adapter
// builds the graph, the published pages, the sidebar (MkDocs; Antora's comes
// from its nav files after parsing), the home page, the site URL, and, when
// the sidebar cannot be known, why. A malformed config throws ConfigError, or
// with `tolerate` degrades: a bad mkdocs.yml or antora.yml leaves the plain
// links graph (`unreadable` and `configError` carry the message), and a bad
// playbook, which only supplies the site URL, leaves the site with no URL.
function siteLayout(root, tracked, mode, configs, tolerate, isPresent) {
  const read = (p) => readFileSync(join(root, p), 'utf8');
  const tolerated = (e) => {
    if (!tolerate || !(e instanceof ConfigError)) throw e;
    return e.message;
  };
  if (mode === 'site:mkdocs') {
    let m;
    try {
      // MkDocs publishes what is in this checkout: a tracked index.md deleted
      // from the work tree does not hide README.md.
      const published = new Set([...tracked].filter((p) => formatFor(p)?.name !== 'markdown' || isPresent(p)));
      m = readMkdocs(configs[0].path, read(configs[0].path), published);
    } catch (e) {
      const configError = tolerated(e);
      return { adapter: 'links', unreadable: configError, configError };
    }
    if (m.unreadable) return { adapter: 'links', unreadable: m.unreadable };
    return { adapter: 'mkdocs', sitePages: m.pages, nav: m.nav ?? m.pages, home: m.home, siteUrl: m.siteUrl };
  }
  if (mode === 'site:antora') {
    const { component: a, configError: badConfig } = loadComponent(root, tracked, configs[0].path, tolerate);
    if (badConfig !== undefined) return { adapter: 'links', unreadable: badConfig, configError: badConfig };
    const playbook = PLAYBOOKS.find((p) => tracked.has(p) && existsSync(join(root, p)));
    let siteUrl = null;
    let configError = null;
    if (playbook) {
      try {
        siteUrl = readPlaybookUrl(playbook, read(playbook));
      } catch (e) {
        configError = tolerated(e);
      }
    }
    return { adapter: 'antora', sitePages: a.pages, antora: a, home: a.startPage, siteUrl, configError };
  }
  return { adapter: 'links' };
}

// A link a reader follows: not a bare URL, an image, or an include.
const followable = (link) => !link.bare && link.kind !== 'image' && link.kind !== 'include';
// Whether `abs` resolves, through symlinks, to a path inside the repository.
export const insideRepo = (realRoot, abs) => {
  const real = realpathSync(abs);
  return real === realRoot || real.startsWith(realRoot + sep);
};

export async function buildGraph(root, { tolerateConfigErrors = false } = {}) {
  const tracked = gitTracked(root);
  const { mode, configs } = detectMode(tracked, root);
  // A tracked doc deleted from the work tree (or a dangling symlink) is absent
  // for a reader of this checkout, so it is not a page (check-refs reports
  // links to it). A symlink resolving outside the repo is not read either;
  // symlinks that stay inside it are a supported layout.
  const probe = { root, realRoot: realpathSync(root), tracked, presence: new Map() }; // present()'s view of the checkout
  const isPresent = (p) => present(probe, p);
  const pages = [...tracked].filter((p) => formatFor(p) && !inDotDir(p) && isPresent(p)).sort();
  const pageSet = new Set(pages);
  const site = siteLayout(root, tracked, mode, configs, tolerateConfigErrors, isPresent);
  const mkdocsPages = site.adapter === 'mkdocs' ? new Set(site.sitePages) : null;
  const resolve = makeResolve(tracked, pageSet, mkdocsPages);
  const antora = site.antora ?? null;
  const componentModules = antora && `${antora.prefix}modules/`;
  const models = new Map();
  const edges = [];
  const unresolved = [];
  for (const page of pages) {
    const model = await parseDoc(page, readFileSync(join(root, page), 'utf8'));
    models.set(page, model);
    for (const link of model.links) {
      if (!followable(link)) continue;
      const policy = antora ? antoraRefPolicy(page, link, componentModules) : 'path';
      if (policy === 'resource') {
        const r = resolveXref(link.target, page, antora);
        if (r === null) continue;
        if (r.unresolvable || r.unpublished) unresolved.push({ from: page, line: link.line, target: link.target, reason: r.unresolvable ?? r.unpublished });
        else if (tracked.has(r.path)) edges.push({ from: page, line: link.line, to: r.path });
        continue;
      }
      if (policy === 'link') {
        const r = resolveLink(link.target, page, antora);
        if (r?.path && tracked.has(r.path)) edges.push({ from: page, line: link.line, to: r.path });
        continue;
      }
      const to = resolve(link.target, page);
      if (to !== null) edges.push({ from: page, line: link.line, to });
    }
  }
  const sitePages = (site.sitePages ?? []).filter((p) => pageSet.has(p));
  const sitePageSet = new Set(sitePages);
  let globalNav = [];
  if (site.adapter === 'mkdocs') {
    // A nav entry ending in `/` names a directory; plain MkDocs links only its
    // index page. Plugins that expand a directory further (literate-nav,
    // awesome-pages) are out of scope: their extra pages stay unlisted.
    const entries = site.nav.map((p) => (p.endsWith('/') ? indexPage(p.replace(/\/+$/, '') || '.', sitePageSet, mkdocsPages) : p));
    globalNav = [...new Set(entries)].filter((p) => p !== null && sitePageSet.has(p)).sort();
  }
  if (site.adapter === 'antora') {
    const listed = new Set();
    for (const navFile of antora.navFiles) {
      if (!models.has(navFile)) {
        let why = 'is tracked but not read: under a hidden directory, outside the repo, or not a doc file';
        if (!tracked.has(navFile)) why = 'is not tracked';
        else if (!existsSync(join(root, navFile))) why = 'is tracked but missing from the work tree';
        unresolved.push({ from: configs[0].path, line: null, target: navFile, reason: `nav file listed in antora.yml ${why}` });
        continue;
      }
      for (const link of models.get(navFile).links) {
        if (link.kind !== 'xref') continue;
        const r = resolveXref(link.target, navFile, antora);
        if (r && r.path && sitePageSet.has(r.path)) listed.add(r.path);
      }
    }
    globalNav = [...listed].sort();
  }
  const readme = readmeNames().find((n) => pageSet.has(n)) ?? null;
  const pagesByDir = new Map();
  for (const p of pages) {
    const dir = posix.dirname(p);
    if (!pagesByDir.has(dir)) pagesByDir.set(dir, []);
    pagesByDir.get(dir).push(p);
  }
  const home = site.home && pageSet.has(site.home) ? site.home : null;
  const frontDoors = [...new Set([home, readme].filter(Boolean))];
  return {
    root, realRoot: probe.realRoot, mode, configs, adapter: site.adapter, frontDoors, readme, pages, pageSet, pagesByDir, edges, globalNav, tracked, models, resolve, mkdocsPages,
    sitePages, home, componentModules, siteUrl: site.siteUrl ?? null, unreadable: site.unreadable ?? null, configError: site.configError ?? null, unresolved,
    outsideEdges: new Map(),
    presence: probe.presence, // present() answers, per file
    edgesByFrom: null, // edgesOutOf()'s lookup of graph.edges by `from`, built on first use
    targetsCache: { base: null, withOutside: { count: -1, map: null } }, // reachable()'s adjacency; withOutside is rebuilt when outsideEdges grows
  };
}

// The adjacency of the graph's own edges, built once per graph.
export const pageTargets = (graph) => graph.targetsCache.base ??= targetsOf(graph);

// Map page -> Set of the targets its edges point at. `edges` defaults to the
// graph's own; pass a longer list to include edges out of non-page docs.
export function targetsOf(graph, edges = graph.edges) {
  const out = new Map();
  for (const e of edges) {
    if (!out.has(e.from)) out.set(e.from, new Set());
    out.get(e.from).add(e.to);
  }
  return out;
}

// The pages an edge target lands on: the page itself, every page directly
// inside a directory with no index page, or none (a non-doc file).
export function landOn(graph, to) {
  if (graph.models.has(to)) return [to];
  return graph.pagesByDir.get(to) ?? [];
}

// A tracked file still in the work tree and resolving inside the repo; one
// deleted there, or symlinked out of it, is absent. Every doc-existence check
// goes through this; the answer is remembered per graph, so a file changed
// after buildGraph is not re-read.
export function present(graph, file) {
  let ok = graph.presence.get(file);
  if (ok === undefined) {
    const abs = join(graph.root, file);
    ok = graph.tracked.has(file) && existsSync(abs) && insideRepo(graph.realRoot, abs);
    graph.presence.set(file, ok);
  }
  return ok;
}

// The one walk over the edges: what a reader reaches from `starts`. A link to
// a directory with no index page lands on every page directly inside it; a
// link to a non-doc file (LICENSE) lands nowhere. By default only pages are
// reached, over the graph's own edges. `edges` swaps in a longer list, and
// `outsidePages` also reaches a present doc outside the page set (a file in a
// dot-directory), as a start or as a link target, and follows the edges
// loadOutsideEdges read out of it.
export function reachable(graph, starts, { outsidePages = false } = {}) {
  const counts = (f) => graph.pageSet.has(f) || (outsidePages && formatFor(f) !== null && present(graph, f));
  const cache = graph.targetsCache;
  let out;
  if (!outsidePages) {
    out = pageTargets(graph);
  } else {
    // A doc's outside edges are set once, so the count says whether any are new.
    if (cache.withOutside.count !== graph.outsideEdges.size) {
      cache.withOutside = { count: graph.outsideEdges.size, map: targetsOf(graph, [...graph.edges, ...[...graph.outsideEdges.values()].flat()]) };
    }
    out = cache.withOutside.map;
  }
  const seen = new Set();
  const queue = starts.filter(counts);
  while (queue.length > 0) {
    const f = queue.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    for (const to of out.get(f) ?? []) {
      queue.push(...landOn(graph, to));
      if (outsidePages && counts(to)) queue.push(to);
    }
  }
  return seen;
}

// Edges out of a tracked doc file that need not be a page: a persona
// walkthrough can start in a dot-directory (`.github/SECURITY.md`). Same
// link rules as page edges; a file missing from the work tree or resolving
// outside the repo has none.
export async function edgesOutOf(graph, file) {
  if (graph.models.has(file)) {
    if (!graph.edgesByFrom) {
      graph.edgesByFrom = new Map();
      for (const e of graph.edges) {
        if (!graph.edgesByFrom.has(e.from)) graph.edgesByFrom.set(e.from, []);
        graph.edgesByFrom.get(e.from).push(e);
      }
    }
    return graph.edgesByFrom.get(file) ?? [];
  }
  if (!formatFor(file) || !present(graph, file)) return [];
  const model = await parseDoc(file, readFileSync(join(graph.root, file), 'utf8'));
  return model.links.filter(followable)
    .map((link) => ({ from: file, line: link.line, to: graph.resolve(link.target, file) }))
    .filter((e) => e.to !== null);
}

// Reads the edges out of each doc outside the page set that a walk from
// `starts` reaches, so reachable(..., { outsidePages: true }) can follow them.
// Walks again after each batch, since a loaded doc can link to another.
// Only reached docs are read, never every tracked file.
export async function loadOutsideEdges(graph, starts) {
  for (;;) {
    const fresh = [...reachable(graph, starts, { outsidePages: true })].filter((f) => !graph.models.has(f) && !graph.outsideEdges.has(f));
    if (fresh.length === 0) return;
    for (const f of fresh) graph.outsideEdges.set(f, await edgesOutOf(graph, f));
  }
}

if (isMain(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 1 || args[0] !== '--mode') {
      process.stderr.write('usage: nav-graph.mjs --mode\n');
      process.exitCode = 2;
    } else {
      const root = repoRootOf(process.cwd());
      if (!root) {
        process.stderr.write('nav-graph: not a git repository; the docs mode is read from tracked files\n');
        process.exitCode = 2;
      } else {
        process.stdout.write(JSON.stringify(detectMode(gitTracked(root), root), null, 2) + '\n');
      }
    }
  } catch (e) {
    process.stderr.write('nav-graph: internal error: ' + (e && e.stack ? e.stack : e) + '\n');
    process.exitCode = 2;
  }
}
