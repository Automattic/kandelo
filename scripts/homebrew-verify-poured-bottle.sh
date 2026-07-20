#!/usr/bin/env bash
# Force-pour and test one exact Kandelo bottle without publisher credentials.
set -euo pipefail

TAP_ROOT=""
TAP_REPOSITORY=""
TAP_NAME_INPUT=""
TAP_COMMIT=""
FORMULA=""
ARCH=""
ABI=""
BOTTLE=""
BOTTLE_JSON=""
BOTTLE_URL=""
BOTTLE_SHA256=""
BOTTLE_BYTES=""
BOTTLE_ROOT_URL=""
DEPENDENCY_PROVENANCE=""
SELECTION_RECEIPT=""
SYSROOT_BUILD_ROOT=""
OUT=""
BUILD_USER="${KANDELO_HOMEBREW_BUILD_USER:-}"
SHARED_TEMP="${KANDELO_HOMEBREW_SHARED_TEMP:-}"

usage() {
  cat >&2 <<'EOF'
usage: scripts/homebrew-verify-poured-bottle.sh --tap-root <dir> --tap-repository <owner/repo> [--tap-name <owner/name>] --tap-commit <sha> --formula <name> --arch <wasm32|wasm64> --abi <number> --bottle <archive> --bottle-json <json> --bottle-url <url> --bottle-sha256 <sha> --bottle-bytes <count> --bottle-root-url <url> --dependency-provenance <json> --selection-receipt <json> --sysroot-build-root <dir> --out <runtime-evidence.json>

The tap must already contain the reconstructed target bottle block. In CI all
Homebrew and Formula execution runs as the dedicated isolated workflow user.
For a real publication the verifier empties Homebrew's cache and runs the
reviewed Homebrew implementation with --force-bottle and no credentials, so
Homebrew itself must resolve, fetch, and pour the exact public bottle. A local
archive path is accepted only for the explicit dry-run mode.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --tap-root) TAP_ROOT="${2:-}"; shift 2 ;;
    --tap-repository) TAP_REPOSITORY="${2:-}"; shift 2 ;;
    --tap-name) TAP_NAME_INPUT="${2:-}"; shift 2 ;;
    --tap-commit) TAP_COMMIT="${2:-}"; shift 2 ;;
    --formula) FORMULA="${2:-}"; shift 2 ;;
    --arch) ARCH="${2:-}"; shift 2 ;;
    --abi) ABI="${2:-}"; shift 2 ;;
    --bottle) BOTTLE="${2:-}"; shift 2 ;;
    --bottle-json) BOTTLE_JSON="${2:-}"; shift 2 ;;
    --bottle-url) BOTTLE_URL="${2:-}"; shift 2 ;;
    --bottle-sha256) BOTTLE_SHA256="${2:-}"; shift 2 ;;
    --bottle-bytes) BOTTLE_BYTES="${2:-}"; shift 2 ;;
    --bottle-root-url) BOTTLE_ROOT_URL="${2:-}"; shift 2 ;;
    --dependency-provenance) DEPENDENCY_PROVENANCE="${2:-}"; shift 2 ;;
    --selection-receipt) SELECTION_RECEIPT="${2:-}"; shift 2 ;;
    --sysroot-build-root) SYSROOT_BUILD_ROOT="${2:-}"; shift 2 ;;
    --out) OUT="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "homebrew-verify-poured-bottle.sh: unknown flag $1" >&2; usage; exit 2 ;;
  esac
done

for name in TAP_ROOT TAP_REPOSITORY TAP_COMMIT FORMULA ARCH ABI BOTTLE BOTTLE_JSON \
  BOTTLE_URL BOTTLE_SHA256 BOTTLE_BYTES BOTTLE_ROOT_URL DEPENDENCY_PROVENANCE \
  SYSROOT_BUILD_ROOT OUT; do
  [ -n "${!name}" ] || {
    echo "homebrew-verify-poured-bottle.sh: $name is required" >&2
    exit 2
  }
done
[ -n "$SELECTION_RECEIPT" ] || {
  echo "homebrew-verify-poured-bottle.sh: SELECTION_RECEIPT is required" >&2
  exit 2
}

for secret_name in GH_TOKEN GITHUB_TOKEN HOMEBREW_GITHUB_API_TOKEN \
  HOMEBREW_GITHUB_PACKAGES_TOKEN HOMEBREW_DOCKER_REGISTRY_TOKEN; do
  [ -z "${!secret_name:-}" ] || {
    echo "homebrew-verify-poured-bottle.sh: verifier received $secret_name" >&2
    exit 2
  }
done

