#!/usr/bin/env bash
# Build one Homebrew bottle from a tap checkout.
set -euo pipefail

TAP_ROOT=""
TAP_REPOSITORY="${KANDELO_HOMEBREW_TAP_REPOSITORY:-kandelo-dev/homebrew-tap-core}"
TAP_NAME_INPUT="${KANDELO_HOMEBREW_TAP_NAME:-}"
FORMULA=""
ARCH=""
OUT_DIR=""
BOTTLE_ROOT_URL=""
STAGING_CANDIDATE_ABI=""
BUILD_USER="${KANDELO_HOMEBREW_BUILD_USER:-}"
SHARED_TEMP="${KANDELO_HOMEBREW_SHARED_TEMP:-}"
LOCAL_BUILD_EVIDENCE="${KANDELO_HOMEBREW_LOCAL_BUILD_EVIDENCE:-}"
RETIRE_SOURCE_INSTALL=false

usage() {
  cat >&2 <<'EOF'
usage: scripts/homebrew-bottle-build.sh --tap-root <tap-root> [--tap-repository <owner/repo>] [--tap-name <owner/name>] --formula <name> --arch <wasm32|wasm64> --out <dir> --bottle-root-url <url> [--staging-candidate-abi <positive-integer>] [--retire-source-install]

This script is intended to run inside scripts/dev-shell.sh. It invokes the
absolute Homebrew executable named by HOMEBREW_BREW_FILE, avoiding host PATH
leakage while still using the Homebrew installation provided by the workflow.
The Homebrew checkout is patched in a temporary worktree. A short-lived
launcher symlink under the selected Homebrew prefix keeps that prefix and its
Cellar intact while loading code from the patched worktree. CI also requires a
dedicated build user, protected systemd/sudo process boundaries, and a
root-provisioned shared temporary directory through the KANDELO_HOMEBREW_*
workflow environment.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --tap-root) TAP_ROOT="${2:-}"; shift 2 ;;
    --tap-repository) TAP_REPOSITORY="${2:-}"; shift 2 ;;
    --tap-name) TAP_NAME_INPUT="${2:-}"; shift 2 ;;
    --formula) FORMULA="${2:-}"; shift 2 ;;
    --arch) ARCH="${2:-}"; shift 2 ;;
    --out) OUT_DIR="${2:-}"; shift 2 ;;
    --bottle-root-url) BOTTLE_ROOT_URL="${2:-}"; shift 2 ;;
    --staging-candidate-abi) STAGING_CANDIDATE_ABI="${2:-}"; shift 2 ;;
    --retire-source-install)
      [ "$RETIRE_SOURCE_INSTALL" = false ] || {
        echo "homebrew-bottle-build.sh: duplicate --retire-source-install" >&2
        exit 2
      }
      RETIRE_SOURCE_INSTALL=true
      shift
      ;;
    -h|--help) usage; exit 0 ;;
    *) echo "homebrew-bottle-build.sh: unknown flag $1" >&2; usage; exit 2 ;;
  esac
done

require() {
  local name="$1" value="$2"
  if [ -z "$value" ]; then
    echo "homebrew-bottle-build.sh: --$name is required" >&2
    exit 2
  fi
}

require tap-root "$TAP_ROOT"
require tap-repository "$TAP_REPOSITORY"
require formula "$FORMULA"
require arch "$ARCH"
require out "$OUT_DIR"
require bottle-root-url "$BOTTLE_ROOT_URL"

if ! [[ "$TAP_REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  echo "homebrew-bottle-build.sh: invalid tap repository: $TAP_REPOSITORY" >&2
  exit 2
fi
if ! [[ "$FORMULA" =~ ^[a-z0-9][a-z0-9._-]*$ ]]; then
  echo "homebrew-bottle-build.sh: invalid formula name: $FORMULA" >&2
  exit 2
fi

case "$ARCH" in
  wasm32|wasm64) ;;
  *) echo "homebrew-bottle-build.sh: invalid arch: $ARCH" >&2; exit 2 ;;
esac
if [ -n "$STAGING_CANDIDATE_ABI" ] &&
   ! [[ "$STAGING_CANDIDATE_ABI" =~ ^[1-9][0-9]*$ ]]; then
  echo "homebrew-bottle-build.sh: invalid staging candidate ABI: $STAGING_CANDIDATE_ABI" >&2
  exit 2
fi

