#!/usr/bin/env bash
#
# Build ICU4C (libicuuc.a, libicui18n.a, libicudata.a stub + icu.dat) for
# wasm32-posix-kernel.
#
# ICU requires a TWO-STAGE build:
#
#   Stage 1 (HOST): build ICU natively to produce the data-generation tools
#                   (genrb, pkgdata, icupkg, genccode, …) and the ICU common
#                   data. These run on the build machine.
#   Stage 2 (CROSS): configure ICU for wasm32 with --with-cross-build pointing
#                   at the stage-1 build dir. The cross build reuses the host
#                   tools and host-generated data; it only compiles the C++
#                   sources into wasm32 static libraries.
#
# Data is built in `archive` packaging mode, which emits the ICU common data as
# a standalone `icudt<ver>l.dat` file (NOT linked into libicudata.a — that
# becomes a stub). We install that file as `share/icu.dat`; PHP's intl side
# module loads it at runtime via udata_setCommonData() (the name `icu.dat` is
# deliberate and is NOT ICU's default-searched name). See
# packages/registry/php/build-php.sh for the intl side.
#
# Honors the dep-resolver build-script contract (see docs/package-management.md).
# When invoked via `cargo xtask build-deps resolve icu`, the resolver sets:
#     WASM_POSIX_DEP_OUT_DIR        # where to install
#     WASM_POSIX_DEP_VERSION        # upstream version (e.g. "74.2")
#     WASM_POSIX_DEP_SOURCE_URL     # tarball URL
#     WASM_POSIX_DEP_SOURCE_SHA256  # expected sha256 of the tarball
#     WASM_POSIX_DEP_LIBCXX_DIR     # resolved libcxx prefix (direct dep)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/sdk/activate.sh"

if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found after sourcing sdk/activate.sh." >&2
    exit 1
fi

# --- Inputs from resolver, with ad-hoc fallbacks ---
ICU_VERSION="${WASM_POSIX_DEP_VERSION:-${ICU_VERSION:-74.2}}"
ICU_VER_UNDERSCORE="${ICU_VERSION//./_}"          # 74.2 -> 74_2
ICU_MAJOR="${ICU_VERSION%%.*}"                     # 74.2 -> 74
TARGET_ARCH="${WASM_POSIX_DEP_TARGET_ARCH:-wasm32}"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/icu-install}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://github.com/unicode-org/icu/releases/download/release-${ICU_MAJOR}-${ICU_VERSION#*.}/icu4c-${ICU_VER_UNDERSCORE}-src.tgz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-68db082212a96d6f53e35d60f47d38b962e9f9d207a74cfac78029ae8ff5e08c}"

SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"
export WASM_POSIX_SYSROOT="$SYSROOT"

if [ "$TARGET_ARCH" != "wasm32" ]; then
    echo "ERROR: ICU currently supports only wasm32, got $TARGET_ARCH" >&2
    exit 1
fi

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/kandelo-icu.XXXXXX")"
cleanup() {
    status=$?
    trap - EXIT
    if [ "${WASM_POSIX_KEEP_BUILD_DIR:-0}" = "1" ]; then
        echo "==> Preserving ICU build directory: $WORK_DIR" >&2
    else
        rm -rf "$WORK_DIR"
    fi
    exit "$status"
}
trap cleanup EXIT

SRC_ROOT="$WORK_DIR/source"             # contains icu/ (with source/)
ICU_SRC="$SRC_ROOT/icu/source"
HOST_BUILD="$WORK_DIR/host-build"       # stage-1 native build (out-of-tree)

