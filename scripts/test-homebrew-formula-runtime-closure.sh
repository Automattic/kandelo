#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

TAP_ROOT="$TMP_ROOT/tap"
MARKER="$TMP_ROOT/formula-executed"
mkdir -p "$TAP_ROOT/Formula"

cat >"$TAP_ROOT/Formula/required.rb" <<'RUBY'
class Required < Formula
end
RUBY
cat >"$TAP_ROOT/Formula/recommended.rb" <<'RUBY'
class Recommended < Formula
  depends_on "kandelo-dev/tap-core/transitive"
end
RUBY
cat >"$TAP_ROOT/Formula/transitive.rb" <<'RUBY'
class Transitive < Formula
end
RUBY
cat >"$TAP_ROOT/Formula/root.rb" <<'RUBY'
class Root < Formula
  depends_on "pkgconf" => :build
  depends_on "wabt" => [:build, :test]
  depends_on "kandelo-dev/tap-core/required"
  depends_on "kandelo-dev/tap-core/recommended" => :recommended
  depends_on "kandelo-dev/tap-core/optional" => :optional
  depends_on "external-required"
  depends_on "third-party/tools/recommended" => :recommended
  depends_on "external-optional" => :optional
end
RUBY

resolver="$REPO_ROOT/scripts/homebrew-formula-runtime-closure.rb"
declarations="$(ruby "$resolver" "$TAP_ROOT" kandelo-dev/tap-core root --declarations-json)"
jq -e '
  keys == ["dependencies", "formula", "full_name", "schema", "tap"] and
  .schema == 1 and
  .tap == "kandelo-dev/tap-core" and
  .formula == "root" and
  .full_name == "kandelo-dev/tap-core/root" and
  .dependencies == [
    {kind: "optional", name: "external-optional", same_tap: false},
    {kind: "required", name: "external-required", same_tap: false},
    {kind: "optional", name: "kandelo-dev/tap-core/optional", same_tap: true},
    {kind: "recommended", name: "kandelo-dev/tap-core/recommended", same_tap: true},
    {kind: "required", name: "kandelo-dev/tap-core/required", same_tap: true},
    {kind: "recommended", name: "third-party/tools/recommended", same_tap: false}
  ]
' <<<"$declarations" >/dev/null

cat >"$TAP_ROOT/Formula/host-plan.rb" <<'RUBY'
class HostPlan < Formula
  depends_on "python@3.14" => :build
  depends_on "kandelo-dev/tap-core/required"
  depends_on "wabt" => [:build, :test]
  depends_on "kandelo-dev/tap-core/same-build" => :build
  depends_on "check" => :test
  depends_on "kandelo-dev/tap-core/recommended" => :recommended
  depends_on "third-party/tools/optional-tool" => :optional
  depends_on "external-optional" => :optional
  depends_on "kandelo-dev/tap-core/optional" => :optional
end
RUBY
PRIMARY_RESOLVED_TAPS="$TMP_ROOT/primary-resolved-taps.json"
cat >"$PRIMARY_RESOLVED_TAPS" <<JSON
{
  "schema": 1,
  "primary": {
    "tap_name": "kandelo-dev/tap-core",
    "tap_repository": "kandelo-dev/homebrew-tap-core",
    "tap_commit": "1111111111111111111111111111111111111111",
    "root": "$TAP_ROOT"
  },
  "dependencies": []
}
JSON
chmod 0444 "$PRIMARY_RESOLVED_TAPS"
host_plan="$(KANDELO_HOMEBREW_RESOLVED_TAPS_FILE="$PRIMARY_RESOLVED_TAPS" \
  ruby "$resolver" "$TAP_ROOT" kandelo-dev/tap-core host-plan --host-dependencies-json)"
jq -e '
  keys == ["build", "build_and_test", "formula", "full_name", "runtime_and_test", "schema", "tap", "target_taps"] and
  .schema == 3 and
  .tap == "kandelo-dev/tap-core" and
  .formula == "host-plan" and
  .full_name == "kandelo-dev/tap-core/host-plan" and
  .target_taps == [{
    tap_commit: "1111111111111111111111111111111111111111",
    tap_name: "kandelo-dev/tap-core",
    tap_repository: "kandelo-dev/homebrew-tap-core"
  }] and
  .build == ["python@3.14", "wabt"] and
  .build_and_test == ["check", "python@3.14", "wabt"] and
  .runtime_and_test == ["check", "wabt"]
