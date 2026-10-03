#!/usr/bin/env node
// Cited-source snapshots for /docs-audit document mode.
//
// The only component of the module that makes network requests, and only when
// the user passed `/docs-audit --fetch`. It extracts every absolute URL a doc
// cites, fetches the ones the SSRF filter allows, and writes each response to
// a snapshot file the Lane 6 content-drift subagent reads as untrusted data.
// The LLM never fetches: a filter written as a prompt rule can be argued past
// by the content it guards, a filter in code cannot.
//
//   CITATION_BLOCKED       warning  the filter rejected the URL or a redirect hop
//   CITATION_FETCH_FAILED  info     network error, timeout, run deadline,
//                                   non-2xx, size cap, a compressed body, a
//                                   malformed Location header, a content
//                                   type that is not text, or an unexpected
//                                   error while fetching that one URL
//   CITATION_LIMIT         info     more than LIMITS.maxUrls distinct URLs
//   CITATIONS_NOT_FETCHED  info     --offline: one per doc citing a URL
//
// Filter (applied before connecting and on every redirect hop): https only,
// no userinfo, port 443, and every resolved address outside BLOCKED. The
// address check runs inside the `lookup` hook https.request calls, so it
// judges the addresses the socket actually connects to — a separate
// pre-resolution would let DNS answer differently the second time. Node skips
// `lookup` for an IP-literal host, so literals are checked up front.
//
// Time: each hop gets LIMITS.timeoutMs, and the whole run gets
// LIMITS.deadlineMs; a hop never outlives the run deadline, and no hop starts
// after it.
//
// Local sources: every relative link, image, cross-reference, or include
// target is resolved against its doc's directory and judged by realpath
// against `--root` (the audited path argument's directory). Accepted: a
// regular file inside --root with no dot-named component below it. Anything
// else is listed as unread with its reason; a missing target is left to
// REF_BROKEN. The script only stats and realpaths local sources — it never
// reads their contents.
//
// Output: JSON {status, scanned, fetched, findings:[{code, severity, file,
// line, message}], citations:[{url, file, line, snapshot}],
// localSources:[{file, line, target, path}], unreadSources:[{file, line,
// target, reason}]}. A doc outside --root is an internal error. Docs are
// judged lexically, by the path they were reached by, so a symlinked doc
// inside --root is audited even when its target lies elsewhere.
// Exit 0 = no findings, 1 = findings, 2 = internal error.

import https from 'node:https';
import { lookup as dnsLookup } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { join, dirname, resolve, relative, isAbsolute, sep } from 'node:path';
import { parseDoc } from './formats/index.mjs';
import { isMain } from './is-main.mjs';

export const LIMITS = { maxUrls: 50, maxBytes: 2 * 1024 * 1024, timeoutMs: 10_000, deadlineMs: 90_000, maxRedirects: 3 };
const KEPT_TYPE = /^(text\/[\w.+-]+|application\/json|application\/xhtml\+xml)\s*(;|$)/i;
const USER_AGENT = 'docs-discipline-fetch-citations';

