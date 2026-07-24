#!/usr/bin/env bash
set -euo pipefail

PORTABLE_CACHE_REL=".ci-test-binary-cache"

if [ "$#" -ne 2 ]; then
  echo "usage: materialize-resolver-binaries.sh BINARIES_DIR CACHE_ROOT" >&2
  exit 2
fi

input="$1"
cache_root="$2"
if [ ! -d "$input" ] || [ -L "$input" ]; then
  echo "materialize-resolver-binaries.sh: binaries root is not a real directory: $input" >&2
  exit 2
fi

parent="$(cd "$(dirname "$input")" && pwd -P)"
name="$(basename "$input")"
case "$name" in
  ""|.|..) echo "materialize-resolver-binaries.sh: invalid binaries root" >&2; exit 2 ;;
esac
source_dir="$parent/$name"
portable_cache="$parent/$PORTABLE_CACHE_REL"
if [ -e "$portable_cache" ] || [ -L "$portable_cache" ]; then
  echo "materialize-resolver-binaries.sh: portable cache destination is already occupied: $portable_cache" >&2
  exit 2
fi

script_root="$(cd "$(dirname "$0")" && pwd -P)"

transaction="$(mktemp -d "$parent/.${name}.materialize.XXXXXX")"
stage_root="$transaction/staged"
mkdir "$stage_root"
staged_binaries="$stage_root/binaries"
staged_cache="$stage_root/$PORTABLE_CACHE_REL"
backup="$transaction/original"
original_move_started=0
binaries_installed=0
cache_installed=0

cleanup() {
  local status="$?" cleanup_status=0
  trap - EXIT
  if [ "$original_move_started" -eq 1 ]; then
    if [ "$binaries_installed" -eq 1 ] && \
       { [ -e "$source_dir" ] || [ -L "$source_dir" ]; } && \
       { [ ! -e "$staged_binaries" ] && [ ! -L "$staged_binaries" ]; }; then
      chmod -R u+rwX "$source_dir" 2>/dev/null &&
        mv "$source_dir" "$staged_binaries" || cleanup_status=1
    fi
    if { [ -e "$backup" ] || [ -L "$backup" ]; } && \
       { [ ! -e "$source_dir" ] && [ ! -L "$source_dir" ]; }; then
      mv "$backup" "$source_dir" || cleanup_status=1
    elif { [ ! -e "$backup" ] && [ ! -L "$backup" ]; } && \
         { [ -e "$source_dir" ] || [ -L "$source_dir" ]; }; then
      : # The original rename failed before changing the tree.
    else
      cleanup_status=1
    fi
    if [ "$cleanup_status" -ne 0 ]; then
      echo "materialize-resolver-binaries.sh: rollback failed; preserving $transaction" >&2
    fi
  fi
  if [ "$cache_installed" -eq 1 ]; then
    if [ -d "$portable_cache" ] && [ ! -L "$portable_cache" ]; then
      chmod -R u+rwX "$portable_cache" 2>/dev/null &&
        rm -rf -- "$portable_cache" || cleanup_status=1
    else
      cleanup_status=1
    fi
  fi
  if [ "$cleanup_status" -eq 0 ]; then
    if [ -d "$stage_root" ] && [ ! -L "$stage_root" ]; then
      chmod -R u+rwX "$stage_root" 2>/dev/null || cleanup_status=1
    fi
  fi
  if [ "$cleanup_status" -eq 0 ]; then
    rm -rf -- "$transaction" || cleanup_status=1
  fi
  [ "$status" -ne 0 ] || status="$cleanup_status"
  exit "$status"
}
trap cleanup EXIT

# WHY: package mirrors are symlinks into one content-addressed generation.
# Flattening those links would discard the identity the resolver uses to stop
# cross-generation package composition. Transport the complete generations
# with the same helper used by prepared conformance workspaces instead.
bash "$script_root/stage-portable-resolver-binaries.sh" \
  "$source_dir" "$cache_root" "$stage_root"
if [ ! -d "$staged_cache/programs" ] || [ -L "$staged_cache" ] || \
   [ -L "$staged_cache/programs" ]; then
  echo "materialize-resolver-binaries.sh: Formula runtime contains no portable program cache" >&2
  exit 1
fi

# Install the cache first. No Formula consumer exists during this preparation
# window, and rollback removes it if replacing binaries/ does not complete.
mv "$staged_cache" "$portable_cache"
cache_installed=1
original_move_started=1
mv "$source_dir" "$backup"
if ! mv "$staged_binaries" "$source_dir"; then
  echo "materialize-resolver-binaries.sh: could not install the portable resolver tree" >&2
  exit 1
fi
binaries_installed=1
find "$source_dir" "$portable_cache" -xdev -type d -exec chmod 0555 {} +
find "$source_dir" "$portable_cache" -xdev -type f -exec chmod 0444 {} +
# WHY: once the complete replacement and portable cache are read-only, they
# are the authoritative pair. Deleting the backup can partially succeed, so
# rolling back after that point could restore an incomplete original tree.
original_move_started=0
binaries_installed=0
cache_installed=0
if ! rm -rf -- "$backup"; then
  echo "materialize-resolver-binaries.sh: could not remove the original resolver tree; preserving $transaction" >&2
  trap - EXIT
  exit 1
fi
rmdir "$stage_root" "$transaction"
trap - EXIT