' <<<"$host_plan" >/dev/null
[ "$host_plan" = "$(KANDELO_HOMEBREW_RESOLVED_TAPS_FILE="$PRIMARY_RESOLVED_TAPS" \
  ruby "$resolver" "$TAP_ROOT" kandelo-dev/tap-core host-plan --host-dependencies-json)" ]

cat >"$TAP_ROOT/Formula/third-party-plan.rb" <<'RUBY'
class ThirdPartyPlan < Formula
  depends_on "acme/tools/required"
  depends_on "wabt" => [:build, :test]
end
RUBY
THIRD_PARTY_RESOLVED_TAPS="$TMP_ROOT/third-party-resolved-taps.json"
cat >"$THIRD_PARTY_RESOLVED_TAPS" <<JSON
{
  "schema": 1,
  "primary": {
    "tap_name": "acme/tools",
    "tap_repository": "acme/homebrew-tools",
    "tap_commit": "2222222222222222222222222222222222222222",
    "root": "$TAP_ROOT"
  },
  "dependencies": []
}
JSON
chmod 0444 "$THIRD_PARTY_RESOLVED_TAPS"
third_party_plan="$(KANDELO_HOMEBREW_RESOLVED_TAPS_FILE="$THIRD_PARTY_RESOLVED_TAPS" \
  ruby "$resolver" "$TAP_ROOT" Acme/tools third-party-plan --host-dependencies-json)"
jq -e '
  .tap == "acme/tools" and
  .full_name == "acme/tools/third-party-plan" and
  .build == ["wabt"] and
  .build_and_test == ["wabt"] and
  .runtime_and_test == ["wabt"]
' <<<"$third_party_plan" >/dev/null

cat >"$TAP_ROOT/Formula/external-runtime.rb" <<'RUBY'
class ExternalRuntime < Formula
  depends_on "zstd"
end
RUBY
if ruby "$resolver" "$TAP_ROOT" kandelo-dev/tap-core external-runtime \
  --host-dependencies-json >"$TMP_ROOT/external-runtime.out" 2>"$TMP_ROOT/external-runtime.err"; then
  echo "test-homebrew-formula-runtime-closure.sh: treated external runtime dependency as a host dependency" >&2
  exit 1
fi
grep -F 'external runtime dependency must be same-tap, not a host Formula: "zstd"' \
  "$TMP_ROOT/external-runtime.err" >/dev/null

cat >"$TAP_ROOT/Formula/external-recommended.rb" <<'RUBY'
class ExternalRecommended < Formula
  depends_on "pkgconf" => :recommended
end
RUBY
if ruby "$resolver" "$TAP_ROOT" kandelo-dev/tap-core external-recommended \
  --host-dependencies-json >"$TMP_ROOT/external-recommended.out" \
  2>"$TMP_ROOT/external-recommended.err"; then
  echo "test-homebrew-formula-runtime-closure.sh: treated recommended runtime dependency as a host dependency" >&2
  exit 1
fi
grep -F 'external runtime dependency must be same-tap, not a host Formula: "pkgconf"' \
  "$TMP_ROOT/external-recommended.err" >/dev/null

cat >"$TAP_ROOT/Formula/external-tap.rb" <<'RUBY'
class ExternalTap < Formula
  depends_on "third-party/tools/cmake" => :build
end
RUBY
if ruby "$resolver" "$TAP_ROOT" kandelo-dev/tap-core external-tap \
  --host-dependencies-json >"$TMP_ROOT/external-tap.out" 2>"$TMP_ROOT/external-tap.err"; then
  echo "test-homebrew-formula-runtime-closure.sh: accepted external tap-qualified host dependency" >&2
  exit 1
fi
grep -F 'external tap-qualified host dependency is unsupported: "third-party/tools/cmake"' \
  "$TMP_ROOT/external-tap.err" >/dev/null || \
  grep -F 'external tap-qualified dependency is not locked: "third-party/tools/cmake"' \
    "$TMP_ROOT/external-tap.err" >/dev/null
ruby "$resolver" "$TAP_ROOT" kandelo-dev/tap-core external-tap \
  --declarations-json >/dev/null

