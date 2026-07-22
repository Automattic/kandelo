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
require "digest"
require "fileutils"
require "json"
require "pathname"
require "shellwords"
require "tempfile"

if defined?(KandeloFormulaSupport)
  unless KandeloFormulaSupport::KANDELO_FORMULA_SUPPORT_API_VERSION == 1 &&
         Digest::SHA256.file(Pathname(__FILE__).realpath).hexdigest ==
           KandeloFormulaSupport::KANDELO_TIER2_RUNTIME.fetch("support_sha256")
    raise "loaded Kandelo Formula support copies are incompatible"
  end
else
module KandeloFormulaSupport
  KANDELO_FORMULA_SUPPORT_API_VERSION = 1

  def self.kandelo_load_tier2_runtime!
    support_path = Pathname(__FILE__).realpath
    support_path.freeze
  end

  KANDELO_TIER2_RUNTIME = kandelo_load_tier2_runtime!

  def kandelo_build_package(package: nil, script_env: {})
    [package, script_env]
  end
end
end
RUBY

write_valid_bridge_formula() {
  cat >"$TAP_ROOT/Formula/bridge.rb" <<'RUBY'
require (Tap.fetch("kandelo-dev", "tap-core").path/"Kandelo/formula_support/kandelo_formula_support").to_s

class Bridge < Formula
  include KandeloFormulaSupport

  KANDELO_REGISTRY_BRIDGE = true

  desc "Tier-2 bridge fixture"
  homepage "https://example.test/bridge"
  url "https://example.test/bridge-1.2.3.tar.gz"
  version "1.2.3"
  sha256 "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  license "MIT"

  def install
    ["fixture"].map(&:to_s)
    out_dir = kandelo_build_package(
      script_env: {
        "WASM_POSIX_DEP_ZLIB_DIR" => formula_opt_prefix("kandelo-dev/tap-core/zlib"),
      }
    )
    kandelo_install_bin(out_dir, "bridge.wasm", "bridge")
  end
end
RUBY
}

write_mapped_bridge_formula() {
  write_valid_bridge_formula
  ruby - "$TAP_ROOT/Formula/bridge.rb" <<'RUBY'
path = ARGV.fetch(0)
source = File.binread(path)
needle = "    out_dir = kandelo_build_package(\n      script_env: {\n"
replacement = "    out_dir = kandelo_build_package(\n      package: \"cpython\",\n      script_env: {\n"
abort "missing canonical bridge call" unless source.sub!(needle, replacement)
File.binwrite(path, source)
RUBY
}

