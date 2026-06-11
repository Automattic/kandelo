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
LOCK_SAME_RUN_STALE_SECONDS="${STATE_LOCK_SAME_RUN_STALE_SECONDS:-1800}"
STATE_LOCK_OWNER_TOKEN="${STATE_LOCK_OWNER_TOKEN:-}"
STATE_LOCK_OWNER_DETAIL="${STATE_LOCK_OWNER_DETAIL:-}"

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

git_auth_header() {
  local token="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
  if [ -z "$token" ]; then
    return 1
  fi

  printf 'AUTHORIZATION: basic %s' \
    "$(printf 'x-access-token:%s' "$token" | base64 | tr -d '\n')"
}

git_remote() {
  local header
  if header="$(git_auth_header 2>/dev/null)"; then
    git \
      -c "http.https://github.com/.extraheader=" \
      -c "http.https://github.com/.extraheader=$header" \
      "$@"
  else
    git "$@"
  fi
}

remote_lock_sha() {
  git_remote ls-remote origin "$LOCK_REF" | awk '{print $1}'
}

state_file_path() {
  echo "${STATE_LOCK_STATE_FILE:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/state-lock.env}"
}

new_owner_token() {
  if command -v uuidgen >/dev/null 2>&1; then
    uuidgen
    return 0
  fi

  if [ -r /dev/urandom ]; then
    od -An -N16 -tx1 /dev/urandom | tr -d ' \n'
    echo
    return 0
  fi

  printf '%s:%s:%s:%s\n' \
    "${GITHUB_RUN_ID:-}" \
    "${GITHUB_JOB:-}" \
    "$$" \
    "$(date -u +%s)" \
    | git hash-object --stdin
}

ensure_owner_token() {
  if [ -z "$STATE_LOCK_OWNER_TOKEN" ]; then
    STATE_LOCK_OWNER_TOKEN="$(new_owner_token)"
  fi
}

write_lock_state() {
  local lock_ref="$1"
  local lock_sha="$2"
  local state_file

  state_file="$(state_file_path)"
  {
    printf 'STATE_LOCK_REF=%q\n' "$lock_ref"
    printf 'STATE_LOCK_SHA=%q\n' "$lock_sha"
    printf 'STATE_LOCK_SUBJECT=%q\n' "$SUBJECT"
    printf 'STATE_LOCK_OWNER_TOKEN=%q\n' "$STATE_LOCK_OWNER_TOKEN"
    printf 'STATE_LOCK_OWNER_DETAIL=%q\n' "$STATE_LOCK_OWNER_DETAIL"
    printf 'DURABLE_RELEASE_LOCK_REF=%q\n' "$lock_ref"
    printf 'DURABLE_RELEASE_LOCK_SHA=%q\n' "$lock_sha"
  } >"$state_file"

  if [ -n "${GITHUB_ENV:-}" ]; then
    {
      echo "STATE_LOCK_REF=$lock_ref"
      echo "STATE_LOCK_SHA=$lock_sha"
      echo "STATE_LOCK_SUBJECT=$SUBJECT"
      echo "STATE_LOCK_OWNER_TOKEN=$STATE_LOCK_OWNER_TOKEN"
      echo "STATE_LOCK_OWNER_DETAIL=$STATE_LOCK_OWNER_DETAIL"
      # Backward-compat for any callers still reading the old env names.
      echo "DURABLE_RELEASE_LOCK_REF=$lock_ref"
      echo "DURABLE_RELEASE_LOCK_SHA=$lock_sha"
    } >>"$GITHUB_ENV"
  fi
}

load_lock_state() {
  local state_file

  state_file="$(state_file_path)"
  if [ -f "$state_file" ]; then
    # File is written by write_lock_state in this script.
    # Prefer it over inherited GITHUB_ENV values because a later step
    # in the same job may acquire a new lock after an earlier acquire.
    # shellcheck source=/dev/null
    . "$state_file"
  fi
}

delete_lock_if_unchanged() {
  local expected_sha="$1"
  git_remote push \
    --force-with-lease="$LOCK_REF:$expected_sha" \
    origin ":$LOCK_REF" >/dev/null 2>&1
}

lock_message_for() {
  local lock_sha="$1"
  git_remote fetch --no-tags --depth=1 origin "$LOCK_REF" >/dev/null 2>&1
  git log -1 --format=%B "$lock_sha"
}

owner_field() {
  local field="$1"
  sed -n "s/^${field}=//p" | head -n 1
}

