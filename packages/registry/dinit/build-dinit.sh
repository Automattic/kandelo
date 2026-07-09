#!/usr/bin/env bash
# Build dinit (https://github.com/davmac314/dinit) for wasm32-posix.
# dinit is a service supervisor / init system. We use it as PID 1 in
# service-demo VFS images so the demos boot via real init mechanics
# (per-service config files, dependency resolution, fail-fast on
# upstream failures) rather than JS-side orchestration.
#
# Output: packages/registry/dinit/bin/dinit (and dinitctl, dinitcheck)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/sdk/activate.sh"

DINIT_VERSION="${DINIT_VERSION:-${WASM_POSIX_DEP_VERSION:-0.19.4}}"
case "$DINIT_VERSION" in
    v*) DINIT_TAG="$DINIT_VERSION" ;;
    *) DINIT_TAG="v$DINIT_VERSION" ;;
esac
SYSROOT="$REPO_ROOT/sysroot"
WORK_DIR="${WASM_POSIX_DEP_WORK_DIR:-$SCRIPT_DIR}"
SRC_DIR="${WASM_POSIX_DEP_SOURCE_DIR:-$WORK_DIR/dinit-src}"
BIN_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/bin}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://github.com/davmac314/dinit/archive/refs/tags/${DINIT_TAG}.tar.gz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-}"
mkdir -p "$WORK_DIR" "$BIN_DIR"

source "$REPO_ROOT/scripts/wasm-artifact-guards.sh"

current_kernel_abi() {
    sed -nE 's/^pub const ABI_VERSION: u32 = ([0-9]+);/\1/p' \
        "$REPO_ROOT/crates/shared/src/lib.rs" | head -1
}

wasm_abi() {
    local wasm="$1"
    (
        cd "$REPO_ROOT"
        npx --no-install tsx --eval \
            "const { extractAbiVersion } = require('./host/src/constants.ts'); const { readFileSync } = require('node:fs'); const path = process.argv[1]; const b = readFileSync(path); const abi = extractAbiVersion(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); if (abi != null) console.log(abi);" \
            -- "$wasm"
    )
}

# --- Idempotent fast path ---
# If all three artifacts already exist (e.g. left over from a prior
# build, or downloaded by scripts/fetch-binaries.sh into bin/), just
# install them and return. This lets `xtask archive-stage` succeed in
# environments that don't have libc++ available — needed because the
# resolver invokes this script to ensure_built before staging.
if [ -f "$BIN_DIR/dinit.wasm" ] && [ -f "$BIN_DIR/dinitctl.wasm" ] && [ -f "$BIN_DIR/dinitcheck.wasm" ]; then
    current_abi="$(current_kernel_abi || true)"
    artifact_abi="$(wasm_abi "$BIN_DIR/dinit.wasm" 2>/dev/null || true)"
    legacy_artifacts=()
    for artifact in "$BIN_DIR/dinit.wasm" "$BIN_DIR/dinitctl.wasm" "$BIN_DIR/dinitcheck.wasm"; do
        if wasm_has_legacy_asyncify "$artifact"; then
            legacy_artifacts+=("$artifact")
        fi
    done
    if [ -n "$current_abi" ] && [ "$artifact_abi" = "$current_abi" ] && [ "${#legacy_artifacts[@]}" -eq 0 ]; then
        echo "==> Reusing existing dinit artifacts in $BIN_DIR (ABI $artifact_abi; skip rebuild)."
        source "$REPO_ROOT/scripts/install-local-binary.sh"
        install_local_binary dinit "$BIN_DIR/dinit.wasm" dinit.wasm
        install_local_binary dinit "$BIN_DIR/dinitctl.wasm" dinitctl.wasm
        install_local_binary dinit "$BIN_DIR/dinitcheck.wasm" dinitcheck.wasm
        exit 0
    fi
    if [ "${#legacy_artifacts[@]}" -gt 0 ]; then
        echo "==> Existing dinit artifacts contain legacy Asyncify symbols; rebuilding."
    else
        echo "==> Existing dinit artifacts are stale (artifact ABI ${artifact_abi:-unknown}, current ABI ${current_abi:-unknown}); rebuilding."
    fi