[[ "$TAP_REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || {
  echo "homebrew-verify-poured-bottle.sh: invalid tap repository" >&2; exit 2;
}
[[ "$TAP_COMMIT" =~ ^[0-9a-f]{40}$ ]] || {
  echo "homebrew-verify-poured-bottle.sh: invalid tap commit" >&2; exit 2;
}
[[ "$FORMULA" =~ ^[a-z0-9][a-z0-9._-]*$ ]] || {
  echo "homebrew-verify-poured-bottle.sh: invalid Formula name" >&2; exit 2;
}
case "$ARCH" in wasm32|wasm64) ;; *) echo "homebrew-verify-poured-bottle.sh: invalid arch" >&2; exit 2 ;; esac
[[ "$ABI" =~ ^[1-9][0-9]*$ ]] || {
  echo "homebrew-verify-poured-bottle.sh: invalid ABI" >&2; exit 2;
}
[[ "$BOTTLE_SHA256" =~ ^[0-9a-f]{64}$ ]] || {
  echo "homebrew-verify-poured-bottle.sh: invalid bottle sha256" >&2; exit 2;
}
[[ "$BOTTLE_BYTES" =~ ^[1-9][0-9]*$ ]] || {
  echo "homebrew-verify-poured-bottle.sh: invalid bottle byte count" >&2; exit 2;
}
[ -d "$SYSROOT_BUILD_ROOT" ] && [ ! -L "$SYSROOT_BUILD_ROOT" ] || {
  echo "homebrew-verify-poured-bottle.sh: sysroot build root must be a real directory" >&2
  exit 2
}
SYSROOT_BUILD_ROOT="$(cd "$SYSROOT_BUILD_ROOT" && pwd -P)"

TAP_ROOT="$(cd "$TAP_ROOT" && pwd -P)"
KANDELO_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
# shellcheck source=/dev/null
. "$KANDELO_ROOT/scripts/homebrew-tap-identity.sh"
TAP_NAME="$(homebrew_resolve_tap_name "$TAP_REPOSITORY" "$TAP_NAME_INPUT")"
BOTTLE_TAG="${ARCH}_kandelo"
for file in "$BOTTLE" "$BOTTLE_JSON" "$DEPENDENCY_PROVENANCE" "$SELECTION_RECEIPT"; do
  [ -f "$file" ] && [ ! -L "$file" ] || {
    echo "homebrew-verify-poured-bottle.sh: required input is not a regular file: $file" >&2
    exit 2
  }
done
if ! jq -e \
  --arg formula "$FORMULA" \
  --arg bottle_tag "$BOTTLE_TAG" \
  --arg bottle_root_url "$BOTTLE_ROOT_URL" \
  --arg sha256 "$BOTTLE_SHA256" '
    type == "object" and keys == [$formula] and
    (.[$formula].formula | type == "object") and
    .[$formula].formula.name == $formula and
    (.[$formula].formula.pkg_version |
      type == "string" and test("^[A-Za-z0-9][A-Za-z0-9._+,-]{0,255}$")) and
    (.[$formula].bottle | type == "object") and
    .[$formula].bottle.root_url == $bottle_root_url and
    (.[$formula].bottle.rebuild |
      type == "number" and . >= 0 and floor == .) and
    (.[$formula].bottle.tags | type == "object" and keys == [$bottle_tag]) and
    .[$formula].bottle.tags[$bottle_tag].sha256 == $sha256
  ' "$BOTTLE_JSON" >/dev/null; then
  echo "homebrew-verify-poured-bottle.sh: canonical bottle JSON does not match the selected bottle" >&2
  exit 2
fi
PKG_VERSION="$(jq -r --arg formula "$FORMULA" '.[$formula].formula.pkg_version' "$BOTTLE_JSON")"
BOTTLE_REBUILD="$(jq -r --arg formula "$FORMULA" '.[$formula].bottle.rebuild' "$BOTTLE_JSON")"
BOTTLE_REBUILD_SUFFIX=""
if [ "$BOTTLE_REBUILD" != "0" ]; then
  BOTTLE_REBUILD_SUFFIX=".$BOTTLE_REBUILD"
fi
EXPECTED_BOTTLE_FILENAME="${FORMULA}--${PKG_VERSION}.${BOTTLE_TAG}.bottle${BOTTLE_REBUILD_SUFFIX}.tar.gz"
if [ "$(basename "$BOTTLE")" != "$EXPECTED_BOTTLE_FILENAME" ]; then
  echo "homebrew-verify-poured-bottle.sh: selected bottle must use Homebrew filename $EXPECTED_BOTTLE_FILENAME" >&2
  exit 2
