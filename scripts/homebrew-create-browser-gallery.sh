#!/usr/bin/env bash
# Create browser-gallery assets for a Homebrew-built precomposed VFS image.
set -euo pipefail

METADATA=""
IMAGE=""
REPORT=""
OUT_DIR=""
FORMULA=""
SOURCE_ID="kandelo-homebrew"
ENTRY_ID=""
TITLE=""
DESCRIPTION=""

usage() {
  cat >&2 <<'EOF'
usage: scripts/homebrew-create-browser-gallery.sh --metadata <Kandelo/metadata.json> --image <image.vfs.zst> --report <report.json> --out <dir> --formula <name> [--source-id <id>] [--entry-id <id>] [--title <title>] [--description <text>]

Writes gallery.json, index.toml, and a package-source-shaped .tar.zst archive
containing artifacts/<entry-id>.vfs.zst. The selected Homebrew metadata bottle
must be wasm32 success with browser_compatible=true.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --metadata) METADATA="${2:-}"; shift 2 ;;
    --image) IMAGE="${2:-}"; shift 2 ;;
    --report) REPORT="${2:-}"; shift 2 ;;
    --out) OUT_DIR="${2:-}"; shift 2 ;;
    --formula) FORMULA="${2:-}"; shift 2 ;;
    --source-id) SOURCE_ID="${2:-}"; shift 2 ;;
    --entry-id) ENTRY_ID="${2:-}"; shift 2 ;;
    --title) TITLE="${2:-}"; shift 2 ;;
    --description) DESCRIPTION="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "homebrew-create-browser-gallery.sh: unknown flag $1" >&2; usage; exit 2 ;;
  esac
done

require() {
  local name="$1" value="$2"
  if [ -z "$value" ]; then
    echo "homebrew-create-browser-gallery.sh: --$name is required" >&2
    exit 2
  fi
}

valid_id() {
  [[ "$1" =~ ^[a-z0-9][a-z0-9._-]*$ ]]
}

file_size() {
  if stat -f %z "$1" >/dev/null 2>&1; then
    stat -f %z "$1"
  else
    stat -c %s "$1"
  fi
}

toml_quote() {
  jq -Rn --arg value "$1" '$value'
}

require metadata "$METADATA"
require image "$IMAGE"
require report "$REPORT"
require out "$OUT_DIR"
require formula "$FORMULA"

if [ ! -f "$METADATA" ]; then echo "homebrew-create-browser-gallery.sh: metadata not found: $METADATA" >&2; exit 2; fi
if [ ! -f "$IMAGE" ]; then echo "homebrew-create-browser-gallery.sh: image not found: $IMAGE" >&2; exit 2; fi
if [ ! -f "$REPORT" ]; then echo "homebrew-create-browser-gallery.sh: report not found: $REPORT" >&2; exit 2; fi
if ! valid_id "$FORMULA"; then echo "homebrew-create-browser-gallery.sh: invalid formula id: $FORMULA" >&2; exit 2; fi
if ! valid_id "$SOURCE_ID"; then echo "homebrew-create-browser-gallery.sh: invalid source id: $SOURCE_ID" >&2; exit 2; fi
mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"

if [ -z "$ENTRY_ID" ]; then ENTRY_ID="${FORMULA}-homebrew-vfs"; fi
if [ -z "$TITLE" ]; then TITLE="${FORMULA} Homebrew VFS"; fi
if [ -z "$DESCRIPTION" ]; then DESCRIPTION="Precomposed Kandelo VFS image built from the published Homebrew ${FORMULA} bottle."; fi
if ! valid_id "$ENTRY_ID"; then echo "homebrew-create-browser-gallery.sh: invalid entry id: $ENTRY_ID" >&2; exit 2; fi

package_json="$(jq -c --arg formula "$FORMULA" 'first(.packages[] | select(.name == $formula)) // empty' "$METADATA")"
if [ -z "$package_json" ]; then
  echo "homebrew-create-browser-gallery.sh: formula not found in metadata: $FORMULA" >&2
  exit 1
fi
bottle_json="$(jq -c 'first(.bottles[] | select(.arch == "wasm32")) // empty' <<<"$package_json")"
if [ -z "$bottle_json" ]; then
  echo "homebrew-create-browser-gallery.sh: $FORMULA has no wasm32 bottle metadata" >&2
  exit 1
fi

status="$(jq -r '.status' <<<"$bottle_json")"
browser_compatible="$(jq -r '.browser_compatible' <<<"$bottle_json")"
if [ "$status" != "success" ]; then
  echo "homebrew-create-browser-gallery.sh: $FORMULA wasm32 metadata status is $status, expected success" >&2
  exit 1
