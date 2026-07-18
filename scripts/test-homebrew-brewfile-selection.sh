#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
PARSER="$REPO_ROOT/scripts/homebrew-brewfile-selection.rb"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

expect_failure() {
  local name="$1" needle="$2" path="$3"
  if ruby "$PARSER" "$path" >"$TMP_ROOT/$name.out" 2>"$TMP_ROOT/$name.err"; then
    echo "test-homebrew-brewfile-selection.sh: accepted $name" >&2
    exit 1
  fi
  grep -F "$needle" "$TMP_ROOT/$name.err" >/dev/null
}

VALID="$TMP_ROOT/valid.Brewfile"
printf '%s\r\n' \
  '# A static Kandelo image selection.' \
  'tap "kandelo-dev/tap-core"' \
  "brew 'sqlite'" \
  'brew "kandelo-dev/tap-core/xz" # fully qualified is equivalent' \
  >"$VALID"
VALID_JSON="$(ruby "$PARSER" "$VALID")"
VALID_SHA="$(ruby -rdigest -e 'print Digest::SHA256.file(ARGV.fetch(0)).hexdigest' "$VALID")"
VALID_BYTES="$(wc -c <"$VALID" | tr -d ' ')"
jq -e \
  --arg sha "$VALID_SHA" \
  --argjson bytes "$VALID_BYTES" '
    keys == ["bytes", "kind", "packages", "schema", "sha256", "tap_name"] and
    .schema == 1 and
    .kind == "kandelo-static-brewfile-v1" and
    .tap_name == "kandelo-dev/tap-core" and
    .sha256 == $sha and
    .bytes == $bytes and
    .packages == ["sqlite", "xz"]
  ' <<<"$VALID_JSON" >/dev/null

NO_TAP="$TMP_ROOT/no-tap.Brewfile"
printf '%s\n' 'brew "sqlite"' >"$NO_TAP"
expect_failure no-tap "exactly one literal tap entry" "$NO_TAP"

NO_BREW="$TMP_ROOT/no-brew.Brewfile"
printf '%s\n' 'tap "kandelo-dev/tap-core"' >"$NO_BREW"
expect_failure no-brew "at least one literal brew entry" "$NO_BREW"

MULTI_TAP="$TMP_ROOT/multi-tap.Brewfile"
printf '%s\n' \
  'tap "kandelo-dev/tap-core"' \
  'tap "example/tools"' \
  'brew "sqlite"' >"$MULTI_TAP"
expect_failure multi-tap "exactly one literal tap entry" "$MULTI_TAP"

FOREIGN="$TMP_ROOT/foreign.Brewfile"
printf '%s\n' \
  'tap "kandelo-dev/tap-core"' \
  'brew "example/tools/sqlite"' >"$FOREIGN"
expect_failure foreign "must belong to tap" "$FOREIGN"

DUPLICATE="$TMP_ROOT/duplicate.Brewfile"
printf '%s\n' \
  'tap "kandelo-dev/tap-core"' \
  'brew "sqlite"' \
  'brew "kandelo-dev/tap-core/sqlite"' >"$DUPLICATE"
expect_failure duplicate "duplicates requested package" "$DUPLICATE"

OPTIONS="$TMP_ROOT/options.Brewfile"
printf '%s\n' \
  'tap "kandelo-dev/tap-core"' \
  'brew "sqlite", link: false' >"$OPTIONS"
expect_failure options "outside the static subset" "$OPTIONS"

CONDITIONAL="$TMP_ROOT/conditional.Brewfile"
printf '%s\n' \
  'tap "kandelo-dev/tap-core"' \
  'brew "sqlite" if OS.linux?' >"$CONDITIONAL"
expect_failure conditional "outside the static subset" "$CONDITIONAL"

INTERPOLATED="$TMP_ROOT/interpolated.Brewfile"
printf '%s\n' \
  'tap "kandelo-dev/tap-core"' \
  'brew "#{ENV.fetch("PACKAGE")}"' >"$INTERPOLATED"
expect_failure interpolated "outside the static subset" "$INTERPOLATED"

CASK="$TMP_ROOT/cask.Brewfile"
printf '%s\n' \
  'tap "kandelo-dev/tap-core"' \
  'cask "firefox"' >"$CASK"
expect_failure cask "outside the static subset" "$CASK"

MARKER="$TMP_ROOT/executed"
EXECUTABLE="$TMP_ROOT/executable.Brewfile"
printf 'File.write(%q, "executed")\n' "\"$MARKER\"" >"$EXECUTABLE"
printf '%s\n' \
  'tap "kandelo-dev/tap-core"' \
  'brew "sqlite"' >>"$EXECUTABLE"
expect_failure executable "outside the static subset" "$EXECUTABLE"
if [ -e "$MARKER" ]; then
  echo "test-homebrew-brewfile-selection.sh: executed Brewfile Ruby" >&2
  exit 1
fi

TOO_MANY="$TMP_ROOT/too-many.Brewfile"
printf '%s\n' 'tap "kandelo-dev/tap-core"' >"$TOO_MANY"
for index in $(seq 1 129); do
  printf 'brew "package-%s"\n' "$index" >>"$TOO_MANY"
done
expect_failure too-many "more than 128 packages" "$TOO_MANY"

OVERSIZE="$TMP_ROOT/oversize.Brewfile"
dd if=/dev/zero bs=65537 count=1 2>/dev/null | tr '\0' '#' >"$OVERSIZE"
expect_failure oversize "exceeds 65536 bytes" "$OVERSIZE"

SYMLINK="$TMP_ROOT/symlink.Brewfile"
ln -s "$VALID" "$SYMLINK"
expect_failure symlink "regular non-symlink file" "$SYMLINK"

NUL="$TMP_ROOT/nul.Brewfile"
printf 'tap "kandelo-dev/tap-core"\0\nbrew "sqlite"\n' >"$NUL"
expect_failure nul "contains a NUL byte" "$NUL"

INVALID_UTF8="$TMP_ROOT/invalid-utf8.Brewfile"
printf 'tap "kandelo-dev/tap-core"\nbrew "sqlite"\n\377' >"$INVALID_UTF8"
expect_failure invalid-utf8 "not valid UTF-8" "$INVALID_UTF8"

echo "test-homebrew-brewfile-selection.sh: ok"