write_bridge_formula_with_env_shape() {
  local shape="$1"
  write_valid_bridge_formula
  ruby - "$TAP_ROOT/Formula/bridge.rb" "$shape" <<'RUBY'
path, shape = ARGV
keys = (0...64).map do |index|
  prefix = format("BRIDGE_%02d_", index)
  prefix + ("A" * (64 - prefix.bytesize))
end
case shape
when "exact"
  # 64 keys and 4096 aggregate key bytes: both limits exactly.
when "count-over"
  keys << "BRIDGE_64"
when "bytes-over"
  keys[-1] += "A"
else
  abort "unknown env shape #{shape.inspect}"
end
source = File.binread(path)
replacement = keys.map { |key| "        #{key.inspect} => \"fixture\",\n" }.join
pattern = /^        "WASM_POSIX_DEP_ZLIB_DIR".*\n/
abort "could not replace the script_env fixture" unless source.scan(pattern).length == 1
source.sub!(pattern, replacement)
File.binwrite(path, source)
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

expect_support_runtime_failure() {
  local label="$1" expected="$2"
  if ruby "$resolver" "$TAP_ROOT" kandelo-dev/tap-core support-only \
    --tier2-bridge-json >"$TMP_ROOT/$label.out" 2>"$TMP_ROOT/$label.err"; then
    echo "test-homebrew-formula-runtime-closure.sh: accepted invalid support runtime: $label" >&2
    exit 1
  fi
  grep -F "$expected" "$TMP_ROOT/$label.err" >/dev/null || {
    cat "$TMP_ROOT/$label.err" >&2
    echo "test-homebrew-formula-runtime-closure.sh: wrong support-runtime rejection: $label" >&2
    exit 1
  }
}

write_valid_bridge_formula
printf 'omega\n' >"$TAP_ROOT/Kandelo/formula_support/z-runtime.txt"
printf 'alpha\n' >"$TAP_ROOT/Kandelo/formula_support/a-runtime.txt"
bridge_plan="$(ruby "$resolver" "$TAP_ROOT" kandelo-dev/tap-core bridge --tier2-bridge-json)"
jq -e '
  keys == ["formula", "formula_sha256", "full_name", "schema", "support_runtime_sha256", "support_sha256", "tap", "tier2_bridge"] and
  .schema == 2 and
  .tap == "kandelo-dev/tap-core" and
  .formula == "bridge" and
  .full_name == "kandelo-dev/tap-core/bridge" and
  (.formula_sha256 | test("^[0-9a-f]{64}$")) and
  (.support_sha256 | test("^[0-9a-f]{64}$")) and
  (.support_runtime_sha256 | test("^[0-9a-f]{64}$")) and
  .tier2_bridge == {
    package: "bridge",
    script_env_keys: ["WASM_POSIX_DEP_ZLIB_DIR"],
    source_sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    source_url: "https://example.test/bridge-1.2.3.tar.gz",
    version: "1.2.3"
  }
' <<<"$bridge_plan" >/dev/null
[ "$(jq -r '.support_runtime_sha256' <<<"$bridge_plan")" = \
  "f4268a4e34b7fc2fc3ec46466e656eb6b917bd451d77cbfffdafe2a08e8924a4" ]
[ "$bridge_plan" = "$(ruby "$resolver" "$TAP_ROOT" kandelo-dev/tap-core bridge --tier2-bridge-json)" ]
rm "$TAP_ROOT/Kandelo/formula_support/a-runtime.txt" \
  "$TAP_ROOT/Kandelo/formula_support/z-runtime.txt"

write_mapped_bridge_formula
mapped_bridge_plan="$(ruby "$resolver" "$TAP_ROOT" kandelo-dev/tap-core bridge --tier2-bridge-json)"
jq -e '
  .formula == "bridge" and
  .full_name == "kandelo-dev/tap-core/bridge" and
  .tier2_bridge.package == "cpython" and
  .tier2_bridge.script_env_keys == ["WASM_POSIX_DEP_ZLIB_DIR"]
' <<<"$mapped_bridge_plan" >/dev/null

write_mapped_bridge_formula
ruby - "$TAP_ROOT/Formula/bridge.rb" <<'RUBY'
path = ARGV.fetch(0)
source = File.binread(path)
abort "missing script_env close" unless source.sub!("      }\n    )\n", "      },\n    )\n")
File.binwrite(path, source)
RUBY
trailing_comma_plan="$(ruby "$resolver" "$TAP_ROOT" kandelo-dev/tap-core bridge --tier2-bridge-json)"
[ "$(jq -c '.tier2_bridge' <<<"$trailing_comma_plan")" = \
  "$(jq -c '.tier2_bridge' <<<"$mapped_bridge_plan")" ]

write_mapped_bridge_formula
sed -i.bak 's/WASM_POSIX_DEP_ZLIB_DIR/CPYTHON_CONFIGURE/' "$TAP_ROOT/Formula/bridge.rb"
rm "$TAP_ROOT/Formula/bridge.rb.bak"
mapped_namespace_plan="$(ruby "$resolver" "$TAP_ROOT" kandelo-dev/tap-core bridge --tier2-bridge-json)"
jq -e '.tier2_bridge.package == "cpython" and
  .tier2_bridge.script_env_keys == ["CPYTHON_CONFIGURE"]' \
  <<<"$mapped_namespace_plan" >/dev/null

write_mapped_bridge_formula
sed -i.bak 's/WASM_POSIX_DEP_ZLIB_DIR/BRIDGE_CONFIGURE/' "$TAP_ROOT/Formula/bridge.rb"
rm "$TAP_ROOT/Formula/bridge.rb.bak"
expect_bridge_failure formula-env-for-mapped-package \
  'script_env uses keys outside the approved namespace ["BRIDGE_CONFIGURE"]'

idiomatic_plan="$(ruby "$resolver" "$TAP_ROOT" kandelo-dev/tap-core required --tier2-bridge-json)"
jq -e '.tier2_bridge == null and .support_sha256 == null and
  .support_runtime_sha256 == null and
  (.formula_sha256 | test("^[0-9a-f]{64}$"))' <<<"$idiomatic_plan" >/dev/null

cat >"$TAP_ROOT/Formula/support-only.rb" <<'RUBY'
require (Tap.fetch("kandelo-dev", "tap-core").path/"Kandelo/formula_support/kandelo_formula_support").to_s

class SupportOnly < Formula
  include KandeloFormulaSupport

  desc "Idiomatic Formula that shares inert support"
  homepage "https://example.test/support-only"
  url "https://example.test/support-only-1.0.tar.gz"
  sha256 "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  license "MIT"
end
RUBY
support_only_plan="$(ruby "$resolver" "$TAP_ROOT" kandelo-dev/tap-core support-only --tier2-bridge-json)"
jq -e '.tier2_bridge == null and
  (.support_sha256 | test("^[0-9a-f]{64}$")) and
  (.support_runtime_sha256 | test("^[0-9a-f]{64}$")) and
  (.formula_sha256 | test("^[0-9a-f]{64}$"))' \
  <<<"$support_only_plan" >/dev/null

support_runtime_dir="$TAP_ROOT/Kandelo/formula_support"
mkdir "$support_runtime_dir/test"
printf 'tap-local test bytes\n' >"$support_runtime_dir/test/fixture.txt"
ln -s ../kandelo_formula_support.rb "$support_runtime_dir/test/ignored-link.rb"
test_excluded_plan="$(ruby "$resolver" "$TAP_ROOT" kandelo-dev/tap-core support-only --tier2-bridge-json)"
[ "$(jq -r '.support_runtime_sha256' <<<"$test_excluded_plan")" = \
  "$(jq -r '.support_runtime_sha256' <<<"$support_only_plan")" ]
rm "$support_runtime_dir/test/ignored-link.rb" "$support_runtime_dir/test/fixture.txt"
rmdir "$support_runtime_dir/test"

ln -s kandelo_formula_support.rb "$support_runtime_dir/runtime-link.rb"
expect_support_runtime_failure runtime-symlink \
  'support runtime entry must be a canonical regular file'
rm "$support_runtime_dir/runtime-link.rb"

mkdir "$support_runtime_dir/nested-runtime"
expect_support_runtime_failure runtime-directory \
  'support runtime entry must be a canonical regular file'
rmdir "$support_runtime_dir/nested-runtime"

ln -s . "$support_runtime_dir/test"
expect_support_runtime_failure test-symlink \
  'support test path must be a real directory'
rm "$support_runtime_dir/test"

printf 'invalid name\n' >"$support_runtime_dir/runtime helper.txt"
expect_support_runtime_failure runtime-name \
  'support runtime entry must be a canonical regular file'
rm "$support_runtime_dir/runtime helper.txt"

for ((index = 1; index <= 127; index++)); do
  touch "$support_runtime_dir/$(printf 'count-%03d.txt' "$index")"
done
count_boundary_plan="$(ruby "$resolver" "$TAP_ROOT" kandelo-dev/tap-core support-only --tier2-bridge-json)"
jq -e '(.support_runtime_sha256 | test("^[0-9a-f]{64}$"))' \
  <<<"$count_boundary_plan" >/dev/null
touch "$support_runtime_dir/count-128.txt"
expect_support_runtime_failure runtime-file-count \
  'support runtime exceeds 128 files'
for ((index = 1; index <= 128; index++)); do
  rm "$support_runtime_dir/$(printf 'count-%03d.txt' "$index")"
done

ruby - "$support_runtime_dir/exact-file.bin" 1048576 <<'RUBY'
path, size = ARGV
File.open(path, "wb") { |file| file.truncate(Integer(size, 10)) }
RUBY
file_size_boundary_plan="$(ruby "$resolver" "$TAP_ROOT" kandelo-dev/tap-core support-only --tier2-bridge-json)"
jq -e '(.support_runtime_sha256 | test("^[0-9a-f]{64}$"))' \
  <<<"$file_size_boundary_plan" >/dev/null
ruby - "$support_runtime_dir/exact-file.bin" 1048577 <<'RUBY'
path, size = ARGV
File.open(path, "wb") { |file| file.truncate(Integer(size, 10)) }
RUBY
expect_support_runtime_failure runtime-file-bytes \
  'support runtime exceeds the byte limit'
rm "$support_runtime_dir/exact-file.bin"

ruby - "$support_runtime_dir" <<'RUBY'
support_dir = ARGV.fetch(0)
15.times do |index|
  File.open(File.join(support_dir, format("aggregate-%02d.bin", index)), "wb") do |file|
    file.truncate(1_048_576)
  end
end
support_bytes = File.size(File.join(support_dir, "kandelo_formula_support.rb"))
File.open(File.join(support_dir, "aggregate-15.bin"), "wb") do |file|
  file.truncate(1_048_576 - support_bytes)
end
RUBY
aggregate_boundary_plan="$(ruby "$resolver" "$TAP_ROOT" kandelo-dev/tap-core support-only --tier2-bridge-json)"
jq -e '(.support_runtime_sha256 | test("^[0-9a-f]{64}$"))' \
  <<<"$aggregate_boundary_plan" >/dev/null
printf x >"$support_runtime_dir/aggregate-over.bin"
expect_support_runtime_failure runtime-aggregate-bytes \
  'support runtime exceeds the byte limit'
rm "$support_runtime_dir/aggregate-over.bin"
for ((index = 0; index <= 15; index++)); do
  rm "$support_runtime_dir/$(printf 'aggregate-%02d.bin' "$index")"
done

mkdir -p "$DEPENDENCY_TAP_ROOT/Kandelo/formula_support"
cp "$TAP_ROOT/Kandelo/formula_support/kandelo_formula_support.rb" \
  "$DEPENDENCY_TAP_ROOT/Kandelo/formula_support/kandelo_formula_support.rb"
printf 'export const reviewed = true;\n' \
  >"$TAP_ROOT/Kandelo/formula_support/run-browser-wasm.ts"
cp "$TAP_ROOT/Kandelo/formula_support/run-browser-wasm.ts" \
  "$DEPENDENCY_TAP_ROOT/Kandelo/formula_support/run-browser-wasm.ts"
mkdir -p "$TAP_ROOT/Kandelo/formula_support/test" \
  "$DEPENDENCY_TAP_ROOT/Kandelo/formula_support/test"
printf 'primary tap-local test\n' \
  >"$TAP_ROOT/Kandelo/formula_support/test/tap-local.txt"
printf 'dependency tap-local test\n' \
  >"$DEPENDENCY_TAP_ROOT/Kandelo/formula_support/test/tap-local.txt"
cat >"$TAP_ROOT/Formula/m4.rb" <<'RUBY'
require (Tap.fetch("acme", "tools").path/"Kandelo/formula_support/kandelo_formula_support").to_s

class M4 < Formula
  include KandeloFormulaSupport

  depends_on "kandelo-dev/tap-core/dash"
end
RUBY
cat >"$DEPENDENCY_TAP_ROOT/Formula/dash.rb" <<'RUBY'
require (Tap.fetch("kandelo-dev", "tap-core").path/"Kandelo/formula_support/kandelo_formula_support").to_s

class Dash < Formula
  include KandeloFormulaSupport

  bottle do
    root_url "https://ghcr.io/v2/kandelo-dev/homebrew-tap-core"
    sha256 cellar: :any, wasm32_kandelo: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
  end
end
RUBY
identical_support_direct="$(
  KANDELO_HOMEBREW_RESOLVED_TAPS_FILE="$RESOLVED_TAPS" \
    ruby "$resolver" "$TAP_ROOT" acme/tools m4 --direct
)"
[ "$identical_support_direct" = "kandelo-dev/tap-core/dash" ]
printf 'export const dependencyDrift = true;\n' \
  >>"$DEPENDENCY_TAP_ROOT/Kandelo/formula_support/run-browser-wasm.ts"
