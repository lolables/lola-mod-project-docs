import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { isIP } from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, mkdirSync, realpathSync, rmSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractCitations, isBlockedAddress, checkUrl, fetchCitation, snapshotName, snapshotContent, run, LIMITS,
} from '../../../module/skills/docs-organization/scripts/fetch-citations.mjs';
import { parseDoc } from '../../../module/skills/docs-organization/scripts/formats/index.mjs';

const cites = async (src, name = 'doc.md') => extractCitations(await parseDoc(name, src));

const tmpDirs = [];
after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});
function mktemp() {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'fetch-citations-')));
  tmpDirs.push(d);
  return d;
}

// An offline stand-in for https.request + dns.lookup. `routes` maps a
// hostname to {addrs, status, headers, body} or {addrs, hang: true}. Like the
// real transport, the fake request resolves the host through `opts.lookup` —
// the guarded lookup fetchCitation installs — before "connecting", so the
// address filter is exercised exactly as in production.
function fakeTransport(routes) {
  const requested = [];
  const lookup = (host, options, callback) => {
    const r = routes[host];
    if (!r) return callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' }));
    return callback(null, r.addrs.map((address) => ({ address, family: isIP(address) })));
  };
  const request = (opts, onResponse) => {
    const req = new EventEmitter();
    req.end = () => opts.lookup(opts.hostname, { all: true }, (err) => {
      if (err) return req.emit('error', err);
      requested.push(opts.hostname);
      const r = routes[opts.hostname];
      if (r.hang) return;
      const res = Readable.from(r.body === undefined ? [] : [Buffer.from(r.body)]);
      res.statusCode = r.status;
      res.headers = r.headers || {};
      onResponse(res);
    });
    req.destroy = () => {};
    return req;
  };
  return { request, lookup, requested };
}

const PUBLIC = '93.184.216.34';
const html = (body) => ({ addrs: [PUBLIC], status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body });
const redirect = (location) => ({ addrs: [PUBLIC], status: 301, headers: { location } });

// --- extraction ---

test('extracts link, image, autolink, bare, and table-cell URLs with their lines', async () => {
  const doc = [
    '# Title',
    'See https://bare.example/a and',
    '[text](https://link.example/b) plus <https://auto.example/c>.',
    '![img](https://img.example/d.png)',
    '',
    '| col |',
    '|---|',
    '| https://cell.example/e |',
  ].join('\n');
  assert.deepEqual(await cites(doc), [
    { url: 'https://bare.example/a', line: 2 },
    { url: 'https://link.example/b', line: 3 },
    { url: 'https://auto.example/c', line: 3 },
    { url: 'https://img.example/d.png', line: 4 },
    { url: 'https://cell.example/e', line: 8 },
  ]);
});

// markdown-it percent-encodes link targets (`[`→%5B), which would make an
// IPv6 literal an invalid URL. Citations carry the WHATWG canonical href:
// IPv6 brackets survive, non-ASCII is percent-encoded, %2F stays encoded.
test('citations are reported in WHATWG canonical form: IPv6 brackets, non-ASCII, reserved escapes', async () => {
  assert.deepEqual((await cites('[a](https://[::1]/) [b](https://ex.example/é?q=ü) [c](https://ex.example/a%2Fb)')).map((c) => c.url),
    ['https://[::1]/', 'https://ex.example/%C3%A9?q=%C3%BC', 'https://ex.example/a%2Fb']);
});

// The citation URL becomes a snapshot header line, so it must never carry a
// raw newline, control character, or bidi override that could forge or
// visually disguise provenance.
test('control and bidi characters in a cited URL never appear raw', async () => {
  const doc = '[a](https://ex.example/a‮b) [b](https://ex.example/c%E2%80%AEd) [c](https://ex.example/e%0Af%01g%7F) https://ex.example/h‮i';
  const urls = (await cites(doc)).map((c) => c.url);
  assert.equal(urls.length, 4);
  for (const url of urls) assert.doesNotMatch(url, /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/);
});

// decodeURI turns %5C into \, and the URL parser turns a \ in an https URL
// into /, so decoding before parsing would canonicalize this to
// https://evil.com/@127.0.0.1/ — a different host than a browser opens.
// The raw string must be tried first, so the cited host matches what a
// browser (and checkUrl, and the fetch itself) actually resolves.
test('a URL that decodes to a different host is cited by its raw host, not a decoded one', async () => {
  const [c] = await cites('[a](https://evil.com%5C@127.0.0.1/)');
  assert.equal(new URL(c.url).hostname, '127.0.0.1');
});

test('an unparseable citation keeps the percent-encoded target so the filter reports it', async () => {
  const [c] = await cites('[a](https://exa%20mple.com/)');
  assert.equal(c.url, 'https://exa%20mple.com/');
  assert.match(checkUrl(c.url).reason, /not a valid URL/);
});

test('URLs in code spans and fenced blocks are examples, not citations', async () => {
  const doc = 'Run `curl https://span.example/`.\n\n```\nhttps://fence.example/\n```\n';
  assert.deepEqual(await cites(doc), []);
});

test('relative links, anchors, and mailto: are not citations', async () => {
  assert.deepEqual(await cites('[a](./x.md) [b](#top) [c](mailto:me@example.com)'), []);
});

// markdown-it's validateLink never turns file:, javascript:, vbscript:, or
// non-image data: targets into links, so those can never become citations.
test('non-https absolute URLs are extracted so the filter can report them', async () => {
  assert.deepEqual((await cites('[a](http://plain.example/) [b](ftp://files.example/x)')).map((c) => c.url),
    ['http://plain.example/', 'ftp://files.example/x']);
});

