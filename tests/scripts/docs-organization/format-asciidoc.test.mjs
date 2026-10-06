import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import asciidoc from '../../../module/skills/docs-organization/scripts/formats/asciidoc.mjs';

const ADAPTER = fileURLToPath(new URL('../../../module/skills/docs-organization/scripts/formats/asciidoc.mjs', import.meta.url));
const parse = (src) => asciidoc.parse(src);
const refs = (m) => m.links.map(({ kind, target, line, bare }) => [kind, target, line, bare]);

test('declares its extensions and README names', () => {
  assert.deepEqual(asciidoc.extensions, ['.adoc', '.asciidoc']);
  assert.deepEqual(asciidoc.readmeNames, ['README.adoc', 'README.asciidoc']);
});

test('headings: document title is level 1, == is level 2, discrete headings count', async () => {
  const m = await parse('= Title\n:toc:\n\n== Two\n\n[discrete]\n=== Floating\n\n==== Four\n');
  assert.deepEqual(m.headings, [
    { level: 1, line: 1, title: 'Title' },
    { level: 2, line: 4, title: 'Two' },
    { level: 3, line: 7, title: 'Floating' },
    { level: 4, line: 9, title: 'Four' },
  ]);
});

test('a document without a header has no level-1 heading', async () => {
  const m = await parse('Just a paragraph.\n\n== Section\n');
  assert.deepEqual(m.headings, [{ level: 2, line: 3, title: 'Section' }]);
});

test('paragraph context: top, quote block, [quote] paragraph, admonitions, list attachment', async () => {
  const src = [
    'Top paragraph.',      // 1
    '',
    '____',                // 3
    'Quoted block.',       // 4
    '____',
    '',
    '[quote]',             // 7
    'Quoted paragraph.',   // 8
    '',
    'NOTE: Inline note.',  // 10
    '',
    '[TIP]',               // 12
    '====',                // 13
    'Compound tip.',       // 14
    '====',
    '',
    '* item',              // 17
    '+',
    'Attached paragraph.', // 19
    '',
  ].join('\n');
  const m = await parse(src);
  assert.deepEqual(m.paragraphs.map(({ line, context }) => [line, context]), [
    [1, 'top'], [4, 'quote'], [8, 'quote'], [10, 'callout'], [14, 'callout'], [19, 'list'],
  ]);
});

test('list items: own text with continuation lines, nesting, and description lists', async () => {
  // A paragraph separates the lists: AsciiDoc nests an adjacent list of a
  // different kind inside the previous list's last item.
  const m = await parse('* outer link:a.adoc[A]\ncontinued\n** inner\n* flat\n\nBetween.\n\nterm:: definition text\n');
  assert.deepEqual(m.listItems.map(({ line, text, hasNestedList }) => [line, text, hasNestedList]), [
    [1, 'outer link:a.adoc[A]\ncontinued', true],
    [3, 'inner', false],
    [4, 'flat', false],
    [8, 'definition text', false],
  ]);
});

test('references: link, xref, <<>>, inline and block image, URL macro, bare URL, mailto ignored', async () => {
  const src = [
    'See link:doc.adoc[Doc] and xref:other.adoc#sec[Other].',     // 1
    'Also <<local-id>>, <<guide#intro,Guide>>, and <<ref.adoc>>.', // 2
    'Inline image:icon.png[] and https://site.example[Site].',     // 3
    'Bare https://bare.example/path. and mailto:me@example.com[].', // 4
    '',
    'image::diagram.png[Alt]',                                      // 6
  ].join('\n');
  assert.deepEqual(refs(await parse(src)), [
    ['link', 'doc.adoc', 1, false],
    ['xref', 'other.adoc#sec', 1, false],
    ['xref', '#local-id', 2, false],
    ['xref', 'guide.adoc#intro', 2, false],
    ['xref', 'ref.adoc', 2, false],
    ['image', 'icon.png', 3, false],
    ['link', 'https://site.example', 3, false],
    ['link', 'https://bare.example/path', 4, true],
    ['image', 'diagram.png', 6, false],
  ]);
});

test('include:: is an include reference and its target is never read (secure mode)', async () => {
  const m = await parse('Before.\n\ninclude::/etc/passwd[]\n\ninclude::partials/part.adoc[]\n');
  assert.deepEqual(refs(m), [
    ['include', '/etc/passwd', 3, false],
    ['include', 'partials/part.adoc', 5, false],
  ]);
  assert.ok(!m.paragraphs.some((p) => /root:/.test(p.text)), 'include target content must never appear');
  assert.deepEqual(m.diagnostics, []);
});