// A citation is an absolute URL with an authority (`scheme://`). mailto:/tel:
// are contact details, and relative targets are local sources.
const ABSOLUTE = /^[a-z][a-z0-9+.-]*:\/\//i;
const NOT_LOCAL = /^(#|mailto:|tel:|data:)/i;

// Every absolute URL cited in a parsed doc — link, image, autolink, or bare —
// with the 1-based line it appears on, in document order. Code spans and code
// blocks never produce links, so examples are not citations.
//
// Each URL is reported in WHATWG canonical form (`new URL(…).href`), because
// it becomes a snapshot header line: the canonical form strips tabs and
// newlines and percent-encodes every other control character, so a `%0A` in
// the source can never forge a header line or smuggle a bidi control. The
// RAW target is parsed first, so the cited URL is never a different one than
// what a browser would open: decodeURI turns `%5C` into `\`, and the URL
// parser turns a `\` in an https URL into `/`, so decoding before parsing
// would canonicalize `https://evil.com%5C@127.0.0.1/` to
// `https://evil.com/@127.0.0.1/` — a different host. Decoding is the
// fallback, only for a target the raw string can't parse as given (adapters
// may hand one over percent-encoded, e.g. markdown-it encodes `[::1]` as
// `%5B::1%5D`, an invalid URL on its own); decodeURI leaves reserved escapes
// like `%2F` alone. A target that parses neither way stays as given, which
// carries no raw control characters, so checkUrl reports it as not a valid
// URL.
export function extractCitations(model) {
  const out = [];
  for (const l of model.links) {
    if (!l.target || !ABSOLUTE.test(l.target)) continue;
    let url;
    try { url = new URL(l.target).href; }
    catch { try { url = new URL(decodeUri(l.target)).href; } catch { url = l.target; } }
    out.push({ url, line: l.line });
  }
  return out;
}

function decodeUri(t) {
  try { return decodeURI(t); } catch { return t; }
}

// Targets may be percent-encoded; decode as check-refs.mjs does,
// keeping the raw string when an escape is malformed.
function decodeTarget(t) {
  try { return decodeURIComponent(t); } catch { return t; }
}

// Every relative reference target in a parsed doc with its line, in document
// order: {target, file} where `target` is the decoded target and `file` the
// decoded path with any #fragment stripped. Absolute URLs, pure anchors,
// mailto:, tel:, and data: are not local. Code never produces references.
function extractLocalTargets(model) {
  const out = [];
  for (const l of model.links) {
    if (!l.target || ABSOLUTE.test(l.target) || NOT_LOCAL.test(l.target)) continue;
    out.push({ target: decodeTarget(l.target), file: decodeTarget(l.target.replace(/#.*$/, '')), line: l.line });
  }
  return out;
}

const isOutside = (rel) => rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel);

// Judge one local target by its realpath against `realRoot` (already a
// realpath). Returns {path} when accepted, {path, reason} when rejected, or null
// when the target cannot be resolved (missing, dangling link, unreadable
// parent) — the same targets check-refs.mjs reports as REF_BROKEN.
function classifyLocal(realRoot, fromDir, file) {
  let path;
  try { path = realpathSync(resolve(fromDir, file)); } catch { return null; }
  const rel = relative(realRoot, path);
  if (isOutside(rel)) return { path, reason: 'outside the audited tree' };
  if (rel.split(sep).some((part) => part.startsWith('.'))) return { path, reason: 'inside a dot-directory' };
  if (!statSync(path).isFile()) return { path, reason: 'not a regular file' };
  return { path };
}

const BLOCKED = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) BLOCKED.addSubnet(net, prefix, 'ipv4');
// ::/96 covers ::, ::1, and IPv4-compatible addresses (::a.b.c.d);
// fec0::/10 is the deprecated site-local range. RFC 8215 local-use NAT64
// (64:ff9b:1::/48) may embed IPv4 outside the last 32 bits (bits 48-87), so
// the whole /48 is blocked outright rather than decoded.
for (const [net, prefix] of [
  ['::', 96], ['fc00::', 7], ['fec0::', 10], ['fe80::', 10], ['ff00::', 8], ['64:ff9b:1::', 48],
]) {
  BLOCKED.addSubnet(net, prefix, 'ipv6');
}
// The well-known NAT64 prefix 64:ff9b::/96 embeds an IPv4 address in its
// last 32 bits, so it is judged by that embedded address below instead of
// being blocked outright.
const NAT64 = new BlockList();
NAT64.addSubnet('64:ff9b::', 96, 'ipv6');

// True when `address` (an IP literal) must never be connected to. BlockList
// already matches IPv4-mapped IPv6 (::ffff:a.b.c.d) against the IPv4 ranges;
// an address under the well-known NAT64 prefix is judged by the IPv4
// address embedded in its last 32 bits.
export function isBlockedAddress(address) {
  const family = isIP(address);
  if (family === 4) return BLOCKED.check(address, 'ipv4');
  if (family !== 6) return true;
  if (NAT64.check(address, 'ipv6')) {
    const groups = new URL(`http://[${address}]/`).hostname.slice(1, -1).split(':');
    const hi = parseInt(groups.at(-2) || '0', 16);
    const lo = parseInt(groups.at(-1) || '0', 16);
    return BLOCKED.check([hi >> 8, hi & 255, lo >> 8, lo & 255].join('.'), 'ipv4');
  }
  return BLOCKED.check(address, 'ipv6');
}

// The URL-shape half of the filter. Returns {ok: true, url, host} with the
// bracket-free host to connect to, or {ok: false, reason}.
export function checkUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { return { ok: false, reason: 'not a valid URL' }; }
  if (url.protocol !== 'https:') return { ok: false, reason: `scheme ${url.protocol} is not https:` };
  if (url.username || url.password) return { ok: false, reason: 'URL carries credentials (userinfo)' };
  if (url.port && url.port !== '443') return { ok: false, reason: `port ${url.port} is not 443` };
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && isBlockedAddress(host)) return { ok: false, reason: `address ${host} is private, loopback, link-local, or reserved` };
  return { ok: true, url, host };
}

class Blocked extends Error {}

// Wraps a dns.lookup-compatible function so a host resolving to any blocked
// address fails to connect. Answers with the callback shape the caller asked
// for: net asks for `all: true` when it may try several addresses.
function guardedLookup(lookup) {
  return (hostname, options, callback) => {
    lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err);
      const bad = addresses.find((a) => isBlockedAddress(a.address));
      if (bad) return callback(new Blocked(`${hostname} resolves to ${bad.address}, which is private, loopback, link-local, or reserved`));
      if (options && options.all) return callback(null, addresses);
      return callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

// One GET with no redirect following, abandoned after `timeoutMs` with
// `expired` as the reason. Never rejects; resolves to one of
//   {kind: 'redirect', location} | {kind: 'response', status, contentType, body}
//   {kind: 'blocked', reason}   | {kind: 'failed', reason}
// The timer exists before request() is called, because a transport may
// respond or fail before request() returns.
function getOnce({ url, host }, { request, lookup, limits, timeoutMs, expired }) {
  return new Promise((resolve) => {
    let settled = false;
    let req;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      if (req) req.destroy();
      finish({ kind: 'failed', reason: expired });
    }, timeoutMs);
    const onError = (e) => finish(e instanceof Blocked ? { kind: 'blocked', reason: e.message } : { kind: 'failed', reason: e.message });
    try {
      req = request({
        hostname: host,
        port: 443,
        path: url.pathname + url.search,
        method: 'GET',
        agent: false,
        lookup: guardedLookup(lookup),
        headers: { 'user-agent': USER_AGENT, accept: 'text/*, application/json, application/xhtml+xml' },
      }, (res) => {
        const status = res.statusCode;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.destroy();
          return finish({ kind: 'redirect', location: res.headers.location });
        }
        const encoding = String(res.headers['content-encoding'] || 'identity').trim();
        if (encoding.toLowerCase() !== 'identity') {
          res.destroy();
          return finish({ kind: 'failed', reason: `content encoding "${encoding}" is not supported` });
        }
        const contentType = String(res.headers['content-type'] || '');
        if (!KEPT_TYPE.test(contentType)) {
          res.destroy();
          return finish({ kind: 'failed', reason: `content type "${contentType || 'none'}" is not text, JSON, or XHTML` });
        }
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > limits.maxBytes) {
            res.destroy();
            return finish({ kind: 'failed', reason: `body exceeds ${limits.maxBytes} bytes` });
          }
          chunks.push(chunk);
        });
        res.on('end', () => finish({ kind: 'response', status, contentType, body: Buffer.concat(chunks) }));
        res.on('error', (e) => finish({ kind: 'failed', reason: e.message }));
      });
      req.on('error', onError);
      req.end();
    } catch (e) {
      onError(e);
    }
  });
}