if KANDELO_HOMEBREW_RESOLVED_TAPS_FILE="$RESOLVED_TAPS" \
  ruby "$resolver" "$TAP_ROOT" acme/tools m4 --direct \
    >"$TMP_ROOT/cross-support-runtime-drift.out" \
    2>"$TMP_ROOT/cross-support-runtime-drift.err"; then
  echo "test-homebrew-formula-runtime-closure.sh: accepted divergent cross-tap support runtime" >&2
  exit 1
fi
grep -F 'Kandelo Formula support API or runtime-tree bytes differ across the immutable tap closure' \
  "$TMP_ROOT/cross-support-runtime-drift.err" >/dev/null
cp "$TAP_ROOT/Kandelo/formula_support/run-browser-wasm.ts" \
  "$DEPENDENCY_TAP_ROOT/Kandelo/formula_support/run-browser-wasm.ts"
printf '# incompatible support copy\n' \
  >>"$DEPENDENCY_TAP_ROOT/Kandelo/formula_support/kandelo_formula_support.rb"
if KANDELO_HOMEBREW_RESOLVED_TAPS_FILE="$RESOLVED_TAPS" \
  ruby "$resolver" "$TAP_ROOT" acme/tools m4 --direct \
    >"$TMP_ROOT/cross-support-drift.out" 2>"$TMP_ROOT/cross-support-drift.err"; then
  echo "test-homebrew-formula-runtime-closure.sh: accepted divergent cross-tap support" >&2
  exit 1