fi
[ "$(git -C "$TAP_ROOT" rev-parse HEAD)" = "$TAP_COMMIT" ] || {
  echo "homebrew-verify-poured-bottle.sh: tap HEAD differs from the planned commit" >&2
  exit 2
}
RECONSTRUCTED_FORMULA_RELATIVE="Formula/$FORMULA.rb"
[ -f "$TAP_ROOT/$RECONSTRUCTED_FORMULA_RELATIVE" ] && \
  [ ! -L "$TAP_ROOT/$RECONSTRUCTED_FORMULA_RELATIVE" ] || {
  echo "homebrew-verify-poured-bottle.sh: reconstructed Formula must be a regular file" >&2
  exit 2
}
mapfile -t source_tap_changes < <(
  git -C "$TAP_ROOT" status --short --untracked-files=all
)
[ "${#source_tap_changes[@]}" -eq 1 ] && \
  [ "${source_tap_changes[0]}" = " M $RECONSTRUCTED_FORMULA_RELATIVE" ] || {
  echo "homebrew-verify-poured-bottle.sh: reconstructed tap must change only $RECONSTRUCTED_FORMULA_RELATIVE" >&2
  exit 2
}
actual_sha="$(sha256sum "$BOTTLE" | awk '{print $1}')"
actual_bytes="$(wc -c <"$BOTTLE" | tr -d '[:space:]')"
[ "$actual_sha" = "$BOTTLE_SHA256" ] && [ "$actual_bytes" = "$BOTTLE_BYTES" ] || {
  echo "homebrew-verify-poured-bottle.sh: selected bottle bytes differ from the receipt" >&2
  exit 1
}
SELECTION_MODE="$(jq -er '.bottle.mode' "$SELECTION_RECEIPT")"
case "$SELECTION_MODE" in
  anonymous-public-readback|local-dry-run) ;;
  *) echo "homebrew-verify-poured-bottle.sh: invalid bottle selection mode" >&2; exit 2 ;;
esac

BREW_BIN="${HOMEBREW_BREW_FILE:-}"
[ -n "$BREW_BIN" ] && [ -x "$BREW_BIN" ] || {
  echo "homebrew-verify-poured-bottle.sh: HOMEBREW_BREW_FILE is required" >&2
  exit 2
}
PATCH_FILE="$KANDELO_ROOT/homebrew/patches/0001-add-kandelo-wasm-bottle-tags.patch"
PUBLISHER_ISOLATION_PATCH_FILE="$KANDELO_ROOT/homebrew/patches/0002-support-isolated-publisher.patch"
# shellcheck source=/dev/null
. "$KANDELO_ROOT/scripts/homebrew-patched-launcher.sh"

OUT_PARENT="$(dirname "$OUT")"
mkdir -p "$OUT_PARENT"
OUT_PARENT="$(cd "$OUT_PARENT" && pwd -P)"
OUT="$OUT_PARENT/$(basename "$OUT")"
chmod 0700 "$OUT_PARENT"
if [ -n "$BUILD_USER" ]; then
  [ -d "$SHARED_TEMP" ] && [ ! -L "$SHARED_TEMP" ] || {
    echo "homebrew-verify-poured-bottle.sh: isolated verification requires a real shared temp root" >&2
    exit 2
  }
  SHARED_TEMP="$(cd "$SHARED_TEMP" && pwd -P)"
  WORK_DIR="$(mktemp -d "$SHARED_TEMP/homebrew-verify.XXXXXX")"
else
  WORK_DIR="$(mktemp -d)"
fi
NATIVE_BASE="$(mktemp -d /tmp/k.XXXXXX)"
if [ -n "$BUILD_USER" ]; then
  chmod 0711 "$NATIVE_BASE"
fi
CONTROL_DIR="$(mktemp -d "$OUT_PARENT/.control.XXXXXX")"
chmod 0700 "$CONTROL_DIR"

