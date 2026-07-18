#!/usr/bin/env bash
# Compose one validated bottle JSON document into a clean tap checkout without
# loading Formula Ruby or invoking Homebrew.
set -euo pipefail

TAP_ROOT=""
TAP_REPOSITORY=""
TAP_NAME_INPUT=""
FORMULA=""
ARCH=""
BOTTLE_JSON=""
EXPECTED_SHA256=""
EXPECTED_ROOT_URL=""
EXPECTED_CELLAR=""
RELEASE_TAG=""

usage() {
  cat >&2 <<'EOF'
usage: scripts/homebrew-merge-bottle-json.sh --tap-root <dir> --tap-repository <owner/repo> [--tap-name <owner/name>] --formula <name> --arch <wasm32|wasm64> --release-tag <bottles-abi-vN> --bottle-json <path> --expected-sha256 <sha256> --expected-root-url <url> --expected-cellar <any|any_skip_relocation|canonical-cellar>
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --tap-root) TAP_ROOT="${2:-}"; shift 2 ;;
    --tap-repository) TAP_REPOSITORY="${2:-}"; shift 2 ;;
    --tap-name) TAP_NAME_INPUT="${2:-}"; shift 2 ;;
    --formula) FORMULA="${2:-}"; shift 2 ;;
    --arch) ARCH="${2:-}"; shift 2 ;;
    --release-tag) RELEASE_TAG="${2:-}"; shift 2 ;;
    --bottle-json) BOTTLE_JSON="${2:-}"; shift 2 ;;
    --expected-sha256) EXPECTED_SHA256="${2:-}"; shift 2 ;;
    --expected-root-url) EXPECTED_ROOT_URL="${2:-}"; shift 2 ;;
    --expected-cellar) EXPECTED_CELLAR="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "homebrew-merge-bottle-json.sh: unknown flag $1" >&2; usage; exit 2 ;;
  esac
done

for name in TAP_ROOT TAP_REPOSITORY FORMULA ARCH RELEASE_TAG BOTTLE_JSON EXPECTED_SHA256 EXPECTED_ROOT_URL EXPECTED_CELLAR; do
  if [ -z "${!name}" ]; then
    echo "homebrew-merge-bottle-json.sh: ${name,,} is required" >&2
    exit 2
  fi
done
if ! [[ "$TAP_REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  echo "homebrew-merge-bottle-json.sh: invalid tap repository" >&2
  exit 2
fi
KANDELO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=/dev/null
. "$KANDELO_ROOT/scripts/homebrew-tap-identity.sh"
TAP_NAME="$(homebrew_resolve_tap_name "$TAP_REPOSITORY" "$TAP_NAME_INPUT")"
EXPECTED_TAP_ROOT="$(homebrew_bottle_root_url "$TAP_REPOSITORY" "$TAP_NAME")"
if [ "$EXPECTED_ROOT_URL" != "$EXPECTED_TAP_ROOT" ]; then
  echo "homebrew-merge-bottle-json.sh: expected bottle root does not match the tap repository package root" >&2
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
if ! [[ "$RELEASE_TAG" =~ ^bottles-abi-v[0-9]+$ ]]; then
  echo "homebrew-merge-bottle-json.sh: invalid release tag" >&2
  exit 2
fi
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
if [ ! -f "$FORMULA_PATH" ] || [ -L "$FORMULA_PATH" ] || \
   [ ! -f "$BOTTLE_JSON" ] || [ -L "$BOTTLE_JSON" ]; then
  echo "homebrew-merge-bottle-json.sh: formula or bottle JSON is missing" >&2
  exit 2
fi

TAG="${ARCH}_kandelo"
FORMULA_JSON_PATH="Library/Taps/${TAP_NAME%%/*}/homebrew-${TAP_NAME#*/}/Formula/${FORMULA}.rb"
jq -e \
  --arg formula "$FORMULA" \
  --arg formula_path "$FORMULA_JSON_PATH" \
  --arg tag "$TAG" \
  --arg sha "$EXPECTED_SHA256" \
  --arg root "$EXPECTED_ROOT_URL" \
  --arg cellar "$EXPECTED_CELLAR" '
    (keys | length) == 1 and
    (to_entries[0].key == $formula) and
    (to_entries[0].value.formula.name == $formula) and
    (to_entries[0].value.formula.path == $formula_path) and
    (to_entries[0].value.bottle.root_url == $root) and
    (to_entries[0].value.bottle.cellar == $cellar) and
    (to_entries[0].value.bottle.rebuild | type == "number" and . >= 0 and floor == .) and
    (to_entries[0].value.bottle.tags | keys == [$tag]) and
    (to_entries[0].value.bottle.tags[$tag] | keys == ["sha256"]) and
    (to_entries[0].value.bottle.tags[$tag].sha256 == $sha)
  ' "$BOTTLE_JSON" >/dev/null || {
    echo "homebrew-merge-bottle-json.sh: bottle JSON identity or digest mismatch" >&2
    exit 1
  }

# shellcheck source=/dev/null
. "$KANDELO_ROOT/scripts/homebrew-sibling-bottle-policy.sh"
COMPOSER="$KANDELO_ROOT/scripts/homebrew-compose-formula-bottle.rb"
COMPOSED_FORMULA="$(mktemp "$TAP_ROOT/Formula/.${FORMULA}.XXXXXX")"

cleanup() {
  rm -f "$COMPOSED_FORMULA"
}
trap cleanup EXIT

REBUILD="$(jq -er '.[] | .bottle.rebuild' "$BOTTLE_JSON")"
PKG_VERSION="$(jq -er '.[] | .formula.pkg_version' "$BOTTLE_JSON")"
FORMULA_REVISION=0
if [[ "$PKG_VERSION" =~ _([1-9][0-9]*)$ ]]; then
  FORMULA_REVISION="${BASH_REMATCH[1]}"
fi
ABI_VERSION="${RELEASE_TAG#bottles-abi-v}"
SIBLING_POLICY="$(homebrew_sibling_bottle_policy \
  "$TAP_ROOT/Kandelo/metadata.json" "$FORMULA" "$PKG_VERSION" \
  "$FORMULA_REVISION" "$REBUILD" "$ABI_VERSION" \
  "$EXPECTED_ROOT_URL" "$FORMULA_PATH" \
  "homebrew-merge-bottle-json.sh")"
ruby "$COMPOSER" \
  "$FORMULA_PATH" \
  "$FORMULA_PATH" \
  "$EXPECTED_ROOT_URL" \
  "$REBUILD" \
  "$TAG" \
  "$EXPECTED_CELLAR" \
  "$EXPECTED_SHA256" \
  "$SIBLING_POLICY" \
  "$COMPOSED_FORMULA"
chmod --reference="$FORMULA_PATH" "$COMPOSED_FORMULA"
mv "$COMPOSED_FORMULA" "$FORMULA_PATH"

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
