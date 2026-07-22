#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
BREW_COMMIT="34c40c18ffa2029b611b61c73273e32c003d0842"
EXPECTED_BUILD_BLOB="be833176c02f78cd5b3502aac968b5a733cb7af8"
EXPECTED_MAC_SANDBOX_BLOB="b81da0fd8878e6a6de1171e0cb7a08a86b4be561"
BREW_SOURCE=""
TMP_ROOT=""
BREW_ROOT=""
BUNDLE_ROOT=""
BUNDLE_RUBY_ROOT=""
NETWORK_PROFILE=""
NETWORK_PROBE_PID=""
OFFLINE_RUNNER=()

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
  [ "$(git -C "$candidate" rev-parse \
    "$BREW_COMMIT:Library/Homebrew/extend/os/mac/sandbox.rb")" = \
    "$EXPECTED_MAC_SANDBOX_BLOB" ] || return 0
  BREW_SOURCE="$(cd "$candidate" && pwd -P)"
}

cleanup() {
  local status=$?
  if [ -n "$NETWORK_PROBE_PID" ]; then
    kill "$NETWORK_PROBE_PID" >/dev/null 2>&1 || true
    wait "$NETWORK_PROBE_PID" >/dev/null 2>&1 || true
  fi
  if [ -n "$TMP_ROOT" ] && [ -d "$TMP_ROOT" ]; then
    chmod -R u+w "$TMP_ROOT" >/dev/null 2>&1 || true
  fi
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

# The whole lifecycle is wrapped in a stronger outer macOS network sandbox.
# Teach this disposable test worktree to skip Homebrew's inner sandbox only
# when it can prove that outer sandbox is already active. macOS rejects nested
# sandbox-exec calls before Formula code runs; Linux can nest its namespaces
# and does not use this OS-specific seam.
git -C "$BREW_ROOT" apply - <<'PATCH'
diff --git a/Library/Homebrew/extend/os/mac/sandbox.rb b/Library/Homebrew/extend/os/mac/sandbox.rb
--- a/Library/Homebrew/extend/os/mac/sandbox.rb
+++ b/Library/Homebrew/extend/os/mac/sandbox.rb
@@ -65,4 +65,8 @@ module OS
         sig { returns(T::Boolean) }
         def available?
+          if ENV["HOMEBREW_KANDELO_HERMETIC_LIFECYCLE_TEST"] == "1" && nested_sandbox?
+            return false
+          end
+
           File.executable?(SANDBOX_EXEC)
         end
PATCH

# Seed a disposable copy of Homebrew's Ruby state before the publisher
# lifecycle begins. The real publisher has the same explicit seed-then-seal
# boundary: Formula build and test code may consume the selected gem group,
# but may neither provision nor mutate it. Never link the temporary worktree to
# the ambient Homebrew bundle because Bundler cleanup would then mutate shared
# developer or runner state.
SOURCE_VENDOR="$BREW_SOURCE/Library/Homebrew/vendor"
PORTABLE_RUBY_VERSION="$(<"$BREW_ROOT/Library/Homebrew/vendor/portable-ruby-version")"
if [ -d "$SOURCE_VENDOR/portable-ruby/$PORTABLE_RUBY_VERSION" ]; then
  mkdir -p "$BREW_ROOT/Library/Homebrew/vendor/portable-ruby"
  cp -R -p "$SOURCE_VENDOR/portable-ruby/$PORTABLE_RUBY_VERSION" \
    "$BREW_ROOT/Library/Homebrew/vendor/portable-ruby/"
  ln -s "$PORTABLE_RUBY_VERSION" "$BREW_ROOT/Library/Homebrew/vendor/portable-ruby/current"
fi
if [ -d "$SOURCE_VENDOR/bundle" ]; then
  # Keep the pinned commit's tracked standalone Bundler loader. Only the
  # untracked gem payload is reusable across Homebrew worktrees; copying a
  # newer loader would leave it naming newer gem versions after the pinned
  # provisioning step correctly prunes them.
  mkdir -p "$BREW_ROOT/Library/Homebrew/vendor/bundle"
  cp -R -p "$SOURCE_VENDOR/bundle/ruby" \
    "$BREW_ROOT/Library/Homebrew/vendor/bundle/"
fi

mkdir -p "$BREW_ROOT/.tmp" "$BREW_ROOT/.cache" "$BREW_ROOT/.config" \
  "$BREW_ROOT/.home"
BREW_ENV=(
  HOME="$BREW_ROOT/.home"
  HOMEBREW_CACHE="$BREW_ROOT/.cache"
  HOMEBREW_NO_ANALYTICS=1
  HOMEBREW_NO_AUTO_UPDATE=1
  HOMEBREW_NO_ENV_HINTS=1
  HOMEBREW_NO_INSTALL_CLEANUP=1
  HOMEBREW_NO_INSTALL_FROM_API=1
  HOMEBREW_KANDELO_HERMETIC_LIFECYCLE_TEST=1
  HOMEBREW_TEMP="$BREW_ROOT/.tmp"
  XDG_CONFIG_HOME="$BREW_ROOT/.config"
)

PROVISION_LOG="$TMP_ROOT/bundler-provision.log"
if ! env "${BREW_ENV[@]}" "$BREW_ROOT/bin/brew" \
  install-bundler-gems --groups=formula_test >"$PROVISION_LOG" 2>&1; then
  cat "$PROVISION_LOG" >&2
  fail "could not provision the disposable formula_test gem group"
fi

BUNDLE_ROOT="$BREW_ROOT/Library/Homebrew/vendor/bundle"
BUNDLE_RUBY_ROOT="$BUNDLE_ROOT/ruby"
[ -d "$BUNDLE_ROOT" ] && [ ! -L "$BUNDLE_ROOT" ] ||
  fail "the provisioned Bundler vendor root is not a real directory"
[ -d "$BUNDLE_RUBY_ROOT" ] && [ ! -L "$BUNDLE_RUBY_ROOT" ] ||
  fail "the provisioned Bundler Ruby root is not a real directory"
UNSAFE_BUNDLE_ENTRY="$(find "$BUNDLE_RUBY_ROOT" -mindepth 1 \
  ! \( -type d -o -type f \) -print -quit)"
[ -z "$UNSAFE_BUNDLE_ENTRY" ] ||
  fail "the provisioned Bundler vendor tree contains a non-regular entry"
[ "$(LC_ALL=C sort "$BUNDLE_RUBY_ROOT/.homebrew_gem_groups")" = "formula_test" ] ||
  fail "the provisioned Bundler state does not contain exactly formula_test"
[ "$(find "$BUNDLE_RUBY_ROOT" -mindepth 2 -maxdepth 2 -type f \
  -name .homebrew_vendor_version -print | awk 'END { print NR + 0 }')" -eq 1 ] ||
  fail "the provisioned Bundler state has an ambiguous vendor version"
[ "$(find "$BUNDLE_RUBY_ROOT" -mindepth 2 -maxdepth 2 -type f \
  -name .homebrew_vendor_version -exec cat {} \;)" = "7" ] ||
  fail "the provisioned Bundler state has the wrong vendor version"
git -C "$BREW_ROOT" diff --quiet -- Library/Homebrew/vendor/bundle/bundler/setup.rb ||
  fail "Bundler provisioning rewrote the pinned standalone loader"

# Seal the exact disposable bundle before any Formula-controlled process runs.
# A content digest after both commands proves that even harmless-looking
# Bundler cleanup did not rewrite or prune the sealed toolchain.
find "$BUNDLE_ROOT" -type d -exec chmod a-w {} +
find "$BUNDLE_ROOT" -type f -exec chmod a-w {} +
BUNDLE_DIGEST_BEFORE="$(find "$BUNDLE_ROOT" -type f -print0 |
  LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | awk '{print $1}')"

