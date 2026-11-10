// Temp git repos for the routing tests. Synthetic text only: nothing here is
// copied from a real project. Also builds the crosscodex-shaped and
// template-shaped fixture repos, with a CLI to materialize them.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { THRESHOLDS } from '../../../module/skills/docs-organization/scripts/check-routing.mjs';

const MODULE = fileURLToPath(new URL('../../../module/', import.meta.url));

export const GENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'routing-test',
  GIT_AUTHOR_EMAIL: 'routing-test@invalid',
  GIT_COMMITTER_NAME: 'routing-test',
  GIT_COMMITTER_EMAIL: 'routing-test@invalid',
};
for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR']) delete GENV[k];

const made = [];

export function tempDir() {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'routing-')));
  made.push(d);
  return d;
}

export function removeTemp() {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
}

export function writeFiles(root, files) {
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), body);
  }
}

// git init, then commit everything .gitignore lets through.
export function commitAll(root) {
  for (const args of [['init', '-q'], ['add', '-A'], ['commit', '-q', '-m', 'fixture']]) {
    execFileSync('git', args, { cwd: root, env: GENV, stdio: ['ignore', 'pipe', 'pipe'] });
  }
}

export function tempRepo(files) {
  const root = tempDir();
  writeFiles(root, files);
  commitAll(root);
  return root;
}

// `n` distinct one-line paragraph lines, no trailing newline.
export const lines = (n, word = 'filler') => Array.from({ length: n }, (_, i) => `${word} line ${i + 1}`).join('\n');

// A README shaped like the motivating case: upgrade notes bury the quick
// start, which is itself too long; reference, security, and admin content
// live in the README. docs/dev has one orphaned page; SECURITY.md has no
// door; there is no Status line and no SUPPORT file. Section sizes derive
// from THRESHOLDS, so each one is just past its limit.
export function crosscodexFiles() {
  const list = (n, topic) => Array.from({ length: n }, (_, i) => `- ${topic} note ${i + 1}.`).join('\n');
  const section = (title, n, topic) => `## ${title}\n\n${list(n, topic)}\n`;
  const readme = [
    '# relaybox\n',
    '> Mirrors code review comments between two forges.\n',
    section('Upgrading from 1.x', THRESHOLDS.frontDoorLead, 'upgrade'),
    section('Quick Start', THRESHOLDS.quickstartLines, 'setup step'),
    section('Configuration reference', THRESHOLDS.sectionLines + 5, 'config key'),
    section('Security internals', THRESHOLDS.sectionLines + 5, 'token handling'),
    section('Administration', THRESHOLDS.sectionLines + 5, 'admin task'),
    '## More\n\n- [Developer docs](docs/dev/README.md)\n- [License](LICENSE)\n',
  ].join('\n');
  const devPage = (title) => `# ${title}\n\nFor maintainers. Back to the [developer docs](README.md).\n`;
  return {
    'README.md': readme,
    'LICENSE': 'MIT License\n',
    'SECURITY.md': '# Security\n\nReport a vulnerability through the private advisory form.\n',
    'docs/dev/README.md': '# Developer docs\n\nFor maintainers. Back to the [README](../../README.md).\n\n- [Architecture](architecture.md)\n- [Testing](testing.md)\n',
    'docs/dev/architecture.md': devPage('Architecture'),
    'docs/dev/testing.md': devPage('Testing'),
    'docs/dev/release.md': devPage('Releasing'),
  };
}

// The body of the ````markdown block under `### <heading>` in
// docs-tree-template.md.
function treeTemplate(heading) {
  const text = readFileSync(MODULE + 'skills/docs-organization/reference/docs-tree-template.md', 'utf8');
  const start = text.indexOf(`### ${heading}\n`);
  if (start < 0) throw new Error(`docs-tree-template.md has no "### ${heading}"`);
  const open = text.indexOf('````markdown\n', start) + '````markdown\n'.length;
  return text.slice(open, text.indexOf('\n````', open) + 1);
}

// The indented ```markdown block that starts with `# Diagrams` in docs-init.md.
function diagramsReadme() {
  const lines = readFileSync(MODULE + 'commands/docs-init.md', 'utf8').split('\n');
  const open = lines.findIndex((l, i) => l.trim() === '```markdown' && lines[i + 1]?.trim() === '# Diagrams');
  if (open < 0) throw new Error('docs-init.md has no diagrams README block');
  const indent = lines[open].length - lines[open].trimStart().length;
  const close = lines.findIndex((l, i) => i > open && l.trim() === '```');
  return lines.slice(open + 1, close).map((l) => l.slice(indent)).join('\n') + '\n';
}

// The repo /docs-init's greenfield path scaffolds, built from the shipped
// templates. It adds the LICENSE, SECURITY.md, and SUPPORT.md the template's
// doors point at, since a project that has them is the zero-findings case.
export function writeSmallProject(root) {
  writeFiles(root, {
    '.gitignore': 'docs/superpowers/\n',
    'README.md': readFileSync(MODULE + 'skills/docs-organization/reference/readme-template.md', 'utf8'),
    'LICENSE': 'MIT License\n',
    'SECURITY.md': '# Security\n\nReport a vulnerability through the private advisory form.\n',
    'SUPPORT.md': '# Support\n\nAsk in the discussion forum.\n',
    'docs/dev/README.md': treeTemplate('docs/dev/README.md'),
    'docs/dev/architecture.md': treeTemplate('docs/dev/architecture.md'),
    'docs/dev/contributing.md': treeTemplate('docs/dev/contributing.md'),
    'docs/dev/diagrams/README.md': diagramsReadme(),
  });
  mkdirSync(join(root, 'docs/dev/adr'), { recursive: true });
  execFileSync('bash', [join(MODULE, 'skills/adr/scripts/adr-index.sh'), join(root, 'docs/dev/adr')], { stdio: 'ignore' });
  commitAll(root);
}