if [ -n "$LOCAL_BUILD_EVIDENCE" ]; then
  if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
    echo "homebrew-bottle-build.sh: local build evidence is forbidden in CI" >&2
    exit 2
  fi
  case "$LOCAL_BUILD_EVIDENCE" in
    /*) ;;
    *) echo "homebrew-bottle-build.sh: local build evidence path must be absolute" >&2; exit 2 ;;
  esac
  if [ -e "$LOCAL_BUILD_EVIDENCE" ] || [ -L "$LOCAL_BUILD_EVIDENCE" ]; then
    echo "homebrew-bottle-build.sh: local build evidence output already exists" >&2
    exit 2
  fi
fi

if [ "$RETIRE_SOURCE_INSTALL" = true ]; then
  [ -n "$BUILD_USER" ] || {
    echo "homebrew-bottle-build.sh: source target retirement requires isolated Formula execution" >&2
    exit 2
  }
  [ "${GITHUB_ACTIONS:-}" != true ] || {
    echo "homebrew-bottle-build.sh: source target retirement is local batch behavior" >&2
    exit 2
  }
fi

if [ "${GITHUB_ACTIONS:-}" = "true" ] && [ -z "$BUILD_USER" ]; then
  # WHY: every CI Formula must run as the isolated build identity. Reject the
  # missing authority before creating output, temporary realms, or loading
  # Homebrew so a secondary setup error cannot hide the actual trust failure.
  echo "homebrew-bottle-build.sh: CI Formula execution requires KANDELO_HOMEBREW_BUILD_USER" >&2
  exit 2
fi

TAP_ROOT="$(cd "$TAP_ROOT" && pwd -P)"
mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"

FORMULA_PATH="$TAP_ROOT/Formula/$FORMULA.rb"
if [ ! -f "$FORMULA_PATH" ]; then
  echo "homebrew-bottle-build.sh: formula file not found: $FORMULA_PATH" >&2
  exit 2
fi

BREW_BIN="${HOMEBREW_BREW_FILE:-}"
if [ -z "$BREW_BIN" ]; then
  BREW_BIN="$(command -v brew || true)"
fi
if [ -z "$BREW_BIN" ] || [ ! -x "$BREW_BIN" ]; then
  echo "homebrew-bottle-build.sh: HOMEBREW_BREW_FILE does not name an executable brew" >&2
  exit 2
fi

# Bottles retain an embedded receipt for Kandelo's static VFS composer, so the
# publisher overlay cannot use Homebrew's `--only-json-tab` reproducibility
# path. Supply the exact declared GNU tar instead of letting Formula code or an
# ambient host PATH choose the archive implementation.
unset HOMEBREW_KANDELO_GNU_TAR
HOMEBREW_KANDELO_GNU_TAR="$(command -v tar || true)"
GNU_TAR_VERSION="$("$HOMEBREW_KANDELO_GNU_TAR" --version 2>/dev/null || true)"
if ! [[ "$HOMEBREW_KANDELO_GNU_TAR" =~ ^/nix/store/[0-9a-z]{32}-gnutar-[^/]+/bin/tar$ ]] ||
   [ ! -f "$HOMEBREW_KANDELO_GNU_TAR" ] ||
   [ -L "$HOMEBREW_KANDELO_GNU_TAR" ] ||
   [ ! -x "$HOMEBREW_KANDELO_GNU_TAR" ] ||
   [ -w "$HOMEBREW_KANDELO_GNU_TAR" ] ||
   ! [[ "${GNU_TAR_VERSION%%$'\n'*}" =~ ^tar\ \(GNU\ tar\)\ [0-9] ]]; then
  echo "homebrew-bottle-build.sh: dev shell does not provide a protected Nix GNU tar" >&2
  exit 2
fi
unset GNU_TAR_VERSION
export HOMEBREW_KANDELO_GNU_TAR

KANDELO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=/dev/null
. "$KANDELO_ROOT/scripts/homebrew-tap-identity.sh"
# shellcheck source=/dev/null
. "$KANDELO_ROOT/scripts/homebrew-formula-support-inputs.sh"
# shellcheck source=/dev/null
. "$KANDELO_ROOT/scripts/homebrew-guest-layout.sh"
TAP_NAME="$(homebrew_resolve_tap_name "$TAP_REPOSITORY" "$TAP_NAME_INPUT")"
if [ -n "$STAGING_CANDIDATE_ABI" ]; then
  EXPECTED_BOTTLE_ROOT_URL="$(homebrew_candidate_bottle_root_url \
    "$TAP_REPOSITORY" "$STAGING_CANDIDATE_ABI" "$FORMULA")"
else
  EXPECTED_BOTTLE_ROOT_URL="$(homebrew_bottle_root_url "$TAP_REPOSITORY" "$TAP_NAME")"
fi
if [ "$BOTTLE_ROOT_URL" != "$EXPECTED_BOTTLE_ROOT_URL" ]; then
  echo "homebrew-bottle-build.sh: bottle root URL does not match its exact publication authority" >&2
  exit 2
fi
DEPENDENCY_BOTTLE_ROOT_URL="$BOTTLE_ROOT_URL"
DEPENDENCY_PROVENANCE_SCOPE_ARGS=()
if [ -n "$STAGING_CANDIDATE_ABI" ]; then
  # Candidate bottles have one repository per Formula. Dependency provenance
  # describes the complete poured closure, so it is rooted at their common
  # ABI candidate parent and appends each dependency Formula itself.
  DEPENDENCY_BOTTLE_ROOT_URL="${BOTTLE_ROOT_URL%/*}"
  DEPENDENCY_PROVENANCE_SCOPE_ARGS=(
    --staging-candidate-abi "$STAGING_CANDIDATE_ABI"
  )
fi
homebrew_select_guest_layout \
  "${KANDELO_HOMEBREW_PREFIX_CAMPAIGN_LAYOUT_SHA256:-}"
PATCH_FILE="$HOMEBREW_GUEST_PATCH_FILE"
PUBLISHER_ISOLATION_PATCH_FILE="$KANDELO_ROOT/homebrew/patches/0002-support-isolated-publisher.patch"
. "$KANDELO_ROOT/scripts/homebrew-patched-launcher.sh"
# shellcheck source=/dev/null
. "$KANDELO_ROOT/scripts/homebrew-native-install-contract.sh"
homebrew_patched_launcher_select_host_git
if [ -n "$BUILD_USER" ]; then
  homebrew_patched_launcher_restore_invoker_bootstrap_roots \
    "$BUILD_USER" "$HOMEBREW_GUEST_PREFIX"
fi
mkdir -p "$OUT_DIR/bottles"
if [ -n "$BUILD_USER" ]; then
  if [ ! -d "$SHARED_TEMP" ] || [ -L "$SHARED_TEMP" ]; then
    echo "homebrew-bottle-build.sh: isolated Formula execution requires a real shared temp root" >&2
    exit 2
  fi
  SHARED_TEMP="$(cd "$SHARED_TEMP" && pwd -P)"
  WORK_DIR="$(mktemp -d "$SHARED_TEMP/homebrew-build.XXXXXX")"
else
  WORK_DIR="$(mktemp -d)"
fi
NATIVE_BASE="$(mktemp -d /tmp/k.XXXXXX)"
NATIVE_BASE="$(cd "$NATIVE_BASE" && pwd -P)"
NATIVE_BUILD_ROOT="$NATIVE_BASE"
if [ -n "$BUILD_USER" ]; then
  chmod 0711 "$NATIVE_BASE"
fi
CONTROL_DIR="$(mktemp -d "$OUT_DIR/.control.XXXXXX")"
chmod 0700 "$CONTROL_DIR"
CANDIDATE_TAP_SEALED=0

cleanup() {
  local original_status="${1:-0}" launcher_status=0 tap_restore_status=0
  if [ "$CANDIDATE_TAP_SEALED" = 1 ]; then
    chmod -R u+w -- "$TAPPED_TAP_ROOT" || tap_restore_status="$?"
    CANDIDATE_TAP_SEALED=0
  fi
  if homebrew_patched_launcher_cleanup; then
    :
  else
    launcher_status="$?"
  fi
  rm -rf "$CONTROL_DIR"
  if [ "$launcher_status" -ne 0 ]; then
    echo "homebrew-bottle-build.sh: preserving temporary Homebrew realms after cleanup failure" >&2
  elif [ -n "$BUILD_USER" ] && [ -n "${KANDELO_HOMEBREW_SUDO_BIN:-}" ]; then
    "$KANDELO_HOMEBREW_SUDO_BIN" rm -rf "$NATIVE_BASE" "$WORK_DIR" >/dev/null 2>&1 || true
  else
    rm -rf "$NATIVE_BASE" "$WORK_DIR"
  fi
  [ "$original_status" -eq 0 ] || return "$original_status"
  [ "$tap_restore_status" -eq 0 ] || return "$tap_restore_status"
  return "$launcher_status"
}

cleanup_and_exit() {
  local original_status="$1" cleanup_status=0
  trap - EXIT
  if cleanup "$original_status"; then
    :
  else
    cleanup_status="$?"
  fi
  if [ "$original_status" -ne 0 ]; then
    exit "$original_status"
  fi
  exit "$cleanup_status"
}
trap 'cleanup_and_exit $?' EXIT

# Formula dependencies are evaluated separately from the formula named on the
# command line. Trust the reviewed tap as a whole, but keep every Brew call in
# this build scoped away from user state. The launcher derives
# HOMEBREW_USER_CONFIG_HOME from XDG_CONFIG_HOME, so set the isolated XDG root
# before discovering the repository and prefix.
export XDG_CONFIG_HOME="$WORK_DIR/xdg-config"
mkdir -p "$XDG_CONFIG_HOME/homebrew"
chmod 0700 "$XDG_CONFIG_HOME" "$XDG_CONFIG_HOME/homebrew"
unset HOMEBREW_RELOCATE_BUILD_PREFIX
unset HOMEBREW_KANDELO_PRIMARY_TAP_ROOT

# WHY: even read-only Homebrew discovery loads user configuration. Establish
# the private build config first so prefix validation cannot observe or mutate
# the runner account's Homebrew state.
if [ "$("$BREW_BIN" --prefix)" != "$HOMEBREW_GUEST_PREFIX" ] ||
   [ "$("$BREW_BIN" --cellar)" != "$HOMEBREW_GUEST_CELLAR" ]; then
  echo "homebrew-bottle-build.sh: active Homebrew prefix differs from the selected guest layout" >&2
  exit 2
fi

homebrew_patched_launcher_prepare \
  "$BREW_BIN" "$PATCH_FILE" "$WORK_DIR" "$PUBLISHER_ISOLATION_PATCH_FILE"
BREW_BIN="$HOMEBREW_PATCHED_BREW_BIN"
NATIVE_PREFIX="$(homebrew_patched_launcher_native_prefix_path "$NATIVE_BASE")"
NATIVE_CACHE="$NATIVE_BASE/c"
NATIVE_TEMP="$NATIVE_BASE/t"
NATIVE_CONFIG="$NATIVE_BASE/g"
NATIVE_HOME="$NATIVE_BASE/h"
homebrew_patched_launcher_prepare_native_prefix \
  "$NATIVE_PREFIX" "$NATIVE_CACHE" "$NATIVE_TEMP" "$NATIVE_CONFIG" \
  "$NATIVE_HOME"

BOTTLE_TAG="${ARCH}_kandelo"

export HOMEBREW_NO_AUTO_UPDATE="${HOMEBREW_NO_AUTO_UPDATE:-1}"
export HOMEBREW_NO_INSTALL_CLEANUP="${HOMEBREW_NO_INSTALL_CLEANUP:-1}"
export HOMEBREW_NO_ANALYTICS="${HOMEBREW_NO_ANALYTICS:-1}"
export HOMEBREW_DEVELOPER="${HOMEBREW_DEVELOPER:-1}"
if [ -n "$LOCAL_BUILD_EVIDENCE" ]; then
  # WHY: the local product harness must retain the real configure transcript
  # and generated config.h from the same Homebrew build as the bottle. CI and
  # publishable builds keep their existing ephemeral cleanup behavior.
  export HOMEBREW_KEEP_TMP=1
fi
export KANDELO_HOMEBREW_ARCH="$ARCH"
export KANDELO_HOMEBREW_KANDELO_ROOT="$KANDELO_ROOT"
export HOMEBREW_KANDELO_ARCH="$ARCH"
export HOMEBREW_KANDELO_ROOT="$KANDELO_ROOT"
export HOMEBREW_KANDELO_NODE="$(command -v node)"
export HOMEBREW_KANDELO_LLVM_BIN="${LLVM_BIN:-${WASM_POSIX_LLVM_DIR:-}}"

homebrew_patched_launcher_seed_bundler_groups bottle formula_test

unset HOMEBREW_KANDELO_BOTTLE_TAG KANDELO_HOMEBREW_BOTTLE_TAG

run_brew_for_kandelo_bottles() {
  HOMEBREW_KANDELO_BOTTLE_TAG="$BOTTLE_TAG" \
  KANDELO_HOMEBREW_BOTTLE_TAG="$BOTTLE_TAG" \
    "$@"
}

INSTALL_LOG="$CONTROL_DIR/brew-install.log"
NATIVE_INSTALL_LOG="$CONTROL_DIR/native-brew-install.log"
HOST_DEPENDENCY_PLAN="$CONTROL_DIR/host-dependencies.json"
TIER2_BRIDGE_PLAN="$CONTROL_DIR/tier2-bridge-plan.json"
TIER2_EXECUTION_PLAN="$CONTROL_DIR/tier2-execution-plan.json"
TIER2_ATTESTATION="$CONTROL_DIR/tier2-attestation.json"
TIER2_EXECUTION_ATTESTATION="$CONTROL_DIR/tier2-execution-attestation.json"
TARGET_BOTTLE_IDENTITY="$CONTROL_DIR/target-bottle-identity.json"
HOST_DEPENDENCY_LIST="$CONTROL_DIR/host-dependencies.txt"
DEPENDENCY_LIST="$CONTROL_DIR/same-tap-dependencies.txt"
BUILD_TEST_DEPENDENCY_LIST="$CONTROL_DIR/same-tap-build-test-dependencies.txt"
DEPENDENCY_POUR_LIST="$CONTROL_DIR/target-pour-dependencies.txt"
ALLOWED_TARGET_TAPS="$CONTROL_DIR/allowed-target-taps.txt"
STATIC_RUNTIME_DEPENDENCIES="$CONTROL_DIR/static-runtime-dependencies.txt"
DEPENDENCY_CACHE_EVIDENCE="$CONTROL_DIR/dependency-cache-evidence.json"
TARGET_CELLAR_BEFORE_TEST="$CONTROL_DIR/target-cellar-before-test.txt"
TARGET_CELLAR_AFTER_TEST="$CONTROL_DIR/target-cellar-after-test.txt"
DEPENDENCY_PROVENANCE="$OUT_DIR/dependency-provenance.json"
: >"$INSTALL_LOG"
: >"$NATIVE_INSTALL_LOG"
: >"$HOST_DEPENDENCY_PLAN"
: >"$TIER2_BRIDGE_PLAN"
: >"$TIER2_EXECUTION_PLAN"
: >"$TIER2_ATTESTATION"
: >"$TIER2_EXECUTION_ATTESTATION"
: >"$TARGET_BOTTLE_IDENTITY"
: >"$HOST_DEPENDENCY_LIST"
: >"$DEPENDENCY_LIST"
: >"$BUILD_TEST_DEPENDENCY_LIST"
: >"$DEPENDENCY_POUR_LIST"
: >"$ALLOWED_TARGET_TAPS"
: >"$STATIC_RUNTIME_DEPENDENCIES"
: >"$DEPENDENCY_CACHE_EVIDENCE"
: >"$TARGET_CELLAR_BEFORE_TEST"
: >"$TARGET_CELLAR_AFTER_TEST"
for attempt in 1 2 3; do
  : >"$CONTROL_DIR/brew-install-attempt-${attempt}.log"
done
chmod 0600 "$INSTALL_LOG" "$NATIVE_INSTALL_LOG" \
  "$HOST_DEPENDENCY_PLAN" "$TARGET_BOTTLE_IDENTITY" \
  "$TIER2_BRIDGE_PLAN" "$TIER2_EXECUTION_PLAN" \
  "$TIER2_ATTESTATION" "$TIER2_EXECUTION_ATTESTATION" \
  "$HOST_DEPENDENCY_LIST" "$DEPENDENCY_LIST" \
  "$BUILD_TEST_DEPENDENCY_LIST" "$DEPENDENCY_POUR_LIST" \
  "$ALLOWED_TARGET_TAPS" "$STATIC_RUNTIME_DEPENDENCIES" \
  "$DEPENDENCY_CACHE_EVIDENCE" \
  "$TARGET_CELLAR_BEFORE_TEST" "$TARGET_CELLAR_AFTER_TEST" \
  "$CONTROL_DIR"/brew-install-attempt-*.log

validate_dependency_list() {
  local path="$1" label="$2" bytes count
  bytes="$(wc -c <"$path" | tr -d '[:space:]')"
  count="$(awk 'NF { count++ } END { print count + 0 }' "$path")"
  if [ "$bytes" -gt 65536 ] || [ "$count" -gt 128 ]; then
    echo "homebrew-bottle-build.sh: $label exceeds the dependency limit" >&2
    exit 2
  fi
}

# Derive the native host plan without executing Formula Ruby. This root-owned,
# bounded list is the only input allowed to select core Formulae later under the
# isolated native launcher.
EXPECTED_PLAN_TAP="$TAP_NAME"
HOST_TARGET="$(rustc -vV | sed -n 's/^host: //p')"
XTASK_BIN="$KANDELO_ROOT/target/$HOST_TARGET/release/xtask"
if [ -z "$HOST_TARGET" ] || [ ! -f "$XTASK_BIN" ] || [ -L "$XTASK_BIN" ] ||
   [ ! -x "$XTASK_BIN" ]; then
  echo "homebrew-bottle-build.sh: exact prebuilt release xtask is unavailable" >&2
  exit 2
fi
# WHY: the workflow-scoped variable crosses the dev-shell boundary, while
# HOST_TARGET is derived independently inside it. Requiring both authorities
# to name the same binary prevents another safe-looking target directory from
# selecting the package-policy checker used by isolated Formula tests.
if [ -n "$BUILD_USER" ] && [ "${WASM_POSIX_XTASK_BIN:-}" != "$XTASK_BIN" ]; then
  echo "homebrew-bottle-build.sh: scoped program-index checker differs from the exact host xtask" >&2
  exit 2
fi
WASM_POSIX_XTASK_BIN="$XTASK_BIN"
export WASM_POSIX_XTASK_BIN
ruby "$KANDELO_ROOT/scripts/homebrew-formula-runtime-closure.rb" \
  "$TAP_ROOT" "$TAP_NAME" "$FORMULA" --tier2-bridge-json \
  >"$TIER2_BRIDGE_PLAN"
"$XTASK_BIN" homebrew-tier2-preflight \
  --repo-root "$KANDELO_ROOT" --tap-root "$TAP_ROOT" --arch "$ARCH" \
  --bridge-plan "$TIER2_BRIDGE_PLAN" >"$TIER2_ATTESTATION"
if ! jq -e --arg tap "$EXPECTED_PLAN_TAP" --arg formula "$FORMULA" \
  --arg arch "$ARCH" '
    def sha256: type == "string" and test("^[0-9a-f]{64}$");
    (.schema == 4 or .schema == 3) and
    .tap == $tap and .formula == $formula and .arch == $arch and
    .full_name == ($tap + "/" + $formula) and
    (.formula_sha256 | sha256) and
    (.support_sha256 == null or (.support_sha256 | sha256)) and
    (.support_runtime_sha256 == null or (.support_runtime_sha256 | sha256)) and
    ((.support_sha256 == null) == (.support_runtime_sha256 == null)) and
    if .schema == 4 then
      keys == ["arch", "formula", "formula_sha256", "full_name", "schema", "support_runtime_sha256", "support_sha256", "tap", "tier2_bridge"] and
      (.tier2_bridge == null or .support_sha256 != null) and
      if .tier2_bridge == null then true else
      (.tier2_bridge | keys == ["package", "script", "script_env_keys", "script_sha256", "source_sha256", "source_url", "version"]) and
      (.tier2_bridge.package | type == "string" and test("^[a-z0-9][a-z0-9._-]{0,254}$")) and
      (.tier2_bridge.script | type == "string" and test("^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$")) and
      ([.tier2_bridge.script_sha256, .tier2_bridge.source_sha256] |
        all(.[]; sha256)) and
      (.tier2_bridge.script_env_keys | type == "array" and
        . == (sort | unique) and length <= 64 and
        (map(length) | add // 0) <= 4096) and
      (.tier2_bridge.source_url | type == "string" and startswith("https://")) and
      (.tier2_bridge.version | type == "string" and length > 0)
      end
    else
      keys == ["arch", "formula", "formula_sha256", "full_name", "schema", "support_runtime_sha256", "support_sha256", "tap", "tap_recipe", "tier2_bridge"] and
      .tier2_bridge == null and .support_sha256 != null and
      (.tap_recipe | keys == ["dependencies", "entrypoint", "file_count", "manifest_sha256", "pkg_version", "resources", "script_env_keys", "source_sha256", "source_url", "total_bytes", "version"]) and
      (.tap_recipe.dependencies | type == "array" and . == (sort | unique) and
        length <= 128 and all(.[]; type == "string" and
          test("^[a-z0-9._-]+/[a-z0-9._-]+/[a-z0-9][a-z0-9._-]{0,254}$"))) and
      (.tap_recipe.entrypoint | type == "string" and
        test("^[A-Za-z0-9][A-Za-z0-9._/-]{0,1023}[.]sh$")) and
      (.tap_recipe.file_count | type == "number" and . >= 1 and . <= 512 and floor == .) and
      (.tap_recipe.total_bytes | type == "number" and . >= 0 and . <= 67108864 and floor == .) and
      (.tap_recipe.manifest_sha256 | sha256) and
      (.tap_recipe.source_sha256 | sha256) and
      (.tap_recipe.resources | type == "array" and
        . == (sort_by(.name) | unique_by(.name)) and
        length <= 32 and all(.[];
          keys == ["name", "source_sha256", "source_url"] and
          (.name | type == "string" and test("^[a-z0-9][a-z0-9._+-]{0,127}$")) and
          (.source_sha256 | sha256) and
          (.source_url | type == "string" and length >= 9 and length <= 1024 and
            startswith("https://")))) and
      (.tap_recipe.script_env_keys | type == "array" and
        . == (sort | unique) and length <= 64 and
        (map(length) | add // 0) <= 4096) and
      ((.tap_recipe.dependencies |
          map(split("/")[-1] | ascii_upcase | gsub("[^A-Z0-9]"; "_") |
            "WASM_POSIX_DEP_" + . + "_DIR")) as $dependency_keys |
        (.tap_recipe.resources |
          map(.name | ascii_upcase | gsub("[^A-Z0-9]"; "_") |
            "WASM_POSIX_DEP_RESOURCE_" + . + "_DIR")) as $resource_keys |
        .tap_recipe.script_env_keys as $script_env_keys |
        (($resource_keys | length) == ($resource_keys | unique | length)) and
        ([$dependency_keys[] |
          select(. as $key | $resource_keys | index($key))] | length == 0) and
        ([$resource_keys[] |
          select(. as $key | $script_env_keys | index($key))] | length == 0)) and
      (.tap_recipe.source_url | type == "string" and startswith("https://")) and
      (.tap_recipe.pkg_version |
        type == "string" and
        test("^[A-Za-z0-9][A-Za-z0-9._+,-]{0,254}$")) and
      (.tap_recipe.version as $version |
        .tap_recipe.pkg_version == $version or
        (.tap_recipe.pkg_version |
          startswith($version + "_") and
          (ltrimstr($version + "_") | test("^[1-9][0-9]*$")))) and
      (.tap_recipe.version |
        type == "string" and
        test("^[A-Za-z0-9][A-Za-z0-9._+,-]{0,254}$"))
    end
  ' "$TIER2_ATTESTATION" >/dev/null; then
  echo "homebrew-bottle-build.sh: Tier-2 bridge attestation has an invalid schema" >&2
  exit 2
fi
if jq -e '.schema == 3' "$TIER2_ATTESTATION" >/dev/null; then
  # WHY: closed tap recipes receive executable platform tools, never the Cargo
  # workspace that could rebuild resolver/checker code. Build both helpers
  # while the trusted workflow still owns the exact Kandelo checkout.
  for tool in wasm-fork-instrument wasm-local-root-spill; do
    tool_path="$KANDELO_ROOT/tools/bin/$tool"
    if [ ! -f "$tool_path" ] || [ -L "$tool_path" ] || [ ! -x "$tool_path" ]; then
      case "$tool" in
        wasm-fork-instrument)
          bash "$KANDELO_ROOT/scripts/build-fork-instrument-tool.sh"
          ;;
        wasm-local-root-spill)
          bash "$KANDELO_ROOT/scripts/build-local-root-spill-tool.sh"
          ;;
      esac
    fi
    [ -f "$tool_path" ] && [ ! -L "$tool_path" ] && [ -x "$tool_path" ] || {
      echo "homebrew-bottle-build.sh: required closed-recipe platform tool is unavailable: $tool" >&2
      exit 2
    }
  done
fi
ruby "$KANDELO_ROOT/scripts/homebrew-formula-runtime-closure.rb" \
  "$TAP_ROOT" "$TAP_NAME" "$FORMULA" --bottle-identity-json \
  >"$TARGET_BOTTLE_IDENTITY"
[ "$(wc -c <"$TARGET_BOTTLE_IDENTITY" | tr -d '[:space:]')" -le 4096 ] || {
  echo "homebrew-bottle-build.sh: target bottle identity exceeds the size limit" >&2
  exit 2
}
if ! jq -e --arg tap "$EXPECTED_PLAN_TAP" --arg formula "$FORMULA" '
    keys == ["bottle", "formula", "full_name", "schema", "tap"] and
    .schema == 1 and
    .tap == $tap and
    .formula == $formula and
    .full_name == ($tap + "/" + $formula) and
    (.bottle | keys == ["rebuild", "root_url"]) and
    (.bottle.rebuild | type == "number" and . >= 0 and floor == .) and
    (.bottle.root_url == null or
      (.bottle.root_url | type == "string" and length <= 1024))
  ' "$TARGET_BOTTLE_IDENTITY" >/dev/null; then
  echo "homebrew-bottle-build.sh: planned Formula bottle identity is invalid" >&2
  exit 2
fi
FORMULA_BOTTLE_ROOT="$(jq -r '.bottle.root_url // ""' "$TARGET_BOTTLE_IDENTITY")"
if ! homebrew_formula_bottle_root_matches_build_authority \
  "$TAP_REPOSITORY" "$TAP_NAME" "$FORMULA" "$STAGING_CANDIDATE_ABI" \
  "$BOTTLE_ROOT_URL" "$FORMULA_BOTTLE_ROOT"; then
  echo "homebrew-bottle-build.sh: planned Formula bottle identity uses a different root URL" >&2
  exit 2
fi
EXPECTED_BOTTLE_REBUILD="$(jq -r '.bottle.rebuild' "$TARGET_BOTTLE_IDENTITY")"
[ -n "${KANDELO_HOMEBREW_RESOLVED_TAPS_FILE:-}" ] || {
  echo "homebrew-bottle-build.sh: immutable resolved tap map is required" >&2
  exit 2
}
ruby "$KANDELO_ROOT/scripts/homebrew-formula-runtime-closure.rb" \
  "$TAP_ROOT" "$TAP_NAME" "$FORMULA" --host-dependencies-json \
  >"$HOST_DEPENDENCY_PLAN"
[ "$(wc -c <"$HOST_DEPENDENCY_PLAN" | tr -d '[:space:]')" -le 65536 ] || {
  echo "homebrew-bottle-build.sh: host dependency plan exceeds the size limit" >&2
  exit 2
}
bash "$KANDELO_ROOT/scripts/homebrew-validate-host-dependency-plan.sh" \
  "$HOST_DEPENDENCY_PLAN" "$EXPECTED_PLAN_TAP" "$FORMULA" \
  "$KANDELO_HOMEBREW_RESOLVED_TAPS_FILE" || {
  echo "homebrew-bottle-build.sh: invalid static host dependency plan" >&2
  exit 2
}
jq -r '.build_and_test[]' "$HOST_DEPENDENCY_PLAN" >"$HOST_DEPENDENCY_LIST"
validate_dependency_list "$HOST_DEPENDENCY_LIST" "host dependency list"
homebrew_patched_launcher_stage_dependency_plan "$HOST_DEPENDENCY_PLAN"
homebrew_native_contract_select_api_source \
  homebrew-bottle-build.sh "$BUILD_USER" \
  "$HOST_DEPENDENCY_PLAN" "$HOST_DEPENDENCY_LIST"

TAP_CHECKOUT_COMMIT="$(git -C "$TAP_ROOT" rev-parse HEAD)"
TAP_COMMIT="${KANDELO_HOMEBREW_TAP_SOURCE_COMMIT:-$TAP_CHECKOUT_COMMIT}"
EXPECTED_TAP_CHECKOUT_COMMIT="$TAP_COMMIT"
if [ -n "${KANDELO_HOMEBREW_PREPARED_TAP_COMMIT:-}" ]; then
  [ -n "${KANDELO_HOMEBREW_TAP_SOURCE_COMMIT:-}" ] || {
    echo "homebrew-bottle-build.sh: campaign checkout requires its public tap source commit" >&2
    exit 2
  }
  EXPECTED_TAP_CHECKOUT_COMMIT="$KANDELO_HOMEBREW_PREPARED_TAP_COMMIT"
fi
for commit in "$TAP_COMMIT" "$EXPECTED_TAP_CHECKOUT_COMMIT" \
  "$TAP_CHECKOUT_COMMIT"; do
  [[ "$commit" =~ ^[0-9a-f]{40}$ ]] || {
    echo "homebrew-bottle-build.sh: invalid tap commit identity" >&2
    exit 2
  }
done
[ "$TAP_CHECKOUT_COMMIT" = "$EXPECTED_TAP_CHECKOUT_COMMIT" ] || {
  echo "homebrew-bottle-build.sh: tap checkout differs from the reviewed source materialization" >&2
  exit 2
}
# WHY: a prefix campaign materializes dependency bottle blocks in a local
# synthetic commit. The public source commit remains publication authority,
# while Homebrew must truthfully record the synthetic commit it actually runs.
PRIMARY_TAP_CLONE_URL="$(homebrew_local_tap_clone_url "$TAP_ROOT")"
"$BREW_BIN" tap "$TAP_NAME" "$PRIMARY_TAP_CLONE_URL"
TAPPED_TAP_ROOT="$("$BREW_BIN" --repository "$TAP_NAME")"
TAPPED_TAP_ROOT="$(cd "$TAPPED_TAP_ROOT" && pwd -P)"
[ "$TAPPED_TAP_ROOT" != "$TAP_ROOT" ] && \
  [ "$(git -C "$TAPPED_TAP_ROOT" rev-parse HEAD)" = "$TAP_CHECKOUT_COMMIT" ] && \
  [ -z "$(git -C "$TAPPED_TAP_ROOT" status --short --untracked-files=all)" ] || {
  echo "homebrew-bottle-build.sh: Homebrew did not clone the planned tap commit cleanly" >&2
  exit 1
}
# Formula resolution may load a locked dependency tap's support before it
# loads the selected Formula's support. Keep the selected tap root as explicit
# publisher authority instead of letting Ruby load order choose it. The
# isolated launcher snapshots this HOMEBREW_* value into its root-owned
# wrapper, and Homebrew preserves it across its Formula-evaluation re-execs.
export HOMEBREW_KANDELO_PRIMARY_TAP_ROOT="$TAPPED_TAP_ROOT"
homebrew_prune_formula_support_tests_from_tapped_clone "$TAPPED_TAP_ROOT"

printf '%s\n' "$TAP_NAME" >"$ALLOWED_TARGET_TAPS"
DEPENDENCY_TAP_ROOTS=()
if [ -n "${KANDELO_HOMEBREW_RESOLVED_TAPS_FILE:-}" ]; then
  while IFS=$'\t' read -r dependency_tap dependency_root dependency_commit; do
    [ -n "$dependency_tap" ] && [ -n "$dependency_root" ] && \
      [ -n "$dependency_commit" ] || {
      echo "homebrew-bottle-build.sh: resolved dependency tap is incomplete" >&2
      exit 2
    }
    dependency_tap_clone_url="$(
      homebrew_local_tap_clone_url "$dependency_root"
    )"
    "$BREW_BIN" tap "$dependency_tap" "$dependency_tap_clone_url"
    tapped_dependency_root="$("$BREW_BIN" --repository "$dependency_tap")"
    tapped_dependency_root="$(cd "$tapped_dependency_root" && pwd -P)"
    locked_dependency_root="$(cd "$dependency_root" && pwd -P)"
    [ "$tapped_dependency_root" != "$locked_dependency_root" ] && \
      [ "$(git -C "$tapped_dependency_root" rev-parse HEAD)" = "$dependency_commit" ] && \
      [ -z "$(git -C "$tapped_dependency_root" status --short --untracked-files=all)" ] || {
      echo "homebrew-bottle-build.sh: Homebrew did not clone dependency tap $dependency_tap at its locked commit cleanly" >&2
      exit 1
    }
    homebrew_prune_formula_support_tests_from_tapped_clone \
      "$tapped_dependency_root"
    printf '%s\n' "$dependency_tap" >>"$ALLOWED_TARGET_TAPS"
    DEPENDENCY_TAP_ROOTS+=("$dependency_root")
  done < <(jq -er '.dependencies[] | [.tap_name, .root, .tap_commit] | @tsv' \
    "$KANDELO_HOMEBREW_RESOLVED_TAPS_FILE")
fi
LC_ALL=C sort -u -o "$ALLOWED_TARGET_TAPS" "$ALLOWED_TARGET_TAPS"
validate_dependency_list "$ALLOWED_TARGET_TAPS" "allowed target tap list"

# Trust only the reviewed primary tap and its immutable dependency tap
# checkouts. The publisher-only Homebrew patch suppresses automatic
# persistence of redundant item entries for already-trusted taps, so this
# store can remain immutable during Formula evaluation.
"$BREW_BIN" trust --tap "$TAP_NAME"
if [ -n "${KANDELO_HOMEBREW_RESOLVED_TAPS_FILE:-}" ]; then
  while IFS= read -r dependency_tap; do
    [ "$dependency_tap" = "$TAP_NAME" ] || "$BREW_BIN" trust --tap "$dependency_tap"
  done <"$ALLOWED_TARGET_TAPS"
fi
FORMULA_REF="$TAP_NAME/$FORMULA"
TAPPED_FORMULA_PATH="$TAPPED_TAP_ROOT/Formula/$FORMULA.rb"

same_file() {
  [ -e "$1" ] && [ -e "$2" ] && [ "$1" -ef "$2" ]
}

if ! same_file "$FORMULA_PATH" "$TAPPED_FORMULA_PATH"; then
  mkdir -p "$(dirname "$TAPPED_FORMULA_PATH")"
  cp "$FORMULA_PATH" "$TAPPED_FORMULA_PATH"
fi

# Re-scan the exact Formula/support bytes Homebrew will load and independently
# re-read every authoritative registry input. No Formula Ruby has run yet.
homebrew_native_contract_stage_marker tier2-execution-rescan starting
ruby "$KANDELO_ROOT/scripts/homebrew-formula-runtime-closure.rb" \
  "$TAPPED_TAP_ROOT" "$TAP_NAME" "$FORMULA" --tier2-bridge-json \
  >"$TIER2_EXECUTION_PLAN"
homebrew_native_contract_stage_marker tier2-execution-rescan completed
cmp -s "$TIER2_BRIDGE_PLAN" "$TIER2_EXECUTION_PLAN" || {
  echo "homebrew-bottle-build.sh: tapped Formula/support bridge plan differs from the reviewed source" >&2
  exit 1
}
homebrew_native_contract_stage_marker tier2-execution-preflight starting
"$XTASK_BIN" homebrew-tier2-preflight \
  --repo-root "$KANDELO_ROOT" --tap-root "$TAPPED_TAP_ROOT" --arch "$ARCH" \
  --bridge-plan "$TIER2_EXECUTION_PLAN" >"$TIER2_EXECUTION_ATTESTATION"
homebrew_native_contract_stage_marker tier2-execution-preflight completed
cmp -s "$TIER2_ATTESTATION" "$TIER2_EXECUTION_ATTESTATION" || {
  echo "homebrew-bottle-build.sh: Formula/support/registry execution inputs changed before isolation" >&2
  exit 1
}
homebrew_native_contract_stage_marker tier2-attestation-staging starting
homebrew_patched_launcher_stage_tier2_attestation \
  "$TIER2_EXECUTION_ATTESTATION"
homebrew_native_contract_stage_marker tier2-attestation-staging completed

if [ -z "$BUILD_USER" ]; then
  # Candidate jobs are deliberately uncredentialed and do not provision the
  # production-only secondary Formula identity. Seal the exact tapped checkout
  # before any Homebrew Formula evaluation so the publisher patch observes the
  # same read-only source contract; cleanup restores owner write permission
  # only after every Brew command has finished.
  chmod -R a-w -- "$TAPPED_TAP_ROOT"
  CANDIDATE_TAP_SEALED=1
  [ ! -w "$TAPPED_TAP_ROOT" ] || {
    echo "homebrew-bottle-build.sh: candidate primary tap checkout remains writable" >&2
    exit 2
  }
fi

if [ -n "$BUILD_USER" ]; then
  # Formula helpers deliberately remove stale compiled host output before
  # loading TypeScript sources. Do that while the workflow identity still owns
  # the checkout; the isolated build identity receives no source write access.
  rm -rf "$KANDELO_ROOT/host/dist"
  homebrew_native_contract_stage_marker formula-realm-isolation starting
  homebrew_patched_launcher_isolate "$BUILD_USER" \
    "$WORK_DIR" "$KANDELO_ROOT" "$TAP_ROOT" "$OUT_DIR" "$KANDELO_ROOT" \
    "${DEPENDENCY_TAP_ROOTS[@]}"
  homebrew_native_contract_stage_marker formula-realm-isolation completed
  BREW_BIN="$HOMEBREW_PATCHED_BREW_BIN"
fi

run_brew_logged() {
  local status
  set +e
  "$@" 2>&1 | tee -a "$INSTALL_LOG"
  status="${PIPESTATUS[0]}"
  set -e
  return "$status"
}

run_native_brew_logged() {
  local status
  set +e
  homebrew_patched_launcher_run_native "$@" 2>&1 | tee -a "$NATIVE_INSTALL_LOG"
  status="${PIPESTATUS[0]}"
  set -e
  return "$status"
}

# Install each reviewed direct core tool in its own dependency-resolving command.
# A combined command can hold a top-level lock for a tool such as pkgconf while
# resolving another Formula whose dependency closure needs the same tool.
# Separate commands let each full closure finish before the next top-level lock
# is taken.
# Only the reviewed direct names are exposed to target Homebrew after the native
# tree has been sealed read-only.
homebrew_native_contract_stage_marker signed-native-contract starting
homebrew_native_contract_install \
  "$HOST_DEPENDENCY_LIST" "$CONTROL_DIR" "$NATIVE_INSTALL_LOG" \
  "$NATIVE_TEMP" "${HOMEBREW_BREW_COMMIT:-}" "$KANDELO_ROOT" \
  tap_formula_host_dependencies
homebrew_native_contract_stage_marker signed-native-contract completed
mapfile -t native_dependencies <"$HOST_DEPENDENCY_LIST"
for dependency in "${native_dependencies[@]}"; do
  native_info="$CONTROL_DIR/native-info-$dependency.json"
  : >"$native_info"
  chmod 0600 "$native_info"
  homebrew_native_contract_run_logged \
    installed-formula-metadata "$CONTROL_DIR" \
    "$NATIVE_INSTALL_LOG" "$native_info" \
    homebrew_patched_launcher_run_native info --json=v2 \
      "homebrew/core/$dependency"
  jq -e --arg name "$dependency" '
    (.formulae | length) == 1 and
    .formulae[0].name == $name and
    .formulae[0].full_name == $name and
    .formulae[0].tap == "homebrew/core" and
    (.formulae[0].installed | type == "array" and length > 0)
  ' "$native_info" >/dev/null || {
    echo "homebrew-bottle-build.sh: native Homebrew selected a non-canonical core Formula: $dependency" >&2
    exit 1
  }
done
homebrew_native_contract_verify_no_missing_dependencies \
  "$HOST_DEPENDENCY_LIST"

# Finish every native Homebrew command before target Formula Ruby is evaluated.
# The later dependency query sees the native tree read-only and cannot plant
# configuration or state for a subsequent native invocation.
# `brew install --build-bottle` forces only the selected formula to build from
# source. Preserve the runtime-only locked-tap closure for published
# provenance, but separately resolve build and test dependencies so every
# target Formula is force-poured before the selected target is built.
filter_target_dependencies() {
  awk '
    NR == FNR { allowed[$0] = 1; next }
    NF {
      value = tolower($0)
      count = split(value, parts, "/")
      tap = parts[1] "/" parts[2]
      if (count == 3 && allowed[tap] && !seen[value]++) print value
    }
  ' "$ALLOWED_TARGET_TAPS" -
}

ruby "$KANDELO_ROOT/scripts/homebrew-formula-runtime-closure.rb" \
  "$TAP_ROOT" "$TAP_NAME" "$FORMULA" "$ARCH" |
  jq -r 'keys[]' >"$STATIC_RUNTIME_DEPENDENCIES"
"$BREW_BIN" deps --topological --full-name --formula "$FORMULA_REF" |
  filter_target_dependencies >"$DEPENDENCY_LIST"
if ! diff -u \
  <(LC_ALL=C sort -u "$STATIC_RUNTIME_DEPENDENCIES") \
  <(LC_ALL=C sort -u "$DEPENDENCY_LIST") >/dev/null; then
  echo "homebrew-bottle-build.sh: Homebrew runtime dependency graph differs from the static locked-tap graph" >&2
  diff -u \
    <(LC_ALL=C sort -u "$STATIC_RUNTIME_DEPENDENCIES") \
    <(LC_ALL=C sort -u "$DEPENDENCY_LIST") >&2 || true
  exit 1
fi
"$BREW_BIN" deps --topological --full-name --include-build --include-test \
  --formula "$FORMULA_REF" |
  filter_target_dependencies >"$BUILD_TEST_DEPENDENCY_LIST"
awk 'NF && !seen[$0]++ { print }' \
  "$DEPENDENCY_LIST" "$BUILD_TEST_DEPENDENCY_LIST" >"$DEPENDENCY_POUR_LIST"

validate_dependency_list "$DEPENDENCY_LIST" "runtime dependency list"
validate_dependency_list \
  "$BUILD_TEST_DEPENDENCY_LIST" "build/test dependency list"
validate_dependency_list "$DEPENDENCY_POUR_LIST" "dependency pour list"

LOCAL_DEPENDENCY_CACHE="${KANDELO_HOMEBREW_LOCAL_DEPENDENCY_CACHE:-}"
if [ -n "$LOCAL_DEPENDENCY_CACHE" ]; then
  if [ "${GITHUB_ACTIONS:-}" = true ] || [ ! -d "$LOCAL_DEPENDENCY_CACHE" ] ||
     [ -L "$LOCAL_DEPENDENCY_CACHE" ]; then
    echo "homebrew-bottle-build.sh: local dependency cache is restricted to a real non-CI directory" >&2
    exit 2
  fi
  LOCAL_DEPENDENCY_CACHE="$(cd "$LOCAL_DEPENDENCY_CACHE" && pwd -P)"
  LOCAL_DEPENDENCIES_JSON="$CONTROL_DIR/local-dependencies.json"
  ruby "$KANDELO_ROOT/scripts/homebrew-formula-runtime-closure.rb" \
    "$TAP_ROOT" "$TAP_NAME" "$FORMULA" "$ARCH" >"$LOCAL_DEPENDENCIES_JSON"
  while IFS= read -r dependency; do
    [ -n "$dependency" ] || continue
    dependency_sha="$(jq -er --arg dependency "$dependency" \
      '.[$dependency].sha256' "$LOCAL_DEPENDENCIES_JSON")"
    source_archive="$LOCAL_DEPENDENCY_CACHE/$dependency_sha.tar.gz"
    if [ ! -f "$source_archive" ] || [ -L "$source_archive" ] ||
       [ "$(sha256sum "$source_archive" | awk '{print $1}')" != "$dependency_sha" ]; then
      echo "homebrew-bottle-build.sh: local dependency cache lacks exact $dependency bottle $dependency_sha" >&2
      exit 1
    fi
    cache_archive="$(HOMEBREW_KANDELO_BOTTLE_TAG="$BOTTLE_TAG" \
      KANDELO_HOMEBREW_BOTTLE_TAG="$BOTTLE_TAG" \
      "$BREW_BIN" --cache --bottle-tag="$BOTTLE_TAG" --formula "$dependency")"
    case "$cache_archive" in
      "$HOMEBREW_CACHE"/*) ;;
      *)
        echo "homebrew-bottle-build.sh: Homebrew dependency cache path escapes its private cache" >&2
        exit 1
        ;;
    esac
    mkdir -p "$(dirname "$cache_archive")"
    cp "$source_archive" "$cache_archive"
    chmod 0444 "$cache_archive"
  done <"$DEPENDENCY_POUR_LIST"
fi

while IFS= read -r dependency; do
  [ -n "$dependency" ] || continue
  if [ "$dependency" = "$FORMULA" ] || \
     grep -Fx "$TAP_NAME/$dependency" "$DEPENDENCY_POUR_LIST" >/dev/null; then
    echo "homebrew-bottle-build.sh: native dependency collides with a target Formula: $dependency" >&2
    exit 2
  fi
done <"$HOST_DEPENDENCY_LIST"

homebrew_patched_launcher_seal_native_prefix
for dependency in "${native_dependencies[@]}"; do
  homebrew_patched_launcher_bridge_native_formula "$dependency"
  # Plain `list` constructs a Keg; `list --versions` only enumerates rack
  # entries and would accept the invalid rack-symlink shape this guards.
  if ! "$BREW_BIN" list --formula "$dependency" >/dev/null; then
    echo "homebrew-bottle-build.sh: target Homebrew rejected the native Formula proxy keg: $dependency" >&2
    exit 1
  fi
done

while IFS= read -r dependency; do
  [ -n "$dependency" ] || continue
  dependency_tap="${dependency%/*}"
  dependency_name="${dependency##*/}"
  if ! grep -Fx "$dependency_tap" "$ALLOWED_TARGET_TAPS" >/dev/null || \
     ! [[ "$dependency_name" =~ ^[a-z0-9][a-z0-9._-]*$ ]]; then
    echo "homebrew-bottle-build.sh: invalid locked-tap dependency: $dependency" >&2
    exit 2
  fi
  run_brew_logged run_brew_for_kandelo_bottles "$BREW_BIN" install \
    --force-bottle \
    --as-dependency \
    --ignore-dependencies \
    --formula "$dependency"
