# Working in this repo as a (parallel) agent

This is Track O of `docs/IMPROVEMENT_PLAN.md`. Several Claude Code sessions
often work here at once: a coordinating session plus one agent per track.
This doc covers how they avoid stepping on each other, on the live daemons,
and on the user's uncommitted edits. It also lists the research-discipline
rules every result must follow.

## Rule zero: never work in the main checkout

`~/projects/polycopytrade` (branch `master`) is the **main checkout**. It
runs `track:daemon` and `depth:collector` as systemd services, and background
jobs from `npm run job` run from it (`docs/OPERATIONS.md`). Agents never
edit files there, never switch its branch, and never stash, reset or commit
anything in it. The only exception is the coordinating session running
`scripts/agent-worktree.sh merge`.

The main checkout usually has **uncommitted user edits**, most often in
`docs/IMPROVEMENT_PLAN.md`. Never commit them, stage them, stash them or
"clean them up". `merge` leaves them untouched, and `git cherry-pick`
refuses on its own if a picked commit touches a dirty file.

## Worktrees

Each agent works in its own git worktree on its own branch:

```
scripts/agent-worktree.sh create <name>     # ~/projects/polycopytrade-<name>, branch <name> from master, node_modules symlinked
scripts/agent-worktree.sh list
scripts/agent-worktree.sh merge <name> --dry-run   # show what would be picked
scripts/agent-worktree.sh merge <name>      # coordinator only: cherry-pick master..<name> onto master in the main checkout, then npm test + tsc
scripts/agent-worktree.sh remove <name>     # remove the worktree; the branch is deleted once all its commits are on master
```

- Start every shell command with `cd ~/projects/polycopytrade-<name>` or use
  absolute paths. Agent shells may reset the working directory between
  calls.
- `node_modules` is a symlink to the main checkout's copy, so the lockfile
  is shared. If a track needs a dependency change, replace the symlink with
  a real `npm install` in that worktree and tell the coordinator.
- `merge` cherry-picks commits instead of merging the branch, so master
  stays linear. Already-applied commits are skipped by patch identity
  (`git cherry`). If a pick conflicts, the merge is aborted and master is
  left unchanged. Rebase the branch in its worktree and try again.
- **O1: built-in worktree isolation.** If you launch Claude Code from the
  repo directory (`cd ~/projects/polycopytrade && claude`), the Agent tool's
  `isolation: "worktree"` option works, and sub-agents get throwaway
  worktrees under `.claude/worktrees/` automatically. `eslint.config.mjs`
  already ignores that directory. A session launched from outside the repo
  (e.g. `/mnt/c/Users/...`) doesn't get this, so use the script instead.
  Remove a built-in worktree with `git worktree remove` once it has been
  merged.

## File ownership

When the coordinator starts parallel agents, it gives each one a set of
files or directories it owns. The brief lists what the agent must not
touch. For example, the N/O agent was told to stay out of `src/scoring/*`,
`src/storage/*`, `src/api/*`, `src/tracking/*` and
`src/research/walletConfirmation.ts` while another agent worked on
scoring/storage. Rules:

- Edit only what your brief covers. If a fix belongs in a file someone else
  owns, describe it in your report and don't make it.
- **Never edit `docs/IMPROVEMENT_PLAN.md`.** The user and the coordinator
  log items there after merging, and it usually has uncommitted edits in
  the main checkout. Put what the plan entry should say in your report.
- New files are the easiest way to avoid conflicts (e.g. a new
  `src/research/comparisons.ts` rather than a helper added to a shared
  file).
- Migrations (`src/storage/migrations`) are numbered, so two agents adding
  one at the same time will collide. Coordinate first.

## Sharing the API budget from a worktree

Polymarket rate-limits aggressively. The shared limiter and cache
(K1/K2, `docs/OPERATIONS.md`) only coordinate processes that point at the
same files. A worktree's `data/` is separate, so set these before running
anything that calls the API:

```
export POLYCOPY_SHARED_RATELIMIT_PATH=~/projects/polycopytrade/data/api-ratelimit.db
export POLYCOPY_API_CACHE_PATH=~/projects/polycopytrade/data/api-cache.db   # optional, but saves re-fetching immutable data
```

Without the first one, your job and the daemon each run at the full rate,
and together they get 429s. Scripts that read `wallet_activity` use
`DB_PATH`, which defaults to the worktree's own (mostly empty) db. Point it
at the main db **read-only in intent**. Never run migrations against it
from a branch.