DEPENDENCY_TAP_ROOT="$TMP_ROOT/core-tap"
mkdir -p "$DEPENDENCY_TAP_ROOT/Formula"
cat >"$DEPENDENCY_TAP_ROOT/Formula/dash.rb" <<'RUBY'
class Dash < Formula
  bottle do
    root_url "https://ghcr.io/v2/kandelo-dev/homebrew-tap-core"
    sha256 cellar: :any, wasm32_kandelo: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
  end
end
RUBY
cat >"$TAP_ROOT/Formula/cross-root.rb" <<'RUBY'
class CrossRoot < Formula
  depends_on "kandelo-dev/tap-core/dash"
end
RUBY
RESOLVED_TAPS="$TMP_ROOT/resolved-taps.json"
cat >"$RESOLVED_TAPS" <<JSON
{
  "schema": 1,
  "primary": {
    "tap_name": "acme/tools",
    "tap_repository": "acme/homebrew-tools",
    "tap_commit": "1111111111111111111111111111111111111111",
    "root": "$TAP_ROOT"
  },
  "dependencies": [
    {
      "tap_name": "kandelo-dev/tap-core",
      "tap_repository": "kandelo-dev/homebrew-tap-core",
      "tap_commit": "2222222222222222222222222222222222222222",
      "root": "$DEPENDENCY_TAP_ROOT"
    }
  ]
}
JSON
chmod 0444 "$RESOLVED_TAPS"
mv "$TAP_ROOT/Formula/cross-root.rb" "$TAP_ROOT/Formula/m4.rb"
sed -i.bak 's/class CrossRoot/class M4/' "$TAP_ROOT/Formula/m4.rb"
rm "$TAP_ROOT/Formula/m4.rb.bak"

cross_closure="$(KANDELO_HOMEBREW_RESOLVED_TAPS_FILE="$RESOLVED_TAPS" \
  ruby "$resolver" "$TAP_ROOT" acme/tools m4)"
[ "$cross_closure" = 'kandelo-dev/tap-core/dash' ]
cross_direct="$(KANDELO_HOMEBREW_RESOLVED_TAPS_FILE="$RESOLVED_TAPS" \
  ruby "$resolver" "$TAP_ROOT" acme/tools m4 --direct)"
[ "$cross_direct" = 'kandelo-dev/tap-core/dash' ]
cross_bottle="$(KANDELO_HOMEBREW_RESOLVED_TAPS_FILE="$RESOLVED_TAPS" \
  ruby "$resolver" "$TAP_ROOT" acme/tools m4 wasm32)"
jq -e '
  keys == ["kandelo-dev/tap-core/dash"] and
  .["kandelo-dev/tap-core/dash"].url ==
    "https://ghcr.io/v2/kandelo-dev/homebrew-tap-core/dash/blobs/sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
' <<<"$cross_bottle" >/dev/null
cross_host="$(KANDELO_HOMEBREW_RESOLVED_TAPS_FILE="$RESOLVED_TAPS" \
  ruby "$resolver" "$TAP_ROOT" acme/tools m4 --host-dependencies-json)"
jq -e '
  .schema == 3 and
  .target_taps == [
    {
      tap_commit: "1111111111111111111111111111111111111111",
      tap_name: "acme/tools",
      tap_repository: "acme/homebrew-tools"
    },
    {
      tap_commit: "2222222222222222222222222222222222222222",
      tap_name: "kandelo-dev/tap-core",
      tap_repository: "kandelo-dev/homebrew-tap-core"
    }
  ] and
  .build == [] and .build_and_test == [] and .runtime_and_test == []
' \
  <<<"$cross_host" >/dev/null

cat >"$DEPENDENCY_TAP_ROOT/Formula/m4.rb" <<'RUBY'
class M4 < Formula
end
RUBY
cat >"$TAP_ROOT/Formula/m4.rb" <<'RUBY'
class M4 < Formula
  depends_on "kandelo-dev/tap-core/m4"
end
RUBY
if KANDELO_HOMEBREW_RESOLVED_TAPS_FILE="$RESOLVED_TAPS" \
  ruby "$resolver" "$TAP_ROOT" acme/tools m4 \
    >"$TMP_ROOT/cross-duplicate-cellar.out" \
    2>"$TMP_ROOT/cross-duplicate-cellar.err"; then
  echo "test-homebrew-formula-runtime-closure.sh: accepted a cross-tap dependency with the root Formula's Cellar name" >&2
  exit 1
