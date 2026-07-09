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

# The snapshot includes exports parsed from the built kernel wasm. We
# build the kernel first so stale binaries can't defeat the check. If
# the build fails we bail before running dump-abi, rather than let the
# generator fail later with a confusing "read wasm" error.
KERNEL_WASM="target/wasm32-unknown-unknown/release/kandelo_kernel.wasm"

build_kernel() {
    echo "abi: building kernel wasm for export-signature snapshot..."
    cargo build --release -p kandelo \
        -Z build-std=core,alloc >&2
    if [ ! -f "$KERNEL_WASM" ]; then
        echo "abi: expected $KERNEL_WASM after build, not found." >&2
        exit 1
    fi
}

run_xtask() {
    cargo run -p xtask --target "$HOST_TARGET" --quiet -- "$@"
}

build_kernel

if [ "$MODE" = "update" ]; then
    run_xtask dump-abi --kernel-wasm "$KERNEL_WASM"
    echo
    echo "abi/snapshot.json regenerated."
    echo "If the ABI contract actually changed, bump ABI_VERSION in"
    echo "crates/shared/src/lib.rs in the same commit."
    exit 0
fi

# check mode ----------------------------------------------------------

# Detect whether the committed snapshot drifted from the source of truth.
drift=0
if ! run_xtask dump-abi --check --kernel-wasm "$KERNEL_WASM" ; then
    drift=1
fi

if [ "$drift" -eq 0 ]; then
    echo "abi: snapshot is in sync with sources."
else
    echo
    echo "abi: snapshot DRIFTED from sources (see above)." >&2
fi

if [ "$drift" -eq 1 ]; then
    echo
    echo "ERROR: ABI snapshot is out of date. Run:" >&2
    echo "         bash scripts/check-abi-version.sh update" >&2
    echo "       and commit the regenerated abi/snapshot.json." >&2
    exit 1
fi

# Detect whether ABI_VERSION or the committed ABI snapshot changed in this
# branch. A no-bump snapshot diff is acceptable only if it is narrowly
# additive: new syscalls, new host-intercepted syscalls, new kernel exports,
# or new marshalled struct names. Existing entries and every other section
# must remain byte-for-byte identical.
base_ref="${ABI_CHECK_BASE_REF:-origin/main}"
version_bumped=0
snapshot_changed=0
if git rev-parse --verify --quiet "$base_ref" >/dev/null ; then
    if ! git diff --quiet "$base_ref" -- crates/shared/src/lib.rs 2>/dev/null ; then
        # Process substitution (not a pipe) so `grep -q` exiting on first
        # match can't SIGPIPE `git diff` into a non-zero status that
        # `set -o pipefail` would then propagate — that race made a large
        # lib.rs diff spuriously report "ABI_VERSION not bumped".
        if grep -qE '^\+pub const ABI_VERSION: u32 = ' \
            < <(git diff "$base_ref" -- crates/shared/src/lib.rs) ; then
            version_bumped=1
        fi
    fi
    if ! git diff --quiet "$base_ref" -- abi/snapshot.json 2>/dev/null ; then
        snapshot_changed=1
    fi
else
    echo "abi: base ref $base_ref not found; skipping base-branch ABI diff classification." >&2
fi

if [ "$snapshot_changed" -eq 1 ] && [ "$version_bumped" -eq 0 ]; then
    old_snapshot="$(mktemp "${TMPDIR:-/tmp}/wasm-posix-abi-old.XXXXXX.json")"
    cleanup() {
        rm -f "$old_snapshot"
    }
    trap cleanup EXIT
    git show "$base_ref:abi/snapshot.json" > "$old_snapshot"

    if ! run_xtask dump-abi --classify-compat "$old_snapshot" abi/snapshot.json ; then
        echo
        echo "ERROR: ABI snapshot changed in a backward-incompatible way but ABI_VERSION was not bumped." >&2
        echo "       Either bump ABI_VERSION, or keep the ABI change purely additive." >&2
        echo "       (See docs/abi-versioning.md for policy.)" >&2
        exit 1
    fi
fi

if [ "$snapshot_changed" -eq 1 ] && [ "$version_bumped" -eq 1 ]; then
    echo "abi: snapshot changed and ABI_VERSION was bumped."
elif [ "$snapshot_changed" -eq 1 ]; then
    echo "abi: snapshot changed only by backward-compatible additions; ABI_VERSION may stay unchanged."
elif [ "$version_bumped" -eq 1 ]; then
    echo
    echo "abi: ABI_VERSION changed but abi/snapshot.json did not change." >&2
    echo "     Verify this was intentional; the snapshot/header are still in sync." >&2
fi

echo "abi: ABI_VERSION and snapshot are consistent."
exit 0