test('{attribute} references resolve in targets; an undefined one drops the reference', async () => {
  const m = await parse('= T\n:base: https://ex.example\n:dir: guides/\n\nSee {base}/page and link:{dir}a.adoc[A] and link:{nope}b.adoc[B].\n');
  assert.deepEqual(refs(m), [
    ['link', 'https://ex.example/page', 5, true],
    ['link', 'guides/a.adoc', 5, false],
  ]);
});

test('escaped macros, code spans, passthroughs, comments, verbatim blocks, and excluded conditionals hold no references', async () => {
  const src = [
    'Escaped \\link:esc.adoc[] and `link:code.adoc[]` and +link:pass.adoc[]+.',
    '',
    '// link:comment.adoc[]',
    '',
    '----',
    'link:listing.adoc[]',
    '----',
    '',
    'ifdef::never-set[]',
    'link:hidden.adoc[]',
    'endif::[]',
  ].join('\n');
  assert.deepEqual((await parse(src)).links, []);
});

test('§ texts exclude macro text and share a block id with a link in the same paragraph', async () => {
  const m = await parse('See §3 in link:s.adoc[spec].\n\nAlone §4.\n');
  const sec3 = m.texts.find((t) => t.text.includes('§3'));
  const sec4 = m.texts.find((t) => t.text.includes('§4'));
  assert.equal(m.links[0].block, sec3.block);
  assert.notEqual(sec4.block, sec3.block);
  assert.ok(!m.texts.some((t) => t.text.includes('spec')));
});

test('table cells are scanned with their own lines', async () => {
  const m = await parse('|===\n| Name | Link\n\n| a | link:cell.adoc[]\n|===\n');
  assert.deepEqual(refs(m), [['link', 'cell.adoc', 4, false]]);
});

test('mermaid: [mermaid] literal and [source,mermaid] listing are swappable with exact offsets', async () => {
  const src = '= T\n\n[mermaid]\n....\nflowchart LR\n  A --> B\n....\n\n[source,mermaid]\n----\ngraph TD\n----\n';
  const m = await parse(src);
  assert.equal(m.diagrams.length, 2);
  const [a, b] = m.diagrams;
  assert.equal(a.startLine, 5);
  assert.equal(a.source, 'flowchart LR\n  A --> B');
  assert.equal(src.slice(a.blockStart, a.bodyStart), '....\n');
  assert.equal(src.slice(a.bodyStart, a.bodyEnd), 'flowchart LR\n  A --> B\n');
  assert.equal(a.swappable, true);
  assert.equal(b.startLine, 11);
  assert.equal(src.slice(b.bodyStart, b.bodyEnd), 'graph TD\n');
});

test('mermaid: a [mermaid] paragraph is found but not swappable', async () => {
  const [d] = (await parse('[mermaid]\ngraph LR\n  A --> B\n')).diagrams;
  assert.equal(d.startLine, 2);
  assert.equal(d.source, 'graph LR\n  A --> B');
  assert.equal(d.swappable, false);
});

test('an unterminated block runs to the end and is reported as a diagnostic', async () => {
  const src = 'Intro.\n\n[mermaid]\n----\ngraph LR\n';
  const m = await parse(src);
  assert.equal(m.diagrams[0].bodyEnd, src.length);
  assert.deepEqual(m.diagnostics, [{ line: 4, message: 'unterminated listing block' }]);
});

test('CRLF content: same lines as LF, offsets index the original bytes', async () => {
  const lf = '= T\n\n[mermaid]\n....\ngraph LR\n....\n';
  const crlf = lf.replace(/\n/g, '\r\n');
  const a = await parse(lf);
  const b = await parse(crlf);
  assert.deepEqual(b.headings, a.headings);
  assert.equal(b.diagrams[0].startLine, a.diagrams[0].startLine);
  assert.equal(crlf.slice(b.diagrams[0].bodyStart, b.diagrams[0].bodyEnd), 'graph LR\r\n');
});

