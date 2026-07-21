#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILDER="$REPO_ROOT/scripts/build-homebrew-main-shell-closure.sh"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

fail() {
  echo "test-homebrew-main-shell-closure: $*" >&2
  exit 1
}

expect_failure() {
  local expected="$1"
  shift
  local output
  if output="$("$@" 2>&1)"; then
    fail "command unexpectedly succeeded: $*"
  fi
  grep -Fq "$expected" <<<"$output" || {
    printf '%s\n' "$output" >&2
    fail "failure did not contain: $expected"
  }
}

command -v git >/dev/null 2>&1 || fail "git is required"
command -v jq >/dev/null 2>&1 || fail "jq is required"
command -v node >/dev/null 2>&1 || fail "node is required"

for variable in \
  KANDELO_HOMEBREW_MAIN_SHELL_STRICT \
  KANDELO_HOMEBREW_MAIN_SHELL_SHA256
do
  grep -Fq -- "--keep $variable " "$REPO_ROOT/scripts/dev-shell.sh" ||
    fail "dev shell must preserve $variable for exact browser acceptance"
done

expect_failure "KANDELO_HOMEBREW_MAIN_SHELL_TAP_SHA requires" \
  env KANDELO_HOMEBREW_MAIN_SHELL_TAP_SHA=0000000000000000000000000000000000000000 \
  bash "$REPO_ROOT/packages/registry/shell/build-shell.sh"

tap="$TMP_ROOT/tap"
mkdir -p "$tap/Kandelo"
git -C "$tap" init -q
git -C "$tap" config user.email "homebrew-contract-test@example.invalid"
git -C "$tap" config user.name "Homebrew contract test"
printf '%s\n' \
  '{"tap_repository":"kandelo-dev/homebrew-tap-core","tap_name":"kandelo-dev/tap-core"}' \
  >"$tap/Kandelo/metadata.json"
git -C "$tap" add Kandelo/metadata.json
git -C "$tap" commit -qm "Homebrew: Add canonical test metadata"
tap_sha="$(git -C "$tap" rev-parse HEAD)"
lock="$TMP_ROOT/main-shell-migration-lock.json"
jq --arg sha "$tap_sha" '.catalog.tap_commit = $sha' \
  "$REPO_ROOT/homebrew/main-shell-migration-lock.json" >"$lock"

expect_failure "must match locked catalog" \
  "$BUILDER" --tap-root "$tap" \
  --migration-lock "$lock" \
  --expected-tap-sha 0000000000000000000000000000000000000000

printf '%s\n' "untracked" >"$tap/untracked-file"
expect_failure "exact tap checkout is dirty" \
  "$BUILDER" --tap-root "$tap" --migration-lock "$lock"
rm "$tap/untracked-file"

printf '%s\n' \
  '{"tap_repository":"example/wrong-tap","tap_name":"example/wrong"}' \
  >"$tap/Kandelo/metadata.json"
git -C "$tap" add Kandelo/metadata.json
git -C "$tap" commit -qm "Homebrew: Make test identity invalid"
tap_sha="$(git -C "$tap" rev-parse HEAD)"
jq --arg sha "$tap_sha" '.catalog.tap_commit = $sha' \
  "$REPO_ROOT/homebrew/main-shell-migration-lock.json" >"$lock"
expect_failure "tap metadata has the wrong repository identity" \
  "$BUILDER" --tap-root "$tap" --migration-lock "$lock"

node "$REPO_ROOT/scripts/check-homebrew-main-shell-brewfile.mjs"

jq 'del(.catalog)' \
  "$REPO_ROOT/homebrew/main-shell-migration-lock.json" >"$lock"
expect_failure "must pin one exact catalog commit" \
  node "$REPO_ROOT/scripts/check-homebrew-main-shell-brewfile.mjs" \
  "$REPO_ROOT/homebrew/main-shell.Brewfile" "$lock"

jq '.catalog.tap_commit = "main"' \
  "$REPO_ROOT/homebrew/main-shell-migration-lock.json" >"$lock"
expect_failure "must pin one exact catalog commit" \
  node "$REPO_ROOT/scripts/check-homebrew-main-shell-brewfile.mjs" \
  "$REPO_ROOT/homebrew/main-shell.Brewfile" "$lock"

jq 'del(.reviewed_substitutions[-1])' \
  "$REPO_ROOT/homebrew/main-shell-migration-lock.json" >"$lock"
expect_failure "reviewed migration substitutions are incomplete or stale" \
  node "$REPO_ROOT/scripts/check-homebrew-main-shell-brewfile.mjs" \
  "$REPO_ROOT/homebrew/main-shell.Brewfile" "$lock"

jq '.consumer.max_vfs_byte_length = 268435456' \
  "$REPO_ROOT/homebrew/main-shell-migration-lock.json" >"$lock"
expect_failure "must declare the 512 MiB consumer profile" \
  node "$REPO_ROOT/scripts/check-homebrew-main-shell-brewfile.mjs" \
  "$REPO_ROOT/homebrew/main-shell.Brewfile" "$lock"

jq '.compatibility.link_conflict_owners[0].package = "kandelo-dev/tap-core/not-locked"' \
  "$REPO_ROOT/homebrew/main-shell-migration-lock.json" >"$lock"
expect_failure "compatibility.link_conflict_owners[0] is invalid" \
  node "$REPO_ROOT/scripts/check-homebrew-main-shell-brewfile.mjs" \
  "$REPO_ROOT/homebrew/main-shell.Brewfile" "$lock"

echo "test-homebrew-main-shell-closure: ok"
