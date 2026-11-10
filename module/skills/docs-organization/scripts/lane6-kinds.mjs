// Reply validation and finding mapping for each lane6.mjs job kind.
//
// validate(payload, ctx) -> {ok: true, payload} | {ok: false, reason, remediation}
//   ctx: {file, text, lines, start, end, claims?, candidates?}; start..end is
//   the chunk range, or 1..lines for a whole-file kind. `remediation` is
//   appended to the retried prompt, so it speaks to the subagent.
// toFindings(payload, job) -> {findings: [{code, severity, file, line, note}], other: [string]}
//   severity and note follow docs-audit.md's report schema; `other` holds the
//   lines /docs-update skips (dropped and suppressed candidates).
// groundingNote: whether the prompt carries the file's grounding note. Rounds
// 15/16 in eval/REPORT.md measured the drift ledger and plain language without
// it, so those kinds stay without it.

export const MODES = ['tutorial', 'how-to', 'reference', 'explanation', 'landing'];
export const ADJUDICATED = ['DOUBLE_NEGATIVE', 'SLASH_ALTERNATIVE', 'VOLATILE_DETAIL', 'TIME_ANCHORED'];
const SUPPRESSIBLE = ['VOLATILE_DETAIL', 'TIME_ANCHORED'];
const DIAGRAM_TYPES = ['flowchart', 'sequenceDiagram', 'stateDiagram-v2', 'erDiagram'];
const GROUNDING_MAX_WORDS = 70;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string' && v.trim() !== '';
const words = (s) => s.trim().split(/\s+/).length;
const bad = (reason, remediation) => ({ ok: false, reason, remediation });
const none = () => ({ findings: [], other: [] });
const lineProblem = (n, ctx) => (Number.isInteger(n) && n >= ctx.start && n <= ctx.end ? null : `has line ${n}, outside lines ${ctx.start}-${ctx.end}`);

// The orchestrator copies each reply into a heredoc and may HTML-escape it on
// the way (seen in a smoke run: `>` arrived as `&gt;`). Decoding happens on
// the reply and, for quote matching, on the file too, so a doc that really
// contains `&amp;` still matches. `&amp;` is decoded last so `&amp;gt;`
// becomes `&gt;`, not `>`.
const ENTITIES = [['&lt;', '<'], ['&gt;', '>'], ['&quot;', '"'], ['&#39;', "'"], ['&amp;', '&']];
const decodeEntities = (s) => ENTITIES.reduce((acc, [e, c]) => acc.replaceAll(e, c), s);

// A subagent quotes rendered text: emphasis and code marks and line wrapping
// differ from the source, and a long quote may elide text with an ellipsis
// anywhere. Every fragment between ellipses must appear in the file, in order.
// Case is ignored: a quote starting mid-sentence lower-cases its first word.
const canon = (s) => decodeEntities(s).replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
function quoteIn(quote, ctx) {
  const parts = canon(quote).split(/\.\.\.|…/).map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return false;
  const text = canon(ctx.text);
  let from = 0;
  for (const p of parts) {
    const at = text.indexOf(p, from);
    if (at < 0) return false;
    from = at + p.length;
  }
  return true;
}

// "12", 12, or "40-47" -> {start, end}; anything else -> null.
export function lineSpan(v) {
  if (Number.isInteger(v) && v > 0) return { start: v, end: v };
  const m = typeof v === 'string' ? v.match(/^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/) : null;
  if (!m) return null;
  const start = Number(m[1]);
  const end = m[2] === undefined ? start : Number(m[2]);
  return start > 0 && end >= start ? { start, end } : null;
}

