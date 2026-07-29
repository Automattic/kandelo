#!/usr/bin/env bash
# Regenerate the selected-record lock for native publisher tools on Linux.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
POLICY="$REPO_ROOT/homebrew/homebrew-native-compatibility-roots.json"
PREFLIGHT="$SCRIPT_DIR/homebrew-native-api-preflight.sh"
SOURCE_CHECK="$SCRIPT_DIR/homebrew-native-check-brew-source.sh"
. "$SCRIPT_DIR/homebrew-native-bounded-environment.sh"

if [ "$#" -ne 2 ]; then
  echo "usage: $0 BREW OUTPUT" >&2
  exit 2
fi
BREW_BIN="$1"
OUTPUT="$2"
SUDO_BIN="${KANDELO_HOMEBREW_SUDO_BIN:-/usr/bin/sudo}"

[ "$(uname -s)" = "Linux" ] && [ "$(uname -m)" = "x86_64" ] || {
  echo "update-homebrew-native-compatibility-lock: exact Linux x86_64 is required" >&2
  exit 2
}
[ -x "$BREW_BIN" ] || {
  echo "update-homebrew-native-compatibility-lock: BREW must be executable" >&2
  exit 2
}
[ -x "$SUDO_BIN" ] || {
  echo "update-homebrew-native-compatibility-lock: sudo is unavailable" >&2
  exit 2
}

WORK="$(mktemp -d /tmp/kandelo-homebrew-native-lock.XXXXXX)"
cleanup() {
  local status="$?"
  trap - EXIT
  case "$WORK" in
    /tmp/kandelo-homebrew-native-lock.*)
      "$SUDO_BIN" -n -- /usr/bin/rm -rf -- "$WORK"
      ;;
    *)
      echo "update-homebrew-native-compatibility-lock: refusing unsafe cleanup" >&2
      status=2
      ;;
  esac
  exit "$status"
}
trap cleanup EXIT

ROOTS="$WORK/roots.txt"
RAW="$WORK/dependencies.raw"
CLOSURE="$WORK/closure.txt"
CACHE="$WORK/cache"
STATE="$WORK/state"
GENERATED="$WORK/compatibility-lock.json"
SOURCE_BEFORE="$WORK/source-before.json"
SOURCE_AFTER="$WORK/source-after.json"

jq -er '[.roots[][]] | sort | unique[]' "$POLICY" >"$ROOTS"
KANDELO_HOMEBREW_SUDO_BIN="$SUDO_BIN" \
  bash "$PREFLIGHT" prepare \
    "$BREW_BIN" "$CACHE" "$STATE" "$POLICY" all "$ROOTS"
# The first Brew entry may install Homebrew's checksum-pinned portable Ruby.
# Bind that complete ignored runtime after bootstrap, then require it and the
# reviewed tracked checkout to remain byte-for-byte stable through generation.
BREW_REPOSITORY="$(
  bash "$SOURCE_CHECK" "$BREW_BIN" "$POLICY" "$SOURCE_BEFORE"
)"

formula_refs=()
while IFS= read -r name; do
  formula_refs+=("homebrew/core/$name")
done <"$ROOTS"
homebrew_native_bounded_run \
  "$BREW_BIN" "$CACHE" "$STATE" api-client \
  deps --union --include-implicit --full-name --formula \
  "${formula_refs[@]}" >"$RAW"
LC_ALL=C sort -u "$ROOTS" "$RAW" >"$CLOSURE"

bash "$PREFLIGHT" generate-lock \
  "$BREW_BIN" "$CACHE" "$STATE" "$POLICY" "$ROOTS" "$CLOSURE" \
  "$GENERATED"

# Rebind the executable after every Homebrew operation. A concurrent checkout
# mutation must not become reviewed lock bytes merely because preflight saw a
# clean tree before dependency resolution began.
[ "$(
  bash "$SOURCE_CHECK" "$BREW_BIN" "$POLICY" "$SOURCE_AFTER"
)" = "$BREW_REPOSITORY" ] &&
  cmp -s "$SOURCE_BEFORE" "$SOURCE_AFTER" || {
  echo "update-homebrew-native-compatibility-lock: brew source changed" >&2
  exit 2
}

# The oracle creates GENERATED without replacement. Only this trusted updater
# replaces the reviewed repository artifact after the complete lock exists.
install -m 0644 "$GENERATED" "$OUTPUT"
