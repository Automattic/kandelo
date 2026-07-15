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
OUT=""
BUILD_USER="${KANDELO_HOMEBREW_BUILD_USER:-}"
SHARED_TEMP="${KANDELO_HOMEBREW_SHARED_TEMP:-}"

usage() {
  cat >&2 <<'EOF'
usage: scripts/homebrew-verify-poured-bottle.sh --tap-root <dir> --tap-repository <owner/repo> [--tap-name <owner/name>] --tap-commit <sha> --formula <name> --arch <wasm32|wasm64> --abi <number> --bottle <archive> --bottle-json <json> --bottle-url <url> --bottle-sha256 <sha> --bottle-bytes <count> --bottle-root-url <url> --dependency-provenance <json> --selection-receipt <json> --out <runtime-evidence.json>

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
    --out) OUT="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "homebrew-verify-poured-bottle.sh: unknown flag $1" >&2; usage; exit 2 ;;
  esac
done

for name in TAP_ROOT TAP_REPOSITORY TAP_COMMIT FORMULA ARCH ABI BOTTLE BOTTLE_JSON \
  BOTTLE_URL BOTTLE_SHA256 BOTTLE_BYTES BOTTLE_ROOT_URL DEPENDENCY_PROVENANCE OUT; do
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

TAP_ROOT="$(cd "$TAP_ROOT" && pwd -P)"
KANDELO_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
# shellcheck source=/dev/null
. "$KANDELO_ROOT/scripts/homebrew-tap-identity.sh"
TAP_NAME="$(homebrew_resolve_tap_name "$TAP_REPOSITORY" "$TAP_NAME_INPUT")"
for file in "$BOTTLE" "$BOTTLE_JSON" "$DEPENDENCY_PROVENANCE" "$SELECTION_RECEIPT"; do
  [ -f "$file" ] && [ ! -L "$file" ] || {
    echo "homebrew-verify-poured-bottle.sh: required input is not a regular file: $file" >&2
    exit 2
  }
done
[ "$(git -C "$TAP_ROOT" rev-parse HEAD)" = "$TAP_COMMIT" ] || {
  echo "homebrew-verify-poured-bottle.sh: tap HEAD differs from the planned commit" >&2
  exit 2
}
actual_sha="$(sha256sum "$BOTTLE" | awk '{print $1}')"
actual_bytes="$(wc -c <"$BOTTLE" | tr -d '[:space:]')"
[ "$actual_sha" = "$BOTTLE_SHA256" ] && [ "$actual_bytes" = "$BOTTLE_BYTES" ] || {
  echo "homebrew-verify-poured-bottle.sh: selected bottle bytes differ from the receipt" >&2
  exit 1
}

BREW_BIN="${HOMEBREW_BREW_FILE:-}"
[ -n "$BREW_BIN" ] && [ -x "$BREW_BIN" ] || {
  echo "homebrew-verify-poured-bottle.sh: HOMEBREW_BREW_FILE is required" >&2
  exit 2
}
PATCH_FILE="$KANDELO_ROOT/homebrew/patches/0001-add-kandelo-wasm-bottle-tags.patch"
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
CONTROL_DIR="$(mktemp -d "$OUT_PARENT/.control.XXXXXX")"
chmod 0700 "$CONTROL_DIR"

cleanup() {
  homebrew_patched_launcher_cleanup
  rm -rf "$CONTROL_DIR"
  if [ -n "$BUILD_USER" ] && [ -n "${KANDELO_HOMEBREW_SUDO_BIN:-}" ]; then
    "$KANDELO_HOMEBREW_SUDO_BIN" rm -rf "$WORK_DIR" >/dev/null 2>&1 || true
  else
    rm -rf "$WORK_DIR"
  fi
}
trap cleanup EXIT

export XDG_CONFIG_HOME="$WORK_DIR/xdg-config"
mkdir -p "$XDG_CONFIG_HOME/homebrew"
chmod 0700 "$XDG_CONFIG_HOME" "$XDG_CONFIG_HOME/homebrew"
homebrew_patched_launcher_prepare "$BREW_BIN" "$PATCH_FILE" "$WORK_DIR"
BREW_BIN="$HOMEBREW_PATCHED_BREW_BIN"

FORMULA_REF="$TAP_NAME/$FORMULA"
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
export HOMEBREW_KANDELO_ABI="$ABI"
export HOMEBREW_KANDELO_NODE_RECEIPT_PATH="$WORK_DIR/node-execution-receipt.json"
rm -f "$HOMEBREW_KANDELO_NODE_RECEIPT_PATH"

"$BREW_BIN" tap "$TAP_NAME" "$TAP_ROOT"
"$BREW_BIN" trust --tap "$TAP_NAME"
TAPPED_TAP_ROOT="$("$BREW_BIN" --repository "$TAP_NAME")"
[ "$TAPPED_TAP_ROOT/Formula/$FORMULA.rb" -ef "$TAP_ROOT/Formula/$FORMULA.rb" ] || {
  echo "homebrew-verify-poured-bottle.sh: Homebrew did not select the reconstructed Formula" >&2
  exit 1
}

if [ -n "$BUILD_USER" ]; then
  rm -rf "$KANDELO_ROOT/host/dist"
  homebrew_patched_launcher_isolate "$BUILD_USER" "$WORK_DIR" "$KANDELO_ROOT" "$TAP_ROOT"
  homebrew_assert_tree_not_writable_by_user "$BUILD_USER" "$OUT_PARENT"
  homebrew_assert_tree_not_replaceable_by_user "$BUILD_USER" "$OUT_PARENT"
  BREW_BIN="$HOMEBREW_PATCHED_BREW_BIN"
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