cleanup() {
  local original_status="${1:-0}" launcher_status=0 realm_cleanup_status=0
  if homebrew_patched_launcher_cleanup; then
    :
  else
    launcher_status="$?"
  fi
  rm -rf "$CONTROL_DIR"
  if [ "$launcher_status" -ne 0 ]; then
    echo "homebrew-verify-poured-bottle.sh: preserving temporary Homebrew realms after cleanup failure" >&2
  elif [ -n "$BUILD_USER" ] && [ -n "${KANDELO_HOMEBREW_SUDO_BIN:-}" ]; then
    if "$KANDELO_HOMEBREW_SUDO_BIN" -n -- /usr/bin/rm -rf -- \
      "$NATIVE_BASE" "$WORK_DIR" >/dev/null 2>&1; then
      :
    else
      realm_cleanup_status="$?"
      echo "homebrew-verify-poured-bottle.sh: could not remove temporary Homebrew realms" >&2
    fi
  else
    if rm -rf "$NATIVE_BASE" "$WORK_DIR"; then
      :
    else
      realm_cleanup_status="$?"
      echo "homebrew-verify-poured-bottle.sh: could not remove temporary Homebrew realms" >&2
    fi
  fi
  [ "$original_status" -eq 0 ] || return "$original_status"
  [ "$launcher_status" -eq 0 ] || return "$launcher_status"
  return "$realm_cleanup_status"
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

FORMULA_REF="$TAP_NAME/$FORMULA"
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
export HOMEBREW_KANDELO_ABI="$ABI"
export HOMEBREW_KANDELO_NODE_RECEIPT_PATH="$WORK_DIR/node-execution-receipt.json"
rm -f "$HOMEBREW_KANDELO_NODE_RECEIPT_PATH"

homebrew_patched_launcher_seed_bundler_groups bottle formula_test

INSTALL_LOG="$CONTROL_DIR/install.log"
NATIVE_INSTALL_LOG="$CONTROL_DIR/native-install.log"
HOST_DEPENDENCY_PLAN="$CONTROL_DIR/host-dependencies.json"
HOST_DEPENDENCY_LIST="$CONTROL_DIR/host-dependencies.txt"
DEPENDENCY_LIST="$CONTROL_DIR/dependencies.txt"
TEST_DEPENDENCY_LIST="$CONTROL_DIR/test-dependencies.txt"
SAME_TAP_TEST_DEPENDENCY_LIST="$CONTROL_DIR/same-tap-test-dependencies.txt"
DEPENDENCY_POUR_LIST="$CONTROL_DIR/pour-dependencies.txt"
ALLOWED_TARGET_TAPS="$CONTROL_DIR/allowed-target-taps.txt"
STATIC_RUNTIME_DEPENDENCIES="$CONTROL_DIR/static-runtime-dependencies.txt"
FORMULA_INFO="$CONTROL_DIR/formula-info.json"
VERIFIED_DEPENDENCIES="$CONTROL_DIR/verified-dependency-provenance.json"
TARGET_CELLAR_BEFORE_TEST="$CONTROL_DIR/target-cellar-before-test.txt"
TARGET_CELLAR_AFTER_TEST="$CONTROL_DIR/target-cellar-after-test.txt"
: >"$INSTALL_LOG"
: >"$NATIVE_INSTALL_LOG"
: >"$HOST_DEPENDENCY_PLAN"
: >"$HOST_DEPENDENCY_LIST"
: >"$DEPENDENCY_LIST"
: >"$TEST_DEPENDENCY_LIST"
: >"$SAME_TAP_TEST_DEPENDENCY_LIST"
: >"$DEPENDENCY_POUR_LIST"
: >"$ALLOWED_TARGET_TAPS"
: >"$STATIC_RUNTIME_DEPENDENCIES"
: >"$TARGET_CELLAR_BEFORE_TEST"
: >"$TARGET_CELLAR_AFTER_TEST"
chmod 0600 "$INSTALL_LOG" "$NATIVE_INSTALL_LOG" \
  "$HOST_DEPENDENCY_PLAN" "$HOST_DEPENDENCY_LIST" "$DEPENDENCY_LIST" \
  "$TEST_DEPENDENCY_LIST" "$SAME_TAP_TEST_DEPENDENCY_LIST" \
  "$DEPENDENCY_POUR_LIST" "$ALLOWED_TARGET_TAPS" \
  "$STATIC_RUNTIME_DEPENDENCIES" "$TARGET_CELLAR_BEFORE_TEST" \
  "$TARGET_CELLAR_AFTER_TEST"

validate_dependency_list() {
  local path="$1" label="$2" bytes count
  bytes="$(wc -c <"$path" | tr -d '[:space:]')"
  count="$(awk 'NF { count++ } END { print count + 0 }' "$path")"
  if [ "$bytes" -gt 65536 ] || [ "$count" -gt 128 ]; then
    echo "homebrew-verify-poured-bottle.sh: $label exceeds the dependency limit" >&2
    exit 2
  fi
}

# Resolve native test/runtime tools statically before any Formula executes.
# Formula code can consume this bounded control input later, but cannot choose
# additional native packages or modify the plan.
EXPECTED_PLAN_TAP="$TAP_NAME"
[ -n "${KANDELO_HOMEBREW_RESOLVED_TAPS_FILE:-}" ] || {
  echo "homebrew-verify-poured-bottle.sh: immutable resolved tap map is required" >&2
  exit 2
}
ruby "$KANDELO_ROOT/scripts/homebrew-formula-runtime-closure.rb" \
  "$TAP_ROOT" "$TAP_NAME" "$FORMULA" --host-dependencies-json \
  >"$HOST_DEPENDENCY_PLAN"
[ "$(wc -c <"$HOST_DEPENDENCY_PLAN" | tr -d '[:space:]')" -le 65536 ] || {
  echo "homebrew-verify-poured-bottle.sh: host dependency plan exceeds the size limit" >&2
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
  echo "homebrew-verify-poured-bottle.sh: invalid static host dependency plan" >&2
  exit 2
}
jq -r '.runtime_and_test[]' "$HOST_DEPENDENCY_PLAN" >"$HOST_DEPENDENCY_LIST"
validate_dependency_list "$HOST_DEPENDENCY_LIST" "host dependency list"
homebrew_patched_launcher_stage_dependency_plan "$HOST_DEPENDENCY_PLAN"

"$BREW_BIN" tap "$TAP_NAME" "$TAP_ROOT"
printf '%s\n' "$TAP_NAME" >"$ALLOWED_TARGET_TAPS"
DEPENDENCY_TAP_ROOTS=()
if [ -n "${KANDELO_HOMEBREW_RESOLVED_TAPS_FILE:-}" ]; then
  while IFS=$'\t' read -r dependency_tap dependency_root dependency_commit; do
    [ -n "$dependency_tap" ] && [ -n "$dependency_root" ] && \
      [ -n "$dependency_commit" ] || {
      echo "homebrew-verify-poured-bottle.sh: resolved dependency tap is incomplete" >&2
      exit 2
    }
    "$BREW_BIN" tap "$dependency_tap" "$dependency_root"
    tapped_dependency_root="$("$BREW_BIN" --repository "$dependency_tap")"
    tapped_dependency_root="$(cd "$tapped_dependency_root" && pwd -P)"
    locked_dependency_root="$(cd "$dependency_root" && pwd -P)"
    [ "$tapped_dependency_root" != "$locked_dependency_root" ] && \
      [ "$(git -C "$tapped_dependency_root" rev-parse HEAD)" = "$dependency_commit" ] && \
      [ -z "$(git -C "$tapped_dependency_root" status --short --untracked-files=all)" ] || {
      echo "homebrew-verify-poured-bottle.sh: Homebrew did not clone dependency tap $dependency_tap at its locked commit cleanly" >&2
      exit 1
    }
    printf '%s\n' "$dependency_tap" >>"$ALLOWED_TARGET_TAPS"
    DEPENDENCY_TAP_ROOTS+=("$dependency_root")
  done < <(jq -er '.dependencies[] | [.tap_name, .root, .tap_commit] | @tsv' \
    "$KANDELO_HOMEBREW_RESOLVED_TAPS_FILE")
fi
LC_ALL=C sort -u -o "$ALLOWED_TARGET_TAPS" "$ALLOWED_TARGET_TAPS"
validate_dependency_list "$ALLOWED_TARGET_TAPS" "allowed target tap list"
"$BREW_BIN" trust --tap "$TAP_NAME"
if [ -n "${KANDELO_HOMEBREW_RESOLVED_TAPS_FILE:-}" ]; then
  while IFS= read -r dependency_tap; do
    [ "$dependency_tap" = "$TAP_NAME" ] || "$BREW_BIN" trust --tap "$dependency_tap"
  done <"$ALLOWED_TARGET_TAPS"
fi
TAPPED_TAP_ROOT="$("$BREW_BIN" --repository "$TAP_NAME")"
TAPPED_TAP_ROOT="$(cd "$TAPPED_TAP_ROOT" && pwd -P)"
[ "$TAPPED_TAP_ROOT" != "$TAP_ROOT" ] && \
  [ "$(git -C "$TAPPED_TAP_ROOT" rev-parse HEAD)" = "$TAP_COMMIT" ] && \
  [ -z "$(git -C "$TAPPED_TAP_ROOT" status --short --untracked-files=all)" ] && \
  [ -f "$TAPPED_TAP_ROOT/$RECONSTRUCTED_FORMULA_RELATIVE" ] && \
  [ ! -L "$TAPPED_TAP_ROOT/$RECONSTRUCTED_FORMULA_RELATIVE" ] || {
  echo "homebrew-verify-poured-bottle.sh: Homebrew did not clone the planned tap commit cleanly" >&2
  exit 1
}
cp -- "$TAP_ROOT/$RECONSTRUCTED_FORMULA_RELATIVE" \
  "$TAPPED_TAP_ROOT/$RECONSTRUCTED_FORMULA_RELATIVE"
mapfile -t selected_tap_changes < <(
  git -C "$TAPPED_TAP_ROOT" status --short --untracked-files=all
)
[ "${#selected_tap_changes[@]}" -eq 1 ] && \
  [ "${selected_tap_changes[0]}" = " M $RECONSTRUCTED_FORMULA_RELATIVE" ] && \
  cmp -s "$TAPPED_TAP_ROOT/$RECONSTRUCTED_FORMULA_RELATIVE" \
    "$TAP_ROOT/$RECONSTRUCTED_FORMULA_RELATIVE" || {
  echo "homebrew-verify-poured-bottle.sh: Homebrew did not select the exact reconstructed Formula" >&2
  exit 1
}

if [ -n "$BUILD_USER" ]; then
  rm -rf "$KANDELO_ROOT/host/dist"
  homebrew_patched_launcher_isolate "$BUILD_USER" \
    "$WORK_DIR" "$KANDELO_ROOT" "$TAP_ROOT" "$OUT_PARENT" "$SYSROOT_BUILD_ROOT" \
    "${DEPENDENCY_TAP_ROOTS[@]}"
  BREW_BIN="$HOMEBREW_PATCHED_BREW_BIN"

  if [ "$SELECTION_MODE" = "local-dry-run" ]; then
    # The workflow-owned RUNNER_TEMP tree is intentionally not part of the
    # Formula execution realm. Give the isolated identity one immutable copy
    # of the validated archive instead of weakening that boundary.
    homebrew_patched_launcher_stage_protected_input \
      "$BUILD_USER" "$SHARED_TEMP" "$BOTTLE" "$EXPECTED_BOTTLE_FILENAME"
    PROTECTED_BOTTLE="$HOMEBREW_PATCHED_STAGED_INPUT_PATH"
    [ "$(sha256sum "$PROTECTED_BOTTLE" | awk '{print $1}')" = "$BOTTLE_SHA256" ] &&
      [ "$(wc -c <"$PROTECTED_BOTTLE" | tr -d '[:space:]')" = "$BOTTLE_BYTES" ] || {
        echo "homebrew-verify-poured-bottle.sh: protected bottle input differs from the selected bytes" >&2
        exit 1
      }
    BOTTLE="$PROTECTED_BOTTLE"
  fi
elif [ "${GITHUB_ACTIONS:-}" = "true" ]; then
  echo "homebrew-verify-poured-bottle.sh: CI Formula execution requires KANDELO_HOMEBREW_BUILD_USER" >&2
  exit 2
fi

unset HOMEBREW_KANDELO_BOTTLE_TAG KANDELO_HOMEBREW_BOTTLE_TAG

run_brew_for_kandelo_bottles() {
  HOMEBREW_KANDELO_BOTTLE_TAG="$BOTTLE_TAG" \
  KANDELO_HOMEBREW_BOTTLE_TAG="$BOTTLE_TAG" \
    "$@"
}

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

# Resolve each reviewed direct runtime/test tool in its own normal dependency
# transaction. This avoids Homebrew resolving a dependency whose top-level lock
# is already held by the same combined install command. Expose
# only the reviewed direct tools to target Homebrew after sealing the tree.
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
    echo "homebrew-verify-poured-bottle.sh: native Homebrew selected a non-canonical core Formula: $dependency" >&2
    exit 1
  }
