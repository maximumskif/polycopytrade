#!/bin/bash
# Track L1 wrapper: what each `npm run job` transient systemd unit actually
# runs (launched by src/cli/job.ts -- don't invoke by hand). Usage:
#   run-job.sh <run-dir> -- <command...>
#
# It exists so a run's ending is always recorded: the command's exit code,
# end time and duration go to <run-dir>/exit.json whether it succeeded,
# failed, or was stopped (`npm run job:stop` / `systemctl --user stop`).
# The command's stdout+stderr already go to <run-dir>/output.log via the
# unit's StandardOutput=/StandardError=append: settings, which also catch
# anything this wrapper itself prints.
#
# Bash rather than a Node script (2026-09-24): the thing being wrapped is
# usually Node, and a wrapper that shares the command's failure modes (bad
# PATH, broken nvm install) couldn't record those failures.
#
# Only a SIGKILL / OOM kill / WSL shutdown can skip exit.json -- `npm run
# jobs` detects that case by the unit no longer being active and shows the
# run as "lost" instead of "running" forever.

set -u
run_dir="$1"
shift
[ "${1:-}" = "--" ] && shift

start_epoch=$(date +%s)
if [ -f "$run_dir/meta.json" ]; then
  # Prefer the launcher's recorded start so duration matches meta.json.
  meta_start=$(grep -o '"startedAtEpoch": *[0-9]*' "$run_dir/meta.json" | grep -o '[0-9]*$')
  [ -n "$meta_start" ] && start_epoch=$meta_start
fi

signal=""
# Stop requests: systemd sends SIGTERM to every process in the unit's
# cgroup (child included), so just note it here and keep waiting for the
# child to actually exit, then record the ending below.
trap 'signal=SIGTERM' TERM
trap 'signal=SIGINT' INT

echo "[run-job] $(date -Is) starting: ${*@Q}"
"$@" &
child=$!
while true; do
  wait "$child"
  rc=$?
  # wait returns >128 early when a trapped signal interrupts it; loop until
  # the child is really gone so rc is the child's own exit status.
  kill -0 "$child" 2>/dev/null || break
done

end_epoch=$(date +%s)
end_iso=$(date -u +%Y-%m-%dT%H:%M:%SZ)
if [ -n "$signal" ]; then sig_json="\"$signal\""; else sig_json=null; fi
echo "[run-job] $(date -Is) finished: exit code $rc${signal:+ (after $signal)}"

# Write-then-rename so a reader never sees a half-written exit.json.
tmp="$run_dir/.exit.json.tmp"
cat >"$tmp" <<JSON
{
  "exitCode": $rc,
  "signal": $sig_json,
  "endedAt": "$end_iso",
  "endedAtEpoch": $end_epoch,
  "durationSeconds": $((end_epoch - start_epoch))
}
JSON
mv -f "$tmp" "$run_dir/exit.json"
exit "$rc"
