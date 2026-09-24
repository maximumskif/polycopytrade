import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalJson,
  checkRuleAgainstKeySpace,
  evaluateRule,
  integrityProblems,
  newPreregistration,
  normalizeArgv,
  parseRule,
  parseWindow,
  registrationHash,
  resultMismatches,
  selectRow,
  type Registration,
} from "../src/research/preregistration";
import { RESULT_SCHEMA_ID, withSlippage, type ResearchResult, type ResultRow } from "../src/research/researchResult";
import { parseArgs as weatherArgs, requestedWindow, resultKeySpace } from "../src/research/weatherFavorites";
import { parseArgs as volArgs, resultKeySpace as volKeySpace } from "../src/research/volatilityBreakout";
import type { BacktestTrial } from "../src/domain/types";

const ITEM_44_RULE = "ciLowerBound > 0 at slippageBps=50 AND roi > 0 at slippageBps=300";

function row(key: ResultRow["key"], m: Partial<ResultRow["metrics"]> = {}): ResultRow {
  return {
    key,
    metrics: {
      trials: 100,
      events: 50,
      winRate: 0.8,
      roi: 0.05,
      netPnl: 5,
      ciLowerBound: 0.01,
      ciUpperBound: 0.09,
      meetsMinimumSample: true,
      ...m,
    },
  };
}

function registration(overrides: Partial<Registration> = {}): Registration {
  return {
    slug: "weather-70-85-oos",
    createdAt: "2026-09-24T10:00:00.000Z",
    gitCommit: "abc",
    gitDirty: false,
    hypothesis: "70-85c @24h favorites have positive ROI out of sample",
    script: "weather-favorites",
    args: ["--leadHours=24", "--skipDays=43", "--days=43", "--asOf=2026-09-24", "--sensitivityBps=300"],
    resolvedArgs: null,
    window: { start: "2026-07-01", end: "2026-08-12" },
    select: { bucket: "70-85", leadHours: "24", grouping: "event" },
    metric: "event-clustered bootstrap ROI",
    passRule: ITEM_44_RULE,
    ...overrides,
  };
}

function result(overrides: Partial<ResearchResult> = {}): ResearchResult {
  return {
    schema: RESULT_SCHEMA_ID,
    script: "weather-favorites",
    argv: ["--asOf=2026-09-24", "--days=43", "--skipDays=43", "--leadHours=24", "--sensitivityBps=300", "--json=data/x.json"],
    args: {},
    requestedWindow: { start: "2026-07-01", end: "2026-08-12" },
    observedWindow: { start: "2026-07-01", end: "2026-08-12" },
    generatedAt: "2026-09-24T11:00:00.000Z",
    gitCommit: "abc",
    gitDirty: false,
    comparisons: null,
    rows: [],
    ...overrides,
  };
}

test("parseRule parses item 44's rule, percentages and case-insensitive metrics", () => {
  const clauses = parseRule(ITEM_44_RULE);
  assert.equal(clauses.length, 2);
  assert.deepEqual(clauses[0], {
    text: "ciLowerBound > 0 at slippageBps=50",
    metric: "ciLowerBound",
    op: ">",
    value: 0,
    at: { slippageBps: "50" },
  });
  assert.deepEqual(clauses[1].at, { slippageBps: "300" });
  const [pctClause] = parseRule("ROI >= 2.5% at slippageBps=50, grouping=date");
  assert.equal(pctClause.metric, "roi");
  assert.equal(pctClause.op, ">=");
  assert.equal(pctClause.value, 0.025);
  assert.deepEqual(pctClause.at, { slippageBps: "50", grouping: "date" });
  assert.equal(parseRule("events >= 20 && roi > 0").length, 2);
});

