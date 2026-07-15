#!/usr/bin/env bash
# Validate an upload receipt and its exact build handoff in a fresh job.
set -euo pipefail

RECEIPT=""
HANDOFF=""
FORMULA=""
ARCH=""
RELEASE_TAG=""
TAP_REPOSITORY=""
TAP_NAME_INPUT=""
TAP_COMMIT=""
KANDELO_COMMIT=""
BOTTLE_ROOT_URL=""
OUT_ENV=""
OUT_BOTTLE_JSON=""
ALLOW_DRY_RUN=0
FORBIDDEN_ROOTS=()

usage() {
  cat >&2 <<'EOF'
usage: scripts/homebrew-validate-upload-receipt.sh --receipt <json> --handoff <dir> --formula <name> --arch <wasm32|wasm64> --release-tag <tag> --tap-repository <owner/repo> [--tap-name <owner/name>] --tap-commit <sha> --kandelo-commit <sha> --bottle-root-url <url> --forbidden-root <absolute-path> [--forbidden-root <absolute-path> ...] [--out-env <path>] [--out-bottle-json <path>] [--allow-dry-run]

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
    --tap-name) TAP_NAME_INPUT="${2:-}"; shift 2 ;;
    --tap-commit) TAP_COMMIT="${2:-}"; shift 2 ;;
    --kandelo-commit) KANDELO_COMMIT="${2:-}"; shift 2 ;;
    --bottle-root-url) BOTTLE_ROOT_URL="${2:-}"; shift 2 ;;
    --out-env) OUT_ENV="${2:-}"; shift 2 ;;
    --out-bottle-json) OUT_BOTTLE_JSON="${2:-}"; shift 2 ;;
    --allow-dry-run) ALLOW_DRY_RUN=1; shift ;;
    --forbidden-root)
      [ "$#" -ge 2 ] && [ -n "$2" ] || {
        echo "homebrew-validate-upload-receipt.sh: --forbidden-root requires a value" >&2
        exit 2
      }
      FORBIDDEN_ROOTS+=("$2")
      shift 2
      ;;
    -h|--help) usage; exit 0 ;;
    *) echo "homebrew-validate-upload-receipt.sh: unknown flag $1" >&2; usage; exit 2 ;;
  esac
done

if [ "${#FORBIDDEN_ROOTS[@]}" -eq 0 ]; then
  echo "homebrew-validate-upload-receipt.sh: at least one --forbidden-root is required" >&2
  exit 2
fi

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
# shellcheck source=/dev/null
. "$SCRIPT_ROOT/homebrew-tap-identity.sh"
TAP_NAME="$(homebrew_resolve_tap_name "$TAP_REPOSITORY" "$TAP_NAME_INPUT")"
validation_tmp="$(mktemp -d)"
trap 'rm -rf "$validation_tmp"' EXIT
build_env="$validation_tmp/build.env"
build_validation_args=(
  --handoff "$HANDOFF"
  --formula "$FORMULA"
  --arch "$ARCH"
  --release-tag "$RELEASE_TAG"
  --tap-repository "$TAP_REPOSITORY"
  --tap-name "$TAP_NAME"
  --tap-commit "$TAP_COMMIT"
  --kandelo-commit "$KANDELO_COMMIT"
  --bottle-root-url "$BOTTLE_ROOT_URL"
  --out-env "$build_env"
)
for forbidden_root in "${FORBIDDEN_ROOTS[@]}"; do
  build_validation_args+=(--forbidden-root "$forbidden_root")
done
bash "$SCRIPT_ROOT/homebrew-validate-build-handoff.sh" \
  "${build_validation_args[@]}" >/dev/null
# shellcheck disable=SC1090
. "$build_env"