// Fetch one cited URL through the filter, following up to
// limits.maxRedirects redirects by hand so every hop is re-filtered. Resolves
// to {ok: true, finalUrl, status, contentType, body} or
// {ok: false, code: 'CITATION_BLOCKED' | 'CITATION_FETCH_FAILED', reason}.
// `deadline` (epoch ms, set by run() from limits.deadlineMs) caps every hop's
// timer; without it each hop gets the full limits.timeoutMs.
// `request` and `lookup` are injectable so tests drive every branch offline.
export async function fetchCitation(raw, { request = https.request, lookup = dnsLookup, limits = LIMITS, deadline } = {}) {
  const pastDeadline = `run deadline of ${limits.deadlineMs} ms reached`;
  let current = raw;
  for (let hop = 0; ; hop++) {
    const where = hop === 0 ? '' : `redirect hop ${hop} to ${current}: `;
    const verdict = checkUrl(current);
    if (!verdict.ok) return { ok: false, code: 'CITATION_BLOCKED', reason: where + verdict.reason };
    const left = deadline === undefined ? Infinity : deadline - Date.now();
    if (left <= 0) return { ok: false, code: 'CITATION_FETCH_FAILED', reason: where + pastDeadline };
    const timeoutMs = Math.min(limits.timeoutMs, left);
    const expired = timeoutMs < limits.timeoutMs ? pastDeadline : `no complete response within ${limits.timeoutMs} ms`;
    const r = await getOnce(verdict, { request, lookup, limits, timeoutMs, expired });
    if (r.kind === 'blocked') return { ok: false, code: 'CITATION_BLOCKED', reason: where + r.reason };
    if (r.kind === 'failed') return { ok: false, code: 'CITATION_FETCH_FAILED', reason: where + r.reason };
    if (r.kind === 'redirect') {
      if (hop === limits.maxRedirects) {
        return { ok: false, code: 'CITATION_FETCH_FAILED', reason: where + `more than ${limits.maxRedirects} redirects` };
      }
      try {
        current = new URL(r.location, verdict.url).href;
      } catch {
        return { ok: false, code: 'CITATION_FETCH_FAILED', reason: where + 'invalid Location header' };
      }
      continue;
    }
    if (r.status < 200 || r.status > 299) {
      return { ok: false, code: 'CITATION_FETCH_FAILED', reason: where + `HTTP status ${r.status}` };
    }
    return { ok: true, finalUrl: verdict.url.href, status: r.status, contentType: r.contentType, body: r.body };
  }
}

