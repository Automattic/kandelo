#!/usr/bin/env bash
# Build dinit (https://github.com/davmac314/dinit) for wasm32-posix.
# dinit is a service supervisor / init system. We use it to supervise
# service-demo VFS images so the demos boot via real init mechanics
# (per-service config files, dependency resolution, fail-fast on
# upstream failures) rather than JS-side orchestration.
#
# Output: packages/registry/dinit/bin/dinit (and dinitctl, dinitcheck)
set -euo pipefail

DINIT_VERSION="${DINIT_VERSION:-v0.19.4}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SYSROOT="$REPO_ROOT/sysroot"
SRC_DIR="$SCRIPT_DIR/dinit-src"
BIN_DIR="$SCRIPT_DIR/bin"

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
if [ -n "$LIBCXX_DIR" ]; then
    copy_dep_file() {
        local src="$1"
        local dst="$2"

        if [ -e "$dst" ] && [ ! -L "$dst" ] && cmp -s "$src" "$dst"; then
            return
        fi

        rm -f "$dst"
        cp "$src" "$dst"
    }

    mkdir -p "$SYSROOT/lib" "$SYSROOT/include/c++"
    copy_dep_file "$LIBCXX_DIR/lib/libc++.a" "$SYSROOT/lib/libc++.a"
    copy_dep_file "$LIBCXX_DIR/lib/libc++abi.a" "$SYSROOT/lib/libc++abi.a"

    LIBCXX_INCLUDE_SRC="$LIBCXX_DIR/include/c++/v1"
    LIBCXX_INCLUDE_DST="$SYSROOT/include/c++/v1"
    if [ ! -d "$LIBCXX_INCLUDE_DST" ] \
        || [ "$(cd "$LIBCXX_INCLUDE_SRC" && pwd -P)" != "$(cd "$LIBCXX_INCLUDE_DST" && pwd -P)" ]; then
        rm -rf "$LIBCXX_INCLUDE_DST"
        cp -RL "$LIBCXX_INCLUDE_SRC" "$LIBCXX_INCLUDE_DST"
    fi
fi

if [ ! -f "$SYSROOT/lib/libc++.a" ]; then
    echo "ERROR: libc++.a not found in $SYSROOT/lib/" >&2
    echo "       Resolve the declared libcxx dependency first." >&2
    exit 1
fi

# --- Download source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading dinit $DINIT_VERSION..."
    git clone --depth 1 --branch "$DINIT_VERSION" \
        https://github.com/davmac314/dinit.git "$SRC_DIR"
fi

cd "$SRC_DIR"

# Clang lowers Wasm setjmp/longjmp to an exception transfer. Dasynq's pselect
# backend places the sigsetjmp landing pad inside pull_events(), but marks that
# same function noexcept. A SIGCHLD then reaches std::terminate before the
# internal landing pad can consume the longjmp. This is a Wasm toolchain
# compatibility boundary: keep C++ EH for dinit's real try/catch paths and
# remove only the conflicting noexcept declaration.
PATCH_FILE="$SCRIPT_DIR/patches/0001-wasm-sjlj-pselect-noexcept.patch"
echo "==> Applying dinit Wasm SjLj compatibility patch..."
if git apply --reverse --check "$PATCH_FILE" >/dev/null 2>&1; then
    echo "    $(basename "$PATCH_FILE") already applied"
elif git apply --check "$PATCH_FILE" >/dev/null 2>&1; then
    git apply "$PATCH_FILE"
else
    echo "ERROR: $(basename "$PATCH_FILE") does not apply cleanly" >&2
    exit 1
fi

HOST_CXX="${CXX_FOR_BUILD:-c++}"
if [ -n "${NIX_CC_FOR_BUILD:-}" ] \
    && [ -x "$NIX_CC_FOR_BUILD/bin/c++" ]; then
    HOST_CXX="$NIX_CC_FOR_BUILD/bin/c++"
fi

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

# Host toolchain — used by build/tools/mconfig-gen and any other generator
# binary that runs on the developer machine. Prefer Nix's declared build
# compiler when the dev shell exposes one; otherwise use the caller's compiler
# or the platform c++ default.
CXX_FOR_BUILD = $HOST_CXX
CXXFLAGS_FOR_BUILD = -std=c++14 -O1
CPPFLAGS_FOR_BUILD =
LDFLAGS_FOR_BUILD =

# Target flags. dinit uses C++ exceptions in both its supervisor and client
# tools. Compile all targets with the WebAssembly exception model so normal
# service-description and connection errors stay inside dinit's catch paths.
# Add the libc++ include path explicitly since the wasm32posix toolchain does
# not auto-include it; the library is picked up at link time via -lc++
# -lc++abi.
CPPFLAGS = -D_POSIX_C_SOURCE=200809L -isystem $SYSROOT/include/c++/v1
CXXFLAGS = -std=c++14 -O2 -Wall -Wextra -fwasm-exceptions
CFLAGS = -O2 -Wall

# Link flags (target). Explicit -L because the SDK wrapper does not
# auto-add the sysroot lib path during link.
LDFLAGS_BASE = -L$SYSROOT/lib -lc++ -lc++abi

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
make clean 2>&1 | tail -5 || true
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" 2>&1 | tail -30

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