same_run_owner_is_inactive() {
  local repo="$1"
  local owner_run_id="$2"
  local owner_detail="$3"
  local owner_detail_alt=""
  local jobs
  local found=0
  local active=0
  local job_name job_status

  if [ -z "$owner_detail" ]; then
    return 1
  fi

  if [[ "$owner_detail" =~ ^([^,]+),[[:space:]]*(wasm32|wasm64)$ ]]; then
    owner_detail_alt="${BASH_REMATCH[2]}, ${BASH_REMATCH[1]}"
  fi

  jobs="$(gh api "/repos/${repo}/actions/runs/${owner_run_id}/jobs" \
    --paginate \
    --jq '.jobs[] | [.name, .status] | @tsv' 2>/dev/null || true)"

  while IFS=$'\t' read -r job_name job_status; do
    if [[ "$job_name" == *"$owner_detail"* ]] ||
       { [ -n "$owner_detail_alt" ] && [[ "$job_name" == *"$owner_detail_alt"* ]]; }
    then
      found=1
      if [ "$job_status" != "completed" ]; then
        active=1
      fi
    fi
  done <<<"$jobs"

  [ "$found" = "1" ] && [ "$active" = "0" ]
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
job=${GITHUB_JOB:-}
owner_token=${STATE_LOCK_OWNER_TOKEN}
owner_detail=${STATE_LOCK_OWNER_DETAIL}
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
  local unresolved_push_failures=0
  local unresolved_push_first_epoch=0
  local unresolved_push_delay=2
  local unresolved_push_max_seconds="${STATE_LOCK_UNRESOLVED_PUSH_FAILURE_SECONDS:-120}"
  ensure_owner_token

  while true; do
    local lock_sha push_output
    lock_sha="$(create_lock_commit)"

    if push_output="$(git_remote push origin "$lock_sha:$LOCK_REF" 2>&1)"; then
      write_lock_state "$LOCK_REF" "$lock_sha"
      echo "Acquired state lock $LOCK_REF (subject=$SUBJECT) at $lock_sha."
      return 0
    fi

    local held_sha
    held_sha="$(remote_lock_sha || true)"
    if [ -z "$held_sha" ]; then
      local unresolved_now unresolved_elapsed
      unresolved_now="$(date -u +%s)"
      if [ "$unresolved_push_first_epoch" = "0" ]; then
        unresolved_push_first_epoch="$unresolved_now"
      fi
      unresolved_elapsed=$((unresolved_now - unresolved_push_first_epoch))
      unresolved_push_failures=$((unresolved_push_failures + 1))
      if [ -n "${STATE_LOCK_UNRESOLVED_PUSH_FAILURES:-}" ] \
           && [ "$unresolved_push_failures" -ge "$STATE_LOCK_UNRESOLVED_PUSH_FAILURES" ] \
           || [ "$unresolved_elapsed" -ge "$unresolved_push_max_seconds" ]
      then
        echo "::error::state-lock cannot push ${LOCK_REF} and cannot read a current lock after ${unresolved_push_failures} attempts over ${unresolved_elapsed}s." >&2
        echo "::error::Check this job's permissions (contents: write is required) and GitHub git transport availability." >&2
        printf '%s\n' "$push_output" >&2
        exit 1
      fi
      echo "State lock push did not acquire subject=$SUBJECT and no current lock was readable; retrying in ${unresolved_push_delay}s."
      sleep "$unresolved_push_delay"
      if [ "$unresolved_push_delay" -lt 30 ]; then
        unresolved_push_delay=$((unresolved_push_delay * 2))
        if [ "$unresolved_push_delay" -gt 30 ]; then
          unresolved_push_delay=30
        fi
      fi
      continue
    fi
    unresolved_push_failures=0
    unresolved_push_first_epoch=0
    unresolved_push_delay=2

    local message owner_run_id owner_token owner_detail owner_epoch status stale_reason now age
    message="$(lock_message_for "$held_sha" 2>/dev/null || true)"
    owner_run_id="$(printf '%s\n' "$message" | owner_field run_id)"
    owner_token="$(printf '%s\n' "$message" | owner_field owner_token)"
    owner_detail="$(printf '%s\n' "$message" | owner_field owner_detail)"
    owner_epoch="$(printf '%s\n' "$message" | owner_field created_epoch)"
    stale_reason=""

    if [ -n "$owner_run_id" ]; then
      if [ "$owner_run_id" = "$run_id" ] \
           && [ -n "$owner_token" ] \
           && [ "$owner_token" = "$STATE_LOCK_OWNER_TOKEN" ]
      then
        stale_reason="left by this lock owner"
      elif [ "$owner_run_id" = "$run_id" ] \
             && same_run_owner_is_inactive "$repo" "$owner_run_id" "$owner_detail"
      then
        stale_reason="same-run owner job is no longer active (${owner_detail})"
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
      if [ -n "$owner_run_id" ] \
           && [ "$owner_run_id" = "$run_id" ] \
           && [ "$age" -gt "$LOCK_SAME_RUN_STALE_SECONDS" ]
      then
        stale_reason="same-run lock is older than ${LOCK_SAME_RUN_STALE_SECONDS}s"
      elif [ "$age" -gt "$LOCK_STALE_SECONDS" ]; then
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
      if [ -n "$owner_detail" ]; then
        echo "State lock for subject=$SUBJECT is held by workflow run ${owner_run_id} (${owner_detail}); waiting ${LOCK_POLL_SECONDS}s."
      else
        echo "State lock for subject=$SUBJECT is held by workflow run ${owner_run_id}; waiting ${LOCK_POLL_SECONDS}s."
      fi
    else
      echo "State lock for subject=$SUBJECT is held by ${held_sha}; waiting ${LOCK_POLL_SECONDS}s."
    fi
    sleep "$LOCK_POLL_SECONDS"
  done
}

release() {
  load_lock_state

  local lock_ref="${STATE_LOCK_REF:-${DURABLE_RELEASE_LOCK_REF:-}}"
  local owned_sha="${STATE_LOCK_SHA:-${DURABLE_RELEASE_LOCK_SHA:-}}"

  if [ -z "$owned_sha" ] || [ -z "$lock_ref" ]; then
    echo "No state lock owned by this job."
    return 0
  fi

  LOCK_REF="$lock_ref"
  if delete_lock_if_unchanged "$owned_sha"; then
    echo "Released state lock ${LOCK_REF}."
    rm -f "$(state_file_path)"
  else
    local held_sha
    held_sha="$(remote_lock_sha || true)"
    if [ "$held_sha" != "$owned_sha" ]; then
      echo "State lock is no longer owned by this job; leaving ${LOCK_REF} unchanged."
    else
      echo "::warning::Could not release state lock ${LOCK_REF}; a later run will clear it if stale."
    fi
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