// A MkDocs site: a nav with titled, nested, and external entries; Python
// tags a real mkdocs.yml carries; one page reached only by a link, one
// orphan. The README links the site URL.
export function mkdocsFiles() {
  return {
    'README.md': '# relaybox\n\n**Status:** beta\n\n## Install\n\nrun it\n\nRead the [documentation](https://example.org/relaybox/).\n',
    'mkdocs.yml': [
      'site_name: relaybox',
      'site_url: https://example.org/relaybox/',
      'nav:',
      '  - Home: index.md',
      '  - Guide:',
      '    - guide/a.md',
      '  - Source: https://example.com/src',
      'markdown_extensions:',
      '  - pymdownx.emoji:',
      '      emoji_index: !!python/name:material.extensions.emoji.twemoji',
      'extra:',
      '  key: !ENV [API_KEY, unset]',
      '',
    ].join('\n'),
    'docs/index.md': '# Home\n\n## Install\n\nrun it\n\n[More](guide/b.md)\n',
    'docs/guide/a.md': '# A\n',
    'docs/guide/b.md': '# B\n',
    'docs/guide/lost.md': '# Lost\n',
  };
}

// An Antora component under docs/: one nav file, a page reached only by an
// xref, one orphan, a hidden page, a partial, and an xref to another
// component.
export function antoraFiles() {
  return {
    'README.adoc': '= relaybox\n\n*Status:* beta\n\n== Install\n\nrun it\n\nlink:https://docs.example.org[Documentation]\n',
    'antora-playbook.yml': 'site:\n  url: https://docs.example.org\n',
    'docs/antora.yml': 'name: relaybox\nversion: ~\nnav:\n- modules/ROOT/nav.adoc\n',
    'docs/modules/ROOT/nav.adoc': '* xref:index.adoc[Home]\n* xref:usage:config.adoc[Configuration]\n',
    'docs/modules/ROOT/pages/index.adoc': '= Home\n\n== Install\n\nrun it\n\nxref:install.adoc[Install] and xref:other::intro.adoc[the other component]\n',
    'docs/modules/ROOT/pages/install.adoc': '= Install\n',
    'docs/modules/ROOT/pages/_draft.adoc': '= Draft\n',
    'docs/modules/ROOT/partials/note.adoc': 'xref:index.adoc[Home]\n',
    'docs/modules/usage/pages/config.adoc': '= Configuration\n',
    'docs/modules/usage/pages/lost.adoc': '= Lost\n',
  };
}

// A repo for walkthrough checks. Line numbers are load-bearing: README line
// 11 links docs/usage, 12 docs/dev/, 13 .github/SECURITY.md; docs/dev/README
// line 3 links architecture.md, line 4 the index-less guides/ directory;
// .github/SECURITY.md line 3 links docs/security/data.md. docs/dev/testing.md
// is linked from nowhere.
export function walkFiles() {
  return {
    'README.md': '# relaybox\n\nMirrors code review comments between two forges.\n\n## Install\n\nRun `relaybox sync --once`.\n\n## Where to go next\n\n- [Usage](docs/usage/README.md)\n- [Developer docs](docs/dev/)\n- [Security](.github/SECURITY.md)\n',
    '.github/SECURITY.md': '# Security\n\nReport privately. Data handling: [data](../docs/security/data.md).\n',
    'docs/security/data.md': '# Data\n\nBack to the [README](../../README.md).\n',
    'docs/usage/README.md': '# Usage\n\n- [Configuration](config.md)\n',
    'docs/usage/config.md': '# Configuration\n\nSet `sync.interval` in `relaybox.toml`.\n',
    'docs/dev/README.md': '# Developer docs\n\n- [Architecture](architecture.md)\n- [Guides](guides/)\n',
    'docs/dev/architecture.md': '# Architecture\n\nOne process.\n',
    'docs/dev/guides/one.md': '# One\n',
    'docs/dev/testing.md': '# Testing\n\nRun `relaybox-test`.\n',
  };
}

// Smoke runs: `node routing-fixtures.mjs crosscodex|small|mkdocs|antora <empty-dir>`.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [kind, dir] = process.argv.slice(2);
  if (!['crosscodex', 'small', 'mkdocs', 'antora'].includes(kind) || !dir) {
    process.stderr.write('usage: routing-fixtures.mjs crosscodex|small|mkdocs|antora <empty-dir>\n');
    process.exit(2);
  }
  mkdirSync(dir, { recursive: true });
  if (kind === 'small') writeSmallProject(dir);
  else { writeFiles(dir, { crosscodex: crosscodexFiles, mkdocs: mkdocsFiles, antora: antoraFiles }[kind]()); commitAll(dir); }
}