test('fuzzy links without a scheme are not citations', async () => {
  assert.deepEqual(await cites('Visit www.example.com today.'), []);
});

test('URLs inside admonitions and footnotes are citations; front matter is not', async () => {
  const doc = '---\nurl: https://fm.example/\n---\n!!! note\n    See https://adm.example/a.\n\nText[^1].\n\n[^1]: From [x](https://fn.example/b).\n';
  assert.deepEqual(await cites(doc), [
    { url: 'https://adm.example/a', line: 5 },
    { url: 'https://fn.example/b', line: 9 },
  ]);
});

test('AsciiDoc: URL macros, bare URLs, and attribute URLs are citations; links in listings are not', async () => {
  const doc = '= T\n:site: https://attr.example\n\nSee https://macro.example/a[A], https://bare.example/b, and {site}/c.\n\n----\nhttps://listing.example/\n----\n';
  assert.deepEqual(await cites(doc, 'doc.adoc'), [
    { url: 'https://macro.example/a', line: 4 },
    { url: 'https://bare.example/b', line: 4 },
    { url: 'https://attr.example/c', line: 4 },
  ]);
});

// --- address filter (negative cases first) ---

for (const address of [
  '0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1',
  '192.0.0.8', '192.168.1.1', '198.18.0.1', '224.0.0.1', '255.255.255.255',
  '::', '::1', 'fd00::1', 'fe80::1', 'ff02::1',
  '::ffff:127.0.0.1', '::ffff:10.0.0.1', '64:ff9b::a00:1', '64:ff9b::7f00:1',
  'fec0::1', '::127.0.0.1', '::808:808', '64:ff9b:1::a00:1', '64:ff9b:1::7f00:1', '64:ff9b:1::808:808',
]) {
  test(`blocks ${address}`, () => assert.equal(isBlockedAddress(address), true));
}

for (const address of ['8.8.8.8', PUBLIC, '2606:4700::1111', '64:ff9b::808:808']) {
  test(`allows public ${address}`, () => assert.equal(isBlockedAddress(address), false));
}

test('a string that is not an IP address is blocked', async () => {
  assert.equal(isBlockedAddress('example.com'), true);
});

// --- URL filter ---

for (const [raw, reason] of [
  ['http://example.com/', /scheme http: is not https:/],
  ['ftp://files.example/x', /scheme ftp: is not https:/],
  ['https://user:pw@example.com/', /credentials/],
  ['https://example.com:8443/', /port 8443/],
  ['https://127.0.0.1/', /127\.0\.0\.1 is private/],
  ['https://[::1]/', /::1 is private/],
  ['https://0x7f.1/', /127\.0\.0\.1 is private/],
  ['https://2130706433/', /127\.0\.0\.1 is private/],
  ['https://[::ffff:169.254.169.254]/', /private/],
  ['https://exa mple.com/', /not a valid URL/],
]) {
  test(`checkUrl rejects ${raw}`, () => {
    const v = checkUrl(raw);
    assert.equal(v.ok, false);
    assert.match(v.reason, reason);
  });
}

test('checkUrl accepts a public https URL and an explicit :443', async () => {
  assert.equal(checkUrl('https://example.com/a?b=1').ok, true);
  assert.equal(checkUrl('https://example.com:443/').ok, true);
});

// --- fetching (offline, injected transport) ---

test('a public text response is returned with its body', async () => {
  const t = fakeTransport({ 'good.example': html('hello') });
  const r = await fetchCitation('https://good.example/p', t);
  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
  assert.equal(r.finalUrl, 'https://good.example/p');
  assert.equal(r.body.toString(), 'hello');
});

test('a host resolving to one public and one private address is blocked', async () => {
  const t = fakeTransport({ 'mixed.example': { ...html('x'), addrs: [PUBLIC, '10.0.0.5'] } });
  const r = await fetchCitation('https://mixed.example/', t);
  assert.equal(r.code, 'CITATION_BLOCKED');
  assert.match(r.reason, /10\.0\.0\.5/);
  assert.deepEqual(t.requested, []);
});

test('a host resolving to loopback is blocked before any response is read', async () => {
  const t = fakeTransport({ 'localhost': { ...html('x'), addrs: ['127.0.0.1', '::1'] } });
  const r = await fetchCitation('https://localhost/', t);
  assert.equal(r.code, 'CITATION_BLOCKED');
  assert.deepEqual(t.requested, []);
});

test('a public host redirecting to a private host is blocked at that hop', async () => {
  const t = fakeTransport({
    'pub.example': redirect('https://internal.example/admin'),
    'internal.example': { ...html('secret'), addrs: ['192.168.1.10'] },
  });
  const r = await fetchCitation('https://pub.example/', t);
  assert.equal(r.code, 'CITATION_BLOCKED');
  assert.match(r.reason, /^redirect hop 1 to https:\/\/internal\.example\/admin: /);
  assert.deepEqual(t.requested, ['pub.example']);
});

test('a redirect to an http: URL is blocked', async () => {
  const t = fakeTransport({ 'pub.example': redirect('http://pub.example/') });
  const r = await fetchCitation('https://pub.example/', t);
  assert.equal(r.code, 'CITATION_BLOCKED');
  assert.match(r.reason, /scheme http:/);
});

