# Pre-registrations

Track N1 of `docs/IMPROVEMENT_PLAN.md`. Each file in this directory records
one out-of-sample test, written **before** the test was run: the hypothesis,
the exact command, the data window, and a machine-checkable pass rule. Later,
the run's result is stamped into the same file as PASS or FAIL.

Why bother: item 44's weather 70-85c bucket looked robust in the discovery
window (+10.8%, CI [7.4%, 13.9%], held up across both halves and at 300bps).
It was also the best of 8 post-hoc comparisons. The out-of-sample test
had been written down before it ran, and it came back at -2.3%, CI
[-7.2%, 3.1%]. Had the rule been chosen after seeing the new data, the
result could have been reframed as "the city-date grouping still looks OK" or
"try the 6h lead". A pre-registration blocks that move.

## Where files live, and why they are committed

The files go here, in `docs/preregistrations/`, and are **committed**. They
do not go in `data/`, which is gitignored. A pre-registration is only worth
something if you can later show two things: that it existed before the run,
and that nobody changed it afterwards. Committing the file right after
`create` gives both. The commit timestamp and history show it came first,
and a reviewer sees any later edit as a diff. The in-file hash (below)
catches accidental edits, but anyone could recompute it, so the git check
is the one that counts. The files are also small and easy to review, and
they form a lasting record of which hypotheses passed and which failed.

Result files (`--json=...`) are large, reproducible and gitignored, so they
go in `data/research-results/`. The evaluation stamps their sha256, key
metrics, git commit and data window into the committed pre-registration.

## Commands

```
npm run prereg -- create <slug> --script=<npm script> --args="<exact args>" \
    --hypothesis="..." --select=key=value,... --rule="<pass rule>" \
    [--window=YYYY-MM-DD..YYYY-MM-DD] [--metric="..."] [--notes="..."]
git add docs/preregistrations/<date>-<slug>.json && git commit -m "Pre-register <slug>"   # BEFORE running
npm run job -- <slug> -- npm run <script> -- <exact args>                                  # the registered command
npm run prereg -- evaluate <slug> --result=data/research-results/<file>.json
git add docs/preregistrations/<date>-<slug>.json && git commit -m "Evaluate <slug>: PASS|FAIL"
npm run prereg -- list          # status + integrity of every registration
npm run prereg -- show <slug>   # full file + hash check
```

`POLYCOPY_PREREG_DIR` points the helper at another directory. Use it for
dry runs, so throwaway registrations stay out of this directory.

### Scripts that emit results

A pre-registration can only be evaluated against a result file that a
script writes with `--json=<path>`. Rows in that file are keyed by the
dimensions that identify a cell:

| script | row keys | extra flags |
|---|---|---|
| `weather-favorites` | `bucket` (70-85, 85-90, 90-95, 95-99, 85-99), `leadHours`, `slippageBps`, `grouping` (event, city-date, date) | `--asOf=YYYY-MM-DD` pins "today", which the window is measured back from (**required** for a registration). `--sensitivityBps=150,300` adds rows re-costed at each extra slippage. |
| `volatility-breakout` | `bucket` (all, BTC, WTI, 0-5c ... 95-100c), `grouping` (event, month), `slippageBps` (0 plus sensitivity) | `--asOf` picks the newest ladders that had ended by that date. `--sensitivityBps` works the same way. The window is by count, so `--window` is required and the ladder months actually used must fall inside it. |

Both scripts also print a multiple-comparison footer (Track N2,
`src/research/comparisons.ts`), and so does `favorite-harvesting`. The
footer gives k (e.g. `4 buckets x 2 leads = 8 comparisons`), marks the best
cell as POST HOC, and adds a rough Bonferroni check at 1-0.05/k. It is a
reason to write a pre-registration, not a substitute for one.

### Pass-rule language

```
<metric> <op> <number>[%] [at key=value[,key=value...]]  AND  ...
```

- metrics: `roi`, `ciLowerBound`, `ciUpperBound` (the event-clustered 95%
  bootstrap CI from `computeStrategyResult`), `winRate`, `trials`, `events`,
  `netPnl`
- ops: `>`, `>=`, `<`, `<=`. `2%` means `0.02`.
- **AND only.** OR is rejected, because it gives the test two chances to
  pass.
- `--select` pins the dimensions shared by every clause. Each clause's `at`
  pins the rest. Every clause has to land on **exactly one** row. If a
  dimension is left unpinned, or a value never appears in the result,
  `create` rejects the rule when the script is known, and `evaluate`
  refuses otherwise. A clause whose metric is n/a (for example, no CI
  because there are fewer than `MIN_SAMPLE_SIZE` trials) counts as a
  **FAIL**. A test without enough data to show its edge has failed to show
  it.
