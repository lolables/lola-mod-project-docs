#!/usr/bin/env node
// Routing checks: can each reader find the door built for them? Reads the
// readers from personas.mjs and, for repo-wide checks, the graph from
// nav-graph.mjs; never parses links or navigation itself.
//
//   FRONT_DOOR_BLOCKED  more than THRESHOLDS.frontDoorLead lines between a
//                       front door's title and its first getting-started
//                       heading, or no such heading
//   LONG_QUICKSTART     a getting-started section over THRESHOLDS.quickstartLines
//   MISPLACED_SECTION   a front-door H2 section, other than a getting-started
//                       one, over THRESHOLDS.sectionLines. A candidate:
//                       /docs-audit's LLM step assigns its reader from the
//                       registry and keeps it only when that reader is not
//                       the new user
//   MISSING_DOOR        a persona's entry point exists, but no front door
//                       links to any of that persona's entry points
//   MISSING_GATE_FILE   no LICENSE (warning), SECURITY or SUPPORT file (info);
//                       issue templates satisfy support
//   ORPHAN_PAGE         a page under docs/ that no link path from the README
//                       reaches; an ADR counts as reached when its
//                       directory's index is
//   NO_WAY_BACK         a page under docs/ (ADRs exempt: their index is
//                       generated) that links to neither the README nor its
//                       directory's index page (an index page: its parent's)
//   SITE_CANDIDATE      docs/ has outgrown links between files: more than
//                       THRESHOLDS.sitePages pages besides ADRs, a persona
//                       index linking more than THRESHOLDS.indexLinks pages,
//                       or navigation strain. A suggestion; /docs-audit's LLM
//                       step adds judgment signals and costs
//   MISSING_STATUS      the README has no Status heading and no line starting
//                       `Status:`, `**Status:**`, or `*Status:*` (AsciiDoc bold)
//
// Docs modes. In `repo` mode the checks above run as written. When the graph
// reads a site's navigation (site:mkdocs, site:antora):
//   ORPHAN_PAGE         a site page neither in the sidebar (globalNav) nor
//                       reachable by links from a page that is or from a
//                       front door; the fix is a navigation entry
//   MISSING_DOOR        also `Site:`: the README links neither the home page's
//                       source nor the site URL (skipped when neither is known)
//   FRONT_DOOR_BLOCKED  the README passes when it links the site; the home
//                       page is checked as a front door
//   NO_WAY_BACK         the sidebar is the way back for a site page; a docs
//                       page the site does not publish keeps the repo-mode
//                       ORPHAN_PAGE and NO_WAY_BACK checks over the link graph
//   SITE_CANDIDATE      does not apply: the docs are already a site
// A sidebar entry for a persona's entry point counts as its door. In any
// other docs mode, or when the sidebar cannot be read (mkdocs.yml INHERIT or
// exclude_docs), page-reachability codes are listed in `skipped` with the
// reason — never reported as a pass. README checks run in every mode.
//
// CLI: `node check-routing.mjs`, inside the repository (no arguments).
// Output: JSON {status, mode, configs, scanned, skipped:[{code, reason}],
// unresolved:[{from, line, target, reason}] (Antora xrefs to what this repo
// does not hold; passed through from the graph),
// findings:[{code, severity, file, line, message}]}. `file` is relative to
// the repo root, or null for a repo-wide finding; `line` is null when no line
// applies; `scanned` counts doc pages in the graph. Exit 0 = no findings,
// 1 = findings, 2 = internal error (including: not a git repository).
// A malformed mkdocs.yml or antora.yml also exits 2, but degrades: the JSON on
// stdout still carries the checks that need no site (README, doors to files,
// gates), the page-reachability codes are in `skipped` with the config error
// as the reason, and stderr names the file. A malformed antora-playbook.yml,
// which only supplies the site URL, keeps site mode with the URL unknown:
// the site door check is skipped and stderr names the playbook.

import { posix } from 'node:path';
import { PERSONAS, describeEntry } from './personas.mjs';
import { formatFor } from './formats/index.mjs';
import { sectionSpan } from './check-prose.mjs';
import { buildGraph, loadOutsideEdges, reachable, indexPage, pageTargets, present } from './nav-graph.mjs';
import { repoRootOf } from './docs-mode.mjs';
import { isMain } from './is-main.mjs';
import { ConfigError } from './site-yaml.mjs';

