#!/usr/bin/env bash
# Fail closed unless one exact commit is the current main tip of the named
# public GitHub repository. This script performs no publication writes.
set -euo pipefail

REPOSITORY=""
SOURCE_SHA=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repository) REPOSITORY="$2"; shift 2 ;;
    --source-sha) SOURCE_SHA="$2"; shift 2 ;;
    *)
      echo "require-exact-repository-main: unknown flag $1" >&2
      exit 2
      ;;
  esac
done

owner="${REPOSITORY%%/*}"
if ! [[ "$REPOSITORY" =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,37}[A-Za-z0-9])?/[A-Za-z0-9]([A-Za-z0-9_.-]{0,98}[A-Za-z0-9])?$ ]] ||
   [[ "$owner" == *--* ]] ||
   ! [[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "require-exact-repository-main: one safe owner/repository and one lowercase 40-character source SHA are required" >&2
  exit 2
fi
if [ "${GITHUB_SERVER_URL:-https://github.com}" != "https://github.com" ]; then
  echo "require-exact-repository-main: only github.com main identity is supported" >&2
  exit 2
fi

ANONYMOUS_ROOT="$(mktemp -d)"
cleanup() {
  rm -rf "$ANONYMOUS_ROOT"
}
trap cleanup EXIT

# WHY: use anonymous Git transport for the target repository. Publication
# credentials must not be able to make a private or token-specific ref appear
# to be the public main branch that consumers will resolve. Running outside
# the checkout also excludes its persisted extra headers and URL rewrites.
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
  echo "require-exact-repository-main: could not read public refs/heads/main" >&2
  exit 1
fi
if [ "$(printf '%s\n' "$record" | awk 'NF { count += 1 } END { print count + 0 }')" -ne 1 ] ||
   [ "${record#*[[:space:]]}" != "refs/heads/main" ] ||
   ! [[ "${record%%[[:space:]]*}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "require-exact-repository-main: refs/heads/main returned a noncanonical commit identity" >&2
  exit 1
fi
main_sha="${record%%[[:space:]]*}"
if [ "$SOURCE_SHA" != "$main_sha" ]; then
  echo "require-exact-repository-main: source SHA must equal the public refs/heads/main commit" >&2
  exit 1
fi

printf '%s\n' "$main_sha"
