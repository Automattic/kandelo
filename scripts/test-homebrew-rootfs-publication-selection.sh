#!/usr/bin/env bash
# Focused Formula-authority tests for the rootfs-wasm32 bottle lane.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HELPER="$REPO_ROOT/scripts/homebrew-rootfs-publication-selection.sh"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT
TAP_ROOT="$TMP_ROOT/tap"
RESOLVED_TAPS="$TMP_ROOT/resolved-taps.json"
RUBY_BIN="$(command -v ruby)"

fail() {
  echo "test-homebrew-rootfs-publication-selection.sh: $*" >&2
  exit 1
}

expect_failure() {
  local label="$1" expected="$2"
  shift 2
  local err="$TMP_ROOT/${label}.err"
  if "$@" >"$TMP_ROOT/${label}.out" 2>"$err"; then
    fail "$label unexpectedly succeeded"
  fi
  grep -F -- "$expected" "$err" >/dev/null ||
    fail "$label did not explain its failure: $(cat "$err")"
}

write_formula_support() {
  mkdir -p "$TAP_ROOT/Kandelo/formula_support"
  cat >"$TAP_ROOT/Kandelo/formula_support/kandelo_formula_support.rb" <<'RUBY'
require "digest"
require "fileutils"
require "json"
require "pathname"
require "shellwords"
require "tempfile"
require "tmpdir"

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
    { "support_sha256" => Digest::SHA256.file(support_path).hexdigest }.freeze
  end

  KANDELO_TIER2_RUNTIME = kandelo_load_tier2_runtime!

  def kandelo_build_package(package: nil, script_env: {})
    [package, script_env]
  end

  def kandelo_build_tap_recipe(manifest_sha256:, script_env: {})
    [manifest_sha256, script_env]
  end
end
end
RUBY
}

write_direct_formula() {
  cat >"$TAP_ROOT/Formula/direct.rb" <<'RUBY'
require (Tap.fetch("kandelo-dev", "tap-core").path/"Kandelo/formula_support/kandelo_formula_support").to_s

class Direct < Formula
  include KandeloFormulaSupport

  desc "Direct source Formula fixture"
  homepage "https://example.test/direct"
  url "https://example.test/direct-1.0.tar.gz"
  version "1.0"
  sha256 "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  license "MIT"

  depends_on "make" => :build

  def install
    bin.install "direct"
  end
end
RUBY
}

write_missing_host_tool_formula() {
  cat >"$TAP_ROOT/Formula/missing-native.rb" <<'RUBY'
class MissingNative < Formula
  desc "Missing native host-tool fixture"
  homepage "https://example.test/missing-native"
  url "https://example.test/missing-native-1.0.tar.gz"
  version "1.0"
  sha256 "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
  license "MIT"

  depends_on "missing-native-tool" => :build

  def install
    bin.install "missing-native"
  end
end
RUBY
}

write_supportless_formula() {
  cat >"$TAP_ROOT/Formula/plain.rb" <<'RUBY'
class Plain < Formula
  desc "Direct source Formula without Kandelo support"
  homepage "https://example.test/plain"
  url "https://example.test/plain-1.0.tar.gz"
  version "1.0"
  sha256 "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
  license "MIT"

  def install
    bin.install "plain"
  end
end
RUBY
}

write_recipe_formula() {
  local digest="${1:-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb}"
  cat >"$TAP_ROOT/Formula/nethack.rb" <<RUBY
require (Tap.fetch("kandelo-dev", "tap-core").path/"Kandelo/formula_support/kandelo_formula_support").to_s

class Nethack < Formula
  include KandeloFormulaSupport

  KANDELO_TAP_RECIPE = true

  desc "Closed tap recipe fixture"
  homepage "https://example.test/nethack"
  url "https://example.test/nethack-1.0.tar.gz"
  version "1.0"
  revision 2
  sha256 "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
  license "MIT"

  depends_on "kandelo-dev/tap-core/direct"

  def install
    out_dir = kandelo_build_tap_recipe(
      manifest_sha256: "$digest",
      script_env:       {},
    )
    bin.install out_dir/"nethack"
  end
end
RUBY
}

write_bridge_formula() {
  local formula="$1" package="$2"
  local class_name
  class_name="$(printf '%s' "$formula" | awk -F- '{
    for (i = 1; i <= NF; i++) {
      printf "%s", toupper(substr($i, 1, 1)) substr($i, 2)
    }
  }')"
  cat >"$TAP_ROOT/Formula/$formula.rb" <<RUBY
