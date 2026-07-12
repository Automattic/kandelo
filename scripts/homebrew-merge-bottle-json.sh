#!/usr/bin/env bash
# Merge one validated bottle JSON document into a clean tap checkout.
set -euo pipefail

TAP_ROOT=""
TAP_REPOSITORY=""
FORMULA=""
ARCH=""
BOTTLE_JSON=""
EXPECTED_SHA256=""
EXPECTED_ROOT_URL=""
EXPECTED_CELLAR=""

usage() {
  cat >&2 <<'EOF'
usage: scripts/homebrew-merge-bottle-json.sh --tap-root <dir> --tap-repository <owner/repo> --formula <name> --arch <wasm32|wasm64> --bottle-json <path> --expected-sha256 <sha256> --expected-root-url <url> --expected-cellar <any|any_skip_relocation|canonical-cellar>
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --tap-root) TAP_ROOT="${2:-}"; shift 2 ;;
    --tap-repository) TAP_REPOSITORY="${2:-}"; shift 2 ;;
    --formula) FORMULA="${2:-}"; shift 2 ;;
    --arch) ARCH="${2:-}"; shift 2 ;;
    --bottle-json) BOTTLE_JSON="${2:-}"; shift 2 ;;
    --expected-sha256) EXPECTED_SHA256="${2:-}"; shift 2 ;;
    --expected-root-url) EXPECTED_ROOT_URL="${2:-}"; shift 2 ;;
    --expected-cellar) EXPECTED_CELLAR="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "homebrew-merge-bottle-json.sh: unknown flag $1" >&2; usage; exit 2 ;;
  esac
done

for name in TAP_ROOT TAP_REPOSITORY FORMULA ARCH BOTTLE_JSON EXPECTED_SHA256 EXPECTED_ROOT_URL EXPECTED_CELLAR; do
  if [ -z "${!name}" ]; then
    echo "homebrew-merge-bottle-json.sh: ${name,,} is required" >&2
    exit 2
  fi
done
if ! [[ "$TAP_REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  echo "homebrew-merge-bottle-json.sh: invalid tap repository" >&2
  exit 2
fi
case "$EXPECTED_CELLAR" in
  any) EXPECTED_CELLAR_DSL=":any" ;;
  any_skip_relocation) EXPECTED_CELLAR_DSL=":any_skip_relocation" ;;
  /home/linuxbrew/.linuxbrew/Cellar)
    EXPECTED_CELLAR_DSL="\"/home/linuxbrew/.linuxbrew/Cellar\""
    ;;
  *) echo "homebrew-merge-bottle-json.sh: invalid expected relocation cellar" >&2; exit 2 ;;
esac
if ! [[ "$FORMULA" =~ ^[a-z0-9][a-z0-9._-]*$ ]]; then
  echo "homebrew-merge-bottle-json.sh: invalid formula" >&2
  exit 2
fi
case "$ARCH" in
  wasm32|wasm64) ;;
  *) echo "homebrew-merge-bottle-json.sh: invalid architecture" >&2; exit 2 ;;
esac
if ! [[ "$EXPECTED_SHA256" =~ ^[0-9a-f]{64}$ ]]; then
  echo "homebrew-merge-bottle-json.sh: invalid expected sha256" >&2
  exit 2
