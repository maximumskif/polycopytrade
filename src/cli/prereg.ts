// Track N1 (docs/IMPROVEMENT_PLAN.md): `npm run prereg` -- register an
// out-of-sample test BEFORE running it, then stamp the run's result
// against the registered pass rule. Pure logic lives in
// src/research/preregistration.ts; this file does file + git I/O.
//
//   npm run prereg -- create <slug> --script=<npm script> --args="<args>"
//       --hypothesis="..." --select=k=v,... --rule="<pass rule>"
//       [--window=YYYY-MM-DD..YYYY-MM-DD] [--metric="..."] [--notes="..."]
//   npm run prereg -- evaluate <slug> --result=<result.json>
//   npm run prereg -- list
//   npm run prereg -- show <slug>
//
// Files: docs/preregistrations/<created date>-<slug>.json, COMMITTED (see
// docs/preregistrations/README.md for why and for a worked example).
// POLYCOPY_PREREG_DIR overrides the directory (tests / dry runs).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  canonicalJson,
  checkRuleAgainstKeySpace,
  evaluateRule,
  fmtWindow,
  integrityProblems,
  newPreregistration,
  parseKeyValues,
  parseWindow,
  PreregistrationSchema,
  registrationHash,
  resultMismatches,
  type Preregistration,
  type RowKeySpace,
} from "../research/preregistration";
import { gitState, REPO_ROOT, ResearchResultSchema, sha256, type DateWindow } from "../research/researchResult";
import * as weather from "../research/weatherFavorites";
import * as volatility from "../research/volatilityBreakout";

const PREREG_DIR = process.env.POLYCOPY_PREREG_DIR
  ? path.resolve(process.env.POLYCOPY_PREREG_DIR)
  : path.join(REPO_ROOT, "docs", "preregistrations");

// Scripts that emit --json results. Registering one of these resolves its
// args through the script's own parser (defaults filled in, so a later
// default change is caught), derives the data window where the args fix
// it, and checks the rule against the rows the script can produce.
interface ScriptSpec {
  parseArgs(argv: string[]): Record<string, unknown>;
  keySpace(args: Record<string, unknown>): RowKeySpace;
  windowFor?(args: Record<string, unknown>): DateWindow;
}
const SCRIPTS: Record<string, ScriptSpec> = {
  "weather-favorites": {
    parseArgs: (argv) => ({ ...weather.parseArgs(argv) }),
    keySpace: (a) => weather.resultKeySpace(a as unknown as weather.Args),
    windowFor: (a) => weather.requestedWindow(a as unknown as weather.Args),
  },
  "volatility-breakout": {
    parseArgs: (argv) => ({ ...volatility.parseArgs(argv) }),
    keySpace: (a) => volatility.resultKeySpace(a as unknown as volatility.Args),
  },
};

function fail(msg: string): never {
  console.error(`prereg: ${msg}`);
  process.exit(1);
}

function flags(argv: string[]): { positional: string[]; opts: Record<string, string> } {
  const positional: string[] = [];
  const opts: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    // "--name=value" or "--name value"
    if (eq > 0) opts[a.slice(2, eq)] = a.slice(eq + 1);
    else if (i + 1 < argv.length) opts[a.slice(2)] = argv[++i];
    else fail(`${a} needs a value`);
  }
  return { positional, opts };
}

function files(): string[] {
  if (!existsSync(PREREG_DIR)) return [];
  return readdirSync(PREREG_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}-.+\.json$/.test(f))
    .sort();
}

function slugOf(file: string): string {
  return file.replace(/^\d{4}-\d{2}-\d{2}-/, "").replace(/\.json$/, "");
}

function findFile(slug: string): string {
  const match = files().filter((f) => slugOf(f) === slug);
  if (match.length === 0) fail(`no pre-registration "${slug}" in ${PREREG_DIR}`);
  if (match.length > 1) fail(`several files for "${slug}": ${match.join(", ")}`);
  return path.join(PREREG_DIR, match[0]);
}

function load(file: string): Preregistration {
  return PreregistrationSchema.parse(JSON.parse(readFileSync(file, "utf8")));
}