// House conventions set by the persona-routing design; not tuned against
// eval runs (reference/rule-sources.md).
export const THRESHOLDS = {
  frontDoorLead: 40,
  quickstartLines: 60,
  sectionLines: 30,
  sitePages: 30,
  indexLinks: 15,
  strainFloor: 10,
  strainShare: 0.25,
};

const GETTING_STARTED_RE = /^(?:install(?:ation|ing)?|quick\s*start|get(?:ting)?\s+started|set\s*up)(?![\p{L}\p{N}])/iu;
const isGettingStarted = (title) => GETTING_STARTED_RE.test(title.replace(/^[^\p{L}]+/u, ''));
const STATUS_HEADING_RE = /^(?:(?:project|development|maintenance)\s+)?status(?![\p{L}\p{N}])/iu;
const STATUS_LINE_RE = /^(?:\*\*Status(?::\*\*|\*\*:)|\*Status(?::\*|\*:)|Status:)/;

// A getting-started heading counts at level 2, or deeper when every heading
// between it and the H1 is itself getting-started (`## Install` > `### npm`).
function countsAsStart(headings, i) {
  if (headings[i].level < 2 || !isGettingStarted(headings[i].title)) return false;
  let level = headings[i].level;
  for (let j = i - 1; j >= 0 && level > 2; j--) {
    if (headings[j].level >= level) continue;
    if (headings[j].level >= 2 && !isGettingStarted(headings[j].title)) return false;
    level = headings[j].level;
  }
  return true;
}

export function frontDoorFindings(file, model) {
  const findings = [];
  const { headings, lines } = model;
  const title = headings.find((h) => h.level === 1);
  const titleLine = title ? title.line : 1;
  const leadStart = title ? title.line : 0; // no H1: every line before the heading is lead
  const starts = headings
    .map((h, i) => ({ h, i, span: sectionSpan(headings, i, lines) }))
    .filter(({ i }) => countsAsStart(headings, i));

  if (starts.length === 0) {
    findings.push({
      code: 'FRONT_DOOR_BLOCKED', severity: 'warning', file, line: titleLine,
      message: 'no getting-started heading (`Install`, `Quickstart`, `Quick start`, `Getting started`, `Get started`, `Setup`, `Set up`); a new user cannot find the first run',
    });
  } else {
    const first = starts[0].h;
    const lead = first.line - leadStart - 1;
    if (lead > THRESHOLDS.frontDoorLead) {
      findings.push({
        code: 'FRONT_DOOR_BLOCKED', severity: 'warning', file, line: first.line,
        message: `"${first.title}" starts ${lead} lines after the title (> ${THRESHOLDS.frontDoorLead}); move what stands before it to its reader's door`,
      });
    }
  }

  let coveredUntil = 0;
  for (const { h, span } of starts) {
    if (h.line < coveredUntil) continue; // nested in a getting-started section already measured
    coveredUntil = h.line + span;
    if (span > THRESHOLDS.quickstartLines) {
      findings.push({
        code: 'LONG_QUICKSTART', severity: 'warning', file, line: h.line,
        message: `"${h.title}" spans ${span} lines (> ${THRESHOLDS.quickstartLines}); keep the shortest path to a working result here and move the full setup to \`docs/usage/getting-started${formatFor(file).extensions[0]}\``,
      });
    }
  }

  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    if (h.level !== 2 || isGettingStarted(h.title)) continue;
    const span = sectionSpan(headings, i, lines);
    if (span <= THRESHOLDS.sectionLines) continue;
    findings.push({
      code: 'MISPLACED_SECTION', severity: 'warning', file, line: h.line,
      message: `section "${h.title}" spans ${span} lines (> ${THRESHOLDS.sectionLines}) in the front door; candidate: assign its reader from reference/personas.md, keep it only when that reader is not the new user, and name the destination`,
    });
  }
  return findings;
}

export function statusFindings(file, model) {
  const hasStatus = model.headings.some((h) => STATUS_HEADING_RE.test(h.title.replace(/^[^\p{L}]+/u, '')))
    || model.paragraphs.some((p) => p.text.split('\n').some((l) => STATUS_LINE_RE.test(l.trim())))
    || model.listItems.some((li) => STATUS_LINE_RE.test(li.text.trim()));
  if (hasStatus) return [];
  return [{
    code: 'MISSING_STATUS', severity: 'info', file, line: null,
    message: 'no `Status` heading or `Status:` line; say how mature the project is and whether it is maintained (for example `**Status:** beta, maintained`)',
  }];
}

