#!/usr/bin/env bash
# Build one Homebrew bottle from a tap checkout.
set -euo pipefail

TAP_ROOT=""
TAP_REPOSITORY="${KANDELO_HOMEBREW_TAP_REPOSITORY:-Automattic/kandelo-homebrew}"
FORMULA=""
ARCH=""
OUT_DIR=""
BOTTLE_ROOT_URL=""

usage() {
  cat >&2 <<'EOF'
usage: scripts/homebrew-bottle-build.sh --tap-root <tap-root> [--tap-repository <owner/repo>] --formula <name> --arch <wasm32|wasm64> --out <dir> --bottle-root-url <url>

This script is intended to run inside scripts/dev-shell.sh. It invokes the
absolute Homebrew executable named by HOMEBREW_BREW_FILE, avoiding host PATH
leakage while still using the Homebrew installation provided by the workflow.
The Homebrew checkout is patched in a temporary worktree so Kandelo wasm bottle
tags are generated without mutating a developer's host Homebrew checkout.
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
mkdir -p "$OUT_DIR/bottles"
WORK_DIR="$(mktemp -d)"
BREW_REPO=""
BREW_OVERLAY=""

cleanup() {
  if [ -n "$BREW_REPO" ] && [ -n "$BREW_OVERLAY" ] && [ -d "$BREW_OVERLAY" ]; then
    git -C "$BREW_REPO" worktree remove --force "$BREW_OVERLAY" >/dev/null 2>&1 || rm -rf "$BREW_OVERLAY"
  fi
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

BREW_REPO="$("$BREW_BIN" --repository)"
if [ -f "$PATCH_FILE" ] && git -C "$BREW_REPO" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git -C "$BREW_REPO" apply --check "$PATCH_FILE"
  BREW_OVERLAY="$WORK_DIR/homebrew-overlay"
  git -C "$BREW_REPO" worktree add --detach "$BREW_OVERLAY" HEAD >/dev/null
  git -C "$BREW_OVERLAY" apply --whitespace=nowarn "$PATCH_FILE"
  BREW_BIN="$BREW_OVERLAY/bin/brew"
fi

TAP_NAME="$(printf '%s' "$TAP_REPOSITORY" | tr '[:upper:]' '[:lower:]')"
BOTTLE_TAG="${ARCH}_kandelo"

export HOMEBREW_NO_AUTO_UPDATE="${HOMEBREW_NO_AUTO_UPDATE:-1}"
export HOMEBREW_NO_INSTALL_CLEANUP="${HOMEBREW_NO_INSTALL_CLEANUP:-1}"
export HOMEBREW_NO_ANALYTICS="${HOMEBREW_NO_ANALYTICS:-1}"
export HOMEBREW_DEVELOPER="${HOMEBREW_DEVELOPER:-1}"
export KANDELO_HOMEBREW_ARCH="$ARCH"
export HOMEBREW_KANDELO_BOTTLE_TAG="$BOTTLE_TAG"
export KANDELO_HOMEBREW_BOTTLE_TAG="$BOTTLE_TAG"
export KANDELO_HOMEBREW_KANDELO_ROOT="$KANDELO_ROOT"
export HOMEBREW_KANDELO_ARCH="$ARCH"
export HOMEBREW_KANDELO_ROOT="$KANDELO_ROOT"
export HOMEBREW_KANDELO_NODE="$(command -v node)"
export HOMEBREW_KANDELO_LLVM_BIN="${LLVM_BIN:-${WASM_POSIX_LLVM_DIR:-}}"

if [ ! -d "$TAP_SOURCE/.git" ]; then
  TAP_SOURCE="$WORK_DIR/tap-source"
  mkdir -p "$TAP_SOURCE"
  rsync -a --exclude .git "$TAP_ROOT/" "$TAP_SOURCE/"
  git -C "$TAP_SOURCE" init -q
  git -C "$TAP_SOURCE" config user.name "kandelo-homebrew-local"
  git -C "$TAP_SOURCE" config user.email "kandelo-homebrew-local@example.invalid"
  git -C "$TAP_SOURCE" add .
  git -C "$TAP_SOURCE" commit -q -m "stage Kandelo Homebrew tap"
fi

"$BREW_BIN" tap "$TAP_NAME" "$TAP_SOURCE"
"$BREW_BIN" trust "$TAP_NAME"
FORMULA_REF="$TAP_NAME/$FORMULA"
TAPPED_TAP_ROOT="$("$BREW_BIN" --repository "$TAP_NAME")"
TAPPED_FORMULA_PATH="$TAPPED_TAP_ROOT/Formula/$FORMULA.rb"

same_file() {
  [ -e "$1" ] && [ -e "$2" ] && [ "$1" -ef "$2" ]
}

formula_has_bottle_tag() {
  local formula_path="$1"
  [ -f "$formula_path" ] && grep -Eq "${BOTTLE_TAG}: \"[0-9a-f]{64}\"" "$formula_path"
}

if ! same_file "$FORMULA_PATH" "$TAPPED_FORMULA_PATH"; then
  mkdir -p "$(dirname "$TAPPED_FORMULA_PATH")"
  cp "$FORMULA_PATH" "$TAPPED_FORMULA_PATH"
fi

brew_install_build_bottle() {
  local attempt status log
  status=1
  for attempt in 1 2 3; do
    log="$WORK_DIR/brew-install-attempt-${attempt}.log"
    set +e
    "$BREW_BIN" install --build-bottle --formula "$FORMULA_REF" 2> >(tee "$log" >&2)
    status=$?
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
  HOMEBREW_KANDELO_BOTTLE_TAG="$BOTTLE_TAG" \
  KANDELO_HOMEBREW_BOTTLE_TAG="$BOTTLE_TAG" \
    "$BREW_BIN" bottle --json --no-rebuild --root-url "$BOTTLE_ROOT_URL" "$FORMULA_REF"
)

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
REMOTE_BOTTLE_FILENAME="$(
  "$BREW_BIN" ruby -rjson -e '
    json_path, bottle_tag = ARGV
    data = JSON.parse(File.read(json_path))
    tag = data.values.first.fetch("bottle").fetch("tags").fetch(bottle_tag)
    puts tag.fetch("filename")
  ' "$BOTTLE_JSON" "$BOTTLE_TAG"
)"
if [ -n "$REMOTE_BOTTLE_FILENAME" ] && [ "$REMOTE_BOTTLE_FILENAME" != "$(basename "$BOTTLE_ARCHIVE")" ]; then
  cp "$BOTTLE_ARCHIVE" "$OUT_DIR/bottles/$REMOTE_BOTTLE_FILENAME"
fi

(
  cd "$TAP_ROOT"
  HOMEBREW_KANDELO_BOTTLE_TAG="$BOTTLE_TAG" \
  KANDELO_HOMEBREW_BOTTLE_TAG="$BOTTLE_TAG" \
    "$BREW_BIN" bottle --merge --write --no-commit "$BOTTLE_JSON"
)

if [ ! -f "$TAPPED_FORMULA_PATH" ]; then
  echo "homebrew-bottle-build.sh: merged formula not found: $TAPPED_FORMULA_PATH" >&2
  exit 1
fi
if formula_has_bottle_tag "$FORMULA_PATH"; then
  :
elif formula_has_bottle_tag "$TAPPED_FORMULA_PATH"; then
  cp "$TAPPED_FORMULA_PATH" "$FORMULA_PATH"
else
  echo "homebrew-bottle-build.sh: bottle merge did not write $BOTTLE_TAG to $FORMULA_PATH" >&2
  exit 1
fi

{
  printf 'FORMULA=%q\n' "$FORMULA"
  printf 'ARCH=%q\n' "$ARCH"
  printf 'BOTTLE_JSON=%q\n' "$BOTTLE_JSON"
  printf 'BOTTLE_ARCHIVE=%q\n' "$BOTTLE_ARCHIVE"
  printf 'BOTTLE_ROOT_URL=%q\n' "$BOTTLE_ROOT_URL"
} >"$OUT_DIR/build.env"

echo "homebrew-bottle-build.sh: built $BOTTLE_ARCHIVE"
