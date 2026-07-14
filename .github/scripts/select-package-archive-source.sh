#!/usr/bin/env bash
set -euo pipefail

CANONICAL_ASSETS=""
STAGING_ASSETS=""
CANONICAL_TAG=""
STAGING_TAG=""
PREFIX=""
SUFFIX=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --canonical-assets) CANONICAL_ASSETS="$2"; shift 2 ;;
    --staging-assets) STAGING_ASSETS="$2"; shift 2 ;;
    --canonical-tag) CANONICAL_TAG="$2"; shift 2 ;;
    --staging-tag) STAGING_TAG="$2"; shift 2 ;;
    --prefix) PREFIX="$2"; shift 2 ;;
    --suffix) SUFFIX="$2"; shift 2 ;;
    *) echo "select-package-archive-source: unknown flag $1" >&2; exit 2 ;;
  esac
done

for file in "$CANONICAL_ASSETS" "$STAGING_ASSETS"; do
  if [ -z "$file" ] || [ ! -f "$file" ]; then
    echo "select-package-archive-source: asset metadata file is required: $file" >&2
    exit 2
  fi
done
if [ -z "$CANONICAL_TAG" ] || [ -z "$STAGING_TAG" ] ||
   [ -z "$PREFIX" ] || [ -z "$SUFFIX" ]; then
  echo "select-package-archive-source: tags, prefix, and suffix are required" >&2
  exit 2
fi

for file in "$CANONICAL_ASSETS" "$STAGING_ASSETS"; do
  if ! jq -e '
      type == "array" and
      all(.[];
        type == "object" and
        (.name | type == "string") and
        (.size | type == "number") and
        ((.digest // "") | type == "string"))
    ' "$file" >/dev/null
  then
    echo "select-package-archive-source: malformed asset metadata in $file" >&2
    exit 1
  fi
done

select_match() {
  local file="$1" label="$2" tag="$3" matches count asset name digest size
  matches=$(jq -c --arg prefix "$PREFIX" --arg suffix "$SUFFIX" '
    [.[] | select(.name | startswith($prefix) and endswith($suffix))]
  ' "$file")
  count=$(jq 'length' <<<"$matches")
  if [ "$count" -gt 1 ]; then
    echo "select-package-archive-source: multiple $label assets match $PREFIX*$SUFFIX" >&2
    exit 1
  fi
  if [ "$count" -eq 0 ]; then
    return 1
  fi

  asset=$(jq -c '.[0]' <<<"$matches")
  name=$(jq -r .name <<<"$asset")
  digest=$(jq -r '.digest // ""' <<<"$asset")
  size=$(jq -r .size <<<"$asset")
  if ! [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    echo "select-package-archive-source: $label asset $name has no trustworthy sha256 digest" >&2
    exit 1
  fi
  if ! [[ "$size" =~ ^[0-9]+$ ]] || [ "$size" = 0 ]; then
    echo "select-package-archive-source: $label asset $name has invalid size $size" >&2
    exit 1
  fi

  jq -nc \
    --arg source "$label" \
    --arg source_tag "$tag" \
    --arg archive_name "$name" \
    --arg archive_sha256 "${digest#sha256:}" \
    --argjson archive_size "$size" \
    '{
      source: $source,
      source_tag: $source_tag,
      archive_name: $archive_name,
      archive_sha256: $archive_sha256,
      archive_size: $archive_size
    }'
  return 0
}

# Canonical bytes are immutable and already resolver-visible. Prefer them even
# when a PR staging release contains an archive with the same cache-key name:
# run-specific manifest provenance can make those staging bytes differ.
if select_match "$CANONICAL_ASSETS" canonical "$CANONICAL_TAG"; then
  exit 0
fi
if select_match "$STAGING_ASSETS" staging "$STAGING_TAG"; then
  exit 0
fi
jq -nc '{source: "build"}'