// Tracked paths that satisfy one registry entry (see personas.mjs).
export function entryPaths(entry, tracked) {
  const out = [];
  for (const path of tracked) {
    if (entry.dir) {
      if (path.startsWith(`${entry.dir}/`)) out.push(path);
      continue;
    }
    if (!entry.in.includes(posix.dirname(path))) continue;
    const name = posix.basename(path).toLowerCase();
    const hit = entry.file.some((stem) => {
      const s = stem.toLowerCase();
      return name === s || (name.startsWith(s) && (entry.variants ? /^[.\-_]/ : /^\./).test(name.slice(s.length)));
    });
    if (hit) out.push(path);
  }
  return out;
}

// entryPaths over the files a reader of this checkout has: a tracked file
// deleted from the work tree, or a symlink resolving outside the repo, is
// absent, as in page discovery.
export const presentEntryPaths = (entry, graph) => entryPaths(entry, graph.tracked).filter((p) => present(graph, p));

// Does a link target land on this entry: the file itself, or the directory,
// its index page, or any page inside it?
const lands = (entry, to) => (entry.dir
  ? to === entry.dir || to.startsWith(`${entry.dir}/`)
  : entryPaths(entry, [to]).length > 0);

export function doorFindings(graph) {
  const file = graph.readme ?? graph.home;
  const targets = [...graph.edges.filter((e) => graph.frontDoors.includes(e.from)).map((e) => e.to), ...graph.globalNav];
  const findings = [];
  for (const persona of PERSONAS.filter((p) => p.door)) {
    const entries = persona.entries.filter((e) => e.door !== false);
    const found = entries.map((e) => ({ e, paths: presentEntryPaths(e, graph) })).filter((f) => f.paths.length > 0);
    if (found.length === 0) continue;
    if (targets.some((to) => entries.some((e) => lands(e, to)))) continue;
    const existing = found.flatMap(({ e, paths }) => (e.dir ? [`${e.dir}/`] : paths));
    findings.push({
      code: 'MISSING_DOOR', severity: 'warning', file, line: null,
      message: `${persona.label}: ${existing.map((p) => `\`${p}\``).join(', ')} exists, but no front door links to it; add a door line for this reader`,
    });
  }
  return findings;
}

export function gateFindings(graph) {
  const findings = [];
  for (const persona of PERSONAS.filter((p) => p.gate)) {
    const gates = persona.entries.filter((e) => e.gate);
    if (gates.some((e) => presentEntryPaths(e, graph).length > 0)) continue;
    findings.push({
      code: 'MISSING_GATE_FILE', severity: persona.gate, file: null, line: null,
      message: `${persona.label}: no ${gates.map(describeEntry).join(' or ')}; ${persona.gateHint}`,
    });
  }
  return findings;
}

const ADR_DIRS = new Set(['docs/dev/adr', 'docs/adr']);
const isAdr = (p) => ADR_DIRS.has(posix.dirname(p));
// The docs mode each graph adapter reads.
const ADAPTER_MODE = { links: 'repo', mkdocs: 'site:mkdocs', antora: 'site:antora' };

// Link-graph checks over the docs pages the repo itself must route readers to.
// In a read site (`site`), the published pages are siteFindings' job; this
// covers the rest, and skips SITE_CANDIDATE since the docs are already a site.
function navFindings(graph, skipped, site, reached) {
  const findings = [];
  const pageSet = graph.pageSet;
  const published = new Set(graph.sitePages);
  // Antora files under the component's modules/ are pages, partials, or attachments: the site's call.
  const inSite = (p) => published.has(p) || (graph.componentModules !== null && p.startsWith(graph.componentModules));
  const docsPages = graph.pages.filter((p) => p.startsWith('docs/') && !(site && inSite(p)));
  const readme = graph.readme;
  const out = pageTargets(graph);
  const strained = new Set();

  if (readme) {
    for (const page of docsPages) {
      if (reached.has(page)) continue;
      if (isAdr(page)) {
        const index = indexPage(posix.dirname(page), pageSet, graph.mkdocsPages);
        if (index && index !== page && reached.has(index)) continue;
      }
      strained.add(page);
      const own = indexPage(posix.dirname(page), pageSet, graph.mkdocsPages);
      const target = (own !== page ? own : indexPage(posix.dirname(posix.dirname(page)), pageSet, graph.mkdocsPages)) ?? readme;
      findings.push({
        code: 'ORPHAN_PAGE', severity: 'warning', file: page, line: null,
        message: `no link path from \`${readme}\` reaches this page; link it from \`${target}\``,
      });
    }
  } else {
    skipped.push({ code: 'ORPHAN_PAGE', reason: 'the repo has no README to start from (see MISSING_README)' });
  }

  for (const page of docsPages) {
    if (isAdr(page)) continue;
    const dir = posix.dirname(page);
    const index = indexPage(dir, pageSet, graph.mkdocsPages);
    const back = new Set(readme ? [readme] : []);
    if (index && index !== page) back.add(index);
    if (index === page) {
      const parent = indexPage(posix.dirname(dir), pageSet, graph.mkdocsPages);
      if (parent) back.add(parent);
    }
    if (back.size === 0) continue;
    const targets = out.get(page) ?? new Set();
    if ([...back].some((b) => targets.has(b))) continue;
    strained.add(page);
    findings.push({
      code: 'NO_WAY_BACK', severity: 'info', file: page, line: null,
      message: `links to none of ${[...back].map((b) => `\`${b}\``).join(', ')}; a reader who lands here from search has no way back, so open the page with who it is for and a back link`,
    });
  }

  const content = docsPages.filter((p) => !isAdr(p));
  const signals = [];
  if (content.length > THRESHOLDS.sitePages) {
    signals.push(`${content.length} pages under docs/ besides ADRs (> ${THRESHOLDS.sitePages})`);
  }
  for (const entry of PERSONAS.flatMap((p) => p.entries)) {
    if (!entry.dir || !entry.dir.startsWith('docs/')) continue;
    const index = indexPage(entry.dir, pageSet, graph.mkdocsPages);
    if (!index) continue;
    const linked = [...(out.get(index) ?? [])].filter((t) => pageSet.has(t) && t !== index && t.startsWith(`${entry.dir}/`));
    if (linked.length > THRESHOLDS.indexLinks) {
      signals.push(`\`${index}\` links ${linked.length} pages (> ${THRESHOLDS.indexLinks})`);
    }
  }
  const strainedContent = content.filter((p) => strained.has(p)).length;
  if (content.length >= THRESHOLDS.strainFloor && strainedContent / content.length >= THRESHOLDS.strainShare) {
    signals.push(`navigation strain: ${strainedContent} of ${content.length} pages are orphaned or have no way back`);
  }
  if (signals.length > 0 && !site) {
    findings.push({
      code: 'SITE_CANDIDATE', severity: 'info', file: null, line: null,
      message: `${signals.join('; ')}; a documentation site may serve these readers better (suggestion only)`,
    });
  }
  return findings;
}