fi
if ! [[ "$EXPECTED_ROOT_URL" =~ ^https://ghcr\.io/v2/[a-z0-9._-]+/[a-z0-9._/-]+$ ]]; then
  echo "homebrew-merge-bottle-json.sh: invalid expected bottle root URL" >&2
  exit 2
fi

TAP_ROOT="$(cd "$TAP_ROOT" && pwd)"
BOTTLE_JSON="$(cd "$(dirname "$BOTTLE_JSON")" && pwd)/$(basename "$BOTTLE_JSON")"
FORMULA_PATH="$TAP_ROOT/Formula/$FORMULA.rb"
if [ ! -f "$FORMULA_PATH" ] || [ ! -f "$BOTTLE_JSON" ]; then
  echo "homebrew-merge-bottle-json.sh: formula or bottle JSON is missing" >&2
  exit 2
fi

TAG="${ARCH}_kandelo"
jq -e \
  --arg formula "$FORMULA" \
  --arg tag "$TAG" \
  --arg sha "$EXPECTED_SHA256" \
  --arg root "$EXPECTED_ROOT_URL" \
  --arg cellar "$EXPECTED_CELLAR" '
    (keys | length) == 1 and
    (to_entries[0].key == $formula) and
    (to_entries[0].value.formula.name == $formula) and
    (to_entries[0].value.bottle.root_url == $root) and
    (to_entries[0].value.bottle.cellar == $cellar) and
    (to_entries[0].value.bottle.tags[$tag].sha256 == $sha)
  ' "$BOTTLE_JSON" >/dev/null || {
    echo "homebrew-merge-bottle-json.sh: bottle JSON identity or digest mismatch" >&2
    exit 1
  }

BREW_BIN="${HOMEBREW_BREW_FILE:-}"
if [ -z "$BREW_BIN" ] || [ ! -x "$BREW_BIN" ]; then
  echo "homebrew-merge-bottle-json.sh: HOMEBREW_BREW_FILE is required" >&2
  exit 2
fi
KANDELO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PATCH_FILE="$KANDELO_ROOT/homebrew/patches/0001-add-kandelo-wasm-bottle-tags.patch"
BREW_REPO="$("$BREW_BIN" --repository)"
BREW_OVERLAY="$(mktemp -d)"

cleanup() {
  if [ -d "$BREW_OVERLAY" ]; then
    git -C "$BREW_REPO" worktree remove --force "$BREW_OVERLAY" >/dev/null 2>&1 || rm -rf "$BREW_OVERLAY"
  fi
}
trap cleanup EXIT

git -C "$BREW_REPO" apply --check "$PATCH_FILE"
rm -rf "$BREW_OVERLAY"
git -C "$BREW_REPO" worktree add --detach "$BREW_OVERLAY" HEAD >/dev/null
git -C "$BREW_OVERLAY" apply --whitespace=nowarn "$PATCH_FILE"
BREW_BIN="$BREW_OVERLAY/bin/brew"

TAP_NAME="$(printf '%s' "$TAP_REPOSITORY" | tr '[:upper:]' '[:lower:]')"
"$BREW_BIN" tap "$TAP_NAME" "$TAP_ROOT"
TAPPED_ROOT="$("$BREW_BIN" --repository "$TAP_NAME")"
TAPPED_FORMULA="$TAPPED_ROOT/Formula/$FORMULA.rb"
if [ ! "$FORMULA_PATH" -ef "$TAPPED_FORMULA" ]; then
  cp "$FORMULA_PATH" "$TAPPED_FORMULA"
fi
(
  cd "$TAP_ROOT"
  HOMEBREW_KANDELO_BOTTLE_TAG="$TAG" \
  KANDELO_HOMEBREW_BOTTLE_TAG="$TAG" \
    "$BREW_BIN" bottle --merge --write --no-commit "$BOTTLE_JSON"
)
if [ ! "$FORMULA_PATH" -ef "$TAPPED_FORMULA" ]; then
  cp "$TAPPED_FORMULA" "$FORMULA_PATH"
fi

grep -F "root_url \"$EXPECTED_ROOT_URL\"" "$FORMULA_PATH" >/dev/null || {
  echo "homebrew-merge-bottle-json.sh: merged Formula root URL mismatch" >&2
  exit 1
}
grep -E "${TAG}: \"${EXPECTED_SHA256}\"" "$FORMULA_PATH" >/dev/null || {
  echo "homebrew-merge-bottle-json.sh: merged Formula digest mismatch" >&2
  exit 1
}
grep -F "sha256 cellar: $EXPECTED_CELLAR_DSL, $TAG: \"$EXPECTED_SHA256\"" "$FORMULA_PATH" >/dev/null || {
  echo "homebrew-merge-bottle-json.sh: merged Formula relocation cellar mismatch" >&2
  exit 1
}
echo "homebrew-merge-bottle-json.sh: merged $FORMULA/$TAG at $EXPECTED_SHA256"
