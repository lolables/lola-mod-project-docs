import { contrastRatio, resolveColor } from './contrast.mjs';
import { validateMermaid } from './vendor/merval.mjs';
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isMain } from './is-main.mjs';
import { formatFor } from './formats/index.mjs';

const LIGHT_BG = '#ffffff';
const DARK_BG = '#1e1e1e';
const APPROVED_CLASSNAMES = new Set([
  'sysA', 'sysB', 'sysC', 'sysD', 'sysE', 'sysF', 'edgeLabel',
]);
// LLM-configuration files describe agent behavior, not the project, and
// are excluded from documentation audits per docs-organization SKILL.md
// ("Scope of audit"). Applies to directory traversal only — an explicit
// file argument is still honored.
const LLM_CONFIG_BASENAMES = new Set([
  'CLAUDE.md', 'AGENTS.md', 'GEMINI.md', '.cursorrules',
]);
const CONTRAST_TEXT = 4.5;   // WCAG AA for text
const CONTRAST_BG = 3.0;     // WCAG threshold for non-text graphical objects
// Relative to the skill root, so the path resolves in an installed skill.
const HOUSE_STYLE_REF = 'reference/mermaid-house-style.md';

// Valid mermaid flowchart shapes the vendored merval grammar does not parse
// (it knows only [] () (()) {} and the slash-delimited forms). merval reports
// them as an unclosed bracket, which points away from the cause. The capture
// in UNSUPPORTED_SHAPE_RE maps to an entry here; '(((' precedes the others so
// it wins at the same position. The node id must not follow `<` or `/`, so an
// HTML tag in a label (`<b>`, `</b>`) is not read as the asymmetric `>`.
const UNSUPPORTED_SHAPES = {
  '(((': { name: 'double circle', syntax: '(((…)))' },
  '([': { name: 'stadium', syntax: '([…])' },
  '[[': { name: 'subroutine', syntax: '[[…]]' },
  '[(': { name: 'cylinder', syntax: '[(…)]' },
  '{{': { name: 'hexagon', syntax: '{{…}}' },
  '@{': { name: 'expanded-syntax', syntax: '@{ shape: … }' },
  '>': { name: 'asymmetric', syntax: '>…]' },
};
const UNSUPPORTED_SHAPE_RE = /(?<![\w<\/])\w+(\(\(\(|\(\[|\[\[|\[\(|\{\{|@\{|>)/;

// 1-based line number of character offset `index` in `text`.
function lineAt(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (text[i] === '\n') line++;
  return line;
}

// Returns the %%{init}%% header and its 1-based line, or null.
export function extractInitBlock(source) {
  const m = /%%\{\s*init\s*:\s*([\s\S]*?)\}%%/.exec(source);
  return m ? { text: m[0], line: lineAt(source, m.index) } : null;
}

// When merval rejects `lineNo` of a flowchart and that line puts an
// unsupported shape opener right after a node id, return the shape. Quoted
// labels and |edge labels| are blanked first so their text cannot match.
function findUnsupportedShape(source, lineNo) {
  const init = extractInitBlock(source);
  const body = init ? source.replace(init.text, '') : source;
  const kind = body.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('%%'));
  if (!kind || !/^(flowchart|graph)\b/.test(kind)) return null;
  const line = source.split('\n')[lineNo - 1];
  if (line === undefined) return null;
  const bare = line.replace(/"[^"]*"/g, '""').replace(/\|[^|]*\|/g, '||');
  const m = UNSUPPORTED_SHAPE_RE.exec(bare);
  return m ? UNSUPPORTED_SHAPES[m[1]] : null;
}

// Detect `node["label"]:::className` — inline class assignment on a node
// with an explicit shape. Merval rejects this even though the mermaid
// live editor accepts it. Returns the first occurrence with line/column.
export function findInlineClassUse(source) {
  const lines = source.split('\n');
  // Pattern: identifier + (shape-bracket) + label + close-bracket + :::class
  // Shapes: [text], (text), {text}, [[text]], ((text)), etc.
  const re = /(\w+)[\[\(\{].*?[\]\)\}]:::([A-Za-z_]\w*)/;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (m) {
      return {
        line: i + 1,
        column: m.index + 1,
        match: m[0],
        nodeId: m[1],
        className: m[2],
      };
    }
  }
  return null;
}

// The color properties of a classDef/style body (`fill:#fff,color:white,…`),
// each as { value, hex } — `hex` is null when the value cannot be resolved.
function colorProps(body) {
  const props = new Map();
  for (const part of body.split(',')) {
    const m = /^\s*([\w-]+)\s*:\s*(.*?)\s*;?\s*$/.exec(part);
    if (m) props.set(m[1].toLowerCase(), m[2]);
  }
  const prop = (key) => (props.has(key)
    ? { value: props.get(key), hex: resolveColor(props.get(key)) }
    : null);
  return { fill: prop('fill'), color: prop('color'), stroke: prop('stroke') };
}

// `keyword` is `classDef` or `style`; both are `<keyword> <name> <props>`.
function extractColorRules(source, keyword) {
  const out = [];
  const re = new RegExp(`^\\s*${keyword}\\s+([^\\s,]+)[ \\t]+(.+)$`, 'gm');
  let m;
  while ((m = re.exec(source)) !== null) {
    // `^\s*` can span blank lines, so locate the keyword, not the match start.
    const line = lineAt(source, m.index + m[0].indexOf(keyword));
    out.push({ name: m[1], ...colorProps(m[2]), line });
  }
  return out;
}

// `yellow (#ffff00)` for a named color, the hex alone otherwise.
const describe = (c) => (c.value === c.hex ? c.hex : `${c.value} (${c.hex})`);

// LOW_CONTRAST_* findings for one classDef or style rule. `label` names the
// rule in the message (`classDef "sysA"`, `style "A"`).
function contrastFindings(label, rule) {
  const findings = [];
  const fill = rule.fill?.hex ? rule.fill : null;
  const color = rule.color?.hex ? rule.color : null;
  if (fill && color) {
    const textVsFill = contrastRatio(fill.hex, color.hex);
    if (textVsFill < CONTRAST_TEXT) {
      findings.push({
        code: 'LOW_CONTRAST_TEXT',
        severity: 'blocker',
        line: rule.line,
        message:
          `${label}: text ${describe(color)} on fill ${describe(fill)} ` +
          `is ${textVsFill.toFixed(2)}:1 — needs >= ${CONTRAST_TEXT}:1 (AA).`,
      });
    }
  }
  if (fill) {
    for (const [code, name, bg] of [
      ['LOW_CONTRAST_LIGHT_BG', 'light', LIGHT_BG],
      ['LOW_CONTRAST_DARK_BG', 'dark', DARK_BG],
    ]) {
      const ratio = contrastRatio(fill.hex, bg);
      if (ratio < CONTRAST_BG) {
        findings.push({
          code,
          severity: 'blocker',
          line: rule.line,
          message:
            `${label}: fill ${describe(fill)} vs ${name} bg ${bg} ` +
            `is ${ratio.toFixed(2)}:1 — needs >= ${CONTRAST_BG}:1.`,
        });
      }
    }
  }
  return findings;
}

// merval's verdict as a single finding. Lines are 1-based within `source`.
function syntaxFinding(source, err) {
  const shape = err?.line ? findUnsupportedShape(source, err.line) : null;
  if (shape) {
    return {
      code: 'SYNTAX_ERROR',
      severity: 'blocker',
      line: err.line,
      column: err.column,
      message:
        `${err.message} — likely cause: merval does not support the ` +
        `${shape.name} shape \`${shape.syntax}\` (valid mermaid, but outside ` +
        `the linter's grammar). Use [text], (text), ((text)) or {text}; see ` +
        `${HOUSE_STYLE_REF} "Syntax constraints".`,
      suggestion: err.suggestion,
    };
  }
  // Inline `:::sysX` on a node with an explicit shape is a common gotcha —
  // merval rejects it but the error message ("Adjacent nodes 'web' and
  // 'sysA'…") doesn't hint at the cause. Surface a finding pointing at the fix.
  const inlineClass = findInlineClassUse(source);
  if (inlineClass) {
    return {
      code: 'INLINE_CLASS_NOT_SUPPORTED',
      severity: 'blocker',
      line: inlineClass.line,
      column: inlineClass.column,
      message:
        `Inline class assignment on a node with an explicit shape ` +
        `(${inlineClass.match}) is rejected by the linter. Declare the ` +
        `node first, then assign with a separate \`class\` statement: ` +
        `\`class ${inlineClass.nodeId} ${inlineClass.className}\`.`,
    };
  }
  if (!err) {
    return {
      code: 'SYNTAX_ERROR',
      severity: 'blocker',
      line: 1,
      message: 'Diagram failed validation (no error details available).',
    };
  }
  return {
    code: 'SYNTAX_ERROR',
    severity: 'blocker',
    line: err.line ?? 1,
    column: err.column,
    message: err.message,
    suggestion: err.suggestion,
  };
}

// Findings carry a 1-based `line` within `source`. The header, class-name and
// contrast checks read the raw text, not merval's parse, so they run even
// when merval rejects the diagram — one syntax error never hides them.
export async function lintDiagram(source) {
  const findings = [];

  const v = validateMermaid(source);
  if (!v.isValid) findings.push(syntaxFinding(source, v.errors?.[0]));

  const init = extractInitBlock(source);
  if (!init) {
    findings.push({
      code: 'MISSING_HOUSE_STYLE_HEADER',
      severity: 'blocker',
      line: 1,
      message:
        `Diagram is missing the %%{init}%% house-style header. See ${HOUSE_STYLE_REF}.`,
    });
  } else {
    const initBlock = init.text;
    // Warn if the header looks like a pre-palette-update legacy header.
    // Required signals (in any one of the 4 current palettes): clusterBkg
    // and primaryTextColor set to a non-white value. The legacy header set
    // primaryTextColor to '#ffffff' (which makes chart titles, axis labels,
    // sankey/radar node labels, ER attributes, and edge labels invisible).
    const hasClusterBkg = /'clusterBkg'\s*:/.test(initBlock);
    const whitePrimaryText = /'primaryTextColor'\s*:\s*'#(fff|ffffff)'/i.test(initBlock);
    if (!hasClusterBkg || whitePrimaryText) {
      const reasons = [];
      if (!hasClusterBkg) reasons.push("missing 'clusterBkg' (subgraph cluster fills will use mermaid's brown default)");
      if (whitePrimaryText) reasons.push("'primaryTextColor' is white — chart titles, axis labels, ER attributes, and edge labels will be invisible on light backgrounds");
      findings.push({
        code: 'LEGACY_HOUSE_STYLE_HEADER',
        severity: 'warning',
        line: init.line,
        message:
          'Init header is the legacy form (' + reasons.join('; ') +
          `). Replace with one of the four palette headers — see ${HOUSE_STYLE_REF}.`,
      });
    }
  }

  for (const def of extractColorRules(source, 'classDef')) {
    if (!APPROVED_CLASSNAMES.has(def.name)) {
      findings.push({
        code: 'UNAPPROVED_CLASSNAME',
        severity: 'warning',
        line: def.line,
        message:
          `classDef "${def.name}" is not in the approved set. ` +
          `Use one of: ${[...APPROVED_CLASSNAMES].join(', ')}.`,
      });
      continue;
    }
    findings.push(...contrastFindings(`classDef "${def.name}"`, def));
  }

  // A `style` statement colors one node outside the palette, so it is the
  // per-node form of an unapproved classDef: a warning. Unlike an unapproved
  // classDef its colors are still contrast-checked — the statement names the
  // exact colors the node renders with.
  for (const rule of extractColorRules(source, 'style')) {
    if (!rule.fill && !rule.color && !rule.stroke) continue;
    findings.push({
      code: 'UNAPPROVED_STYLE',
      severity: 'warning',
      line: rule.line,
      message:
        `style "${rule.name}" sets colors outside the palette. Assign an ` +
        `approved class instead, e.g. \`class ${rule.name} sysA\` ` +
        `(one of: ${[...APPROVED_CLASSNAMES].join(', ')}). See ${HOUSE_STYLE_REF}.`,
    });
    findings.push(...contrastFindings(`style "${rule.name}"`, rule));
  }
  return findings;
}

// A .mmd is one whole diagram. Any other file is parsed by its format adapter
// (formats/index.mjs), whose diagrams carry `startLine` (the 1-based file line
// of the first diagram line), `blockStart` and [bodyStart, bodyEnd) offsets
// into the original text, and `swappable` — swap-palette.sh splices by these,
// so it numbers blocks exactly as the findings do. `block` is the 1-based
// number `swap-palette.sh --block` takes; null for a .mmd. A file no format
// owns has no blocks.
export async function extractMermaidBlocks(content, filename) {
  if (filename.endsWith('.mmd')) {
    return [{ source: content, blockIndex: 0, block: null, startLine: 1 }];
  }
  const format = formatFor(filename);
  if (!format) return [];
  const { diagrams } = await format.parse(content);
  return diagrams.map((d, i) => ({
    source: d.source,
    blockIndex: i,
    block: i + 1,
    startLine: d.startLine,
    blockStart: d.blockStart,
    bodyStart: d.bodyStart,
    bodyEnd: d.bodyEnd,
    swappable: d.swappable,
  }));
}

export function walk(target) {
  const out = [];
  const stat = statSync(target);
  if (stat.isFile()) {
    if (target.endsWith('.mmd') || formatFor(target)) out.push(target);
    return out;
  }
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    if (entry.name === '__fixtures__') continue;
    if (LLM_CONFIG_BASENAMES.has(entry.name)) continue;
    const p = join(target, entry.name);
    out.push(...walk(p));
  }
  return out;
}

function formatHuman(results, blockerCount) {
  const warningCount = results.reduce(
    (acc, r) => acc + r.findings.filter((f) => f.severity === 'warning').length,
    0,
  );
  if (results.length === 0) {
    return 'lint-mermaid: ok — no findings.\n';
  }
  const lines = [];
  for (const r of results) {
    lines.push(`${r.file}${r.block ? ` (block ${r.block})` : ''}:`);
    for (const f of r.findings) {
      const where = f.line ? ` line ${f.line}${f.column ? `:${f.column}` : ''}` : '';
      const tag = f.severity === 'blocker' ? '✖' : '⚠';
      lines.push(`  ${tag} ${f.code}${where}`);
      // Wrap message at ~80 cols, indented under the tag.
      for (const chunk of f.message.match(/.{1,76}(\s|$)|.{1,76}/g) ?? [f.message]) {
        lines.push(`    ${chunk.trim()}`);
      }
      if (f.suggestion) lines.push(`    suggestion: ${f.suggestion}`);
    }
    lines.push('');
  }
  const parts = [];
  if (blockerCount) parts.push(`${blockerCount} blocker${blockerCount === 1 ? '' : 's'}`);
  if (warningCount) parts.push(`${warningCount} warning${warningCount === 1 ? '' : 's'}`);
  // `results` has one entry per block with findings; a doc can hold several.
  const blocks = results.length;
  const files = new Set(results.map((r) => r.file)).size;
  lines.push(
    `lint-mermaid: ${parts.join(', ')} in ${blocks} block${blocks === 1 ? '' : 's'} ` +
    `across ${files} file${files === 1 ? '' : 's'}.`,
  );
  return lines.join('\n') + '\n';
}

async function main(argv) {
  const args = argv.slice(2);
  const json = args.includes('--json');
  const targets = args.filter((a) => a !== '--json');
  if (targets.length === 0) {
    console.error('usage: lint-mermaid.mjs [--json] <file-or-dir>...');
    process.exit(2);
  }

  const results = [];
  for (const target of targets) {
    for (const file of walk(target)) {
      const content = readFileSync(file, 'utf8');
      const blocks = await extractMermaidBlocks(content, file);
      for (const block of blocks) {
        const findings = (await lintDiagram(block.source)).map((f) => ({
          ...f,
          line: block.startLine + f.line - 1,
          block: block.block,
        }));
        if (findings.length > 0) {
          results.push({ file, blockIndex: block.blockIndex, block: block.block, findings });
        }
      }
    }
  }

  const blockerCount = results.reduce(
    (acc, r) => acc + r.findings.filter((f) => f.severity === 'blocker').length,
    0,
  );

  if (json) {
    process.stdout.write(
      JSON.stringify(
        {
          status: results.length === 0 ? 'ok' : 'findings',
          blockerCount,
          results,
        },
        null,
        2,
      ) + '\n',
    );
  } else {
    process.stdout.write(formatHuman(results, blockerCount));
  }
  // Any finding, warnings included, is exit 1 (SKILL.md contract). A gate
  // that should fail only on blockers reads `blockerCount` from --json.
  process.exit(results.length > 0 ? 1 : 0);
}

export { formatHuman };

if (isMain(import.meta.url)) {
  main(process.argv).catch((e) => {
    console.error('lint-mermaid: unexpected error:', e);
    process.exit(2);
  });
}