test('a relative redirect resolves against the current URL', async () => {
  const t = fakeTransport({ 'pub.example': { addrs: [PUBLIC], status: 302, headers: { location: '/moved' } } });
  t.request = ((inner) => (opts, cb) => {
    if (opts.path === '/moved') {
      const req = new EventEmitter();
      req.end = () => {
        const res = Readable.from([Buffer.from('moved')]);
        res.statusCode = 200;
        res.headers = { 'content-type': 'text/plain' };
        cb(res);
      };
      req.destroy = () => {};
      return req;
    }
    return inner(opts, cb);
  })(t.request);
  const r = await fetchCitation('https://pub.example/start', t);
  assert.equal(r.ok, true);
  assert.equal(r.finalUrl, 'https://pub.example/moved');
});

test('three redirects are followed; a fourth is refused', async () => {
  const t = fakeTransport({
    'r1.example': redirect('https://r2.example/'),
    'r2.example': redirect('https://r3.example/'),
    'r3.example': redirect('https://r4.example/'),
    'r4.example': redirect('https://good.example/'),
    'good.example': html('end'),
  });
  assert.equal((await fetchCitation('https://r2.example/', t)).ok, true);
  const r = await fetchCitation('https://r1.example/', t);
  assert.equal(r.code, 'CITATION_FETCH_FAILED');
  assert.equal(r.reason, 'redirect hop 3 to https://r4.example/: more than 3 redirects');
});

test('a malformed Location header fails that URL with the hop prefix', async () => {
  const t = fakeTransport({ 'r1.example': redirect('https://r2.example/'), 'r2.example': redirect('https://[') });
  const r = await fetchCitation('https://r1.example/', t);
  assert.equal(r.code, 'CITATION_FETCH_FAILED');
  assert.equal(r.reason, 'redirect hop 1 to https://r2.example/: invalid Location header');
});

test('a hop-0 finalUrl is the canonical parsed URL, not the raw string', async () => {
  const t = fakeTransport({ 'good.example': html('x') });
  const r = await fetchCitation('https://good.example/p\nstatus: 200', t);
  assert.equal(r.ok, true);
  assert.equal(r.finalUrl, 'https://good.example/pstatus:%20200');
});

test('a compressed body is refused', async () => {
  const t = fakeTransport({ 'gz.example': { ...html('x'), headers: { 'content-type': 'text/plain', 'content-encoding': 'gzip' } } });
  const r = await fetchCitation('https://gz.example/', t);
  assert.equal(r.code, 'CITATION_FETCH_FAILED');
  assert.match(r.reason, /content encoding "gzip"/);
});

test('an identity content encoding is accepted', async () => {
  const t = fakeTransport({ 'id.example': { ...html('x'), headers: { 'content-type': 'text/plain', 'content-encoding': 'identity' } } });
  assert.equal((await fetchCitation('https://id.example/', t)).ok, true);
});

// A transport may answer before request() returns. getOnce must not touch
// state it has not initialized yet, and must not reject.
test('a transport that responds synchronously inside request() is handled', async () => {
  const request = (opts, onResponse) => {
    const res = Readable.from([]);
    res.statusCode = 200;
    res.headers = { 'content-type': 'image/png' };
    onResponse(res);
    const req = new EventEmitter();
    req.end = () => {};
    req.destroy = () => {};
    return req;
  };
  const r = await fetchCitation('https://sync.example/', { request, lookup: () => {} });
  assert.equal(r.code, 'CITATION_FETCH_FAILED');
  assert.match(r.reason, /content type "image\/png"/);
});

test('a transport that emits error synchronously inside request() fails that URL', async () => {
  const request = () => {
    const req = new EventEmitter();
    req.emit('error', new Error('socket exploded'));
    return req;
  };
  const r = await fetchCitation('https://sync.example/', { request, lookup: () => {} });
  assert.equal(r.code, 'CITATION_FETCH_FAILED');
  assert.match(r.reason, /socket exploded/);
});

test('a run deadline cuts a hop short of the per-hop timeout', async () => {
  const t = fakeTransport({ 'hang.example': { addrs: [PUBLIC], hang: true } });
  const started = Date.now();
  const r = await fetchCitation('https://hang.example/', { ...t, limits: { ...LIMITS, timeoutMs: 5000, deadlineMs: 40 }, deadline: started + 40 });
  assert.equal(r.code, 'CITATION_FETCH_FAILED');
  assert.equal(r.reason, 'run deadline of 40 ms reached');
  assert.ok(Date.now() - started < 2000);
});

test('no hop starts once the run deadline has passed', async () => {
  const t = fakeTransport({ 'r1.example': redirect('https://good.example/'), 'good.example': html('x') });
  const r = await fetchCitation('https://r1.example/', { ...t, limits: { ...LIMITS, deadlineMs: 5 }, deadline: Date.now() - 1 });
  assert.equal(r.code, 'CITATION_FETCH_FAILED');
  assert.equal(r.reason, 'run deadline of 5 ms reached');
  assert.deepEqual(t.requested, []);
});

test('without a deadline option the per-hop timeout still applies', async () => {
  const t = fakeTransport({ 'hang.example': { addrs: [PUBLIC], hang: true } });
  const r = await fetchCitation('https://hang.example/', { ...t, limits: { ...LIMITS, timeoutMs: 30 } });
  assert.equal(r.reason, 'no complete response within 30 ms');
});

// --- the guarded lookup, through the real transport and directly ---

// localhost resolves through /etc/hosts, so this touches no external network.
test('the real transport blocks a host that resolves to loopback', async () => {
  const r = await fetchCitation('https://localhost/');
  assert.equal(r.code, 'CITATION_BLOCKED');
  assert.match(r.reason, /resolves to/);
});