fi
grep -F 'Kandelo Formula support API or runtime-tree bytes differ across the immutable tap closure' \
  "$TMP_ROOT/cross-support-drift.err" >/dev/null
cp "$TAP_ROOT/Kandelo/formula_support/kandelo_formula_support.rb" \
  "$DEPENDENCY_TAP_ROOT/Kandelo/formula_support/kandelo_formula_support.rb"

cp "$TAP_ROOT/Kandelo/formula_support/kandelo_formula_support.rb" "$TMP_ROOT/package-keyword-support.rb"
sed -i.bak 's/package: nil, script_env: {}/script_env: {}/' \
  "$TAP_ROOT/Kandelo/formula_support/kandelo_formula_support.rb"
rm "$TAP_ROOT/Kandelo/formula_support/kandelo_formula_support.rb.bak"
write_valid_bridge_formula
legacy_same_name_plan="$(ruby "$resolver" "$TAP_ROOT" kandelo-dev/tap-core bridge --tier2-bridge-json)"
jq -e '.formula == "bridge" and .tier2_bridge.package == "bridge"' \
  <<<"$legacy_same_name_plan" >/dev/null
write_mapped_bridge_formula
expect_bridge_failure legacy-support-package-mapping \
  'Formula bridge package mapping requires canonical package: support'