const NAV_ENTRY = { mkdocs: 'a `nav:` line in `mkdocs.yml`', antora: 'an `* xref:…[]` line in a `nav.adoc` that `antora.yml` lists' };

// URL.parse needs Node 20.18; the supported floor is older. null when invalid.
function parseUrl(text) {
  try {
    return new URL(text);
  } catch {
    return null;
  }
}

// Does the README link the published site: its home page's source file, or
// a URL under site_url? A bare URL counts; a forge renders it as a link.
function linksSite(graph) {
  const model = graph.models.get(graph.readme);
  const site = graph.siteUrl ? parseUrl(graph.siteUrl) : null;
  return model.links.filter((l) => l.kind !== 'image' && l.kind !== 'include').some((l) => (site && underSite(site, l.target))
    || (graph.home && graph.resolve(l.target, graph.readme) === graph.home));
}

// Is `target` the site URL or a page under it? http and https are the same
// site, the host is case-insensitive (URL lowercases it), and the path
// matches whole segments, so /project2 is not under /proj.
function underSite(site, target) {
  const url = parseUrl(target);
  if (!url || !/^https?:$/.test(url.protocol) || url.host !== site.host) return false;
  const base = site.pathname.replace(/\/+$/, '');
  const path = url.pathname.replace(/\/+$/, '');
  return path === base || path.startsWith(`${base}/`);
}

