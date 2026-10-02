// AsciiDoc adapter: parses a document with Asciidoctor.js into the DocModel
// described in formats/index.mjs.
//
// Asciidoctor runs in `secure` safe mode. Audited docs may come from an
// untrusted repository, and secure mode guarantees the parser never reads a
// file (include::, docinfo, images) or fetches a URI.
//
// Block structure, line numbers, and verbatim content come from Asciidoctor's
// public API (getLineNumber, getSourceLines, table cell source/lineno).
// Asciidoctor has no inline AST, and its text getters return converted HTML,
// so inline references are found by the regexes below, run over the raw
// source lines of each text-bearing block. Inline code spans and `+…+`
// passthroughs are masked first, so an example is never read as a reference.
//
// Conditionals (ifdef/ifndef/ifeval/endif) are resolved by Asciidoctor's own
// preprocessor before block parsing ever starts, which is also where it
// rewrites `include::target[]` into a `link:target[role=include]` paragraph
// — so a block's reported getLineNumber() can overshoot past content a
// conditional dropped (see excludedLines below), and getSourceLines() can
// hold that rewritten form instead of the original directive. include::
// references are therefore read directly off the raw lines in one pass
// (scanIncludes), the one place that works the same inside a paragraph, a
// list item, or a listing/literal block alike; the rewritten form is
// filtered out of paragraph and item text wherever it appears.
//
// Parser warnings go to a per-call MemoryLogger (load's `logger` option is
// scoped to that call) and come back as `diagnostics`, never on stdout/stderr.

import { load, MemoryLogger } from '../vendor/asciidoctor.mjs';
import { countLines, lineStarts, splitLines } from './text.mjs';