# Network denial is an OS boundary, not a proxy-only convention. macOS uses
# sandbox-exec; Linux uses a private user/network namespace while preserving
# the caller's non-root uid so Homebrew does not observe a root invocation.
case "$(uname -s)" in
  Darwin)
    [ -x /usr/bin/sandbox-exec ] || fail "sandbox-exec is unavailable"
    NETWORK_PROFILE="$TMP_ROOT/no-network.sb"
    cat >"$NETWORK_PROFILE" <<EOF
(version 1)
(allow default)
(deny network*)
(allow network* (subpath "$BREW_ROOT/.tmp"))
EOF
    OFFLINE_RUNNER=(/usr/bin/sandbox-exec -f "$NETWORK_PROFILE")
    ;;
  Linux)
    [ -x /usr/bin/unshare ] || fail "/usr/bin/unshare is unavailable"
    if /usr/bin/unshare --user --map-current-user --net -- /usr/bin/true; then
      OFFLINE_RUNNER=(/usr/bin/unshare --user --map-current-user --net --)
    elif [ -x /usr/bin/sudo ] && /usr/bin/sudo -n /usr/bin/true && \
      /usr/bin/sudo -n /usr/bin/unshare --net \
        --setgid="$(id -g)" --setuid="$(id -u)" -- /usr/bin/true; then
      OFFLINE_RUNNER=(/usr/bin/sudo -n /usr/bin/unshare --net
        --setgid="$(id -g)" --setuid="$(id -u)" --)
    else
      fail "neither unprivileged nor passwordless-sudo network isolation is available"
    fi
    # If an outer namespace prevents Bubblewrap from nesting, Homebrew may use
    # that already-active sandbox instead of treating the build as unisolated.
    BREW_ENV+=(HOMEBREW_AVOID_NESTED_SANDBOXING=1)
    ;;
  *)
    fail "no enforced network-isolation backend exists for $(uname -s)"
    ;;
