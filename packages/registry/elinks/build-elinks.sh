#!/usr/bin/env bash
set -euo pipefail

# Build ELinks 0.20.0 with QuickJS-NG JavaScript for wasm32-posix-kernel.
#
# ELinks ships two build systems. Its primary one is meson; this recipe uses
# the autoconf one instead, for two reasons:
#   - The SDK links with --allow-undefined, so every "does this function
#     exist" link probe succeeds. autoconf lets a recipe state the truth for
#     such probes through cache variables; meson has no equivalent, so its
#     has_function() answers cannot be corrected.
#   - autoconf, automake and pkg-config are already in the dev shell. meson
#     and ninja are not, and adding them would change flake.nix, which is an
#     input to every package's cache key.
#
# Output: packages/registry/elinks/bin/elinks.wasm for a direct build, or the
# resolver-owned WASM_POSIX_DEP_OUT_DIR.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$SCRIPT_DIR"
# shellcheck source=/dev/null
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"
export WASM_POSIX_DEP_WORK_DIR="$WORK_DIR"
SRC_DIR="$WORK_DIR/elinks-src"
BIN_DIR="$WORK_DIR/bin"
SOURCE_MARKER="$WORK_DIR/.kandelo-elinks-source"

ELINKS_VERSION="$WASM_POSIX_DEP_VERSION"
SOURCE_URL="$WASM_POSIX_DEP_SOURCE_URL"
SOURCE_SHA256="$WASM_POSIX_DEP_SOURCE_SHA256"
VERIFIED_SOURCE_DIR="${WASM_POSIX_DEP_SOURCE_DIR:-}"

# Always use this worktree's SDK wrappers. A resolver caller owns the work and
# output roots, so suppress the developer-only local mirror. ELinks forks (for
# DNS lookups, external viewers and its session master), so the binary must
# be fork-instrumented.
# shellcheck source=/dev/null
source "$REPO_ROOT/sdk/activate.sh"
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
fi

# wasm-ld: ELinks links each source directory into one relocatable lib.o.
# perl: generates fetch.h (see below). The autotools regenerate configure.
for tool in wasm32posix-cc wasm32posix-c++ wasm32posix-pkg-config wasm-ld \
            perl make aclocal autoheader autoconf; do
    if ! command -v "$tool" &>/dev/null; then
        echo "ERROR: $tool not found. Enter scripts/dev-shell.sh." >&2
        exit 1
    fi
done

# --- Direct dependencies ------------------------------------------------
# Every library ELinks links is a declared dependency whose prefix the
# resolver passes in. A missing one is an error, never a silent fallback.
require_dep() {
    local package="$1"
    local witness="$2"
    local key variable prefix
    key="$(printf '%s' "${package//-/_}" | tr '[:lower:]' '[:upper:]')"
    variable="WASM_POSIX_DEP_${key}_DIR"
    prefix="$(printenv "$variable" 2>/dev/null || true)"
    if [ -z "$prefix" ] || [ ! -e "$prefix/$witness" ]; then
        echo "ERROR: elinks needs $package ($variable/$witness);" >&2
        echo "       build through 'cargo xtask build-deps resolve elinks'." >&2
        exit 1
    fi
    printf '%s\n' "$prefix"
}

ZLIB_PREFIX="$(require_dep zlib lib/libz.a)"
OPENSSL_PREFIX="$(require_dep openssl lib/libssl.a)"
LIBCURL_PREFIX="$(require_dep libcurl lib/libcurl.a)"
SQLITE_PREFIX="$(require_dep sqlite lib/libsqlite3.a)"
QUICKJS_PREFIX="$(require_dep quickjs-ng lib/libqjs.a)"
LIBWAPCAPLET_PREFIX="$(require_dep libwapcaplet lib/libwapcaplet.a)"
LIBPARSERUTILS_PREFIX="$(require_dep libparserutils lib/libparserutils.a)"
LIBHUBBUB_PREFIX="$(require_dep libhubbub lib/libhubbub.a)"
LIBCSS_PREFIX="$(require_dep libcss lib/libcss.a)"
LIBDOM_PREFIX="$(require_dep libdom lib/libdom.a)"
require_dep libcxx lib/libc++.a >/dev/null

DEP_PKG_CONFIG_PATH=""
for prefix in "$ZLIB_PREFIX" "$OPENSSL_PREFIX" "$LIBCURL_PREFIX" \
              "$SQLITE_PREFIX" "$QUICKJS_PREFIX" "$LIBWAPCAPLET_PREFIX" \
              "$LIBPARSERUTILS_PREFIX" "$LIBHUBBUB_PREFIX" "$LIBCSS_PREFIX" \
              "$LIBDOM_PREFIX"; do
    DEP_PKG_CONFIG_PATH="${DEP_PKG_CONFIG_PATH:+$DEP_PKG_CONFIG_PATH:}$prefix/lib/pkgconfig"
done
if [ -n "${WASM_POSIX_DEP_PKG_CONFIG_PATH:-}" ]; then
    DEP_PKG_CONFIG_PATH="$DEP_PKG_CONFIG_PATH:$WASM_POSIX_DEP_PKG_CONFIG_PATH"
fi
export PKG_CONFIG_PATH="$DEP_PKG_CONFIG_PATH"

# libc++ is not part of the base sysroot. Overlay the declared libcxx package
# onto a private copy so the compiler finds <map> and the linker libc++.a.
SYSROOT="$(
    kandelo_package_prepare_private_sysroot elinks "$REPO_ROOT/sysroot" libcxx
)"
export WASM_POSIX_SYSROOT="$SYSROOT"

