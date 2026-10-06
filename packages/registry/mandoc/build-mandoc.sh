#!/usr/bin/env bash
# Build mandoc (the man viewer/formatter) for wasm32. Produces mandoc.wasm;
# the `man` front-end is installed as a bin/man hard link to mandoc (mandoc's
# own `make install` already does this via its BINM_MAN convention).
#
# mandoc has no autotools. Its BSD-style ./configure compiles-and-executes
# small probe programs on the *build* host to detect libc features, then
# writes config.h + Makefile.local. Under cross-compilation the probe
# binaries are wasm32 modules the host cannot execute, so every probe that
# depends on *running* the compiled test fails closed (reports the feature
# absent) rather than hanging or crashing the configure script itself.
# mandoc ships portable compat_*.c fallbacks for every one of those
# features, so a blanket "not found" is safe: the build simply always uses
# the checked-in compat implementation instead of trusting a host libc
# function that may not even exist on the wasm32/musl target. The two
# exceptions are handled explicitly below because mandoc's configure
# treats them as fatal if no probe succeeds (see configure.local comments).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"
SRC_DIR="$WORK_DIR/mandoc-src"
SYSROOT="$REPO_ROOT/sysroot"
MANDOC_VERSION="${WASM_POSIX_DEP_VERSION:-${MANDOC_VERSION:-1.14.6}}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://mandoc.bsd.lv/snapshots/mandoc-${MANDOC_VERSION}.tar.gz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-8bf0d570f01e70a6e124884088870cbed7537f36328d512909eb10cd53179d9c}"
VERIFIED_SOURCE_DIR="${WASM_POSIX_DEP_SOURCE_DIR:-}"
SOURCE_MARKER="$SRC_DIR/.kandelo-mandoc-source"

# A resolver/Formula caller owns the declared work and output roots. Keep the
# reviewed checkout read-only and suppress the developer-only local mirror.
if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ] && [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
fi

# --- Prerequisites ---
if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Run through scripts/dev-shell.sh." >&2
    exit 1
fi

if [ ! -f "$SYSROOT/lib/libc.a" ]; then
    echo "ERROR: sysroot not found. Run: bash build.sh && bash scripts/build-musl.sh" >&2
    exit 1
fi

export WASM_POSIX_SYSROOT="$SYSROOT"

# --- Resolve zlib (mandoc unconditionally links -lz for mandoc.db reading) ---
# Env-var short-circuit lets an outer resolver run (which already resolved
# our declared `depends_on = ["zlib@1.3.1"]`) pass the prefix through
# without re-invoking cargo. Direct/dev builds fall back to resolving it.
ZLIB_PREFIX="${WASM_POSIX_DEP_ZLIB_DIR:-}"
if [ -z "$ZLIB_PREFIX" ]; then
    echo "==> Resolving zlib via cargo xtask build-deps..."
    HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"
    ZLIB_PREFIX="$(cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TARGET" --quiet -- \
        build-deps resolve zlib)"
fi
if [ ! -f "$ZLIB_PREFIX/lib/libz.a" ]; then
    echo "ERROR: zlib resolve returned '$ZLIB_PREFIX' but libz.a is missing" >&2
    exit 1
fi
echo "==> zlib at $ZLIB_PREFIX"

# --- Stage verified mandoc source ---
expected_source_marker="$(printf '%s\n%s\n%s' \
    "$MANDOC_VERSION" "$SOURCE_URL" "$SOURCE_SHA256")"
if [ -d "$SRC_DIR" ] && \
   [ "$(cat "$SOURCE_MARKER" 2>/dev/null || true)" != "$expected_source_marker" ]; then
    rm -rf "$SRC_DIR"
fi
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Staging verified mandoc $MANDOC_VERSION source..."
    kandelo_package_stage_verified_source mandoc "$SRC_DIR" \
        "$VERIFIED_SOURCE_DIR" "$SOURCE_URL" "$SOURCE_SHA256" "$WORK_DIR"
    printf '%s\n' "$expected_source_marker" >"$SOURCE_MARKER"
fi

cd "$SRC_DIR"

# --- Configure ---
if [ ! -f Makefile.local ]; then
    echo "==> Configuring mandoc for wasm32..."

    # mandoc reads configure.local for cross overrides (documented at the top
    # of every knob in ./configure itself). Point the toolchain at the SDK,
    # install under /usr, and wire in zlib's cross-built include/lib.
    #
    # HAVE_ENDIAN=1 and HAVE_NANOSLEEP=1 are the only two manual overrides
    # that matter functionally: configure treats "no endian-conversion
    # function found at all" and "no nanosleep" as FATAL and aborts before
    # writing Makefile.local. Every *other* HAVE_* probe is left on
    # automatic — under cross-compilation they all fail closed to "0"
    # (compat_*.c fallback), which is safe (see file header) and matches
    # what a from-scratch/embedded mandoc port normally ships.
    # - musl's <endian.h> genuinely defines be32toh/htobe32 (verified in
    #   libc/musl/include/endian.h), so HAVE_ENDIAN=1 is accurate, not
    #   just a way to dodge the FATAL check.
    # - musl implements nanosleep() directly (no librt needed), so
    #   HAVE_NANOSLEEP=1 is accurate too.
    cat > configure.local <<EOF
CC="wasm32posix-cc"
AR="wasm32posix-ar"
CFLAGS="-O2 -I$ZLIB_PREFIX/include"
LDFLAGS="-L$ZLIB_PREFIX/lib"
PREFIX="/usr"
BINDIR="/usr/bin"
MANDIR="/usr/share/man"
HAVE_ENDIAN=1
HAVE_NANOSLEEP=1
EOF

    ./configure
    echo "==> Configure complete."
fi

# --- Build ---
echo "==> Building mandoc..."
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" 2>&1 | tail -60

# --- Install into a DESTDIR stage ---
STAGE="$WORK_DIR/stage"
rm -rf "$STAGE"
mkdir -p "$STAGE"
make DESTDIR="$STAGE" install 2>&1 | tail -60

# mandoc's own base-install already hard-links bin/man -> bin/mandoc (see
# Makefile's `$(LN) mandoc $(BINM_MAN)`, LN="ln -f" by default). Create the
# link ourselves only if that install layout ever changes upstream.
if [ ! -e "$STAGE/usr/bin/man" ]; then
    ln -f "$STAGE/usr/bin/mandoc" "$STAGE/usr/bin/man"
fi
[ -f "$STAGE/usr/bin/mandoc" ] || { echo "ERROR: mandoc binary missing after install" >&2; exit 2; }
[ -e "$STAGE/usr/bin/man" ] || { echo "ERROR: bin/man missing after install" >&2; exit 2; }

echo ""
echo "==> mandoc $MANDOC_VERSION built successfully!"

# The resolver expects the primary output as <out>/mandoc.wasm.
cp "$STAGE/usr/bin/mandoc" "$WORK_DIR/mandoc.wasm"

source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary mandoc "$WORK_DIR/mandoc.wasm"

# Stage the full install tree (mandoc/man/demandoc/soelim + man pages) for
# the browser-bundle reshaper (Task 2). This is scratch data alongside the
# declared mandoc.wasm output, not itself a declared package output.
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    cp -R "$STAGE/usr" "$WASM_POSIX_DEP_OUT_DIR/usr"
fi
