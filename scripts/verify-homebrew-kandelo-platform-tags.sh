#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PATCH_FILE="$ROOT/homebrew/patches/0001-add-kandelo-wasm-bottle-tags.patch"
TEST_FILE="$ROOT/homebrew/test/kandelo_platform_tags.rb"
BREW_REPO="${HOMEBREW_REPOSITORY:-$(brew --repository)}"
if [ "$#" -gt 0 ]; then
  RUN_ROOT="$1"
else
  RUN_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/kandelo-homebrew-platform-tags.XXXXXX")"
fi
OVERLAY_ROOT="$RUN_ROOT/homebrew-overlay"

mkdir -p "$OVERLAY_ROOT/Library/Homebrew/extend/os/mac/utils"
mkdir -p "$OVERLAY_ROOT/Library/Homebrew/utils"

if git -C "$BREW_REPO" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git -C "$BREW_REPO" apply --check "$PATCH_FILE"
else
  echo "warning: $BREW_REPO is not a git worktree; skipping git apply --check" >&2
fi

cp "$BREW_REPO/Library/Homebrew/hardware.rb" "$OVERLAY_ROOT/Library/Homebrew/hardware.rb"
cp "$BREW_REPO/Library/Homebrew/extend/os/mac/utils/bottles.rb" \
  "$OVERLAY_ROOT/Library/Homebrew/extend/os/mac/utils/bottles.rb"
cp "$BREW_REPO/Library/Homebrew/utils/bottles.rb" "$OVERLAY_ROOT/Library/Homebrew/utils/bottles.rb"

(cd "$OVERLAY_ROOT" && git apply --whitespace=nowarn "$PATCH_FILE")

brew ruby "$TEST_FILE" "$OVERLAY_ROOT/Library/Homebrew"

cat > "$RUN_ROOT/summary.txt" <<SUMMARY
patch: $PATCH_FILE
test: $TEST_FILE
homebrew_repository: $BREW_REPO
overlay: $OVERLAY_ROOT
result: pass
SUMMARY
