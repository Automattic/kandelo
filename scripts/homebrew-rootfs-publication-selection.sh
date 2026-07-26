#!/usr/bin/env bash
# Validate the deliberately bounded schema-1 rootfs bottle selection.
set -euo pipefail

FORMULAE=""
ARCHES=""
REQUIRE_VFS_ACCEPTANCE=""

# WHY: the preserved schema-1 rootfs generation contains only the first
# wasm32 bottle wave. Keep this allowlist explicit so adding another Formula
# requires a reviewed Kandelo policy change instead of silently broadening the
# authority of an older package generation.
readonly ROOTFS_WASM32_ALLOWED_FORMULAE=(bash dinit m4)

fail() {
  echo "::error::homebrew-rootfs-publication-selection: $*" >&2
  exit 2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --formulae)
      [ "$#" -ge 2 ] || fail "--formulae requires a value"
      FORMULAE="$2"
      shift 2
      ;;
    --arches)
      [ "$#" -ge 2 ] || fail "--arches requires a value"
      ARCHES="$2"
      shift 2
      ;;
    --require-vfs-acceptance)
      [ "$#" -ge 2 ] || fail "--require-vfs-acceptance requires a value"
      REQUIRE_VFS_ACCEPTANCE="$2"
      shift 2
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
done

normalize_selection() {
  printf '%s\n' "$1" |
    tr ',[:space:]' '\n' |
    sed '/^$/d' |
    sort -u |
    paste -sd, -
}

normalized_formulae="$(normalize_selection "$FORMULAE")"
normalized_arches="$(normalize_selection "$ARCHES")"

[ -n "$normalized_formulae" ] ||
  fail "the rootfs-wasm32 publication lane requires at least one Formula"
[ "$normalized_arches" = "wasm32" ] ||
  fail "the rootfs-wasm32 publication lane supports exactly wasm32"

# WHY: this generation predates dependency-bearing VFS acceptance inputs. A
# successful bottle build is valid, but claiming that newer acceptance graph
# from these older package inputs would manufacture evidence they do not carry.
[ "$REQUIRE_VFS_ACCEPTANCE" = "false" ] ||
  fail "the rootfs-wasm32 publication lane cannot materialize the legacy VFS acceptance image"

IFS=, read -r -a selected_formulae <<<"$normalized_formulae"
for formula in "${selected_formulae[@]}"; do
  allowed=false
  for allowed_formula in "${ROOTFS_WASM32_ALLOWED_FORMULAE[@]}"; do
    if [ "$formula" = "$allowed_formula" ]; then
      allowed=true
      break
    fi
  done
  [ "$allowed" = "true" ] ||
    fail "the rootfs-wasm32 publication lane does not admit Formula: $formula"
done
