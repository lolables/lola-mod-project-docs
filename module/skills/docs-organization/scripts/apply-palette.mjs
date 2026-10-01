// Given a palette JSON (one of the four shipped under
// reference/palettes/) and a mermaid source body (no init header, no
// classDefs), emit a full mermaid diagram with the init header +
// classDefs filled in for the chosen palette.
//
// Usage: node apply-palette.mjs <palette.json> <body.mmd> > <output.mmd>
//        node apply-palette.mjs --swap <palette.json> <file.mmd|file.md> [block]
//
// --swap is swap-palette.sh's engine: it strips the existing palette from a
// whole diagram, or from each (or the 1-based `block`) mermaid fence of a .md,
// and re-applies. Refusals print a reason on stderr and exit 2.
//
// The body should reference sysA..sysF via the standard classDef names
// (`:::sysX` or `class X sysY`). The script appends classDef lines only
// for the names the body actually references — diagram types that don't
// support classDef (sequence, ER, journey, gantt, pie) get nothing
// appended and stay parseable.

import { readFileSync } from 'node:fs';
import { isMain } from './is-main.mjs';
import { extractMermaidBlocks } from './lint-mermaid.mjs';

export function initHeader(palette) {
  // primaryTextColor is the EDGE-LABEL / CHART-TITLE color. Setting it to
  // the node text color (white) makes axis labels and chart titles vanish
  // on light backgrounds; setting it dark fixes that but makes default
  // node text dark too. We resolve that with a small themeCSS rule that
  // forces `.node .nodeLabel` to white, so any node without an explicit
  // classDef still gets white text on its palette fill.
  //
  // Per-diagram-type variables (pie*, git*, cScale*, entity*, etc.) are
  // set explicitly because mermaid's per-type theming pipelines ignore
  // most of the cluster/edge-label variables.
  const n = palette.nodes;
  const tw = n.sysA.text;
  const fills = [n.sysA.fill, n.sysB.fill, n.sysC.fill, n.sysD.fill, n.sysE.fill, n.sysF.fill];
  const themeCSS = `.node .nodeLabel{color:${tw}!important;fill:${tw}!important;}`;
  return [
    "%%{init: {'theme': 'base', 'themeVariables': {",
    `  'primaryColor': '${n.sysA.fill}',`,
    `  'primaryTextColor': '${palette.edgeLabel.text}',`,
    `  'primaryBorderColor': '${palette.cluster.border}',`,
    `  'lineColor': '${palette.cluster.border}',`,
    `  'edgeLabelBackground': '${palette.edgeLabel.bg}',`,
    `  'tertiaryColor': '${palette.cluster.fill}',`,
    `  'tertiaryTextColor': '${palette.canvasText}',`,
    `  'tertiaryBorderColor': '${palette.cluster.border}',`,
    `  'clusterBkg': '${palette.cluster.fill}',`,
    `  'clusterBorder': '${palette.cluster.border}',`,
    `  'titleColor': '${palette.canvasText}',`,
    `  'noteBkgColor': '${palette.edgeLabel.bg}',`,
    `  'noteTextColor': '${palette.edgeLabel.text}',`,
    `  'attributeBackgroundColorOdd': '${palette.edgeLabel.bg}',`,
    `  'attributeBackgroundColorEven': '#ffffff',`,
    `  'relationLabelColor': '${palette.edgeLabel.text}',`,
    `  'relationLabelBackground': '${palette.edgeLabel.bg}',`,
    `  'entityFillColor': '${n.sysA.fill}',`,
    `  'entityHeaderTextColor': '${n.sysA.text}',`,
    `  'entityHeaderColor': '${n.sysA.fill}',`,
    `  'altBackground': '${palette.edgeLabel.bg}',`,
    `  'pie1': '${fills[0]}','pie2': '${fills[1]}','pie3': '${fills[2]}',`,
    `  'pie4': '${fills[3]}','pie5': '${fills[4]}','pie6': '${fills[5]}',`,
    `  'pie7': '${fills[0]}','pie8': '${fills[1]}','pie9': '${fills[2]}',`,
    `  'pie10': '${fills[3]}','pie11': '${fills[4]}','pie12': '${fills[5]}',`,
    `  'pieSectionTextColor': '${tw}',`,
    `  'pieTitleTextColor': '${palette.canvasText}',`,
    `  'pieLegendTextColor': '${palette.canvasText}',`,
    `  'pieStrokeColor': '${palette.cluster.border}',`,
    `  'pieOuterStrokeColor': '${palette.cluster.border}',`,
    `  'git0': '${fills[0]}','git1': '${fills[1]}','git2': '${fills[2]}',`,
    `  'git3': '${fills[3]}','git4': '${fills[4]}','git5': '${fills[5]}',`,
    `  'git6': '${fills[0]}','git7': '${fills[1]}',`,
    `  'gitBranchLabel0': '${tw}','gitBranchLabel1': '${tw}','gitBranchLabel2': '${tw}',`,
    `  'gitBranchLabel3': '${tw}','gitBranchLabel4': '${tw}','gitBranchLabel5': '${tw}',`,
    `  'cScale0': '${fills[0]}','cScale1': '${fills[1]}','cScale2': '${fills[2]}',`,
    `  'cScale3': '${fills[3]}','cScale4': '${fills[4]}','cScale5': '${fills[5]}',`,
    `  'cScaleLabel0': '${tw}','cScaleLabel1': '${tw}','cScaleLabel2': '${tw}',`,
    `  'cScaleLabel3': '${tw}','cScaleLabel4': '${tw}','cScaleLabel5': '${tw}',`,
    `  'xyChart': {`,
    `    'plotColorPalette': '${fills.join(',')}',`,
    `    'titleColor': '${palette.canvasText}',`,
    `    'xAxisLabelColor': '${palette.canvasText}',`,
    `    'yAxisLabelColor': '${palette.canvasText}',`,
    `    'xAxisTitleColor': '${palette.canvasText}',`,
    `    'yAxisTitleColor': '${palette.canvasText}',`,
    `    'xAxisLineColor': '${palette.cluster.border}',`,
    `    'yAxisLineColor': '${palette.cluster.border}'`,
    `  },`,
    `  'fontFamily': 'system-ui, sans-serif'`,
    `}, 'themeCSS': '${themeCSS}'}}%%`,
  ].join('\n');
}

