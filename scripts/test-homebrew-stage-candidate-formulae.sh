#!/usr/bin/env bash
# Focused tests for staging only the declared candidate Formula closure.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
STAGER="$REPO_ROOT/scripts/homebrew-stage-candidate-formulae.sh"
TMP_ROOT="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

fail() {
  echo "test-homebrew-stage-candidate-formulae.sh: $*" >&2
  exit 1
}

: "${KANDELO_DEV_SHELL_TOOL_PATH:?test must run through scripts/dev-shell.sh}"
SOURCE="$TMP_ROOT/source"
TARGET="$TMP_ROOT/target"
mkdir -p "$SOURCE/Formula"
for formula in mini-base mini-tool unrelated; do
  printf 'class %s < Formula\nend\n' "$formula" >"$SOURCE/Formula/$formula.rb"
done
git -C "$SOURCE" init -q
git -C "$SOURCE" add Formula
git -C "$SOURCE" -c user.name=Fixture -c user.email=fixture.invalid \
  commit -qm 'fixture Formulae'
git clone -q "$SOURCE" "$TARGET"

printf 'class MiniBase < Formula\n  bottle do\n  end\nend\n' \
  >"$SOURCE/Formula/mini-base.rb"
printf 'class MiniTool < Formula\n  bottle do\n  end\nend\n' \
  >"$SOURCE/Formula/mini-tool.rb"

"$STAGER" \
  --source-tap "$SOURCE" \
  --target-tap "$TARGET" \
  --target-formula mini-tool \
  --dependency-formula mini-base
cmp -s "$SOURCE/Formula/mini-base.rb" "$TARGET/Formula/mini-base.rb" || \
  fail "declared dependency Formula was not copied"
cmp -s "$SOURCE/Formula/mini-tool.rb" "$TARGET/Formula/mini-tool.rb" || \
  fail "target Formula was not copied"
[ "$(git -C "$TARGET" status --short --untracked-files=all)" = \
  $' M Formula/mini-base.rb\n M Formula/mini-tool.rb' ] || \
  fail "target changes escaped the declared Formula closure"

git -C "$TARGET" reset --hard -q HEAD
printf 'changed undeclared Formula\n' >"$SOURCE/Formula/unrelated.rb"
if "$STAGER" \
  --source-tap "$SOURCE" \
  --target-tap "$TARGET" \
  --target-formula mini-tool \
  --dependency-formula mini-base \
  >"$TMP_ROOT/undeclared.stdout" 2>"$TMP_ROOT/undeclared.stderr"; then
  fail "undeclared reconstructed Formula change was accepted"
fi
grep -F 'source tap changed an undeclared Formula' \
  "$TMP_ROOT/undeclared.stderr" >/dev/null || \
  fail "undeclared source rejection was not explicit"

git -C "$SOURCE" checkout -q -- Formula/unrelated.rb
printf 'dirty destination\n' >"$TARGET/Formula/unrelated.rb"
if "$STAGER" \
  --source-tap "$SOURCE" \
  --target-tap "$TARGET" \
  --target-formula mini-tool \
  --dependency-formula mini-base \
  >"$TMP_ROOT/dirty.stdout" 2>"$TMP_ROOT/dirty.stderr"; then
  fail "dirty destination tap was accepted"
fi
grep -F 'target tap must begin clean' "$TMP_ROOT/dirty.stderr" >/dev/null || \
  fail "dirty target rejection was not explicit"

echo "Homebrew candidate Formula staging: PASS"
