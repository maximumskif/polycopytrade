// Track N1 (docs/IMPROVEMENT_PLAN.md): pre-registration as tooling. Item 44
// wrote an out-of-sample test's hypothesis, data window and exact pass rule
// into the plan BEFORE running it -- and that is what showed the discovery
// window's best bucket (+10.8%) to be a best-of-8 artifact (-2.3% out of
// sample). This module is the pure half of `npm run prereg`
// (src/cli/prereg.ts does the file/git I/O):
//
//   - a tiny pass-rule language, e.g.
//       ciLowerBound > 0 at slippageBps=50 AND roi > 0 at slippageBps=300
//     each clause = <metric> <op> <number>[%] [at key=value[,key=value]],
//     clauses joined by AND only (an OR is a way to get two shots at
//     passing -- deliberately not supported);
//   - evaluation against a research result's rows (researchResult.ts): the
//     registration's `select` plus each clause's `at` must pick EXACTLY one
//     row, otherwise evaluation refuses rather than guessing;
//   - tamper evidence: the registration block is hashed (canonical JSON,
//     sorted keys) when created; evaluate refuses on a mismatch, and the CLI
//     additionally compares against the file's first committed version;
//   - result/registration consistency: same script, same resolved args
//     (output-only flags like --json/--cache excluded), same requested data
//     window, observed data inside it, and a result generated AFTER the
//     registration was created.

import { z } from "zod";
import { sha256, WindowSchema, type DateWindow, type ResearchResult, type ResultRow } from "./researchResult";

export const PREREG_SCHEMA_ID = "polycopytrade.preregistration/v1";

export const METRICS = ["roi", "ciLowerBound", "ciUpperBound", "winRate", "trials", "events", "netPnl"] as const;
export type Metric = (typeof METRICS)[number];
export type Op = ">=" | "<=" | ">" | "<";

export interface RuleClause {
  text: string;
  metric: Metric;
  op: Op;
  value: number;
  at: Record<string, string>;
}

const CLAUSE_RE = /^([A-Za-z]+)\s*(>=|<=|>|<)\s*(-?\d+(?:\.\d+)?)(%?)(?:\s+at\s+(.+))?$/;

// key=value pairs separated by commas and/or whitespace.
export function parseKeyValues(raw: string, what: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of raw.split(/[\s,]+/).filter(Boolean)) {
    const eq = part.indexOf("=");
    if (eq <= 0 || eq === part.length - 1) throw new Error(`${what}: expected key=value, got "${part}"`);
    const key = part.slice(0, eq);
    if (key in out) throw new Error(`${what}: "${key}" given twice`);
    out[key] = part.slice(eq + 1);
  }
  return out;
}

export function parseRule(rule: string): RuleClause[] {
  const trimmed = rule.trim();
  if (trimmed === "") throw new Error("pass rule is empty");
  if (/\bOR\b|\|\|/i.test(trimmed)) throw new Error("pass rule: only AND is supported (an OR is a second shot at passing)");
  return trimmed.split(/\s+AND\s+|\s*&&\s*/i).map((raw) => {
    const text = raw.trim();
    const m = CLAUSE_RE.exec(text);
    if (!m) throw new Error(`pass rule: can't parse clause "${text}" (expected "<metric> <op> <number> [at key=value,...]")`);
    const metric = METRICS.find((x) => x.toLowerCase() === m[1].toLowerCase());
    if (!metric) throw new Error(`pass rule: unknown metric "${m[1]}" (known: ${METRICS.join(", ")})`);
    const value = Number(m[3]) / (m[4] === "%" ? 100 : 1);
    return { text, metric, op: m[2] as Op, value, at: m[5] ? parseKeyValues(m[5], `clause "${text}"`) : {} };
  });
}

export function mergeSelector(base: Record<string, string>, at: Record<string, string>, clauseText: string): Record<string, string> {
  for (const [k, v] of Object.entries(at)) {
    if (k in base && base[k] !== v) throw new Error(`clause "${clauseText}": at ${k}=${v} conflicts with select ${k}=${base[k]}`);
  }
  return { ...base, ...at };
}

function describeSelector(sel: Record<string, string>): string {
  return Object.entries(sel)
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
}

