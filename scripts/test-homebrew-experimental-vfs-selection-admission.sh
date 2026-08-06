#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ADMISSION="$REPO_ROOT/scripts/validate-homebrew-experimental-vfs-selection.sh"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/kandelo-vfs-admission.XXXXXX")"
trap 'rm -rf -- "$TEST_ROOT"' EXIT

fail() {
  echo "test-homebrew-experimental-vfs-selection-admission: $*" >&2
  exit 1
}

create_tap() {
  local tap_root="$1"
  git init -q "$tap_root"
  git -C "$tap_root" config user.email test@example.invalid
  git -C "$tap_root" config user.name "Kandelo test"
  mkdir -p "$tap_root/Kandelo/selections"
  printf '{"schema":"fixture"}\n' \
    >"$tap_root/Kandelo/selections/experimental-abi42.json"
  git -C "$tap_root" add Kandelo/selections/experimental-abi42.json
  git -C "$tap_root" commit -qm "Add selection fixture"
}

run_admission() {
  local tap_root="$1"
  local selection="$tap_root/Kandelo/selections/experimental-abi42.json"
  env \
    TAP_ROOT="$tap_root" \
    TAP_REVISION="$(git -C "$tap_root" rev-parse HEAD)" \
    SELECTION_PATH=Kandelo/selections/experimental-abi42.json \
    SELECTION_SHA256="$(sha256sum "$selection" | awk '{print $1}')" \
    bash "$ADMISSION"
}

expect_rejection() {
  local label="$1"
  local tap_root="$2"
  if run_admission "$tap_root" >"$TEST_ROOT/$label.log" 2>&1; then
    fail "accepted $label"
  fi
}

plain_tap="$TEST_ROOT/plain"
create_tap "$plain_tap"
run_admission "$plain_tap"

tampered_regular_tap="$TEST_ROOT/tampered-regular"
create_tap "$tampered_regular_tap"
printf '{"schema":"tampered"}\n' \
  >"$tampered_regular_tap/Kandelo/selections/experimental-abi42.json"
expect_rejection tracked-regular-overwritten-after-commit "$tampered_regular_tap"

leaf_link_tap="$TEST_ROOT/leaf-link"
create_tap "$leaf_link_tap"
mv "$leaf_link_tap/Kandelo/selections/experimental-abi42.json" \
  "$leaf_link_tap/Kandelo/experimental-abi42.json"
ln -s ../experimental-abi42.json \
  "$leaf_link_tap/Kandelo/selections/experimental-abi42.json"
expect_rejection selection-symlink "$leaf_link_tap"

root_link_tap="$TEST_ROOT/root-link"
create_tap "$root_link_tap"
mv "$root_link_tap/Kandelo/selections" \
  "$root_link_tap/Kandelo/relocated-selections"
ln -s relocated-selections "$root_link_tap/Kandelo/selections"
expect_rejection selections-root-symlink "$root_link_tap"

echo "test-homebrew-experimental-vfs-selection-admission: ok"
