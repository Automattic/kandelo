#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
BREW_COMMIT="34c40c18ffa2029b611b61c73273e32c003d0842"
EXPECTED_BUILD_BLOB="be833176c02f78cd5b3502aac968b5a733cb7af8"
BREW_SOURCE=""
TMP_ROOT=""
BREW_ROOT=""

fail() {
  echo "test-homebrew-publisher-real-lifecycle.sh: $*" >&2
  exit 1
}

consider_brew_source() {
  local candidate="$1"
  [ -n "$candidate" ] || return 0
  [ -d "$candidate" ] || return 0
  [ "$(git -C "$candidate" rev-parse --is-inside-work-tree 2>/dev/null || true)" = true ] || return 0
  [ "$(git -C "$candidate" cat-file -t "$BREW_COMMIT" 2>/dev/null || true)" = commit ] || return 0
  [ "$(git -C "$candidate" rev-parse "$BREW_COMMIT:Library/Homebrew/build.rb")" = \
    "$EXPECTED_BUILD_BLOB" ] || return 0
  BREW_SOURCE="$(cd "$candidate" && pwd -P)"
}

cleanup() {
  local status=$?
  if [ -n "$BREW_ROOT" ] && [ -n "$BREW_SOURCE" ] && [ -e "$BREW_ROOT" ]; then
    git -C "$BREW_SOURCE" worktree remove --force "$BREW_ROOT" >/dev/null 2>&1 || true
  fi
  if [ -n "$TMP_ROOT" ] && [ -d "$TMP_ROOT" ]; then
    find "$TMP_ROOT" -depth -mindepth 1 -delete >/dev/null 2>&1 || true
    rmdir "$TMP_ROOT" >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap cleanup EXIT

consider_brew_source "${KANDELO_HOMEBREW_SOURCE_REPOSITORY:-}"
for candidate in /opt/homebrew /home/linuxbrew/.linuxbrew/Homebrew /usr/local/Homebrew; do
  [ -z "$BREW_SOURCE" ] || break
  consider_brew_source "$candidate"
done
[ -n "$BREW_SOURCE" ] || fail \
  "the pinned Homebrew commit is unavailable; set KANDELO_HOMEBREW_SOURCE_REPOSITORY"

TMP_ROOT="$(mktemp -d)"
TMP_ROOT="$(cd "$TMP_ROOT" && pwd -P)"
BREW_ROOT="$TMP_ROOT/brew"
git -C "$BREW_SOURCE" worktree add --detach "$BREW_ROOT" "$BREW_COMMIT" >/dev/null
git -C "$BREW_ROOT" apply "$REPO_ROOT/homebrew/patches/0001-add-kandelo-wasm-bottle-tags.patch"
git -C "$BREW_ROOT" apply "$REPO_ROOT/homebrew/patches/0002-support-isolated-publisher.patch"

# Reuse the already provisioned Homebrew Ruby and bundle. The test must execute
# the exact pinned source, but it must not download toolchain state to do so.
SOURCE_VENDOR="$BREW_SOURCE/Library/Homebrew/vendor"
PORTABLE_RUBY_VERSION="$(<"$BREW_ROOT/Library/Homebrew/vendor/portable-ruby-version")"
if [ -d "$SOURCE_VENDOR/portable-ruby/$PORTABLE_RUBY_VERSION" ]; then
  mkdir -p "$BREW_ROOT/Library/Homebrew/vendor/portable-ruby"
  ln -s "$SOURCE_VENDOR/portable-ruby/$PORTABLE_RUBY_VERSION" \
    "$BREW_ROOT/Library/Homebrew/vendor/portable-ruby/$PORTABLE_RUBY_VERSION"
  ln -s "$PORTABLE_RUBY_VERSION" "$BREW_ROOT/Library/Homebrew/vendor/portable-ruby/current"
fi
if [ -d "$SOURCE_VENDOR/bundle" ]; then
  ln -s "$SOURCE_VENDOR/bundle" "$BREW_ROOT/Library/Homebrew/vendor/bundle"
fi

TAP_ROOT="$BREW_ROOT/Library/Taps/kandelo-dev/homebrew-tap-core"
CORE_ROOT="$BREW_ROOT/Library/Taps/homebrew/homebrew-core"
SOURCE_ROOT="$TMP_ROOT/source"
mkdir -p "$TAP_ROOT/Formula" "$TAP_ROOT/Kandelo/formula_support" \
  "$CORE_ROOT/Formula/w" "$SOURCE_ROOT/fixture-1.0" \
  "$BREW_ROOT/Cellar/wabt/1.0/bin" "$BREW_ROOT/opt" \
  "$BREW_ROOT/.tmp" "$BREW_ROOT/.cache" "$BREW_ROOT/.config" "$BREW_ROOT/.home"

printf 'fixture source\n' >"$SOURCE_ROOT/fixture-1.0/README"
tar -C "$SOURCE_ROOT" -czf "$SOURCE_ROOT/fixture-1.0.tar.gz" fixture-1.0
SOURCE_SHA256="$(sha256sum "$SOURCE_ROOT/fixture-1.0.tar.gz" | awk '{print $1}')"

cat >"$TAP_ROOT/Kandelo/formula_support/kandelo_formula_support.rb" <<'RUBY'
# frozen_string_literal: true

module KandeloFormulaSupport
  class WabtRequirement < Requirement
    KANDELO_NATIVE_FORMULA = "wabt"
    KANDELO_NATIVE_SENTINEL = "wasm-validate"

    fatal true
    satisfy(build_env: false) { which("wasm-validate") }
  end
end
RUBY

cat >"$TAP_ROOT/Formula/fixture.rb" <<RUBY
require (Tap.fetch("kandelo-dev", "tap-core").path/"Kandelo/formula_support/kandelo_formula_support").to_s

class Fixture < Formula
  desc "Exercise Kandelo's sealed native Requirement lifecycle"
  homepage "https://example.invalid/fixture"
  url "file://$SOURCE_ROOT/fixture-1.0.tar.gz"
  sha256 "$SOURCE_SHA256"
  license "0BSD"

  depends_on KandeloFormulaSupport::WabtRequirement => [:build, :test]

  def install
    system "wasm-validate", "--kandelo-build-probe"
    (bin/"fixture").write <<~SH
      #!/bin/sh
      exit 0
    SH
  end

  test do
    system "wasm-validate", "--kandelo-test-probe"
  end
end
RUBY

cat >"$CORE_ROOT/Formula/w/wabt.rb" <<RUBY
class Wabt < Formula
  desc "Offline Formula identity for the sealed native proxy"
  homepage "https://example.invalid/wabt"
  url "file://$SOURCE_ROOT/fixture-1.0.tar.gz"
  sha256 "$SOURCE_SHA256"
  license "0BSD"

  def install
    bin.install "README" => "wasm-validate"
  end
end
RUBY

cat >"$BREW_ROOT/Cellar/wabt/1.0/bin/wasm-validate" <<'SH'
#!/bin/sh
set -eu
marker_root="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd -P)"
case "${1:-}" in
  --kandelo-build-probe) : >"$marker_root/build-tool-used" ;;
  --kandelo-test-probe) : >"$marker_root/test-tool-used" ;;
  *) exit 64 ;;