INSTALL_LOG="$CONTROL_DIR/install.log"
DEPENDENCY_LIST="$CONTROL_DIR/dependencies.txt"
TEST_DEPENDENCY_LIST="$CONTROL_DIR/test-dependencies.txt"
SAME_TAP_TEST_DEPENDENCY_LIST="$CONTROL_DIR/same-tap-test-dependencies.txt"
HOST_DEPENDENCY_LIST="$CONTROL_DIR/host-dependencies.txt"
DEPENDENCY_POUR_LIST="$CONTROL_DIR/pour-dependencies.txt"
FORMULA_INFO="$CONTROL_DIR/formula-info.json"
VERIFIED_DEPENDENCIES="$CONTROL_DIR/verified-dependency-provenance.json"
: >"$INSTALL_LOG"
: >"$DEPENDENCY_LIST"
: >"$TEST_DEPENDENCY_LIST"
: >"$SAME_TAP_TEST_DEPENDENCY_LIST"
: >"$HOST_DEPENDENCY_LIST"
: >"$DEPENDENCY_POUR_LIST"
chmod 0600 "$INSTALL_LOG" "$DEPENDENCY_LIST" \
  "$TEST_DEPENDENCY_LIST" "$SAME_TAP_TEST_DEPENDENCY_LIST" \
  "$HOST_DEPENDENCY_LIST" "$DEPENDENCY_POUR_LIST"

run_brew_logged() {
  local status
  set +e
  "$@" 2>&1 | tee -a "$INSTALL_LOG"
  status="${PIPESTATUS[0]}"
  set -e
  return "$status"
}

"$BREW_BIN" deps --topological --full-name --formula "$FORMULA_REF" |
  awk -v prefix="$TAP_NAME/" '
    index(tolower($0), prefix) == 1 && !seen[tolower($0)]++ { print tolower($0) }
  ' >"$DEPENDENCY_LIST"
"$BREW_BIN" deps --topological --full-name --include-test \
  --formula "$FORMULA_REF" |
  awk 'NF && !seen[tolower($0)]++ { print tolower($0) }' >"$TEST_DEPENDENCY_LIST"
awk -v prefix="$TAP_NAME/" 'index($0, prefix) == 1 { print }' \
  "$TEST_DEPENDENCY_LIST" >"$SAME_TAP_TEST_DEPENDENCY_LIST"
awk -v prefix="$TAP_NAME/" 'index($0, prefix) != 1 { print }' \
  "$TEST_DEPENDENCY_LIST" >"$HOST_DEPENDENCY_LIST"
awk 'NF && !seen[$0]++ { print }' \
  "$DEPENDENCY_LIST" "$SAME_TAP_TEST_DEPENDENCY_LIST" >"$DEPENDENCY_POUR_LIST"

validate_dependency_list() {
  local path="$1" label="$2" bytes count
  bytes="$(wc -c <"$path" | tr -d '[:space:]')"
  count="$(awk 'NF { count++ } END { print count + 0 }' "$path")"
  if [ "$bytes" -gt 65536 ] || [ "$count" -gt 128 ]; then
    echo "homebrew-verify-poured-bottle.sh: $label exceeds the dependency limit" >&2
    exit 2
  fi
}

validate_dependency_list "$DEPENDENCY_LIST" "runtime dependency list"
validate_dependency_list \
  "$SAME_TAP_TEST_DEPENDENCY_LIST" "test dependency list"
validate_dependency_list "$DEPENDENCY_POUR_LIST" "dependency pour list"
validate_dependency_list "$HOST_DEPENDENCY_LIST" "host dependency list"

while IFS= read -r dependency; do
  [ -n "$dependency" ] || continue
  dependency_name="${dependency#"$TAP_NAME/"}"
  [ "$dependency_name" != "$dependency" ] && \
    [[ "$dependency_name" =~ ^[a-z0-9][a-z0-9._-]*$ ]] || {
      echo "homebrew-verify-poured-bottle.sh: invalid same-tap dependency: $dependency" >&2
      exit 2
    }
  run_brew_logged run_brew_for_kandelo_bottles "$BREW_BIN" install \
    --force-bottle --as-dependency --ignore-dependencies --formula "$dependency"
done <"$DEPENDENCY_POUR_LIST"

# Homebrew treats the target as unbottled under the native Linux tag, so asking
# Homebrew to install the target's dependencies would reintroduce pure build deps.
# Install only the explicitly resolved non-tap runtime/test closure instead.
while IFS= read -r dependency; do
  [ -n "$dependency" ] || continue
  [[ "$dependency" =~ ^[a-z0-9][a-z0-9@+_.-]*$|^[a-z0-9][a-z0-9_.-]*/[a-z0-9][a-z0-9_.-]*/[a-z0-9][a-z0-9@+_.-]*$ ]] || {
    echo "homebrew-verify-poured-bottle.sh: invalid host dependency: $dependency" >&2
    exit 2
  }
  run_brew_logged "$BREW_BIN" install \
    --as-dependency --ignore-dependencies --formula "$dependency"
done <"$HOST_DEPENDENCY_LIST"

SELECTION_MODE="$(jq -er '.bottle.mode' "$SELECTION_RECEIPT")"
case "$SELECTION_MODE" in
  anonymous-public-readback|local-dry-run) ;;
  *) echo "homebrew-verify-poured-bottle.sh: invalid bottle selection mode" >&2; exit 2 ;;
esac

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
TARGET_PREFIX="$("$BREW_BIN" --prefix "$FORMULA_REF")"
TARGET_RECEIPT="$TARGET_PREFIX/INSTALL_RECEIPT.json"
"$BREW_BIN" info --json=v2 "$FORMULA_REF" >"$FORMULA_INFO"
run_brew_logged "$BREW_BIN" test "$FORMULA_REF"

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
