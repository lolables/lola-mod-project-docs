// Link-target helpers shared by check-refs.mjs, nav-graph.mjs, and
// antora.mjs: which targets are external, how a percent-encoded target
// decodes, and which directories a tracked file set implies.

import { dirname } from 'node:path';

export function isExternal(t) {
  return /^[a-z]+:\/\//i.test(t) || t.startsWith('mailto:') || t.startsWith('#') || t.startsWith('tel:')
    || /^data:/i.test(t);
}

// Targets can arrive percent-encoded (markdown-it encodes every href) — a literal
// space written inside `<...>`, or a non-ASCII byte written bare, comes out
// as `%20` / `%C3%A9` — so the target must be decoded before it can match a
// tracked filesystem path, and the decoded form is what findings report
// (closer to what the author actually wrote than the re-encoded href). A
// malformed escape (not a valid UTF-8 percent sequence) falls back to the
// raw string rather than throwing.
export function decodeTarget(t) {
  try { return decodeURIComponent(t); }
  catch { return t; }
}

// Every ancestor directory of a tracked file — git tracks files, not dirs, so a
// link to a real directory (`module/agents/`) would otherwise look untracked.
export function trackedDirsOf(tracked) {
  const dirs = new Set();
  for (const f of tracked) {
    let d = dirname(f);
    while (d && d !== '.') { dirs.add(d); d = dirname(d); }
  }
  return dirs;
}