done
run_native_brew_logged missing

# Finish native Homebrew before evaluating target Formula Ruby. The target
# dependency query receives only read-only access to the native prefix and no
# access to its mutable cache, temporary directory, configuration, or home.
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
  echo "homebrew-verify-poured-bottle.sh: Homebrew runtime dependency graph differs from the static locked-tap graph" >&2
  diff -u \
    <(LC_ALL=C sort -u "$STATIC_RUNTIME_DEPENDENCIES") \
    <(LC_ALL=C sort -u "$DEPENDENCY_LIST") >&2 || true
  exit 1
fi
"$BREW_BIN" deps --topological --full-name --include-test \
  --formula "$FORMULA_REF" |
  filter_target_dependencies >"$TEST_DEPENDENCY_LIST"
cp "$TEST_DEPENDENCY_LIST" "$SAME_TAP_TEST_DEPENDENCY_LIST"
awk 'NF && !seen[$0]++ { print }' \
  "$DEPENDENCY_LIST" "$SAME_TAP_TEST_DEPENDENCY_LIST" >"$DEPENDENCY_POUR_LIST"

validate_dependency_list "$DEPENDENCY_LIST" "runtime dependency list"
validate_dependency_list \
  "$SAME_TAP_TEST_DEPENDENCY_LIST" "test dependency list"