done <"$DEPENDENCY_POUR_LIST"

# WHY: Homebrew's human-readable progress output is not a stable provenance
# API. Its concurrent downloader may print only a checkmark even though it
# fetched and verified a bottle. Before untrusted Formula code runs, resolve
# every runtime dependency's machine-readable cache path and hash the exact
# regular file that Homebrew retained. The control directory is hidden from
# each isolated Brew command, so the later Formula cannot rewrite this record.
dependency_cache_args=(
  capture-cache
  --brew-bin "$BREW_BIN"
  --tap-root "$TAP_ROOT"
  --tap-repository "$TAP_REPOSITORY"
  --tap-name "$TAP_NAME"
  --tap-commit "$TAP_COMMIT"
  --tap-checkout-commit "$TAP_CHECKOUT_COMMIT"
  --formula "$FORMULA"
  --arch "$ARCH"
  --bottle-root-url "$DEPENDENCY_BOTTLE_ROOT_URL"
  --expected-dependencies "$DEPENDENCY_LIST"
  --cache-root "$HOMEBREW_CACHE"
  --out "$DEPENDENCY_CACHE_EVIDENCE"
)
dependency_cache_args+=("${DEPENDENCY_PROVENANCE_SCOPE_ARGS[@]}")
if [ -n "$HOMEBREW_GUEST_LAYOUT_SHA256" ]; then
  dependency_cache_args+=(
    --prefix-campaign-layout-sha256 "$HOMEBREW_GUEST_LAYOUT_SHA256"
  )
