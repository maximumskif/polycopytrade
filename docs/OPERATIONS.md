# Operations: running the background daemons

`track:daemon` (wallet polling + Phase 3 paper trading) and `depth:collector`
(order-book snapshot capture) are meant to run continuously. `docs/AUDIT.md`
already recorded both dying silently once (the underlying shell/host session
ended, not a code bug) with nothing to notice or restart them. This is the
fix: systemd user services with `Restart=always`.

## Install

Unit files live in `ops/systemd/` (checked into the repo) with this
machine's paths already filled in — Node's nvm install path and the repo's
location (`~/projects/polycopytrade`), both written with systemd's `%h`
(home directory) specifier. Moved 2026-09-22 from the old `/mnt/c` checkout,
which sat outside `$HOME` and needed absolute paths.

```
mkdir -p ~/.config/systemd/user
ln -s ~/projects/polycopytrade/ops/systemd/polycopytrade-track.service ~/.config/systemd/user/
ln -s ~/projects/polycopytrade/ops/systemd/polycopytrade-depth.service ~/.config/systemd/user/
systemctl --user daemon-reload
```

## Enable (start on login) vs. start (start now)

```
systemctl --user enable polycopytrade-track.service polycopytrade-depth.service   # start on future logins
systemctl --user start  polycopytrade-track.service polycopytrade-depth.service   # start right now
```

These are deliberately separate: enabling the units is pure infrastructure
(Track A of `docs/IMPROVEMENT_PLAN.md`) and has no effect until started.
Actually starting `track:daemon` begins polling the real Polymarket API
continuously and resumes live paper-trading against `0x1b20a0...` — that's
Track E work, a decision to make separately, not a side effect of setting up
supervision.

## Persisting across WSL restarts

By default, systemd user services only run while you have an active login
session. To let them keep running (and auto-start) even with no terminal
open:

```
loginctl enable-linger $(whoami)
```

**Known limit**: this survives a WSL session/terminal closing, but not the
Windows machine being fully shut down or WSL itself being shut down
(`wsl --shutdown`) — there is no way around that from inside WSL. Verify
after a real restart, don't assume linger makes this bulletproof.

## Checking status / logs

```
systemctl --user status polycopytrade-track.service polycopytrade-depth.service
journalctl --user -u polycopytrade-track -f     # follow logs
journalctl --user -u polycopytrade-depth -f
```

Logs are also appended to `data/track-daemon.systemd.log` /
`data/depth-collector.systemd.log` per the unit files.

## Stopping

```
systemctl --user stop polycopytrade-track.service polycopytrade-depth.service
```

`Restart=always` means a plain `kill` will just bounce back after
`RestartSec=5` — use `stop`, not `kill`, to actually shut one down.

## If paths change

The unit files hardcode this machine's Node path (`~/.nvm/versions/node/v22.23.2/...`)
and repo location. If either moves (nvm upgrades Node, repo is relocated),
edit both `.service` files' `ExecStart`/`WorkingDirectory`/`ExecStartPre`
lines, re-symlink if the repo path changed, then `systemctl --user
daemon-reload` and restart.

## Background jobs (`npm run job`)

Track L1 of `docs/IMPROVEMENT_PLAN.md`. Long research jobs (30 min - 3 h of
rate-limited API pulls: `source-wallets`, `confirm-shallow`, sweeps) used to
run as ad-hoc background shells logging to `/tmp` -- a WSL reboot wiped a
3-hour sweep's log that way. Launch them through the job runner instead:

```
npm run job -- <name> -- <command...>
npm run job -- sweep -- npm run source-wallets
npm run job -- confirm -- npm run confirm-shallow -- <args...>
npm run job -- adhoc -- bash -c 'cmd1 && cmd2 | tee x'   # for shell syntax
```

The first `--` is npm's; the second separates the job name from the
command (everything after it, including further `--`s, is passed to the
command untouched). The command runs as a transient systemd user unit
(`systemd-run --user`, named `pct-job-<run dir>.service`) with the repo
root as working directory and a PATH that starts with the Node that
launched it -- so it survives the terminal / Claude session ending and
doesn't depend on an interactive nvm shell.

Each run gets `data/runs/<YYYY-MM-DDTHHMMSS>-<name>/` (local time,
gitignored):

- `output.log` -- stdout + stderr, plus `[run-job]` start/finish lines
- `meta.json` -- name, argv, git commit + dirty flag (tracked files only),
  start time, unit name
- `exit.json` -- written on completion by `ops/jobs/run-job.sh` (the
  wrapper the unit runs): exit code, signal if stopped, end time, duration

```
npm run jobs                              # recent runs (--limit N, --all)
npm run jobs -- --tail <name|dir>         # last 40 lines (--lines N)
tail -f data/runs/<dir>/output.log        # follow live
npm run job:stop -- <name|dir>            # SIGTERM the running job
npm run status                            # includes a jobs rollup
```

`<name|dir>` is a run directory name, a job name (its most recent run), or
a directory-name prefix. States: `running`, `succeeded` (exit 0), `failed`
(non-zero exit, or systemd-run couldn't launch it), `stopped` (via
job:stop/`systemctl --user stop`), and `lost` -- no `exit.json` and the
unit is no longer active, i.e. the process was SIGKILLed, OOM-killed, or
WSL shut down mid-run. `jobs` checks `systemctl --user is-active` for any
run without `exit.json`, so a dead job never shows as running forever.

**Across WSL restarts**: the run directory (log, meta, whatever the job
wrote to `data/`) survives, unlike `/tmp`. The job itself does **not** --
transient units aren't restarted, so a job running during `wsl --shutdown`
/ a Windows reboot shows as `lost` and has to be relaunched (check whether
the command itself can resume). Linger (see above) keeps jobs running
after the terminal closes, not across WSL shutdown.

Units are launched with `--collect`, so finished/failed ones unload
themselves; `systemctl --user list-units 'pct-job-*'` shows only live
jobs. Recurring jobs (systemd timers, Track L2) are not set up -- they make
unattended API calls and are gated on explicit approval.
