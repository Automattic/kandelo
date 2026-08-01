#!/usr/bin/env bash
# Fail closed unless one exact commit is reachable from GitHub's current main.
# This script performs no publication writes.
set -euo pipefail

REPOSITORY=""
SOURCE_SHA=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repository) REPOSITORY="${2:-}"; shift 2 ;;
    --source-sha) SOURCE_SHA="${2:-}"; shift 2 ;;
    *)
      echo "require-repository-main-contains: unknown flag $1" >&2
      exit 2
      ;;
  esac
done

owner="${REPOSITORY%%/*}"
if ! [[ "$REPOSITORY" =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,37}[A-Za-z0-9])?/[A-Za-z0-9]([A-Za-z0-9_.-]{0,98}[A-Za-z0-9])?$ ]] ||
   [[ "$owner" == *--* ]] ||
   ! [[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "require-repository-main-contains: one safe owner/repository and lowercase 40-character source SHA are required" >&2
  exit 2
fi
if [ "${GITHUB_SERVER_URL:-https://github.com}" != "https://github.com" ]; then
  echo "require-repository-main-contains: only github.com main identity is supported" >&2
  exit 2
fi
if [ -z "${GH_TOKEN:-${GITHUB_TOKEN:-}}" ]; then
  echo "require-repository-main-contains: a GitHub token is required to verify protected main" >&2
  exit 2
fi

ANONYMOUS_ROOT="$(mktemp -d)"
cleanup() {
  rm -rf "$ANONYMOUS_ROOT"
}
trap cleanup EXIT

# WHY: credentials may expose private refs or token-specific rewrites. Read the
# protected target anonymously so the history authority is exactly the public
# main branch that consumers can resolve.
if ! record="$(
  cd "$ANONYMOUS_ROOT"
  env -u GH_TOKEN -u GITHUB_TOKEN \
      GIT_CONFIG_NOSYSTEM=1 \
      GIT_CONFIG_GLOBAL=/dev/null \
      GIT_TERMINAL_PROMPT=0 \
      git \
        -c credential.helper= \
        -c http.https://github.com/.extraheader= \
        ls-remote \
      "https://github.com/${REPOSITORY}.git" refs/heads/main
)"; then
  echo "require-repository-main-contains: could not read public refs/heads/main" >&2
  exit 1
fi
if [ "$(printf '%s\n' "$record" | awk 'NF { count += 1 } END { print count + 0 }')" -ne 1 ] ||
   [ "${record#*[[:space:]]}" != "refs/heads/main" ] ||
   ! [[ "${record%%[[:space:]]*}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "require-repository-main-contains: public main returned a noncanonical commit identity" >&2
  exit 1
fi
main_sha="${record%%[[:space:]]*}"

if ! comparison="$(
  GH_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}" \
    gh api "/repos/$REPOSITORY/compare/$SOURCE_SHA...$main_sha" \
      --jq '[.status, .base_commit.sha, .merge_base_commit.sha] | @tsv'
)"; then
  echo "require-repository-main-contains: could not compare source with protected main" >&2
  exit 1
fi
IFS=$'\t' read -r status base_sha merge_base_sha extra <<<"$comparison"
if [ -n "${extra:-}" ] ||
   [ "$base_sha" != "$SOURCE_SHA" ] ||
   [ "$merge_base_sha" != "$SOURCE_SHA" ] ||
   { [ "$status" != ahead ] && [ "$status" != identical ]; }; then
  # WHY: a campaign may intentionally publish from a reviewed commit that
  # predates today's main. Requiring that exact commit to be the merge base
  # proves main still contains it; accepting merely related or same-tree
  # commits would let an unreviewed history authorize a write.
  echo "require-repository-main-contains: source SHA is not contained in the current refs/heads/main history" >&2
  exit 1
fi

printf '%s\n' "$main_sha"