// Exactly one row whose key equals the selector on every selector key AND
// whose key has no dimension the selector left unpinned -- so "roi > 0" can
// never silently pick whichever of several slippage rows came first.
export function selectRow(rows: ResultRow[], selector: Record<string, string>): ResultRow {
  const matches = rows.filter((r) => Object.entries(selector).every(([k, v]) => k in r.key && String(r.key[k]) === v));
  if (matches.length === 0) throw new Error(`no result row matches {${describeSelector(selector)}}`);
  if (matches.length > 1) {
    const free = [...new Set(matches.flatMap((r) => Object.keys(r.key).filter((k) => !(k in selector))))];
    throw new Error(`${matches.length} result rows match {${describeSelector(selector)}} -- the rule must also pin: ${free.join(", ")}`);
  }
  const unpinned = Object.keys(matches[0].key).filter((k) => !(k in selector));
  if (unpinned.length > 0) throw new Error(`selector {${describeSelector(selector)}} leaves ${unpinned.join(", ")} unpinned`);
  return matches[0];
}

function compare(observed: number, op: Op, value: number): boolean {
  switch (op) {
    case ">":
      return observed > value;
    case ">=":
      return observed >= value;
    case "<":
      return observed < value;
    case "<=":
      return observed <= value;
  }
}

export interface ClauseOutcome {
  clause: string;
  selector: Record<string, string>;
  observed: number | null;
  pass: boolean;
  note?: string;
}

// Throws (= refuse) when the rule can't be applied to these rows; returns
// per-clause outcomes otherwise. A null metric (e.g. no CI: too few
// trials/events) is a FAIL, not a refusal -- an under-powered test that
// can't show its edge failed to show it.
export function evaluateRule(
  passRule: string,
  select: Record<string, string>,
  rows: ResultRow[]
): { pass: boolean; clauses: ClauseOutcome[] } {
  const clauses = parseRule(passRule).map((c): ClauseOutcome => {
    const selector = mergeSelector(select, c.at, c.text);
    const row = selectRow(rows, selector);
    const observed = row.metrics[c.metric];
    if (observed === null)
      return { clause: c.text, selector, observed: null, pass: false, note: `${c.metric} is n/a (too few trials/events)` };
    return { clause: c.text, selector, observed, pass: compare(observed, c.op, c.value) };
  });
  return { pass: clauses.every((c) => c.pass), clauses };
}

// Possible values per result-row key for a script run with given args
// (scripts export this so `create` can reject a rule that could never
// select a row, instead of discovering it after a 40-minute pull).
export type RowKeySpace = Record<string, (string | number)[]>;

export function checkRuleAgainstKeySpace(passRule: string, select: Record<string, string>, space: RowKeySpace): string[] {
  const problems: string[] = [];
  for (const c of parseRule(passRule)) {
    const sel = mergeSelector(select, c.at, c.text);
    for (const [key, values] of Object.entries(space)) {
      if (!(key in sel)) problems.push(`clause "${c.text}" doesn't pin ${key} (one of: ${values.join(", ")})`);
      else if (!values.map(String).includes(sel[key]))
        problems.push(`clause "${c.text}": ${key}=${sel[key]} is not produced (one of: ${values.join(", ")})`);
    }
    for (const key of Object.keys(sel))
      if (!(key in space)) problems.push(`clause "${c.text}": unknown key "${key}" (keys: ${Object.keys(space).join(", ")})`);
  }
  return problems;
}

export const RegistrationSchema = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  createdAt: z.string(),
  gitCommit: z.string().nullable(),
  gitDirty: z.boolean().nullable(),
  hypothesis: z.string().min(1),
  script: z.string().min(1),
  args: z.array(z.string()),
  // The script's own parseArgs() output for `args` (defaults filled in), when
  // the script is known to the helper; null otherwise (argv compared as-is).
  resolvedArgs: z.record(z.string(), z.unknown()).nullable(),
  window: WindowSchema,
  select: z.record(z.string(), z.string()),
  metric: z.string().min(1),
  passRule: z.string().min(1),
  notes: z.string().optional(),
});
export type Registration = z.infer<typeof RegistrationSchema>;

const ClauseOutcomeSchema = z.object({
  clause: z.string(),
  selector: z.record(z.string(), z.string()),
  observed: z.number().nullable(),
  pass: z.boolean(),
  note: z.string().optional(),
});