const HEADING_RE = /^(?:=+|#+)[ \t]+(.*?)[ \t]*$/;
const LIST_MARKER_RE = /^[ \t]*(?:\*+|-+|\.+|\d+\.|[a-zA-Z]\.|[ivxIVX]+\)|<\d+>|<\.>)[ \t]+/;
const DLIST_TERM_RE = /^.*?(?::{2,4}|;;)(?:[ \t]+|$)/;
const DLIST_DELIM_RE = /::|;;/;
// An open block's delimiter is exactly two dashes; a listing/literal block's
// is four or more dashes or dots. Three dashes is not a recognized AsciiDoc
// delimiter either way, so it is deliberately not matched by either branch.
const DELIMITER_RE = /^(--|-{4,}|\.{4,})[ \t]*$/;
// A table's own delimiter: one of |===, ,===, :===, !=== (the last for a
// table nested inside another table's cell, to tell its close from the
// outer one's).
const TABLE_DELIM_RE = /^([|,:!]={3,})[ \t]*$/;
const ATTRIBUTE_LINE_RE = /^\[.*\]$/;
const TITLE_LINE_RE = /^\.[^\s.]/;
// Secure mode rewrites `include::target[...]` into this single-line
// `link:target[role=include,...]` paragraph; a paragraph consisting only of
// one is not prose, just the trace of a directive the parser already erased.
const INCLUDE_ONLY_RE = /^link:\S+\[role=include(?:,[^\]]*)?\]$/;
// A raw (unrewritten) include line, as it still appears in `lines` wherever
// our own scans read raw text directly instead of Asciidoctor's rewritten
// getSourceLines() — inside a list item's continuation lines, for example.
const RAW_INCLUDE_RE = /^include::(\S+?)\[([^\]]*)\]\s*$/;
// The same, but distinguishing an escaped line (never a directive) from a
// real one, for the one-pass raw-line include scan.
const RAW_INCLUDE_LINE_RE = /^(\\)?include::(\S+?)\[([^\]]*)\]$/;
const COMMENT_FENCE_RE = /^\/{4,}$/;
const LINE_COMMENT_RE = /^\/\/(?!\/)/;
// A conditional preprocessor directive — ifdef/ifndef/ifeval/endif — ported
// from Asciidoctor's own ConditionalDirectiveRx (reader.js). Groups: escape,
// name, target (with its raw `,`/`+`-delimited attribute list, if any), text
// (the single-line form's bracket content, or an ifeval expression).
const COND_DIRECTIVE_RE = /^(\\)?(ifdef|ifndef|ifeval|endif)::([^[]*)\[(.*)\]$/;
// An attribute entry — `:name: value`, `:name!:`, `:!name:`, or `:name:`
// (set to an empty value) — ported from Asciidoctor's own AttributeEntryRx
// (rx.js). Group 1 is the name with its optional leading/trailing `!`.
const ATTR_ENTRY_RE = /^:(!?[\p{Alphabetic}\p{N}_][^:]*):(?:[ \t]+(.*))?$/u;
// A listing (----), literal (....), passthrough (++++), or comment (////)
// delimiter line — the four block kinds whose content is never scanned for
// attribute entries. Group 1 is the exact delimiter (trailing whitespace
// aside), so a close is matched against the same character repeated the
// same number of times as the open.
const DELIM_BLOCK_RE = /^(-{4,}|\.{4,}|\+{4,}|\/{4,})[ \t]*$/;
const COMMENT_BLOCK_RE = /^\/{4,}[ \t]*$/;
const CODE_SPAN_RE = /`[^`\n]*`|\+[^+\n]*\+/g;
const URL_MARK_RE = /[*_#]/;
const URL_SCHEME_RE = /^(?:https?|ftp|irc):\/\//;
// One alternation, tried left to right at each position: escaped macros,
// escaped xref shorthand, and escaped bare URLs first (so a `\`-prefixed one
// is skipped entirely), then named macros, then cross-references, then bare
// URLs.
//
// Only `image` takes a double colon, and only when it opens its own line (a
// block image); `link`/`xref` never do, and `image::` in the middle of a
// line is plain text, not an inline image (the same line class — excluding a
// second `:` from the target's first character — already rejects it, since
// the macro name literal can't restart mid-word). `xref` alone allows spaces
// in its target (AsciiDoc file names may have them); `link`/`image` do not.
//
// The bare-URL body is Asciidoctor's own InlineLinkRx body — greedy, then
// backtracking one character at a time off a required non-punctuation last
// character — the same linear mechanism real Asciidoctor uses, and the fix
// for the quadratic `+?` + lookahead this replaced. Its preceding-context
// lookbehind mirrors Asciidoctor's: start of line, whitespace, `<>()[];`,
// `link:`, or one of the constrained-formatting marks `*_#` (Asciidoctor
// runs quote substitution before macro detection, so `*bold*`/`_em_`/`#mark#`
// content is scanned with those delimiters already stripped; scanning raw
// text instead, a literal mark is accepted here and one matching trailing
// mark is stripped from the target in scanInline). A quote character is
// deliberately NOT a valid boundary: Asciidoctor consumes a paired quote as
// a curly-quote substitution before macro detection ever runs, so a
// straight-quoted URL never becomes a link.
// Every "scan some characters, then require a literal delimiter" piece below
// (a macro's target before `[`, its attrlist before `]`, an xref id before
// `>>`, a URL body) is capped at MAX_SPAN repetitions. JS regexes have no
// possessive quantifier or atomic group, so when the required delimiter is
// never found, an unbounded `*`/`+` backtracks one character at a time all
// the way back to empty before giving up — O(n) wasted work at every one of
// up to O(n) starting positions, i.e. O(n²), on adversarial input with no
// `[`/`]`/`>>` at all (a line of nothing but `link:` or `<<`). No real
// AsciiDoc target, attrlist, or xref id is anywhere near this long; the cap
// only ever bites on input built to defeat it.
const MAX_SPAN = 2000;
const INLINE_RE = new RegExp([
  String.raw`\\(?:link|xref|image|mailto):[^\s\[]{0,${MAX_SPAN}}\[[^\]]{0,${MAX_SPAN}}\]`,
  String.raw`\\<<[^>]{0,${MAX_SPAN}}>>`,
  String.raw`\\(?:https?|ftp|irc):\/\/\S{0,${MAX_SPAN}}`,
  String.raw`(?<macro>link|image):(?<mtarget>[^\s\[:][^\s\[]{0,${MAX_SPAN}})\[(?<mattrs>[^\]]{0,${MAX_SPAN}})\]`,
  String.raw`(?<macro>xref):(?<mtarget>[^\s\[:][^\[]{0,${MAX_SPAN}})\[(?<mattrs>[^\]]{0,${MAX_SPAN}})\]`,
  String.raw`^(?<macro>image)::(?<mtarget>[^\s\[][^\s\[]{0,${MAX_SPAN}})\[(?<mattrs>[^\]]{0,${MAX_SPAN}})\]`,
  String.raw`<<(?<xref>[^,><]{1,${MAX_SPAN}}?)(?:,[^>]{0,${MAX_SPAN}})?>>`,
  String.raw`(?<=^|[\s\u00a0<>()\[\];]|link:|[*_#])(?<url>(?:https?|ftp|irc):\/\/[^\s\[\]<]{0,${MAX_SPAN}}[^\s,.?!\[\]<)>"])(?<urltext>\[[^\]]{0,${MAX_SPAN}}\])?`,
].join('|'), 'g');
const ATTR_REF_RE = /\{([\w-]+)\}/g;
const HAS_ATTR_REF_RE = /\{[\w-]+\}/;

// Asciidoctor substitutes `{name}` attribute references before it looks for
// macros, so a line is resolved first. A reference to an undefined attribute
// is left as written; a target still holding one cannot be resolved and is
// dropped rather than reported as a broken reference.
function resolveAttributes(doc, text) {
  return text.replace(ATTR_REF_RE, (whole, name) => {
    const v = doc.getAttribute(name);
    return v === undefined || v === null ? whole : String(v);
  });
}

// Whether an ifdef/ifndef's OWN condition (ignoring any enclosing
// conditional) is false, ported from reader.js #preprocessConditionalDirective.
// `,` is "any of these attributes is set" (ifdef) / "is unset" (ifndef);
// `+` is "all of these". doc.getAttribute holds the document's FINAL
// attributes — an attribute set or unset midway through the document after a
// conditional is evaluated as its final value, a documented approximation.
function evalIfDirective(name, rawTarget, has) {
  const delimiter = rawTarget.includes(',') ? ',' : rawTarget.includes('+') ? '+' : null;
  const target = rawTarget.toLowerCase();
  if (name === 'ifdef') {
    if (delimiter === ',') return !target.split(',').some(has);
    if (delimiter === '+') return target.split('+').some((a) => !has(a));
    return !has(target);
  }
  if (delimiter === ',') return target.split(',').some(has);
  if (delimiter === '+') return target.split('+').every(has);
  return has(target);
}