fi
grep -F 'tap dependency closure contains duplicate Cellar names: ["m4:acme/tools/m4,kandelo-dev/tap-core/m4"]' \
  "$TMP_ROOT/cross-duplicate-cellar.err" >/dev/null
rm "$DEPENDENCY_TAP_ROOT/Formula/m4.rb"
cat >"$TAP_ROOT/Formula/m4.rb" <<'RUBY'
class M4 < Formula
  depends_on "kandelo-dev/tap-core/dash"
end
RUBY

cat >"$DEPENDENCY_TAP_ROOT/Formula/dash.rb" <<'RUBY'
class Dash < Formula
  depends_on "acme/tools/m4"

  bottle do
    root_url "https://ghcr.io/v2/kandelo-dev/homebrew-tap-core"
    sha256 cellar: :any, wasm32_kandelo: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
  end
end
RUBY
if KANDELO_HOMEBREW_RESOLVED_TAPS_FILE="$RESOLVED_TAPS" \
  ruby "$resolver" "$TAP_ROOT" acme/tools m4 \
    >"$TMP_ROOT/cross-cycle.out" 2>"$TMP_ROOT/cross-cycle.err"; then
  echo "test-homebrew-formula-runtime-closure.sh: accepted a cross-tap dependency cycle" >&2
  exit 1
fi
grep -F 'tap dependency cycle: acme/tools/m4 -> kandelo-dev/tap-core/dash -> acme/tools/m4' \
  "$TMP_ROOT/cross-cycle.err" >/dev/null

cat >"$TAP_ROOT/Formula/invalid-host.rb" <<'RUBY'
class InvalidHost < Formula
  depends_on "InvalidHost" => :test
end
RUBY
if ruby "$resolver" "$TAP_ROOT" kandelo-dev/tap-core invalid-host \
  --host-dependencies-json >"$TMP_ROOT/invalid-host.out" 2>"$TMP_ROOT/invalid-host.err"; then
  echo "test-homebrew-formula-runtime-closure.sh: accepted malformed host dependency" >&2
  exit 1
fi
grep -F 'invalid host Formula dependency: "InvalidHost"' \
  "$TMP_ROOT/invalid-host.err" >/dev/null

if ruby "$resolver" "$TAP_ROOT" kandelo-dev/tap-core root \
  >"$TMP_ROOT/external.out" 2>"$TMP_ROOT/external.err"; then
  echo "test-homebrew-formula-runtime-closure.sh: accepted selected external dependency" >&2
  exit 1
fi
grep -E "required external Formula dependencies are unsupported|required dependency uses an undeclared tap" \
  "$TMP_ROOT/external.err" >/dev/null

cat >"$TAP_ROOT/Formula/root.rb" <<'RUBY'
class Root < Formula
  depends_on "pkgconf" => :build
  depends_on "wabt" => [:build, :test]
  depends_on "kandelo-dev/tap-core/required"
  depends_on "kandelo-dev/tap-core/recommended" => :recommended
  depends_on "kandelo-dev/tap-core/optional" => :optional
  depends_on "external-optional" => :optional
end
RUBY
closure="$(ruby "$resolver" "$TAP_ROOT" kandelo-dev/tap-core root)"
[ "$closure" = $'kandelo-dev/tap-core/recommended\nkandelo-dev/tap-core/required\nkandelo-dev/tap-core/transitive' ]
direct="$(ruby "$resolver" "$TAP_ROOT" kandelo-dev/tap-core root --direct)"
[ "$direct" = $'kandelo-dev/tap-core/recommended\nkandelo-dev/tap-core/required' ]

cat >"$TAP_ROOT/Formula/recommended.rb" <<'RUBY'
class Recommended < Formula
  depends_on "kandelo-dev/tap-core/transitive"
  depends_on "transitive-external"
end
RUBY
if ruby "$resolver" "$TAP_ROOT" kandelo-dev/tap-core root \
  >"$TMP_ROOT/transitive-external.out" 2>"$TMP_ROOT/transitive-external.err"; then
  echo "test-homebrew-formula-runtime-closure.sh: accepted transitive external dependency" >&2
  exit 1
