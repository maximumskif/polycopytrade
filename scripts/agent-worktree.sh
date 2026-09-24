#!/usr/bin/env bash
# Track O1 (docs/IMPROVEMENT_PLAN.md, docs/AGENTS.md): one git worktree per
# parallel agent, so agents never edit the main checkout -- which runs the
# live daemons and background jobs.
#
#   scripts/agent-worktree.sh create <name>            ~/projects/polycopytrade-<name> on new branch <name> from master
#   scripts/agent-worktree.sh merge <name> [--dry-run] cherry-pick master..<name> onto master IN THE MAIN CHECKOUT, then npm test
#   scripts/agent-worktree.sh remove <name> [--force]  remove the worktree; delete the branch once every commit is on master
#   scripts/agent-worktree.sh list
#
# Env: POLYCOPY_MAIN (main checkout, default ~/projects/polycopytrade),
#      POLYCOPY_BASE (base branch, default master).
#
# merge is for the coordinating session / the user, not for the agent that
# did the work. It never stashes, resets or commits the main checkout's own
# uncommitted edits (e.g. the user's docs/IMPROVEMENT_PLAN.md): git
# cherry-pick refuses on its own if a picked commit touches a dirty file.

set -euo pipefail

MAIN="${POLYCOPY_MAIN:-$HOME/projects/polycopytrade}"
BASE="${POLYCOPY_BASE:-master}"

die() { echo "agent-worktree: $*" >&2; exit 1; }
usage() { sed -n '5,9p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }

[ -d "$MAIN/.git" ] || [ -f "$MAIN/.git" ] || die "main checkout not found at $MAIN (set POLYCOPY_MAIN)"

cmd="${1:-}"; name="${2:-}"
case "$cmd" in create|merge|remove) [ -n "$name" ] || usage ;; list) ;; *) usage ;; esac
if [ -n "$name" ]; then
  [[ "$name" =~ ^[a-z0-9][a-z0-9._-]*$ ]] || die "name must be lowercase [a-z0-9._-], got '$name'"
  [ "$name" != "$BASE" ] || die "refusing to use the base branch name '$BASE'"
fi
WT="$(dirname "$MAIN")/$(basename "$MAIN")-$name"

case "$cmd" in
  create)
    [ ! -e "$WT" ] || die "$WT already exists"
    git -C "$MAIN" show-ref --verify --quiet "refs/heads/$name" && die "branch '$name' already exists"
    git -C "$MAIN" worktree add -b "$name" "$WT" "$BASE"
    # Shared node_modules: same lockfile, no second npm install. (A worktree
    # that changes dependencies must replace the symlink with a real install.)
    [ -d "$MAIN/node_modules" ] && ln -s "$MAIN/node_modules" "$WT/node_modules"
    cat <<MSG

Worktree ready: $WT (branch $name from $BASE @ $(git -C "$WT" rev-parse --short HEAD))
  cd $WT
Share the main checkout's rate limiter (and API cache) when calling the API from here:
  export POLYCOPY_SHARED_RATELIMIT_PATH=$MAIN/data/api-ratelimit.db
  export POLYCOPY_API_CACHE_PATH=$MAIN/data/api-cache.db
Verify: npm test && npx tsc --noEmit -p . && npx eslint <changed files>
Merge (from the coordinating session): scripts/agent-worktree.sh merge $name
MSG
    ;;

  merge)
    git -C "$MAIN" show-ref --verify --quiet "refs/heads/$name" || die "no branch '$name'"
    current="$(git -C "$MAIN" symbolic-ref --short -q HEAD || true)"
    [ "$current" = "$BASE" ] || die "main checkout is on '${current:-detached HEAD}', not '$BASE'"
    # Skip commits already on BASE by patch identity (git cherry marks them '-').
    mapfile -t commits < <(git -C "$MAIN" cherry "$BASE" "$name" | awk '$1 == "+" { print $2 }')
    if [ "${#commits[@]}" -eq 0 ]; then echo "nothing to merge: every commit on '$name' is already on $BASE"; exit 0; fi
    echo "Commits on '$name' not on $BASE (oldest first):"
    for c in "${commits[@]}"; do git -C "$MAIN" log -1 --format='  %h %s' "$c"; done
    dirty="$(git -C "$MAIN" status --porcelain --untracked-files=no)"
    [ -z "$dirty" ] || { echo "Main checkout has uncommitted changes (left untouched):"; echo "$dirty" | sed 's/^/  /'; }
    if [ "${3:-}" = "--dry-run" ]; then echo "(dry run: nothing picked)"; exit 0; fi
    if ! git -C "$MAIN" cherry-pick "${commits[@]}"; then
      git -C "$MAIN" cherry-pick --abort 2>/dev/null || true
      die "cherry-pick failed and was aborted -- $BASE is unchanged; rebase '$name' onto $BASE in its worktree and retry"
    fi
    echo "Picked ${#commits[@]} commit(s). Running tests in $MAIN ..."
    log="$(mktemp)"
    if ! (cd "$MAIN" && npm test --silent >"$log" 2>&1); then
      tail -n 30 "$log"
      die "tests FAIL on $BASE after the merge (full log: $log) -- fix forward on $BASE or revert the picked commits"
    fi
    grep -E '^# (tests|pass|fail)' "$log" | sed 's/^/  /'; rm -f "$log"
    (cd "$MAIN" && npx tsc --noEmit -p .) || die "typecheck failed on $BASE after the merge"
    echo "Merged. Restart long-running services only if the change needs it (docs/OPERATIONS.md)."
    ;;

  remove)
    force=""; [ "${3:-}" = "--force" ] && force="--force"
    if [ -e "$WT" ]; then
      # The node_modules symlink is untracked; remove it so a clean worktree
      # isn't reported dirty.
      [ -L "$WT/node_modules" ] && rm "$WT/node_modules"
      git -C "$MAIN" worktree remove $force "$WT" || die "worktree has changes -- commit them, or rerun with --force to discard"
      echo "Removed worktree $WT"
    else
      git -C "$MAIN" worktree prune
      echo "No worktree at $WT (pruned stale entries)"
    fi
    if git -C "$MAIN" show-ref --verify --quiet "refs/heads/$name"; then
      if git -C "$MAIN" cherry "$BASE" "$name" | grep -q '^+'; then
        echo "Kept branch '$name': it has commits not on $BASE (git cherry $BASE $name). Delete with: git branch -D $name"
      else
        git -C "$MAIN" branch -D "$name" >/dev/null && echo "Deleted branch '$name' (all its commits are on $BASE)"
      fi
    fi
    ;;

  list)
    git -C "$MAIN" worktree list
    ;;
esac
