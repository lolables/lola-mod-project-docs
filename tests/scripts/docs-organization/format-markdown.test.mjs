import { test } from 'node:test';
import assert from 'node:assert/strict';
import markdown from '../../../module/skills/docs-organization/scripts/formats/markdown.mjs';

const parse = (src) => markdown.parse(src);

test('declares its extensions and README names', () => {
  assert.deepEqual(markdown.extensions, ['.md', '.markdown', '.mdown', '.mkd', '.mkdn']);
  assert.deepEqual(markdown.readmeNames, ['README.md', 'README.markdown']);
  assert.ok(!markdown.extensions.includes('.mdx'), '.mdx is source (Linguist), not prose');
});

test('headings carry Markdown levels, lines, and titles (ATX and setext)', async () => {
  const m = await parse('# Title\n\n## Two\n\nSetext\n------\n\n#### Four\n');
  assert.deepEqual(m.headings, [
    { level: 1, line: 1, title: 'Title' },
    { level: 2, line: 3, title: 'Two' },
    { level: 2, line: 5, title: 'Setext' },
    { level: 4, line: 8, title: 'Four' },
  ]);
});

test('YAML and TOML front matter is neither a heading nor a paragraph, and lines stay exact', async () => {
  for (const fence of ['---', '+++']) {
    const m = await parse(`${fence}\ntitle: x\n${fence}\n# Real\n\nBody.\n`);
    assert.deepEqual(m.headings, [{ level: 1, line: 4, title: 'Real' }], fence);
    assert.deepEqual(m.paragraphs.map((p) => p.line), [6], fence);
    assert.equal(m.lines, 6, fence);
  }
});

test('a --- thematic break later in the file is not front matter', async () => {
  const m = await parse('Intro.\n\n---\n\nAfter.\n');
  assert.deepEqual(m.paragraphs.map((p) => p.line), [1, 5]);
});

test('a leading --- rule closed by a later --- is not front matter: a diagram between them is kept', async () => {
  const m = await parse('---\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\n---\n\nBody.\n');
  assert.deepEqual(m.diagrams.map((d) => d.startLine), [4]);
});

test('a link between two leading --- rules is reported as a link, not swallowed as front matter', async () => {
  const m = await parse('---\n\n[x](nope.md)\n\n---\n\nBody.\n');
  assert.deepEqual(m.links.map((l) => l.target), ['nope.md']);
});

test('an empty --- block (no key-looking inner line) is still read as front matter', async () => {
  const m = await parse('---\n---\n# T\n');
  assert.deepEqual(m.headings, [{ level: 1, line: 3, title: 'T' }]);
});

test('paragraph context: top, quote, GFM alert, admonition, container, list', async () => {
  const src = [
    'Top.',                       // 1
    '',
    '> Quoted.',                  // 3
    '',
    '> [!WARNING]',               // 5
    '> Alert body.',
    '',
    '!!! note "Heads up"',        // 8
    '    Admonition body.',       // 9
    '',
    '::: tip',                    // 11
    'Container body.',            // 12
    ':::',
    '',
    '- item own text',            // 15
    '',
    '  Second paragraph in item.',// 17
    '',
  ].join('\n');
  const m = await parse(src);
  assert.deepEqual(m.paragraphs.map(({ line, context }) => [line, context]), [
    [1, 'top'], [3, 'quote'], [5, 'callout'], [9, 'callout'], [12, 'callout'], [17, 'list'],
  ]);
  assert.deepEqual(m.listItems.map(({ line, hasNestedList }) => [line, hasNestedList]), [[15, false]]);
});

test('list items: own text, nested-list flag, nested text attributed to the inner item', async () => {
  const m = await parse('- outer [a](a.md)\n  - inner text\n- flat\n');
  assert.deepEqual(m.listItems.map(({ line, text, hasNestedList }) => [line, text.trim(), hasNestedList]), [
    [1, 'outer [a](a.md)', true], [2, 'inner text', false], [3, 'flat', false],
  ]);
});

