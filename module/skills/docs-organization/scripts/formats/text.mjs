// Line arithmetic shared by every format adapter. One line-break rule for all
// of them — markdown-it's normalize rule, /\r\n?|\n/ — so LF, CRLF, and
// CR-only files report the same line numbers whichever parser read them.

const NEWLINE_RE = /\r\n?|\n/g;
const NEWLINE_SPLIT_RE = new RegExp(NEWLINE_RE.source);

// Source lines, without their terminators.
export function splitLines(content) {
  return content.split(NEWLINE_SPLIT_RE);
}

// Number of lines; a trailing line break does not start another line.
export function countLines(content) {
  if (content === '') return 0;
  const parts = splitLines(content);
  if (parts[parts.length - 1] === '') parts.pop();
  return parts.length;
}

// Character offset at which each 0-based line starts.
export function lineStarts(content) {
  const starts = [0];
  for (const m of content.matchAll(NEWLINE_RE)) starts.push(m.index + m[0].length);
  return starts;
}
