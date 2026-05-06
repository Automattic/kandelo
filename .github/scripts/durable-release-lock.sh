#!/usr/bin/env bash
set -euo pipefail

LOCK_REF="${DURABLE_RELEASE_LOCK_REF:-refs/heads/github-actions/durable-release-lock}"
LOCK_POLL_SECONDS="${DURABLE_RELEASE_LOCK_POLL_SECONDS:-30}"
LOCK_STALE_SECONDS="${DURABLE_RELEASE_LOCK_STALE_SECONDS:-21600}"

usage() {
  echo "usage: $0 acquire|release" >&2
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
durable release lock

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
  local repo="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
  local run_id="${GITHUB_RUN_ID:?GITHUB_RUN_ID is required}"

  while true; do
    local lock_sha
    lock_sha="$(create_lock_commit)"

    if git push origin "$lock_sha:$LOCK_REF" >/dev/null 2>&1; then
      {
        echo "DURABLE_RELEASE_LOCK_REF=$LOCK_REF"
        echo "DURABLE_RELEASE_LOCK_SHA=$lock_sha"
      } >>"$GITHUB_ENV"
      echo "Acquired durable release lock $LOCK_REF at $lock_sha."
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
      echo "Removing stale durable release lock ${held_sha}: ${stale_reason}."
      delete_lock_if_unchanged "$held_sha" || true
      sleep 2
      continue
    fi

    if [ -n "$owner_run_id" ]; then
      echo "Durable release lock is held by workflow run ${owner_run_id}; waiting ${LOCK_POLL_SECONDS}s."
    else
      echo "Durable release lock is held by ${held_sha}; waiting ${LOCK_POLL_SECONDS}s."
    fi
    sleep "$LOCK_POLL_SECONDS"
  done
}

release() {
  local lock_ref="${DURABLE_RELEASE_LOCK_REF:-$LOCK_REF}"
  local owned_sha="${DURABLE_RELEASE_LOCK_SHA:-}"

  if [ -z "$owned_sha" ]; then
    echo "No durable release lock owned by this job."
    return 0
  fi

  LOCK_REF="$lock_ref"
  local held_sha
  held_sha="$(remote_lock_sha || true)"
  if [ "$held_sha" != "$owned_sha" ]; then
    echo "Durable release lock is no longer owned by this job; leaving ${LOCK_REF} unchanged."
    return 0
  fi

  if delete_lock_if_unchanged "$owned_sha"; then
    echo "Released durable release lock ${LOCK_REF}."
  else
    echo "::warning::Could not release durable release lock ${LOCK_REF}; a later run will clear it if stale."
  fi
}

case "${1:-}" in
  acquire) acquire ;;
  release) release ;;
  *) usage; exit 2 ;;
esac