test('links: inline, reference-style, image, autolink, bare URL, footnote body, table cell — with exact lines', async () => {
  const src = [
    'See [doc](doc.md) and ![img](i.png).',  // 1
    'Ref [r][x] then <https://auto.example/>', // 2
    'bare https://bare.example/p here[^1].',  // 3
    '',
    '| a |',                                    // 5
    '|---|',
    '| [cell](c.md) |',                         // 7
    '',
    '[x]: ref.md',                              // 9
    '[^1]: Note [fn](fn.md).',                  // 10
  ].join('\n');
  const m = await parse(src);
  assert.deepEqual(m.links.map(({ kind, target, line, bare }) => [kind, target, line, bare]), [
    ['link', 'doc.md', 1, false],
    ['image', 'i.png', 1, false],
    ['link', 'ref.md', 2, false],
    ['link', 'https://auto.example/', 2, false],
    ['link', 'https://bare.example/p', 3, true],
    ['link', 'c.md', 7, false],
    ['link', 'fn.md', 10, false],
  ]);
});

test('a scheme-less www. address is not a link (fuzzy linkify is off)', async () => {
  const m = await parse('Visit www.example.com today.\n');
  assert.deepEqual(m.links, []);
});

test('code spans and fences produce no links and no texts', async () => {
  const m = await parse('Run `[x](y.md)`.\n\n```\n[z](z.md) §1\n```\n');
  assert.deepEqual(m.links, []);
  assert.ok(m.texts.every((t) => !t.text.includes('§')));
});

test('texts exclude link text and share a block id with links in the same inline block', async () => {
  const m = await parse('See §3 in [spec](s.md).\n\nAlone §4.\n');
  const sec3 = m.texts.find((t) => t.text.includes('§3'));
  const sec4 = m.texts.find((t) => t.text.includes('§4'));
  assert.equal(m.links[0].block, sec3.block);
  assert.notEqual(sec4.block, sec3.block);
  assert.ok(!m.texts.some((t) => t.text === 'spec'));
});

test('mermaid fences: top-level is swappable with exact offsets; nested is not', async () => {
  const src = '# T\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\n!!! note\n    ```mermaid\n    graph TD\n    ```\n';
  const m = await parse(src);
  assert.equal(m.diagrams.length, 2);
  const [top, nested] = m.diagrams;
  assert.equal(top.startLine, 4);
  assert.equal(top.source, 'flowchart LR\n  A --> B');
  assert.equal(src.slice(top.blockStart, top.bodyStart), '```mermaid\n');
  assert.equal(src.slice(top.bodyStart, top.bodyEnd), 'flowchart LR\n  A --> B\n');
  assert.equal(top.swappable, true);
  assert.equal(nested.startLine, 10);
  assert.equal(nested.source, 'graph TD');
  assert.equal(nested.swappable, false);
});

test('a closing fence indented 1-3 spaces is valid CommonMark and still swappable', async () => {
  const src = '# T\n\n```mermaid\nflowchart LR\n  A --> B\n  ```\n';
  const [d] = (await parse(src)).diagrams;
  assert.equal(d.swappable, true);
  assert.equal(src.slice(d.bodyStart, d.bodyEnd), 'flowchart LR\n  A --> B\n');
});

test('a ~~~ fence is not closed by ```, and a 4-backtick fence hides an inner ```mermaid', async () => {
  const m = await parse('````\n```mermaid\nnot a diagram\n```\n````\n\n~~~mermaid\ngraph LR\n```\n~~~\n');
  assert.equal(m.diagrams.length, 1);
  assert.equal(m.diagrams[0].source, 'graph LR\n```');
});

test('an unclosed fence runs to the end of the document', async () => {
  const src = '```mermaid\ngraph LR\n';
  const [d] = (await parse(src)).diagrams;
  assert.equal(d.bodyEnd, src.length);
});