test("parseRule rejects OR, unknown metrics, junk and empty rules", () => {
  assert.throws(() => parseRule("roi > 0 OR ciLowerBound > 0"), /only AND/);
  assert.throws(() => parseRule("sharpe > 1"), /unknown metric/);
  assert.throws(() => parseRule("roi is positive"), /can't parse/);
  assert.throws(() => parseRule("   "), /empty/);
  assert.throws(() => parseRule("roi > 0 at slippageBps"), /key=value/);
  assert.throws(() => parseRule("roi > 0 at a=1,a=2"), /twice/);
});

const ROWS: ResultRow[] = [
  row({ bucket: "70-85", leadHours: 24, slippageBps: 50, grouping: "event" }, { roi: 0.108, ciLowerBound: 0.074 }),
  row({ bucket: "70-85", leadHours: 24, slippageBps: 300, grouping: "event" }, { roi: 0.081, ciLowerBound: 0.04 }),
  row({ bucket: "70-85", leadHours: 24, slippageBps: 50, grouping: "date" }, { roi: 0.108, ciLowerBound: 0.06 }),
  row({ bucket: "70-85", leadHours: 24, slippageBps: 300, grouping: "date" }, { roi: 0.081, ciLowerBound: 0.02 }),
];

test("evaluateRule passes when every clause holds on exactly its row", () => {
  const out = evaluateRule(ITEM_44_RULE, registration().select, ROWS);
  assert.equal(out.pass, true);
  assert.deepEqual(
    out.clauses.map((c) => [c.observed, c.pass]),
    [
      [0.074, true],
      [0.081, true],
    ]
  );
  assert.deepEqual(out.clauses[1].selector, { bucket: "70-85", leadHours: "24", grouping: "event", slippageBps: "300" });
});

test("evaluateRule fails item 44's real out-of-sample numbers", () => {
  // 70-85c @24h, 2026-07-01..08-12: ROI -2.3%, CI [-7.2%, 3.1%].
  const oos = [
    row({ bucket: "70-85", leadHours: 24, slippageBps: 50, grouping: "event" }, { roi: -0.023, ciLowerBound: -0.072, ciUpperBound: 0.031 }),
    row({ bucket: "70-85", leadHours: 24, slippageBps: 300, grouping: "event" }, { roi: -0.05, ciLowerBound: -0.1 }),
  ];
  const out = evaluateRule(ITEM_44_RULE, registration().select, oos);
  assert.equal(out.pass, false);
  assert.deepEqual(
    out.clauses.map((c) => c.pass),
    [false, false]
  );
});

test("evaluateRule treats a missing CI as FAIL, not a refusal", () => {
  const thin = [row({ bucket: "x", slippageBps: 50 }, { ciLowerBound: null, ciUpperBound: null })];
  const out = evaluateRule("ciLowerBound > 0 at slippageBps=50", { bucket: "x" }, thin);
  assert.equal(out.pass, false);
  assert.equal(out.clauses[0].observed, null);
  assert.match(out.clauses[0].note!, /n\/a/);
});

test("evaluateRule refuses ambiguous, missing or conflicting selections", () => {
  // grouping not pinned -> 2 rows match
  assert.throws(
    () => evaluateRule("roi > 0 at slippageBps=50", { bucket: "70-85", leadHours: "24" }, ROWS),
    /2 result rows match.*grouping/
  );
  assert.throws(() => evaluateRule("roi > 0 at slippageBps=150", registration().select, ROWS), /no result row/);
  assert.throws(() => evaluateRule("roi > 0 at bucket=85-90", registration().select, ROWS), /conflicts with select/);
});

test("selectRow refuses a selector that leaves a row dimension unpinned", () => {
  const rows = [row({ bucket: "a", slippageBps: 50 })];
  assert.throws(() => selectRow(rows, { bucket: "a" }), /unpinned/);
  assert.equal(selectRow(rows, { bucket: "a", slippageBps: "50" }), rows[0]);
});

test("checkRuleAgainstKeySpace catches rules that could never select a weather row", () => {
  const args = weatherArgs(["--leadHours=24", "--sensitivityBps=300", "--asOf=2026-09-24"]);
  const space = resultKeySpace(args);
  assert.deepEqual(checkRuleAgainstKeySpace(ITEM_44_RULE, registration().select, space), []);
  const problems = checkRuleAgainstKeySpace("roi > 0 at slippageBps=150", { bucket: "70-85", leadHours: "6" }, space);
  assert.ok(problems.some((p) => /slippageBps=150 is not produced/.test(p)));
  assert.ok(problems.some((p) => /leadHours=6 is not produced/.test(p)));
  assert.ok(problems.some((p) => /doesn't pin grouping/.test(p)));
  assert.ok(checkRuleAgainstKeySpace("roi > 0 at foo=1", {}, space).some((p) => /unknown key "foo"/.test(p)));
});

test("weather requestedWindow reproduces item 44's out-of-sample window from --asOf", () => {
  const args = weatherArgs(["--leadHours=24", "--skipDays=43", "--days=43", "--asOf=2026-09-24"]);
  assert.deepEqual(requestedWindow(args), { start: "2026-07-01", end: "2026-08-12" });
  assert.throws(() => weatherArgs(["--asOf=2026-13-01"]), /YYYY-MM-DD/);
  assert.deepEqual(weatherArgs(["--sensitivityBps=150,300"]).sensitivityBps, [150, 300]);
  assert.throws(() => weatherArgs(["--sensitivityBps=abc"]));
});

test("volatility-breakout parses --asOf/--sensitivityBps/--json and lists its row keys", () => {
  const a = volArgs(["--eventsPerAsset=10", "--asOf=2025-04-01", "--sensitivityBps=100", "--json=out.json"]);
  assert.deepEqual(a, { eventsPerAsset: 10, asOf: "2025-04-01", sensitivityBps: [100], json: "out.json" });
  const space = volKeySpace(a);
  assert.deepEqual(space.slippageBps, [0, 100]);
  assert.ok(space.bucket.includes("65-85c"));
  assert.deepEqual(checkRuleAgainstKeySpace("ciLowerBound > 0 at slippageBps=100", { bucket: "65-85c", grouping: "event" }, space), []);
});

test("registration hash: canonical, and any content edit is detected", () => {
  const p = newPreregistration(registration());
  assert.deepEqual(integrityProblems(p), []);
  // key order / formatting doesn't matter
  const reordered = JSON.parse(JSON.stringify(p));
  reordered.registration = Object.fromEntries(Object.entries(reordered.registration).reverse());
  assert.deepEqual(integrityProblems(reordered), []);
  assert.equal(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] }), '{"a":[{"c":3,"d":2}],"b":1}');
  // loosening the rule after the fact is caught
  const tampered = { ...p, registration: { ...p.registration, passRule: "roi > -0.05 at slippageBps=50" } };
  assert.match(integrityProblems(tampered)[0], /modified after creation/);
  // ...even if the window is quietly moved
  const moved = { ...p, registration: { ...p.registration, window: { start: "2026-08-13", end: "2026-09-21" } } };
  assert.equal(integrityProblems(moved).length, 1);
  assert.notEqual(registrationHash(moved.registration), p.registrationSha256);
});