# --- Stage verified source ---------------------------------------------
# A tree staged for a different version, URL or hash is discarded rather
# than reused, so a version bump can never build the previous release.
expected_source_marker="$(printf '%s\n%s\n%s' \
    "$ELINKS_VERSION" "$SOURCE_URL" "$SOURCE_SHA256")"
if [ -d "$SRC_DIR" ] && \
   [ "$(cat "$SOURCE_MARKER" 2>/dev/null || true)" != "$expected_source_marker" ]; then
    rm -rf "$SRC_DIR" "$BIN_DIR"
fi
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Staging verified ELinks $ELINKS_VERSION source..."
    kandelo_package_stage_verified_source elinks "$SRC_DIR" \
        "$VERIFIED_SOURCE_DIR" "$SOURCE_URL" "$SOURCE_SHA256" "$WORK_DIR"
    printf '%s\n' "$expected_source_marker" >"$SOURCE_MARKER"

    # Each patch header says why it exists. Neither adapts ELinks to Kandelo:
    # 0001 removes undefined behavior that any signature-checking target
    # rejects, and 0002 is an unmodified upstream commit.
    for patch_file in "$SCRIPT_DIR"/patches/*.patch; do
        echo "==> Applying $(basename "$patch_file")..."
        kandelo_package_git_apply_patch "$SRC_DIR" "$patch_file"
    done
fi

cd "$SRC_DIR"

# --- Generated inputs ---------------------------------------------------
# src/js/Makefile embeds ELinks's fetch() implementation, fetch.js, as a C
# array by running `xxd -i fetch.js fetch.h`. xxd (part of vim) is not in the
# dev shell, and the Makefile ignores the failed $(shell ...), so the build
# would stop later on a missing header. Write the byte-identical file here:
# the same declaration, twelve bytes per line, that xxd -i emits.
perl -e '
    use strict; use warnings;
    my ($in, $name) = @ARGV;
    open(my $fh, "<:raw", $in) or die "cannot open $in: $!";
    local $/; my $data = <$fh>; close($fh);
    my @bytes = map { sprintf("0x%02x", $_) } unpack("C*", $data);
    print "unsigned char ${name}[] = {\n";
    while (my @row = splice(@bytes, 0, 12)) {
        print "  ", join(", ", @row), (@bytes ? "," : ""), "\n";
    }
    print "};\n";
    print "unsigned int ${name}_len = ", length($data), ";\n";
' src/js/fetch.js fetch_js > src/js/fetch.h

# --- Configure ----------------------------------------------------------
if [ ! -f Makefile.config ]; then
    # The release tarball ships configure.ac but no generated configure.
    echo "==> Generating configure..."
    ./autogen.sh

    echo "==> Configuring ELinks for wasm32..."

    # Answers configure cannot discover when cross-compiling. Each states
    # what the Kandelo sysroot actually provides.
    #
    # A Cygwin-only function. Its link probe "succeeds" because undefined
    # symbols become Wasm imports.
    export ac_cv_func_cygwin_conv_to_full_win32_path=no
    # AC_FUNC_MEMCMP runs a test program; musl's memcmp is 8-bit clean.
    export ac_cv_func_memcmp_working=yes
    # Also a run test: musl's vsnprintf returns the C99 would-be length.
    export el_cv_HAVE_C99_VSNPRINTF=yes
    # ELinks stamps a git commit id into the binary when it finds git. A
    # release tarball has no repository, and a build directory inside the
    # Kandelo checkout must not pick up Kandelo's.
    export ac_cv_path_GIT=

    # ELinks links every source directory into a relocatable lib.o with
    # `$(LD) -r`; that must be the Wasm linker, not the host's ld.
    #
    # --with-static makes configure ask pkg-config for --static flags. All
    # dependencies are static archives, so their own dependencies (libcurl's
    # OpenSSL and zlib, QuickJS's libm) must appear on the link line.
    #
    # Every --without/--disable below names a feature whose library Kandelo
    # does not package. They are spelled out because configure's presence
    # checks for them are link probes, which always succeed here; leaving a
    # feature to auto-detection would compile calls into a library that is
    # not there. package.toml lists what this costs users.
    #
    # --sysconfdir: the system-wide configuration is /etc/elinks/elinks.conf,
    # the path ELinks's own default prefix logic and Debian use. The shell
    # image writes that file (host/src/shell-runtime-layout.ts).
    #
    # CPPFLAGS carries QuickJS's include directory because configure.ac
    # adds quickjs-ng's libraries from pkg-config but not its cflags.
    #
    # -fwasm-exceptions/-lc++/-lc++abi: see docs/sdk-guide.md, "Linking C++
    # programs".
    LD=wasm-ld wasm32posix-configure \
        --sysconfdir=/etc/elinks \
        --with-static \
        --with-quickjs \
        --with-zlib \
        --with-openssl="$OPENSSL_PREFIX" \
        --without-gpm \
        --without-terminfo \
        --without-bzlib \
        --without-zstd \
        --without-brotli \
        --without-lzma \
        --without-idn2 \
        --without-tre \
        --without-gnutls \
        --without-libsixel \
        --without-x \
        --disable-xbel \
        --disable-backtrace \
        --disable-sftp \
        --disable-nls \
        --enable-256-colors \
        --enable-true-color \
        --enable-exmode \
        --enable-gopher \
        --enable-gemini \
        --enable-finger \
        --enable-reproducible \
        CPPFLAGS="-I$ZLIB_PREFIX/include $(wasm32posix-pkg-config --cflags quickjs-ng)" \
        CFLAGS="-O2" \
        CXXFLAGS="-O2 -fwasm-exceptions" \
        LDFLAGS="-L$ZLIB_PREFIX/lib" \
        LIBS="-lc++ -lc++abi" \
        2>&1 | tail -80

    # configure must have enabled what this package promises. A silently
    # dropped feature would otherwise ship as a smaller, quieter binary.
    for feature in CONFIG_QUICKJS CONFIG_ECMASCRIPT CONFIG_LIBDOM CONFIG_LIBCSS \
                   CONFIG_LIBCURL CONFIG_OPENSSL CONFIG_GZIP CONFIG_UTF8; do
        if ! grep -Eq "^#define $feature 1\$" config.h; then
            echo "ERROR: ELinks configure did not enable $feature" >&2
            exit 1
        fi
    done
    echo "==> Configure complete."
fi

# --- Build --------------------------------------------------------------
# Only src/: the top-level Makefile would also build documentation with
# whatever asciidoc/xmlto it found on the build machine.
echo "==> Building ELinks..."
make -C src -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" GIT= 2>&1 | tail -30

if [ ! -f "$SRC_DIR/src/elinks" ]; then
    echo "ERROR: elinks binary not found after build" >&2
    exit 1
fi

mkdir -p "$BIN_DIR"
cp "$SRC_DIR/src/elinks" "$BIN_DIR/elinks.wasm"
ls -lh "$BIN_DIR/elinks.wasm"

# Apply the normal artifact guards and fork instrumentation, then install to
# the direct-build mirror or the caller-owned resolver output root.
cd "$REPO_ROOT"
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary elinks "$BIN_DIR/elinks.wasm" elinks.wasm