- The sample-size floor has to be written into the rule if you want it
  enforced, e.g. `... AND events >= 20 at slippageBps=50`.

### What `evaluate` refuses

`evaluate` stops without stamping anything in each of these cases:

- The registration block's sha256 doesn't match the one recorded at
  creation.
- The registration differs from the first committed version of the file.
  This catches an edit even if the hash was recomputed.
- The result came from a different script.
- The result's args differ from the registered ones. For known scripts
  the comparison uses the script's own parsed args with defaults filled
  in; otherwise it compares argv, ignoring order. Output-only
  `--json`/`--cache` are ignored.
- The result's requested window differs from the registered one.
- The result's data spans dates outside the registered window. This
  happens, for example, when a reused `--cache` file brings discovery-window
  events into the analysis.
- The result was generated before the registration was created.
- The registration has already been evaluated. Each registration gets
  exactly one evaluation.

The following produce warnings that are stamped into the file, but don't
block evaluation: the registration isn't committed, it was committed after
the result was generated, or the result came from a dirty checkout.

## Worked example: item 44, in this format

Item 44's registration was written as prose in `docs/IMPROVEMENT_PLAN.md`
because this helper didn't exist yet. This is how it would be registered
now. It is a reconstruction, not a real registration file, and it is not
committed here as one, because a file created today can't claim to predate
that run.

```
npm run prereg -- create weather-70-85-24h-oos \
  --script=weather-favorites \
  --args="--leadHours=24 --skipDays=43 --days=43 --asOf=2026-09-24 --sensitivityBps=300 --cache=data/weather-favorites/oos.json --json=data/research-results/weather-70-85-oos.json" \
  --hypothesis="Buying the favorite at 70-85c 24h before endDate in daily-temperature markets has positive ROI out of sample. Discovery (2026-08-13..09-21): +10.8% [7.4%, 13.9%], best of 8 post-hoc comparisons." \
  --select=bucket=70-85,leadHours=24,grouping=event \
  --rule="ciLowerBound > 0 at slippageBps=50 AND roi > 0 at slippageBps=300"
```

`--asOf=2026-09-24 --skipDays=43 --days=43` fixes the window at
2026-07-01..2026-08-12. That range doesn't overlap the discovery window.
The helper derives it from the args and writes it into the file.

```json
{
  "schema": "polycopytrade.preregistration/v1",
  "registration": {
    "slug": "weather-70-85-24h-oos",
    "createdAt": "2026-09-24T...Z",
    "gitCommit": "<HEAD at creation>",
    "gitDirty": false,
    "hypothesis": "Buying the favorite at 70-85c 24h before endDate ...",
    "script": "weather-favorites",
    "args": ["--leadHours=24", "--skipDays=43", "--days=43", "--asOf=2026-09-24", "--sensitivityBps=300", "--cache=...", "--json=..."],
    "resolvedArgs": {
      "days": 43, "skipDays": 43, "eventsPerDay": 5, "leadHours": [24], "anchor": "end",
      "slippageBps": 50, "feeBps": 0, "maxStaleHours": 3, "asOf": "2026-09-24",
      "sensitivityBps": [300], "cache": "...", "json": "..."
    },
    "window": { "start": "2026-07-01", "end": "2026-08-12" },
    "select": { "bucket": "70-85", "leadHours": "24", "grouping": "event" },
    "metric": "event-clustered bootstrap ROI (computeStrategyResult)",
    "passRule": "ciLowerBound > 0 at slippageBps=50 AND roi > 0 at slippageBps=300"
  },
  "registrationSha256": "<sha256 of the canonical registration JSON>",
  "evaluation": null
}
```

After the run, `evaluate` fills in `evaluation`. With item 44's real
numbers (ROI -2.3%, CI [-7.2%, 3.1%] at 50bps) the result would be:

```
weather-70-85-24h-oos: FAIL
  FAIL  ciLowerBound > 0 at slippageBps=50  [observed -0.0720; {"bucket":"70-85","grouping":"event","leadHours":"24","slippageBps":"50"}]
  FAIL  roi > 0 at slippageBps=300  [observed ...; {..."slippageBps":"300"}]
```

The FAIL above is a reconstruction. The item-44 run happened before
`--sensitivityBps` existed, so its 300bps number was never recorded, and
the output shows it as `...`. A FAIL on the first clause settles the
verdict either way. The unit test `evaluateRule fails item 44's real
out-of-sample numbers` in `tests/preregistration.test.ts` runs the same
rule against these numbers.

The stamped `evaluation` block records the verdict, each clause's selector
and observed value, the result file's sha256, `generatedAt`, git commit,
dirty flag, and requested and observed windows, the registration's first
commit, and any warnings.
