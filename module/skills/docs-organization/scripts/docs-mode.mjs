// Docs mode: how a repository's docs are published, named from the file
// names of site-generator configs git tracks. Nothing in a config is read or
// run here; site-yaml.mjs and the adapters read the supported ones.
//
// detectMode(tracked) names the mode, from the file names of the configs.
//   repo                          no site config
//   site:mkdocs, site:antora      MkDocs and Antora keep navigation in data
//                                 files a reader can parse without running
//                                 anything
//   site-unsupported:<generator>  docusaurus, sphinx, hugo
//   site-unsupported:multiple     more than one config
// A Jekyll _config.yml is no site config: GitHub Pages publishes the repo's
// Markdown with its relative links intact, so the repo is checked as a repo.
// An antora.yml counts only beside tracked modules/*/pages/ files; the other
// generators have no equally clear layout evidence here (Sphinx needs an index
// beside conf.py). Configs inside dot-directories are ignored. With `root`, so is a config git
// tracks but the work tree lacks (deleted, uncommitted), as page discovery
// ignores deleted pages.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, posix } from 'node:path';

const depth = (p) => p.split('/').length - 1;
export const inDotDir = (p) => p.split('/').slice(0, -1).some((s) => s.startsWith('.'));

// An Antora component keeps pages at <dir>/modules/<module>/pages/; an
// antora.yml with none beside it is a fixture or example, not the publisher.
export const hasPages = (dir, tracked) => {
  const prefix = dir === '.' ? 'modules/' : `${dir}/modules/`;
  for (const p of tracked) {
    const parts = p.startsWith(prefix) ? p.slice(prefix.length).split('/') : [];
    if (parts.length >= 3 && parts[1] === 'pages') return true;
  }
  return false;
};

const SITE_CONFIGS = [
  { generator: 'mkdocs', site: true, match: (p) => p === 'mkdocs.yml' || p === 'mkdocs.yaml' },
  {
    generator: 'antora',
    site: true,
    match: (p, tracked) => depth(p) <= 1 && posix.basename(p) === 'antora.yml' && hasPages(posix.dirname(p), tracked),
  },
  {
    generator: 'docusaurus',
    match: (p) => depth(p) <= 1 && /^docusaurus\.config\.(?:js|mjs|cjs|ts|mts)$/.test(posix.basename(p)),
  },
  {
    generator: 'sphinx',
    match: (p, tracked) => depth(p) <= 2 && posix.basename(p) === 'conf.py'
      && ['index.rst', 'index.md'].some((n) => tracked.has(posix.join(posix.dirname(p), n))),
  },
  { generator: 'hugo', match: (p) => depth(p) <= 1 && /^hugo\.(?:toml|yaml|json)$/.test(posix.basename(p)) },
];

export function detectMode(tracked, root = null) {
  const found = [];
  for (const path of [...tracked].sort()) {
    if (inDotDir(path)) continue;
    for (const c of SITE_CONFIGS) {
      if (c.match(path, tracked) && (root === null || existsSync(join(root, path)))) found.push({ c, path });
    }
  }
  const configs = found.map(({ c, path }) => ({ generator: c.generator, path }));
  if (found.length === 0) return { mode: 'repo', configs };
  if (found.length > 1) return { mode: 'site-unsupported:multiple', configs };
  const { c } = found[0];
  return { mode: `${c.site ? 'site' : 'site-unsupported'}:${c.generator}`, configs };
}

export function gitTracked(root) {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return new Set(out.split('\0').filter(Boolean));
}

// The git work tree containing `dir`, or null when git itself says `dir` is
// not inside a repository — docs there are checked on disk. Any other git
// failure (corrupt config, a safe.directory refusal, git not installed) is
// not "outside git" and propagates so the caller exits 2 with git's message.
export function repoRootOf(dir) {
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