export const EvaluationSchema = z.object({
  evaluatedAt: z.string(),
  verdict: z.enum(["PASS", "FAIL"]),
  clauses: z.array(ClauseOutcomeSchema),
  result: z.object({
    file: z.string(),
    sha256: z.string(),
    generatedAt: z.string(),
    gitCommit: z.string().nullable(),
    gitDirty: z.boolean().nullable(),
    requestedWindow: WindowSchema.nullable(),
    observedWindow: WindowSchema.nullable(),
  }),
  registrationCommit: z.string().nullable(),
  registrationCommittedAt: z.string().nullable(),
  warnings: z.array(z.string()),
});
export type Evaluation = z.infer<typeof EvaluationSchema>;

export const PreregistrationSchema = z.object({
  schema: z.literal(PREREG_SCHEMA_ID),
  registration: RegistrationSchema,
  registrationSha256: z.string(),
  evaluation: EvaluationSchema.nullable(),
});
export type Preregistration = z.infer<typeof PreregistrationSchema>;

// JSON with object keys sorted at every level -- the hashed form, so
// re-indenting or re-ordering keys doesn't count as tampering but any
// change of content does.
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function registrationHash(reg: Registration): string {
  return sha256(canonicalJson(reg));
}

export function newPreregistration(reg: Registration): Preregistration {
  const registration = RegistrationSchema.parse(reg);
  parseRule(registration.passRule); // refuse to register a rule that can't be evaluated
  if (registration.window.start > registration.window.end)
    throw new Error(`window start ${registration.window.start} is after end ${registration.window.end}`);
  return { schema: PREREG_SCHEMA_ID, registration, registrationSha256: registrationHash(registration), evaluation: null };
}

// Integrity problems of a parsed file on its own (git history is checked by
// the CLI). Empty = intact.
export function integrityProblems(p: Preregistration): string[] {
  const actual = registrationHash(p.registration);
  return actual === p.registrationSha256
    ? []
    : [
        `registration block was modified after creation (sha256 ${actual.slice(0, 12)}... != recorded ${p.registrationSha256.slice(0, 12)}...)`,
      ];
}

// Arg keys that only say where output goes -- they can differ between the
// registered command and the actual run.
export const OUTPUT_ONLY_ARGS = ["json", "cache"];

function withoutKeys(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.includes(k)));
}

export function normalizeArgv(argv: string[]): string[] {
  return argv.filter((a) => !OUTPUT_ONLY_ARGS.some((k) => a === `--${k}` || a.startsWith(`--${k}=`))).sort();
}

// Everything that makes `result` not the pre-registered run. Empty = matches.
export function resultMismatches(reg: Registration, result: ResearchResult): string[] {
  const out: string[] = [];
  if (result.script !== reg.script) out.push(`script: result is "${result.script}", registered "${reg.script}"`);
  if (reg.resolvedArgs) {
    const want = canonicalJson(withoutKeys(reg.resolvedArgs, OUTPUT_ONLY_ARGS));
    const got = canonicalJson(withoutKeys(result.args, OUTPUT_ONLY_ARGS));
    if (want !== got) out.push(`args: result ran with ${got}, registered ${want}`);
  } else {
    const want = normalizeArgv(reg.args).join(" ");
    const got = normalizeArgv(result.argv).join(" ");
    if (want !== got) out.push(`args: result ran with "${got}", registered "${want}"`);
  }
  if (result.requestedWindow && (result.requestedWindow.start !== reg.window.start || result.requestedWindow.end !== reg.window.end)) {
    out.push(`window: result requested ${fmtWindow(result.requestedWindow)}, registered ${fmtWindow(reg.window)}`);
  }
  if (!result.observedWindow) out.push("window: result has no observed data window (no data?)");
  else if (result.observedWindow.start < reg.window.start || result.observedWindow.end > reg.window.end) {
    out.push(
      `window: result's data spans ${fmtWindow(result.observedWindow)}, outside registered ${fmtWindow(reg.window)} (a reused cache mixing in other dates?)`
    );
  }
  if (!(Date.parse(result.generatedAt) > Date.parse(reg.createdAt))) {
    out.push(`timing: result generated ${result.generatedAt}, not after registration ${reg.createdAt}`);
  }
  return out;
}

export function fmtWindow(w: DateWindow): string {
  return `${w.start}..${w.end}`;
}

export function parseWindow(raw: string): DateWindow {
  const m = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(raw.trim());
  if (!m) throw new Error(`--window must be YYYY-MM-DD..YYYY-MM-DD, got "${raw}"`);
  return WindowSchema.parse({ start: m[1], end: m[2] });
}
