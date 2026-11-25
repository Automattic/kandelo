# shellcheck shell=bash
# Shared setup checks for the Node, browser and CI conformance entry points.

conformance_setup_error() {
    printf 'SETUP ERROR: %s\n' "$*" >&2
    return 1
}

conformance_source_input() {
    case "$1" in
        libc)
            CONFORMANCE_SOURCE_FILE="$REPO_ROOT/tests/libc/libc-test/src/common/test.h"
            CONFORMANCE_SOURCE_REPAIR='git submodule update --init tests/libc/libc-test'
            ;;
        posix)
            # Open POSIX is vendored in Kandelo, with no submodule to initialize.
            CONFORMANCE_SOURCE_FILE="$REPO_ROOT/tests/posix/open-posix-testsuite/include/posixtest.h"
            CONFORMANCE_SOURCE_REPAIR='git restore -- tests/posix/open-posix-testsuite'
            ;;
        sortix)
            CONFORMANCE_SOURCE_FILE="${KANDELO_SORTIX_SOURCE_ROOT:-$REPO_ROOT/tests/sortix/os-test}/Makefile"
            CONFORMANCE_SOURCE_REPAIR='git submodule update --init tests/sortix/os-test'
            if [ -n "${KANDELO_SORTIX_SOURCE_ROOT:-}" ]; then
                CONFORMANCE_SOURCE_REPAIR="restore the pinned os-test checkout at KANDELO_SORTIX_SOURCE_ROOT (git submodule update --init tests/sortix/os-test for the default checkout)"
            fi
            ;;
    esac
}

# Also used after a compile error, before applying any test expectation.
conformance_missing_build_input() {
    if [ ! -f "$CONFORMANCE_SOURCE_FILE" ]; then
        printf 'missing %s. Run %s.\n' "$CONFORMANCE_SOURCE_FILE" "$CONFORMANCE_SOURCE_REPAIR"
    elif [ ! -f "${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}/lib/libc.a" ]; then
        printf 'missing sysroot archive %s/lib/libc.a. Run ./run.sh setup.\n' "${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"
    else
        return 1
    fi
}

conformance_require_artifact() {
    local request="$1" repair="$2" path
    if ! path=$("$REPO_ROOT/scripts/resolve-binary.sh" "$request") || [ ! -f "$path" ]; then
        conformance_setup_error "unavailable $request. Run $repair."
        return 1
    fi
    printf '%s\n' "$path"
}

# A fast negative probe avoids starting Cargo just to learn that a package
# artifact is absent. Positive candidates are validated in the real resolver
# and, for Node's lazy rootfs closure, by the same loader that boots each case.
conformance_require_candidate() {
    local repair="$1"
    shift
    if ! "$REPO_ROOT/scripts/resolve-binary.sh" --check-candidates "$@" >/dev/null; then
        conformance_setup_error "unavailable $*. Run $repair."
    fi
}

conformance_require_rootfs() {
    if [ "$1" = browser ]; then
        "$REPO_ROOT/scripts/resolve-binary.sh" --browser-rootfs >/dev/null
    else
        "$REPO_ROOT/scripts/resolve-binary.sh" --check-candidates \
            rootfs.vfs.zst programs/rootfs.vfs.zst >/dev/null
    fi || conformance_setup_error 'unavailable rootfs.vfs.zst. Run scripts/dev-shell.sh bash scripts/build-rootfs.sh.'
}

conformance_preflight() {
    local suite="$1" host="$2" mode="${3:-runtime}" missing
    conformance_source_input "$suite"
    if missing=$(conformance_missing_build_input); then
        conformance_setup_error "$missing"
        return 1
    fi
    [ "$mode" = compile-only ] && return 0

    conformance_require_rootfs "$host" || return 1
    KERNEL_WASM=$(conformance_require_artifact kernel.wasm './run.sh setup') || return 1
    if [ "$host" = node ]; then
        if [ ! -f "$REPO_ROOT/local-binaries/kandelo_image_module32.wasm" ]; then
            conformance_setup_error 'missing local-binaries/kandelo_image_module32.wasm. Run ./run.sh setup.'
            return 1
        fi
    else
        local request
        for request in kandelo_image_module32.wasm kandelo_image_module_positioned32.wasm \
            programs/bash.wasm programs/coreutils.wasm programs/grep.wasm programs/sed.wasm \
            programs/posix-utils-lite/gencat.wasm; do
            conformance_require_candidate './run.sh setup --all' "$request" || return 1
        done
    fi
}

conformance_check_browser_artifacts() {
    # Resolve the tools as a batch, sharing one program index freshness check.
    local rootfs artifacts
    rootfs=$("$REPO_ROOT/scripts/resolve-binary.sh" --browser-rootfs) ||
        { conformance_setup_error 'unavailable rootfs.vfs.zst. Run scripts/dev-shell.sh bash scripts/build-rootfs.sh.'; return 1; }
    artifacts=$("$REPO_ROOT/scripts/resolve-binary.sh" \
        kandelo_image_module32.wasm kandelo_image_module_positioned32.wasm \
        programs/bash.wasm programs/coreutils.wasm programs/grep.wasm programs/sed.wasm \
        programs/posix-utils-lite/gencat.wasm) ||
        { conformance_setup_error 'browser test runner artifacts could not be resolved. Run ./run.sh setup --all.'; return 1; }
    export KANDELO_BROWSER_CONFORMANCE_ARTIFACTS
    KANDELO_BROWSER_CONFORMANCE_ARTIFACTS=$(printf '%s\n' "$KERNEL_WASM" "$rootfs" "$artifacts")
}

conformance_check_node_rootfs() {
    node --import tsx/esm scripts/check-conformance-rootfs.ts ||
        conformance_setup_error 'cannot prepare the Node rootfs and its resolver artifacts. Run ./run.sh setup --all and scripts/dev-shell.sh bash scripts/build-rootfs.sh.'
}

conformance_record_setup_error() {
    local id="$1" detail="$2"
    printf 'SETUP ERROR %s: %s\n' "$id" "$detail" >&2
    RESULTS+=("SETUP $id")
    SETUP_ERROR_COUNT=$((SETUP_ERROR_COUNT + 1))
}