fi

# --- Prerequisites ---
if ! command -v wasm32posix-c++ &>/dev/null; then
    echo "ERROR: wasm32posix-c++ not found. Run 'npm link' in sdk/ first." >&2
    exit 1
fi

LIBCXX_DIR="${WASM_POSIX_DEP_LIBCXX_DIR:-}"
LIBCXX_INCLUDE_DIR="$SYSROOT/include/c++/v1"
LIBCXX_LIB_DIR="$SYSROOT/lib"
if [ -n "$LIBCXX_DIR" ]; then
    LIBCXX_INCLUDE_DIR="$LIBCXX_DIR/include/c++/v1"
    LIBCXX_LIB_DIR="$LIBCXX_DIR/lib"
fi

if [ ! -f "$LIBCXX_LIB_DIR/libc++.a" ]; then
    echo "ERROR: libc++.a not found in $LIBCXX_LIB_DIR/" >&2
    echo "       Resolve the declared libcxx dependency first." >&2
    exit 1
fi
if [ ! -f "$LIBCXX_LIB_DIR/libc++abi.a" ]; then
    echo "ERROR: libc++abi.a not found in $LIBCXX_LIB_DIR/" >&2
    echo "       Resolve the declared libcxx dependency first." >&2
    exit 1
fi
if [ ! -d "$LIBCXX_INCLUDE_DIR" ]; then
    echo "ERROR: libc++ headers not found at $LIBCXX_INCLUDE_DIR/" >&2
    echo "       Resolve the declared libcxx dependency first." >&2
    exit 1
fi

# --- Download source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading dinit $DINIT_TAG..."
    case "$SOURCE_URL" in
        *.git|git://*)
            git clone --depth 1 --branch "$DINIT_TAG" "$SOURCE_URL" "$SRC_DIR"
            ;;
        *)
            tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/kandelo-dinit-src.XXXXXX")"
            trap 'rm -rf "$tmpdir"' EXIT
            TARBALL="$tmpdir/dinit-${DINIT_TAG}.tar.gz"
            curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors -fsSL "$SOURCE_URL" -o "$TARBALL"
            if [ -n "$SOURCE_SHA256" ]; then
                echo "==> Verifying source sha256..."
                echo "$SOURCE_SHA256  $TARBALL" | shasum -a 256 -c -
            fi
            mkdir -p "$SRC_DIR"
            tar xzf "$TARBALL" -C "$SRC_DIR" --strip-components=1
            trap - EXIT
            rm -rf "$tmpdir"
            ;;
    esac
fi

cd "$SRC_DIR"

# --- Configure ---
# dinit's build is driven by mconfig (a make-included config file). We
# generate one by hand for the cross-compile rather than running
# ./configure (which probes the host system, not the wasm sysroot).
echo "==> Generating mconfig for wasm32-posix..."
cat > mconfig <<EOF
# Cross-compile config for wasm32-posix-kernel.
# Generated by build-dinit.sh; do not commit.

# Target toolchain (cross-compile to wasm32-posix)
CXX = wasm32posix-c++
CC = wasm32posix-cc

# Host toolchain — used by build/tools/mconfig-gen and any other
# generator binary that runs on the developer machine. The default
# c++ resolves to clang++ on macOS or g++ on Linux.
CXX_FOR_BUILD = c++
CXXFLAGS_FOR_BUILD = -std=c++14 -O1
CPPFLAGS_FOR_BUILD =
LDFLAGS_FOR_BUILD =

# Target flags. dinit uses C++ exceptions in its client code (dinitctl,
# dinit-monitor) so we cannot disable them. Add libc++ include path
# explicitly since the wasm32posix toolchain does not auto-include it.
CPPFLAGS = -D_POSIX_C_SOURCE=200809L -isystem $LIBCXX_INCLUDE_DIR -isystem $SYSROOT/include
CXXFLAGS = -std=c++14 -O2 -Wall -Wextra
CFLAGS = -O2 -Wall