# --- Resolve libcxx (ICU is C++), symlink into sysroot (mariadb pattern) ---
HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"
resolve_dep() {
    (cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TARGET" --quiet -- build-deps --arch "$TARGET_ARCH" resolve "$1")
}
LIBCXX_PREFIX="${WASM_POSIX_DEP_LIBCXX_DIR:-}"
if [ -z "$LIBCXX_PREFIX" ]; then
    echo "==> Resolving libcxx via cargo xtask build-deps..."
    LIBCXX_PREFIX="$(resolve_dep libcxx)"
fi
[ -f "$LIBCXX_PREFIX/lib/libc++.a" ]     || { echo "ERROR: libcxx resolve missing libc++.a at $LIBCXX_PREFIX" >&2; exit 1; }
[ -f "$LIBCXX_PREFIX/lib/libc++abi.a" ]  || { echo "ERROR: libcxx resolve missing libc++abi.a at $LIBCXX_PREFIX" >&2; exit 1; }
[ -d "$LIBCXX_PREFIX/include/c++/v1" ]   || { echo "ERROR: libcxx resolve missing include/c++/v1 at $LIBCXX_PREFIX" >&2; exit 1; }

echo "==> Linking libcxx into sysroot ($LIBCXX_PREFIX)..."
mkdir -p "$SYSROOT/lib" "$SYSROOT/include/c++"
ln -sf  "$LIBCXX_PREFIX/lib/libc++.a"    "$SYSROOT/lib/libc++.a"
ln -sf  "$LIBCXX_PREFIX/lib/libc++abi.a" "$SYSROOT/lib/libc++abi.a"
rm -rf  "$SYSROOT/include/c++/v1"
ln -sfn "$LIBCXX_PREFIX/include/c++/v1"  "$SYSROOT/include/c++/v1"

# --- Fetch + verify source ---
if [ ! -d "$ICU_SRC" ]; then
    echo "==> Downloading ICU $ICU_VERSION..."
    TARBALL="$WORK_DIR/icu4c-${ICU_VER_UNDERSCORE}-src.tgz"
    curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors -fsSL "$SOURCE_URL" -o "$TARBALL"
    echo "==> Verifying source sha256..."
    echo "$SOURCE_SHA256  $TARBALL" | shasum -a 256 -c -
    mkdir -p "$SRC_ROOT"
    tar xzf "$TARBALL" -C "$SRC_ROOT"    # extracts icu/
    rm "$TARBALL"
fi

NPROC="$(sysctl -n hw.ncpu 2>/dev/null || nproc)"

run_logged() {
    local label="$1"
    shift
    local log="$WORK_DIR/$label.log"
    if "$@" >"$log" 2>&1; then
        tail -20 "$log"
        return 0
    fi
    echo "ERROR: $label failed; final log follows:" >&2
    tail -200 "$log" >&2
    return 1
}

# ============================================================
# Stage 1 — HOST build (native tools + data)
# ============================================================
# Uses the host compiler wrappers (`cc`/`c++` from the dev shell), NOT the wasm
# wrappers. The wrapper names matter in Nix: they add the declared host SDK and
# C++ standard-library paths, while a raw `clang++` earlier on PATH may not be
# able to find headers such as `<memory>`. sdk/activate.sh only prepends SDK bin
# to PATH; it does not export CC/CXX, so an explicit host CC/CXX keeps this
# stage native.
#
# On Linux, statically fold the GNU C++/GCC runtime into the data tools: the Nix
# CI runner has no libstdc++.so.6 on its loader path, so a dynamically linked
# icupkg/pkgdata (run here by Stage 2's make) aborts at exec with "cannot open
# shared object file". macOS clang links a self-contained libc++ and rejects the
# flags. LDFLAGS set here is honored: runConfigureICU re-exports it to configure.
case "$(uname -s)" in
    Linux) HOST_LDFLAGS="-static-libstdc++ -static-libgcc" ;;
    *)     HOST_LDFLAGS="" ;;
esac
if [ ! -x "$HOST_BUILD/bin/icupkg" ] && [ ! -x "$HOST_BUILD/bin/genccode" ]; then
    echo "==> Stage 1: building ICU natively for host tools + data..."
    rm -rf "$HOST_BUILD"
    mkdir -p "$HOST_BUILD"
    ( cd "$HOST_BUILD"
      CC="${HOST_CC:-cc}" CXX="${HOST_CXX:-c++}" \
      LDFLAGS="$HOST_LDFLAGS" \
        "$ICU_SRC/runConfigureICU" MacOSX \
            --enable-static --disable-shared \
            --disable-samples --disable-tests --disable-extras
      run_logged host-make make -j"$NPROC"
    )
else
    echo "==> Stage 1: reusing existing host build at $HOST_BUILD"
fi

# ============================================================
# Stage 2 — CROSS build (wasm32 static libs)
# ============================================================
echo "==> Stage 2: cross-configuring ICU for wasm32..."
# In-tree cross build (wasm32posix-configure runs ./configure in CWD).
# Scrub any prior cross-build state in the source tree.
cd "$ICU_SRC"
make distclean 2>/dev/null || true