// net only asks for `all: true` when it may race several addresses; the
// single-address callback shape must be answered and filtered too.
test('the guarded lookup answers a caller that does not ask for all addresses', async () => {
  const seen = {};
  const lookup = (host, options, cb) => cb(null, [{ address: host === 'pub.example' ? PUBLIC : '10.0.0.1', family: 4 }]);
  const request = (opts) => {
    const req = new EventEmitter();
    req.end = () => opts.lookup(opts.hostname, {}, (...args) => {
      seen[opts.hostname] = args;
      req.emit('error', new Error('stop after lookup'));
    });
    req.destroy = () => {};
    return req;
  };
  await fetchCitation('https://pub.example/', { request, lookup });
  await fetchCitation('https://priv.example/', { request, lookup });
  assert.deepEqual(seen['pub.example'], [null, PUBLIC, 4]);
  assert.equal(seen['priv.example'].length, 1);
  assert.match(seen['priv.example'][0].message, /priv\.example resolves to 10\.0\.0\.1/);
});

test('a body over the size cap fails', async () => {
  const t = fakeTransport({ 'big.example': html('x'.repeat(11)) });
  const r = await fetchCitation('https://big.example/', { ...t, limits: { ...LIMITS, maxBytes: 10 } });
  assert.equal(r.code, 'CITATION_FETCH_FAILED');
  assert.match(r.reason, /exceeds 10 bytes/);
});

test('a response that never completes times out', async () => {
  const t = fakeTransport({ 'hang.example': { addrs: [PUBLIC], hang: true } });
  const r = await fetchCitation('https://hang.example/', { ...t, limits: { ...LIMITS, timeoutMs: 30 } });
  assert.equal(r.code, 'CITATION_FETCH_FAILED');
  assert.match(r.reason, /within 30 ms/);
});

for (const type of ['application/octet-stream', 'image/png', '']) {
  test(`content type "${type}" is not kept`, async () => {
    const t = fakeTransport({ 'bin.example': { addrs: [PUBLIC], status: 200, headers: type ? { 'content-type': type } : {}, body: 'x' } });
    const r = await fetchCitation('https://bin.example/', t);
    assert.equal(r.code, 'CITATION_FETCH_FAILED');
    assert.match(r.reason, /content type/);
  });
}

for (const type of ['text/plain', 'text/markdown; charset=utf-8', 'application/json', 'application/xhtml+xml']) {
  test(`content type "${type}" is kept`, async () => {
    const t = fakeTransport({ 'ok.example': { addrs: [PUBLIC], status: 200, headers: { 'content-type': type }, body: '{}' } });
    assert.equal((await fetchCitation('https://ok.example/', t)).ok, true);
  });
}

test('a non-2xx final status fails', async () => {
  const t = fakeTransport({ 'nf.example': { ...html('gone'), status: 404 } });
  const r = await fetchCitation('https://nf.example/', t);
  assert.equal(r.code, 'CITATION_FETCH_FAILED');
  assert.match(r.reason, /HTTP status 404/);
});

test('an unresolvable host fails without being blocked', async () => {
  const r = await fetchCitation('https://missing.example/', fakeTransport({}));
  assert.equal(r.code, 'CITATION_FETCH_FAILED');
  assert.match(r.reason, /ENOTFOUND/);
});

test('requests send no credentials or cookies', async () => {
  let seen;
  const t = fakeTransport({ 'good.example': html('x') });
  const inner = t.request;
  t.request = (opts, cb) => { seen = opts; return inner(opts, cb); };
  await fetchCitation('https://good.example/', t);
  const names = Object.keys(seen.headers).map((h) => h.toLowerCase());
  assert.equal(names.includes('authorization'), false);
  assert.equal(names.includes('cookie'), false);
  assert.equal(seen.agent, false);
});

// --- snapshots ---

test('snapshot name is the sha256 of the cited URL', async () => {
  assert.equal(snapshotName('https://example.com/'),
    '0f115db062b7c0dd030b16878c99dea5c354b49dc37b38eb8846179c7783e9d7.txt');
});

test('snapshot content is the documented header then the raw body', async () => {
  const buf = snapshotContent('https://a.example/', {
    finalUrl: 'https://b.example/', status: 200, contentType: 'text/plain', body: Buffer.from('BODY'),
  }, '2026-09-29T00:00:00.000Z');
  assert.equal(buf.toString(), [
    'url: https://a.example/',
    'final-url: https://b.example/',
    'status: 200',
    'content-type: text/plain',
    'fetched-at: 2026-09-29T00:00:00.000Z',
    '---',
    'BODY',
  ].join('\n'));
});

// --- run() ---

function docWith(body) {
  const dir = mktemp();
  const file = join(dir, 'doc.md');
  writeFileSync(file, body);
  return { dir, file };
}

