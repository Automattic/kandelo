#!/usr/bin/env bash
set -euo pipefail

# Build MirBSD paxmirabilis for wasm32-posix-kernel with upstream's Build.sh.
#
# pax walks file trees with fts(3), which musl leaves to the separate
# musl-fts library (as on Alpine and Void); it is a declared dependency.
#
# Build.sh is cross-compiled by naming the target: TARGET_OS is what
# Kandelo's uname(2) reports ("wasm-posix"), not the build host.
#
# The source is fetched over plain HTTP: www.mirbsd.org offers only TLS
# versions the dev shell's OpenSSL refuses. The pinned SHA-256 is what
# guarantees the bytes, as it does for every source archive.
#
# Output: $KANDELO_PACKAGE_WORK_DIR/bin/pax.wasm

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"
SRC_DIR="$WORK_DIR/paxmirabilis-src"
BIN_DIR="$WORK_DIR/bin"
SYSROOT="$REPO_ROOT/sysroot"
VERSION="${WASM_POSIX_DEP_VERSION:-20240817}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-http://www.mirbsd.org/MirOS/dist/mir/cpio/paxmirabilis-${VERSION}.tgz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-e955d5d3af97aede0a3f463a9a59b83e8d1083aaf142eb6f388c549a7d182e6b}"
VERIFIED_SOURCE_DIR="${WASM_POSIX_DEP_SOURCE_DIR:-}"
SOURCE_MARKER="$SRC_DIR/.kandelo-paxmirabilis-source"

# A resolver/Formula caller owns the declared work and output roots. Keep the
# reviewed checkout read-only and suppress the developer-only local mirror.
if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ] && [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
fi

# Keep direct and resolver-driven builds pinned to this worktree's SDK.
# shellcheck source=/dev/null
source "$REPO_ROOT/sdk/activate.sh"

if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Run through scripts/dev-shell.sh." >&2
    exit 1
fi

if [ ! -f "$SYSROOT/lib/libc.a" ]; then
    echo "ERROR: sysroot not found. Run: bash build.sh && bash scripts/build-musl.sh" >&2
    exit 1
fi

export WASM_POSIX_SYSROOT="$SYSROOT"

# --- Stage verified source ---
expected_source_marker="$(printf '%s\n%s\n%s' \
    "$VERSION" "$SOURCE_URL" "$SOURCE_SHA256")"
if [ -d "$SRC_DIR" ] && \
   [ "$(cat "$SOURCE_MARKER" 2>/dev/null || true)" != "$expected_source_marker" ]; then
    rm -rf "$SRC_DIR" "$BIN_DIR"
fi
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Staging verified paxmirabilis $VERSION source..."
    kandelo_package_stage_verified_source paxmirabilis "$SRC_DIR" \
        "$VERIFIED_SOURCE_DIR" "$SOURCE_URL" "$SOURCE_SHA256" "$WORK_DIR"
    printf '%s\n' "$expected_source_marker" >"$SOURCE_MARKER"
fi

cd "$SRC_DIR"
mkdir -p "$BIN_DIR"

# --- Answer Build.sh's link probes from libc.a ---
# The SDK links with --allow-undefined (host imports resolve at load time),
# so a program calling a function that does not exist still links. Build.sh
# checks for exactly that ("if the compiler does not fail correctly") and
# stops, because its function probes would all answer "yes". Answer each
# probe from the symbols the sysroot's libc.a actually defines instead, the
# way Build.sh documents (HAVE_<TEST>=0/1). HAVE_COMPILER_FAILS=0 records
# that the lying link check has been accounted for, so Build.sh proceeds.
libc_defines() {
    wasm32posix-nm "$SYSROOT/lib/libc.a" 2>/dev/null |
        awk -v sym="$1" '$2 ~ /^[TW]$/ && $3 == sym { found = 1 } END { exit !found }'
}
probe() {
    local test="$1" symbol value=1
    shift
    for symbol in "$@"; do
        libc_defines "$symbol" || value=0
    done
    export "HAVE_$(printf '%s' "$test" | tr '[:lower:]' '[:upper:]')=$value"
    echo "    HAVE_$test=$value ($*)"
}
echo "==> Link probes answered from libc.a:"
for fn in dprintf fchmodat fchownat futimens futimes lchmod lchown linkat           lutimes pledge reallocarray strlcat strlcpy strmode strtonum           utimensat utimes; do
    probe "$fn" "$fn"
done
probe setpgent setgroupent setpassent
probe ug_from_ugid user_from_uid group_from_gid
probe ugid_from_ug uid_from_user gid_from_group
export HAVE_COMPILER_FAILS=0

# --- Resolve musl-fts ---
FTS_PREFIX="${WASM_POSIX_DEP_MUSL_FTS_DIR:-}"
if [ -z "$FTS_PREFIX" ]; then
    echo "==> Resolving musl-fts via cargo xtask build-deps..."
    HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"
    FTS_PREFIX="$(cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TARGET" --quiet --         build-deps resolve musl-fts)"
fi
if [ ! -f "$FTS_PREFIX/lib/libfts.a" ]; then
    echo "ERROR: musl-fts resolve returned '$FTS_PREFIX' but libfts.a is missing" >&2
    exit 1
fi

# --- Build ---
echo "==> Building pax..."
rm -f pax
CC=wasm32posix-cc CFLAGS="-O2" CPPFLAGS="-I$FTS_PREFIX/include"     LDFLAGS="-L$FTS_PREFIX/lib" LIBS="-lfts" TARGET_OS=wasm-posix     sh ./Build.sh -r 2>&1 | tail -40
cp pax "$BIN_DIR/pax.wasm"
ls -lh "$BIN_DIR/pax.wasm"

source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary paxmirabilis "$BIN_DIR/pax.wasm"