function siteFindings(graph, skipped, reached, siteLinked) {
  const findings = [];
  for (const page of graph.sitePages) {
    if (reached.has(page)) continue;
    findings.push({
      code: 'ORPHAN_PAGE', severity: 'warning', file: page, line: null,
      message: `not in the site navigation, and no link path from a page that is reaches it; add ${NAV_ENTRY[graph.adapter]}`,
    });
  }
  if (graph.readme) {
    // A bad mkdocs.yml leaves no home page; a bad playbook leaves the home page
    // and loses only the URL, so a README link to any URL might be the site's.
    const readmeUrl = () => graph.models.get(graph.readme).links.some((l) => l.kind !== 'image' && l.kind !== 'include' && /^https?:$/.test(parseUrl(l.target)?.protocol));
    if (graph.configError && (!graph.home || (!siteLinked && readmeUrl()))) {
      skipped.push({ code: 'MISSING_DOOR', reason: `the README's link to the published site: the site URL is unknown, ${graph.configError}` });
    } else if (!graph.home && !graph.siteUrl) {
      skipped.push({ code: 'MISSING_DOOR', reason: "the README's link to the published site: the site has no home page and no known URL" });
    } else if (!siteLinked) {
      const home = graph.home && `its home page \`${graph.home}\``;
      const url = graph.siteUrl && `its URL ${graph.siteUrl}`;
      const missing = home && url ? `links neither ${home} nor ${url}` : `does not link ${home ?? url}`;
      const unknown = graph.configError ? ' (the site URL is unknown, and the README links no URL)' : '';
      findings.push({
        code: 'MISSING_DOOR', severity: 'warning', file: graph.readme, line: null,
        message: `Site: the README ${missing}${unknown}; add a door to the published site`,
      });
    }
  }
  return findings;
}

function siteSkips(graph) {
  const list = graph.configs.map((c) => `\`${c.path}\``).join(', ');
  const why = graph.unreadable
    ?? (graph.mode === 'site-unsupported:multiple'
      ? `several site configs (${list}); routing cannot tell which one publishes the docs`
      : `the docs are published by ${graph.configs[0].generator} (${list}), whose navigation routing does not read`);
  return [
    { code: 'ORPHAN_PAGE', reason: why },
    { code: 'NO_WAY_BACK', reason: why },
    { code: 'SITE_CANDIDATE', reason: 'the docs are already published as a site' },
    { code: 'MISSING_DOOR', reason: `the README's link to the published site: ${why}; doors to files are still checked` },
    { code: 'FRONT_DOOR_BLOCKED', reason: `the README's pass for linking the published site: ${why}; the README is checked as in a repo` },
  ];
}

export async function analyzeRouting(root) {
  const graph = await buildGraph(root, { tolerateConfigErrors: true });
  const findings = [];
  const skipped = [];
  const readme = graph.readme;
  const routed = ADAPTER_MODE[graph.adapter] === graph.mode;
  const site = routed && graph.mode !== 'repo';
  const siteLinked = site && readme ? linksSite(graph) : false;
  for (const door of graph.frontDoors) {
    const found = frontDoorFindings(door, graph.models.get(door));
    findings.push(...(door === readme && siteLinked ? found.filter((f) => f.code !== 'FRONT_DOOR_BLOCKED') : found));
  }
  if (readme) findings.push(...statusFindings(readme, graph.models.get(readme)));
  if (graph.frontDoors.length > 0) findings.push(...doorFindings(graph));
  else skipped.push({ code: 'MISSING_DOOR', reason: 'the persona door checks: the repo has no README or site home page to link from (see MISSING_README)' });
  findings.push(...gateFindings(graph));
  const seeds = [...graph.frontDoors, ...graph.globalNav];
  if (routed) await loadOutsideEdges(graph, seeds);
  const reached = routed ? reachable(graph, seeds, { outsidePages: true }) : null;
  if (site) findings.push(...siteFindings(graph, skipped, reached, siteLinked), ...navFindings(graph, skipped, true, reached));
  else if (routed) findings.push(...navFindings(graph, skipped, false, reached));
  else skipped.push(...siteSkips(graph));
  return { mode: graph.mode, configs: graph.configs, scanned: graph.pages.length, skipped, unresolved: graph.unresolved, findings, configError: graph.configError };
}

async function main(argv) {
  if (argv.length > 2) {
    process.stderr.write('usage: check-routing.mjs (no arguments; run it inside the repository)\n');
    process.exit(2);
  }
  const root = repoRootOf(process.cwd());
  if (!root) {
    process.stderr.write('check-routing: not a git repository; routing reads the tracked file list\n');
    process.exit(2);
  }
  const { configError, ...result } = await analyzeRouting(root);
  const status = result.findings.length ? 'findings' : 'ok';
  process.stdout.write(JSON.stringify({ status, ...result }, null, 2) + '\n');
  if (configError) {
    process.stderr.write(`check-routing: ${configError}\n`);
    process.exit(2);
  }
  process.exit(result.findings.length ? 1 : 0);
}

if (isMain(import.meta.url)) {
  main(process.argv).catch((e) => {
    process.stderr.write(e instanceof ConfigError ? `check-routing: ${e.message}\n` : 'check-routing: internal error: ' + (e && e.stack ? e.stack : e) + '\n');
    process.exit(2);
  });
}
