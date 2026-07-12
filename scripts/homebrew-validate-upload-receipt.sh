#!/usr/bin/env bash
# Validate an upload receipt and its exact build handoff in a fresh job.
set -euo pipefail

RECEIPT=""
HANDOFF=""
FORMULA=""
ARCH=""
RELEASE_TAG=""
TAP_REPOSITORY=""
TAP_COMMIT=""
KANDELO_COMMIT=""
BOTTLE_ROOT_URL=""
OUT_ENV=""
OUT_BOTTLE_JSON=""

usage() {
  cat >&2 <<'EOF'
usage: scripts/homebrew-validate-upload-receipt.sh --receipt <json> --handoff <dir> --formula <name> --arch <wasm32|wasm64> --release-tag <tag> --tap-repository <owner/repo> --tap-commit <sha> --kandelo-commit <sha> --bottle-root-url <url> [--out-env <path>] [--out-bottle-json <path>]

Revalidates the build handoff, then checks the strict upload receipt against
the plan identity and the handoff's recomputed bottle digest and byte count.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --receipt) RECEIPT="${2:-}"; shift 2 ;;
    --handoff) HANDOFF="${2:-}"; shift 2 ;;
    --formula) FORMULA="${2:-}"; shift 2 ;;
    --arch) ARCH="${2:-}"; shift 2 ;;
    --release-tag) RELEASE_TAG="${2:-}"; shift 2 ;;
    --tap-repository) TAP_REPOSITORY="${2:-}"; shift 2 ;;
    --tap-commit) TAP_COMMIT="${2:-}"; shift 2 ;;
    --kandelo-commit) KANDELO_COMMIT="${2:-}"; shift 2 ;;
    --bottle-root-url) BOTTLE_ROOT_URL="${2:-}"; shift 2 ;;
    --out-env) OUT_ENV="${2:-}"; shift 2 ;;
    --out-bottle-json) OUT_BOTTLE_JSON="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "homebrew-validate-upload-receipt.sh: unknown flag $1" >&2; usage; exit 2 ;;
  esac
done

require() {
  local name="$1" value="$2"
  if [ -z "$value" ]; then
    echo "homebrew-validate-upload-receipt.sh: --$name is required" >&2
    exit 2
  fi
}

for requirement in \
  "receipt:$RECEIPT" \
  "handoff:$HANDOFF" \
  "formula:$FORMULA" \
  "arch:$ARCH" \
  "release-tag:$RELEASE_TAG" \
  "tap-repository:$TAP_REPOSITORY" \
  "tap-commit:$TAP_COMMIT" \
  "kandelo-commit:$KANDELO_COMMIT" \
  "bottle-root-url:$BOTTLE_ROOT_URL"; do
  require "${requirement%%:*}" "${requirement#*:}"
done

if [ ! -f "$RECEIPT" ] || [ -L "$RECEIPT" ]; then
  echo "homebrew-validate-upload-receipt.sh: receipt must be a regular non-symlink file: $RECEIPT" >&2
  exit 1
fi
receipt_bytes="$(wc -c <"$RECEIPT" | tr -d '[:space:]')"
if ! [[ "$receipt_bytes" =~ ^[0-9]+$ ]] || [ "$receipt_bytes" -gt 65536 ]; then
  echo "homebrew-validate-upload-receipt.sh: receipt exceeds 65536 bytes" >&2
  exit 1
fi

SCRIPT_ROOT="$(cd "$(dirname "$0")" && pwd -P)"
validation_tmp="$(mktemp -d)"
trap 'rm -rf "$validation_tmp"' EXIT
build_env="$validation_tmp/build.env"
build_validation_args=(
  --handoff "$HANDOFF"
  --formula "$FORMULA"
  --arch "$ARCH"
  --release-tag "$RELEASE_TAG"
  --tap-repository "$TAP_REPOSITORY"
  --tap-commit "$TAP_COMMIT"
  --kandelo-commit "$KANDELO_COMMIT"
  --bottle-root-url "$BOTTLE_ROOT_URL"
  --out-env "$build_env"
)
bash "$SCRIPT_ROOT/homebrew-validate-build-handoff.sh" \
  "${build_validation_args[@]}" >/dev/null
# shellcheck disable=SC1090
. "$build_env"

EXPECTED_URL="${BOTTLE_ROOT_URL}/${FORMULA}/blobs/sha256:${BOTTLE_SHA256}"
case "$BOTTLE_ROOT_URL" in
  https://ghcr.io/v2/*) image_root="ghcr.io/${BOTTLE_ROOT_URL#https://ghcr.io/v2/}" ;;
  *) image_root="${BOTTLE_ROOT_URL#https://}" ;;