// The 1-based raw line numbers the preprocessor drops: every conditional
// directive line itself (ifdef/ifndef/ifeval/endif), plus any line inside a
// conditional currently evaluating false. A directive's own truth doesn't
// depend on whether it also sits inside an outer false conditional — each is
// evaluated independently against the attributes seen so far, and a line is
// excluded if ANY enclosing conditional (including its own, for ifdef/ifndef)
// is false. ifeval is never evaluated — its content is always treated as
// kept, since over-reporting a reference beats hiding one a real evaluation
// would have kept. The single-line form (`ifdef::a[content]`) is
// self-contained (no matching endif) and is not supported beyond marking its
// own line excluded either way — true or false, its bracket content is never
// read as kept text, a documented simplification.
//
// An ifdef/ifndef's condition is evaluated against attribute entries tracked
// here, in document order, as the preprocessor itself sees them — NOT
// doc.getAttribute(), which (after load() restores header state) never
// reflects a body-level `:name: value`/`:name!:`/`:!name:` entry at all. A
// name with no entry seen so far falls back to doc.getAttribute(), which
// still correctly covers built-ins (backend-html5, asciidoctor,
// safe-mode-secure, env-*, …) and header-only attributes — a name set later
// in the body is absent from that fallback too, which is exactly right: at
// the point a condition is evaluated, it hasn't been set yet. An attribute
// entry on an excluded line, or inside a listing/literal/passthrough/comment
// block (where it is literal content, not a real entry), is ignored.
// Directives are also never recognized inside a comment block — Asciidoctor
// does not evaluate them there either.
function excludedLines(lines, doc) {
  const excluded = new Set();
  const attrs = new Map();
  const hasAttr = (name) => {
    const n = name.toLowerCase();
    if (attrs.has(n)) return attrs.get(n);
    const v = doc.getAttribute(n);
    return v !== undefined && v !== null;
  };
  const stack = []; // {skip}: this frame's own truth value
  let skipping = false;
  const recompute = () => { skipping = stack.some((f) => f.skip); };
  const handleDirective = (m, l) => {
    const [, , name, rawTarget, text] = m;
    excluded.add(l);
    if (name === 'endif') {
      if (stack.length > 0) stack.pop();
      recompute();
    } else if (name === 'ifeval') {
      stack.push({ skip: false });
      recompute();
    } else if (!text) {
      stack.push({ skip: evalIfDirective(name, rawTarget, hasAttr) });
      recompute();
    }
    // else: single-line ifdef/ifndef form — only its own line is excluded.
  };

  let delim = null; // the exact delimiter string of the currently open block
  let inComment = false; // that open delimiter is specifically a //// block
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const l = i + 1;

    if (delim) {
      const closeMatch = raw.match(DELIM_BLOCK_RE);
      const closing = closeMatch && closeMatch[1] === delim;
      if (inComment) {
        excluded.add(l); // comment content never renders; directives don't fire inside
        if (closing) { delim = null; inComment = false; }
        continue;
      }
      if (closing) { delim = null; if (skipping) excluded.add(l); continue; }
      const dm = raw.match(COND_DIRECTIVE_RE);
      if (dm && !dm[1]) { handleDirective(dm, l); continue; }
      if (skipping) excluded.add(l);
      continue;
    }

    const openMatch = raw.match(DELIM_BLOCK_RE);
    if (openMatch) {
      delim = openMatch[1];
      inComment = COMMENT_BLOCK_RE.test(raw);
      if (inComment || skipping) excluded.add(l);
      continue;
    }

    const dm = raw.match(COND_DIRECTIVE_RE);
    if (dm && !dm[1]) { handleDirective(dm, l); continue; }

    const am = raw.match(ATTR_ENTRY_RE);
    if (am) {
      if (!skipping) {
        const unset = am[1].startsWith('!') || am[1].endsWith('!');
        attrs.set(am[1].replace(/^!|!$/g, '').toLowerCase(), !unset);
      }
      if (skipping) excluded.add(l);
      continue;
    }

    if (skipping) excluded.add(l);
  }
  return excluded;
}

// `<<id>>` is an in-document anchor; `<<file#id>>` and `<<file.adoc>>` point at
// another document, and Asciidoctor adds `.adoc` when the path has no extension.
function xrefTarget(raw) {
  const hash = raw.indexOf('#');
  if (hash === -1) return /\.adoc$/i.test(raw) ? raw : '#' + raw;
  const path = raw.slice(0, hash);
  if (path === '') return raw;
  return (/\.[^/.]+$/.test(path) ? path : path + '.adoc') + raw.slice(hash);
}

