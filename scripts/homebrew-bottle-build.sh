#!/usr/bin/env bash
# Build one Homebrew bottle from a tap checkout.
set -euo pipefail

TAP_ROOT=""
FORMULA=""
ARCH=""
OUT_DIR=""
BOTTLE_ROOT_URL=""

usage() {
  cat >&2 <<'EOF'
usage: scripts/homebrew-bottle-build.sh --tap-root <tap-root> --formula <name> --arch <wasm32|wasm64> --out <dir> --bottle-root-url <url>

This script is intended to run inside scripts/dev-shell.sh. It invokes the
absolute Homebrew executable named by HOMEBREW_BREW_FILE, avoiding host PATH
leakage while still using the Homebrew installation provided by the workflow.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --tap-root) TAP_ROOT="${2:-}"; shift 2 ;;
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
require formula "$FORMULA"
require arch "$ARCH"
require out "$OUT_DIR"
require bottle-root-url "$BOTTLE_ROOT_URL"

if ! [[ "$FORMULA" =~ ^[a-z0-9][a-z0-9._-]*$ ]]; then
  echo "homebrew-bottle-build.sh: invalid formula name: $FORMULA" >&2
  exit 2
fi

case "$ARCH" in
  wasm32|wasm64) ;;
  *) echo "homebrew-bottle-build.sh: invalid arch: $ARCH" >&2; exit 2 ;;
esac

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

mkdir -p "$OUT_DIR/bottles"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

export HOMEBREW_NO_AUTO_UPDATE="${HOMEBREW_NO_AUTO_UPDATE:-1}"
export HOMEBREW_NO_INSTALL_CLEANUP="${HOMEBREW_NO_INSTALL_CLEANUP:-1}"
export HOMEBREW_NO_ANALYTICS="${HOMEBREW_NO_ANALYTICS:-1}"
export HOMEBREW_DEVELOPER="${HOMEBREW_DEVELOPER:-1}"
export KANDELO_HOMEBREW_ARCH="$ARCH"
export KANDELO_HOMEBREW_BOTTLE_TAG="${ARCH}_kandelo"

(
  cd "$WORK_DIR"
  "$BREW_BIN" install --build-bottle --formula "$FORMULA_PATH"
  "$BREW_BIN" bottle --json --no-rebuild --root-url "$BOTTLE_ROOT_URL" "$FORMULA_PATH"
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

{
  printf 'FORMULA=%q\n' "$FORMULA"
  printf 'ARCH=%q\n' "$ARCH"
  printf 'BOTTLE_JSON=%q\n' "$BOTTLE_JSON"
  printf 'BOTTLE_ARCHIVE=%q\n' "$BOTTLE_ARCHIVE"
  printf 'BOTTLE_ROOT_URL=%q\n' "$BOTTLE_ROOT_URL"
} >"$OUT_DIR/build.env"

echo "homebrew-bottle-build.sh: built $BOTTLE_ARCHIVE"