# Link flags (target). Put the declared libcxx prefix first so package-manager
# builds do not need to mutate the shared repo sysroot.
LDFLAGS_BASE = -L$LIBCXX_LIB_DIR -L$SYSROOT/lib -lc++ -lc++abi

# Path/install
SBINDIR = /sbin
MANDIR = /usr/share/man

# Service defaults — the build Makefile passes these to mconfig-gen
# unconditionally. If empty, the generated #define expands to nothing
# at use sites, breaking compilation. Set them explicitly to dinit's
# documented defaults.
DEFAULT_AUTO_RESTART = ON_FAILURE
DEFAULT_START_TIMEOUT = 60
DEFAULT_STOP_TIMEOUT = 10

# dinit features
# Skip cgroup support (Linux-specific, not in kandelo).
SUPPORT_CGROUPS = 0
# Skip capability support (Linux-specific).
SUPPORT_CAPABILITIES = 0
# pselect-based event loop (most portable; epoll is Linux-only and we
# don't want to assume our wasm-kernel's epoll is feature-complete for
# dasynq's needs at this point).
USE_LIBSELECT_EV = 1
# No utmp updating (no wtmp/utmp in our environment).
DISABLE_UTMPX = 1

# Linker
LDFLAGS = \$(LDFLAGS_BASE)
EOF

# --- Build ---
echo "==> Building dinit (this may take a minute)..."
make clean 2>&1 | tee "$WORK_DIR/dinit-clean.log" | tail -5 || true
MAKE_JOBS="${WASM_POSIX_MAKE_JOBS:-$(sysctl -n hw.ncpu 2>/dev/null || nproc)}"
if ! make -j"$MAKE_JOBS" 2>&1 | tee "$WORK_DIR/dinit-build.log" | tail -120; then
    echo "ERROR: dinit build failed; see $WORK_DIR/dinit-build.log" >&2
    exit 1
fi

# --- Collect binaries ---
echo "==> Collecting binaries..."
mkdir -p "$BIN_DIR"
for binary in dinit dinitctl dinitcheck; do
    if [ -f "src/$binary" ]; then
        cp "src/$binary" "$BIN_DIR/$binary.wasm"
        ls -la "$BIN_DIR/$binary.wasm"
    else
        echo "WARNING: src/$binary not found"
    fi
done

# --- Fork instrumentation for fork support ---
# dinit forks once per service to launch each daemon (fork()+execvp()
# pattern). Without wasm-fork-instrument wrapping kernel_fork, the child wasm
# instance re-runs main() from scratch and always dispatches the FIRST
# service in dinit's start order — every fork's child ends up as the
# first service, no matter which service dinit thinks it's launching.
#
# wasm-fork-instrument instruments callers up the chain to kernel_fork so
# the host can save/restore the call stack across fork: child resumes
# from the fork point with all locals intact, exec's the right binary.
# Same pattern as nginx/php-fpm/bash. Apply only to dinit (the only
# binary that forks); dinitctl and dinitcheck don't need it.
FORK_INSTRUMENT="$REPO_ROOT/scripts/run-wasm-fork-instrument.sh"
echo "==> Applying wasm-fork-instrument to dinit.wasm..."
"$FORK_INSTRUMENT" "$BIN_DIR/dinit.wasm" -o "$BIN_DIR/dinit.wasm.instr"
mv "$BIN_DIR/dinit.wasm.instr" "$BIN_DIR/dinit.wasm"
ls -la "$BIN_DIR/dinit.wasm"

# Install into local-binaries/ so the resolver (host/src/binary-resolver.ts)
# picks these up over anything fetched by scripts/fetch-binaries.sh.
# Also makes the artifacts visible to `xtask archive-stage` when a
# package archive is being produced.
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary dinit "$BIN_DIR/dinit.wasm" dinit.wasm
install_local_binary dinit "$BIN_DIR/dinitctl.wasm" dinitctl.wasm
install_local_binary dinit "$BIN_DIR/dinitcheck.wasm" dinitcheck.wasm

echo "==> dinit build complete"