// Scan one text-bearing block's raw lines for references and plain text.
// `lineNumbers[i]` is the already-resolved original source line for
// `rawLines[i]` — sequential for most blocks, but realigned (see alignLines)
// wherever an excluded conditional could have shifted Asciidoctor's own count.
function scanInline(doc, model, block, lineNumbers, rawLines) {
  rawLines.forEach((raw, i) => {
    const line = lineNumbers[i];
    const text = resolveAttributes(doc, raw.replace(CODE_SPAN_RE, (s) => ' '.repeat(s.length)));
    let last = 0;
    for (const m of text.matchAll(INLINE_RE)) {
      const g = m.groups;
      let ref = null;
      if (g.macro) {
        ref = { kind: g.macro, target: g.mtarget, bare: false };
      } else if (g.xref) {
        ref = { kind: 'xref', target: xrefTarget(g.xref), bare: false };
      } else if (g.url) {
        // The body, and separately a bracketed [text], are each capped at
        // MAX_SPAN; a genuinely longer one is dropped here rather than
        // reported truncated, or (for an oversized [text]) silently
        // degraded to a bare link that leaks the rejected text. Hitting the
        // cap is distinguished from naturally stopping on trailing
        // punctuation (a paren, a comma, …) by checking whether the body
        // reached the cap exactly AND more of the same URL-body characters
        // still follow — punctuation that ended the match early never does.
        const scheme = g.url.match(URL_SCHEME_RE)[0];
        const bodyLen = g.url.length - scheme.length;
        const nextAfterMatch = text[m.index + m[0].length];
        const bodyTruncated = bodyLen >= MAX_SPAN && nextAfterMatch !== undefined && !/[\s[\]<]/.test(nextAfterMatch);
        const bracketRejected = g.urltext === undefined && text[m.index + g.url.length] === '[';
        if (!bodyTruncated && !bracketRejected) {
          // A URL preceded by one of the constrained-formatting marks
          // carries its closing mark into the greedy body (nothing in the
          // body's character classes excludes `*`/`_`/`#`); strip it back
          // off here if the body does end with the SAME mark that opened it.
          let target = g.url;
          const before = text[m.index - 1];
          if (before && URL_MARK_RE.test(before) && target.endsWith(before)) target = target.slice(0, -1);
          ref = { kind: 'link', target, bare: !g.urltext };
        }
      }
      if (ref && !HAS_ATTR_REF_RE.test(ref.target)) model.links.push({ ...ref, line, block });
      if (m.index > last) model.texts.push({ text: text.slice(last, m.index), line, block });
      last = m.index + m[0].length;
    }
    if (last < text.length) model.texts.push({ text: text.slice(last), line, block });
  });
}

// Where a delimited verbatim block's body sits in `content`. Its line number is
// the opening delimiter's; like Asciidoctor, the block closes at the next line
// that repeats the opening delimiter exactly, or runs to the end of the file.
function diagramOf(b, content, starts, lines, excluded) {
  const line0 = b.getLineNumber() - 1;
  const body = b.getSourceLines();
  const at = (l) => (l < starts.length ? starts[l] : content.length);
  if (DELIMITER_RE.test(lines[line0] ?? '')) {
    const delimiter = lines[line0].trimEnd();
    let closeLine = line0 + 1;
    // A delimiter line the preprocessor drops (inside a false ifdef) closes nothing.
    while (closeLine < lines.length && (excluded.has(closeLine + 1) || lines[closeLine].trimEnd() !== delimiter)) closeLine++;
    // A listing/literal block's own getSourceLines() is the processed body —
    // conditionals already resolved, so it is used as-is. An open block's
    // (`--`) is always empty (its content lives in a nested child block
    // instead), so its body is read straight out of the raw file lines, with
    // any excluded (conditional-dropped) line of its own dropped too.
    const bodyLineNos = [];
    for (let l = line0 + 1; l < closeLine; l++) bodyLineNos.push(l + 1);
    // `excluded` only tracks conditional directives; a raw include:: line is
    // not one (scanIncludes reports it regardless of conditional state), so
    // it is checked for separately here.
    const hasExcluded = bodyLineNos.some((l) => excluded.has(l) || RAW_INCLUDE_LINE_RE.test(lines[l - 1].trim()));
    // A listing/literal body's getSourceLines() still holds secure mode's
    // `link:target[role=include]` rewrite of an include:: line — never
    // prose here either.
    const sourceLines = body.length > 0
      ? body.filter((l) => !INCLUDE_ONLY_RE.test(l.trim()))
      : bodyLineNos.filter((l) => !excluded.has(l) && !RAW_INCLUDE_LINE_RE.test(lines[l - 1].trim())).map((l) => lines[l - 1]);
    return {
      startLine: line0 + 2,
      source: sourceLines.join('\n').trimEnd(),
      blockStart: starts[line0],
      bodyStart: at(line0 + 1),
      bodyEnd: closeLine < lines.length ? starts[closeLine] : content.length,
      // A directive or conditional-excluded line inside the body would be
      // dropped by a swap (it never reaches the rendered diagram as
      // written), so such a body is reported as not swappable rather than
      // silently losing it.
      swappable: !hasExcluded,
    };
  }
  // `[mermaid]` on a paragraph: no delimiters, and a swap that added a blank
  // line would end the paragraph, so it is never swapped automatically.
  return {
    startLine: line0 + 1,
    source: body.join('\n').trimEnd(),
    blockStart: starts[line0],
    bodyStart: starts[line0],
    bodyEnd: at(line0 + body.length),
    swappable: false,
  };
}

const isMermaid = (b) => b.getStyle() === 'mermaid'
  || (b.getStyle() === 'source' && b.getAttribute('language') === 'mermaid');

