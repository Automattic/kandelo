#!/usr/bin/env bash
#
# Create a byte-reproducible ZIP from an already-staged directory tree.
#
# Usage:
#   create-deterministic-zip.sh <staging-dir> <output.zip>
#
# The lazy-archive producer may run independently in a bundle job and as a
# dependency of an image job. Both builds must produce one byte identity, so
# filesystem enumeration order, source mtimes, umask-derived permissions, and
# host-specific ZIP extra fields cannot leak into the archive.
set -euo pipefail

if [ "$#" -ne 2 ]; then
    echo "create-deterministic-zip: usage:" \
        "create-deterministic-zip.sh <staging-dir> <output.zip>" >&2
    exit 2
fi

STAGING_DIR="$1"
OUTPUT_FILE="$2"

if [ ! -d "$STAGING_DIR" ] || [ -L "$STAGING_DIR" ]; then
    echo "create-deterministic-zip: staging path must be a real directory: $STAGING_DIR" >&2
    exit 1
fi

STAGING_DIR="$(cd "$STAGING_DIR" && pwd -P)"
OUTPUT_PARENT="$(dirname "$OUTPUT_FILE")"
mkdir -p "$OUTPUT_PARENT"
OUTPUT_PARENT="$(cd "$OUTPUT_PARENT" && pwd -P)"
OUTPUT_FILE="$OUTPUT_PARENT/$(basename "$OUTPUT_FILE")"

case "$OUTPUT_FILE/" in
    "$STAGING_DIR/"*)
        echo "create-deterministic-zip: output must be outside the staging tree: $OUTPUT_FILE" >&2
        exit 1
        ;;
esac

TMP_DIR="$(mktemp -d "$OUTPUT_FILE.tmp.XXXXXX")"
trap 'rm -rf -- "$TMP_DIR"' EXIT
MIRROR_DIR="$TMP_DIR/staging"
ENTRY_LIST="$TMP_DIR/entries.txt"
TMP_OUTPUT="$TMP_DIR/archive.zip"
mkdir -p "$MIRROR_DIR"

has_executable_mode_bit() {
    # Unlike test -x, this inspects the file's mode rather than the current
    # user's identity or an ambient ACL. BSD and GNU stat spell the portable
    # permission-only format differently.
    local mode
    mode="$(LC_ALL=C stat -f '%Lp' "$1" 2>/dev/null || true)"
    if [[ ! "$mode" =~ ^[0-7]+$ ]]; then
        mode="$(LC_ALL=C stat -c '%a' "$1" 2>/dev/null || true)"
    fi
    if [[ ! "$mode" =~ ^[0-7]+$ ]]; then
        echo "create-deterministic-zip: could not read mode: $1" >&2
        return 2
    fi
    (( (8#$mode & 8#111) != 0 ))
}

# 2000-01-01 00:00:00 UTC is exactly representable by ZIP's DOS timestamp.
# Build a private mirror so normalization never mutates the caller's staging
# tree. Canonical distribution modes preserve file kind and executable intent,
# rather than arbitrary source permission bits or the caller's umask.
cd "$STAGING_DIR"
while IFS= read -r -d '' path; do
    relative="${path#./}"
    if [[ "$relative" == *$'\n'* ]]; then
        echo "create-deterministic-zip: ZIP entry names must not contain newlines: $relative" >&2
        exit 1
    fi
    destination="$MIRROR_DIR/$relative"
    if [ -L "$path" ]; then
        mkdir -p "$(dirname "$destination")"
        # Copy the link itself so every valid POSIX target is preserved
        # byte-for-byte. A zero umask gives ZIP one canonical link mode on
        # hosts where symlink creation honors the process umask.
        (umask 000; cp -P "$path" "$destination")
    elif [ -d "$path" ]; then
        mkdir -p "$destination"
    elif [ -f "$path" ]; then
        mkdir -p "$(dirname "$destination")"
        cp "$path" "$destination"
        if has_executable_mode_bit "$path"; then
            chmod 0755 "$destination"
        else
            mode_status=$?
            if [ "$mode_status" -eq 1 ]; then
                chmod 0644 "$destination"
            else
                exit "$mode_status"
            fi
        fi
    else
        echo "create-deterministic-zip: unsupported special file: $relative" >&2
        exit 1
    fi
done < <(LC_ALL=C find . -mindepth 1 -print0 | LC_ALL=C sort -z)

# Enumerate the mirror again after it is complete: adding children changes
# directory mtimes, so all metadata must be normalized in this final pass.
entry_count=0
cd "$MIRROR_DIR"
while IFS= read -r -d '' path; do
    relative="${path#./}"
    if [ -L "$path" ]; then
        TZ=UTC touch -h -t 200001010000.00 "$path"
    elif [ -d "$path" ]; then
        chmod 0755 "$path"
        TZ=UTC touch -t 200001010000.00 "$path"
    elif [ -f "$path" ]; then
        TZ=UTC touch -t 200001010000.00 "$path"
    fi
    printf '%s\n' "$relative" >> "$ENTRY_LIST"
    entry_count=$((entry_count + 1))
done < <(LC_ALL=C find . -mindepth 1 -print0 | LC_ALL=C sort -z)

if [ "$entry_count" -eq 0 ]; then
    echo "create-deterministic-zip: staging tree is empty: $STAGING_DIR" >&2
    exit 1
fi

# -X strips UID/GID and host-specific extra fields. Feeding the canonical
# list over stdin preserves its bytewise path order without recursive rewalks.
# -y stores symlinks as symlinks; registration extracts their exact targets.
env -u SOURCE_DATE_EPOCH -u ZIP -u ZIPOPT LC_ALL=C TZ=UTC \
    zip -X -y -6 -q "$TMP_OUTPUT" -@ < "$ENTRY_LIST"
chmod 0644 "$TMP_OUTPUT"
mv -f "$TMP_OUTPUT" "$OUTPUT_FILE"
