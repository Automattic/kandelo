#!/usr/bin/env bash
# state-lock.sh — generalized workflow-level mutex over a git ref.
#
# Generalizes the older durable-release-lock.sh: the subject is a
# positional arg that maps into a per-subject ref name. This lets one
# script serialize independent workflows over independent subjects
# (e.g., durable-release publish, binaries-abi-v8 index updates,
# pr-<N>-staging index updates) without contention between them.
#
# Backward-compatible env-var fallbacks for the older DURABLE_RELEASE_*
# names are kept so an in-flight workflow that hasn't been migrated
# still operates correctly.
set -euo pipefail

LOCK_POLL_SECONDS="${STATE_LOCK_POLL_SECONDS:-${DURABLE_RELEASE_LOCK_POLL_SECONDS:-30}}"
LOCK_STALE_SECONDS="${STATE_LOCK_STALE_SECONDS:-${DURABLE_RELEASE_LOCK_STALE_SECONDS:-21600}}"

usage() {
  echo "usage: $0 acquire <subject>|release" >&2
}

validate_subject() {
  local s="$1"
  # Allow only a conservative ASCII subset: a-zA-Z0-9._-
  if ! [[ "$s" =~ ^[A-Za-z0-9._-]+$ ]]; then
    echo "state-lock: invalid subject '$s' (allowed: [A-Za-z0-9._-]+)" >&2
    exit 2
  fi
}

ref_for_subject() {
  echo "refs/heads/github-actions/state-lock/$1"
}

remote_lock_sha() {
  git ls-remote origin "$LOCK_REF" | awk '{print $1}'
}

delete_lock_if_unchanged() {
  local expected_sha="$1"
  git push \
    --force-with-lease="$LOCK_REF:$expected_sha" \
    origin ":$LOCK_REF" >/dev/null 2>&1
}

lock_message_for() {
  local lock_sha="$1"
  git fetch --no-tags --depth=1 origin "$LOCK_REF" >/dev/null 2>&1
  git log -1 --format=%B "$lock_sha"
}

owner_field() {
  local field="$1"
  sed -n "s/^${field}=//p" | head -n 1
}

create_lock_commit() {
  local now
  local tree
  local message

  now="$(date -u +%s)"
  tree="$(git mktree </dev/null)"
  message="$(mktemp)"
  cat >"$message" <<EOF
state lock: ${SUBJECT}

subject=${SUBJECT}
workflow=${GITHUB_WORKFLOW:-}
run_id=${GITHUB_RUN_ID}
run_attempt=${GITHUB_RUN_ATTEMPT:-}
run_url=${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}
created_epoch=${now}
EOF

  GIT_AUTHOR_NAME="github-actions[bot]" \
  GIT_AUTHOR_EMAIL="github-actions[bot]@users.noreply.github.com" \
  GIT_COMMITTER_NAME="github-actions[bot]" \
  GIT_COMMITTER_EMAIL="github-actions[bot]@users.noreply.github.com" \
    git commit-tree "$tree" -F "$message"
}

acquire() {
  validate_subject "$SUBJECT"
  LOCK_REF="$(ref_for_subject "$SUBJECT")"

  if [ -n "${STATE_LOCK_DRY_RUN:-}" ]; then
    echo "state-lock dry-run: subject=$SUBJECT ref=$LOCK_REF"
    return 0
  fi

  local repo="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
  local run_id="${GITHUB_RUN_ID:?GITHUB_RUN_ID is required}"

  while true; do
    local lock_sha
    lock_sha="$(create_lock_commit)"

    if git push origin "$lock_sha:$LOCK_REF" >/dev/null 2>&1; then
      {
        echo "STATE_LOCK_REF=$LOCK_REF"
        echo "STATE_LOCK_SHA=$lock_sha"
        echo "STATE_LOCK_SUBJECT=$SUBJECT"
        # Backward-compat for any callers still reading the old env names.
        echo "DURABLE_RELEASE_LOCK_REF=$LOCK_REF"
        echo "DURABLE_RELEASE_LOCK_SHA=$lock_sha"
      } >>"$GITHUB_ENV"
      echo "Acquired state lock $LOCK_REF (subject=$SUBJECT) at $lock_sha."
      return 0
    fi

    local held_sha
    held_sha="$(remote_lock_sha || true)"
    if [ -z "$held_sha" ]; then
      sleep 2
      continue
    fi

    local message owner_run_id owner_epoch status stale_reason now age
    message="$(lock_message_for "$held_sha" 2>/dev/null || true)"
    owner_run_id="$(printf '%s\n' "$message" | owner_field run_id)"
    owner_epoch="$(printf '%s\n' "$message" | owner_field created_epoch)"
    stale_reason=""

    if [ -n "$owner_run_id" ]; then
      if [ "$owner_run_id" = "$run_id" ]; then
        stale_reason="left by this workflow run"
      else
        status="$(gh api "/repos/${repo}/actions/runs/${owner_run_id}" -q .status 2>/dev/null || true)"
        if [ "$status" = "completed" ]; then
          stale_reason="owner run ${owner_run_id} is completed"
        fi
      fi
    fi

    if [ -z "$stale_reason" ] && [ -n "$owner_epoch" ]; then
      now="$(date -u +%s)"
      age=$((now - owner_epoch))
      if [ "$age" -gt "$LOCK_STALE_SECONDS" ]; then
        stale_reason="lock is older than ${LOCK_STALE_SECONDS}s"
      fi
    fi

    if [ -n "$stale_reason" ]; then
      echo "Removing stale state lock ${held_sha} (subject=$SUBJECT): ${stale_reason}."
      delete_lock_if_unchanged "$held_sha" || true
      sleep 2
      continue
    fi

    if [ -n "$owner_run_id" ]; then
      echo "State lock for subject=$SUBJECT is held by workflow run ${owner_run_id}; waiting ${LOCK_POLL_SECONDS}s."
    else
      echo "State lock for subject=$SUBJECT is held by ${held_sha}; waiting ${LOCK_POLL_SECONDS}s."
    fi
    sleep "$LOCK_POLL_SECONDS"
  done
}

release() {
  local lock_ref="${STATE_LOCK_REF:-${DURABLE_RELEASE_LOCK_REF:-}}"
  local owned_sha="${STATE_LOCK_SHA:-${DURABLE_RELEASE_LOCK_SHA:-}}"

  if [ -z "$owned_sha" ] || [ -z "$lock_ref" ]; then
    echo "No state lock owned by this job."
    return 0
  fi

  LOCK_REF="$lock_ref"
  local held_sha
  held_sha="$(remote_lock_sha || true)"
  if [ "$held_sha" != "$owned_sha" ]; then
    echo "State lock is no longer owned by this job; leaving ${LOCK_REF} unchanged."
    return 0
  fi

  if delete_lock_if_unchanged "$owned_sha"; then
    echo "Released state lock ${LOCK_REF}."
  else
    echo "::warning::Could not release state lock ${LOCK_REF}; a later run will clear it if stale."
  fi
}

case "${1:-}" in
  acquire)
    SUBJECT="${2:?usage: $0 acquire <subject>}"
    acquire
    ;;
  release)
    release
    ;;
  *)
    usage
    exit 2
    ;;
esac