EXPECTED_URL="${BOTTLE_ROOT_URL}/${FORMULA}/blobs/sha256:${BOTTLE_SHA256}"
case "$BOTTLE_ROOT_URL" in
  https://ghcr.io/v2/*) image_root="ghcr.io/${BOTTLE_ROOT_URL#https://ghcr.io/v2/}" ;;
  *) image_root="${BOTTLE_ROOT_URL#https://}" ;;
esac
EXPECTED_REMOTE="${image_root}/${FORMULA}"
EXPECTED_ABI="${RELEASE_TAG#bottles-abi-v}"

layout_receipt="$validation_tmp/layout-receipt.json"
jq -e '.layout' "$RECEIPT" >"$layout_receipt" || {
  echo "homebrew-validate-upload-receipt.sh: receipt lacks a child layout receipt" >&2
  exit 1
}
python3 "$SCRIPT_ROOT/homebrew-oci-layout.py" validate-child-receipt \
  --receipt "$layout_receipt"
if command -v sha256sum >/dev/null 2>&1; then
  actual_layout_receipt_sha256="$(jq -cS '.layout' "$RECEIPT" | sha256sum | awk '{print $1}')"
else
  actual_layout_receipt_sha256="$(jq -cS '.layout' "$RECEIPT" | shasum -a 256 | awk '{print $1}')"
fi

if ! jq -e \
  --arg formula "$FORMULA" \
  --arg arch "$ARCH" \
  --arg abi "$EXPECTED_ABI" \
  --arg tap_repository "$TAP_REPOSITORY" \
  --arg tap_name "$TAP_NAME" \
  --arg tap_commit "$TAP_COMMIT" \
  --arg kandelo_commit "$KANDELO_COMMIT" \
  --arg url "$EXPECTED_URL" \
  --arg sha256 "$BOTTLE_SHA256" \
  --arg bytes "$BOTTLE_BYTES" \
  --arg remote "$EXPECTED_REMOTE" \
  --arg layout_receipt_sha256 "$actual_layout_receipt_sha256" \
  --argjson allow_dry_run "$ALLOW_DRY_RUN" '
    def exact_keys($expected):
      type == "object" and keys == ($expected | sort);
    exact_keys([
      "formula", "kind", "layout", "layout_receipt_sha256", "publication", "schema",
      "tap_name", "tap_repository"
    ]) and
    .schema == 3 and
    .kind == "child" and
    .formula == $formula and
    (.tap_repository | ascii_downcase) == ($tap_repository | ascii_downcase) and
    .tap_name == $tap_name and
    .layout_receipt_sha256 == $layout_receipt_sha256 and
    .layout.kind == "child" and
    .layout.formula == $formula and
    .layout.arch == $arch and
    .layout.abi == ($abi | tonumber) and
    .layout.tap_commit == $tap_commit and
    .layout.kandelo_commit == $kandelo_commit and
    (.layout.tap_repository | ascii_downcase) == ($tap_repository | ascii_downcase) and
    .layout.tap_name == $tap_name and
    .layout.bottle.url == $url and
    .layout.bottle.sha256 == $sha256 and
    .layout.bottle.bytes == ($bytes | tonumber) and
    (.publication | exact_keys([
      "digest", "previous_digest", "public_readback_digest", "reference", "remote", "status"
    ])) and
    .publication.remote == $remote and
    .publication.reference == .layout.oci.transport_tag and
    .publication.digest == .layout.oci.manifest.digest and
    .publication.previous_digest == null and
    (if $allow_dry_run == 1 then
      .publication.status == "dry-run" and .publication.public_readback_digest == null
    else
      (.publication.status == "uploaded" or .publication.status == "already-present") and
      .publication.public_readback_digest == .publication.digest
    end)
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
    printf 'BOTTLE_IMAGE=%q\n' "$EXPECTED_REMOTE:$(jq -r '.publication.reference' "$RECEIPT")"
  } >"$out_tmp"
  mv "$out_tmp" "$out_path"
fi

echo "homebrew-validate-upload-receipt.sh: validated $FORMULA/$ARCH"