validate_dependency_list "$DEPENDENCY_POUR_LIST" "dependency pour list"

while IFS= read -r dependency; do
  [ -n "$dependency" ] || continue
  if [ "$dependency" = "$FORMULA" ] || \
     grep -Fx "$TAP_NAME/$dependency" "$DEPENDENCY_POUR_LIST" >/dev/null; then
    echo "homebrew-verify-poured-bottle.sh: native dependency collides with a target Formula: $dependency" >&2
    exit 2
  fi
done <"$HOST_DEPENDENCY_LIST"

homebrew_patched_launcher_seal_native_prefix
for dependency in "${native_dependencies[@]}"; do
  homebrew_patched_launcher_bridge_native_formula "$dependency"
  # Plain `list` constructs a Keg; `list --versions` only enumerates rack
  # entries and would accept an invalid proxy rack symlink.
  if ! "$BREW_BIN" list --formula "$dependency" >/dev/null; then
    echo "homebrew-verify-poured-bottle.sh: target Homebrew rejected the native Formula proxy keg: $dependency" >&2
    exit 1
  fi
done

while IFS= read -r dependency; do
  [ -n "$dependency" ] || continue
  dependency_tap="${dependency%/*}"
  dependency_name="${dependency##*/}"
  grep -Fx "$dependency_tap" "$ALLOWED_TARGET_TAPS" >/dev/null && \
    [[ "$dependency_name" =~ ^[a-z0-9][a-z0-9._-]*$ ]] || {
      echo "homebrew-verify-poured-bottle.sh: invalid locked-tap dependency: $dependency" >&2
      exit 2
    }
  run_brew_logged run_brew_for_kandelo_bottles "$BREW_BIN" install \
    --force-bottle --as-dependency --ignore-dependencies --formula "$dependency"
