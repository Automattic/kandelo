#!/bin/bash
set -euo pipefail

# Provide a case-sensitive filesystem for trees git cannot check out here.
#
# WHY: macOS formats its boot volume case-insensitively by default. Git can
# track two paths that differ only in letter case — the Sortix os-test
# conformance suite tracks `include/inttypes/PRIx16.c` alongside
# `include/inttypes/PRIX16.c`, and 16 more pairs like it. A case-insensitive
# volume cannot hold both, so a plain `git submodule update --init` silently
# collapses each pair into one file. Only one spelling keeps a directory
# entry, so the suite never discovers the other: it runs 3,741 `include` tests
# where a case-sensitive checkout runs 3,758, and reports the smaller number
# as if it were the whole suite. Seventeen files also show as modified that
# nobody edited, because the path git indexed now reads its sibling's bytes.
#
# `scripts/check-case-sensitive-checkout.sh` detects that state and refuses
# it. This script supplies the fix: an APFS sparse disk image formatted
# case-sensitive, created on demand and mounted, so a collapsing tree can be
# checked out somewhere that holds it correctly.
#
# The image is sparse: it allocates only the bytes actually stored, so the
# nominal size below is a ceiling, not a reservation.
#
# On Linux — and on any macOS machine whose repository already sits on a
# case-sensitive volume — this script is a no-op that succeeds, so callers
# can invoke it unconditionally during provisioning. It never touches, moves,
# or reformats an existing checkout.
#
# Usage:
#   scripts/ensure-case-sensitive-volume.sh
#       Ensure the image exists and is mounted. Prints what it did.
#   scripts/ensure-case-sensitive-volume.sh --print-mount-point
#       Same, but print ONLY the mount point on stdout (for `$(...)` capture).
#       On a host that needs no image, prints nothing and exits 0.
#   scripts/ensure-case-sensitive-volume.sh --detach
#       Unmount the image (the image file is kept).

IMAGE_DIR="${KANDELO_CASE_IMAGE_DIR:-$HOME/.cache/kandelo}"
IMAGE_PATH="$IMAGE_DIR/KandeloCaseBuild.sparseimage"
VOLUME_NAME="KandeloCaseBuild"
MOUNT_POINT="/Volumes/$VOLUME_NAME"
IMAGE_SIZE="${KANDELO_CASE_IMAGE_SIZE:-20g}"

PRINT_ONLY=false
DETACH=false

while [ $# -gt 0 ]; do
    case "$1" in
        --print-mount-point) PRINT_ONLY=true; shift ;;
        --detach) DETACH=true; shift ;;
        -h|--help) sed -n '3,40p' "$0"; exit 0 ;;
        *) echo "ensure-case-sensitive-volume: unknown argument: $1" >&2; exit 2 ;;
    esac
done

# Emit progress on stderr so --print-mount-point keeps stdout clean.
say() {
    if $PRINT_ONLY; then echo "$@" >&2; else echo "$@"; fi
}

# Is the given directory on a case-sensitive filesystem? Probes behavior
# rather than trusting a filesystem name: create one file and test whether
# the opposite-case spelling resolves to the same inode.
fs_is_case_sensitive() {
    local dir="$1"
    local probe upper lower status
    probe="$(mktemp "$dir/.kandelo-case-probe-aA.XXXXXX" 2>/dev/null)" || return 2
    lower="${probe}z"
    upper="${probe}Z"
    : > "$lower"
    if [ -e "$upper" ] && [ "$lower" -ef "$upper" ]; then
        status=1   # case-insensitive
    else
        status=0   # case-sensitive
    fi
    rm -f "$probe" "$lower" "$upper"
    return "$status"
}

if [ "$(uname -s)" != "Darwin" ]; then
    if fs_is_case_sensitive "${TMPDIR:-/tmp}"; then
        say "ensure-case-sensitive-volume: no-op — $(uname -s) filesystem is case-sensitive."
        exit 0
    fi
    echo "ensure-case-sensitive-volume: this host is $(uname -s) with a" \
         "case-insensitive filesystem; no automated image is implemented" \
         "for it. Check the repository out on a case-sensitive filesystem." >&2
    exit 1
fi

if $DETACH; then
    if [ -d "$MOUNT_POINT" ]; then
        hdiutil detach "$MOUNT_POINT" >/dev/null
        say "ensure-case-sensitive-volume: detached $MOUNT_POINT."
    else
        say "ensure-case-sensitive-volume: $MOUNT_POINT is not mounted."
    fi
    exit 0
fi

# If the repository already lives on a case-sensitive volume, nothing is
# needed. Probe the repository itself, not the boot volume: a checkout may
# already sit inside an image like this one.
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if fs_is_case_sensitive "$REPO_ROOT"; then
    say "ensure-case-sensitive-volume: no-op — $REPO_ROOT is already on a" \
        "case-sensitive filesystem."
    exit 0
fi

if [ ! -f "$IMAGE_PATH" ]; then
    mkdir -p "$IMAGE_DIR"
    say "ensure-case-sensitive-volume: creating $IMAGE_PATH (sparse, max $IMAGE_SIZE)..."
    hdiutil create \
        -type SPARSE \
        -fs "Case-sensitive APFS" \
        -volname "$VOLUME_NAME" \
        -size "$IMAGE_SIZE" \
        -quiet \
        "${IMAGE_PATH%.sparseimage}"
    say "ensure-case-sensitive-volume: created $IMAGE_PATH."
else
    say "ensure-case-sensitive-volume: reusing existing $IMAGE_PATH."
fi

if [ ! -d "$MOUNT_POINT" ]; then
    say "ensure-case-sensitive-volume: mounting $IMAGE_PATH at $MOUNT_POINT..."
    hdiutil attach -nobrowse "$IMAGE_PATH" >/dev/null
else
    say "ensure-case-sensitive-volume: $MOUNT_POINT already mounted."
fi

if [ ! -d "$MOUNT_POINT" ]; then
    echo "ensure-case-sensitive-volume: $IMAGE_PATH did not mount at" \
         "$MOUNT_POINT." >&2
    exit 1
fi

# Verify the mounted volume actually behaves case-sensitively. An image
# created by hand, or by an older macOS default, may not, and mounting a
# case-insensitive volume here would reintroduce the exact defect this
# script exists to prevent.
if ! fs_is_case_sensitive "$MOUNT_POINT"; then
    echo "" >&2
    echo "ERROR: $MOUNT_POINT is mounted but is NOT case-sensitive." >&2
    echo "" >&2
    echo "A checkout placed here would collapse case-colliding paths exactly" >&2
    echo "as the boot volume does. The image at" >&2
    echo "  $IMAGE_PATH" >&2
    echo "was not formatted 'Case-sensitive APFS'. Detach and remove it, then" >&2
    echo "re-run this script to have it recreated:" >&2
    echo "  scripts/ensure-case-sensitive-volume.sh --detach" >&2
    echo "  rm -f '$IMAGE_PATH'" >&2
    echo "  scripts/ensure-case-sensitive-volume.sh" >&2
    echo "" >&2
    exit 1
fi

say "ensure-case-sensitive-volume: verified $MOUNT_POINT is case-sensitive."

if $PRINT_ONLY; then
    echo "$MOUNT_POINT"
else
    echo ""
    echo "Case-sensitive volume ready: $MOUNT_POINT"
    echo ""
    echo "Check a collapsing tree out here, for example:"
    echo "  git clone <repo> $MOUNT_POINT/kandelo"
    echo ""
    echo "Verify any checkout with:"
    echo "  scripts/check-case-sensitive-checkout.sh <tree>"
fi