export default {
  name: 'asciidoc',
  extensions: ['.adoc', '.asciidoc'],
  readmeNames: ['README.adoc', 'README.asciidoc'],

  async parse(content) {
    // A leading BOM is zero-width. Asciidoctor is parsed on `body` (BOM
    // stripped) so it never shows up in a title or a delimiter check, but
    // offsets (starts, blockStart/bodyStart/bodyEnd) must index the ORIGINAL
    // bytes, so `starts` and `lines` stay derived from `content`; only
    // `lines[0]` has the BOM trimmed, so the header-title scan and the
    // delimiter regex on `lines[0]` aren't thrown off by it sitting before
    // the marker on line 1.
    const body = content.startsWith('﻿') ? content.slice(1) : content;
    const logger = MemoryLogger.create();
    const doc = await load(body, { sourcemap: true, safe: 'secure', logger });
    const starts = lineStarts(content);
    const lines = splitLines(content);
    if (lines[0]) lines[0] = lines[0].replace(/^﻿/, '');
    // Computed once, against the document's final attributes: which raw
    // lines the preprocessor drops (see excludedLines above).
    const excluded = excludedLines(lines, doc);
    const model = {
      lines: countLines(content),
      headings: [], paragraphs: [], listItems: [], links: [], texts: [], diagrams: [], diagnostics: [],
    };
    let block = 0;
    const scan = (lineNumbers, rawLines) => {
      scanInline(doc, model, block, lineNumbers, rawLines);
      block++;
    };

    // include:: references, in one pass over the raw lines rather than from
    // secure mode's per-paragraph rewrite: its preprocessing runs before any
    // block-type parsing, so an include:: line is resolved — and reported
    // here — the same way whether it sits in a paragraph, a list item, or a
    // listing/literal block. Skips an excluded (conditional-dropped) line, a
    // `////`-fenced comment block, and a `//` line comment; each include
    // line is its own inline block.
    const scanIncludes = () => {
      let inComment = false;
      for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (COMMENT_FENCE_RE.test(trimmed)) { inComment = !inComment; continue; }
        if (inComment || LINE_COMMENT_RE.test(trimmed)) continue;
        const l = i + 1;
        if (excluded.has(l)) continue;
        const m = trimmed.match(RAW_INCLUDE_LINE_RE);
        if (!m || m[1]) continue;
        const target = resolveAttributes(doc, m[2]);
        if (HAS_ATTR_REF_RE.test(target)) continue;
        model.links.push({ kind: 'include', target, line: l, block, bare: false });
        block++;
      }
    };
    scanIncludes();

    // Secure mode's `link:target[role=include,...]` rewrite of an
    // include:: line is not prose — drop it from a block's own source lines
    // (and the aligned line each one maps to) wherever it falls, including
    // in the middle of a multi-line paragraph. Its reference was already
    // reported, at its true line, by scanIncludes above.
    // Also drops a source line alignLines could not place at a real raw
    // line (`unmatched`) — its position is a guess, and reporting a
    // reference at a guessed line is worse than not reporting it.
    const filterAlignedSrc = (srcLines, aligned) => {
      const text = [];
      const nums = [];
      srcLines.forEach((s, i) => {
        if (aligned.unmatched.has(i) || INCLUDE_ONLY_RE.test(s.trim())) return;
        text.push(s);
        nums.push(aligned.lines[i]);
      });
      return { text, lines: nums };
    };

    // Two raw lines "are the same line" if they match once trailing
    // whitespace is ignored, OR the source line is secure mode's
    // `link:target[role=include]` rewrite of the raw `include::target[...]`
    // line it replaced (same target).
    const sameLine = (src, raw) => {
      if (raw === undefined) return false;
      const a = src.trimEnd();
      const b = raw.trimEnd();
      if (a === b) return true;
      const rewritten = a.match(/^link:(\S+)\[role=include(?:,[^\]]*)?\]$/);
      if (rewritten) {
        const original = b.match(/^include::(\S+?)\[[^\]]*\]$/);
        if (original && original[1] === rewritten[1]) return true;
      }
      // getSourceLines() strips a simple admonition's own label from its
      // first line (`NOTE: text` -> `text`).
      const labeled = b.match(/^(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION):[ \t]+(.*)$/);
      return !!labeled && labeled[1].trimEnd() === a;
    };

    // A conditional (or include) directive is resolved before Asciidoctor
    // ever reports a line number, so a block whose own source spans one
    // reports a position that overshoots its true first line. This recovers
    // the true line for each of a block's (possibly conditional-shortened)
    // source lines by re-finding each one in the raw file: the first line is
    // the nearest match at or before the reported line (never after — the
    // report never undershoots); each later line is the next match forward
    // from the previous one. Excluded lines (conditional directives, and
    // content under a false one) are skipped while searching rather than
    // compared against: a duplicate of the real text sitting inside a
    // dropped region must never be mistaken for the match, whichever
    // direction it is found from.
    //
    // A line that cannot be found this way (`unmatched`) falls back to the
    // reported position, or the previous line plus one — this happens for
    // text Asciidoctor spliced in rather than copied verbatim, chiefly a
    // true single-line `ifdef::a[content]`'s bracket content (which lives,
    // unquoted, inside the directive's own raw line). Since its true
    // position is genuinely unknown, callers filter such a line out of both
    // scanning and reported text rather than attribute a reference to a
    // guessed line.
    // The forward half: given a TRUSTED true first line, chain each later
    // source line to the next raw line that matches it, skipping excluded
    // ones. Shared by alignLines (which finds that first line itself, by
    // backward content search) and the table case (which instead computes
    // it from the kept-line count — see keptLineAt below).
    const chainFromFirst = (first, srcLines, matches = sameLine, maxLine = lines.length) => {
      const unmatched = new Set();
      const result = [first];
      let prev = first;
      for (let i = 1; i < srcLines.length; i++) {
        let found = null;
        for (let l = prev + 1; l <= maxLine; l++) {
          if (excluded.has(l)) continue;
          if (matches(srcLines[i], lines[l - 1])) { found = l; break; }
        }
        if (found === null) { found = Math.min(prev + 1, maxLine); unmatched.add(i); }
        result.push(found);
        prev = found;
      }
      return { lines: result, unmatched };
    };
    const alignLines = (reported, srcLines) => {
      let first = null;
      for (let l = reported; l >= 1; l--) {
        if (excluded.has(l)) continue;
        if (sameLine(srcLines[0], lines[l - 1])) { first = l; break; }
      }
      // An unfound first line (never observed outside a table's nested
      // AsciiDoc cell, whose own line numbers are relative to the cell, not
      // the raw file, so no raw line can ever match) keeps the reported
      // position as a best-effort guess, same as a later unmatched line —
      // but is not itself flagged unmatched: unlike a later line, there is
      // no better-aligned neighbor it could be confused with instead.
      return chainFromFirst(first ?? reported, srcLines);
    };

    // A table cell's own reported lineno comes from the preprocessed line
    // stream the table parser sees, not the raw file — it undercounts by
    // however many lines an excluded conditional dropped earlier IN THE
    // TABLE, an undershoot rather than every other block's overshoot, and
    // not something a content search could resolve (two cells on the same
    // raw line share one lineno, so there is nothing distinguishing one
    // cell's own text to search for). keptLineAt(n) maps it back to the
    // true raw line by counting forward through non-excluded lines from the
    // top of the file.
    const keptLineAt = [];
    for (let i = 0, count = 0; i < lines.length; i++) {
      if (!excluded.has(i + 1)) keptLineAt[++count] = i + 1;
    }

    // A cell's own source line matches a raw line exactly; or the segment
    // right after some occurrence of the table's cell separator (up to the
    // next separator, or end of line) equals it, whatever specifier
    // (colspan `2+`, rowspan `.2+`, duplicate `3*`, alignment `^.^`, style
    // `h`/`m`/…) sits between the previous separator and this one — a
    // linear indexOf-style scan, not a backtracking regex, and the only way
    // to tell two cells on the same raw line apart; or (a format with no
    // single-character separator, e.g. CSV/DSV) the raw line starts with it
    // and has more content after, whatever introduces the next cell or row.
    const cellLineMatches = (src, raw, sep) => {
      const a = src.trimEnd();
      const b = raw.trimEnd();
      if (a === b) return true;
      let at = b.indexOf(sep);
      while (at !== -1) {
        const next = b.indexOf(sep, at + 1);
        const segment = (next === -1 ? b.slice(at + 1) : b.slice(at + 1, next)).trim();
        if (segment === a) return true;
        at = next;
      }
      return a !== '' && b.startsWith(a) && b.slice(a.length).trimStart() !== '';
    };
    // keptLineAt's guess can still be one line early — a bare separator
    // alone on its own line with the cell's real content starting on the
    // next one, or a line comment / other non-cell line the table parser
    // itself skips but excludedLines does not track. Resolved the same way
    // alignment resolves everything else: a forward content search,
    // skipping excluded lines, from the guessed position — bounded to the
    // table's own line range, never searching past it.
    const findCellFirst = (guess, text, sep, minLine, maxLine) => {
      for (let l = Math.max(guess, minLine); l <= maxLine; l++) {
        if (excluded.has(l)) continue;
        if (cellLineMatches(text, lines[l - 1], sep)) return l;
      }
      return Math.min(Math.max(guess, minLine), maxLine);
    };

    // Start lines of every node, so a list item's own text can be cut off at
    // the next thing that starts after it.
    const nodeStarts = new Set();
    for (const b of doc.findBy()) if (b.getLineNumber()) nodeStarts.add(b.getLineNumber());

    // List items and dlist terms have no getSourceLines() of their own to
    // realign against, only a single marker position. Their true line is the
    // nearest raw (and not excluded) line at or before the reported one that
    // still looks like a marker/term line — a conditional wrapped around
    // (part of) the item pushes the reported position past it, the same
    // overshoot alignLines corrects for text-bearing blocks. Skipping
    // excluded lines, rather than merely testing them, also keeps a directive
    // line like `endif::[]` (which contains `::`) from ever being mistaken
    // for a dlist delimiter.
    const trueMarkerLine = (reported, markerRe) => {
      for (let l = reported; l >= 1; l--) {
        if (excluded.has(l)) continue;
        if (markerRe.test(lines[l - 1] ?? '')) return l;
      }
      return reported;
    };

    // A list item's text: its marker line plus continuation lines, up to a
    // blank line, a `+` list continuation, or the next node. An excluded line
    // is skipped rather than ending collection, so kept content after it
    // (e.g. inside a true ifeval) is still gathered. A raw (unrewritten)
    // include line is also skipped here — its reference is reported
    // elsewhere, by the single pass over every raw line.
    const itemLines = (line, stripRe) => {
      const text = [lines[line - 1].replace(stripRe, '')];
      const nums = [line];
      for (let l = line + 1; l <= lines.length; l++) {
        const t = lines[l - 1];
        // Excluded first: a conditional directive's own line can be the
        // SAME item's overshot getLineNumber() (nodeStarts would otherwise
        // read it as a sibling starting here and stop too early).
        if (excluded.has(l)) continue;
        if (t.trim() === '' || t.trim() === '+' || nodeStarts.has(l)) break;
        if (RAW_INCLUDE_RE.test(t.trim())) continue;
        text.push(t);
        nums.push(l);
      }
      return { text, lines: nums };
    };

    // A block's declaring `.Title text` line, found by scanning backward
    // from its own first line over any attribute (`[source,ruby]`) or anchor
    // (`[[id]]`/`[#id]`) lines in between.
    const titleLine = (firstLine) => {
      for (let l = firstLine - 1; l >= 1; l--) {
        const t = lines[l - 1] ?? '';
        if (TITLE_LINE_RE.test(t)) return l;
        if (!ATTRIBUTE_LINE_RE.test(t)) return null;
      }
      return null;
    };
    // getTitle() returns Asciidoctor's HTML-rendered title, not scannable
    // raw text, so a titled block's declaring line is found and scanned on
    // its own — it is never reported as one of the block's own paragraphs.
    const scanTitle = (b, firstLine) => {
      if (!b.getTitle || !b.getTitle()) return;
      const tLine = titleLine(firstLine);
      if (tLine !== null) scan([tLine], [lines[tLine - 1].slice(1)]);
    };

    const walk = (node, ctx) => {
      for (const b of node.getBlocks()) {
        if (Array.isArray(b)) continue; // dlist entries are walked by their list
        const context = b.getContext();
        const line = b.getLineNumber();
        switch (context) {
          case 'section':
          case 'floating_title': {
            const level = b.level + 1;
            const trueLine = trueMarkerLine(line, HEADING_RE);
            const m = (lines[trueLine - 1] ?? '').match(HEADING_RE);
            const title = m ? m[1] : (b.getTitle() ?? '');
            model.headings.push({ level, line: trueLine, title });
            scan([trueLine], [title]);
            walk(b, ctx);
            break;
          }
          case 'paragraph': {
            const src = b.getSourceLines();
            if (isMermaid(b)) { scanTitle(b, line); model.diagrams.push(diagramOf(b, content, starts, lines, excluded)); break; }
            const aligned = alignLines(line, src);
            const filtered = filterAlignedSrc(src, aligned);
            scanTitle(b, filtered.lines[0] ?? aligned.lines[0]);
            if (filtered.text.length > 0) {
              model.paragraphs.push({ line: filtered.lines[0], text: filtered.text.join('\n'), context: ctx.para });
              if (ctx.item) ctx.item.text += ' ' + filtered.text.join('\n');
            }
            scan(filtered.lines, filtered.text);
            break;
          }
          case 'admonition': {
            const src = b.getSourceLines();
            if (b.getContentModel?.() === 'compound' || b.getBlocks().length > 0) {
              scanTitle(b, line);
              walk(b, { ...ctx, para: ctx.para === 'top' ? 'callout' : ctx.para });
            } else {
              const aligned = alignLines(line, src);
              const filtered = filterAlignedSrc(src, aligned);
              scanTitle(b, filtered.lines[0] ?? aligned.lines[0]);
              if (filtered.text.length > 0) {
                model.paragraphs.push({ line: filtered.lines[0], text: filtered.text.join('\n'), context: ctx.para === 'top' ? 'callout' : ctx.para });
                if (ctx.item) ctx.item.text += ' ' + filtered.text.join('\n');
              }
              scan(filtered.lines, filtered.text);
            }
            break;
          }
          case 'ulist':
          case 'olist':
          case 'colist':
            scanTitle(b, line);
            if (ctx.item) ctx.item.hasNestedList = true;
            walk(b, ctx);
            break;
          case 'list_item': {
            const trueLine = trueMarkerLine(line, LIST_MARKER_RE);
            const raw = itemLines(trueLine, LIST_MARKER_RE);
            const item = { line: trueLine, text: raw.text.join('\n'), hasNestedList: false };
            scan(raw.lines, raw.text);
            walk(b, { para: 'list', item });
            model.listItems.push(item);
            break;
          }
          case 'dlist':
            scanTitle(b, line);
            if (ctx.item) ctx.item.hasNestedList = true;
            for (const [terms, desc] of b.getItems()) {
              for (const t of terms) {
                const tLine = trueMarkerLine(t.getLineNumber(), DLIST_DELIM_RE);
                scan([tLine], [lines[tLine - 1].replace(/(?::{2,4}|;;).*$/, '')]);
              }
              if (!desc) continue;
              const reportedDline = desc.getLineNumber();
              const onTermLine = terms.some((t) => t.getLineNumber() === reportedDline);
              const dline = onTermLine ? trueMarkerLine(reportedDline, DLIST_DELIM_RE) : reportedDline;
              const raw = onTermLine
                ? itemLines(dline, DLIST_TERM_RE)
                : itemLines(dline, /^[ \t]+/);
              const item = { line: dline, text: raw.text.join('\n'), hasNestedList: false };
              scan(raw.lines, raw.text);
              walk(desc, { para: 'list', item });
              model.listItems.push(item);
            }
            break;
          case 'table': {
            scanTitle(b, line);
            // Every cell search is bounded to the table's own raw line
            // range — never the rest of the file — both so a guess that is
            // off never wanders into a later row's (or the prose after the
            // table's) identical text, and for linear rather than quadratic
            // time on a large table. The open line is realigned the same
            // way any other block's is; the close is the next line that
            // repeats that exact delimiter text.
            const openLine = trueMarkerLine(line, TABLE_DELIM_RE);
            const delimText = (lines[openLine - 1] ?? '').match(TABLE_DELIM_RE)?.[1];
            let closeLine = lines.length;
            if (delimText) {
              for (let l = openLine + 1; l <= lines.length; l++) {
                if (!excluded.has(l) && lines[l - 1].trimEnd() === delimText) { closeLine = l; break; }
              }
            }
            const sep = b.getAttribute('separator') || '|';
            for (const section of ['head', 'body', 'foot']) {
              for (const row of b.rows[section] ?? []) {
                for (const cell of row) {
                  const inner = cell.getInnerDocument?.();
                  if (inner) { walk(inner, ctx); continue; }
                  const cellLines = cell.source().split('\n');
                  const guess = keptLineAt[cell.lineno] ?? cell.lineno ?? line;
                  const first = findCellFirst(guess, cellLines[0], sep, openLine, closeLine);
                  // An unmatched line here (chainFromFirst's own fallback)
                  // is kept at its guessed position rather than dropped:
                  // the forward search already skips excluded lines, so
                  // unlike a spliced-in single-line conditional, there is no
                  // better-aligned neighbor left for it to be confused with.
                  const aligned = chainFromFirst(first, cellLines, (s, r) => cellLineMatches(s, r, sep), closeLine);
                  scan(aligned.lines, cellLines);
                }
              }
            }
            break;
          }
          case 'image': {
            const trueLine = trueMarkerLine(line, /^image::/);
            scanTitle(b, trueLine);
            const src = lines[trueLine - 1] ?? '';
            scan([trueLine], [src]);
            break;
          }
          case 'listing':
          case 'literal':
            scanTitle(b, line);
            if (isMermaid(b)) model.diagrams.push(diagramOf(b, content, starts, lines, excluded));
            break;
          case 'open':
            // An open block (`--`) holds its content as a nested child, not
            // its own source lines; a `[mermaid]`-styled one is a diagram,
            // same as a listing/literal — its child must not also be walked
            // and read as a stray paragraph.
            scanTitle(b, line);
            if (isMermaid(b)) { model.diagrams.push(diagramOf(b, content, starts, lines, excluded)); break; }
            if (b.getBlocks) walk(b, ctx);
            break;
          case 'quote':
          case 'verse': {
            // A delimited quote holds blocks; a `[quote]` paragraph or a
            // verse holds its text directly.
            const para = ctx.item ? 'list' : 'quote';
            if (b.getBlocks().length > 0) { scanTitle(b, line); walk(b, { ...ctx, para }); break; }
            const src = b.getSourceLines();
            const aligned = alignLines(line, src);
            const filtered = filterAlignedSrc(src, aligned);
            scanTitle(b, filtered.lines[0] ?? aligned.lines[0]);
            if (filtered.text.length > 0) {
              model.paragraphs.push({ line: filtered.lines[0], text: filtered.text.join('\n'), context: para });
              if (ctx.item) ctx.item.text += ' ' + filtered.text.join('\n');
            }
            scan(filtered.lines, filtered.text);
            break;
          }
          default:
            // example, sidebar, preamble, …: containers whose children keep
            // the enclosing context. pass, stem, comment: no prose.
            if (b.getBlocks) walk(b, ctx);
            break;
        }
      }
    };
    // The document title lives in the header, not in the block tree.
    if (doc.hasHeader()) {
      const line = lines.findIndex((l, i) => !excluded.has(i + 1) && /^=[ \t]+\S/.test(l)) + 1;
      if (line > 0) {
        const title = lines[line - 1].match(HEADING_RE)[1];
        model.headings.push({ level: 1, line, title });
        scan([line], [title]);
      }
    }
    walk(doc, { para: 'top', item: null });

    for (const m of logger.getMessages()) {
      const loc = m.getSourceLocation();
      model.diagnostics.push({ line: loc?.lineno ?? 1, message: m.getText() });
    }
    model.headings.sort((a, b) => a.line - b.line);
    model.paragraphs.sort((a, b) => a.line - b.line);
    model.listItems.sort((a, b) => a.line - b.line);
    model.links.sort((a, b) => a.line - b.line || a.block - b.block);
    model.diagrams.sort((a, b) => a.startLine - b.startLine);
    return model;
  },
};
