// Markdown file enumeration shared by check-prose.mjs and check-refs.mjs.
//
// A symlinked .md file is included: a doc tree can be a directory of symlinks
// into a canonical copy, and each script decides what a second path to the
// same file means (check-prose dedupes it; check-refs resolves links from it).
// A symlinked *directory* is not descended — git tracks it as one entry, and
// following it could loop. A dangling .md symlink makes statSync throw, which
// the callers surface as exit 2 rather than silently skipping the file.
//
// CLI: `node md-files.mjs <path>...` prints the JSON array of markdown files
// the walk finds, in argument order. /docs-audit uses it to expand directory
// arguments so every lane receives the same explicit file list. A missing path
// exits 2.

import { statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isMain } from './is-main.mjs';

export function walkMarkdown(target) {
  const st = statSync(target);
  if (st.isFile()) return target.endsWith('.md') ? [target] : [];
  const out = [];
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue; // skip dot-dirs (agent runtime spaces)
    const p = join(target, entry.name);
    if (entry.isDirectory()) out.push(...walkMarkdown(p));
    else if (!entry.name.endsWith('.md')) continue;
    else if (entry.isFile() || (entry.isSymbolicLink() && statSync(p).isFile())) out.push(p);
  }
  return out;
}

if (isMain(import.meta.url)) {
  const targets = process.argv.slice(2);
  if (targets.length === 0) {
    process.stderr.write('usage: md-files.mjs <file-or-dir>...\n');
    process.exit(2);
  }
  try {
    process.stdout.write(JSON.stringify(targets.flatMap((t) => walkMarkdown(t)), null, 2) + '\n');
  } catch (e) {
    process.stderr.write('md-files: internal error: ' + (e && e.stack ? e.stack : e) + '\n');
    process.exit(2);
  }
}