require (Tap.fetch("kandelo-dev", "tap-core").path/"Kandelo/formula_support/kandelo_formula_support").to_s

class $class_name < Formula
  include KandeloFormulaSupport

  KANDELO_REGISTRY_BRIDGE = true

  desc "Registry bridge fixture"
  homepage "https://example.test/$formula"
  url "https://example.test/$formula-1.0.tar.gz"
  version "1.0"
  sha256 "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
  license "MIT"

  def install
    out_dir = kandelo_build_package(
      package:    "$package",
      script_env: {},
    )
    bin.install out_dir/"$formula"
  end
end
RUBY
}

refresh_tap_identity() {
  git -C "$TAP_ROOT" add -A
  if ! git -C "$TAP_ROOT" diff --cached --quiet; then
    git -C "$TAP_ROOT" commit -q -m "refresh authority fixtures"
  fi
  local commit
  commit="$(git -C "$TAP_ROOT" rev-parse HEAD)"
  jq -nS \
    --arg root "$TAP_ROOT" \
    --arg commit "$commit" '{
      schema: 1,
      primary: {
        tap_name: "kandelo-dev/tap-core",
        tap_repository: "kandelo-dev/homebrew-tap-core",
        tap_commit: $commit,
        root: $root
      },
      dependencies: []
    }' >"$RESOLVED_TAPS"
}

selection() {
  bash "$HELPER" \
    --kandelo-root "$REPO_ROOT" \
    --tap-root "$TAP_ROOT" \
    --tap-name kandelo-dev/tap-core \
    --resolved-taps "$RESOLVED_TAPS" \
    --ruby-bin "$RUBY_BIN" \
    --formulae "$1" \
    --arches "${2:-wasm32}" \
    --require-vfs-acceptance "${3:-false}"
}

selection_with_plan() {
  local plan="$1" formula="$2"
  TEST_AUTHORITY_PLAN="$plan" \
    bash "$HELPER" \
      --kandelo-root "$FAKE_KANDELO_ROOT" \
      --tap-root "$TAP_ROOT" \
      --tap-name kandelo-dev/tap-core \
      --resolved-taps "$RESOLVED_TAPS" \
      --ruby-bin "$RUBY_BIN" \
      --formulae "$formula" \
      --arches wasm32 \
      --require-vfs-acceptance false
}

expect_plan_failure() {
  local label="$1" plan="$2" formula="$3"
  expect_failure "$label" \
    "Formula authority plan has an invalid or unexpected schema: $formula" \
    selection_with_plan "$plan" "$formula"
}

install_native_policy_contract() {
  local root="$1"
  mkdir -p "$root/homebrew" "$root/scripts"
  cp "$REPO_ROOT/homebrew/homebrew-native-compatibility-roots.json" \
    "$root/homebrew/"
  cp "$REPO_ROOT/scripts/homebrew-validate-host-dependency-plan.sh" \
    "$root/scripts/"
}

mkdir -p "$TAP_ROOT/Formula" "$TAP_ROOT/Kandelo"
write_formula_support
write_direct_formula
write_supportless_formula
write_recipe_formula
write_bridge_formula modeset modeset
git -C "$TAP_ROOT" init -q
git -C "$TAP_ROOT" config user.name "Kandelo Test"
git -C "$TAP_ROOT" config user.email "kandelo-test@example.invalid"
refresh_tap_identity

expect_failure unpinned-ruby \
  "pinned Formula authority Ruby must come from the immutable Nix store" \
  bash "$HELPER" \
    --kandelo-root "$REPO_ROOT" \
    --tap-root "$TAP_ROOT" \
    --tap-name kandelo-dev/tap-core \
    --resolved-taps "$RESOLVED_TAPS" \
    --ruby-bin "$(command -v bash)" \
    --formulae direct \
    --arches wasm32 \
    --require-vfs-acceptance false

mixed="$(selection $' nethack,direct\n nethack ')"
[ "$(wc -l <<<"$mixed" | tr -d '[:space:]')" = 1 ] ||
  fail "authority selection is not one compact JSON line"
