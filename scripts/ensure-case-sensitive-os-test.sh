#!/bin/bash
set -euo pipefail

# Provision a case-sensitive checkout of the Sortix os-test submodule.
#
# WHY: os-test tracks 17 pairs of paths that differ only in letter case, such
# as `include/inttypes/PRIx16.c` and `include/inttypes/PRIX16.c`. On a
# case-insensitive filesystem — the macOS default — git can only write one
# file per pair, so the checkout keeps the survivor and both names read the
# same bytes. The affected tests still compile and still PASS, while checking
# a macro other than the one their name claims. The `include` suite supplies
# most of this project's conformance passes, so a collapsed checkout makes a
# large fraction of the reported conformance fictional.
#
# scripts/run-sortix-tests.sh refuses to run on such a checkout. This script
# supplies the fix: it clones os-test, at the exact commit the submodule
# pins, onto the case-sensitive volume that
# scripts/ensure-case-sensitive-volume.sh provides, and prints the directory
# to pass through KANDELO_OS_TEST_DIR.
#
# It does NOT relocate, modify, or replace the repository's own submodule
# checkout. The collapsed submodule stays exactly as it is; the runner is
# simply pointed at a checkout that holds every path.
#
# On Linux, and on any macOS machine whose repository already sits on a
# case-sensitive filesystem, this script is a no-op that prints the existing
# submodule path, so provisioning can call it unconditionally.
#
# Usage:
#   scripts/ensure-case-sensitive-os-test.sh
#       Provision if needed; print progress plus the directory to use.
#   scripts/ensure-case-sensitive-os-test.sh --print-dir
#       Print ONLY the directory on stdout, for `$(...)` capture:
#           export KANDELO_OS_TEST_DIR="$(scripts/ensure-case-sensitive-os-test.sh --print-dir)"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SUBMODULE="$REPO_ROOT/tests/sortix/os-test"

PRINT_ONLY=false
while [ $# -gt 0 ]; do
    case "$1" in
        --print-dir) PRINT_ONLY=true; shift ;;
        -h|--help) sed -n '3,33p' "$0"; exit 0 ;;
        *) echo "ensure-case-sensitive-os-test: unknown argument: $1" >&2; exit 2 ;;
    esac
done

say() {
    if $PRINT_ONLY; then echo "$@" >&2; else echo "$@"; fi
}

if [ ! -d "$SUBMODULE/.git" ] && [ ! -f "$SUBMODULE/.git" ]; then
    echo "ensure-case-sensitive-os-test: os-test submodule is not checked out." >&2
    echo "  Run: git submodule update --init tests/sortix/os-test" >&2
    exit 1
fi

# Nothing to do when the submodule checkout already holds every tracked path.
if "$REPO_ROOT/scripts/check-case-sensitive-checkout.sh" "$SUBMODULE" >/dev/null 2>&1; then
    say "ensure-case-sensitive-os-test: no-op — the submodule checkout is" \
        "already case-correct."
    if $PRINT_ONLY; then echo "$SUBMODULE"; else
        echo ""
        echo "Use: $SUBMODULE"
    fi
    exit 0
fi

say "ensure-case-sensitive-os-test: submodule checkout is case-collapsed;" \
    "provisioning a case-sensitive one."

MOUNT_POINT="$("$REPO_ROOT/scripts/ensure-case-sensitive-volume.sh" --print-mount-point)"
if [ -z "$MOUNT_POINT" ]; then
    echo "ensure-case-sensitive-os-test: no case-sensitive volume available." >&2
    exit 1
fi

DEST="$MOUNT_POINT/os-test"
PINNED_SHA="$(git -C "$SUBMODULE" rev-parse HEAD)"

if [ -d "$DEST/.git" ]; then
    say "ensure-case-sensitive-os-test: reusing $DEST."
else
    say "ensure-case-sensitive-os-test: cloning os-test into $DEST..."
    rm -rf "$DEST"
    # Clone from the local submodule. Its object store is complete even
    # though its working tree collapsed, so this needs no network access and
    # cannot drift from the commit the repository pins.
    git clone --quiet --no-checkout "$SUBMODULE" "$DEST"
fi

if [ "$(git -C "$DEST" rev-parse HEAD 2>/dev/null || true)" != "$PINNED_SHA" ]; then
    say "ensure-case-sensitive-os-test: checking out pinned commit $PINNED_SHA..."
    # Re-fetch in case the submodule advanced since this clone was made.
    git -C "$DEST" fetch --quiet origin
    git -C "$DEST" checkout --quiet --detach "$PINNED_SHA"
fi

# Verify, rather than assume, that the provisioned checkout is case-correct.
if ! "$REPO_ROOT/scripts/check-case-sensitive-checkout.sh" "$DEST" >/dev/null; then
    echo "ensure-case-sensitive-os-test: $DEST is still case-collapsed." >&2
    exit 1
fi

say "ensure-case-sensitive-os-test: $DEST is at $PINNED_SHA and case-correct."

if $PRINT_ONLY; then
    echo "$DEST"
else
    echo ""
    echo "Case-sensitive os-test ready: $DEST"
    echo ""
    echo "Run the suite against it with:"
    echo "  KANDELO_OS_TEST_DIR=$DEST scripts/run-sortix-tests.sh include"
    echo ""
    echo "or export it for the session:"
    echo "  export KANDELO_OS_TEST_DIR=\"\$(scripts/ensure-case-sensitive-os-test.sh --print-dir)\""
fi