fi
HOMEBREW_KANDELO_BOTTLE_TAG="$BOTTLE_TAG" \
KANDELO_HOMEBREW_BOTTLE_TAG="$BOTTLE_TAG" \
  python3 "$KANDELO_ROOT/scripts/homebrew-dependency-provenance.py" \
    "${dependency_cache_args[@]}"

# WHY: dependency bottles are installed after the isolation boundary is
# prepared. Seal the complete poured dependency set now, before selected
# Formula Ruby can invoke its tap recipe, so the recipe supervisor never
# accepts build-user-owned or writable dependency kegs.
if [ -n "$BUILD_USER" ]; then
  homebrew_patched_launcher_seal_target_dependencies \
    "$BUILD_USER" "$HOMEBREW_PATCHED_SUDO_BIN"
fi

brew_install_build_bottle() {
  local attempt status log
  status=1
  for attempt in 1 2 3; do
    log="$CONTROL_DIR/brew-install-attempt-${attempt}.log"
    set +e
    "$BREW_BIN" install --build-bottle --ignore-dependencies \
      --formula "$FORMULA_REF" 2>&1 |
      tee "$log" |
      tee -a "$INSTALL_LOG"
    status="${PIPESTATUS[0]}"
    set -e
    if [ "$status" -eq 0 ]; then
      return 0
    fi
    if [ "$attempt" -lt 3 ] && grep -Eq 'has already locked .*\.incomplete' "$log"; then
      echo "homebrew-bottle-build.sh: brew install hit a Homebrew download lock; retrying attempt $((attempt + 1))/3" >&2
      sleep $((attempt * 20))
      continue
    fi
    return "$status"
  done
  return "$status"
}

