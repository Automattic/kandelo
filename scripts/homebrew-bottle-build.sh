#!/usr/bin/env bash
# Build one Homebrew bottle from a tap checkout.
set -euo pipefail

TAP_ROOT=""
TAP_REPOSITORY="${KANDELO_HOMEBREW_TAP_REPOSITORY:-Automattic/kandelo-homebrew}"
FORMULA=""
ARCH=""
OUT_DIR=""
BOTTLE_ROOT_URL=""
BUILD_USER="${KANDELO_HOMEBREW_BUILD_USER:-}"
SHARED_TEMP="${KANDELO_HOMEBREW_SHARED_TEMP:-}"

usage() {
  cat >&2 <<'EOF'
usage: scripts/homebrew-bottle-build.sh --tap-root <tap-root> [--tap-repository <owner/repo>] --formula <name> --arch <wasm32|wasm64> --out <dir> --bottle-root-url <url>

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

TAP_ROOT="$(cd "$TAP_ROOT" && pwd)"
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

KANDELO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PATCH_FILE="$KANDELO_ROOT/homebrew/patches/0001-add-kandelo-wasm-bottle-tags.patch"
. "$KANDELO_ROOT/scripts/homebrew-patched-launcher.sh"
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
CONTROL_DIR="$(mktemp -d "$OUT_DIR/.control.XXXXXX")"
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

# Formula dependencies are evaluated separately from the formula named on the
# command line. Trust the reviewed tap as a whole, but keep every Brew call in
# this build scoped away from user state. The launcher derives
# HOMEBREW_USER_CONFIG_HOME from XDG_CONFIG_HOME, so set the isolated XDG root
# before discovering the repository and prefix.
export XDG_CONFIG_HOME="$WORK_DIR/xdg-config"
mkdir -p "$XDG_CONFIG_HOME/homebrew"
chmod 0700 "$XDG_CONFIG_HOME" "$XDG_CONFIG_HOME/homebrew"

homebrew_patched_launcher_prepare "$BREW_BIN" "$PATCH_FILE" "$WORK_DIR"
BREW_BIN="$HOMEBREW_PATCHED_BREW_BIN"

TAP_NAME="$(printf '%s' "$TAP_REPOSITORY" | tr '[:upper:]' '[:lower:]')"
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

unset HOMEBREW_KANDELO_BOTTLE_TAG KANDELO_HOMEBREW_BOTTLE_TAG

run_brew_for_kandelo_bottles() {
  HOMEBREW_KANDELO_BOTTLE_TAG="$BOTTLE_TAG" \
  KANDELO_HOMEBREW_BOTTLE_TAG="$BOTTLE_TAG" \
    "$@"
}

INSTALL_LOG="$CONTROL_DIR/brew-install.log"
DEPENDENCY_LIST="$CONTROL_DIR/same-tap-dependencies.txt"
BUILD_TEST_DEPENDENCY_LIST="$CONTROL_DIR/same-tap-build-test-dependencies.txt"
DEPENDENCY_POUR_LIST="$CONTROL_DIR/same-tap-pour-dependencies.txt"
DEPENDENCY_PROVENANCE="$OUT_DIR/dependency-provenance.json"
: >"$INSTALL_LOG"
: >"$DEPENDENCY_LIST"
: >"$BUILD_TEST_DEPENDENCY_LIST"
: >"$DEPENDENCY_POUR_LIST"
for attempt in 1 2 3; do
  : >"$CONTROL_DIR/brew-install-attempt-${attempt}.log"
done
chmod 0600 "$INSTALL_LOG" "$DEPENDENCY_LIST" \
  "$BUILD_TEST_DEPENDENCY_LIST" "$DEPENDENCY_POUR_LIST" \
  "$CONTROL_DIR"/brew-install-attempt-*.log

"$BREW_BIN" tap "$TAP_NAME" "$TAP_ROOT"
"$BREW_BIN" trust --tap "$TAP_NAME"
FORMULA_REF="$TAP_NAME/$FORMULA"
TAPPED_TAP_ROOT="$("$BREW_BIN" --repository "$TAP_NAME")"
TAPPED_FORMULA_PATH="$TAPPED_TAP_ROOT/Formula/$FORMULA.rb"

same_file() {
  [ -e "$1" ] && [ -e "$2" ] && [ "$1" -ef "$2" ]
}

if ! same_file "$FORMULA_PATH" "$TAPPED_FORMULA_PATH"; then
  mkdir -p "$(dirname "$TAPPED_FORMULA_PATH")"
  cp "$FORMULA_PATH" "$TAPPED_FORMULA_PATH"
fi

if [ -n "$BUILD_USER" ]; then
  # Formula helpers deliberately remove stale compiled host output before
  # loading TypeScript sources. Do that while the workflow identity still owns
  # the checkout; the isolated build identity receives no source write access.
  rm -rf "$KANDELO_ROOT/host/dist"
  homebrew_patched_launcher_isolate "$BUILD_USER" \
    "$WORK_DIR" "$KANDELO_ROOT" "$TAP_ROOT" "$OUT_DIR"
  BREW_BIN="$HOMEBREW_PATCHED_BREW_BIN"
elif [ "${GITHUB_ACTIONS:-}" = "true" ]; then
  echo "homebrew-bottle-build.sh: CI Formula execution requires KANDELO_HOMEBREW_BUILD_USER" >&2
  exit 2
fi

# `brew install --build-bottle` forces only the selected formula to build from
# source. Homebrew otherwise permits each dependency to fall back to a source
# build when its bottle is missing. Preserve the runtime-only same-tap closure
# for published provenance, but separately resolve build and test dependencies
# so every same-tap Formula is force-poured before Homebrew resolves native host
# tools. Topological order plus --ignore-dependencies prevents those explicit
# installs from recursively taking Homebrew's source fallback path.
"$BREW_BIN" deps --topological --full-name --formula "$FORMULA_REF" |
  awk -v prefix="$TAP_NAME/" '
    index(tolower($0), prefix) == 1 && !seen[tolower($0)]++ { print tolower($0) }
  ' >"$DEPENDENCY_LIST"
"$BREW_BIN" deps --topological --full-name --include-build --include-test \
  --formula "$FORMULA_REF" |
  awk -v prefix="$TAP_NAME/" '
    index(tolower($0), prefix) == 1 && !seen[tolower($0)]++ { print tolower($0) }
  ' >"$BUILD_TEST_DEPENDENCY_LIST"
awk 'NF && !seen[$0]++ { print }' \
  "$DEPENDENCY_LIST" "$BUILD_TEST_DEPENDENCY_LIST" >"$DEPENDENCY_POUR_LIST"

validate_same_tap_dependency_list() {
  local path="$1" label="$2" bytes count
  bytes="$(wc -c <"$path" | tr -d '[:space:]')"
  count="$(awk 'NF { count++ } END { print count + 0 }' "$path")"
  if [ "$bytes" -gt 65536 ] || [ "$count" -gt 128 ]; then
    echo "homebrew-bottle-build.sh: $label exceeds the same-tap dependency limit" >&2
    exit 2
  fi
}

validate_same_tap_dependency_list "$DEPENDENCY_LIST" "runtime dependency list"
validate_same_tap_dependency_list \
  "$BUILD_TEST_DEPENDENCY_LIST" "build/test dependency list"
validate_same_tap_dependency_list "$DEPENDENCY_POUR_LIST" "dependency pour list"

run_brew_logged() {
  local status
  set +e
  "$@" 2>&1 | tee -a "$INSTALL_LOG"
  status="${PIPESTATUS[0]}"
  set -e
  return "$status"
}

while IFS= read -r dependency; do
  [ -n "$dependency" ] || continue
  dependency_name="${dependency#"$TAP_NAME/"}"
  if [ "$dependency_name" = "$dependency" ] || \
     ! [[ "$dependency_name" =~ ^[a-z0-9][a-z0-9._-]*$ ]]; then
    echo "homebrew-bottle-build.sh: invalid same-tap dependency: $dependency" >&2
    exit 2
  fi
  run_brew_logged run_brew_for_kandelo_bottles "$BREW_BIN" install \
    --force-bottle \
    --as-dependency \
    --ignore-dependencies \
    --formula "$dependency"
done <"$DEPENDENCY_POUR_LIST"

# The exact same-tap build and test closure is now installed, so ask Homebrew to
# complete the selected Formula's remaining declared dependency closure normally.
# Keep the Kandelo bottle tag unset here: native tools such as Binaryen, WABT,
# and certificate bundles must resolve as host packages, while the already
# installed same-tap Formulae remain the reviewed Kandelo bottles above.
run_brew_logged "$BREW_BIN" install \
  --only-dependencies \
  --include-test \
  --formula "$FORMULA_REF"

brew_install_build_bottle() {
  local attempt status log
  status=1
  for attempt in 1 2 3; do
    log="$CONTROL_DIR/brew-install-attempt-${attempt}.log"
    set +e
    "$BREW_BIN" install --build-bottle --formula "$FORMULA_REF" 2>&1 |
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
  "$BREW_BIN" test "$FORMULA_REF"
  run_brew_for_kandelo_bottles "$BREW_BIN" bottle \
    --json --no-rebuild --root-url "$BOTTLE_ROOT_URL" "$FORMULA_REF"
)

TAP_COMMIT="$(git -C "$TAP_ROOT" rev-parse HEAD)"
TARGET_PREFIX="$("$BREW_BIN" --prefix "$FORMULA_REF")"
python3 "$KANDELO_ROOT/scripts/homebrew-dependency-provenance.py" capture \
  --brew-bin "$BREW_BIN" \
  --tap-root "$TAP_ROOT" \
  --tap-repository "$TAP_REPOSITORY" \
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
mapfile -t bottle_archives < <(find "$WORK_DIR" -maxdepth 1 -type f \( -name '*.bottle.tar.gz' -o -name '*.bottle.tar.zst' \) -print | sort)

if [ "${#bottle_jsons[@]}" -ne 1 ]; then
  echo "homebrew-bottle-build.sh: expected exactly one .bottle.json, found ${#bottle_jsons[@]}" >&2
  exit 1
fi
if [ "${#bottle_archives[@]}" -ne 1 ]; then
  echo "homebrew-bottle-build.sh: expected exactly one bottle archive, found ${#bottle_archives[@]}" >&2
  exit 1
fi

cp "${bottle_jsons[0]}" "$OUT_DIR/bottles/"
cp "${bottle_archives[0]}" "$OUT_DIR/bottles/"

BOTTLE_JSON="$OUT_DIR/bottles/$(basename "${bottle_jsons[0]}")"
BOTTLE_ARCHIVE="$OUT_DIR/bottles/$(basename "${bottle_archives[0]}")"

{
  printf 'FORMULA=%q\n' "$FORMULA"
  printf 'ARCH=%q\n' "$ARCH"
  printf 'BOTTLE_JSON=%q\n' "$BOTTLE_JSON"
  printf 'BOTTLE_ARCHIVE=%q\n' "$BOTTLE_ARCHIVE"
  printf 'DEPENDENCY_PROVENANCE=%q\n' "$DEPENDENCY_PROVENANCE"
  printf 'BOTTLE_ROOT_URL=%q\n' "$BOTTLE_ROOT_URL"
} >"$OUT_DIR/build.env"

echo "homebrew-bottle-build.sh: built $BOTTLE_ARCHIVE"