jq -e '
  map({formula, authority_class}) == [
    {formula:"direct", authority_class:"direct"},
    {formula:"nethack", authority_class:"tap-recipe"}
  ] and
  (.[0].formula_sha256 | test("^[0-9a-f]{64}$")) and
  .[0].tap_recipe_manifest_sha256 == null and
  .[0].tier2_package == null and
  .[1].authority_class == "tap-recipe" and
  .[1].tap_recipe_manifest_sha256 ==
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
' <<<"$mixed" >/dev/null ||
  fail "direct/schema-3 selection is not canonical: $mixed"

plain="$(selection plain)"
jq -e '
  length == 1 and
  .[0].authority_class == "direct" and
  .[0].support_sha256 == null and
  .[0].support_runtime_sha256 == null
' <<<"$plain" >/dev/null ||
  fail "supportless direct Formula is not admitted canonically: $plain"

all_selection="$(selection all)"
jq -e '
  map(.formula) == ["direct", "modeset", "nethack", "plain"]
' <<<"$all_selection" >/dev/null ||
  fail "all did not expand the complete regular Formula set"

write_missing_host_tool_formula
refresh_tap_identity
expect_failure missing-native-host-tool \
  "native host-tool policy omits selected Formula requirements: missing-native-tool" \
  selection direct,missing-native

bridge_plan="$(selection modeset)"
jq -e '
  length == 1 and
  .[0].authority_class == "registry-bridge" and
  .[0].tier2_package == "modeset" and
  .[0].tier2_version == "1.0"
' <<<"$bridge_plan" >/dev/null ||
  fail "allowlisted bridge classification changed: $bridge_plan"

FAKE_KANDELO_ROOT="$TMP_ROOT/fake-kandelo"
install_native_policy_contract "$FAKE_KANDELO_ROOT"
cat >"$FAKE_KANDELO_ROOT/scripts/homebrew-formula-runtime-closure.rb" <<'RUBY'
plan = ENV.fetch("TEST_AUTHORITY_PLAN")
abort "test authority plan must be a regular file" unless File.file?(plan)
STDOUT.write(File.binread(plan))
RUBY

capture_plan() {
  local formula="$1" output="$2"
  KANDELO_HOMEBREW_RESOLVED_TAPS_FILE="$RESOLVED_TAPS" \
    "$RUBY_BIN" "$REPO_ROOT/scripts/homebrew-formula-runtime-closure.rb" \
      "$TAP_ROOT" kandelo-dev/tap-core "$formula" \
      --tier2-bridge-json >"$output"
}

direct_plan="$TMP_ROOT/direct-plan.json"
recipe_plan="$TMP_ROOT/recipe-plan.json"
registry_plan="$TMP_ROOT/registry-plan.json"
capture_plan direct "$direct_plan"
capture_plan nethack "$recipe_plan"
capture_plan modeset "$registry_plan"

mutated_plan="$TMP_ROOT/mutated-plan.json"
jq '.full_name = "kandelo-dev/tap-core/wrong"' \
  "$direct_plan" >"$mutated_plan"
expect_plan_failure wrong-full-name "$mutated_plan" direct
jq '.unexpected = true' "$direct_plan" >"$mutated_plan"
expect_plan_failure extra-top-level-key "$mutated_plan" direct
jq '.tier2_bridge.unexpected = true' "$registry_plan" >"$mutated_plan"
expect_plan_failure extra-bridge-key "$mutated_plan" modeset
jq '.tier2_bridge.source_url = "http://example.test/modeset.tar.gz"' \
  "$registry_plan" >"$mutated_plan"
expect_plan_failure malformed-bridge-source "$mutated_plan" modeset
jq '.support_sha256 = null | .support_runtime_sha256 = null' \
  "$registry_plan" >"$mutated_plan"
expect_plan_failure bridge-without-support "$mutated_plan" modeset
jq '.tap_recipe.resources = [{
      name: "payload",
      source_sha256: ("a" * 64),
      source_url: "https://example.test/payload",
      unexpected: true
    }]' "$recipe_plan" >"$mutated_plan"
expect_plan_failure extra-recipe-resource-key "$mutated_plan" nethack
jq '.tap_recipe.declared_dependencies = ["kandelo-dev/tap-core/direct"] |
    .tap_recipe.script_env_keys = ["lowercase"]' \
  "$recipe_plan" >"$mutated_plan"
expect_plan_failure malformed-recipe-environment "$mutated_plan" nethack
jq 'del(.tap_recipe.pkg_version)' "$recipe_plan" >"$mutated_plan"
expect_plan_failure missing-recipe-package-version "$mutated_plan" nethack
jq '.tap_recipe.pkg_version = "other_2"' \
  "$recipe_plan" >"$mutated_plan"
