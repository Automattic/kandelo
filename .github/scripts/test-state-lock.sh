#!/usr/bin/env bash
# Test state-lock subject isolation and owner liveness fencing.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$REPO_ROOT/.github/scripts/state-lock.sh"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

fail=0

test_subject_maps_to_ref() {
  local subject="$1"
  local expected_ref="$2"
  local actual_ref
  actual_ref=$(STATE_LOCK_DRY_RUN=1 bash "$SCRIPT" acquire "$subject" 2>&1 | grep -oE 'refs/heads/[^ ]+' | head -1)
  if [ "$actual_ref" != "$expected_ref" ]; then
    echo "FAIL: subject=$subject expected_ref=$expected_ref actual=$actual_ref" >&2
    fail=1
    return 1
  fi
  echo "PASS: subject=$subject → $actual_ref"
}

test_subject_maps_to_ref "durable-release" "refs/heads/github-actions/state-lock/durable-release"
test_subject_maps_to_ref "binaries-abi-v8" "refs/heads/github-actions/state-lock/binaries-abi-v8"
test_subject_maps_to_ref "pr-423-staging"  "refs/heads/github-actions/state-lock/pr-423-staging"

REMOTE="$TMP_ROOT/remote.git"
WORK="$TMP_ROOT/work"
BIN="$TMP_ROOT/bin"
LOG="$TMP_ROOT/gh.log"
mkdir -p "$BIN"
git init --bare -q "$REMOTE"
git init -q "$WORK"
git -C "$WORK" remote add origin "$REMOTE"

cat > "$BIN/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$GH_STUB_LOG"
case "$*" in
  "api /repos/example/repo/actions/runs/200 -q .status")
    printf 'in_progress\n'
    ;;
  *)
    echo "unexpected gh invocation: $*" >&2
    exit 1
    ;;
esac
EOF
chmod +x "$BIN/gh"

cat > "$BIN/sleep" <<'EOF'
#!/usr/bin/env bash
# Stop the acquire loop after it has demonstrated that the active owner wins.
exit 97
EOF
chmod +x "$BIN/sleep"

subject="old-active-owner"
lock_ref="refs/heads/github-actions/state-lock/$subject"
tree="$(git -C "$WORK" mktree </dev/null)"
old_message="$TMP_ROOT/old-lock-message"
cat > "$old_message" <<EOF
state lock: $subject

subject=$subject
workflow=Prepare merge
run_id=200
run_attempt=1
job=matrix-build
owner_token=old-owner
owner_detail=publish, wasm32
created_epoch=1
EOF
old_sha="$(
  GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.com \
  GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.com \
    git -C "$WORK" commit-tree "$tree" -F "$old_message"
)"
git -C "$WORK" push -q origin "$old_sha:$lock_ref"

set +e
active_output="$(
  cd "$WORK" &&
    GH_STUB_LOG="$LOG" \
    GITHUB_REPOSITORY=example/repo \
    GITHUB_RUN_ID=200 \
    GITHUB_RUN_ATTEMPT=1 \
    GITHUB_JOB=activation \
    GITHUB_WORKFLOW='Activate candidate' \
    STATE_LOCK_OWNER_TOKEN=new-owner \
    STATE_LOCK_OWNER_DETAIL=activation \
    STATE_LOCK_POLL_SECONDS=1 \
    STATE_LOCK_SAME_RUN_STALE_SECONDS=0 \
    STATE_LOCK_STALE_SECONDS=0 \
    RUNNER_TEMP="$TMP_ROOT/runner" \
    PATH="$BIN:$PATH" \
      bash "$SCRIPT" acquire "$subject" 2>&1
)"
active_rc=$?
set -e

if [ "$active_rc" -ne 97 ]; then
  echo "FAIL: old active-owner probe exited $active_rc instead of waiting" >&2
  printf '%s\n' "$active_output" >&2
  fail=1
fi
if ! grep -Fq 'is held by workflow run 200' <<<"$active_output"; then
  echo "FAIL: old active owner was not reported as held" >&2
  printf '%s\n' "$active_output" >&2
  fail=1
fi
if grep -Fq 'Removing stale state lock' <<<"$active_output"; then
  echo "FAIL: old active owner was treated as stale" >&2
  printf '%s\n' "$active_output" >&2
  fail=1
fi
actual_sha="$(git -C "$WORK" ls-remote origin "$lock_ref" | awk '{print $1}')"
if [ "$actual_sha" != "$old_sha" ]; then
  echo "FAIL: old active owner's lock changed: expected=$old_sha actual=$actual_sha" >&2
  fail=1
else
  echo "PASS: an old lock with an active same-run owner is not stolen"
fi

exit "$fail"
