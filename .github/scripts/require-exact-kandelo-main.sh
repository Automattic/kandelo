#!/usr/bin/env bash
# Fail closed unless one canonical Kandelo commit is the current GitHub main
# branch tip. This script performs no publication writes.
set -euo pipefail

REPOSITORY=""
SOURCE_SHA=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repository) REPOSITORY="$2"; shift 2 ;;
    --source-sha) SOURCE_SHA="$2"; shift 2 ;;
    *)
      echo "require-exact-kandelo-main: unknown flag $1" >&2
      exit 2
      ;;
  esac
done

if [ "$REPOSITORY" != "Automattic/kandelo" ] ||
   ! [[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "require-exact-kandelo-main: Automattic/kandelo and one canonical lowercase 40-character source SHA are required" >&2
  exit 2
fi
if [ "${GITHUB_SERVER_URL:-https://github.com}" != "https://github.com" ]; then
  echo "require-exact-kandelo-main: only github.com main identity is supported" >&2
  exit 2
fi
if [ -z "${GH_TOKEN:-}" ]; then
  echo "require-exact-kandelo-main: GH_TOKEN is required to verify protected main" >&2
  exit 2
fi

if ! main_sha="$(
  gh api "/repos/$REPOSITORY/git/ref/heads/main" --jq .object.sha
)"; then
  echo "require-exact-kandelo-main: could not read refs/heads/main" >&2
  exit 1
fi
if ! [[ "$main_sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "require-exact-kandelo-main: refs/heads/main returned a noncanonical commit identity" >&2
  exit 1
fi
if [ "$SOURCE_SHA" != "$main_sha" ]; then
  # WHY: ancestry, equal trees, tags, and pull-request refs prove neither that
  # these exact source bytes are main nor that main still authorizes a write.
  # Every canonical mutation must therefore re-read the branch ref and compare
  # commit identity, not graph reachability or tree identity.
  echo "require-exact-kandelo-main: source SHA must equal the current refs/heads/main commit" >&2
  exit 1
fi

printf '%s\n' "$main_sha"
