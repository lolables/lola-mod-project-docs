// Markdown adapter: parses CommonMark + GFM tables/strikethrough (markdown-it's
// default preset) plus footnotes, `:::` containers, and MkDocs `!!!`
// admonitions into the DocModel described in formats/index.mjs.
//
// Structure comes from the markdown-it token stream, never per-line regexes,
// so fenced code, tables, and nested lists are told apart by token type.
// Inline tokens carry no position of their own; stampInlineLines gives each
// one its exact source line.
//
// Extensions handled here rather than by a plugin:
//   - Front matter: a leading `---`…`---` (YAML) or `+++`…`+++` (TOML) block
//     is replaced by blank lines before parsing, so it is never read as a
//     setext heading or a paragraph and every line number stays exact. It
//     must start at byte 0 (after an optional BOM), and either be empty or
//     have a first non-blank inner line that looks like a key (`name:` or
//     `name=`), the same way Jekyll and Hugo read front matter — so a
//     leading `---` thematic break is never swallowed as the opener of a
//     front-matter block it isn't.
//   - GFM alerts: a blockquote whose first line is `[!NOTE]` (or TIP,
//     IMPORTANT, WARNING, CAUTION) is a callout, not a quotation.
//
// listItems[].text holds all of an item's own prose except nested lists, so
// an item's later paragraphs are ALSO reported in `paragraphs` with context
// 'list' — a check reads one or the other for an item's prose, never both.
//
// Linkify is on with fuzzy links, mailto:, and // (protocol-relative) off: a
// bare `https://` URL becomes a link token marked `bare`, which
// fetch-citations needs and check-refs ignores. Any scheme the inline rule
// skips falls to the core linkify rule, which runs after inline parsing and
// so leaves its tokens unstamped — those schemes must stay disabled.

import MarkdownIt, { footnote, container, admon } from '../vendor/markdown-it.mjs';
import { stampInlineLines } from './md-lines.mjs';
import { countLines, lineStarts, splitLines } from './text.mjs';

const md = new MarkdownIt({ linkify: true })
  .use(footnote)
  .use(admon)
  .use(container, 'callout', { validate: () => true });
// Inline footnotes (`^[body]`) are off: footnote_tail splices their body's
// paragraph/inline tokens in from state.env, not from block parsing, so those
// tokens carry no .map and crash the line lookups below. Referenced/labelled
// footnotes (`[^1]` + `[^1]: body`) are unaffected — their body is tokenized
// as an ordinary block and keeps a real map.
md.inline.ruler.disable('footnote_inline');
// mailto: and // (protocol-relative) are schemes markdown-it's inline linkify rule
// hands off to the CORE linkify rule, which runs after stampInlineLines'
// wrapping and so leaves its tokens unstamped (see md-lines.mjs). Disabling
// them keeps every link token on the stamped, inline-rule path.
md.linkify.set({ fuzzyLink: false, fuzzyEmail: false }).add('mailto:', null).add('//', null);
const lineOf = stampInlineLines(md);

// footnote_tail (run after 'inline', confirmed by grepping the vendored
// plugin) reorders footnote bodies to the document's end and DROPS the body
// of any footnote definition that is never referenced — so links inside an
// unreferenced `[^1]: ...` definition would otherwise vanish. Capturing the
// token stream one rule earlier keeps every definition in its source
// position. Token OBJECTS (not the array) are shared with the post-footnote
// stream footnote_tail builds, so later core rules (core linkify, text_join)
// still finish mutating their `.children` in place before we read them.
md.core.ruler.before('footnote_tail', 'source_order_tokens', (state) => {
  state.env.sourceTokens = state.tokens.slice();
});