done <"$DEPENDENCY_POUR_LIST"

# Dependency downloads have already been proven independently. Remove every
# cached object before the target selection so a public publication must make
# Homebrew fetch the target selected by the reconstructed bottle block.
if [ -n "$BUILD_USER" ]; then
  "$KANDELO_HOMEBREW_SUDO_BIN" -n -- /usr/bin/find "$HOMEBREW_CACHE" -mindepth 1 -delete
else
  find "$HOMEBREW_CACHE" -mindepth 1 -delete
fi
[ -z "$(find "$HOMEBREW_CACHE" -mindepth 1 -print -quit)" ] || {
  echo "homebrew-verify-poured-bottle.sh: target bottle cache is not empty" >&2
  exit 1
}

existing="$("$BREW_BIN" list --versions --formula "$FORMULA_REF" 2>/dev/null || true)"
[ -z "$existing" ] || {
  echo "homebrew-verify-poured-bottle.sh: target Formula was already installed: $existing" >&2
  exit 1
}

if [ "$SELECTION_MODE" = "anonymous-public-readback" ]; then
  run_brew_logged run_brew_for_kandelo_bottles "$BREW_BIN" install \
    --force-bottle --ignore-dependencies --formula "$FORMULA_REF"
else
  run_brew_logged "$BREW_BIN" install --force-bottle --ignore-dependencies "$BOTTLE"
fi
TARGET_OPT_PREFIX="$("$BREW_BIN" --prefix "$FORMULA_REF")"
EXPECTED_TARGET_OPT_PREFIX="$HOMEBREW_PATCHED_PREFIX/opt/$FORMULA"
[ "$TARGET_OPT_PREFIX" = "$EXPECTED_TARGET_OPT_PREFIX" ] || {
  echo "homebrew-verify-poured-bottle.sh: target Formula opt prefix is not canonical" >&2
  exit 1
}
TARGET_PREFIX="$(cd "$TARGET_OPT_PREFIX" && pwd -P)" || {
  echo "homebrew-verify-poured-bottle.sh: target Formula opt prefix does not resolve" >&2
  exit 1
}
TARGET_RACK="$HOMEBREW_PATCHED_PREFIX/Cellar/$FORMULA"
[ -d "$TARGET_RACK" ] && [ ! -L "$TARGET_RACK" ] || {
  echo "homebrew-verify-poured-bottle.sh: target Formula Cellar rack is not a real directory" >&2
  exit 1
}
TARGET_RACK="$(cd "$TARGET_RACK" && pwd -P)" || {
  echo "homebrew-verify-poured-bottle.sh: target Formula Cellar rack does not resolve" >&2
  exit 1
}
EXPECTED_TARGET_PREFIX="$TARGET_RACK/$PKG_VERSION"
[ -d "$EXPECTED_TARGET_PREFIX" ] && [ ! -L "$EXPECTED_TARGET_PREFIX" ] || {
  echo "homebrew-verify-poured-bottle.sh: expected target Formula keg is not a real directory" >&2
  exit 1
}
EXPECTED_TARGET_PREFIX="$(cd "$EXPECTED_TARGET_PREFIX" && pwd -P)" || {
  echo "homebrew-verify-poured-bottle.sh: expected target Formula keg does not resolve" >&2
  exit 1
}
[ "$TARGET_PREFIX" = "$EXPECTED_TARGET_PREFIX" ] || {
  echo "homebrew-verify-poured-bottle.sh: target Formula opt prefix does not select the exact versioned keg" >&2
  exit 1
}
TARGET_RECEIPT="$TARGET_PREFIX/INSTALL_RECEIPT.json"
"$BREW_BIN" info --json=v2 "$FORMULA_REF" >"$FORMULA_INFO"
homebrew_patched_launcher_snapshot_target_cellar_layout \
  >"$TARGET_CELLAR_BEFORE_TEST"