export function snapshotName(url) {
  return createHash('sha256').update(url).digest('hex') + '.txt';
}

export function snapshotContent(url, result, fetchedAt) {
  const header = [
    `url: ${url}`,
    `final-url: ${result.finalUrl}`,
    `status: ${result.status}`,
    `content-type: ${result.contentType}`,
    `fetched-at: ${fetchedAt}`,
    '---',
    '',
  ].join('\n');
  return Buffer.concat([Buffer.from(header), result.body]);
}

function usage() {
  process.stderr.write('usage: fetch-citations.mjs --root <dir> --out <empty-dir> <doc>...\n'
    + '       fetch-citations.mjs --root <dir> --offline <doc>...\n');
  process.exit(2);
}

// Run `worker` over `items` with at most `n` in flight.
async function pool(items, n, worker) {
  let next = 0;
  const run = async () => { while (next < items.length) await worker(items[next++]); };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, run));
}

export async function run(argv, transport = {}) {
  const args = argv.slice(2);
  const offline = args.includes('--offline');
  const outAt = args.indexOf('--out');
  const out = outAt === -1 ? null : args[outAt + 1];
  const rootAt = args.indexOf('--root');
  const root = rootAt === -1 ? undefined : args[rootAt + 1];
  const docs = args.filter((a, i) => a !== '--offline' && i !== outAt && i !== outAt + 1 && i !== rootAt && i !== rootAt + 1);
  if (!docs.length || (offline === (out !== null)) || (outAt !== -1 && !out) || !root) return null;
  let realRoot;
  try { realRoot = realpathSync(root); } catch { realRoot = null; }
  if (!realRoot || !statSync(realRoot).isDirectory()) throw new Error(`--root ${root} must be an existing directory`);
  for (const file of docs) {
    if (isOutside(relative(resolve(root), resolve(file)))) throw new Error(`${file} is not inside --root ${root}`);
  }
  if (out && (!statSync(out).isDirectory() || readdirSync(out).length)) {
    throw new Error(`--out ${out} must be an existing empty directory`);
  }

  const citations = [];
  const localSources = [];
  const unreadSources = [];
  for (const file of docs) {
    const model = await parseDoc(file, readFileSync(file, 'utf8'));
    for (const c of extractCitations(model)) citations.push({ ...c, file });
    const seen = new Set();
    for (const t of extractLocalTargets(model)) {
      const verdict = classifyLocal(realRoot, dirname(file), t.file);
      if (!verdict || seen.has(verdict.path)) continue;
      seen.add(verdict.path);
      if (verdict.reason) unreadSources.push({ file, line: t.line, target: t.target, reason: verdict.reason });
      else localSources.push({ file, line: t.line, target: t.target, path: verdict.path });
    }
  }
  const first = new Map();
  for (const c of citations) if (!first.has(c.url)) first.set(c.url, c);
  const findings = [];
  const snapshots = new Map();

  if (offline) {
    for (const file of docs) {
      const cited = citations.filter((c) => c.file === file);
      if (!cited.length) continue;
      const urls = [...new Set(cited.map((c) => c.url))];
      findings.push({
        code: 'CITATIONS_NOT_FETCHED', severity: 'info', file, line: cited[0].line,
        message: `${urls.length} cited URL(s) not fetched (run /docs-audit --fetch to verify claims against them): ${urls.join(', ')}`,
      });
    }
  } else {
    const unique = [...first.keys()];
    const toFetch = unique.slice(0, LIMITS.maxUrls);
    const skipped = unique.slice(LIMITS.maxUrls);
    if (skipped.length) {
      findings.push({
        code: 'CITATION_LIMIT', severity: 'info', file: '—', line: null,
        message: `${unique.length} distinct URLs cited; only the first ${LIMITS.maxUrls} were fetched. Not fetched: ${skipped.join(', ')}`,
      });
    }
    const deadline = Date.now() + LIMITS.deadlineMs;
    // One URL must never sink the run: an unexpected throw becomes that URL's
    // finding instead of an internal error that discards every result.
    await pool(toFetch, 5, async (url) => {
      const { file, line } = first.get(url);
      let r;
      try {
        r = await fetchCitation(url, { ...transport, deadline });
      } catch (e) {
        findings.push({ code: 'CITATION_FETCH_FAILED', severity: 'info', file, line, message: `${url} — unexpected error: ${e && e.message ? e.message : e}` });
        return;
      }
      if (!r.ok) {
        findings.push({ code: r.code, severity: r.code === 'CITATION_BLOCKED' ? 'warning' : 'info', file, line, message: `${url} — ${r.reason}` });
        return;
      }
      const name = snapshotName(url);
      writeFileSync(join(out, name), snapshotContent(url, r, new Date().toISOString()));
      snapshots.set(url, join(out, name));
    });
  }

  findings.sort((a, b) => String(a.file).localeCompare(String(b.file)) || (a.line || 0) - (b.line || 0));
  return {
    status: findings.length ? 'findings' : 'ok',
    scanned: docs.length,
    fetched: snapshots.size,
    findings,
    citations: citations.map((c) => ({ url: c.url, file: c.file, line: c.line, snapshot: snapshots.get(c.url) || null })),
    localSources,
    unreadSources,
  };
}

if (isMain(import.meta.url)) {
  run(process.argv).then((result) => {
    if (!result) usage();
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exit(result.findings.length ? 1 : 0);
  }).catch((e) => {
    process.stderr.write('fetch-citations: internal error: ' + (e && e.stack ? e.stack : e) + '\n');
    process.exit(2);
  });
}
