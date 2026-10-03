#!/usr/bin/env node
// Re-pin .taskfiles/vendor/linguist-pin.json to Linguist's latest release.
//
// Looks up the latest release tag, fetches every file the pin already lists at
// that tag, and records each file's SHA-256. This is trust-on-first-use: the new
// hashes are whatever GitHub serves now, so review the regenerated linguist.json
// diff before committing. After that, build-linguist-data.mjs rejects any
// mismatch.
//
// Usage: node bump-linguist-pin.mjs   (run from the repo root; `task deps:bump`)

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const PIN_FILE = '.taskfiles/vendor/linguist-pin.json';
const REPO = 'github-linguist/linguist';

async function get(url, accept) {
  let res;
  try {
    res = await fetch(url, { headers: { Accept: accept, 'User-Agent': 'docs-discipline-deps-bump' } });
  } catch (e) {
    throw new Error(`${url}: ${e.cause?.message ?? e.message}`);
  }
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res;
}

const pin = JSON.parse(readFileSync(PIN_FILE, 'utf8'));

const release = await (await get(`https://api.github.com/repos/${REPO}/releases/latest`, 'application/vnd.github+json')).json();
const tag = release.tag_name;
// The tag is spliced into fetch URLs and the shipped linguist.json, so accept
// only a plain release tag.
if (typeof tag !== 'string' || !/^v\d+\.\d+\.\d+$/.test(tag)) {
  throw new Error(`unexpected latest release tag from ${REPO}: ${JSON.stringify(tag)}`);
}

if (tag === pin.tag) {
  process.stdout.write(`bump-linguist-pin: already at ${tag}\n`);
  process.exit(0);
}

const sha256 = {};
for (const path of Object.keys(pin.sha256)) {
  const res = await get(`https://raw.githubusercontent.com/${REPO}/${tag}/${path}`, '*/*');
  sha256[path] = createHash('sha256').update(Buffer.from(await res.arrayBuffer())).digest('hex');
}

writeFileSync(PIN_FILE, JSON.stringify({ tag, sha256 }, null, 1) + '\n');
process.stdout.write(`bump-linguist-pin: ${pin.tag} -> ${tag}\n`);
