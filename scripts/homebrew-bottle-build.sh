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
BUILD_USER="${KANDELO_HOMEBREW_BUILD_USER:-}"
SHARED_TEMP="${KANDELO_HOMEBREW_SHARED_TEMP:-}"

usage() {
  cat >&2 <<'EOF'
usage: scripts/homebrew-bottle-build.sh --tap-root <tap-root> [--tap-repository <owner/repo>] [--tap-name <owner/name>] --formula <name> --arch <wasm32|wasm64> --out <dir> --bottle-root-url <url>

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
TAP_NAME="$(homebrew_resolve_tap_name "$TAP_REPOSITORY" "$TAP_NAME_INPUT")"
EXPECTED_BOTTLE_ROOT_URL="$(homebrew_bottle_root_url "$TAP_REPOSITORY" "$TAP_NAME")"
if [ "$BOTTLE_ROOT_URL" != "$EXPECTED_BOTTLE_ROOT_URL" ]; then
  echo "homebrew-bottle-build.sh: bottle root URL does not match the tap repository package root" >&2
  exit 2
fi
PATCH_FILE="$KANDELO_ROOT/homebrew/patches/0001-add-kandelo-wasm-bottle-tags.patch"
PUBLISHER_ISOLATION_PATCH_FILE="$KANDELO_ROOT/homebrew/patches/0002-support-isolated-publisher.patch"
. "$KANDELO_ROOT/scripts/homebrew-patched-launcher.sh"
homebrew_patched_launcher_select_host_git
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

cleanup() {
  local original_status="${1:-0}" launcher_status=0
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
ruby "$KANDELO_ROOT/scripts/homebrew-formula-runtime-closure.rb" \
  "$TAP_ROOT" "$TAP_NAME" "$FORMULA" --tier2-bridge-json \
  >"$TIER2_BRIDGE_PLAN"
"$XTASK_BIN" homebrew-tier2-preflight \
  --repo-root "$KANDELO_ROOT" --arch "$ARCH" \
  --bridge-plan "$TIER2_BRIDGE_PLAN" >"$TIER2_ATTESTATION"
if ! jq -e --arg tap "$EXPECTED_PLAN_TAP" --arg formula "$FORMULA" \
  --arg arch "$ARCH" '
    keys == ["arch", "formula", "formula_sha256", "full_name", "schema", "support_sha256", "tap", "tier2_bridge"] and
    .schema == 1 and .tap == $tap and .formula == $formula and .arch == $arch and
    .full_name == ($tap + "/" + $formula) and
    (.formula_sha256 | type == "string" and test("^[0-9a-f]{64}$")) and
    (.support_sha256 == null or
      (.support_sha256 | type == "string" and test("^[0-9a-f]{64}$"))) and
    if .tier2_bridge == null then true else
      (.tier2_bridge | keys == ["build_toml_sha256", "package", "package_toml_sha256", "script", "script_env_keys", "script_sha256", "source_mode", "source_sha256", "source_url", "version"]) and
      (.tier2_bridge.package | type == "string" and test("^[a-z0-9][a-z0-9._-]{0,254}$")) and
      (.tier2_bridge.script | type == "string" and test("^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$")) and
      ([.tier2_bridge.package_toml_sha256, .tier2_bridge.build_toml_sha256,
        .tier2_bridge.script_sha256, .tier2_bridge.source_sha256] |
        all(.[]; type == "string" and test("^[0-9a-f]{64}$"))) and
      (.tier2_bridge.script_env_keys | type == "array" and
        . == (sort | unique) and length <= 64 and
        (map(length) | add // 0) <= 4096) and
      (.tier2_bridge.source_mode == "exact" or
        .tier2_bridge.source_mode == "in-repository-source") and
      (.tier2_bridge.source_url | type == "string" and startswith("https://")) and
      (.tier2_bridge.version | type == "string" and length > 0)
    end
  ' "$TIER2_ATTESTATION" >/dev/null; then
  echo "homebrew-bottle-build.sh: Tier-2 bridge attestation has an invalid schema" >&2
  exit 2
fi
ruby "$KANDELO_ROOT/scripts/homebrew-formula-runtime-closure.rb" \
  "$TAP_ROOT" "$TAP_NAME" "$FORMULA" --bottle-identity-json \
  >"$TARGET_BOTTLE_IDENTITY"
[ "$(wc -c <"$TARGET_BOTTLE_IDENTITY" | tr -d '[:space:]')" -le 4096 ] || {
  echo "homebrew-bottle-build.sh: target bottle identity exceeds the size limit" >&2
  exit 2
}
if ! jq -e --arg tap "$EXPECTED_PLAN_TAP" --arg formula "$FORMULA" \
  --arg root "$BOTTLE_ROOT_URL" '
    keys == ["bottle", "formula", "full_name", "schema", "tap"] and
    .schema == 1 and
    .tap == $tap and
    .formula == $formula and
    .full_name == ($tap + "/" + $formula) and
    (.bottle | keys == ["rebuild", "root_url"]) and
    (.bottle.rebuild | type == "number" and . >= 0 and floor == .) and
    (.bottle.root_url == null or .bottle.root_url == $root)
  ' "$TARGET_BOTTLE_IDENTITY" >/dev/null; then
  echo "homebrew-bottle-build.sh: planned Formula bottle identity is invalid or uses a different root URL" >&2
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
jq -e --arg tap "$EXPECTED_PLAN_TAP" --arg formula "$FORMULA" \
  --slurpfile resolved "$KANDELO_HOMEBREW_RESOLVED_TAPS_FILE" '
  keys == ["build", "build_and_test", "formula", "full_name", "runtime_and_test", "schema", "tap", "target_taps"] and
  .schema == 3 and
  .tap == $tap and
  .formula == $formula and
  .full_name == ($tap + "/" + $formula) and
  (.build | type == "array") and
  (.build_and_test | type == "array") and
  (.runtime_and_test | type == "array") and
  (.build == (.build | sort | unique)) and
  (.build_and_test == (.build_and_test | sort | unique)) and
  (.runtime_and_test == (.runtime_and_test | sort | unique)) and
  (.target_taps == (
    [$resolved[0].primary, $resolved[0].dependencies[]] |
    map({tap_name, tap_repository, tap_commit}) | sort_by(.tap_name)
  )) and
  (.target_taps | all(.[];
    keys == ["tap_commit", "tap_name", "tap_repository"] and
    (.tap_name | type == "string" and test("^[a-z0-9._-]+/[a-z0-9._-]+$")) and
    (.tap_repository | type == "string" and test("^[a-z0-9._-]+/homebrew-[a-z0-9._-]+$")) and
    (.tap_commit | type == "string" and test("^[0-9a-f]{40}$"))
  )) and
  (.target_taps | map(.tap_name) | index($tap) != null) and
  ((.build - .build_and_test) | length) == 0 and
  ((.runtime_and_test - .build_and_test) | length) == 0 and
  all(.build[]; type == "string" and test("^[a-z0-9][a-z0-9@+_.-]*$")) and
  all(.build_and_test[]; type == "string" and test("^[a-z0-9][a-z0-9@+_.-]*$")) and
  all(.runtime_and_test[]; type == "string" and test("^[a-z0-9][a-z0-9@+_.-]*$"))
' "$HOST_DEPENDENCY_PLAN" >/dev/null || {
  echo "homebrew-bottle-build.sh: invalid static host dependency plan" >&2
  exit 2
}
jq -r '.build_and_test[]' "$HOST_DEPENDENCY_PLAN" >"$HOST_DEPENDENCY_LIST"
validate_dependency_list "$HOST_DEPENDENCY_LIST" "host dependency list"
homebrew_patched_launcher_stage_dependency_plan "$HOST_DEPENDENCY_PLAN"

TAP_COMMIT="$(git -C "$TAP_ROOT" rev-parse HEAD)"
"$BREW_BIN" tap "$TAP_NAME" "$TAP_ROOT"
TAPPED_TAP_ROOT="$("$BREW_BIN" --repository "$TAP_NAME")"
TAPPED_TAP_ROOT="$(cd "$TAPPED_TAP_ROOT" && pwd -P)"
[ "$TAPPED_TAP_ROOT" != "$TAP_ROOT" ] && \
  [ "$(git -C "$TAPPED_TAP_ROOT" rev-parse HEAD)" = "$TAP_COMMIT" ] && \
  [ -z "$(git -C "$TAPPED_TAP_ROOT" status --short --untracked-files=all)" ] || {
  echo "homebrew-bottle-build.sh: Homebrew did not clone the planned tap commit cleanly" >&2
  exit 1
}
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
    "$BREW_BIN" tap "$dependency_tap" "$dependency_root"
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
ruby "$KANDELO_ROOT/scripts/homebrew-formula-runtime-closure.rb" \
  "$TAPPED_TAP_ROOT" "$TAP_NAME" "$FORMULA" --tier2-bridge-json \
  >"$TIER2_EXECUTION_PLAN"
cmp -s "$TIER2_BRIDGE_PLAN" "$TIER2_EXECUTION_PLAN" || {
  echo "homebrew-bottle-build.sh: tapped Formula/support bridge plan differs from the reviewed source" >&2
  exit 1
}
"$XTASK_BIN" homebrew-tier2-preflight \
  --repo-root "$KANDELO_ROOT" --arch "$ARCH" \
  --bridge-plan "$TIER2_EXECUTION_PLAN" >"$TIER2_EXECUTION_ATTESTATION"
cmp -s "$TIER2_ATTESTATION" "$TIER2_EXECUTION_ATTESTATION" || {
  echo "homebrew-bottle-build.sh: Formula/support/registry execution inputs changed before isolation" >&2
  exit 1
}
homebrew_patched_launcher_stage_tier2_attestation \
  "$TIER2_EXECUTION_ATTESTATION"

if [ -n "$BUILD_USER" ]; then
  # Formula helpers deliberately remove stale compiled host output before
  # loading TypeScript sources. Do that while the workflow identity still owns
  # the checkout; the isolated build identity receives no source write access.
  rm -rf "$KANDELO_ROOT/host/dist"
  homebrew_patched_launcher_isolate "$BUILD_USER" \
    "$WORK_DIR" "$KANDELO_ROOT" "$TAP_ROOT" "$OUT_DIR" "$KANDELO_ROOT" \
    "${DEPENDENCY_TAP_ROOTS[@]}"
  BREW_BIN="$HOMEBREW_PATCHED_BREW_BIN"
elif [ "${GITHUB_ACTIONS:-}" = "true" ]; then
  echo "homebrew-bottle-build.sh: CI Formula execution requires KANDELO_HOMEBREW_BUILD_USER" >&2
  exit 2
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
mapfile -t native_dependencies <"$HOST_DEPENDENCY_LIST"
for dependency in "${native_dependencies[@]}"; do
  run_native_brew_logged install --as-dependency --formula \
    "homebrew/core/$dependency"
done
for dependency in "${native_dependencies[@]}"; do
  native_info="$CONTROL_DIR/native-info-$dependency.json"
  : >"$native_info"
  chmod 0600 "$native_info"
  homebrew_patched_launcher_run_native info --json=v2 \
    "homebrew/core/$dependency" >"$native_info" 2>>"$NATIVE_INSTALL_LOG"
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
run_native_brew_logged missing

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

TARGET_PREFIX="$("$BREW_BIN" --prefix "$FORMULA_REF")"
python3 "$KANDELO_ROOT/scripts/homebrew-dependency-provenance.py" capture \
  --brew-bin "$BREW_BIN" \
  --tap-root "$TAP_ROOT" \
  --tap-repository "$TAP_REPOSITORY" \
  --tap-name "$TAP_NAME" \
  --tap-commit "$TAP_COMMIT" \
  --formula "$FORMULA" \
  --arch "$ARCH" \
  --bottle-root-url "$BOTTLE_ROOT_URL" \
  --target-receipt "$TARGET_PREFIX/INSTALL_RECEIPT.json" \
  --expected-dependencies "$DEPENDENCY_LIST" \
  --install-log "$INSTALL_LOG" \
  --out "$DEPENDENCY_PROVENANCE"

if [ -n "$BUILD_USER" ]; then
  homebrew_patched_launcher_teardown "$BUILD_USER"
  homebrew_patched_launcher_verify_isolation
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