cp "$TMP_ROOT/package-keyword-support.rb" \
  "$TAP_ROOT/Kandelo/formula_support/kandelo_formula_support.rb"

cp "$TAP_ROOT/Kandelo/formula_support/kandelo_formula_support.rb" "$TMP_ROOT/runtime-support.rb"
ruby - "$TAP_ROOT/Kandelo/formula_support/kandelo_formula_support.rb" <<'RUBY'
path = ARGV.fetch(0)
source = File.binread(path)
initializer = "  def self.kandelo_load_tier2_runtime!\n" \
              "    support_path = Pathname(__FILE__).realpath\n" \
              "    support_path.freeze\n" \
              "  end\n\n" \
              "  KANDELO_TIER2_RUNTIME = kandelo_load_tier2_runtime!\n\n"
source.sub!(initializer, "") or abort "missing runtime initializer pair"
File.binwrite(path, source)
RUBY
if ruby "$resolver" "$TAP_ROOT" kandelo-dev/tap-core support-only \
  --tier2-bridge-json >"$TMP_ROOT/support-without-runtime.out" \
  2>"$TMP_ROOT/support-without-runtime.err"; then
  echo "test-homebrew-formula-runtime-closure.sh: accepted API-v1 support without runtime authority" >&2
  exit 1
fi
grep -F 'must initialize Tier-2 runtime authority exactly once' \
  "$TMP_ROOT/support-without-runtime.err" >/dev/null
cp "$TMP_ROOT/runtime-support.rb" "$TAP_ROOT/Kandelo/formula_support/kandelo_formula_support.rb"

write_bridge_formula_with_env_shape exact
exact_env_plan="$(ruby "$resolver" "$TAP_ROOT" kandelo-dev/tap-core bridge --tier2-bridge-json)"
jq -e '(.tier2_bridge.script_env_keys | length) == 64 and
  ([.tier2_bridge.script_env_keys[] | length] | add) == 4096' \
  <<<"$exact_env_plan" >/dev/null

write_bridge_formula_with_env_shape count-over
expect_bridge_failure env-count-over 'script_env exceeds the static key limit'

write_bridge_formula_with_env_shape bytes-over
expect_bridge_failure env-bytes-over 'script_env exceeds the static key limit'

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
sed -i.bak '/  KANDELO_REGISTRY_BRIDGE = true/d' "$TAP_ROOT/Formula/bridge.rb"
rm "$TAP_ROOT/Formula/bridge.rb.bak"
expect_bridge_failure missing-marker 'bridge marker and canonical helper call must appear together'

write_valid_bridge_formula
sed -i.bak 's/kandelo_build_package(/formula_opt_prefix(/' "$TAP_ROOT/Formula/bridge.rb"
rm "$TAP_ROOT/Formula/bridge.rb.bak"
expect_bridge_failure marker-without-call 'bridge marker and canonical helper call must appear together'

write_valid_bridge_formula
sed -i.bak 's/KANDELO_REGISTRY_BRIDGE = true/KANDELO_REGISTRY_BRIDGE = false/' \
  "$TAP_ROOT/Formula/bridge.rb"
rm "$TAP_ROOT/Formula/bridge.rb.bak"
expect_bridge_failure false-marker 'registry bridge marker must be one canonical true constant'

write_valid_bridge_formula
sed -i.bak '/  KANDELO_REGISTRY_BRIDGE = true/a\
  KANDELO_REGISTRY_BRIDGE = true' "$TAP_ROOT/Formula/bridge.rb"
rm "$TAP_ROOT/Formula/bridge.rb.bak"
expect_bridge_failure duplicate-marker 'registry bridge marker must be one canonical true constant'

write_valid_bridge_formula
sed -i.bak '/    out_dir = kandelo_build_package(/a\
      "wrong",' "$TAP_ROOT/Formula/bridge.rb"
rm "$TAP_ROOT/Formula/bridge.rb.bak"
expect_bridge_failure positional-identity 'must use one canonical keyword hash'

write_mapped_bridge_formula
sed -i.bak 's/package: "cpython"/package: PACKAGE_NAME/' "$TAP_ROOT/Formula/bridge.rb"
rm "$TAP_ROOT/Formula/bridge.rb.bak"
expect_bridge_failure dynamic-package \
  'must use an optional literal package followed by one literal script_env hash'

