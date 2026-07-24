#!/usr/bin/env bash
set -euo pipefail

PORTABLE_CACHE_REL=".ci-test-binary-cache"

if [ "$#" -ne 3 ]; then
  echo "usage: stage-portable-resolver-binaries.sh BINARIES_DIR CACHE_ROOT STAGE_ROOT" >&2
  exit 2
fi

input="$1"
cache_root="$2"
stage_root="$3"

if [ ! -d "$input" ] || [ -L "$input" ]; then
  echo "stage-portable-resolver-binaries: binaries root is not a real directory: $input" >&2
  exit 2
fi
source_parent="$(cd "$(dirname "$input")" && pwd -P)"
source_name="$(basename "$input")"
case "$source_name" in
  ""|.|..)
    echo "stage-portable-resolver-binaries: invalid binaries root" >&2
    exit 2
    ;;
esac
source_dir="$source_parent/$source_name"

case "$cache_root" in
  /*) ;;
  *)
    echo "stage-portable-resolver-binaries: cache root must be absolute: $cache_root" >&2
    exit 2
    ;;
esac
source_program_cache="$cache_root/programs"

if [ ! -d "$stage_root" ] || [ -L "$stage_root" ]; then
  echo "stage-portable-resolver-binaries: stage root is not a real directory: $stage_root" >&2
  exit 2
fi
stage_root="$(cd "$stage_root" && pwd -P)"
staged_binaries="$stage_root/binaries"
staged_cache="$stage_root/$PORTABLE_CACHE_REL"
for destination in "$staged_binaries" "$staged_cache"; do
  if [ -e "$destination" ] || [ -L "$destination" ]; then
    echo "stage-portable-resolver-binaries: stage destination is already occupied: $destination" >&2
    exit 2
  fi
done

unsafe_entry="$(find "$source_dir" -xdev \
  \( ! \( -type d -o -type f -o -type l \) -o \
     \( -type f -links +1 \) \) -print -quit)"
if [ -n "$unsafe_entry" ]; then
  echo "stage-portable-resolver-binaries: unsupported resolver entry: $unsafe_entry" >&2
  exit 1
fi
unresolved_link="$(find "$source_dir" -xdev -type l \
  ! -exec test -f {} \; -print -quit)"
if [ -n "$unresolved_link" ]; then
  echo "stage-portable-resolver-binaries: resolver link is not a readable regular file: $unresolved_link" >&2
  exit 1
fi
flattened_program="$(
  find "$source_dir/programs" -xdev -type f -print -quit 2>/dev/null || true
)"
if [ -n "$flattened_program" ]; then
  echo "stage-portable-resolver-binaries: fetched program mirrors must remain generation symlinks: $flattened_program" >&2
  exit 1
fi

cp -a -- "$source_dir" "$staged_binaries"

relative_cache_link() {
  local mirror_relative="$1"
  local cache_relative="$2"
  local parent=""
  case "$mirror_relative" in
    */*) parent="${mirror_relative%/*}" ;;
  esac
  # The mirror is below binaries/, while the transported cache is its sibling
  # at the repository root. Keep the link relative so the complete pair can be
  # moved behind a read-only source alias without retaining a runner path.
  local prefix="../"
  while [ -n "$parent" ]; do
    prefix="../$prefix"
    case "$parent" in
      */*) parent="${parent%/*}" ;;
      *) parent="" ;;
    esac
  done
  printf '%s%s/programs/%s\n' \
    "$prefix" "$PORTABLE_CACHE_REL" "$cache_relative"
}

has_program_links=0
if find "$source_dir/programs" -xdev -type l -print -quit 2>/dev/null |
   grep -q .; then
  has_program_links=1
  if [ ! -d "$cache_root" ] || [ -L "$cache_root" ]; then
    echo "stage-portable-resolver-binaries: cache root is not a real directory: $cache_root" >&2
    exit 2
  fi
  cache_root="$(cd "$cache_root" && pwd -P)"
  source_program_cache="$cache_root/programs"
  if [ ! -d "$source_program_cache" ] || [ -L "$source_program_cache" ]; then
    echo "stage-portable-resolver-binaries: program links exist but the canonical cache is unavailable: $source_program_cache" >&2
    exit 1
  fi
  source_program_cache="$(cd "$source_program_cache" && pwd -P)"
  mkdir -p "$staged_cache/programs"
fi

while IFS= read -r -d '' mirror; do
  mirror_relative="${mirror#"$source_dir"/}"
  if [ "$mirror_relative" = "$mirror" ]; then
    echo "stage-portable-resolver-binaries: resolver link escaped binaries/: $mirror" >&2
    exit 1
  fi
  target="$(realpath -- "$mirror")"
  if [ ! -f "$target" ] || [ -L "$target" ]; then
    echo "stage-portable-resolver-binaries: resolver link is not a canonical regular file: $mirror" >&2
    exit 1
  fi

  staged_mirror="$staged_binaries/$mirror_relative"
  rm -- "$staged_mirror"
  case "$mirror_relative" in
    programs/*)
      case "$target" in
        "$source_program_cache"/*)
          cache_relative="${target#"$source_program_cache"/}"
          ;;
        *)
          echo "stage-portable-resolver-binaries: program resolver link targets a noncanonical cache: $mirror -> $target" >&2
          exit 1
          ;;
      esac
      generation="${cache_relative%%/*}"
      if [ -z "$generation" ] || [ "$generation" = "$cache_relative" ]; then
        echo "stage-portable-resolver-binaries: program resolver link has no generation member: $mirror -> $target" >&2
        exit 1
      fi
      source_generation="$source_program_cache/$generation"
      if [ ! -d "$source_generation" ] || [ -L "$source_generation" ] ||
         [ "$(cd "$source_generation" && pwd -P)" != "$source_generation" ]; then
        echo "stage-portable-resolver-binaries: program generation is not one direct real cache child: $source_generation" >&2
        exit 1
      fi
      if [ ! -e "$staged_cache/programs/$generation" ]; then
        cp -a -- "$source_generation" "$staged_cache/programs/$generation"
      fi
      ln -s \
        "$(relative_cache_link "$mirror_relative" "$cache_relative")" \
        "$staged_mirror"
      ;;
    *)
      # Scalars such as kernel.wasm have no package-generation closure. Carry
      # their already-verified bytes instead of retaining an ambient cache path.
      cp -p -- "$target" "$staged_mirror"
      ;;
  esac
done < <(find "$source_dir" -xdev -type l -print0)

scan_roots=("$staged_binaries")
if [ "$has_program_links" -eq 1 ]; then
  scan_roots+=("$staged_cache")
fi
unsafe_staged_entry="$(find "${scan_roots[@]}" -xdev \
  ! \( -type d -o -type f -o -type l \) -print -quit)"
if [ -n "$unsafe_staged_entry" ]; then
  echo "stage-portable-resolver-binaries: portable closure contains a special entry: $unsafe_staged_entry" >&2
  exit 1
fi
unsafe_link="$(
  find "${scan_roots[@]}" -xdev -type l -print0 |
  while IFS= read -r -d '' link; do
    case "$(readlink "$link")" in
      /*)
        printf '%s\n' "$link"
        break
        ;;
    esac
    resolved="$(realpath "$link" 2>/dev/null || true)"
    case "$resolved" in
      "$stage_root"/*) ;;
      *)
        printf '%s\n' "$link"
        break
        ;;
    esac
  done
)"
if [ -n "$unsafe_link" ]; then
  echo "stage-portable-resolver-binaries: portable resolver closure contains an absolute, dangling, or escaping link: $unsafe_link" >&2
  exit 1
fi
if [ -z "$(find "${scan_roots[@]}" -xdev -type f -print -quit)" ]; then
  echo "stage-portable-resolver-binaries: portable closure contains no binary files" >&2
  exit 1
fi
if ! find "$source_dir" -xdev -type l -exec bash -c '
  source_root="$1"
  staged_root="$2"
  shift 2
  for link in "$@"; do
    relative="${link#"$source_root"/}"
    [ "$relative" != "$link" ] && [ -f "$staged_root/$relative" ] &&
      cmp -s -- "$link" "$staged_root/$relative" || exit 1
  done
' bash "$source_dir" "$staged_binaries" {} +; then
  echo "stage-portable-resolver-binaries: staged bytes differ from resolver output" >&2
  exit 1
fi
