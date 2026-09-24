// Track L1/L3: pure job-runner logic (run-dir naming, arg parsing, meta/exit
// parsing, state derivation, log-line extraction, run resolution) plus the
// quality-pool label check. No systemd units are launched here.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  deriveState,
  formatDuration,
  lastLogLine,
  listRuns,
  parseExit,
  parseJobArgs,
  parseMeta,
  resolveRun,
  runDirName,
  runDuration,
  shellQuote,
  unitNameFor,
  validateJobName,
  type RunInfo,
  type RunMeta,
} from "../src/jobs/runs";
import { isLabeledQualityWallet } from "../src/cli/status";

function meta(overrides: Partial<RunMeta> = {}): RunMeta {
  return {
    name: "sweep",
    command: "npm run source-wallets",
    argv: ["npm", "run", "source-wallets"],
    cwd: "/repo",
    git: { commit: "abc", dirty: false },
    startedAt: "2026-09-24T16:00:00.000Z",
    startedAtEpoch: 1_000,
    unit: "pct-job-2026-09-24T120000-sweep.service",
    runDir: "/repo/data/runs/2026-09-24T120000-sweep",
    ...overrides,
  };
}

test("runDirName: local-time timestamp + name, suffix on collision", () => {
  const d = new Date(2026, 8, 4, 7, 5, 9); // local time
  assert.equal(runDirName(d, "sweep"), "2026-09-04T070509-sweep");
  assert.equal(runDirName(d, "sweep", 1), "2026-09-04T070509-sweep-2");
  assert.equal(unitNameFor("2026-09-04T070509-sweep"), "pct-job-2026-09-04T070509-sweep.service");
});

test("validateJobName: rejects characters unsafe in dir/unit names", () => {
  assert.equal(validateJobName("confirm-shallow_2.x"), null);
  for (const bad of ["", "-lead", "has space", "a/b", "x".repeat(65), "semi;colon"]) {
    assert.notEqual(validateJobName(bad), null, bad);
  }
});

test("parseJobArgs: inner -- optional, command required", () => {
  assert.deepEqual(parseJobArgs(["smoke", "--", "npm", "run", "typecheck"]), { name: "smoke", argv: ["npm", "run", "typecheck"] });
  assert.deepEqual(parseJobArgs(["smoke", "node", "-e", "1"]), { name: "smoke", argv: ["node", "-e", "1"] });
  // Only the first -- is the separator; later ones belong to the command.
  assert.deepEqual(parseJobArgs(["x", "--", "npm", "run", "y", "--", "--z"]), { name: "x", argv: ["npm", "run", "y", "--", "--z"] });
  assert.ok("error" in parseJobArgs([]));
  assert.ok("error" in parseJobArgs(["smoke"]));
  assert.ok("error" in parseJobArgs(["smoke", "--"]));
  assert.ok("error" in parseJobArgs(["bad name", "--", "true"]));
});

test("shellQuote: quotes only when needed", () => {
  assert.equal(shellQuote(["node", "-e", "process.exit(3)"]), "node -e 'process.exit(3)'");
  assert.equal(shellQuote(["echo", "it's"]), `echo 'it'\\''s'`);
  assert.equal(shellQuote(["npm", "run", "x", "--", "--from=2026-06-24"]), "npm run x -- --from=2026-06-24");
});

test("parseMeta / parseExit: tolerate garbage, require key fields", () => {
  assert.deepEqual(parseMeta(JSON.stringify(meta())), meta());
  assert.equal(parseMeta("{not json"), null);
  assert.equal(parseMeta(JSON.stringify({ name: "x" })), null);
  assert.deepEqual(parseExit('{"exitCode":3,"endedAt":"t","durationSeconds":5}'), { exitCode: 3, endedAt: "t", durationSeconds: 5 });
  assert.equal(parseExit(""), null);
  assert.equal(parseExit("null"), null);
  assert.equal(parseExit("{}"), null);
});

test("deriveState: exit.json wins; otherwise unit state decides running vs lost", () => {
  const ended = { endedAt: "t", durationSeconds: 1 };
  assert.equal(deriveState({ ...ended, exitCode: 0 }, null), "succeeded");
  assert.equal(deriveState({ ...ended, exitCode: 3 }, "active"), "failed");
  assert.equal(deriveState({ ...ended, exitCode: 143, signal: "SIGTERM" }, null), "stopped");
  assert.equal(deriveState({ ...ended, exitCode: null, launchError: "no bus" }, null), "failed");
  assert.equal(deriveState(null, "active"), "running");
  assert.equal(deriveState(null, "activating"), "running");
  assert.equal(deriveState(null, "deactivating"), "running");
  // Crashed / SIGKILLed / WSL-rebooted: unit gone, no exit.json.
  assert.equal(deriveState(null, "inactive"), "lost");
  assert.equal(deriveState(null, "failed"), "lost");
  assert.equal(deriveState(null, null), "unknown");
});