(
  cd "$WORK_DIR"
  brew_install_build_bottle
  homebrew_patched_launcher_snapshot_target_cellar_layout \
    >"$TARGET_CELLAR_BEFORE_TEST"
  "$BREW_BIN" test "$FORMULA_REF"
  run_brew_for_kandelo_bottles "$BREW_BIN" bottle \
    --json --keep-old --root-url "$BOTTLE_ROOT_URL" "$FORMULA_REF"
  homebrew_patched_launcher_snapshot_target_cellar_layout \
    >"$TARGET_CELLAR_AFTER_TEST"
  if ! cmp -s "$TARGET_CELLAR_BEFORE_TEST" "$TARGET_CELLAR_AFTER_TEST"; then
    echo "homebrew-bottle-build.sh: Formula test or bottle creation changed the planned target Cellar" >&2
    diff -u "$TARGET_CELLAR_BEFORE_TEST" "$TARGET_CELLAR_AFTER_TEST" >&2 || true
    exit 1
  fi
)

TARGET_PREFIX="$(homebrew_patched_launcher_resolve_installed_formula_keg \
  "$BREW_BIN" "$FORMULA_REF" "$FORMULA")"
dependency_provenance_args=(
  capture
  --brew-bin "$BREW_BIN" \
  --tap-root "$TAP_ROOT" \
  --tap-repository "$TAP_REPOSITORY" \
  --tap-name "$TAP_NAME" \
  --tap-commit "$TAP_COMMIT" \
  --tap-checkout-commit "$TAP_CHECKOUT_COMMIT" \
  --formula "$FORMULA" \
  --arch "$ARCH" \
  --bottle-root-url "$DEPENDENCY_BOTTLE_ROOT_URL" \
  --target-receipt "$TARGET_PREFIX/INSTALL_RECEIPT.json" \
  --expected-dependencies "$DEPENDENCY_LIST" \
  --install-log "$INSTALL_LOG" \
  --cache-evidence "$DEPENDENCY_CACHE_EVIDENCE" \
  --out "$DEPENDENCY_PROVENANCE"
)
dependency_provenance_args+=("${DEPENDENCY_PROVENANCE_SCOPE_ARGS[@]}")
if [ -n "$HOMEBREW_GUEST_LAYOUT_SHA256" ]; then
  dependency_provenance_args+=(
    --prefix-campaign-layout-sha256 "$HOMEBREW_GUEST_LAYOUT_SHA256"
  )