run_brew_logged "$BREW_BIN" test "$FORMULA_REF"
homebrew_patched_launcher_snapshot_target_cellar_layout \
  >"$TARGET_CELLAR_AFTER_TEST"
if ! cmp -s "$TARGET_CELLAR_BEFORE_TEST" "$TARGET_CELLAR_AFTER_TEST"; then
  echo "homebrew-verify-poured-bottle.sh: Formula test changed the planned target Cellar" >&2
  diff -u "$TARGET_CELLAR_BEFORE_TEST" "$TARGET_CELLAR_AFTER_TEST" >&2 || true
  exit 1
fi

if [ "$SELECTION_MODE" = "anonymous-public-readback" ]; then
  mapfile -t selected_bottles < <(
    find "$HOMEBREW_CACHE" -type f -print0 |
      while IFS= read -r -d '' candidate; do
        [ "$(sha256sum "$candidate" | awk '{print $1}')" = "$BOTTLE_SHA256" ] && printf '%s\n' "$candidate"
      done
  )
  [ "${#selected_bottles[@]}" -eq 1 ] || {
    echo "homebrew-verify-poured-bottle.sh: expected one Homebrew-cached exact target bottle, found ${#selected_bottles[@]}" >&2
    exit 1
  }
  INSTALLED_BOTTLE="${selected_bottles[0]}"
else
  INSTALLED_BOTTLE="$BOTTLE"
fi

python3 "$KANDELO_ROOT/scripts/homebrew-dependency-provenance.py" capture \
  --brew-bin "$BREW_BIN" \
  --tap-root "$TAP_ROOT" \
  --tap-repository "$TAP_REPOSITORY" \
  --tap-name "$TAP_NAME" \
  --tap-commit "$TAP_COMMIT" \
  --formula "$FORMULA" \
  --arch "$ARCH" \
  --bottle-root-url "$BOTTLE_ROOT_URL" \
  --target-receipt "$TARGET_RECEIPT" \
  --expected-dependencies "$DEPENDENCY_LIST" \
  --install-log "$INSTALL_LOG" \
  --out "$VERIFIED_DEPENDENCIES"

if [ -n "$BUILD_USER" ]; then
  homebrew_patched_launcher_teardown "$BUILD_USER"
  homebrew_patched_launcher_verify_isolation
fi

[ -f "$HOMEBREW_KANDELO_NODE_RECEIPT_PATH" ] && \
  [ ! -L "$HOMEBREW_KANDELO_NODE_RECEIPT_PATH" ] || {
    echo "homebrew-verify-poured-bottle.sh: brew test did not emit Node execution evidence" >&2
    exit 1
  }

python3 "$KANDELO_ROOT/scripts/homebrew-bottle-runtime-evidence.py" capture \
  --formula "$FORMULA" \
  --arch "$ARCH" \
  --abi "$ABI" \
  --tap-repository "$TAP_REPOSITORY" \
  --tap-name "$TAP_NAME" \
  --tap-commit "$TAP_COMMIT" \
  --tap-root "$TAP_ROOT" \
  --bottle-root-url "$BOTTLE_ROOT_URL" \
  --bottle-json "$BOTTLE_JSON" \
  --bottle-url "$BOTTLE_URL" \
  --bottle-sha256 "$BOTTLE_SHA256" \
  --bottle-bytes "$BOTTLE_BYTES" \
  --dependency-provenance "$VERIFIED_DEPENDENCIES" \
  --selection-receipt "$SELECTION_RECEIPT" \
  --target-prefix "$TARGET_PREFIX" \
  --target-receipt "$TARGET_RECEIPT" \
  --formula-info "$FORMULA_INFO" \
  --install-log "$INSTALL_LOG" \
  --node-receipt "$HOMEBREW_KANDELO_NODE_RECEIPT_PATH" \
  --installed-bottle "$INSTALLED_BOTTLE" \
  --out "$OUT"

echo "homebrew-verify-poured-bottle.sh: verified $FORMULA $ARCH from $BOTTLE_SHA256"