export function classDefs(palette, body) {
  const referenced = new Set();
  for (const name of Object.keys(palette.nodes)) {
    const inline = new RegExp(`:::${name}\\b`);
    const declared = new RegExp(`\\bclass\\s+[^\\n]+\\s+${name}\\b`);
    if (inline.test(body) || declared.test(body)) referenced.add(name);
  }
  if (referenced.size === 0) return '';
  const lines = [];
  for (const name of referenced) {
    const def = palette.nodes[name];
    lines.push(`  classDef ${name} fill:${def.fill},color:${def.text},stroke:${palette.cluster.border}`);
  }
  return lines.join('\n');
}

export function applyPalette(palette, body) {
  const trimmed = body.trimEnd();
  const defs = classDefs(palette, trimmed);
  return defs ? `${initHeader(palette)}\n${trimmed}\n${defs}\n` : `${initHeader(palette)}\n${trimmed}\n`;
}

// Drop the %%{init}%% header (its opening line through the line holding
// `}%%`) and the classDefs of this palette's own classes. Custom classDefs
// stay: applyPalette re-adds only palette classes, so stripping them would
// silently lose their colors.
export function stripPalette(palette, source) {
  const own = new Set(Object.keys(palette.nodes));
  const out = [];
  let inHeader = false;
  for (const line of source.split('\n')) {
    if (!inHeader && /^\s*%%\{\s*init\s*:/.test(line)) inHeader = true;
    if (inHeader) {
      if (line.includes('}%%')) inHeader = false;
      continue;
    }
    const def = /^\s*classDef\s+(\S+)/.exec(line);
    if (def && own.has(def[1])) continue;
    out.push(line);
  }
  if (inHeader) throw new Error('unterminated %%{init}%% header (no closing }%%)');
  return out.join('\n');
}

// `where` names the diagram in the refusal message.
export function swapDiagram(palette, source, where) {
  const body = stripPalette(palette, source);
  if (!/\S/.test(body)) {
    // An empty file, or the caller redirected output onto the input
    // (`... f > f` truncates f before this reads it). A header-only diagram
    // would look like success and silently drop the diagram.
    throw new Error(`no diagram body in ${where} (empty file, or output redirected onto the input?)`);
  }
  return applyPalette(palette, body);
}

// Swap every mermaid fence of a .md, or only the 1-based `block`, splicing
// each new diagram between its fences so every byte outside them is kept.
// Fences are found (and numbered) exactly as lint-mermaid reports them.
export function swapFences(palette, content, file, block) {
  const blocks = extractMermaidBlocks(content, file);
  if (blocks.length === 0) {
    // An empty (or fence-less) .md is what `... p f.md > f.md` leaves behind
    // once the shell truncates f.md before this reads it — same trap as the
    // .mmd empty-file case in swapDiagram, so it gets the same hint.
    throw new Error(`no mermaid fences in ${file} (empty file, or output redirected onto the input?)`);
  }
  if (block !== undefined && block > blocks.length) {
    throw new Error(`block ${block} requested but ${file} has ${blocks.length} mermaid fence(s)`);
  }
  let out = '';
  let pos = 0;
  for (const b of block === undefined ? blocks : [blocks[block - 1]]) {
    const n = b.block;
    // Indented fences (list items, blockquotes) need their indent re-applied
    // to every new line; refuse rather than break the enclosing structure.
    const opensAtColumn0 = b.fenceStart === 0 || content[b.fenceStart - 1] === '\n';
    const closesAtColumn0 = content[b.bodyEnd - 1] === '\n';
    if (!opensAtColumn0 || !closesAtColumn0) {
      throw new Error(`block ${n} of ${file} is indented (not a top-level fence); swap it by hand`);
    }
    out += content.slice(pos, b.bodyStart) +
      swapDiagram(palette, content.slice(b.bodyStart, b.bodyEnd), `block ${n} of ${file}`);
    pos = b.bodyEnd;
  }
  return out + content.slice(pos);
}

function swap([paletteFile, file, block]) {
  const palette = JSON.parse(readFileSync(paletteFile, 'utf8'));
  const content = readFileSync(file, 'utf8');
  try {
    process.stdout.write(file.endsWith('.md')
      ? swapFences(palette, content, file, block === undefined ? undefined : Number(block))
      : swapDiagram(palette, content, file));
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--swap') {
    if (args.length < 3 || args.length > 4) {
      console.error('usage: apply-palette.mjs --swap <palette.json> <file.mmd|file.md> [block]');
      process.exit(2);
    }
    swap(args.slice(1));
    return;
  }
  const [paletteFile, bodyFile] = args;
  if (!paletteFile || !bodyFile) {
    console.error('usage: apply-palette.mjs <palette.json> <body.mmd>');
    process.exit(2);
  }
  const palette = JSON.parse(readFileSync(paletteFile, 'utf8'));
  const body = readFileSync(bodyFile, 'utf8');
  process.stdout.write(applyPalette(palette, body));
}

if (isMain(import.meta.url)) {
  main();
}