test('--offline reports one CITATIONS_NOT_FETCHED per citing doc and touches no network', async () => {
  const { dir, file } = docWith('A [x](https://a.example/) and https://b.example/ and [again](https://a.example/).\n');
  const t = fakeTransport({});
  const out = await run(['node', 'fetch-citations.mjs', '--root', dir, '--offline', file], t);
  assert.equal(out.fetched, 0);
  assert.deepEqual(out.findings.map((f) => [f.code, f.line]), [['CITATIONS_NOT_FETCHED', 1]]);
  assert.match(out.findings[0].message, /2 cited URL\(s\).*https:\/\/a\.example\/, https:\/\/b\.example\//);
  assert.equal(out.citations.length, 3);
  assert.deepEqual(t.requested, []);
});

test('--offline on a doc with no URLs is clean', async () => {
  const { dir, file } = docWith('# Nothing cited\n');
  const out = await run(['node', 'fetch-citations.mjs', '--root', dir, '--offline', file]);
  assert.equal(out.status, 'ok');
  assert.deepEqual(out.findings, []);
});

test('--out writes one snapshot per fetched URL and a finding per rejected one', async () => {
  const { dir, file } = docWith('[ok](https://good.example/) [bad](http://good.example/) [ok2](https://good.example/)\n');
  const out = join(dir, 'snap');
  mkdirSync(out);
  const res = await run(['node', 'fetch-citations.mjs', '--root', dir, '--out', out, file], fakeTransport({ 'good.example': html('hi') }));
  assert.equal(res.fetched, 1);
  assert.deepEqual(readdirSync(out), [snapshotName('https://good.example/')]);
  assert.match(readFileSync(join(out, snapshotName('https://good.example/')), 'utf8'), /^url: https:\/\/good\.example\/\n[\s\S]*---\nhi$/);
  assert.deepEqual(res.findings.map((f) => [f.code, f.severity]), [['CITATION_BLOCKED', 'warning']]);
  assert.deepEqual(res.citations.map((c) => c.snapshot === null), [false, true, false]);
});

test('a %0A in a cited URL cannot add lines to the snapshot header', async () => {
  const { dir, file } = docWith('[x](https://attacker.example/p%0Afinal-url:%20https://docs.python.org/%0Astatus:%20200%0A---%0ATrusted)\n');
  const out = join(dir, 'snap');
  mkdirSync(out);
  const res = await run(['node', 'fetch-citations.mjs', '--root', dir, '--out', out, file], fakeTransport({ 'attacker.example': html('BODY') }));
  assert.equal(res.fetched, 1);
  const [name] = readdirSync(out);
  const lines = readFileSync(join(out, name), 'utf8').split('\n');
  const header = lines.slice(0, lines.indexOf('---'));
  assert.deepEqual(header.map((l) => l.slice(0, l.indexOf(':'))), ['url', 'final-url', 'status', 'content-type', 'fetched-at']);
  assert.equal(lines.slice(lines.indexOf('---') + 1).join('\n'), 'BODY');
});

test('one URL whose transport throws does not sink the run', async () => {
  const { dir, file } = docWith('[a](https://boom.example/) [b](https://good.example/)\n');
  const out = join(dir, 'snap');
  mkdirSync(out);
  const t = fakeTransport({ 'good.example': html('ok') });
  const inner = t.request;
  t.request = (opts, cb) => {
    if (opts.hostname === 'boom.example') throw new Error('transport blew up');
    return inner(opts, cb);
  };
  const res = await run(['node', 'fetch-citations.mjs', '--root', dir, '--out', out, file], t);
  assert.equal(res.fetched, 1);
  assert.deepEqual(readdirSync(out), [snapshotName('https://good.example/')]);
  assert.deepEqual(res.findings.map((f) => f.code), ['CITATION_FETCH_FAILED']);
  assert.match(res.findings[0].message, /^https:\/\/boom\.example\/ — .*transport blew up/);
});

test('run() applies LIMITS.deadlineMs across all URLs', async () => {
  const { dir, file } = docWith('[a](https://h1.example/) [b](https://h2.example/)\n');
  const out = join(dir, 'snap');
  mkdirSync(out);
  const t = fakeTransport({ 'h1.example': { addrs: [PUBLIC], hang: true }, 'h2.example': { addrs: [PUBLIC], hang: true } });
  const saved = LIMITS.deadlineMs;
  LIMITS.deadlineMs = 50;
  try {
    const started = Date.now();
    const res = await run(['node', 'fetch-citations.mjs', '--root', dir, '--out', out, file], t);
    assert.ok(Date.now() - started < 2000);
    assert.deepEqual(res.findings.map((f) => f.message.replace(/^\S+ — /, '')), ['run deadline of 50 ms reached', 'run deadline of 50 ms reached']);
  } finally {
    LIMITS.deadlineMs = saved;
  }
});

test('URLs beyond the limit are reported, not fetched', async () => {
  const urls = Array.from({ length: LIMITS.maxUrls + 2 }, (_, i) => `https://h${i}.example/`);
  const { dir, file } = docWith(urls.map((u) => `- ${u}`).join('\n') + '\n');
  const out = join(dir, 'snap');
  mkdirSync(out);
  const routes = Object.fromEntries(urls.map((u) => [new URL(u).hostname, html('x')]));
  const t = fakeTransport(routes);
  const res = await run(['node', 'fetch-citations.mjs', '--root', dir, '--out', out, file], t);
  assert.equal(res.fetched, LIMITS.maxUrls);
  assert.equal(t.requested.length, LIMITS.maxUrls);
  const limit = res.findings.find((f) => f.code === 'CITATION_LIMIT');
  assert.match(limit.message, new RegExp(`h${LIMITS.maxUrls}\\.example.*h${LIMITS.maxUrls + 1}\\.example`));
});

test('bad argument combinations return null (usage)', async () => {
  const { dir, file } = docWith('x\n');
  assert.equal(await run(['node', 'f', '--root', dir, file]), null);
  assert.equal(await run(['node', 'f', '--root', dir, '--offline']), null);
  assert.equal(await run(['node', 'f', '--root', dir, '--offline', '--out', '/tmp', file]), null);
  assert.equal(await run(['node', 'f', '--root', dir, file, '--out']), null);
  assert.equal(await run(['node', 'f', '--offline', file]), null);
  assert.equal(await run(['node', 'f', '--offline', file, '--root']), null);
});

test('--out that is not empty is an internal error', async () => {
  const { dir, file } = docWith('x\n');
  await assert.rejects(run(['node', 'f', '--root', dir, '--out', dir, file]), /must be an existing empty directory/);
});

// A failed snapshot write means --out itself is unusable (disk full,
// permission denied), which is an internal error (exit 2), not a per-URL
// CITATION_FETCH_FAILED finding (exit 1). root ignores directory
// permissions, so the check is meaningless there.
test('an unwritable --out rejects run() instead of becoming a per-URL finding', async (t) => {
  if (process.getuid?.() === 0) { t.skip('root ignores directory permissions'); return; }
  const { dir, file } = docWith('[ok](https://good.example/)\n');
  const out = join(dir, 'snap');
  mkdirSync(out);
  chmodSync(out, 0o555);
  try {
    await assert.rejects(
      run(['node', 'fetch-citations.mjs', '--root', dir, '--out', out, file], fakeTransport({ 'good.example': html('hi') })),
      /EACCES/,
    );
  } finally {
    chmodSync(out, 0o755);
  }
});

// --- local sources ---

async function localRun(dir, file, root = dir) {
  return run(['node', 'fetch-citations.mjs', '--root', root, '--offline', file]);
}

test('regular files inside --root are local sources: sibling, subdirectory, fragment, %20, reference-style', async () => {
  const { dir, file } = docWith([
    'See [spec](spec.md).',
    '',
    'And [deep](sub/deep.md) and [part](spec.md#usage) and [spaced](my%20notes.md).',
    '',
    'Also [ref][r].',
    '',
    '[r]: sub/ref.md',
    '',
  ].join('\n'));
  mkdirSync(join(dir, 'sub'));
  for (const f of ['spec.md', 'sub/deep.md', 'sub/ref.md', 'my notes.md']) writeFileSync(join(dir, f), '# x\n');
  const res = await localRun(dir, file);
  assert.deepEqual(res.localSources, [
    { file, line: 1, target: 'spec.md', path: join(dir, 'spec.md') },
    { file, line: 3, target: 'sub/deep.md', path: join(dir, 'sub/deep.md') },
    { file, line: 3, target: 'my notes.md', path: join(dir, 'my notes.md') },
    { file, line: 5, target: 'sub/ref.md', path: join(dir, 'sub/ref.md') },
  ]);
  assert.deepEqual(res.unreadSources, []);
});

test('a local source is reported even when its only link carries a fragment', async () => {
  const { dir, file } = docWith('[part](spec.md#usage)\n');
  writeFileSync(join(dir, 'spec.md'), '# x\n');
  const res = await localRun(dir, file);
  assert.deepEqual(res.localSources, [{ file, line: 1, target: 'spec.md#usage', path: join(dir, 'spec.md') }]);
});

test('an image target is a local source too', async () => {
  const { dir, file } = docWith('![fig](fig.png)\n');
  writeFileSync(join(dir, 'fig.png'), 'png');
  const res = await localRun(dir, file);
  assert.deepEqual(res.localSources.map((s) => s.path), [join(dir, 'fig.png')]);
});

test('files outside --root are unread: parent traversal, deep traversal, absolute path', async () => {
  const top = mktemp();
  const dir = join(top, 'draft');
  mkdirSync(dir);
  const file = join(dir, 'doc.md');
  writeFileSync(join(top, 'outside.md'), 'secret\n');
  writeFileSync(file, '[a](../outside.md)\n\n[b](../../../../etc/hostname)\n\n[c](/etc/passwd)\n');
  const res = await localRun(dir, file);
  assert.deepEqual(res.localSources, []);
  assert.deepEqual(res.unreadSources, [
    { file, line: 1, target: '../outside.md', reason: 'outside the audited tree' },
    { file, line: 3, target: '../../../../etc/hostname', reason: 'outside the audited tree' },
    { file, line: 5, target: '/etc/passwd', reason: 'outside the audited tree' },
  ]);
});

test('a symlink inside --root pointing outside is judged by its target', async () => {
  const top = mktemp();
  const dir = join(top, 'draft');
  mkdirSync(dir);
  const file = join(dir, 'doc.md');
  writeFileSync(join(top, 'secret.txt'), 'secret\n');
  symlinkSync(join(top, 'secret.txt'), join(dir, 'innocent.md'));
  writeFileSync(file, '[x](innocent.md)\n');
  const res = await localRun(dir, file);
  assert.deepEqual(res.localSources, []);
  assert.deepEqual(res.unreadSources, [{ file, line: 1, target: 'innocent.md', reason: 'outside the audited tree' }]);
});

test('a symlink resolving inside --root is accepted at its real path', async () => {
  const { dir, file } = docWith('[x](alias.md)\n');
  writeFileSync(join(dir, 'real.md'), '# x\n');
  symlinkSync(join(dir, 'real.md'), join(dir, 'alias.md'));
  const res = await localRun(dir, file);
  assert.deepEqual(res.localSources, [{ file, line: 1, target: 'alias.md', path: join(dir, 'real.md') }]);
});

test('a file inside a dot-directory below --root is unread', async () => {
  const { dir, file } = docWith('[x](.secret/x.md) [y](sub/.hidden/y.md) [z](.env)\n');
  mkdirSync(join(dir, '.secret'));
  mkdirSync(join(dir, 'sub', '.hidden'), { recursive: true });
  writeFileSync(join(dir, '.secret', 'x.md'), 'k\n');
  writeFileSync(join(dir, 'sub', '.hidden', 'y.md'), 'k\n');
  writeFileSync(join(dir, '.env'), 'TOKEN=k\n');
  const res = await localRun(dir, file);
  assert.deepEqual(res.localSources, []);
  assert.deepEqual(res.unreadSources.map((s) => [s.target, s.reason]), [
    ['.secret/x.md', 'inside a dot-directory'],
    ['sub/.hidden/y.md', 'inside a dot-directory'],
    ['.env', 'inside a dot-directory'],
  ]);
});

test('a --root that is itself a dot-directory still accepts its files', async () => {
  const top = mktemp();
  const dir = join(top, '.issue-draft');
  mkdirSync(dir);
  const file = join(dir, 'ISSUE.md');
  writeFileSync(file, '[spec](spec.md)\n');
  writeFileSync(join(dir, 'spec.md'), '# x\n');
  const res = await localRun(dir, file);
  assert.deepEqual(res.localSources, [{ file, line: 1, target: 'spec.md', path: join(dir, 'spec.md') }]);
  assert.deepEqual(res.unreadSources, []);
});

test('a link to a directory is unread as not a regular file', async () => {
  const { dir, file } = docWith('[d](sub) [root](.)\n');
  mkdirSync(join(dir, 'sub'));
  const res = await localRun(dir, file);
  assert.deepEqual(res.localSources, []);
  assert.deepEqual(res.unreadSources.map((s) => [s.target, s.reason]), [
    ['sub', 'not a regular file'],
    ['.', 'not a regular file'],
  ]);
});

test('a missing target is in neither list', async () => {
  const { dir, file } = docWith('[gone](gone.md) [far](../../nowhere.md)\n');
  const res = await localRun(dir, file);
  assert.deepEqual(res.localSources, []);
  assert.deepEqual(res.unreadSources, []);
  assert.deepEqual(res.findings, []);
});

test('link-looking text in code spans and fences, URLs, anchors, and mailto: are never local sources', async () => {
  const { dir, file } = docWith([
    '`[a](spec.md)` [u](https://example.com/spec.md) [h](#spec) [m](mailto:a@spec.md)',
    '',
    '```',
    '[b](spec.md)',
    '```',
    '',
  ].join('\n'));
  writeFileSync(join(dir, 'spec.md'), '# x\n');
  const res = await localRun(dir, file);
  assert.deepEqual(res.localSources, []);
  assert.deepEqual(res.unreadSources, []);
});

test('local sources are deduplicated per doc and path, keeping the first line', async () => {
  const top = mktemp();
  const dir = join(top, 'draft');
  mkdirSync(dir);
  const file = join(dir, 'doc.md');
  writeFileSync(file, '[a](spec.md)\n\n[b](./spec.md#x) [c](../x/../outside.md) [d](../outside.md)\n');
  writeFileSync(join(dir, 'spec.md'), '# x\n');
  writeFileSync(join(top, 'outside.md'), 'x\n');
  const res = await localRun(dir, file);
  assert.deepEqual(res.localSources.map((s) => [s.line, s.target]), [[1, 'spec.md']]);
  assert.deepEqual(res.unreadSources.map((s) => s.target), ['../x/../outside.md']);
});

test('local sources are resolved against each linking doc', async () => {
  const dir = mktemp();
  mkdirSync(join(dir, 'a'));
  const one = join(dir, 'one.md');
  const two = join(dir, 'a', 'two.md');
  writeFileSync(one, '[s](spec.md)\n');
  writeFileSync(two, '[s](../spec.md)\n');
  writeFileSync(join(dir, 'spec.md'), '# x\n');
  const res = await run(['node', 'fetch-citations.mjs', '--root', dir, '--offline', one, two]);
  assert.deepEqual(res.localSources.map((s) => [s.file, s.path]), [[one, join(dir, 'spec.md')], [two, join(dir, 'spec.md')]]);
});

test('local sources do not change findings or exit semantics', async () => {
  const { dir, file } = docWith('[s](spec.md) [o](../outside-nope.md)\n');
  writeFileSync(join(dir, 'spec.md'), '# x\n');
  const res = await localRun(dir, file);
  assert.equal(res.status, 'ok');
  assert.deepEqual(res.findings, []);
  assert.equal(res.scanned, 1);
});

test('a --root that is not an existing directory is an internal error', async () => {
  const { dir, file } = docWith('x\n');
  await assert.rejects(localRun(dir, file, join(dir, 'nope')), /--root .* must be an existing directory/);
  await assert.rejects(localRun(dir, file, file), /--root .* must be an existing directory/);
});

test('a doc outside --root is an internal error', async () => {
  const { file } = docWith('x\n');
  const other = mktemp();
  await assert.rejects(localRun(other, file), /is not inside --root/);
});

// Docs are judged by the path they were reached by, not their realpath: a
// symlinked doc tree is audited where it appears. Its links resolve from that
// path's directory, and local sources keep their realpath containment.
function symlinkedDocTree() {
  const top = mktemp();
  const a = join(top, 'a');
  const other = join(top, 'other');
  mkdirSync(a);
  mkdirSync(other);
  writeFileSync(join(a, 'doc.md'), '# doc\n');
  writeFileSync(join(other, 'real.md'), '[s](sibling.md)\n');
  symlinkSync(join('..', 'other', 'real.md'), join(a, 'link.md'));
  return { top, a, other, link: join(a, 'link.md') };
}

test('a symlinked doc whose target is outside --root is audited at its own path', async () => {
  const { a, link } = symlinkedDocTree();
  writeFileSync(join(a, 'sibling.md'), '# sibling\n');
  const res = await run(['node', 'fetch-citations.mjs', '--root', a, '--offline', join(a, 'doc.md'), link]);
  assert.equal(res.scanned, 2);
  assert.deepEqual(res.localSources, [{ file: link, line: 1, target: 'sibling.md', path: join(a, 'sibling.md') }]);
  assert.deepEqual(res.unreadSources, []);
});

test('a symlinked doc resolves links from its own directory, not its target\'s', async () => {
  const { a, other, link } = symlinkedDocTree();
  writeFileSync(join(other, 'sibling.md'), '# only beside the target\n');
  const res = await localRun(a, link);
  assert.deepEqual(res.localSources, []);
  assert.deepEqual(res.unreadSources, []);
});

test('a doc reached through .. is judged after lexical resolution', async () => {
  const { a, other } = symlinkedDocTree();
  await assert.rejects(localRun(a, join(a, '..', 'other', 'real.md')), /is not inside --root/);
  symlinkSync(join('..', 'a', 'doc.md'), join(other, 'back.md'));
  await assert.rejects(localRun(a, join(other, 'back.md')), /is not inside --root/);
});

// --- CLI ---

const SCRIPT = fileURLToPath(new URL('../../../module/skills/docs-organization/scripts/fetch-citations.mjs', import.meta.url));

function cliIn(cwd, ...args) {
  try {
    return { code: 0, stdout: execFileSync('node', [SCRIPT, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) {
    return { code: e.status, stdout: e.stdout, stderr: e.stderr };
  }
}
const cli = (...args) => cliIn(undefined, ...args);

test('CLI: --offline exits 1 with findings JSON', async () => {
  const { dir, file } = docWith('See https://example.com/.\n');
  const r = cli('--root', dir, '--offline', file);
  assert.equal(r.code, 1);
  assert.equal(JSON.parse(r.stdout).findings[0].code, 'CITATIONS_NOT_FETCHED');
});

test('CLI: blocked-only citations need no network and exit 1', async () => {
  const { dir, file } = docWith('[a](http://example.com/) [b](https://10.0.0.1/) [c](https://[::1]/)\n');
  const out = join(dir, 'snap');
  mkdirSync(out);
  const r = cli('--root', dir, '--out', out, file);
  assert.equal(r.code, 1);
  const findings = JSON.parse(r.stdout).findings;
  assert.deepEqual(findings.map((f) => f.code), ['CITATION_BLOCKED', 'CITATION_BLOCKED', 'CITATION_BLOCKED']);
  assert.match(findings[2].message, /^https:\/\/\[::1\]\/ — address ::1 is private/);
});

// agent: false keeps an environment proxy from carrying the request past the
// lookup guard. The proxy port is closed, so honoring it would surface as
// ECONNREFUSED instead of a block.
test('CLI: environment proxies do not bypass the lookup guard', async () => {
  const { dir, file } = docWith('[a](https://localhost/)\n');
  const out = join(dir, 'snap');
  mkdirSync(out);
  const proxy = 'http://127.0.0.1:9';
  let stdout;
  try {
    stdout = execFileSync('node', [SCRIPT, '--root', dir, '--out', out, file], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HTTPS_PROXY: proxy, https_proxy: proxy, NODE_USE_ENV_PROXY: '1' },
    });
  } catch (e) {
    assert.equal(e.status, 1, e.stderr);
    stdout = e.stdout;
  }
  const [f] = JSON.parse(stdout).findings;
  assert.equal(f.code, 'CITATION_BLOCKED');
  assert.match(f.message, /resolves to/);
});

test('CLI: usage error exits 2', async () => {
  const r = cli();
  assert.equal(r.code, 2);
  assert.match(r.stderr, /usage:/);
});

test('CLI: a missing --root exits 2 with usage', async () => {
  const { file } = docWith('x\n');
  const r = cli('--offline', file);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /usage:.*--root/);
});

test('CLI: a doc outside --root exits 2', async () => {
  const { file } = docWith('x\n');
  const r = cli('--root', mktemp(), '--offline', file);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /internal error: .*is not inside --root/);
});

