#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
VALIDATOR="$REPO_ROOT/scripts/homebrew-validate-host-dependency-plan.sh"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

RESOLVED="$TMP_ROOT/resolved.json"
PLAN="$TMP_ROOT/plan.json"
MUTATED="$TMP_ROOT/mutated.json"

cat >"$RESOLVED" <<'JSON'
{
  "schema": 1,
  "primary": {
    "tap_name": "kandelo-dev/tap-core",
    "tap_repository": "kandelo-dev/homebrew-tap-core",
    "tap_commit": "1111111111111111111111111111111111111111",
    "root": "/tmp/unused-tap-root"
  },
  "dependencies": []
}
JSON

cat >"$PLAN" <<'JSON'
{
  "schema": 4,
  "tap": "kandelo-dev/tap-core",
  "formula": "fixture",
  "full_name": "kandelo-dev/tap-core/fixture",
  "target_taps": [{
    "tap_name": "kandelo-dev/tap-core",
    "tap_repository": "kandelo-dev/homebrew-tap-core",
    "tap_commit": "1111111111111111111111111111111111111111"
  }],
  "build": ["binaryen", "pkgconf", "wabt"],
  "build_and_test": ["binaryen", "pkgconf", "wabt"],
  "native_requirements": [
    {
      "class": "KandeloFormulaSupport::BinaryenRequirement",
      "formula": "binaryen",
      "sentinel": "wasm-opt",
      "tags": ["build"]
    },
    {
      "class": "KandeloFormulaSupport::PkgconfRequirement",
      "formula": "pkgconf",
      "sentinel": "pkg-config",
      "tags": ["build", "test"]
    }
  ],
  "runtime_and_test": ["pkgconf"]
}
JSON

bash "$VALIDATOR" "$PLAN" kandelo-dev/tap-core fixture "$RESOLVED"

assert_rejected() {
  if bash "$VALIDATOR" "$MUTATED" kandelo-dev/tap-core fixture "$RESOLVED" \
    >/dev/null 2>&1; then
    echo "test-homebrew-validate-host-dependency-plan.sh: accepted $1" >&2
    exit 1
  fi
}

mutate_and_reject() {
  local label="$1"
  local filter="$2"
  jq "$filter" "$PLAN" >"$MUTATED"
  assert_rejected "$label"
}

mutate_and_reject "legacy schema 3" '.schema = 3'
mutate_and_reject "unsorted native Requirement records" '.native_requirements |= reverse'
mutate_and_reject "duplicate native Requirement class" \
  '.native_requirements += [.native_requirements[0]]'
mutate_and_reject "duplicate native Requirement Formula identity" '
  .native_requirements[1].formula = "binaryen" |
  .runtime_and_test = ["binaryen"]
'
mutate_and_reject "test-only native Requirement tags" \
  '.native_requirements[0].tags = ["test"]'
mutate_and_reject "missing test-list membership" '.runtime_and_test = []'
mutate_and_reject "unexpected build-only runtime membership" \
  '.runtime_and_test = ["binaryen", "pkgconf"]'
mutate_and_reject "native Formula absent from the build list" \
  '.build = ["pkgconf", "wabt"]'
mutate_and_reject "unsafe sentinel executable" \
  '.native_requirements[0].sentinel = "../wasm-opt"'
mutate_and_reject "malformed evaluated class identity" \
  '.native_requirements[0].class = "BinaryenRequirement"'
mutate_and_reject "open native Requirement record" \
  '.native_requirements[0].unexpected = true'
mutate_and_reject "missing native Requirement plan" 'del(.native_requirements)'
mutate_and_reject "oversized host dependency arrays" '
  ([range(0; 129) | "tool\(.)"] | sort) as $tools |
  .build = $tools |
  .build_and_test = $tools |
  .native_requirements = [] |
  .runtime_and_test = $tools
'

echo "test-homebrew-validate-host-dependency-plan.sh: ok"
