#!/usr/bin/env node
// Build scripts/vendor/linguist.json from GitHub Linguist at a pinned tag.
//
// check-staleness.mjs needs to know which tracked files are *source*. Linguist
// is the maintained answer (it drives GitHub's language bar); rather than
// hand-maintain an extension list, fetch its data at a pinned tag, verify each
// file against a pinned SHA-256, and ship a trimmed JSON. Bumping the tag means
// updating TAG and every hash below, then `task vendor`.
//
// Usage: node build-linguist-data.mjs <license-out-path>
// Writes $SCRIPTS_DIR/vendor/linguist.json and the Linguist LICENSE text to
// <license-out-path> (build-vendor.sh folds it into LICENSES.md).

import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SCRIPTS_DIR = 'module/skills/docs-organization/scripts';
// js-yaml comes from the `task vendor` toolchain, which lives outside module/.
const require = createRequire(resolve('.taskfiles/vendor', 'package.json'));
const yaml = require('js-yaml');

const TAG = 'v9.7.0';
const BASE = `https://raw.githubusercontent.com/github-linguist/linguist/${TAG}/`;
const PINNED = {
  'lib/linguist/languages.yml': '7c2bc5b59662de6c5d09cd4990e82b2541d4cd2ea7c8c213537730474f24a5c7',
  'lib/linguist/vendor.yml': '1ae9980298c7c4b89fa663f1efbab3c977818a0fcb59ddc869f2b8060a7ad345',
  'lib/linguist/documentation.yml': '9bcc2d965be92c009926dd9390b5a454e309d851f7b26a0f51d6570a808a8745',
  'LICENSE': '7717070c5a8c85440ff2312930bb30dd19002ab5bc235c9800042767f6f5242f',
};

async function fetchPinned(path) {
  let res;
  try {
    res = await fetch(BASE + path);
  } catch (e) {
    throw new Error(`${BASE + path}: ${e.cause?.message ?? e.message}`);
  }
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = createHash('sha256').update(buf).digest('hex');
  if (got !== PINNED[path]) {
    throw new Error(`${path}: sha256 ${got} does not match pinned ${PINNED[path]}`);
  }
  return buf.toString('utf8');
}

// Extension rule follows Linguist's own "detectable" definition (docs/overrides.md:
// "By default only languages of type `programming` or `markup` ... are included
// in the language statistics"): a programming or markup language claims it, no
// prose language does, and no data language claims it as that data language's
// primary (first-listed) extension. `.md` is claimed by GCC Machine Description
// (programming) and Markdown (prose), so it is never source. `.sql` is claimed by
// SQLPL/TSQL (programming) but also by SQL (data) as SQL's primary extension, so
// it is excluded too.
function sourceExtensions(languages) {
  const claims = new Map();
  for (const lang of Object.values(languages)) {
    (lang.extensions || []).forEach((ext, i) => {
      const key = ext.toLowerCase();
      if (!claims.has(key)) claims.set(key, []);
      claims.get(key).push({ type: lang.type, primary: i === 0 });
    });
  }
  return [...claims]
    .filter(([, cs]) => {
      const detectable = cs.some((c) => c.type === 'programming' || c.type === 'markup');
      const claimedByProse = cs.some((c) => c.type === 'prose');
      const primaryOfData = cs.some((c) => c.type === 'data' && c.primary);
      return detectable && !claimedByProse && !primaryOfData;
    })
    .map(([ext]) => ext)
    .sort();
}

// Filename rule: every language that lists the exact filename is programming or
// markup (the same "detectable" types as the extension rule).
function sourceFilenames(languages) {
  const claims = new Map();
  for (const lang of Object.values(languages)) {
    for (const name of lang.filenames || []) {
      if (!claims.has(name)) claims.set(name, []);
      claims.get(name).push(lang.type);
    }
  }
  return [...claims]
    .filter(([, types]) => types.every((t) => t === 'programming' || t === 'markup'))
    .map(([name]) => name)
    .sort();
}

const licenseOut = process.argv[2];
if (!licenseOut) {
  process.stderr.write('usage: build-linguist-data.mjs <license-out-path>\n');
  process.exit(2);
}

const files = {};
for (const path of Object.keys(PINNED)) files[path] = await fetchPinned(path);

const languages = yaml.load(files['lib/linguist/languages.yml']);
const excludePaths = [
  ...yaml.load(files['lib/linguist/vendor.yml']),
  ...yaml.load(files['lib/linguist/documentation.yml']),
];
for (const p of excludePaths) new RegExp(p); // throws on a pattern JS cannot compile

const out = {
  source: `github-linguist/linguist ${TAG}`,
  extensions: sourceExtensions(languages),
  filenames: sourceFilenames(languages),
  excludePaths,
};
writeFileSync(join(SCRIPTS_DIR, 'vendor', 'linguist.json'), JSON.stringify(out, null, 1) + '\n');
writeFileSync(licenseOut, files.LICENSE);
process.stdout.write(`build-linguist-data: ${out.extensions.length} extensions, ${out.filenames.length} filenames, ${excludePaths.length} exclude patterns\n`);