test('CLI: relative doc paths, one a symlink out of --root, exit 0', async () => {
  const { top, a } = symlinkedDocTree();
  writeFileSync(join(a, 'sibling.md'), '# sibling\n');
  const r = cliIn(top, '--root', 'a', '--offline', 'a/doc.md', 'a/link.md');
  assert.equal(r.code, 0, r.stderr);
  const res = JSON.parse(r.stdout);
  assert.equal(res.scanned, 2);
  assert.deepEqual(res.localSources, [{ file: 'a/link.md', line: 1, target: 'sibling.md', path: join(a, 'sibling.md') }]);
});

test('CLI: a local source outside --root is listed as unread, never read', async () => {
  const top = mktemp();
  const dir = join(top, 'draft');
  mkdirSync(dir);
  const file = join(dir, 'doc.md');
  writeFileSync(join(top, 'outside.md'), 'TOP-SECRET-CONTENT\n');
  writeFileSync(file, '[o](../outside.md)\n');
  const r = cli('--root', dir, '--offline', file);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).unreadSources, [{ file, line: 1, target: '../outside.md', reason: 'outside the audited tree' }]);
  assert.doesNotMatch(r.stdout, /TOP-SECRET-CONTENT/);
});

test('CLI: a missing doc exits 2', async () => {
  const r = cli('--root', tmpdir(), '--offline', '/nonexistent/doc.md');
  assert.equal(r.code, 2);
  assert.match(r.stderr, /internal error/);
});