esac
EXPECTED_IMAGE="${image_root}/${FORMULA}:${RELEASE_TAG}-${ARCH}-${BOTTLE_SHA256:0:12}"

if ! jq -e \
  --arg formula "$FORMULA" \
  --arg arch "$ARCH" \
  --arg release_tag "$RELEASE_TAG" \
  --arg tap_commit "$TAP_COMMIT" \
  --arg kandelo_commit "$KANDELO_COMMIT" \
  --arg url "$EXPECTED_URL" \
  --arg sha256 "$BOTTLE_SHA256" \
  --arg bytes "$BOTTLE_BYTES" \
  --arg image "$EXPECTED_IMAGE" '
    def exact_keys($expected):
      type == "object" and keys == ($expected | sort);
    exact_keys([
      "arch", "bottle", "formula", "kandelo_commit", "release_tag", "schema", "tap_commit"
    ]) and
    .schema == 1 and
    .formula == $formula and
    .arch == $arch and
    .release_tag == $release_tag and
    .tap_commit == $tap_commit and
    .kandelo_commit == $kandelo_commit and
    (.bottle | exact_keys(["bytes", "image", "sha256", "url"])) and
    .bottle.url == $url and
    .bottle.sha256 == $sha256 and
    .bottle.bytes == ($bytes | tonumber) and
    .bottle.image == $image
  ' "$RECEIPT" >/dev/null; then
  echo "homebrew-validate-upload-receipt.sh: receipt schema, identity, or bottle evidence does not match the validated build handoff" >&2
  exit 1
fi

if [ -n "$OUT_BOTTLE_JSON" ]; then
  receipt_path="$(cd "$(dirname "$RECEIPT")" && pwd -P)/$(basename "$RECEIPT")"
  bottle_json_parent="$(dirname "$OUT_BOTTLE_JSON")"
  mkdir -p "$bottle_json_parent"
  bottle_json_path="$(cd "$bottle_json_parent" && pwd -P)/$(basename "$OUT_BOTTLE_JSON")"
  if [ "$bottle_json_path" = "$receipt_path" ]; then
    echo "homebrew-validate-upload-receipt.sh: --out-bottle-json must not replace the receipt" >&2
    exit 2
  fi
  if [ -n "$OUT_ENV" ]; then
    out_env_parent="$(dirname "$OUT_ENV")"
    mkdir -p "$out_env_parent"
    out_env_path="$(cd "$out_env_parent" && pwd -P)/$(basename "$OUT_ENV")"
    if [ "$bottle_json_path" = "$out_env_path" ]; then
      echo "homebrew-validate-upload-receipt.sh: --out-env and --out-bottle-json must differ" >&2
      exit 2
    fi
  fi
  bash "$SCRIPT_ROOT/homebrew-validate-build-handoff.sh" \
    "${build_validation_args[@]}" \
    --out-bottle-json "$OUT_BOTTLE_JSON" >/dev/null
  # shellcheck disable=SC1090
  . "$build_env"
fi

if [ -n "$OUT_ENV" ]; then
  out_parent="$(dirname "$OUT_ENV")"
  mkdir -p "$out_parent"
  out_parent="$(cd "$out_parent" && pwd -P)"
  out_path="$out_parent/$(basename "$OUT_ENV")"
  handoff_path="$(cd "$HANDOFF" && pwd -P)"
  receipt_path="$(cd "$(dirname "$RECEIPT")" && pwd -P)/$(basename "$RECEIPT")"
  case "$out_path" in
    "$handoff_path"/*)
      echo "homebrew-validate-upload-receipt.sh: --out-env must be outside the handoff" >&2
      exit 2
      ;;
  esac
  if [ "$out_path" = "$receipt_path" ]; then
    echo "homebrew-validate-upload-receipt.sh: --out-env must not replace the receipt" >&2
    exit 2
  fi
  if [ -L "$out_path" ]; then
    echo "homebrew-validate-upload-receipt.sh: refusing to replace symlink output: $out_path" >&2
    exit 2
  fi
  out_tmp="$(mktemp "$out_parent/.homebrew-upload-receipt.XXXXXX")"
  {
    cat "$build_env"
    printf 'BOTTLE_URL=%q\n' "$EXPECTED_URL"
    printf 'BOTTLE_IMAGE=%q\n' "$EXPECTED_IMAGE"
  } >"$out_tmp"
  mv "$out_tmp" "$out_path"
fi

echo "homebrew-validate-upload-receipt.sh: validated $FORMULA/$ARCH"
