#!/usr/bin/env bash
# Classify whether one pr-<N>-staging release still has an authoritative owner.
set -euo pipefail

if [ "$#" -ne 1 ] || [ ! -f "$1" ] || [ -L "$1" ]; then
  echo "usage: classify-pr-staging.sh <pr-json>" >&2
  exit 2
fi

pr_json="$1"
if ! jq -e '
  type == "object" and
  (.state == "OPEN" or .state == "CLOSED" or .state == "MERGED") and
  ((.mergedAt == null) or (.mergedAt | type == "string" and length > 0)) and
  (.labels | type == "array") and
  all(.labels[]; type == "object" and (.name | type == "string"))
' "$pr_json" >/dev/null
then
  echo "classify-pr-staging: malformed PR state" >&2
  exit 1
fi

state="$(jq -r .state "$pr_json")"
if [ "$state" = OPEN ]; then
  printf '%s\n' retain-open
elif jq -e '
  (.mergedAt | type == "string" and length > 0) and
  any(.labels[]; .name == "retain-package-staging")
' "$pr_json" >/dev/null; then
  # WHY: these bytes are an immutable producer input until a post-merge
  # workflow has validated and promoted their durable package generation.
  printf '%s\n' retain-merged
else
  printf '%s\n' delete
fi
