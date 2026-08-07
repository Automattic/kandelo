#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "validate-homebrew-experimental-vfs-selection: $*" >&2
  exit 1
}

: "${TAP_REVISION:?TAP_REVISION is required}"
: "${SELECTION_PATH:?SELECTION_PATH is required}"
: "${SELECTION_SHA256:?SELECTION_SHA256 is required}"

tap_input="${TAP_ROOT:-tap}"
[[ "$TAP_REVISION" =~ ^[0-9a-f]{40}$ ]] ||
  fail "tap revision must be an exact lowercase commit"
[[ "$SELECTION_SHA256" =~ ^[0-9a-f]{64}$ ]] ||
  fail "selection SHA-256 must be exact lowercase hex"
[[ "$SELECTION_PATH" =~ ^Kandelo/selections/[A-Za-z0-9][A-Za-z0-9._/-]*\.json$ ]] ||
  fail "selection path is outside Kandelo/selections/"
case "/$SELECTION_PATH/" in
  *"/../"*|*"/./"*|*"//"*)
    fail "selection path contains an unsafe component"
    ;;
esac

selection_input="$tap_input/$SELECTION_PATH"
selection_root_input="$tap_input/Kandelo/selections"
[ ! -L "$selection_input" ] ||
  fail "selection must not be a symlink"
[ ! -L "$selection_root_input" ] ||
  fail "Kandelo/selections must not be a symlink"
[ -f "$selection_input" ] ||
  fail "selection must be one regular file"

tap_root="$(realpath "$tap_input")" ||
  fail "tap checkout does not exist"
selection_root="$(realpath "$selection_root_input")" ||
  fail "Kandelo/selections does not exist"
selection_file="$(realpath "$selection_input")" ||
  fail "selection does not exist"

# WHY: resolving only against the tap root would admit a checked-out path
# redirected to an unrelated tap file through a symlinked selections tree.
[ "$selection_root" = "$tap_root/Kandelo/selections" ] ||
  fail "Kandelo/selections is not the canonical tap directory"
case "$selection_file" in
  "$selection_root"/*) ;;
  *) fail "selection escapes canonical Kandelo/selections" ;;
esac

[ "$(git -C "$tap_root" rev-parse --verify 'HEAD^{commit}')" = \
    "$TAP_REVISION" ] ||
  fail "tap checkout differs from the requested revision"
index_mode="$(git -C "$tap_root" ls-files \
  --format='%(objectmode)' -- "$SELECTION_PATH")"
[ "$index_mode" = 100644 ] ||
  fail "selection is not one checked-in regular file"
[ "$(git -C "$tap_root" cat-file -t "$TAP_REVISION:$SELECTION_PATH")" = blob ] ||
  fail "selection is not one regular file at the requested revision"
[ "$(git -C "$tap_root" show "$TAP_REVISION:$SELECTION_PATH" | \
  sha256sum | awk '{print $1}')" = "$SELECTION_SHA256" ] ||
  fail "requested selection SHA-256 does not match the requested revision"
[ "$(sha256sum "$selection_file" | awk '{print $1}')" = \
    "$SELECTION_SHA256" ] ||
  fail "selection bytes differ from the requested SHA-256"