expect_plan_failure mismatched-recipe-package-version "$mutated_plan" nethack
jq '.tap_recipe.pkg_version = "1.0_02"' \
  "$recipe_plan" >"$mutated_plan"
expect_plan_failure malformed-recipe-package-revision "$mutated_plan" nethack

LARGE_KANDELO_ROOT="$TMP_ROOT/large-kandelo"
install_native_policy_contract "$LARGE_KANDELO_ROOT"
cat >"$LARGE_KANDELO_ROOT/scripts/homebrew-formula-runtime-closure.rb" <<'RUBY'
require "json"

tap = ARGV.fetch(1).downcase
formula = ARGV.fetch(2)
if ARGV.last == "--host-dependencies-json"
  resolved = JSON.parse(
    File.binread(ENV.fetch("KANDELO_HOMEBREW_RESOLVED_TAPS_FILE")),
  )
  target_taps = [resolved.fetch("primary"), *resolved.fetch("dependencies")]
    .map do |entry|
      entry.slice("tap_name", "tap_repository", "tap_commit")
    end
    .sort_by { |entry| entry.fetch("tap_name") }
  puts JSON.generate({
    "schema" => 4,
    "tap" => tap,
    "formula" => formula,
    "full_name" => "#{tap}/#{formula}",
    "build" => [],
    "build_and_test" => [],
    "runtime_and_test" => [],
    "native_requirements" => [],
    "target_taps" => target_taps,
  })
  exit
end
puts JSON.generate({
  "schema" => 2,
  "tap" => tap,
  "formula" => formula,
  "full_name" => "#{tap}/#{formula}",
  "formula_sha256" => "a" * 64,
  "support_sha256" => nil,
  "support_runtime_sha256" => nil,
  "tier2_bridge" => nil,
})
RUBY
large_selection=""
for index in $(seq 1 160); do
  suffix="$(printf '%03d' "$index")"
  formula="f${suffix}$(printf 'x%.0s' $(seq 1 240))"
  large_selection="${large_selection}${large_selection:+,}${formula}"
done
expect_failure oversized-selection \
  "rootfs Formula authority selection exceeds the 65536-byte workflow transport limit" \
  bash "$HELPER" \
    --kandelo-root "$LARGE_KANDELO_ROOT" \
    --tap-root "$TAP_ROOT" \
    --tap-name kandelo-dev/tap-core \
    --resolved-taps "$RESOLVED_TAPS" \
    --ruby-bin "$RUBY_BIN" \
    --formulae "$large_selection" \
    --arches wasm32 \
    --require-vfs-acceptance false

write_bridge_formula legacy legacy
refresh_tap_identity
expect_failure unlisted-bridge \
  "registry bridge is not admitted by the rootfs-wasm32 lane: legacy=legacy" \
  selection legacy

expect_failure empty-selection \
  "requires at least one Formula" selection ' , '
expect_failure wasm64 \
  "supports exactly wasm32" selection direct wasm64
expect_failure vfs-acceptance \
  "cannot materialize dependency-bearing VFS acceptance" \
  selection direct wasm32 true
expect_failure invalid-name \
  "invalid Formula name" selection '../direct'
expect_failure unknown-formula \
  "could not classify Formula authority" selection missing

planned_recipe="$(selection nethack)"
write_recipe_formula \
  "abababababababababababababababababababababababababababababababab"
refresh_tap_identity
changed_recipe="$(selection nethack)"
[ "$planned_recipe" != "$changed_recipe" ] ||
  fail "recipe digest mutation did not change the authority record"

write_bridge_formula nethack nethack
refresh_tap_identity
nethack_bridge="$(selection nethack)"
jq -e '
  length == 1 and
  .[0].formula == "nethack" and
  .[0].authority_class == "registry-bridge" and
  .[0].tier2_package == "nethack"
' <<<"$nethack_bridge" >/dev/null ||
  fail "explicit NetHack registry bridge mapping is not admitted: $nethack_bridge"

cat >"$TAP_ROOT/Formula/mixed.rb" <<'RUBY'
class Mixed < Formula
  KANDELO_REGISTRY_BRIDGE = true
  KANDELO_TAP_RECIPE = true
end
RUBY
refresh_tap_identity
expect_failure mixed-authority \
  "could not classify Formula authority" selection mixed

echo "test-homebrew-rootfs-publication-selection.sh: ok"