fi
grep -F 'recommended:transitive-external' "$TMP_ROOT/transitive-external.err" >/dev/null
cat >"$TAP_ROOT/Formula/recommended.rb" <<'RUBY'
class Recommended < Formula
  depends_on "kandelo-dev/tap-core/transitive"
end
RUBY

cat >"$TAP_ROOT/Formula/execute.rb" <<'RUBY'
File.write(ENV.fetch("KANDELO_FORMULA_EXECUTION_MARKER"), "executed")

class Execute < Formula
  depends_on "external-required"
end
RUBY
if KANDELO_FORMULA_EXECUTION_MARKER="$MARKER" \
  ruby "$resolver" "$TAP_ROOT" kandelo-dev/tap-core execute \
    --declarations-json >/dev/null 2>&1; then
  echo "test-homebrew-formula-runtime-closure.sh: executable top-level Formula was accepted" >&2
  exit 1
fi
if [ -e "$MARKER" ]; then
  echo "test-homebrew-formula-runtime-closure.sh: Formula source was executed" >&2
  exit 1
fi

cat >"$TAP_ROOT/Formula/inert.rb" <<'RUBY'
class Inert < Formula
  depends_on "external-required"

  def install
    File.write(ENV.fetch("KANDELO_FORMULA_EXECUTION_MARKER"), "install executed")
  end

  test do
    File.write(ENV.fetch("KANDELO_FORMULA_EXECUTION_MARKER"), "test executed")
  end
end
RUBY
KANDELO_FORMULA_EXECUTION_MARKER="$MARKER" \
  ruby "$resolver" "$TAP_ROOT" kandelo-dev/tap-core inert \
    --declarations-json | jq -e '
      .dependencies == [
        {kind: "required", name: "external-required", same_tap: false}
      ]
    ' >/dev/null
if [ -e "$MARKER" ]; then
  echo "test-homebrew-formula-runtime-closure.sh: accepted Formula methods were executed" >&2
  exit 1
fi

mkdir -p "$TAP_ROOT/Kandelo/formula_support"
cat >"$TAP_ROOT/Kandelo/formula_support/kandelo_formula_support.rb" <<'RUBY'
require "fileutils"
require "json"
require "shellwords"
require "tempfile"

module KandeloFormulaSupport
  def kandelo_build_package(name, script, source_url, source_sha256, script_env: {})
    [name, script, source_url, source_sha256, script_env]
  end
end
RUBY

write_valid_bridge_formula() {
  cat >"$TAP_ROOT/Formula/bridge.rb" <<'RUBY'
require (Tap.fetch("kandelo-dev", "tap-core").path/"Kandelo/formula_support/kandelo_formula_support").to_s

class Bridge < Formula
  include KandeloFormulaSupport

  desc "Tier-2 bridge fixture"
  homepage "https://example.test/bridge"
  url "https://example.test/bridge-1.2.3.tar.gz"
  version "1.2.3"
  sha256 "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  license "MIT"

  def install
    source_dir = kandelo_stage_verified_formula_source
    ["fixture"].map(&:to_s)
    out_dir = kandelo_build_package(
      "registry-name", "build-registry-name.sh", stable.url, stable.checksum.hexdigest,
      script_env: {
        "WASM_POSIX_DEP_SOURCE_DIR" => source_dir,
        "WASM_POSIX_DEP_ZLIB_DIR" => formula_opt_prefix("kandelo-dev/tap-core/zlib"),
      }
    )
    kandelo_install_bin(out_dir, "bridge.wasm", "bridge")
  end
end
RUBY
}

expect_bridge_failure() {
  local label="$1" expected="$2"
  if ruby "$resolver" "$TAP_ROOT" kandelo-dev/tap-core bridge \
    --tier2-bridge-json >"$TMP_ROOT/$label.out" 2>"$TMP_ROOT/$label.err"; then
    echo "test-homebrew-formula-runtime-closure.sh: accepted invalid Tier-2 bridge: $label" >&2
    exit 1
  fi
  grep -F "$expected" "$TMP_ROOT/$label.err" >/dev/null || {
    cat "$TMP_ROOT/$label.err" >&2
    echo "test-homebrew-formula-runtime-closure.sh: wrong Tier-2 rejection: $label" >&2
    exit 1
  }
}