test("newPreregistration refuses unparseable rules and inverted windows", () => {
  assert.throws(() => newPreregistration(registration({ passRule: "roi > 0 OR roi < 0" })), /only AND/);
  assert.throws(() => newPreregistration(registration({ window: { start: "2026-08-12", end: "2026-07-01" } })), /after end/);
  assert.throws(() => newPreregistration(registration({ slug: "Bad Slug" })));
});

test("resultMismatches: argv compared order-insensitively, output-only flags ignored", () => {
  assert.deepEqual(resultMismatches(registration(), result()), []);
  assert.deepEqual(normalizeArgv(["--b=1", "--json=x", "--a=2", "--cache=y"]), ["--a=2", "--b=1"]);
  const other = resultMismatches(registration(), result({ argv: ["--leadHours=6", "--skipDays=43", "--days=43"] }));
  assert.match(other[0], /^args:/);
});

test("resultMismatches compares resolved args when the script is known", () => {
  const resolved = { ...weatherArgs(registration().args) };
  const reg = registration({ resolvedArgs: resolved });
  assert.deepEqual(resultMismatches(reg, result({ args: { ...resolved, json: "data/other.json", cache: "c.json" } })), []);
  const bumped = resultMismatches(reg, result({ args: { ...resolved, slippageBps: 0 } }));
  assert.match(bumped[0], /^args:/);
});

test("resultMismatches refuses wrong script, wrong window, leaked data, and a result from before registration", () => {
  const reg = registration();
  assert.match(resultMismatches(reg, result({ script: "volatility-breakout" }))[0], /^script/);
  assert.match(resultMismatches(reg, result({ requestedWindow: { start: "2026-07-02", end: "2026-08-13" } }))[0], /result requested/);
  // a reused discovery-window cache puts later dates in the analysis
  assert.match(resultMismatches(reg, result({ observedWindow: { start: "2026-07-01", end: "2026-09-21" } }))[0], /outside registered/);
  assert.match(resultMismatches(reg, result({ observedWindow: null }))[0], /no observed/);
  assert.match(resultMismatches(reg, result({ generatedAt: "2026-09-24T09:00:00.000Z" }))[0], /^timing/);
  // count-selected scripts (no requested window) only need observed data inside
  assert.deepEqual(
    resultMismatches(reg, result({ requestedWindow: null, observedWindow: { start: "2026-07-05", end: "2026-08-01" } })),
    []
  );
});

test("parseWindow", () => {
  assert.deepEqual(parseWindow("2026-07-01..2026-08-12"), { start: "2026-07-01", end: "2026-08-12" });
  assert.throws(() => parseWindow("2026-07-01-2026-08-12"));
});

test("withSlippage re-prices a $1 hold-to-resolution trial like applyCosts", () => {
  const base: BacktestTrial = {
    walletAddress: "x",
    conditionId: "c",
    outcome: "Yes",
    eventKey: "e",
    category: "BTC",
    entryTimestamp: 0,
    entryPrice: 0.5,
    usdcStaked: 1,
    shares: 2,
    resolved: true,
    won: true,
    netReturn: 1,
  };
  assert.equal(withSlippage(base, 0), base);
  const w = withSlippage(base, 100);
  assert.ok(Math.abs(w.shares - 1 / 0.505) < 1e-12);
  assert.ok(Math.abs(w.netReturn - (1 / 0.505 - 1)) < 1e-12);
  assert.equal(w.entryPrice, 0.5); // bucket membership is on the quoted price
  assert.equal(withSlippage({ ...base, won: false, netReturn: -1 }, 300).netReturn, -1);
});