test("formatDuration / runDuration", () => {
  assert.equal(formatDuration(5), "5s");
  assert.equal(formatDuration(65), "1m05s");
  assert.equal(formatDuration(3 * 3600 + 7 * 60 + 30), "3h07m");
  assert.equal(formatDuration(null), "?");
  assert.equal(formatDuration(-1), "?");
  assert.equal(runDuration(meta(), null, "running", 1_090), 90);
  assert.equal(runDuration(meta(), { exitCode: 0, endedAt: "t", durationSeconds: 12 }, "succeeded", 9_999), 12);
  // Lost: no recorded end -- estimate from the log's last write, not "now".
  assert.equal(runDuration(meta(), null, "lost", 9_999, 1_030), 30);
  assert.equal(runDuration(meta(), null, "lost", 9_999, null), null);
});

test("lastLogLine: last non-empty line, \\r redraws and ANSI stripped, truncated", () => {
  assert.equal(lastLogLine("a\nb\n\n  \n"), "b");
  assert.equal(lastLogLine("page 1/40\rpage 2/40\rpage 3/40\n"), "page 3/40");
  assert.equal(lastLogLine("\x1b[32mok\x1b[0m done\n"), "ok done");
  assert.equal(lastLogLine(""), "");
  // Wrapper start/finish lines skipped when the command printed something.
  assert.equal(lastLogLine("[run-job] x starting: a\nERR boom\n[run-job] x finished: exit code 1\n"), "ERR boom");
  assert.equal(lastLogLine("[run-job] x starting: a\n[run-job] x finished: exit code 3\n"), "[run-job] x finished: exit code 3");
  assert.equal(lastLogLine("x".repeat(20), 10), "xxxxxxxxx…");
});

test("resolveRun: exact dir, then newest run of that name, then dir prefix", () => {
  const runs: RunInfo[] = [
    { dirName: "2026-09-24T130000-sweep", dir: "/r/a", meta: meta(), exit: null },
    { dirName: "2026-09-24T120000-smoke", dir: "/r/b", meta: meta({ name: "smoke" }), exit: null },
    { dirName: "2026-09-23T120000-sweep", dir: "/r/c", meta: meta(), exit: null },
  ];
  assert.equal(resolveRun("2026-09-23T120000-sweep", runs)?.dir, "/r/c");
  assert.equal(resolveRun("data/runs/2026-09-23T120000-sweep/", runs)?.dir, "/r/c");
  assert.equal(resolveRun("sweep", runs)?.dir, "/r/a");
  assert.equal(resolveRun("2026-09-24T12", runs)?.dir, "/r/b");
  assert.equal(resolveRun("nope", runs), null);
});

test("listRuns: newest first, skips dirs without valid meta.json", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pct-runs-"));
  try {
    for (const [dir, m] of [
      ["2026-09-24T100000-a", meta({ name: "a" })],
      ["2026-09-24T110000-b", meta({ name: "b" })],
    ] as const) {
      fs.mkdirSync(path.join(root, dir));
      fs.writeFileSync(path.join(root, dir, "meta.json"), JSON.stringify(m));
    }
    fs.writeFileSync(path.join(root, "2026-09-24T110000-b", "exit.json"), '{"exitCode":0,"endedAt":"t","durationSeconds":1}');
    fs.mkdirSync(path.join(root, "2026-09-24T120000-broken"));
    const runs = listRuns(root);
    assert.deepEqual(
      runs.map((r) => r.meta.name),
      ["b", "a"]
    );
    assert.equal(runs[0].exit?.exitCode, 0);
    assert.equal(runs[1].exit, null);
    assert.deepEqual(listRuns(path.join(root, "missing")), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("isLabeledQualityWallet: label convention, negations excluded", () => {
  assert.ok(isLabeledQualityWallet("ndb1 (SPORTS ... medianGapSeconds=7 — QUALITY WALLET)"));
  assert.ok(!isLabeledQualityWallet("someone (57/100, profitability-capped)"));
  assert.ok(!isLabeledQualityWallet("someone — not a QUALITY WALLET (veto flag)"));
  assert.ok(!isLabeledQualityWallet("someone — NOT QUALITY WALLET"));
});