function git(dir: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

// The commit that first added `file`, and the registration block as it was
// in that commit -- the tamper check that doesn't rely on the in-file hash
// (anyone editing the file could recompute that).
function firstCommitted(file: string): { commit: string; committedAt: string; registrationSha256: string | null } | null {
  const dir = path.dirname(file);
  const log = git(dir, ["log", "--diff-filter=A", "--format=%H %cI", "--", path.basename(file)]);
  if (!log) return null;
  const [commit, committedAt] = log.split("\n").pop()!.split(" ");
  const root = git(dir, ["rev-parse", "--show-toplevel"]);
  if (!root) return null;
  const rel = path.relative(root, file);
  const original = git(root, ["show", `${commit}:${rel}`]);
  let registrationSha256: string | null;
  try {
    registrationSha256 = original ? registrationHash(PreregistrationSchema.parse(JSON.parse(original)).registration) : null;
  } catch {
    registrationSha256 = null; // unparseable first version: treated as a mismatch
  }
  return { commit, committedAt, registrationSha256 };
}

function create(slug: string | undefined, opts: Record<string, string>): void {
  if (!slug) fail('usage: create <slug> --script=... --args="..." --hypothesis="..." --select=k=v,... --rule="..." [--window=A..B]');
  for (const required of ["script", "hypothesis", "rule"]) if (!opts[required]) fail(`create needs --${required}`);
  if (files().some((f) => slugOf(f) === slug))
    fail(`slug "${slug}" is already registered -- pick a new slug; registrations are never edited`);

  const args = (opts.args ?? "").split(/\s+/).filter(Boolean);
  const spec = SCRIPTS[opts.script];
  const select = opts.select ? parseKeyValues(opts.select, "--select") : {};
  let resolvedArgs: Record<string, unknown> | null = null;
  let window: DateWindow | null = opts.window ? parseWindow(opts.window) : null;
  if (spec) {
    resolvedArgs = spec.parseArgs(args);
    if (!resolvedArgs.json)
      console.warn(`note: --args has no --json=<path>; add one when you run it (output-only flags don't count toward the match)`);
    const problems = checkRuleAgainstKeySpace(opts.rule, select, spec.keySpace(resolvedArgs));
    if (problems.length) fail(`the rule can't select exactly one row:\n  ${problems.join("\n  ")}`);
    if (spec.windowFor) {
      const derived = spec.windowFor(resolvedArgs);
      if (window && fmtWindow(window) !== fmtWindow(derived))
        fail(`--window ${fmtWindow(window)} != the args' window ${fmtWindow(derived)}`);
      if (!resolvedArgs.asOf) fail(`${opts.script}'s window moves with the date -- pin it with --asOf=YYYY-MM-DD in --args`);
      window = derived;
    }
  } else {
    console.warn(`note: "${opts.script}" isn't a known --json script (${Object.keys(SCRIPTS).join(", ")}); args will be compared verbatim`);
  }
  if (!window) fail("create needs --window=YYYY-MM-DD..YYYY-MM-DD (this script doesn't derive one from its args)");

  const { commit, dirty } = gitState();
  const now = new Date();
  const prereg = newPreregistration({
    slug,
    createdAt: now.toISOString(),
    gitCommit: commit,
    gitDirty: dirty,
    hypothesis: opts.hypothesis,
    script: opts.script,
    args,
    resolvedArgs,
    window,
    select,
    metric: opts.metric ?? "event-clustered bootstrap ROI (computeStrategyResult)",
    passRule: opts.rule,
    ...(opts.notes ? { notes: opts.notes } : {}),
  });
  mkdirSync(PREREG_DIR, { recursive: true });
  const file = path.join(PREREG_DIR, `${now.toISOString().slice(0, 10)}-${slug}.json`);
  writeFileSync(file, JSON.stringify(prereg, null, 2) + "\n", { flag: "wx" });
  console.log(`Registered ${path.relative(process.cwd(), file)}`);
  console.log(`  ${opts.script} ${args.join(" ")}`);
  console.log(`  window ${fmtWindow(window)}; pass = ${opts.rule}${Object.keys(select).length ? ` [select ${opts.select}]` : ""}`);
  console.log(`  sha256 ${prereg.registrationSha256}`);
  console.log(`Commit it NOW, before running (the commit is the proof it came first):`);
  console.log(`  git add ${path.relative(process.cwd(), file)} && git commit -m "Pre-register ${slug}"`);
}

function evaluate(slug: string | undefined, opts: Record<string, string>): void {
  if (!slug || !opts.result) fail("usage: evaluate <slug> --result=<result.json>");
  const file = findFile(slug);
  const prereg = load(file);
  if (prereg.evaluation)
    fail(
      `${slug} was already evaluated (${prereg.evaluation.verdict} at ${prereg.evaluation.evaluatedAt}); a registration gets one evaluation`
    );

  const refusals = integrityProblems(prereg);
  const committed = firstCommitted(file);
  const warnings: string[] = [];
  if (committed) {
    if (committed.registrationSha256 !== registrationHash(prereg.registration)) {
      refusals.push(`registration differs from its first committed version (${committed.commit.slice(0, 10)})`);
    }
  } else {
    warnings.push("registration file is not committed -- nothing but its own timestamp shows it was written before the run");
  }

  const resultText = readFileSync(opts.result, "utf8");
  const result = ResearchResultSchema.parse(JSON.parse(resultText));
  refusals.push(...resultMismatches(prereg.registration, result));
  if (committed && !(Date.parse(committed.committedAt) < Date.parse(result.generatedAt))) {
    warnings.push(`registration was committed ${committed.committedAt}, after the result was generated ${result.generatedAt}`);
  }
  if (result.gitDirty) warnings.push("result was generated from a checkout with uncommitted changes");
  if (refusals.length) fail(`refusing to evaluate ${slug}:\n  ${refusals.join("\n  ")}`);

  let outcome: ReturnType<typeof evaluateRule>;
  try {
    outcome = evaluateRule(prereg.registration.passRule, prereg.registration.select, result.rows);
  } catch (err) {
    fail(`refusing to evaluate ${slug}: ${(err as Error).message}`);
  }
  const verdict = outcome.pass ? "PASS" : "FAIL";
  prereg.evaluation = {
    evaluatedAt: new Date().toISOString(),
    verdict,
    clauses: outcome.clauses,
    result: {
      file: path.relative(REPO_ROOT, path.resolve(opts.result)),
      sha256: sha256(resultText),
      generatedAt: result.generatedAt,
      gitCommit: result.gitCommit,
      gitDirty: result.gitDirty,
      requestedWindow: result.requestedWindow,
      observedWindow: result.observedWindow,
    },
    registrationCommit: committed?.commit ?? null,
    registrationCommittedAt: committed?.committedAt ?? null,
    warnings,
  };
  PreregistrationSchema.parse(prereg);
  writeFileSync(file, JSON.stringify(prereg, null, 2) + "\n");

  console.log(`${slug}: ${verdict}`);
  for (const c of outcome.clauses) {
    const obs = c.observed === null ? "n/a" : c.observed.toFixed(4);
    console.log(`  ${c.pass ? "pass" : "FAIL"}  ${c.clause}  [observed ${obs}; ${canonicalJson(c.selector)}]${c.note ? ` ${c.note}` : ""}`);
  }
  for (const w of warnings) console.log(`  warning: ${w}`);
  console.log(`Stamped ${path.relative(process.cwd(), file)} -- commit it (git add ... && git commit -m "Evaluate ${slug}: ${verdict}")`);
}

function list(): void {
  const all = files();
  if (all.length === 0) {
    console.log(`no pre-registrations in ${PREREG_DIR}`);
    return;
  }
  for (const f of all) {
    const full = path.join(PREREG_DIR, f);
    try {
      const p = load(full);
      const intact = integrityProblems(p).length === 0 ? "intact" : "MODIFIED";
      const status = p.evaluation ? p.evaluation.verdict : "pending";
      const r = p.registration;
      console.log(`${status.padEnd(7)} ${intact.padEnd(8)} ${f}`);
      console.log(`        ${r.script} ${fmtWindow(r.window)}: ${r.passRule}`);
    } catch (err) {
      console.log(`INVALID          ${f}: ${(err as Error).message.split("\n")[0]}`);
    }
  }
}

function show(slug: string | undefined): void {
  if (!slug) fail("usage: show <slug>");
  const file = findFile(slug);
  const p = load(file);
  console.log(JSON.stringify(p, null, 2));
  const problems = integrityProblems(p);
  console.log(problems.length ? `\nMODIFIED: ${problems.join("; ")}` : "\nintegrity: registration hash matches");
}

function main(): void {
  const [command, ...rest] = process.argv.slice(2);
  const { positional, opts } = flags(rest);
  switch (command) {
    case "create":
      return create(positional[0], opts);
    case "evaluate":
      return evaluate(positional[0], opts);
    case "list":
      return list();
    case "show":
      return show(positional[0]);
    default:
      fail("usage: npm run prereg -- create|evaluate|list|show ... (see src/cli/prereg.ts header)");
  }
}

main();