write_valid_bridge_formula
bridge_plan="$(ruby "$resolver" "$TAP_ROOT" kandelo-dev/tap-core bridge --tier2-bridge-json)"
jq -e '
  keys == ["formula", "formula_sha256", "full_name", "schema", "support_sha256", "tap", "tier2_bridge"] and
  .schema == 1 and
  .tap == "kandelo-dev/tap-core" and
  .formula == "bridge" and
  .full_name == "kandelo-dev/tap-core/bridge" and
  (.formula_sha256 | test("^[0-9a-f]{64}$")) and
  (.support_sha256 | test("^[0-9a-f]{64}$")) and
  .tier2_bridge == {
    package: "registry-name",
    script: "build-registry-name.sh",
    source_sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    source_url: "https://example.test/bridge-1.2.3.tar.gz",
    version: "1.2.3"
  }
' <<<"$bridge_plan" >/dev/null
[ "$bridge_plan" = "$(ruby "$resolver" "$TAP_ROOT" kandelo-dev/tap-core bridge --tier2-bridge-json)" ]

write_valid_bridge_formula
sed -i.bak \
  's/stable.url, stable.checksum.hexdigest/"https:\/\/example.test\/bridge-1.2.3.tar.gz", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"/' \
  "$TAP_ROOT/Formula/bridge.rb"
rm "$TAP_ROOT/Formula/bridge.rb.bak"
literal_bridge_plan="$(ruby "$resolver" "$TAP_ROOT" kandelo-dev/tap-core bridge --tier2-bridge-json)"
[ "$(jq -c '.tier2_bridge' <<<"$literal_bridge_plan")" = "$(jq -c '.tier2_bridge' <<<"$bridge_plan")" ]

idiomatic_plan="$(ruby "$resolver" "$TAP_ROOT" kandelo-dev/tap-core required --tier2-bridge-json)"
jq -e '.tier2_bridge == null and .support_sha256 == null and
  (.formula_sha256 | test("^[0-9a-f]{64}$"))' <<<"$idiomatic_plan" >/dev/null

write_valid_bridge_formula
sed -i.bak '/  version "1.2.3"/d' "$TAP_ROOT/Formula/bridge.rb"
rm "$TAP_ROOT/Formula/bridge.rb.bak"
expect_bridge_failure missing-version 'Tier-2 Formula must declare one canonical literal class version'

write_valid_bridge_formula
sed -i.bak '/  version "1.2.3"/a\
  version "1.2.3"' "$TAP_ROOT/Formula/bridge.rb"
rm "$TAP_ROOT/Formula/bridge.rb.bak"
expect_bridge_failure duplicate-version 'Tier-2 Formula must declare one canonical literal class version'

write_valid_bridge_formula
sed -i.bak 's/    out_dir = kandelo_build_package(/    out_dir = true \&\& kandelo_build_package(/' \
  "$TAP_ROOT/Formula/bridge.rb"
rm "$TAP_ROOT/Formula/bridge.rb.bak"
expect_bridge_failure nested-call 'must be the direct right-hand side of an install assignment'

write_valid_bridge_formula
sed -i.bak 's/"registry-name", "build-registry-name.sh"/"registry-name", script_name/' \
  "$TAP_ROOT/Formula/bridge.rb"
rm "$TAP_ROOT/Formula/bridge.rb.bak"
expect_bridge_failure dynamic-script 'script must be one canonical literal component'

write_valid_bridge_formula
sed -i.bak 's/"registry-name", "build-registry-name.sh"/"", "build-registry-name.sh"/' \
  "$TAP_ROOT/Formula/bridge.rb"
rm "$TAP_ROOT/Formula/bridge.rb.bak"
expect_bridge_failure empty-package 'package must be one canonical literal component'

write_valid_bridge_formula
sed -i.bak 's/"WASM_POSIX_DEP_SOURCE_DIR"/"WASM_POSIX_DEP_VERSION"/' \
  "$TAP_ROOT/Formula/bridge.rb"
rm "$TAP_ROOT/Formula/bridge.rb.bak"
expect_bridge_failure reserved-env 'script_env overrides reserved variables ["WASM_POSIX_DEP_VERSION"]'

