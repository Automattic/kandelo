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
cleanup() {
    # The mirror carries source directory modes until normalization, so a run
    # that fails in between can hold read-only directories rm cannot empty.
    find "$TMP_DIR" -type d ! -perm -700 -exec chmod u+rwx {} + 2>/dev/null || true
    rm -rf -- "$TMP_DIR"
}
trap cleanup EXIT
MIRROR_DIR="$TMP_DIR/staging"
ENTRY_LIST="$TMP_DIR/entries.txt"
TMP_OUTPUT="$TMP_DIR/archive.zip"
mkdir -p "$MIRROR_DIR"

# Every step below runs a fixed number of processes for the whole tree. Large
# trees (the Perl, Python, and Ruby standard libraries hold thousands of files)
# made a per-file loop of stat/cp/chmod/touch processes take over a minute,
# nearly all of it process startup rather than copying or compression.

# Reject what the ZIP entry list cannot carry before touching the output. A
# path containing a newline has a component containing one, so matching
# component names is enough.
cd "$STAGING_DIR"
bad_name="$(LC_ALL=C find . -mindepth 1 -name $'*\n*' -print -quit)"
if [ -n "$bad_name" ]; then
    echo "create-deterministic-zip: ZIP entry names must not contain newlines: ${bad_name#./}" >&2
    exit 1
fi
special="$(LC_ALL=C find . -mindepth 1 ! -type f ! -type d ! -type l -print -quit)"
if [ -n "$special" ]; then
    echo "create-deterministic-zip: unsupported special file: ${special#./}" >&2
    exit 1
fi

# Build a private mirror so normalization never mutates the caller's staging
# tree. -P copies symlinks as links so every valid POSIX target is preserved
# byte-for-byte. A zero umask gives ZIP one canonical link mode on hosts where
# symlink creation honors the process umask, and keeps source executable bits
# visible to the classification below.
(umask 000; cp -RP "$STAGING_DIR/." "$MIRROR_DIR/")

# Canonical distribution modes preserve file kind and executable intent, rather
# than arbitrary source permission bits or the caller's umask. -perm tests the
# file's mode bits, not the current user's identity or an ambient ACL as
# test -x would.
cd "$MIRROR_DIR"
find . -mindepth 1 -type d -exec chmod 0755 {} +
find . -mindepth 1 -type f \( -perm -100 -o -perm -010 -o -perm -001 \) \
    -exec chmod 0755 {} +
find . -mindepth 1 -type f ! -perm -100 ! -perm -010 ! -perm -001 \
    -exec chmod 0644 {} +

# 2000-01-01 00:00:00 UTC is exactly representable by ZIP's DOS timestamp.
# Stamp after the mirror is complete: adding children changes directory mtimes,
# while chmod and touch of existing entries do not. -h stamps symlinks
# themselves rather than their targets.
TZ=UTC find . -mindepth 1 -exec touch -h -t 200001010000.00 {} +

# Names cannot contain newlines (checked above), so a bytewise sort of the
# NUL-separated walk converts losslessly into zip's newline-separated list.
LC_ALL=C find . -mindepth 1 -print0 | LC_ALL=C sort -z \
    | LC_ALL=C tr '\0' '\n' | LC_ALL=C sed 's|^\./||' > "$ENTRY_LIST"

if [ ! -s "$ENTRY_LIST" ]; then
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