fi
python3 "$KANDELO_ROOT/scripts/homebrew-dependency-provenance.py" \
  "${dependency_provenance_args[@]}"

retain_local_ruby_build_evidence() {
  [ -n "$LOCAL_BUILD_EVIDENCE" ] || return 0
  [ "$FORMULA" = "ruby" ] || {
    echo "homebrew-bottle-build.sh: local build evidence is supported only for ruby" >&2
    return 2
  }

  local config_h="" config_log="" process_c="" instrumented_ruby=""
  local runtime_archive="" runtime_archive_sha256=""
  local candidate candidate_sha256 search_dir installed_ruby_sha256
  while IFS= read -r candidate; do
    if grep -Eq '^#define HAVE_VFORK 1$' "$candidate" &&
       grep -Eq '^#define HAVE_WORKING_VFORK 1$' "$candidate" &&
       grep -Eq '^#define HAVE_WORKING_FORK 1$' "$candidate"; then
      config_h="$candidate"
      break
    fi
  done < <(find -P "$NATIVE_BASE" "$WORK_DIR" -type f -name config.h -print | LC_ALL=C sort)
  [ -n "$config_h" ] || {
    echo "homebrew-bottle-build.sh: retained Ruby target config.h is unavailable" >&2
    return 1
  }

  search_dir="$(dirname "$config_h")"
  while [ "$search_dir" != "/" ] && [ "$search_dir" != "$NATIVE_BASE" ]; do
    if [ -f "$search_dir/config.log" ]; then
      config_log="$search_dir/config.log"
      break
    fi
    search_dir="$(dirname "$search_dir")"
  done
  if [ -z "$config_log" ]; then
    while IFS= read -r candidate; do
      if grep -F 'wasm32-unknown-none' "$candidate" >/dev/null; then
        config_log="$candidate"
        break
      fi
    done < <(find -P "$NATIVE_BASE" "$WORK_DIR" -type f -name config.log -print | LC_ALL=C sort)
  fi
  [ -n "$config_log" ] && [ -f "$config_log" ] || {
    echo "homebrew-bottle-build.sh: retained Ruby configure transcript is unavailable" >&2
    return 1
  }

  while IFS= read -r candidate; do
    if [ "$(sha256sum "$candidate" | awk '{print $1}')" = \
      "39286bbe88bc5e8627f91ac780aa00403052cb1f700c2f25b5407b7af807e608" ]; then
      process_c="$candidate"
      break
    fi
  done < <(find -P "$NATIVE_BASE" "$WORK_DIR" -type f -name process.c -print | LC_ALL=C sort)
  [ -n "$process_c" ] || {
    echo "homebrew-bottle-build.sh: pristine Ruby process.c build input is unavailable" >&2
    return 1
  }

  [ -f "$TARGET_PREFIX/bin/ruby" ] || {
    echo "homebrew-bottle-build.sh: installed Ruby executable is unavailable" >&2
    return 1
  }
  installed_ruby_sha256="$(sha256sum "$TARGET_PREFIX/bin/ruby" | awk '{print $1}')"
  while IFS= read -r candidate; do
    if [ "$(sha256sum "$candidate" | awk '{print $1}')" = "$installed_ruby_sha256" ]; then
      instrumented_ruby="$candidate"
      break
    fi
  done < <(find -P "$NATIVE_BASE" "$WORK_DIR" -type f -name ruby.wasm -print | LC_ALL=C sort)
  [ -n "$instrumented_ruby" ] || {
    echo "homebrew-bottle-build.sh: installed Ruby differs from the transformed recipe output" >&2
    return 1
  }

  while IFS= read -r candidate; do
    candidate_sha256="$(sha256sum "$candidate" | awk '{print $1}')"
    if [ -z "$runtime_archive" ]; then
      runtime_archive="$candidate"
      runtime_archive_sha256="$candidate_sha256"
    elif [ "$candidate_sha256" != "$runtime_archive_sha256" ]; then
      echo "homebrew-bottle-build.sh: Ruby build retained multiple runtime archive identities" >&2
      return 1
    fi
  done < <(find -P "$NATIVE_BASE" "$WORK_DIR" -type f -name ruby-runtime.zip -print | LC_ALL=C sort -u)
  [ -n "$runtime_archive" ] || {
    echo "homebrew-bottle-build.sh: Ruby runtime archive is unavailable" >&2
    return 1
  }

  mkdir -m 0700 "$LOCAL_BUILD_EVIDENCE"
  cp -p "$config_h" "$LOCAL_BUILD_EVIDENCE/config.h"
  cp -p "$config_log" "$LOCAL_BUILD_EVIDENCE/config.log"
  cp -p "$process_c" "$LOCAL_BUILD_EVIDENCE/process.c"
  cp -p "$instrumented_ruby" "$LOCAL_BUILD_EVIDENCE/instrumented-ruby.wasm"
  cp -p "$runtime_archive" "$LOCAL_BUILD_EVIDENCE/ruby-runtime.zip"
  cp -p "$INSTALL_LOG" "$LOCAL_BUILD_EVIDENCE/homebrew-install.log"
  {
    printf 'schema=1\n'
    printf 'provenance_kind=local-test\n'
    printf 'promotable=false\n'
    printf 'published=false\n'
    printf 'process_c_sha256=39286bbe88bc5e8627f91ac780aa00403052cb1f700c2f25b5407b7af807e608\n'
    printf 'instrumented_ruby_sha256=%s\n' "$installed_ruby_sha256"
    printf 'runtime_archive_sha256=%s\n' "$runtime_archive_sha256"
  } >"$LOCAL_BUILD_EVIDENCE/identity.env"
  chmod 0600 "$LOCAL_BUILD_EVIDENCE"/*
}

retain_local_ruby_build_evidence

RETIRE_BOTTLE_SHA256=""
RETIRE_BOTTLE_JSON_SHA256=""
if [ "$RETIRE_SOURCE_INSTALL" = true ]; then
  mapfile -t retire_bottle_jsons < <(
    find "$WORK_DIR" -maxdepth 1 -type f -name '*.bottle.json' -print | sort
  )
  mapfile -t retire_bottle_archives < <(
    find "$WORK_DIR" -maxdepth 1 -type f -name '*.bottle*.tar.gz' -print | sort
  )
  [ "${#retire_bottle_jsons[@]}" -eq 1 ] &&
    [ "${#retire_bottle_archives[@]}" -eq 1 ] || {
    echo "homebrew-bottle-build.sh: local batch retirement requires one exact bottle JSON and archive" >&2
    exit 1
  }
  RETIRE_BOTTLE_JSON="${retire_bottle_jsons[0]}"
  RETIRE_BOTTLE_ARCHIVE="${retire_bottle_archives[0]}"
  RETIRE_PKG_VERSION="${TARGET_PREFIX##*/}"
  RETIRE_RECEIPT="$TARGET_PREFIX/INSTALL_RECEIPT.json"
  [ "$TARGET_PREFIX" = \
      "$HOMEBREW_PATCHED_PREFIX/Cellar/$FORMULA/$RETIRE_PKG_VERSION" ] &&
    [[ "$RETIRE_PKG_VERSION" =~ ^[A-Za-z0-9][A-Za-z0-9._+,-]{0,255}$ ]] || {
    echo "homebrew-bottle-build.sh: source-built target prefix is not canonical" >&2
    exit 1
  }
  jq -e --arg tap "$TAP_NAME" --arg tap_commit "$TAP_CHECKOUT_COMMIT" '
    .built_as_bottle == true and
    .poured_from_bottle == false and
    .source.tap == $tap and
    .source.tap_git_head == $tap_commit
  ' "$RETIRE_RECEIPT" >/dev/null || {
    echo "homebrew-bottle-build.sh: local batch retirement requires the exact source-built target receipt" >&2
    exit 1
  }
  RETIRE_BOTTLE_SHA256="$(homebrew_sha256_stream <"$RETIRE_BOTTLE_ARCHIVE")"
  RETIRE_BOTTLE_JSON_SHA256="$(homebrew_sha256_stream <"$RETIRE_BOTTLE_JSON")"
  homebrew_patched_launcher_retire_source_target \
    "$BREW_BIN" "$FORMULA_REF" "$FORMULA" "$RETIRE_PKG_VERSION" \
    "$RETIRE_BOTTLE_ARCHIVE" "$RETIRE_BOTTLE_JSON" "$RETIRE_RECEIPT"
