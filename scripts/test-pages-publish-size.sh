#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHECKER="$REPO_ROOT/scripts/check-pages-publish-size.mjs"
FIXTURE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/kandelo-pages-size.XXXXXX")"

cleanup() {
  case "$FIXTURE_ROOT" in
    "${TMPDIR:-/tmp}"/kandelo-pages-size.*)
      rm -rf -- "$FIXTURE_ROOT"
      ;;
  esac
}
trap cleanup EXIT

fail() {
  echo "test-pages-publish-size: $*" >&2
  exit 1
}

mkdir -p "$FIXTURE_ROOT/tree/nested"
printf 'abc' >"$FIXTURE_ROOT/tree/first"
printf 'defgh' >"$FIXTURE_ROOT/tree/nested/second"
node "$CHECKER" "$FIXTURE_ROOT/tree" 8 >/dev/null ||
  fail "an exact-boundary tree was rejected"

truncate -s 1000000000 "$FIXTURE_ROOT/tree/first"
printf '' >"$FIXTURE_ROOT/tree/nested/second"
node "$CHECKER" "$FIXTURE_ROOT/tree" 1000000000 >/dev/null ||
  fail "the documented 1,000,000,000-byte boundary was rejected"

truncate -s 1000000001 "$FIXTURE_ROOT/tree/first"
if output="$(node "$CHECKER" "$FIXTURE_ROOT/tree" 1000000000 2>&1)"; then
  fail "a sparse oversized tree was accepted"
fi
grep -Fq 'exceeds the limit by 1 bytes' <<<"$output" ||
  fail "the oversized-tree failure did not report the excess: $output"

truncate -s 1 "$FIXTURE_ROOT/tree/first"
ln -s first "$FIXTURE_ROOT/tree/link"
if output="$(node "$CHECKER" "$FIXTURE_ROOT/tree" 1000000000 2>&1)"; then
  fail "a publish-tree symbolic link was accepted"
fi
grep -Fq 'symbolic link is not allowed' <<<"$output" ||
  fail "the symbolic-link failure was not explicit: $output"

echo "test-pages-publish-size: ok"
