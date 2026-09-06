# Operations: running the background daemons

`track:daemon` (wallet polling + Phase 3 paper trading) and `depth:collector`
(order-book snapshot capture) are meant to run continuously. `docs/AUDIT.md`
already recorded both dying silently once (the underlying shell/host session
ended, not a code bug) with nothing to notice or restart them. This is the
fix: systemd user services with `Restart=always`.

## Install

Unit files live in `ops/systemd/` (checked into the repo) with this
machine's absolute paths already filled in — Node's nvm install path and the
repo's location under `/mnt/c` (WSL mounts the Windows filesystem outside
`$HOME`, so `%h`-relative paths don't work here).

```
mkdir -p ~/.config/systemd/user
ln -s /mnt/c/Users/mdeff/polycopytrade/ops/systemd/polycopytrade-track.service ~/.config/systemd/user/
ln -s /mnt/c/Users/mdeff/polycopytrade/ops/systemd/polycopytrade-depth.service ~/.config/systemd/user/
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