esac

# Prove the selected isolation primitive actually blocks a reachable socket.
# This catches sandbox/profile regressions before a coincidentally cached gem
# set could make the lifecycle appear hermetic.
PYTHON_BIN="$(command -v python3 || true)"
[ -n "$PYTHON_BIN" ] || fail "python3 is required for the network-isolation probe"
NETWORK_PROBE_PORT="$TMP_ROOT/network-probe.port"
"$PYTHON_BIN" -c 'import socket, sys
s = socket.socket()
s.bind(("127.0.0.1", 0))
s.listen(2)
print(s.getsockname()[1], flush=True)
for _ in range(2):
    connection, _ = s.accept()
    connection.close()' >"$NETWORK_PROBE_PORT" &
NETWORK_PROBE_PID=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do
  [ -s "$NETWORK_PROBE_PORT" ] && break
  sleep 0.1
done
[ -s "$NETWORK_PROBE_PORT" ] || fail "the network-isolation probe did not start"
PROBE_PORT="$(cat "$NETWORK_PROBE_PORT")"
"$PYTHON_BIN" -c 'import socket, sys
connection = socket.create_connection(("127.0.0.1", int(sys.argv[1])), timeout=2)
connection.close()' "$PROBE_PORT" || fail "the network-isolation control connection failed"
if "${OFFLINE_RUNNER[@]}" "$PYTHON_BIN" -c 'import socket, sys
connection = socket.create_connection(("127.0.0.1", int(sys.argv[1])), timeout=2)
connection.close()' "$PROBE_PORT" >/dev/null 2>&1; then
  fail "the network-isolation boundary allowed a reachable socket"
fi
kill "$NETWORK_PROBE_PID" >/dev/null 2>&1 || true
wait "$NETWORK_PROBE_PID" >/dev/null 2>&1 || true
NETWORK_PROBE_PID=""

run_offline_brew() {
  local phase="$1"
  shift
  local log="$TMP_ROOT/$phase.log"
  if ! "${OFFLINE_RUNNER[@]}" env "${BREW_ENV[@]}" \
    http_proxy=http://127.0.0.1:9 \
    https_proxy=http://127.0.0.1:9 \
    all_proxy=http://127.0.0.1:9 \
    "$BREW_ROOT/bin/brew" "$@" >"$log" 2>&1; then
    cat "$log" >&2
    fail "the offline Homebrew $phase lifecycle failed"
  fi
  cat "$log"
  if grep -E "Fetching gem metadata|rubygems\\.org|Bundle complete!|Installing '[^']+' gem|install-bundler-gems|bundle install" \
    "$log" >/dev/null; then
    fail "the offline Homebrew $phase lifecycle attempted a gem fetch or install"
  fi
}

TAP_ROOT="$BREW_ROOT/Library/Taps/kandelo-dev/homebrew-tap-core"
CORE_ROOT="$BREW_ROOT/Library/Taps/homebrew/homebrew-core"
SOURCE_ROOT="$TMP_ROOT/source"
mkdir -p "$TAP_ROOT/Formula" "$TAP_ROOT/Kandelo/formula_support" \
  "$CORE_ROOT/Formula/w" "$SOURCE_ROOT/fixture-1.0" \
  "$BREW_ROOT/Cellar/wabt/1.0/bin" "$BREW_ROOT/opt"

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

run_offline_brew install install --build-bottle \
  --ignore-dependencies kandelo-dev/tap-core/fixture
[ -e "$BREW_ROOT/Cellar/wabt/1.0/build-tool-used" ] || fail \
  "the real Build/Superenv lifecycle did not execute the native Requirement tool"

run_offline_brew test test kandelo-dev/tap-core/fixture
[ -e "$BREW_ROOT/Cellar/wabt/1.0/test-tool-used" ] || fail \
  "the real Formula test lifecycle did not execute the sealed native Requirement tool"

BUNDLE_DIGEST_AFTER="$(find "$BUNDLE_ROOT" -type f -print0 |
  LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | awk '{print $1}')"
[ "$BUNDLE_DIGEST_AFTER" = "$BUNDLE_DIGEST_BEFORE" ] ||
  fail "the real publisher lifecycle changed the sealed Bundler vendor tree"

RECEIPT="$BREW_ROOT/Cellar/fixture/1.0/.brew/fixture.rb"
[ -f "$RECEIPT" ] || fail "the real pinned Homebrew lifecycle did not install the fixture"

echo "test-homebrew-publisher-real-lifecycle.sh: ok"