write_valid_bridge_formula
sed -i.bak 's/WASM_POSIX_DEP_SOURCE_DIR/WASM_POSIX_DEP_NA\\x4dE/' \
  "$TAP_ROOT/Formula/bridge.rb"
rm "$TAP_ROOT/Formula/bridge.rb.bak"
expect_bridge_failure escaped-env 'script_env must be one literal hash with unique literal keys'

write_valid_bridge_formula
sed -i.bak 's/stable.url, stable.checksum.hexdigest/source_url, stable.checksum.hexdigest/' \
  "$TAP_ROOT/Formula/bridge.rb"
rm "$TAP_ROOT/Formula/bridge.rb.bak"
expect_bridge_failure dynamic-source-url 'source URL must use stable.url or the exact Formula URL literal'

write_valid_bridge_formula
sed -i.bak 's/stable.url, stable.checksum.hexdigest/stable.url, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"/' \
  "$TAP_ROOT/Formula/bridge.rb"
rm "$TAP_ROOT/Formula/bridge.rb.bak"
expect_bridge_failure wrong-source-sha 'source SHA-256 must use stable.checksum.hexdigest or the exact Formula SHA literal'

write_valid_bridge_formula
sed -i.bak 's#bridge-1.2.3.tar.gz#bridge-\\x31.2.3.tar.gz#' "$TAP_ROOT/Formula/bridge.rb"
rm "$TAP_ROOT/Formula/bridge.rb.bak"
expect_bridge_failure escaped-source-url 'Tier-2 Formula must declare one canonical literal class source URL'

write_valid_bridge_formula
sed -i.bak '/  include KandeloFormulaSupport/a\
  include KandeloFormulaSupport' "$TAP_ROOT/Formula/bridge.rb"
rm "$TAP_ROOT/Formula/bridge.rb.bak"
expect_bridge_failure duplicate-support-include 'Formula repeats KandeloFormulaSupport include'

write_valid_bridge_formula
sed -i.bak '/^end$/i\
  private\
\
  def helper\
    true\
  end\
' "$TAP_ROOT/Formula/bridge.rb"
rm "$TAP_ROOT/Formula/bridge.rb.bak"
expect_bridge_failure private-helper 'Tier-2 Formula may not define private helper methods ["helper"]'

write_valid_bridge_formula
sed -i.bak '/^end$/i\
  private\
\
  def stable\
    raise "shadowed"\
  end\
' "$TAP_ROOT/Formula/bridge.rb"
rm "$TAP_ROOT/Formula/bridge.rb.bak"
expect_bridge_failure stable-shadow 'Tier-2 Formula may not define private helper methods ["stable"]'

write_valid_bridge_formula
sed -i.bak '/^end$/i\
  private\
\
  def kandelo_build_package(*args)\
    args\
  end\
' "$TAP_ROOT/Formula/bridge.rb"
rm "$TAP_ROOT/Formula/bridge.rb.bak"
expect_bridge_failure helper-shadow 'unsupported or duplicate instance method "kandelo_build_package"'

cp "$TAP_ROOT/Kandelo/formula_support/kandelo_formula_support.rb" "$TMP_ROOT/valid-support.rb"
sed -i.bak 's/script_env: {}/**script_env/' \
  "$TAP_ROOT/Kandelo/formula_support/kandelo_formula_support.rb"
rm "$TAP_ROOT/Kandelo/formula_support/kandelo_formula_support.rb.bak"
write_valid_bridge_formula
expect_bridge_failure support-signature 'kandelo_build_package has a noncanonical signature'
cp "$TMP_ROOT/valid-support.rb" "$TAP_ROOT/Kandelo/formula_support/kandelo_formula_support.rb"

write_valid_bridge_formula
sed -i.bak 's/    out_dir = kandelo_build_package(/    first = kandelo_build_package("registry-name", "build-registry-name.sh", stable.url, stable.checksum.hexdigest)\
    out_dir = kandelo_build_package(/' "$TAP_ROOT/Formula/bridge.rb"
rm "$TAP_ROOT/Formula/bridge.rb.bak"
expect_bridge_failure multiple-calls 'Formula has multiple kandelo_build_package calls'

write_valid_bridge_formula
sed -i.bak '/    source_dir = kandelo_stage_verified_formula_source/a\
    singleton_class.instance_exec do\
      alias_method(("kandelo_" + "build_package").to_sym, :system)\
    end' "$TAP_ROOT/Formula/bridge.rb"