const FRONT_MATTER_RE = /^(---|\+\+\+)[ \t]*(?:\r\n?|\n)([\s\S]*?)(?:\r\n?|\n)\1[ \t]*(?=\r\n?|\n|$)/;
// The first non-blank inner line of a real front-matter block: a YAML or
// TOML key (`name:` or `name =`). A block with no non-blank inner line at
// all (an empty `---`…`---`) is front matter too, read as zero fields.
const FRONT_MATTER_KEY_RE = /^[A-Za-z0-9_.-]+\s*[:=]/;
const ALERT_RE = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\n|$)/i;
const FENCE_CLOSE_RE = /^ {0,3}(`+|~+)[ \t]*$/;
const FENCE_AT_COLUMN_0_RE = /^(`{3,}|~{3,})/;

// Blank out front matter, keeping its line breaks so line numbers hold. A
// block whose first non-blank inner line doesn't look like a key is left
// untouched — it is a thematic break (`---`) and a later, unrelated
// thematic break, not front matter.
function stripFrontMatter(content) {
  const m = content.match(FRONT_MATTER_RE);
  if (!m) return content;
  const firstLine = m[2].split(/\r\n?|\n/).find((l) => l.trim() !== '');
  if (firstLine !== undefined && !FRONT_MATTER_KEY_RE.test(firstLine)) return content;
  return m[0].replace(/[^\r\n]/g, '') + content.slice(m[0].length);
}

// A mermaid fence as a DocModel diagram. markdown-it's map for a closed fence
// ends after its closing marker; for an unclosed one it ends where the
// enclosing block (or the document) does. `source` is the fence content with
// the fence indent removed. A fence is swappable only when its OPENER sits at
// column 0 with nothing (no `>`, no list or admonition indent) before it,
// because a swap rewrites the body bytes verbatim and the body is de-indented
// only when the opener is — a closer indented 1-3 spaces is still valid
// CommonMark (FENCE_CLOSE_RE already allows that) and swapping leaves it
// untouched, since [bodyStart, bodyEnd) ends before that line. blockStart/
// bodyStart/bodyEnd are exact byte offsets only when `swappable` is true; for
// a nested fence they can include a `>` prefix, so a consumer must not splice
// them when swappable is false.
function diagramOf(tok, content, starts, lines) {
  const [open, end] = tok.map;
  const closeLine = end - 1;
  const cm = closeLine > open && closeLine < lines.length ? lines[closeLine].match(FENCE_CLOSE_RE) : null;
  const closed = !!cm && cm[1][0] === tok.markup[0] && cm[1].length >= tok.markup.length;
  const at = (line) => (line < starts.length ? starts[line] : content.length);
  const atColumn0 = (line) => FENCE_AT_COLUMN_0_RE.test(lines[line]);
  return {
    startLine: open + 2,
    source: tok.content.trimEnd(),
    blockStart: starts[open],
    bodyStart: at(open + 1),
    bodyEnd: closed ? starts[closeLine] : at(end),
    swappable: atColumn0(open),
  };
}