fi

if [ -n "$BUILD_USER" ]; then
  homebrew_patched_launcher_teardown "$BUILD_USER"
  homebrew_patched_launcher_verify_isolation
fi

if [ "$RETIRE_SOURCE_INSTALL" = true ]; then
  [ "$(homebrew_sha256_stream <"$RETIRE_BOTTLE_ARCHIVE")" = \
      "$RETIRE_BOTTLE_SHA256" ] &&
    [ "$(homebrew_sha256_stream <"$RETIRE_BOTTLE_JSON")" = \
      "$RETIRE_BOTTLE_JSON_SHA256" ] || {
    echo "homebrew-bottle-build.sh: protected retirement changed canonical bottle artifacts" >&2
    exit 1
  }
fi

mapfile -t bottle_jsons < <(find "$WORK_DIR" -maxdepth 1 -type f -name '*.bottle.json' -print | sort)

if [ "${#bottle_jsons[@]}" -ne 1 ]; then
  echo "homebrew-bottle-build.sh: expected exactly one .bottle.json, found ${#bottle_jsons[@]}" >&2
  exit 1
fi

BOTTLE_SOURCE_JSON="${bottle_jsons[0]}"
FORMULA_KEY="${TAP_NAME}/${FORMULA}"
if ! jq -e \
  --arg formula_key "$FORMULA_KEY" \
  --arg formula "$FORMULA" \
  --arg bottle_tag "$BOTTLE_TAG" '
    type == "object" and length == 1 and
    to_entries[0].key == $formula_key and
    (to_entries[0].value.formula | type == "object") and
    to_entries[0].value.formula.name == $formula and
    (to_entries[0].value.formula.pkg_version |
      type == "string" and test("^[A-Za-z0-9][A-Za-z0-9._+,-]{0,255}$")) and
    (to_entries[0].value.bottle | type == "object") and
    (to_entries[0].value.bottle.rebuild |
      type == "number" and . >= 0 and floor == .) and
    (to_entries[0].value.bottle.tags | type == "object" and keys == [$bottle_tag]) and
    (to_entries[0].value.bottle.tags[$bottle_tag].local_filename | type == "string")
  ' "$BOTTLE_SOURCE_JSON" >/dev/null; then
  echo "homebrew-bottle-build.sh: bottle JSON does not identify one canonical Formula bottle output" >&2
  exit 1