write_mapped_bridge_formula
sed -i.bak 's/package: "cpython"/package: "cpy\\x74hon"/' "$TAP_ROOT/Formula/bridge.rb"
rm "$TAP_ROOT/Formula/bridge.rb.bak"
expect_bridge_failure escaped-package \
  'must use an optional literal package followed by one literal script_env hash'

write_mapped_bridge_formula
sed -i.bak 's/package: "cpython"/package: "cpy#{\"thon\"}"/' "$TAP_ROOT/Formula/bridge.rb"
rm "$TAP_ROOT/Formula/bridge.rb.bak"
expect_bridge_failure interpolated-package \
  'must use an optional literal package followed by one literal script_env hash'

write_mapped_bridge_formula
sed -i.bak 's/package: "cpython"/package: "..\/cpython"/' "$TAP_ROOT/Formula/bridge.rb"
rm "$TAP_ROOT/Formula/bridge.rb.bak"
expect_bridge_failure invalid-package \
  'must use an optional literal package followed by one literal script_env hash'

write_mapped_bridge_formula
ruby - "$TAP_ROOT/Formula/bridge.rb" <<'RUBY'
path = ARGV.fetch(0)
source = File.binread(path)
abort "missing package mapping" unless source.sub!('package: "cpython"', "package: #{('p' * 255).inspect}")
File.binwrite(path, source)
RUBY
maximum_package_plan="$(ruby "$resolver" "$TAP_ROOT" kandelo-dev/tap-core bridge --tier2-bridge-json)"
[ "$(jq -r '.tier2_bridge.package | length' <<<"$maximum_package_plan")" = 255 ]

write_mapped_bridge_formula
ruby - "$TAP_ROOT/Formula/bridge.rb" <<'RUBY'
path = ARGV.fetch(0)
source = File.binread(path)
abort "missing package mapping" unless source.sub!('package: "cpython"', "package: #{('p' * 256).inspect}")
File.binwrite(path, source)
RUBY
expect_bridge_failure oversized-package \
  'must use an optional literal package followed by one literal script_env hash'

write_mapped_bridge_formula
ruby - "$TAP_ROOT/Formula/bridge.rb" <<'RUBY'
path = ARGV.fetch(0)
source = File.binread(path)
needle = "      package: \"cpython\",\n      script_env: {\n"
replacement = "      script_env: {\n"
abort "missing package mapping" unless source.sub!(needle, replacement)
source.sub!("      }\n    )\n", "      },\n      package: \"cpython\"\n    )\n") or abort "missing script_env close"
File.binwrite(path, source)
RUBY
expect_bridge_failure reversed-package-keyword \
  'must use an optional literal package followed by one literal script_env hash'

write_mapped_bridge_formula
sed -i.bak '/      package: "cpython",/a\
      package: "cpython",' "$TAP_ROOT/Formula/bridge.rb"
rm "$TAP_ROOT/Formula/bridge.rb.bak"
expect_bridge_failure duplicate-package-keyword \
  'must use an optional literal package followed by one literal script_env hash'

write_mapped_bridge_formula
ruby - "$TAP_ROOT/Formula/bridge.rb" <<'RUBY'
path = ARGV.fetch(0)
source = File.binread(path)
pattern = /      script_env: \{\n.*?      \}\n/m
abort "missing script_env mapping" unless source.sub!(pattern, "")
File.binwrite(path, source)
RUBY
expect_bridge_failure missing-script-env \
  'must use an optional literal package followed by one literal script_env hash'

write_valid_bridge_formula
sed -i.bak 's/"WASM_POSIX_DEP_ZLIB_DIR"/"WASM_POSIX_DEP_VERSION"/' \
  "$TAP_ROOT/Formula/bridge.rb"
rm "$TAP_ROOT/Formula/bridge.rb.bak"
expect_bridge_failure reserved-env 'script_env overrides reserved variables ["WASM_POSIX_DEP_VERSION"]'

write_valid_bridge_formula
sed -i.bak 's/"WASM_POSIX_DEP_ZLIB_DIR"/"WASM_POSIX_DEP_SOURCE_DIR"/' \
  "$TAP_ROOT/Formula/bridge.rb"
rm "$TAP_ROOT/Formula/bridge.rb.bak"
expect_bridge_failure reserved-source-dir 'script_env overrides reserved variables ["WASM_POSIX_DEP_SOURCE_DIR"]'

write_valid_bridge_formula
sed -i.bak 's/"WASM_POSIX_DEP_ZLIB_DIR"/"WASM_POSIX_INSTALL_LOCAL_MIRROR"/' \
  "$TAP_ROOT/Formula/bridge.rb"
rm "$TAP_ROOT/Formula/bridge.rb.bak"
expect_bridge_failure reserved-local-mirror 'script_env overrides reserved variables ["WASM_POSIX_INSTALL_LOCAL_MIRROR"]'