fi
if [ "$browser_compatible" != "true" ]; then
  echo "homebrew-create-browser-gallery.sh: $FORMULA wasm32 metadata is not browser_compatible=true" >&2
  exit 1
fi

version="$(jq -r '.version' <<<"$package_json")"
abi="$(jq -r '.kandelo_abi' "$METADATA")"
generated_at="$(jq -r '.generated_at' "$METADATA")"
tap_repository="$(jq -r '.tap_repository' "$METADATA")"
tap_commit="$(jq -r '.tap_commit' "$METADATA")"
kandelo_repository="$(jq -r '.kandelo_repository' "$METADATA")"
kandelo_commit="$(jq -r '.kandelo_commit' "$METADATA")"
built_by="$(jq -r '.built_by' <<<"$bottle_json")"
image_sha="$(shasum -a 256 "$IMAGE" | awk '{print $1}')"
image_bytes="$(file_size "$IMAGE")"
short_sha="${image_sha:0:8}"
archive_name="${ENTRY_ID}-${version}-rev1-abi${abi}-wasm32-${short_sha}.tar.zst"

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/kandelo-homebrew-gallery.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT
mkdir -p "$work_dir/artifacts"
cp "$IMAGE" "$work_dir/artifacts/${ENTRY_ID}.vfs.zst"

cat >"$work_dir/manifest.toml" <<EOF
kind = "program"
name = $(toml_quote "$ENTRY_ID")
version = $(toml_quote "$version")
kernel_abi = $abi
depends_on = []
arches = ["wasm32"]

[source]
url = $(toml_quote "https://github.com/${tap_repository}/tree/${tap_commit}")
sha256 = "$image_sha"

[license]
spdx = "GPL-3.0-or-later"

[[outputs]]
name = $(toml_quote "$ENTRY_ID")
wasm = $(toml_quote "${ENTRY_ID}.vfs.zst")

[compatibility]
target_arch = "wasm32"
abi_versions = [$abi]
cache_key_sha = "$image_sha"
build_timestamp = $(toml_quote "$generated_at")
build_host = "kandelo-homebrew-browser-smoke"
EOF

(
  cd "$work_dir"
  tar -cf - manifest.toml artifacts | zstd -q -f -T0 -o "$OUT_DIR/$archive_name"
)

archive_sha="$(shasum -a 256 "$OUT_DIR/$archive_name" | awk '{print $1}')"
archive_bytes="$(file_size "$OUT_DIR/$archive_name")"

jq -n \
  --arg source_id "$SOURCE_ID" \
  --arg repository "$tap_repository" \
  --arg entry_id "$ENTRY_ID" \
  --arg title "$TITLE" \
  --arg description "$DESCRIPTION" \
  --arg name "$ENTRY_ID" \
  --arg version "$version" \
  '{
    source_id: $source_id,
    repository: $repository,
    index_url: "index.toml",
    entries: [
      {
        id: $entry_id,
        title: $title,
        description: $description,
        packages: [{ name: $name, version: $version }]
      }
    ]
  }' >"$OUT_DIR/gallery.json"

cat >"$OUT_DIR/index.toml" <<EOF
abi_version = $abi
generated_at = $(toml_quote "$generated_at")
generator = "kandelo-homebrew-browser-gallery 1"

[[packages]]
name = $(toml_quote "$ENTRY_ID")
version = $(toml_quote "$version")
revision = 1

[packages.binary.wasm32]
status = "success"
archive_url = $(toml_quote "$archive_name")
archive_sha256 = "$archive_sha"
archive_bytes = $archive_bytes
cache_key_sha = "$image_sha"
browser_compatible = true
source_metadata = "Kandelo/metadata.json"
source_report = $(toml_quote "$(basename "$REPORT")")
source_image_sha256 = "$image_sha"
source_image_bytes = $image_bytes
built_by = $(toml_quote "$built_by")
tap_repository = $(toml_quote "$tap_repository")
tap_commit = "$tap_commit"
kandelo_repository = $(toml_quote "$kandelo_repository")
kandelo_commit = "$kandelo_commit"
EOF

echo "homebrew-create-browser-gallery: wrote $OUT_DIR/gallery.json"
echo "homebrew-create-browser-gallery: wrote $OUT_DIR/index.toml"
echo "homebrew-create-browser-gallery: wrote $OUT_DIR/$archive_name"
