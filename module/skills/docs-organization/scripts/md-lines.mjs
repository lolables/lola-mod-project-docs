// Exact source lines for markdown-it inline tokens.
//
// markdown-it maps only *blocks* to source lines; inline tokens carry no
// position. An inline token's `content` is its block's source lines joined by
// "\n" (indent and `>` markers stripped, line count kept), so a token's line
// within the block is the number of "\n" before the position it starts at.
// Counting softbreak tokens instead would miss newlines a single token
// swallows (a wrapped code span, a link title spanning two lines).
//
// So every inline rule is wrapped: when it matches (non-silent), each token it
// created that is not yet stamped gets the line of the rule's start position.
// Nested rules (link text) run first and stamp their own tokens. Pending text
// flushed by the rule's first push ends exactly where the rule starts and
// contains no "\n" (the newline rule always flushes first), so it shares that
// line. The one flush outside any rule — trailing text at the end of the
// top-level tokenize — is stamped by a post-process rule with the last line.
// Only *inline* rules are wrapped: a token a core rule creates after inline
// parsing (markdown-it's fuzzy linkify) is never stamped, so a caller that
// enables `linkify` must disable fuzzy links.

import MarkdownIt from './vendor/markdown-it.mjs';

const lineAt = (src, pos) => {
  let n = 0;
  for (let i = src.indexOf('\n'); i !== -1 && i < pos; i = src.indexOf('\n', i + 1)) n++;
  return n;
};

// Returns `inlineBlocks(content)`: every inline block of `content` paired with
// `lineOf(child)`, the 1-based source line of one of its child tokens. Table
// cells have no map of their own; their row (`tr_open`) does.
export function lineAwareMarkdown(options = {}) {
  const md = new MarkdownIt(options);
  const tokenLine = new WeakMap();
  const stampNew = (state, from, line) => {
    for (let i = from; i < state.tokens.length; i++) {
      if (!tokenLine.has(state.tokens[i])) tokenLine.set(state.tokens[i], line);
    }
  };
  for (const rule of [...md.inline.ruler.__rules__]) {
    const orig = rule.fn;
    md.inline.ruler.at(rule.name, (state, silent) => {
      const start = state.pos;
      const from = state.tokens.length;
      const ok = orig(state, silent);
      if (ok && !silent) stampNew(state, from, lineAt(state.src, start));
      return ok;
    }, { alt: rule.alt });
  }
  md.inline.ruler2.before('balance_pairs', 'stamp_trailing_text', (state) => {
    stampNew(state, 0, lineAt(state.src, state.src.length));
  });
  function* inlineBlocks(content) {
    let rowStart = null;
    for (const b of md.parse(content, {})) {
      if (b.type === 'tr_open') rowStart = b.map[0];
      if (b.type !== 'inline' || !b.children) continue;
      const base = b.map ? b.map[0] : rowStart;
      yield { block: b, lineOf: (tok) => base + tokenLine.get(tok) + 1 };
    }
  }
  return { md, inlineBlocks };
}