write_valid_bridge_formula
sed -i.bak 's/"WASM_POSIX_DEP_ZLIB_DIR"/"PATH"/' \
  "$TAP_ROOT/Formula/bridge.rb"
rm "$TAP_ROOT/Formula/bridge.rb.bak"
expect_bridge_failure shell-control-env 'script_env uses keys outside the approved namespace ["PATH"]'

write_valid_bridge_formula
sed -i.bak 's/WASM_POSIX_DEP_ZLIB_DIR/WASM_POSIX_DEP_NA\\x4dE/' \
  "$TAP_ROOT/Formula/bridge.rb"
rm "$TAP_ROOT/Formula/bridge.rb.bak"
expect_bridge_failure escaped-env \
  'must use an optional literal package followed by one literal script_env hash'

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
sed -i.bak 's/^else$/elsif true/' "$TAP_ROOT/Kandelo/formula_support/kandelo_formula_support.rb"
rm "$TAP_ROOT/Kandelo/formula_support/kandelo_formula_support.rb.bak"
write_valid_bridge_formula
expect_bridge_failure support-compatibility-guard \
  'must use the canonical idempotent compatibility guard'
cp "$TMP_ROOT/valid-support.rb" "$TAP_ROOT/Kandelo/formula_support/kandelo_formula_support.rb"

sed -i.bak \
  's/^  KANDELO_FORMULA_SUPPORT_API_VERSION = 1$/  KANDELO_FORMULA_SUPPORT_API_VERSION = 2/' \
  "$TAP_ROOT/Kandelo/formula_support/kandelo_formula_support.rb"
rm "$TAP_ROOT/Kandelo/formula_support/kandelo_formula_support.rb.bak"
write_valid_bridge_formula
expect_bridge_failure support-api-version 'must declare one canonical API version'
cp "$TMP_ROOT/valid-support.rb" "$TAP_ROOT/Kandelo/formula_support/kandelo_formula_support.rb"

sed -i.bak 's/package: nil, script_env: {}/package: nil, **script_env/' \
  "$TAP_ROOT/Kandelo/formula_support/kandelo_formula_support.rb"
rm "$TAP_ROOT/Kandelo/formula_support/kandelo_formula_support.rb.bak"
write_valid_bridge_formula
expect_bridge_failure support-signature 'kandelo_build_package has a noncanonical signature'
cp "$TMP_ROOT/valid-support.rb" "$TAP_ROOT/Kandelo/formula_support/kandelo_formula_support.rb"

sed -i.bak 's/package: nil, script_env: {}/script_env: {}, package: nil/' \
  "$TAP_ROOT/Kandelo/formula_support/kandelo_formula_support.rb"
rm "$TAP_ROOT/Kandelo/formula_support/kandelo_formula_support.rb.bak"
write_valid_bridge_formula
expect_bridge_failure reversed-support-signature \
  'kandelo_build_package has a noncanonical signature'
cp "$TMP_ROOT/valid-support.rb" "$TAP_ROOT/Kandelo/formula_support/kandelo_formula_support.rb"

sed -i.bak 's/package: nil, script_env: {}/package: "bridge", script_env: {}/' \
  "$TAP_ROOT/Kandelo/formula_support/kandelo_formula_support.rb"
rm "$TAP_ROOT/Kandelo/formula_support/kandelo_formula_support.rb.bak"
write_valid_bridge_formula
expect_bridge_failure nonnil-package-default \
  'kandelo_build_package has a noncanonical signature'
cp "$TMP_ROOT/valid-support.rb" "$TAP_ROOT/Kandelo/formula_support/kandelo_formula_support.rb"

sed -i.bak 's/package: nil, script_env: {}/package: nil/' \
  "$TAP_ROOT/Kandelo/formula_support/kandelo_formula_support.rb"
rm "$TAP_ROOT/Kandelo/formula_support/kandelo_formula_support.rb.bak"
write_valid_bridge_formula
expect_bridge_failure missing-script-env-support \
  'kandelo_build_package has a noncanonical signature'
cp "$TMP_ROOT/valid-support.rb" "$TAP_ROOT/Kandelo/formula_support/kandelo_formula_support.rb"

cp "$TMP_ROOT/valid-support.rb" "$TAP_ROOT/Kandelo/formula_support/kandelo_formula_support.rb"
ruby - "$TAP_ROOT/Kandelo/formula_support/kandelo_formula_support.rb" <<'RUBY'
path = ARGV.fetch(0)
source = File.binread(path)
needle = "  def kandelo_build_package(package: nil, script_env: {})\n"
replacement = "  def self.extra_runtime_initializer!\n" \
              "    true\n" \
              "  end\n\n" \
              "  def kandelo_build_package(package: nil, script_env: {})\n"