esac
SH
chmod 0755 "$BREW_ROOT/Cellar/wabt/1.0/bin/wasm-validate"
ln -s ../Cellar/wabt/1.0 "$BREW_ROOT/opt/wabt"

for repository in "$TAP_ROOT" "$CORE_ROOT"; do
  git -C "$repository" init -q
  git -C "$repository" config user.name "Kandelo tests"
  git -C "$repository" config user.email "tests@kandelo.invalid"
  git -C "$repository" add .
  git -C "$repository" commit -qm "Test: create offline Formula fixture"
done
TAP_COMMIT="$(git -C "$TAP_ROOT" rev-parse HEAD)"

cat >"$BREW_ROOT/.kandelo-publisher-build-dependencies.json" <<JSON
{
  "schema": 4,
  "tap": "kandelo-dev/tap-core",
  "formula": "fixture",
  "full_name": "kandelo-dev/tap-core/fixture",
  "target_taps": [{
    "tap_name": "kandelo-dev/tap-core",
    "tap_repository": "kandelo-dev/homebrew-tap-core",
    "tap_commit": "$TAP_COMMIT"
  }],
  "build": ["wabt"],
  "build_and_test": ["wabt"],
  "native_requirements": [{
    "class": "KandeloFormulaSupport::WabtRequirement",
    "formula": "wabt",
    "sentinel": "wasm-validate",
    "tags": ["build", "test"]
  }],
  "runtime_and_test": ["wabt"]
}
JSON
chmod 0444 "$BREW_ROOT/.kandelo-publisher-build-dependencies.json"

BREW_ENV=(
  HOME="$BREW_ROOT/.home"
  HOMEBREW_CACHE="$BREW_ROOT/.cache"
  HOMEBREW_NO_ANALYTICS=1
  HOMEBREW_NO_AUTO_UPDATE=1
  HOMEBREW_NO_ENV_HINTS=1
  HOMEBREW_NO_INSTALL_CLEANUP=1
  HOMEBREW_NO_INSTALL_FROM_API=1
  HOMEBREW_TEMP="$BREW_ROOT/.tmp"
  XDG_CONFIG_HOME="$BREW_ROOT/.config"
)

env "${BREW_ENV[@]}" "$BREW_ROOT/bin/brew" install --build-bottle \
  --ignore-dependencies kandelo-dev/tap-core/fixture
[ -e "$BREW_ROOT/Cellar/wabt/1.0/build-tool-used" ] || fail \
  "the real Build/Superenv lifecycle did not execute the native Requirement tool"

env "${BREW_ENV[@]}" "$BREW_ROOT/bin/brew" test kandelo-dev/tap-core/fixture
[ -e "$BREW_ROOT/Cellar/wabt/1.0/test-tool-used" ] || fail \
  "the real Formula test lifecycle did not execute the sealed native Requirement tool"

RECEIPT="$BREW_ROOT/Cellar/fixture/1.0/.brew/fixture.rb"
[ -f "$RECEIPT" ] || fail "the real pinned Homebrew lifecycle did not install the fixture"

echo "test-homebrew-publisher-real-lifecycle.sh: ok"