export default {
  name: 'markdown',
  extensions: ['.md', '.markdown', '.mdown', '.mkd', '.mkdn'],
  readmeNames: ['README.md', 'README.markdown'],

  async parse(content) {
    // A leading BOM is zero-width and not a line break: parsing sees it strip
    // out cleanly without shifting any line number. But offsets (starts,
    // bodyStart/bodyEnd/blockStart) must index the ORIGINAL bytes, so starts
    // and lines stay derived from `content`; only `lines[0]` has the BOM
    // trimmed, so the column-0 fence check in diagramOf isn't thrown off by
    // it sitting before the fence marker on line 1.
    const body = content.startsWith('\uFEFF') ? content.slice(1) : content;
    const env = {};
    md.parse(stripFrontMatter(body), env);
    const tokens = env.sourceTokens;
    const starts = lineStarts(content);
    const lines = splitLines(content);
    if (lines[0]) lines[0] = lines[0].replace(/^\uFEFF/, '');
    const model = {
      lines: countLines(content),
      headings: [], paragraphs: [], listItems: [], links: [], texts: [], diagrams: [], diagnostics: [],
    };

    const itemStack = [];
    const quoteStack = []; // per open blockquote: true = GFM alert (callout), false = quotation
    let calloutDepth = 0;  // open admonitions and ::: containers
    let rowLine = null;
    let block = 0;
    // Set at an alert blockquote_open, consumed by the very next
    // paragraph_open (its own marker paragraph, by construction of isAlert
    // below) to strip the `[!NOTE]` marker line from the reported text.
    let pendingAlertMarker = false;

    for (let ti = 0; ti < tokens.length; ti++) {
      const tok = tokens[ti];
      switch (tok.type) {
        case 'heading_open':
          model.headings.push({ level: Number(tok.tag.slice(1)), line: tok.map[0] + 1, title: tokens[ti + 1].content });
          break;
        case 'blockquote_open': {
          // An alert is a quote whose very first block is a paragraph whose
          // text starts with `[!NOTE]` et al. on its own line — a heading
          // (`> # [!NOTE]`) or trailing text (`> [!NOTE] inline text`) is an
          // ordinary quote instead.
          const first = tokens[ti + 2];
          const isAlert = tokens[ti + 1]?.type === 'paragraph_open' && !!first && first.type === 'inline' && ALERT_RE.test(first.content);
          quoteStack.push(isAlert);
          if (isAlert) pendingAlertMarker = true;
          break;
        }
        case 'blockquote_close':
          quoteStack.pop();
          break;
        case 'admonition_open':
        case 'container_callout_open':
          calloutDepth++;
          break;
        case 'admonition_close':
        case 'container_callout_close':
          calloutDepth--;
          break;
        case 'bullet_list_open':
        case 'ordered_list_open':
          if (itemStack.length > 0) itemStack[itemStack.length - 1].hasNestedList = true;
          break;
        case 'list_item_open':
          itemStack.push({ line: tok.map[0] + 1, text: '', hasNestedList: false });
          break;
        case 'list_item_close':
          model.listItems.push(itemStack.pop());
          break;
        case 'tr_open':
          rowLine = tok.map[0];
          break;
        case 'paragraph_open': {
          // A list item's first paragraph is the item's own text (listItems),
          // not a separate paragraph; later ones are paragraphs in the item.
          if (ti > 0 && tokens[ti - 1].type === 'list_item_open') break;
          const inQuote = quoteStack.some((isAlert) => !isAlert);
          const inCallout = calloutDepth > 0 || quoteStack.some((isAlert) => isAlert);
          const context = itemStack.length > 0 ? 'list' : inQuote ? 'quote' : inCallout ? 'callout' : 'top';
          let text = tokens[ti + 1].content;
          if (pendingAlertMarker) {
            text = text.replace(ALERT_RE, '');
            pendingAlertMarker = false;
          }
          model.paragraphs.push({ line: tok.map[0] + 1, text, context });
          break;
        }
        case 'fence':
          if (tok.info.trim().split(/\s+/)[0] === 'mermaid') model.diagrams.push(diagramOf(tok, content, starts, lines));
          break;
        case 'inline': {
          if (itemStack.length > 0) itemStack[itemStack.length - 1].text += ' ' + tok.content;
          const base = tok.map ? tok.map[0] : rowLine;
          let linkDepth = 0;
          for (const c of tok.children) {
            if (c.type === 'link_open') {
              linkDepth++;
              model.links.push({ kind: 'link', target: c.attrGet('href'), line: lineOf(base, c), block, bare: c.markup === 'linkify' });
            } else if (c.type === 'link_close') {
              linkDepth = Math.max(0, linkDepth - 1);
            } else if (c.type === 'image') {
              model.links.push({ kind: 'image', target: c.attrGet('src'), line: lineOf(base, c), block, bare: false });
            } else if (c.type === 'text' && linkDepth === 0) {
              model.texts.push({ text: c.content, line: lineOf(base, c), block });
            }
          }
          block++;
          break;
        }
        default:
          break;
      }
    }
    model.listItems.sort((a, b) => a.line - b.line);
    return model;
  },
};