abort "missing support instance method" unless source.sub!(needle, replacement)
File.binwrite(path, source)
RUBY
write_valid_bridge_formula
expect_bridge_failure extra-singleton 'must use one canonical Tier-2 runtime initializer'

cp "$TMP_ROOT/valid-support.rb" "$TAP_ROOT/Kandelo/formula_support/kandelo_formula_support.rb"
sed -i.bak \
  's/KANDELO_TIER2_RUNTIME = kandelo_load_tier2_runtime!/KANDELO_TIER2_RUNTIME = kandelo_load_tier2_runtime!(true)/' \
  "$TAP_ROOT/Kandelo/formula_support/kandelo_formula_support.rb"
rm "$TAP_ROOT/Kandelo/formula_support/kandelo_formula_support.rb.bak"
write_valid_bridge_formula
expect_bridge_failure wrong-runtime-call 'must use one canonical Tier-2 runtime assignment'

cp "$TMP_ROOT/valid-support.rb" "$TAP_ROOT/Kandelo/formula_support/kandelo_formula_support.rb"
sed -i.bak '/  KANDELO_TIER2_RUNTIME = kandelo_load_tier2_runtime!/a\
  KANDELO_TIER2_RUNTIME = kandelo_load_tier2_runtime!' \
  "$TAP_ROOT/Kandelo/formula_support/kandelo_formula_support.rb"
rm "$TAP_ROOT/Kandelo/formula_support/kandelo_formula_support.rb.bak"
write_valid_bridge_formula
expect_bridge_failure duplicate-runtime-assignment 'must use one canonical Tier-2 runtime assignment'

cp "$TMP_ROOT/valid-support.rb" "$TAP_ROOT/Kandelo/formula_support/kandelo_formula_support.rb"
sed -i.bak '/    support_path = Pathname(__FILE__).realpath/a\
    File.binread(__FILE__)' "$TAP_ROOT/Kandelo/formula_support/kandelo_formula_support.rb"
rm "$TAP_ROOT/Kandelo/formula_support/kandelo_formula_support.rb.bak"
write_valid_bridge_formula
expect_bridge_failure extra-file-source 'runtime initializer uses forbidden local source operation "__FILE__"'

cp "$TMP_ROOT/valid-support.rb" "$TAP_ROOT/Kandelo/formula_support/kandelo_formula_support.rb"
ruby - "$TAP_ROOT/Kandelo/formula_support/kandelo_formula_support.rb" <<'RUBY'
path = ARGV.fetch(0)
source = File.binread(path)
initializer = "  def self.kandelo_load_tier2_runtime!\n" \
              "    support_path = Pathname(__FILE__).realpath\n" \
              "    support_path.freeze\n" \
              "  end\n\n"
abort "missing runtime initializer" unless source.sub!(initializer, "")
File.binwrite(path, source)
RUBY
write_valid_bridge_formula
expect_bridge_failure missing-runtime-loader 'must initialize Tier-2 runtime authority exactly once'

cp "$TMP_ROOT/valid-support.rb" "$TAP_ROOT/Kandelo/formula_support/kandelo_formula_support.rb"
sed -i.bak '/  KANDELO_TIER2_RUNTIME = kandelo_load_tier2_runtime!/d' \
  "$TAP_ROOT/Kandelo/formula_support/kandelo_formula_support.rb"
rm "$TAP_ROOT/Kandelo/formula_support/kandelo_formula_support.rb.bak"
write_valid_bridge_formula
expect_bridge_failure missing-runtime-assignment 'must initialize Tier-2 runtime authority exactly once'

cp "$TMP_ROOT/valid-support.rb" "$TAP_ROOT/Kandelo/formula_support/kandelo_formula_support.rb"
write_valid_bridge_formula
sed -i.bak '/  KANDELO_REGISTRY_BRIDGE = true/a\
  KANDELO_TIER2_RUNTIME = nil' "$TAP_ROOT/Formula/bridge.rb"
rm "$TAP_ROOT/Formula/bridge.rb.bak"
expect_bridge_failure formula-runtime-reassignment \
  'Formula uses forbidden dependency metaprogramming "KANDELO_TIER2_RUNTIME"'

cp "$TMP_ROOT/valid-support.rb" "$TAP_ROOT/Kandelo/formula_support/kandelo_formula_support.rb"

write_valid_bridge_formula
sed -i.bak 's/    out_dir = kandelo_build_package(/    first = kandelo_build_package(script_env: {})\
    out_dir = kandelo_build_package(/' "$TAP_ROOT/Formula/bridge.rb"
rm "$TAP_ROOT/Formula/bridge.rb.bak"
expect_bridge_failure multiple-calls 'Formula has multiple kandelo_build_package calls'

write_valid_bridge_formula
sed -i.bak '/    \["fixture"\].map/a\
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