rm "$TAP_ROOT/Formula/bridge.rb.bak"
expect_bridge_failure replaced-dispatch 'forbidden tap-local source operation "singleton_class"'

cat >"$TAP_ROOT/Formula/indirect.rb" <<'RUBY'
require (Tap.fetch("kandelo-dev", "tap-core").path/"Kandelo/formula_support/kandelo_formula_support").to_s

class Indirect < Formula
  include KandeloFormulaSupport

  desc "Indirect bridge fixture"
  homepage "https://example.test/indirect"
  url "https://example.test/indirect-1.0.0.tar.gz"
  version "1.0.0"
  sha256 "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
  license "MIT"

  def install
    KandeloFormulaSupport.instance_method(("kandelo_" + "build_package").to_sym).bind_call(
      self, "wrong", "wrong.sh", stable.url, stable.checksum.hexdigest
    )
  end
end
RUBY
if ruby "$resolver" "$TAP_ROOT" kandelo-dev/tap-core indirect \
  --tier2-bridge-json >"$TMP_ROOT/indirect.out" 2>"$TMP_ROOT/indirect.err"; then
  echo "test-homebrew-formula-runtime-closure.sh: emitted a null plan for indirect bridge dispatch" >&2
  exit 1
fi
grep -F 'forbidden tap-local source operation "instance_method"' \
  "$TMP_ROOT/indirect.err" >/dev/null

cat >"$TAP_ROOT/Formula/symbol-dispatch.rb" <<'RUBY'
class SymbolDispatch < Formula
  def install
    ("kandelo_" + "build_package").to_sym.to_proc.call(
      self, "wrong", "wrong.sh", stable.url, stable.checksum.hexdigest
    )
  end
end
RUBY
if ruby "$resolver" "$TAP_ROOT" kandelo-dev/tap-core symbol-dispatch \
  --tier2-bridge-json >"$TMP_ROOT/symbol-dispatch.out" 2>"$TMP_ROOT/symbol-dispatch.err"; then
  echo "test-homebrew-formula-runtime-closure.sh: emitted a null plan for Symbol proc dispatch" >&2
  exit 1
fi
grep -F 'forbidden tap-local source operation "to_sym"' \
  "$TMP_ROOT/symbol-dispatch.err" >/dev/null

cat >"$TAP_ROOT/Formula/symbol-block-dispatch.rb" <<'RUBY'
class SymbolBlockDispatch < Formula
  def install
    Enumerator.new do |yielder|
      yielder.yield(self, "wrong", "wrong.sh", stable.url, stable.checksum.hexdigest)
    end.each(&:"kandelo_#{"build_package"}")
  end
end
RUBY
if ruby "$resolver" "$TAP_ROOT" kandelo-dev/tap-core symbol-block-dispatch \
  --tier2-bridge-json >"$TMP_ROOT/symbol-block-dispatch.out" \
  2>"$TMP_ROOT/symbol-block-dispatch.err"; then
  echo "test-homebrew-formula-runtime-closure.sh: emitted a null plan for dynamic Symbol block dispatch" >&2
  exit 1
fi
grep -F 'Formula class block pass must be one canonical static symbol' \
  "$TMP_ROOT/symbol-block-dispatch.err" >/dev/null

cat >"$TAP_ROOT/Formula/escaped-symbol-dispatch.rb" <<'RUBY'
class EscapedSymbolDispatch < Formula
  def install
    :"kandelo_\x62uild_package".to_proc.call(
      self, "wrong", "wrong.sh", stable.url, stable.checksum.hexdigest
    )
  end
end
RUBY
if ruby "$resolver" "$TAP_ROOT" kandelo-dev/tap-core escaped-symbol-dispatch \
  --tier2-bridge-json >"$TMP_ROOT/escaped-symbol-dispatch.out" \
  2>"$TMP_ROOT/escaped-symbol-dispatch.err"; then
  echo "test-homebrew-formula-runtime-closure.sh: emitted a null plan for escaped Symbol dispatch" >&2
  exit 1
fi
grep -F 'forbidden tap-local source operation "to_proc"' \
  "$TMP_ROOT/escaped-symbol-dispatch.err" >/dev/null

echo "test-homebrew-formula-runtime-closure.sh: passed"