# ICU maps the configure host triple to a config/mh-<platform> makefile
# fragment. Our SDK forces --host=wasm32-unknown-none, whose OS component
# ("none") ICU does not recognize, so it selects the stock config/mh-unknown —
# a stub that hard-errors "configure could not detect your platform" and aborts
# `make`. ICU's own remedy (printed in that error) is to supply mh-unknown from
# a known platform. We use mh-linux: this is a --disable-shared --enable-static
# build, so mh-linux's Linux shared-library rules are never exercised; only its
# generic compile rules apply, driven by our wasm CC/CXX. Idempotent overwrite,
# re-applied every run because a fresh source extraction resets it.
cp "$ICU_SRC/config/mh-linux" "$ICU_SRC/config/mh-unknown"

# C++ flags: ICU 74 needs C++17. libc++ headers come from the sysroot symlink.
# LDFLAGS carries -lc++ -lc++abi so configure's C++ link probes resolve.
# -fPIC: ICU's static libs are absorbed into intl.so, a wasm SIDE MODULE linked
# with `-shared --experimental-pic`. wasm-ld requires EVERY input object to be
# position-independent; a non-PIC ICU object triggers "R_WASM_MEMORY_ADDR_SLEB
# cannot be used against symbol ...; recompile with -fPIC" at the intl.so link.
CXXFLAGS="-O2 -std=c++17 -fPIC" \
CFLAGS="-O2 -fPIC" \
LDFLAGS="-lc++ -lc++abi" \
wasm32posix-configure \
    --with-cross-build="$HOST_BUILD" \
    --enable-static --disable-shared \
    --disable-tools --disable-tests --disable-samples --disable-extras \
    --disable-layoutex \
    --with-data-packaging=archive \
    --prefix="$INSTALL_DIR"

echo "==> Stage 2: building wasm32 libraries..."
# ICU bakes ICUDATA_DIR into common/putil.ao when data packaging is `common`.
# The resolver install prefix is a random `.tmp-<pid>` directory, so leaving
# the generated default in place makes libicuuc.a differ on every clean build.
# The PHP extension stages icu.dat at this stable guest directory and calls
# udata_setCommonData() explicitly; use the same path for the fallback string.
run_logged wasm-make make -j"$NPROC" ICUDATA_DIR=/usr/lib/php

echo "==> Installing to $INSTALL_DIR..."
rm -rf "$INSTALL_DIR"
run_logged wasm-install make install

# ICU's generated pkg-config metadata records --prefix verbatim. Resolver
# builds install into a temporary directory and later rewrite that to the
# producer's canonical cache path, which still breaks after an archive is
# fetched or moved elsewhere. Keep the metadata package-relative instead: each
# file lives in lib/pkgconfig, so pcfiledir/../.. is the current ICU prefix in
# every cache, extracted archive, or local overlay.
for pc in icu-uc.pc icu-i18n.pc icu-io.pc; do
    pc_path="$INSTALL_DIR/lib/pkgconfig/$pc"
    [ -f "$pc_path" ] || { echo "ERROR: missing ICU pkg-config output $pc_path" >&2; exit 1; }
    sed 's|^prefix = .*|prefix = ${pcfiledir}/../..|' "$pc_path" > "$pc_path.tmp"
    mv "$pc_path.tmp" "$pc_path"
done

# --- Stage the common data as icu.dat (see header) ---
DAT_SRC="$(find "$ICU_SRC/data" "$HOST_BUILD/data" -name "icudt${ICU_MAJOR}l.dat" 2>/dev/null | head -1 || true)"
if [ -z "$DAT_SRC" ]; then
    echo "ERROR: could not locate icudt${ICU_MAJOR}l.dat after build" >&2
    exit 1
fi
mkdir -p "$INSTALL_DIR/share"
cp "$DAT_SRC" "$INSTALL_DIR/share/icu.dat"
echo "==> staged $(basename "$DAT_SRC") -> $INSTALL_DIR/share/icu.dat ($(wc -c < "$INSTALL_DIR/share/icu.dat") bytes)"

# --- Sanity: the static libs we promise (icuio included: PHP's PHP_SETUP_ICU
# requires the icu-io pkg-config module, so intl won't configure without it) ---
for lib in libicuuc.a libicui18n.a libicuio.a libicudata.a; do
    [ -f "$INSTALL_DIR/lib/$lib" ] || { echo "ERROR: missing $INSTALL_DIR/lib/$lib" >&2; exit 1; }
done
echo "==> ICU build complete."
ls -lh "$INSTALL_DIR/lib/"*.a "$INSTALL_DIR/share/icu.dat"