fi

PKG_VERSION="$(jq -r --arg key "$FORMULA_KEY" '.[$key].formula.pkg_version' "$BOTTLE_SOURCE_JSON")"
if jq -e '.schema == 3' "$TIER2_ATTESTATION" >/dev/null &&
   [ "$PKG_VERSION" != "$(jq -r '.tap_recipe.pkg_version' "$TIER2_ATTESTATION")" ]; then
  echo "homebrew-bottle-build.sh: bottle pkg_version differs from the sealed tap recipe attestation" >&2
  exit 1
fi
BOTTLE_REBUILD="$(jq -r --arg key "$FORMULA_KEY" '.[$key].bottle.rebuild' "$BOTTLE_SOURCE_JSON")"
if [ "$BOTTLE_REBUILD" != "$EXPECTED_BOTTLE_REBUILD" ]; then
  echo "homebrew-bottle-build.sh: Homebrew bottle rebuild $BOTTLE_REBUILD differs from planned Formula rebuild $EXPECTED_BOTTLE_REBUILD" >&2
  exit 1
fi
BOTTLE_REBUILD_SUFFIX=""
if [ "$BOTTLE_REBUILD" != "0" ]; then
  BOTTLE_REBUILD_SUFFIX=".$BOTTLE_REBUILD"
fi
EXPECTED_BOTTLE_FILENAME="${FORMULA}--${PKG_VERSION}.${BOTTLE_TAG}.bottle${BOTTLE_REBUILD_SUFFIX}.tar.gz"
if ! jq -e \
  --arg key "$FORMULA_KEY" \
  --arg tag "$BOTTLE_TAG" \
  --arg expected "$EXPECTED_BOTTLE_FILENAME" \
  '.[$key].bottle.tags[$tag].local_filename == $expected' \
  "$BOTTLE_SOURCE_JSON" >/dev/null; then
  echo "homebrew-bottle-build.sh: bottle JSON local filename does not match $EXPECTED_BOTTLE_FILENAME" >&2
  exit 1
fi
BOTTLE_LOCAL_FILENAME="$EXPECTED_BOTTLE_FILENAME"

# Rebuild bottles insert their rebuild number between `.bottle` and `.tar.gz`.
# Discover that bounded family, then let the raw JSON's canonical filename pick
# the only archive that may leave the build realm.
mapfile -t bottle_archives < <(find "$WORK_DIR" -maxdepth 1 -type f -name '*.bottle*.tar.gz' -print | sort)
if [ "${#bottle_archives[@]}" -ne 1 ]; then
  echo "homebrew-bottle-build.sh: expected exactly one bottle archive, found ${#bottle_archives[@]}" >&2
  exit 1
fi
if [ "$(basename "${bottle_archives[0]}")" != "$BOTTLE_LOCAL_FILENAME" ]; then
  echo "homebrew-bottle-build.sh: bottle archive does not match JSON local filename $BOTTLE_LOCAL_FILENAME" >&2
  exit 1
fi

cp -p "$BOTTLE_SOURCE_JSON" "$OUT_DIR/bottles/"
cp -p "${bottle_archives[0]}" "$OUT_DIR/bottles/"

BOTTLE_JSON="$OUT_DIR/bottles/$(basename "$BOTTLE_SOURCE_JSON")"
BOTTLE_ARCHIVE="$OUT_DIR/bottles/$(basename "${bottle_archives[0]}")"

{
  printf 'FORMULA=%q\n' "$FORMULA"
  printf 'ARCH=%q\n' "$ARCH"
  printf 'BOTTLE_JSON=%q\n' "$BOTTLE_JSON"
  printf 'BOTTLE_ARCHIVE=%q\n' "$BOTTLE_ARCHIVE"
  printf 'DEPENDENCY_PROVENANCE=%q\n' "$DEPENDENCY_PROVENANCE"
  printf 'BOTTLE_ROOT_URL=%q\n' "$BOTTLE_ROOT_URL"
  printf 'NATIVE_BUILD_ROOT=%q\n' "$NATIVE_BUILD_ROOT"
} >"$OUT_DIR/build.env"

echo "homebrew-bottle-build.sh: built $BOTTLE_ARCHIVE"