Long pulls (more than a few minutes) go through `npm run job -- <name> --
<cmd>` (from the worktree is fine). A job survives the agent session
ending, and its log lands in `data/runs/`.

## Commit early: agents get interrupted

A session can stop partway through a task: usage limits, a WSL restart, a
killed terminal. An interrupted agent's uncommitted work is only on disk,
and the next session has to rediscover it. So:

- **Commit each working increment** as soon as typecheck and tests pass,
  e.g. "helper + wiring", then "tests", then "docs". Don't hold one big
  commit until the end. Commits on your own branch cost nothing, and
  the coordinator can squash or pick them.
- Don't leave a result only in a terminal. Write it to the run directory
  (`npm run job`) or a `--json` result file, and put the key numbers in a
  commit message or in your report.
- A resumed agent starts with `git status` and `git log master..` in its
  worktree to see what already landed.

## Verification before reporting

Run these in the worktree:

```
npm test                          # full suite; report the count (e.g. 293/293)
npx tsc --noEmit -p .
npx eslint <changed files>        # pre-existing any-warnings in src/storage are known; do not "fix" files you do not own
npx prettier --check <changed files>
bash -n <changed shell scripts>
```

"It compiles" is not verification. Run the real command at least once:
a script on a small sample, a CLI end to end, or a synthetic input when a
real pull would take 40 minutes. Pure logic needs unit tests in `tests/`
(node:test + tsx, the same style as the existing files).

## Commits

- Commit on your own branch. **Never push**, and never commit on master
  (`merge` does that).
- Match the existing message style: `Track <X>: <what>` or `Log item <n>: ...`,
  then a body that says why.
- End every commit message with the trailer the brief gives, currently:

  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  ```

## Report format

Keep the final report to the coordinator short. It becomes the
`docs/IMPROVEMENT_PLAN.md` entry, so include:

1. Commit hashes (oldest first) and the branch.
2. Files changed, new versus modified, one line each.
3. What it does and how to use it (commands, flags, env vars).
4. Verification: test count, typecheck, lint, and the real runs you did
   with sample output.
5. Findings with their numbers: event counts, ROI with CI, and how many
   variants were compared.
6. Anything left undone, anything flagged but not fixed (with the file
   owner), and follow-ups.

## Research discipline (applies to every result)

The project already paid for these rules with results that fell apart
(items 32-34, 43, 44):

- **Event-clustered CIs.** Every strategy number goes through
  `computeStrategyResult` (`src/backtesting/statistics.ts`). Trials are
  keyed by `eventKey`, so correlated trials (the rungs of one ladder, the
  ranges of one temperature reading) form one cluster in the bootstrap.
  Report `distinctEvents`, not just trial counts. A stricter grouping
  (by date or month) is worth reporting next to it.
- **`MIN_SAMPLE_SIZE` = 20 independent events.** Below 20 there is no CI,
  and results are labeled provisional. Don't act on them.
- **Shallow wallet scores must be confirmed.** A shallow-page score can be
  truncated to a wallet's newest activity, so treat it as a screen, not a
  pass. It needs an anchored confirmation (`confirm-shallow` /
  `src/research/walletConfirmation.ts`), and a score that is still
  truncated is **unconfirmed**, never a pass.
- **`qualityScore == 50` is the cap, not a pass.** A wallet sitting exactly
  at 50 is being held there by the profitability-floor cap (both
  profitability terms below neutral). Quality means
  `isQualityWallet(score)`: zero veto flags and a score strictly above 50.
  Don't write your own `>= 50` check.
- **Count your comparisons, and pre-register before trusting a post-hoc
  bucket.** If a script reports k buckets or variants, the best one is the
  best of k. Its 95% CI is not a 95% CI. The N2 footer
  (`src/research/comparisons.ts`) prints k, marks the best cell as POST HOC,
  and gives a rough Bonferroni check. A promising post-hoc cell becomes a
  finding only after an out-of-sample test that was registered **before**
  it ran: `npm run prereg -- create`, commit, run, `evaluate`
  (`docs/preregistrations/README.md`). Item 44's +10.8% bucket went to
  -2.3% out of sample.
- **No execution code.** Track F (live trading) is documentation-only and
  gated on the user.
