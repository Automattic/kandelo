#!/usr/bin/env bash
# Verify the immutable commit chain behind one preserved canonical package
# source. This helper performs no network access or repository writes.
set -euo pipefail

REPOSITORY_ROOT=""
PRODUCER_SHA=""
PRESERVATION_AUTHORITY_SHA=""
CURRENT_AUTHORITY_SHA=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repository-root) REPOSITORY_ROOT="$2"; shift 2 ;;
    --producer-sha) PRODUCER_SHA="$2"; shift 2 ;;
    --preservation-authority-sha) PRESERVATION_AUTHORITY_SHA="$2"; shift 2 ;;
    --current-authority-sha) CURRENT_AUTHORITY_SHA="$2"; shift 2 ;;
    *)
      echo "verify-package-generation-ancestry: unknown flag $1" >&2
      exit 2
      ;;
  esac
done

if [ ! -d "$REPOSITORY_ROOT" ] || [ -L "$REPOSITORY_ROOT" ] ||
   ! [[ "$PRODUCER_SHA" =~ ^[0-9a-f]{40}$ ]] ||
   ! [[ "$PRESERVATION_AUTHORITY_SHA" =~ ^[0-9a-f]{40}$ ]] ||
   ! [[ "$CURRENT_AUTHORITY_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "verify-package-generation-ancestry: repository and three exact commit SHAs are required" >&2
  exit 2
fi

# WHY: a v2 preservation tag points at M0 because GitHub will not let a
# changed workflow write a release targeting historical S. The public seal
# still names S, so consumers must prove S -> M0 -> current M before treating
# those canonical bytes as eligible for current-main admission.
if ! git -C "$REPOSITORY_ROOT" merge-base --is-ancestor \
     "$PRODUCER_SHA" "$PRESERVATION_AUTHORITY_SHA" ||
   ! git -C "$REPOSITORY_ROOT" merge-base --is-ancestor \
     "$PRESERVATION_AUTHORITY_SHA" "$CURRENT_AUTHORITY_SHA"; then
  echo "verify-package-generation-ancestry: preserved canonical source is outside current-main ancestry" >&2
  exit 1
fi
