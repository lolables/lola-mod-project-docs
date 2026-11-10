// MkDocs site layout from mkdocs.yml, read as data (site-yaml.mjs): which
// Markdown pages it publishes, which of them the sidebar lists, its home
// page, and its URL. Per the MkDocs configuration reference: docs_dir
// defaults to `docs`, relative to the config file; nav paths are relative to
// docs_dir; without `nav` every page is in the sidebar; dot-paths and the
// top-level `templates/` directory are excluded; a directory's index is
// index.md, else README.md.
//
// A docs_dir of `!ENV [VAR, default]` resolves to its last element, never to
// the process environment, so an audit gives the same answer on every
// machine. An `!ENV` with no string default is a ConfigError.
//
// readMkdocs(configPath, text, tracked) returns
//   {docsDir, pages, nav, home, siteUrl, unreadable}
//   pages       tracked Markdown files MkDocs publishes, sorted
//   nav         repo paths the `nav` key lists (external entries skipped),
//               or null when there is no nav key
//   home        docs_dir's index.md, else README.md, or null
//   siteUrl     site_url when it is a plain string, else null
//   unreadable  why the sidebar cannot be known from this file alone
//               (INHERIT, exclude_docs), or null
// Throws an Error naming configPath for malformed YAML, a docs_dir that is
// not a string or leaves the repository, or a nav that is not a list.

import { posix } from 'node:path';
import { loadSiteYaml, Inert, ConfigError } from './site-yaml.mjs';
import { formatFor } from './formats/index.mjs';

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

export function readMkdocs(configPath, text, tracked) {
  const config = loadSiteYaml(configPath, text);
  let raw = config.docs_dir ?? 'docs';
  if (raw instanceof Inert && /ENV$/.test(raw.tag)) {
    const fallback = Array.isArray(raw.value) && raw.value.length > 1 ? raw.value.at(-1) : undefined;
    if (typeof fallback !== 'string') throw new ConfigError(`${configPath}: docs_dir uses !ENV without a string default, so the audit cannot know the docs directory`);
    raw = fallback;
  }
  if (typeof raw !== 'string') throw new ConfigError(`${configPath}: docs_dir must be a string`);
  const docsDir = posix.normalize(posix.join(posix.dirname(configPath), raw)).replace(/\/+$/, '') || '.';
  if (posix.isAbsolute(raw) || docsDir === '..' || docsDir.startsWith('../')) {
    throw new ConfigError(`${configPath}: docs_dir ${raw} is outside the repository`);
  }
  const prefix = docsDir === '.' ? '' : `${docsDir}/`;
  const pages = [...tracked].filter((p) => {
    if (!p.startsWith(prefix) || formatFor(p)?.name !== 'markdown') return false;
    const rel = p.slice(prefix.length);
    if (posix.basename(rel) === 'README.md' && tracked.has(`${posix.dirname(p)}/index.md`.replace(/^\.\//, ''))) return false; // MkDocs prefers index.md
    return !rel.split('/').some((s) => s.startsWith('.')) && !rel.startsWith('templates/');
  }).sort();
  const pageSet = new Set(pages);
  const home = [`${prefix}index.md`, `${prefix}README.md`].find((p) => pageSet.has(p)) ?? null;
  const siteUrl = typeof config.site_url === 'string' ? config.site_url : null;
  let unreadable = null;
  if ('INHERIT' in config) unreadable = `${configPath} inherits from ${typeof config.INHERIT === 'string' ? config.INHERIT : 'a non-string INHERIT value'}, which may hold the nav; routing reads one file`;
  else if ('exclude_docs' in config) unreadable = `${configPath} sets exclude_docs, whose gitignore-style patterns routing does not evaluate`;
  const nav = config.nav === null || config.nav === undefined ? null : navPaths(config.nav, prefix, configPath);
  return { docsDir, pages, nav, home, siteUrl, unreadable };
}

// Every internal page a nav value lists, as a repo path. Entries are a path
// string, {title: path}, or {title: [entries]}; a value with a URL scheme
// or a leading `/` is a link, not a page, and skipped.
function navPaths(nav, prefix, configPath) {
  if (!Array.isArray(nav)) throw new ConfigError(`${configPath}: nav must be a list`);
  const out = [];
  const seen = new Set([nav]); // aliases can make a nav cyclic
  const walk = (v) => {
    if (v !== null && typeof v === 'object') {
      if (seen.has(v)) return;
      seen.add(v);
    }
    if (typeof v === 'string') {
      if (!SCHEME_RE.test(v) && !v.startsWith('/')) out.push(posix.normalize(prefix + v));
    } else if (Array.isArray(v)) {
      v.forEach(walk);
    } else if (v !== null && typeof v === 'object' && !(v instanceof Inert)) {
      Object.values(v).forEach(walk);
    }
  };
  nav.forEach(walk);
  return out;
}
