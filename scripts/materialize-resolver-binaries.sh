#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: materialize-resolver-binaries.sh BINARIES_DIR" >&2
  exit 2
fi

input="$1"
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

unsafe_entry="$(find "$source_dir" -xdev \
  \( ! \( -type d -o -type f -o -type l \) -o \
     \( -type f -links +1 \) \) -print -quit)"
if [ -n "$unsafe_entry" ]; then
  echo "materialize-resolver-binaries.sh: unsupported resolver entry: $unsafe_entry" >&2
  exit 1
fi
unresolved_link="$(find "$source_dir" -xdev -type l \
  ! -exec test -f {} \; -print -quit)"
if [ -n "$unresolved_link" ]; then
  echo "materialize-resolver-binaries.sh: resolver link is not a readable regular file: $unresolved_link" >&2
  exit 1
fi

transaction="$(mktemp -d "$parent/.${name}.materialize.XXXXXX")"
staged="$transaction/staged"
backup="$transaction/original"
original_move_started=0
replacement_installed=0

cleanup() {
  local status="$?" cleanup_status=0
  trap - EXIT
  if [ "$original_move_started" -eq 1 ] && [ "$replacement_installed" -eq 0 ]; then
    if { [ -e "$backup" ] || [ -L "$backup" ]; } && \
       { [ ! -e "$source_dir" ] && [ ! -L "$source_dir" ]; }; then
      mv "$backup" "$source_dir" || cleanup_status=1
    elif { [ -e "$backup" ] || [ -L "$backup" ]; } && \
         { [ -e "$source_dir" ] || [ -L "$source_dir" ]; } && \
         { [ ! -e "$staged" ] && [ ! -L "$staged" ]; }; then
      chmod -R u+rwX "$source_dir" && \
        mv "$source_dir" "$staged" && mv "$backup" "$source_dir" || cleanup_status=1
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
  if [ "$cleanup_status" -eq 0 ]; then
    if [ -d "$staged" ] && [ ! -L "$staged" ]; then
      chmod -R u+rwX "$staged" 2>/dev/null || cleanup_status=1
    fi
  fi
  if [ "$cleanup_status" -eq 0 ]; then
    rm -rf "$transaction" || cleanup_status=1
  fi
  [ "$status" -ne 0 ] || status="$cleanup_status"
  exit "$status"
}
trap cleanup EXIT

# Resolver output links point into a per-user cache. Copy through those links
# while the trusted workflow identity can still read them so the later
# read-only source bind is a complete execution closure.
cp -aLx -- "$source_dir" "$staged"

unsafe_entry="$(find "$staged" -xdev ! \( -type d -o -type f \) -print -quit)"
if [ -n "$unsafe_entry" ]; then
  echo "materialize-resolver-binaries.sh: staged tree is not self-contained: $unsafe_entry" >&2
  exit 1
fi
if [ -z "$(find "$staged" -xdev -type f -print -quit)" ]; then
  echo "materialize-resolver-binaries.sh: staged tree contains no binary files" >&2
  exit 1
fi
if ! find "$source_dir" -xdev -type l -exec bash -c '
  source_root="$1"
  staged_root="$2"
  shift 2
  for link in "$@"; do
    relative="${link#"$source_root"/}"
    [ "$relative" != "$link" ] && [ -f "$staged_root/$relative" ] && \
      cmp -s -- "$link" "$staged_root/$relative" || exit 1
  done
' bash "$source_dir" "$staged" {} +; then
  echo "materialize-resolver-binaries.sh: staged bytes differ from resolver output" >&2
  exit 1
fi

original_move_started=1
mv "$source_dir" "$backup"
if ! mv "$staged" "$source_dir"; then
  echo "materialize-resolver-binaries.sh: could not install the self-contained tree" >&2
  exit 1
fi
find "$source_dir" -xdev -type d -exec chmod 0555 {} +
find "$source_dir" -xdev -type f -exec chmod 0444 {} +
replacement_installed=1
if ! rm -rf "$backup"; then
  echo "materialize-resolver-binaries.sh: could not remove resolver cache links" >&2
  exit 1
fi
original_move_started=0
rmdir "$transaction"
trap - EXIT
