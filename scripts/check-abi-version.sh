#!/bin/bash
#
# Verify that the committed ABI snapshot matches what the source of truth
# currently produces, and that any structural change was accompanied by a
# bump of `ABI_VERSION` in the same change.
#
# Modes:
#   check   (default): exit non-zero on drift. Use in CI.
#   update            : regenerate abi/snapshot.json in place. Use locally
#                        after an intentional ABI change.
#
# See docs/abi-versioning.md for policy.

set -euo pipefail

MODE="check"
if [ "${1:-}" = "--update" ] || [ "${1:-}" = "update" ]; then
    MODE="update"
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"

run_xtask() {
    cargo run -p xtask --target "$HOST_TARGET" --quiet -- "$@"
}

if [ "$MODE" = "update" ]; then
    run_xtask dump-abi
    echo
    echo "abi/snapshot.json regenerated."
    echo "If the ABI contract actually changed, bump ABI_VERSION in"
    echo "crates/shared/src/lib.rs in the same commit."
    exit 0
fi

# check mode ----------------------------------------------------------

# Detect whether the snapshot drifted from the source of truth.
drift=0
if ! run_xtask dump-abi --check ; then
    drift=1
fi

if [ "$drift" -eq 0 ]; then
    echo "abi: snapshot is in sync with sources."
else
    echo
    echo "abi: snapshot DRIFTED from sources (see above)." >&2
fi

# Detect whether ABI_VERSION was bumped in this change.
# We look at the working tree + staged changes vs the base branch. If the
# snapshot drifted but ABI_VERSION is unchanged, that's a hard error —
# the contract quietly moved under our feet.
base_ref="${ABI_CHECK_BASE_REF:-origin/main}"
version_bumped=0
if git rev-parse --verify --quiet "$base_ref" >/dev/null ; then
    if ! git diff --quiet "$base_ref" -- crates/shared/src/lib.rs 2>/dev/null ; then
        if git diff "$base_ref" -- crates/shared/src/lib.rs \
            | grep -qE '^\+pub const ABI_VERSION: u32 = ' ; then
            version_bumped=1
        fi
    fi
fi

if [ "$drift" -eq 1 ] && [ "$version_bumped" -eq 0 ]; then
    echo
    echo "ERROR: ABI snapshot changed but ABI_VERSION was not bumped." >&2
    echo "       Either regenerate and bump, or revert the ABI-affecting change." >&2
    echo "       (See docs/abi-versioning.md for policy.)" >&2
    exit 1
fi

if [ "$drift" -eq 1 ]; then
    echo
    echo "ERROR: ABI snapshot is out of date. Run:" >&2
    echo "         bash scripts/check-abi-version.sh update" >&2
    echo "       and commit the regenerated abi/snapshot.json." >&2
    exit 1
fi

echo "abi: ABI_VERSION and snapshot are consistent."
exit 0
