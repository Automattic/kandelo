# shellcheck shell=bash
# Run a package build command inside a Kandelo machine.
#
# Source this from a recipe, then call:
#
#   kandelo_guest_build --workspace <dir> [--input <guest>=<host>]...
#       [--env K=V]... [--timeout-ms <n>] -- <argv...>
#
# The machine boots the declared kernel and build image dependencies, so the
# recipe's package.toml must list both:
#
#   depends_on = ["kernel@0.1.0", "kandelo-build-image@0.1.0", ...]
#
# The workspace is mounted read-write at /build and must live under
# WASM_POSIX_DEP_WORK_DIR. Inputs are mounted read-only. Guest output is
# streamed to stderr and kept in $WASM_POSIX_DEP_WORK_DIR/guest-build.log.
# Returns the guest command's exit status (124 when it timed out).
#
# Files the guest creates on the workspace mount reach the host as mode 0600;
# set modes on the host when installing outputs.
#
# See docs/package-management.md, "Building inside Kandelo".

kandelo_guest_build() {
    local repo_root
    repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

    local kernel_dir="${WASM_POSIX_DEP_KERNEL_DIR:-}"
    local image_dir="${WASM_POSIX_DEP_KANDELO_BUILD_IMAGE_DIR:-}"
    local work_dir="${WASM_POSIX_DEP_WORK_DIR:-}"
    if [ -z "$kernel_dir" ] || [ -z "$image_dir" ] || [ -z "$work_dir" ]; then
        echo "kandelo_guest_build: needs the kernel and kandelo-build-image dependencies" \
            "and a resolver work dir (WASM_POSIX_DEP_KERNEL_DIR," \
            "WASM_POSIX_DEP_KANDELO_BUILD_IMAGE_DIR, WASM_POSIX_DEP_WORK_DIR)" >&2
        return 2
    fi
    local kernel="$kernel_dir/kandelo-kernel.wasm"
    local image="$image_dir/kandelo-build.vfs.zst"
    [ -f "$kernel" ] || { echo "kandelo_guest_build: $kernel not found" >&2; return 2; }
    [ -f "$image" ] || { echo "kandelo_guest_build: $image not found" >&2; return 2; }
    if [ -z "${SOURCE_DATE_EPOCH:-}" ]; then
        echo "kandelo_guest_build: SOURCE_DATE_EPOCH must be set (run under scripts/dev-shell.sh)" >&2
        return 2
    fi

    # One hour unless the recipe says otherwise: a wedged guest build must
    # fail the package build rather than hold it open forever.
    local -a args=(--timeout-ms 3600000)
    local timeout_given=0
    for arg in "$@"; do
        [ "$arg" = "--" ] && break
        [ "$arg" = "--timeout-ms" ] && timeout_given=1
    done
    [ "$timeout_given" -eq 1 ] && args=()

    # tsx opens an IPC socket under TMPDIR; the resolver's content-hashed work
    # dir is long enough to overflow the macOS unix-socket path limit.
    local tsx_tmp status
    tsx_tmp="$(mktemp -d /tmp/kandelo-guest-build.XXXXXX)"
    # Captured with if/else so a failing build returns its status even when
    # the calling recipe runs under `set -e`.
    if TMPDIR="$tsx_tmp" node "$repo_root/node_modules/tsx/dist/cli.mjs" \
        "$repo_root/scripts/guest-build.ts" \
        --kernel "$kernel" \
        --image "$image" \
        --log "$work_dir/guest-build.log" \
        --source-date-epoch "$SOURCE_DATE_EPOCH" \
        "${args[@]}" \
        "$@"; then
        status=0
    else
        status=$?
    fi
    rm -rf -- "$tsx_tmp"
    return "$status"
}