// The last fenced json block, else the whole reply, else its outermost {...}.
export function extractJson(raw) {
  const reply = decodeEntities(raw);
  const fences = [...reply.matchAll(/```json[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/g)];
  const body = fences.length ? fences[fences.length - 1][1] : reply.trim();
  try {
    return JSON.parse(body);
  } catch (e) {
    const a = body.indexOf('{');
    const b = body.lastIndexOf('}');
    if (a < 0 || b <= a) throw e;
    return JSON.parse(body.slice(a, b + 1));
  }
}

function eachEntry(p, key, check) {
  if (!isObj(p) || !Array.isArray(p[key])) {
    return bad(`reply has no "${key}" array`, `Reply with one JSON object {"${key}": [...]}; use an empty array when there is nothing to report.`);
  }
  for (const [i, entry] of p[key].entries()) {
    const problem = isObj(entry) ? check(entry) : 'is not an object';
    if (problem) return bad(`${key}[${i}] ${problem}`, `Fix ${key}[${i}]: it ${problem}. Keep every other entry as it was.`);
  }
  return { ok: true, payload: p };
}

const finding = (job, code, severity, line, note) => ({ code, severity, file: job.file, line, note });
const mapFindings = (fn) => (p, job) => ({ findings: p.findings.map((f) => fn(f, job)), other: [] });

export const KINDS = {
  grounding: {
    label: 'Grounding',
    groundingNote: false,
    validate(p, ctx) {
      if (!isObj(p)) return bad('reply is not a JSON object', 'Reply with one JSON object holding mode, audience, outcome and mode_mixing.');
      if (!MODES.includes(p.mode)) return bad(`mode "${p.mode}" is not one of ${MODES.join(', ')}`, `Set mode to one of ${MODES.join(', ')}.`);
      for (const k of ['audience', 'outcome']) {
        if (!isStr(p[k])) return bad(`${k} is missing`, `Give ${k} as a non-empty string.`);
        if (words(p[k]) > GROUNDING_MAX_WORDS) return bad(`${k} is over ${GROUNDING_MAX_WORDS} words`, `Shorten ${k} to ${GROUNDING_MAX_WORDS} words or fewer.`);
      }
      const m = p.mode_mixing;
      if (m === false) return { ok: true, payload: p };
      if (!isObj(m)) return bad('mode_mixing is neither false nor an object', 'Set mode_mixing to false, or to {"intruding", "section", "quote"}.');
      if (p.mode === 'landing') return bad('a landing page is never mode-mixing', 'Set mode_mixing to false for a landing page.');
      if (!MODES.includes(m.intruding) || m.intruding === 'landing' || m.intruding === p.mode) {
        return bad(`mode_mixing.intruding "${m.intruding}" is not a mode other than ${p.mode}`, 'Name the intruding mode: tutorial, how-to, reference, or explanation, other than the primary mode.');
      }
      if (!isStr(m.section)) return bad('mode_mixing.section is missing', 'Name the section that holds the intruding content.');
      if (!isStr(m.quote) || !quoteIn(m.quote, ctx)) return bad('mode_mixing.quote is not text from the file', `Quote one line of ${ctx.file} exactly as written.`);
      return { ok: true, payload: p };
    },
    toFindings(p, job) {
      if (p.mode_mixing === false) return none();
      const m = p.mode_mixing;
      return { findings: [finding(job, 'MODE_MIXING', 'info', null, `primary ${p.mode}; intruding ${m.intruding}; section "${m.section}"`)], other: [] };
    },
  },

  adjudicate: {
    label: 'Lane 3 adjudication',
    groundingNote: false,
    validate(p, ctx) {
      const byId = new Map(ctx.candidates.map((c) => [c.id, c]));
      if (!isObj(p) || !Array.isArray(p.decisions)) return bad('reply has no "decisions" array', 'Reply with {"decisions": [...]}, one entry per candidate id.');
      const seen = new Set();
      for (const [i, d] of p.decisions.entries()) {
        if (!isObj(d) || !byId.has(d.id)) return bad(`decisions[${i}] names no listed candidate`, `Use only the ids ${[...byId.keys()].join(', ')}.`);
        if (seen.has(d.id)) return bad(`${d.id} is decided twice`, `Give ${d.id} exactly one decision.`);
        seen.add(d.id);
        if (!['keep', 'drop', 'suppress'].includes(d.decision)) return bad(`${d.id} decision "${d.decision}" is not keep, drop, or suppress`, 'Use keep, drop, or suppress.');
        const code = byId.get(d.id).code;
        if (d.decision === 'suppress' && !SUPPRESSIBLE.includes(code)) return bad(`${d.id} is ${code}, which cannot be suppressed`, 'Only VOLATILE_DETAIL and TIME_ANCHORED may be suppressed; keep or drop it.');
        if (d.decision !== 'keep' && !isStr(d.reason)) return bad(`${d.id} has no reason`, 'Give a reason for every drop, and the genre for every suppress.');
      }
      const missing = [...byId.keys()].filter((id) => !seen.has(id));
      if (missing.length) return bad(`no decision for ${missing.join(', ')}`, `Decide every candidate: ${missing.join(', ')}.`);
      return { ok: true, payload: p };
    },
    toFindings(p, job) {
      const byId = new Map(job.params.candidates.map((c) => [c.id, c]));
      const out = none();
      for (const d of p.decisions) {
        const c = byId.get(d.id);
        if (d.decision === 'keep') out.findings.push(finding(job, c.code, 'info', c.line, c.message));
        else if (d.decision === 'drop') out.other.push(`dropped: ${c.code} — ${job.file}:${c.line} — ${d.reason}; not for /docs-update`);
        else out.other.push(`suppressed: ${c.code} — ${job.file} (${d.reason}); not for /docs-update`);
      }
      return out;
    },
  },

  'plain-language': {
    label: 'Plain language',
    groundingNote: false,
    validate: (p, ctx) => eachEntry(p, 'findings', (f) => {
      if (!['NOUN_STRING', 'HIDDEN_VERB'].includes(f.code)) return `has code "${f.code}", not NOUN_STRING or HIDDEN_VERB`;
      const lp = lineProblem(f.line, ctx);
      if (lp) return lp;
      if (!isStr(f.quote) || !quoteIn(f.quote, ctx)) return 'quotes text that is not in the file';
      if (!isStr(f.why) || !isStr(f.rewrite)) return 'lacks why or rewrite';
      return null;
    }),
    toFindings: mapFindings((f, job) => finding(job, f.code, 'info', f.line, `"${f.quote}" — ${f.why}; rewrite: "${f.rewrite}"`)),
  },

  'drift-extract': {
    label: 'Content drift (extract)',
    groundingNote: false,
    validate: (p, ctx) => eachEntry(p, 'claims', (c) => {
      if (!['fact', 'set'].includes(c.kind)) return `has kind "${c.kind}", not fact or set`;
      const span = lineSpan(c.line);
      if (!span || span.start < ctx.start || span.start > ctx.end || span.end > ctx.lines) return `has line "${c.line}", not a line or range starting in ${ctx.start}-${ctx.end}`;
      if (!isStr(c.quote) || !quoteIn(c.quote, ctx)) return 'quotes text that is not in the file';
      if (!isStr(c.target)) return 'has no target (use "?" when unclear)';
      return null;
    }),
    toFindings: () => none(),
  },

  'drift-verify': {
    label: 'Content drift (verify)',
    groundingNote: false,
    // A reply may omit ids; lane6.mjs re-dispatches the rest (spec: partial result).
    validate(p, ctx) {
      const ids = new Set(ctx.claims.map((c) => c.id));
      if (!isObj(p) || !Array.isArray(p.verdicts)) return bad('reply has no "verdicts" array', 'Reply with {"verdicts": [...]}, one entry per claim id.');
      const seen = new Set();
      for (const [i, v] of p.verdicts.entries()) {
        if (!isObj(v) || !ids.has(v.id)) return bad(`verdicts[${i}] names no listed claim`, `Use only the ids ${[...ids].join(', ')}.`);
        if (seen.has(v.id)) return bad(`${v.id} has two verdicts`, `Give ${v.id} exactly one verdict.`);
        seen.add(v.id);
        if (!['match', 'drift', 'unverifiable'].includes(v.verdict)) return bad(`${v.id} verdict "${v.verdict}" is not match, drift, or unverifiable`, 'Use match, drift, or unverifiable.');
        if (!isStr(v.evidence)) return bad(`${v.id} has no evidence`, 'Give file:line evidence for every verdict.');
        if (v.verdict === 'drift' && (!isStr(v.code_says) || typeof v.instructs !== 'boolean')) {
          return bad(`${v.id} is drift without code_says or instructs`, 'For a drift verdict give code_says and instructs (true or false).');
        }
      }
      return { ok: true, payload: p };
    },
    toFindings(p, job) {
      const byId = new Map(job.params.allClaims.map((c) => [c.id, c]));
      const findings = p.verdicts.filter((v) => v.verdict === 'drift').map((v) => {
        const c = byId.get(v.id);
        return finding(job, 'CONTENT_DRIFT', v.instructs ? 'blocker' : 'warning', lineSpan(c.line).start, `doc: "${c.quote}"; code: ${v.code_says} (${v.evidence})`);
      });
      return { findings, other: [] };
    },
  },

  'drift-cited': {
    label: 'Content drift',
    groundingNote: true,
    validate: (p, ctx) => eachEntry(p, 'findings', (f) => {
      if (!['CONTENT_DRIFT', 'NOT_VERIFIABLE'].includes(f.code)) return `has code "${f.code}", not CONTENT_DRIFT or NOT_VERIFIABLE`;
      const lp = lineProblem(f.line, ctx);
      if (lp) return lp;
      if (!isStr(f.claim) || !isStr(f.source)) return 'lacks claim or source';
      if (f.code === 'CONTENT_DRIFT' && (!isStr(f.source_says) || typeof f.instructs !== 'boolean')) return 'is CONTENT_DRIFT without source_says or instructs';
      return null;
    }),
    toFindings: mapFindings((f, job) => (f.code === 'NOT_VERIFIABLE'
      ? finding(job, 'NOT_VERIFIABLE', 'info', f.line, `"${f.claim}" rests on unread source ${f.source}`)
      : finding(job, 'CONTENT_DRIFT', f.instructs ? 'blocker' : 'warning', f.line, `doc: "${f.claim}"; ${f.source}: ${f.source_says}`))),
  },

  'diagram-drift': {
    label: 'Diagram drift',
    groundingNote: false,
    validate: (p) => eachEntry(p, 'findings', (f) => {
      if (!isStr(f.element)) return 'names no node or edge';
      if (!isStr(f.code_says) || !isStr(f.evidence)) return 'lacks code_says or evidence';
      return null;
    }),
    toFindings: mapFindings((f, job) => finding(job, 'CONTENT_DRIFT', 'warning', job.params.startLine, `diagram ${f.element}: ${f.code_says} (${f.evidence})`)),
  },

  'missing-diagrams': {
    label: 'Missing diagrams',
    groundingNote: true,
    validate: (p, ctx) => eachEntry(p, 'findings', (f) => {
      if (!isStr(f.section)) return 'names no section';
      const lp = lineProblem(f.line, ctx);
      if (lp) return lp;
      if (!DIAGRAM_TYPES.includes(f.type)) return `has type "${f.type}", not one of ${DIAGRAM_TYPES.join(', ')}`;
      if (!isStr(f.why)) return 'has no justification';
      return null;
    }),
    toFindings: mapFindings((f, job) => finding(job, 'MISSING_DIAGRAM', 'info', f.line, `${f.section} — ${f.type}: ${f.why}`)),
  },

  'cold-read': {
    label: 'Cold read',
    groundingNote: true,
    validate: (p, ctx) => eachEntry(p, 'findings', (f) => {
      const lp = lineProblem(f.line, ctx);
      if (lp) return lp;
      if (!isStr(f.quote) || !quoteIn(f.quote, ctx)) return 'quotes text that is not in the file';
      if (!isStr(f.why)) return 'has no why';
      if (typeof f.actionable !== 'boolean') return 'has actionable that is not true or false';
      return null;
    }),
    toFindings: mapFindings((f, job) => finding(job, 'COLD_READ', f.actionable ? 'warning' : 'info', f.line, `${f.actionable ? 'actionable: ' : ''}"${f.quote}" — ${f.why}`)),
  },

  completeness: {
    label: 'Completeness for type',
    groundingNote: true,
    validate: (p, ctx) => eachEntry(p, 'findings', (f) => {
      if (f.line !== null) {
        const lp = lineProblem(f.line, ctx);
        if (lp) return lp;
      }
      if (!isStr(f.missing) || !isStr(f.blocks)) return 'lacks missing or blocks';
      return null;
    }),
    toFindings: mapFindings((f, job) => finding(job, 'INCOMPLETE_FOR_TYPE', 'info', f.line, `${f.missing} — ${f.blocks}`)),
  },

  'procedure-structure': {
    label: 'Structure for procedures',
    groundingNote: true,
    validate: (p, ctx) => eachEntry(p, 'findings', (f) => {
      const lp = lineProblem(f.line, ctx);
      if (lp) return lp;
      if (!isStr(f.run) || !isStr(f.why)) return 'lacks run or why';
      if (!Number.isInteger(f.steps) || f.steps < 1) return 'has steps that is not a positive integer';
      return null;
    }),
    toFindings: mapFindings((f, job) => finding(job, 'NEEDS_STRUCTURE', 'info', f.line, `${f.run} — about ${f.steps} steps unbroken; ${f.why}`)),
  },

  'hero-demo': {
    label: 'Hero demo',
    groundingNote: true,
    validate(p) {
      if (isObj(p) && Array.isArray(p.findings) && p.findings.length > 1) return bad('reply has more than one finding; at most one is allowed', 'Return at most one MISSING_DEMO finding, for the hero slot.');
      return eachEntry(p, 'findings', (f) => {
        if (!Array.isArray(f.commands) || !f.commands.length || !f.commands.every(isStr)) return 'has no command sequence';
        if (!isStr(f.success) || !isStr(f.format)) return 'lacks success or format';
        return null;
      });
    },
    toFindings: mapFindings((f, job) => finding(job, 'MISSING_DEMO', 'info', null, `record: ${f.commands.join('; ')}; success: ${f.success}; format: ${f.format}`)),
  },
};

// A failed adjudication must not lose the script's candidates: report them
// as check-prose produced them, marked unjudged.
export function unjudged(job) {
  return job.params.candidates.map((c) => finding(job, c.code, 'info', c.line, `${c.message} (not adjudicated)`));
}