test('CRLF content: lines match the LF version and offsets index the original bytes', async () => {
  const lf = '# T\n\n```mermaid\ngraph LR\n```\n';
  const crlf = lf.replace(/\n/g, '\r\n');
  const a = await parse(lf);
  const b = await parse(crlf);
  assert.deepEqual(b.headings, a.headings);
  assert.equal(b.diagrams[0].startLine, a.diagrams[0].startLine);
  assert.equal(crlf.slice(b.diagrams[0].bodyStart, b.diagrams[0].bodyEnd), 'graph LR\r\n');
});

test('Markdown never reports diagnostics', async () => {
  assert.deepEqual((await parse('```mermaid\nunclosed\n')).diagnostics, []);
});

test('an inline footnote does not crash the parse, and its body link is reported once', async () => {
  const m = await parse('Text^[see [x](x.md)] here.\n');
  assert.deepEqual(m.links.map(({ kind, target, line, bare }) => [kind, target, line, bare]), [
    ['link', 'x.md', 1, false],
  ]);
});

test('mailto: and protocol-relative // addresses are not autolinked, and every line stays an integer', async () => {
  for (const src of ['mail mailto:a@b.co now\n', 'See §2 at //example.com/x.\n']) {
    const m = await parse(src);
    assert.deepEqual(m.links, [], src);
    assert.ok(m.texts.length > 0, src);
    for (const item of [...m.links, ...m.texts]) assert.ok(Number.isInteger(item.line), `${src}: ${JSON.stringify(item)}`);
  }
});

test('a UTF-8 BOM does not hide the first heading, front matter, or a column-0 fence', async () => {
  const bom = '\uFEFF';
  const simple = await parse(`${bom}# Title\n`);
  assert.deepEqual(simple.headings, [{ level: 1, line: 1, title: 'Title' }]);

  const withFrontMatter = await parse(`${bom}---\ntitle: x\n---\n# Real\n`);
  assert.deepEqual(withFrontMatter.headings, [{ level: 1, line: 4, title: 'Real' }]);

  const withFence = await parse(`${bom}\`\`\`mermaid\ngraph LR\n\`\`\`\n`);
  const [d] = withFence.diagrams;
  assert.equal(d.swappable, true);
  const src = `${bom}\`\`\`mermaid\ngraph LR\n\`\`\`\n`;
  assert.equal(src.slice(d.bodyStart, d.bodyEnd), 'graph LR\n');
});

test('an unreferenced footnote definition keeps its link, at the definition line, with top context', async () => {
  const m = await parse('Body.\n\n[^1]: Note [fn](fn.md).\n');
  assert.deepEqual(m.links.map(({ kind, target, line, bare }) => [kind, target, line, bare]), [
    ['link', 'fn.md', 3, false],
  ]);
  assert.deepEqual(m.paragraphs.map(({ line, context }) => [line, context]), [[1, 'top'], [3, 'top']]);
});

test('[!NOTE] is only an alert as its own quoted paragraph, not as a heading or trailing inline text', async () => {
  const heading = await parse('> # [!NOTE]\n> body\n');
  assert.deepEqual(heading.paragraphs.map(({ context }) => context), ['quote']);

  const inline = await parse('> [!NOTE] inline text\n');
  assert.deepEqual(inline.paragraphs.map(({ context }) => context), ['quote']);

  const realAlert = await parse('> [!NOTE]\n> body\n');
  assert.deepEqual(realAlert.paragraphs.map(({ context }) => context), ['callout']);
});

test('an alert paragraph\'s text drops the [!TIP] marker line, keeping only the body', async () => {
  const m = await parse('> [!TIP]\n> one two three\n');
  assert.deepEqual(m.paragraphs.map(({ text, context }) => [text, context]), [['one two three', 'callout']]);
});