test('parser warnings never reach stdout or stderr', () => {
  const script = `import a from ${JSON.stringify(ADAPTER)}; await a.parse('----\\nunterminated\\n');`;
  const r = execFileSync('node', ['--input-type=module', '-e', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(r, '');
});

test('a leading BOM does not shift headings or diagram offsets', async () => {
  const withBom = await parse('﻿= Title\n\n[mermaid]\n....\ngraph LR\n....\n');
  assert.deepEqual(withBom.headings, [{ level: 1, line: 1, title: 'Title' }]);
  assert.equal(withBom.diagrams.length, 1);
  const [d] = withBom.diagrams;
  assert.equal(d.startLine, 5);
  assert.equal(d.swappable, true);
  const src = '﻿= Title\n\n[mermaid]\n....\ngraph LR\n....\n';
  assert.equal(src.slice(d.bodyStart, d.bodyEnd), 'graph LR\n');
});

test('an excluded conditional inside a paragraph does not shift later lines', async () => {
  const m = await parse('L1 link:a.adoc[]\nifdef::nope[]\nL3 hidden\nendif::[]\nL5 link:b.adoc[]\n');
  assert.deepEqual(refs(m), [
    ['link', 'a.adoc', 1, false],
    ['link', 'b.adoc', 5, false],
  ]);
  assert.equal(m.paragraphs[0].line, 1);
});

test('an included conditional (kept content) reports every link on its true, straddled line', async () => {
  const m = await parse(':yes:\n\nL3 link:a.adoc[]\nifdef::yes[]\nL5 link:c.adoc[]\nendif::[]\nL7 link:b.adoc[]\n');
  assert.deepEqual(refs(m), [
    ['link', 'a.adoc', 3, false],
    ['link', 'c.adoc', 5, false],
    ['link', 'b.adoc', 7, false],
  ]);
  assert.equal(m.paragraphs[0].line, 3);
});

test('a conditional inside a list item is excluded from its text and does not shift the marker line', async () => {
  const m = await parse('* item\nifdef::nope[]\nhidden link:h.adoc[]\nendif::[]\n* next\n');
  assert.deepEqual(m.listItems.map(({ line, text }) => [line, text]), [
    [1, 'item'],
    [5, 'next'],
  ]);
  assert.deepEqual(refs(m), []);
});

test('escaped xref shorthand and escaped bare URL hold no references', async () => {
  const m = await parse('Esc \\<<id>> and \\https://e.example ok.\n');
  assert.deepEqual(m.links, []);
});

test('bare URLs: only ones wrapped in constrained formatting marks link; quoted ones never do', async () => {
  // Oracle (asciidoctor itself): only the *…* and _..._ wrapped URLs convert
  // to <a>; a straight-quoted URL never becomes a link (the quote pair is
  // consumed by quote substitution before macro/autolink detection runs).
  const src = `A *https://b.example* B _https://i.example_ C "https://q.example" D 'https://s.example'.\n`;
  const m = await parse(src);
  assert.deepEqual(refs(m), [
    ['link', 'https://b.example', 1, true],
    ['link', 'https://i.example', 1, true],
  ]);
});

test('a bare URL inside angle brackets drops the brackets from its target', async () => {
  const m = await parse('See <https://angle.example> ok.\n');
  assert.deepEqual(refs(m), [['link', 'https://angle.example', 1, true]]);
});

test('a bare URL in parentheses stops before the closing paren, even with an inner paren', async () => {
  const m = await parse('See (https://p.example/x) and (https://p.example/wiki/Foo_(bar)) done.\n');
  assert.deepEqual(refs(m), [
    ['link', 'https://p.example/x', 1, true],
    ['link', 'https://p.example/wiki/Foo_(bar', 1, true],
  ]);
});

test('a long run of non-whitespace after a bare URL parses in linear time', async () => {
  const src = 'Para https://a' + '.'.repeat(40000) + 'x\n';
  const start = Date.now();
  await parse(src);
  assert.ok(Date.now() - start < 500, `took ${Date.now() - start}ms`);
});

test('a block title line is scanned for references, not reported as a paragraph', async () => {
  const src = '.Title with link:bt.adoc[] here\n----\ncode\n----\n\n.Para title https://bt.example\nPara.\n';
  const m = await parse(src);
  assert.deepEqual(refs(m), [
    ['link', 'bt.adoc', 1, false],
    ['link', 'https://bt.example', 6, true],
  ]);
  assert.deepEqual(m.paragraphs.map((p) => p.line), [7]);
});

test('xref targets may contain spaces; link and image targets may not', async () => {
  const m = await parse('xref:my doc.adoc[Doc] and <<my doc.adoc#a,Doc>>.\n');
  assert.deepEqual(refs(m), [
    ['xref', 'my doc.adoc', 1, false],
    ['xref', 'my doc.adoc#a', 1, false],
  ]);
});

test('a paragraph that is only a rewritten include is not prose, but its include ref is kept', async () => {
  const m = await parse('Before\n\ninclude::part.adoc[]\n\nafter\n');
  assert.deepEqual(refs(m), [['include', 'part.adoc', 3, false]]);
  assert.deepEqual(m.paragraphs.map((p) => p.line), [1, 5]);
});

test('a raw include line inside a list item is an include ref, not item text', async () => {
  const m = await parse('* next\ninclude::part2.adoc[]\n');
  assert.deepEqual(m.listItems.map(({ line, text }) => [line, text]), [[1, 'next']]);
  assert.deepEqual(refs(m), [['include', 'part2.adoc', 2, false]]);
});

test('[mermaid] on an open block (--) is a diagram, not prose', async () => {
  const m = await parse('[mermaid]\n--\ngraph LR\n  A-->B\n--\n');
  assert.equal(m.diagrams.length, 1);
  assert.equal(m.diagrams[0].source, 'graph LR\n  A-->B');
  assert.equal(m.diagrams[0].swappable, true);
  assert.equal(m.paragraphs.length, 0);
});

test('swappable is false when the raw diagram body holds a directive or include line', async () => {
  const cond = await parse('[mermaid]\n----\ngraph LR\nifdef::x[]\nA-->B\nendif::[]\n----\n');
  assert.equal(cond.diagrams[0].swappable, false);
  const inc = await parse('[mermaid]\n----\ngraph LR\ninclude::part.mmd[]\n----\n');
  assert.equal(inc.diagrams[0].swappable, false);
});

test('link::dbl.adoc[] is not a link: only image takes a block double-colon form', async () => {
  const m = await parse('See link::dbl.adoc[] ok.\n');
  assert.deepEqual(m.links, []);
});

test('image::blk.png[] in the middle of a paragraph is not an inline image', async () => {
  const m = await parse('icon image:i.png[] and image::blk.png[] inline.\n');
  assert.deepEqual(refs(m), [['image', 'i.png', 1, false]]);
});

test('callout list item markers <1> and <.> are stripped from the item text', async () => {
  const m = await parse('----\ncode <1>\n----\n<1> first callout\n<.> second callout\n');
  assert.deepEqual(m.listItems.map(({ line, text }) => [line, text]), [
    [4, 'first callout'],
    [5, 'second callout'],
  ]);
});

// --- excludedLines: one explicit model of which raw lines the preprocessor
// drops, instead of guessing from regex matches against possibly-duplicated
// text. ---

test('alignment is not fooled by a duplicate of the first line sitting inside an excluded conditional', async () => {
  const m = await parse('x link:x.adoc[]\nifdef::nope[]\nx link:x.adoc[]\nendif::[]\ntail link:t.adoc[]\n');
  assert.deepEqual(refs(m), [
    ['link', 'x.adoc', 1, false],
    ['link', 't.adoc', 5, false],
  ]);
  assert.equal(m.paragraphs[0].line, 1);
});

test('alignment is not fooled by a hidden copy of a later line sitting inside an excluded conditional', async () => {
  const m = await parse('a link:a.adoc[]\nifdef::nope[]\nb link:b.adoc[]\nendif::[]\nb link:b.adoc[]\n');
  assert.deepEqual(refs(m), [
    ['link', 'a.adoc', 1, false],
    ['link', 'b.adoc', 5, false],
  ]);
});

test('nested conditionals with no duplicate text still resolve correctly (regression guard)', async () => {
  const m = await parse(':y:\n\nL3 link:a.adoc[]\nifdef::y[]\nL5 link:b.adoc[]\nifdef::nope[]\nL7 hidden\nendif::nope[]\nL9 link:c.adoc[]\nendif::y[]\nL11 link:d.adoc[]\n');
  assert.deepEqual(refs(m), [
    ['link', 'a.adoc', 3, false],
    ['link', 'b.adoc', 5, false],
    ['link', 'c.adoc', 9, false],
    ['link', 'd.adoc', 11, false],
  ]);
});

test('an endif::[] line is never mistaken for a dlist term, even directly inside an excluded conditional', async () => {
  const m = await parse('term:: L1 def\nifdef::nope[]\nhidden\nendif::[]\nterm2:: L5 def2 link:d2.adoc[]\n');
  assert.deepEqual(m.listItems.map(({ line, text }) => [line, text]), [
    [1, 'L1 def'],
    [5, 'L5 def2 link:d2.adoc[]'],
  ]);
  assert.deepEqual(refs(m), [['link', 'd2.adoc', 5, false]]);
});

test('a directive line before a dlist item does not shift its line (regression guard)', async () => {
  const m = await parse('ifdef::nope[]\nhid:: x\nendif::[]\nterm:: L4 def link:d.adoc[]\n');
  assert.deepEqual(m.listItems.map(({ line, text }) => [line, text]), [[4, 'L4 def link:d.adoc[]']]);
});

test('a conditional wrapping a whole list item does not make the hidden item the nearest marker', async () => {
  const m = await parse('* L1 a\nifdef::nope[]\n* L3 hidden\nendif::[]\n* L5 b link:b.adoc[]\n');
  assert.deepEqual(m.listItems.map(({ line, text }) => [line, text]), [
    [1, 'L1 a'],
    [5, 'L5 b link:b.adoc[]'],
  ]);
  assert.deepEqual(refs(m), [['link', 'b.adoc', 5, false]]);
});

test('ifeval content is treated as kept: a true expression is reported at its true, straddled line', async () => {
  const m = await parse('* L1 item\nifeval::[1 == 1]\nL3 shown link:s.adoc[]\nendif::[]\n* L5 next link:n.adoc[]\n');
  assert.deepEqual(m.listItems.map(({ line, text }) => [line, text]), [
    [1, 'L1 item\nL3 shown link:s.adoc[]'],
    [5, 'L5 next link:n.adoc[]'],
  ]);
  assert.deepEqual(refs(m), [
    ['link', 's.adoc', 3, false],
    ['link', 'n.adoc', 5, false],
  ]);
});

test('ifeval content is treated as kept even when the expression is actually false (documented over-approximation)', async () => {
  // We do not evaluate ifeval expressions; over-reporting a reference beats
  // silently losing one that a real evaluation would have kept.
  const m = await parse('* L1 item link:a.adoc[]\nifeval::[1 == 2]\nL3 hidden link:h.adoc[]\nendif::[]\n* L5 next link:n.adoc[]\n');
  assert.deepEqual(m.listItems.map(({ line, text }) => [line, text]), [
    [1, 'L1 item link:a.adoc[]\nL3 hidden link:h.adoc[]'],
    [5, 'L5 next link:n.adoc[]'],
  ]);
  assert.deepEqual(refs(m), [
    ['link', 'a.adoc', 1, false],
    ['link', 'h.adoc', 3, false],
    ['link', 'n.adoc', 5, false],
  ]);
});

// --- Includes: one raw-line pass, not the secure-mode rewrite. ---

test('include:: is found inside an example block, and the rewritten line is stripped from the paragraph text', async () => {
  const m = await parse('====\nL2 before link:b.adoc[]\ninclude::inc.adoc[]\nL4 after link:a.adoc[]\n====\n');
  assert.deepEqual(refs(m), [
    ['link', 'b.adoc', 2, false],
    ['include', 'inc.adoc', 3, false],
    ['link', 'a.adoc', 4, false],
  ]);
  assert.deepEqual(m.paragraphs.map((p) => [p.line, p.text]), [
    [2, 'L2 before link:b.adoc[]\nL4 after link:a.adoc[]'],
  ]);
});

test('include:: as the first line of a sidebar reports at its own line and is not leaked as paragraph text', async () => {
  const m = await parse('****\ninclude::inc.adoc[]\nL3 text link:t.adoc[]\n****\n');
  assert.deepEqual(refs(m), [
    ['include', 'inc.adoc', 2, false],
    ['link', 't.adoc', 3, false],
  ]);
  assert.deepEqual(m.paragraphs.map((p) => [p.line, p.text]), [[3, 'L3 text link:t.adoc[]']]);
});

test('include:: inside a [source] listing is reported at its own line', async () => {
  const m = await parse('[source,ruby]\n----\ninclude::../examples/missing.rb[]\n----\n');
  assert.deepEqual(refs(m), [['include', '../examples/missing.rb', 3, false]]);
});

test('include:: inside a literal (....) block is reported at its own line', async () => {
  const m = await parse('....\ninclude::out.txt[]\n....\n');
  assert.deepEqual(refs(m), [['include', 'out.txt', 2, false]]);
});

test('the same include:: target appearing twice is reported twice, at each of its own lines', async () => {
  const m = await parse('include::a.adoc[]\n\ninclude::a.adoc[]\nL4 link:z.adoc[]\n');
  assert.deepEqual(refs(m), [
    ['include', 'a.adoc', 1, false],
    ['include', 'a.adoc', 3, false],
    ['link', 'z.adoc', 4, false],
  ]);
  assert.deepEqual(m.paragraphs.map((p) => [p.line, p.text]), [[4, 'L4 link:z.adoc[]']]);
});

test('an include:: inside an excluded ifdef is not reported', async () => {
  const m = await parse('ifdef::nope[]\ninclude::hidden.adoc[]\nendif::[]\n');
  assert.deepEqual(m.links, []);
});

test('an include:: inside a //// comment block is not reported', async () => {
  const m = await parse('////\ninclude::hidden.adoc[]\n////\n\nAfter.\n');
  assert.deepEqual(m.links, []);
});

// --- Minors: block titles on every titled block kind; MAX_SPAN headroom. ---

test('a block title above a list is scanned; the list itself is unaffected', async () => {
  const m = await parse('.List title link:lt.adoc[]\n* L2 item link:i.adoc[]\n* L3 item\n');
  assert.deepEqual(refs(m), [
    ['link', 'lt.adoc', 1, false],
    ['link', 'i.adoc', 2, false],
  ]);
  assert.deepEqual(m.listItems.map(({ line, text }) => [line, text]), [
    [2, 'L2 item link:i.adoc[]'],
    [3, 'L3 item'],
  ]);
  assert.deepEqual(m.paragraphs, []);
});

test('a block title above a list survives an attribute line in between', async () => {
  const m = await parse('.Title https://t.example\n[square]\n* L3 item\n');
  assert.deepEqual(refs(m), [['link', 'https://t.example', 1, true]]);
  assert.deepEqual(m.listItems.map(({ line, text }) => [line, text]), [[3, 'L3 item']]);
});

test('a block title above a table is scanned', async () => {
  const m = await parse('.Tbl link:tt.adoc[]\n|===\n|a\n|===\n');
  assert.deepEqual(refs(m), [['link', 'tt.adoc', 1, false]]);
});

test('a block title above a dlist is scanned', async () => {
  const m = await parse('.DL link:dl.adoc[]\nterm:: def\n');
  assert.deepEqual(refs(m), [['link', 'dl.adoc', 1, false]]);
});

test('a link or xref attrlist/target up to MAX_SPAN is reported intact, not truncated', async () => {
  const longQuery = 'https://docs.google.com/document/d/1AbC/edit?usp=sharing&' + 'x'.repeat(560);
  const m = await parse(`See ${longQuery} end.\n`);
  assert.deepEqual(refs(m), [['link', longQuery, 1, true]]);
});

test('a bare URL longer than MAX_SPAN is dropped entirely, not truncated', async () => {
  const tooLong = 'https://a.example/' + 'x'.repeat(2500);
  const m = await parse(`Para ${tooLong} end.\n`);
  assert.deepEqual(m.links, []);
  assert.ok(!m.links.some((l) => tooLong.startsWith(l.target)), 'no truncated target is reported either');
});

test('a bare URL exactly within MAX_SPAN is reported intact', async () => {
  const intact = 'https://a.example/' + 'x'.repeat(580); // ~600 chars total
  const m = await parse(`Para ${intact} end.\n`);
  assert.deepEqual(refs(m), [['link', intact, 1, true]]);
});

test('an over-cap [text] span on a URL is dropped entirely, not degraded to a bare link', async () => {
  const huge = 'x'.repeat(2500);
  const m = await parse(`See https://u.example[${huge}] end.\n`);
  assert.deepEqual(m.links, []);
});

// --- Attribute tracking: excludedLines evaluates conditions against
// attribute entries seen so far in document order, not doc.getAttribute()
// (Asciidoctor restores header attributes after load, so a body entry is
// otherwise invisible). ---

test('a body-set attribute makes a later ifdef true: the include and both list-item lines are kept', async () => {
  const m = await parse('Intro.\n\n:x:\n\nifdef::x[]\ninclude::part.adoc[]\n\n* item link:a.adoc[]\ncontinued link:c.adoc[]\nendif::[]\n');
  assert.deepEqual(refs(m), [
    ['include', 'part.adoc', 6, false],
    ['link', 'a.adoc', 8, false],
    ['link', 'c.adoc', 9, false],
  ]);
});

test('a header attribute unset later in the body makes a subsequent ifdef false', async () => {
  const m = await parse('= T\n:x:\n\nIntro.\n\n:x!:\n\nifdef::x[]\ninclude::hidden.adoc[]\nendif::[]\n');
  assert.deepEqual(m.links, []);
});

test('a body-set attribute: the kept paragraph and its link land on their true line', async () => {
  const m = await parse('P\n\n:x:\n\nifdef::x[]\nIN link:a.adoc[]\nendif::[]\n');
  assert.deepEqual(refs(m), [['link', 'a.adoc', 6, false]]);
  assert.ok(m.paragraphs.some((p) => p.line === 6 && p.text === 'IN link:a.adoc[]'));
});

test('an attribute entry inside a listing block is literal text, not a real attribute', async () => {
  const m = await parse('----\n:x:\n----\n\nifdef::x[]\nIN link:a.adoc[]\nendif::[]\nOUT link:o.adoc[]\n');
  assert.deepEqual(refs(m), [['link', 'o.adoc', 8, false]]);
});

test('a single-line ifdef with true content does not corrupt the alignment of a later, unrelated identical target', async () => {
  const m = await parse(':y:\n\nA link:L3.adoc[]\nifdef::y[B link:L5.adoc[]]\nC link:L5.adoc[]\n');
  assert.deepEqual(refs(m), [
    ['link', 'L3.adoc', 3, false],
    ['link', 'L5.adoc', 5, false],
  ]);
});

// --- Sections, floating titles, and block images are realigned the same
// way paragraphs are. ---

test('a section heading wrapped by a kept conditional does not shift, and keeps its raw title text', async () => {
  const m = await parse('ifndef::env-github[]\n== Sec link:h.adoc[]\nendif::[]\n');
  assert.deepEqual(m.headings, [{ level: 2, line: 2, title: 'Sec link:h.adoc[]' }]);
  assert.deepEqual(refs(m), [['link', 'h.adoc', 2, false]]);
});

test('a block image wrapped by a kept conditional does not shift', async () => {
  const m = await parse('ifndef::env-github[]\nimage::pic.png[]\nendif::[]\n');
  assert.deepEqual(refs(m), [['image', 'pic.png', 2, false]]);
});

// --- Minors: table-cell realignment, comment blocks, diagram source. ---

test('a table cell after an excluded row does not shift', async () => {
  const m = await parse('|===\n| x\nifdef::nope[]\n| y\nendif::[]\n| z link:z.adoc[]\n|===\n');
  assert.deepEqual(refs(m), [['link', 'z.adoc', 6, false]]);
});

test('a conditional directive inside a //// comment block is not recognized as a directive', async () => {
  const m = await parse('////\nifdef::nope[]\n////\nA link:a.adoc[]\nendif::[]\n');
  assert.deepEqual(refs(m), [['link', 'a.adoc', 4, false]]);
  assert.ok(m.paragraphs.some((p) => p.line === 4 && p.text === 'A link:a.adoc[]'));
});

test('a rewritten include line inside a mermaid listing is stripped from the diagram source', async () => {
  const m = await parse('[mermaid]\n----\ngraph LR\ninclude::part.mmd[]\n----\n');
  assert.equal(m.diagrams.length, 1);
  assert.equal(m.diagrams[0].source, 'graph LR');
  assert.equal(m.diagrams[0].swappable, false);
});

// --- Round 4 regression: a multi-line cell's continuation sharing its raw
// line with the next cell's own marker must not be dropped. ---

test('a wrapped cell line sharing its raw line with the next cell is still reported, and its text kept', async () => {
  const m = await parse('|===\n| a | b\n\n| c link:L4.adoc[]\nwrapped link:L5.adoc[] | d\n|===\n');
  assert.deepEqual(refs(m), [
    ['link', 'L4.adoc', 4, false],
    ['link', 'L5.adoc', 5, false],
  ]);
  assert.ok(m.texts.some((t) => t.text.includes('wrapped')));
});

test('a three-line wrapped cell followed by another cell on its last line realigns every line', async () => {
  const m = await parse('[cols="2"]\n|===\n| one link:L3.adoc[]\ntwo link:L4.adoc[]\nthree link:L5.adoc[] | x\n|===\n');
  assert.deepEqual(refs(m), [
    ['link', 'L3.adoc', 3, false],
    ['link', 'L4.adoc', 4, false],
    ['link', 'L5.adoc', 5, false],
  ]);
});

// --- Round 4 minors: a cell's own first line resolved by forward content
// search from the keptLineAt guess. ---

test('a cell whose content starts on the line after its own bare | marker is found by forward search', async () => {
  const m = await parse('[cols="1"]\n|===\n|\nbody link:x[]\n|===\n');
  assert.deepEqual(refs(m), [['link', 'x', 4, false]]);
});

test('a // line comment before a table row does not shift the cell after it', async () => {
  const m = await parse('|===\n// note\n| a link:x[]\n|===\n');
  assert.deepEqual(refs(m), [['link', 'x', 3, false]]);
});

test('a CSV-format table cell is found even though its row has no | separator', async () => {
  const m = await parse('[%header,format=csv]\n|===\nh1,h2\nlink:x[],b\n|===\n');
  assert.deepEqual(refs(m), [['link', 'x', 4, false]]);
});

// --- Round 6: a second cell on the same raw line must not search past the
// table looking for a line that is actually a prefix match on its own row.

test('a second cell on the same raw line as the first does not search past the table for a later identical line', async () => {
  const m = await parse('[cols="2"]\n|===\n| x | Yes link:y.adoc[]\n| z | No\n|===\n\nYes link:y.adoc[] indeed.\n');
  assert.deepEqual(refs(m), [
    ['link', 'y.adoc', 3, false],
    ['link', 'y.adoc', 7, false],
  ]);
});

test('a second cell is never confused with identical prose after the table', async () => {
  const m = await parse('|===\n| x | See link:a.adoc[]\n|===\n\nSee link:a.adoc[] for more.\n');
  assert.deepEqual(refs(m), [
    ['link', 'a.adoc', 2, false],
    ['link', 'a.adoc', 5, false],
  ]);
});

test('a second cell keeps its own line even when a near-duplicate text wraps into a later row', async () => {
  const m = await parse('[cols="2"]\n|===\n| a | b link:L3.adoc[]\n| c\na b link:L5.adoc[] | d\n|===\n');
  assert.deepEqual(refs(m), [
    ['link', 'L3.adoc', 3, false],
    ['link', 'L5.adoc', 5, false],
  ]);
});

test('a custom [separator=!] table resolves two cells on the same line independently', async () => {
  const m = await parse('[separator=!]\n|===\n! a link:L3a.adoc[] ! b link:L3b.adoc[]\n|===\n');
  assert.deepEqual(refs(m), [
    ['link', 'L3a.adoc', 3, false],
    ['link', 'L3b.adoc', 3, false],
  ]);
});

test('a large two-column table parses in linear time, and the last row lands on its true line', async () => {
  const rows = 10000;
  const big = '[cols="2"]\n|===\n'
    + Array.from({ length: rows }, (_, i) => `| link:k${i}.adoc[] | link:v${i}.adoc[]`).join('\n')
    + '\n|===\n';
  const start = Date.now();
  const m = await parse(big);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 2000, `took ${elapsed}ms`);
  const lastRowLine = 2 + rows;
  assert.ok(m.links.some((l) => l.target === `k${rows - 1}.adoc` && l.line === lastRowLine));
  assert.ok(m.links.some((l) => l.target === `v${rows - 1}.adoc` && l.line === lastRowLine));
});

test('a closing delimiter inside an excluded conditional does not close the block', async () => {
  const table = await parse('|===\n| a link:L2.adoc[] | b\nifdef::nope[]\n|===\nendif::[]\n| c link:L6.adoc[] | d\n|===\n');
  assert.deepEqual(refs(table), [['link', 'L2.adoc', 2, false], ['link', 'L6.adoc', 6, false]]);
  const src = '[mermaid]\n----\ngraph LR\nifdef::nope[]\n----\nendif::[]\n  A --> B\n----\n';
  const [d] = (await parse(src)).diagrams;
  assert.equal(src.slice(d.bodyEnd), '----\n');
});

test('texts: prose marks paragraph, list, and admonition text, not titles, tables, quotes, or dlist terms', async () => {
  const src = [
    '= Title words',
    '',
    'Paragraph words.',
    '',
    '* item words',
    '',
    '|===',
    '| cell | words',
    '|===',
    '',
    '____',
    'quoted words',
    '____',
    '',
    'NOTE: alert words',
    '',
    'term words:: description words',
    '',
  ].join('\n');
  const m = await parse(src);
  const prose = m.texts.filter((t) => t.prose).map((t) => t.text.trim()).filter(Boolean);
  const other = m.texts.filter((t) => !t.prose).map((t) => t.text.trim()).filter(Boolean);
  assert.deepEqual(prose, ['Paragraph words.', 'item words', 'alert words', 'description words']);
  for (const w of ['Title words', 'quoted words', 'term words']) assert.ok(other.some((t) => t.includes(w)), w);
  assert.ok(!prose.some((t) => t.includes('cell')));
  assert.ok(m.texts.every((t) => typeof t.prose === 'boolean'));
});

test('texts: prose excludes quotations nested in lists and lists nested in quotations', async () => {
  const proseWith = (m, want) => m.texts.filter((t) => t.prose && t.text.includes(want));
  const nestedQuote = await parse('* item\n+\n____\nquoted in item\n____\n');
  assert.equal(proseWith(nestedQuote, 'quoted').length, 0);
  assert.ok(nestedQuote.paragraphs.some((p) => p.text.includes('quoted in item')), 'quote attached inside the item');
  assert.equal(proseWith(nestedQuote, 'item').filter((t) => !t.text.includes('quoted')).length, 1);
  const quotedList = await parse('____\n* quoted item\n____\n');
  assert.ok(quotedList.listItems.some((i) => i.text.includes('quoted item')));
  assert.equal(proseWith(quotedList, 'quoted').length, 0);
});
