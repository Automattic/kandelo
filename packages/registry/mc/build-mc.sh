#!/usr/bin/env bash
set -euo pipefail

# Build GNU Midnight Commander 4.8.32 for wasm32-posix-kernel.
#
# Uses the SDK's wasm32posix-configure wrapper for cross-compilation and
# consumes glib, ncurses and pcre2 from the package resolver.
#
# Outputs:
#   mc.wasm          the file manager (mcedit/mcview/mcdiff are the same
#                    binary selected by argv[0]; the browser bundle adds
#                    those names as symlinks)
#   mc-runtime.zip   the /usr-rooted data tree mc loads at startup
#                    (share/mc skins, syntax, help; libexec/mc helpers)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"
SRC_DIR="$WORK_DIR/mc-src"
BIN_DIR="$WORK_DIR/bin"
SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"
MC_VERSION="${WASM_POSIX_DEP_VERSION:-${MC_VERSION:-4.8.32}}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://ftp.osuosl.org/pub/midnightcommander/mc-${MC_VERSION}.tar.xz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-4ddc83d1ede9af2363b3eab987f54b87cf6619324110ce2d3a0e70944d1359fe}"
VERIFIED_SOURCE_DIR="${WASM_POSIX_DEP_SOURCE_DIR:-}"
SOURCE_MARKER="$SRC_DIR/.kandelo-mc-source"

# Always use this worktree's SDK wrappers. A resolver/Formula caller owns the
# work and output roots, so suppress the developer-only local mirror. mc forks
# for its subshell, for every command run from its prompt, and for background
# file operations, so instrumentation is required, not optional.
# shellcheck source=/dev/null
source "$REPO_ROOT/sdk/activate.sh"
if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ] && [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
fi

# --- Prerequisites ---
if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Enter scripts/dev-shell.sh." >&2
    exit 1
fi
if [ ! -f "$SYSROOT/lib/libc.a" ]; then
    echo "ERROR: sysroot not found. Run: scripts/dev-shell.sh ./run.sh setup" >&2
    exit 1
fi
export WASM_POSIX_SYSROOT="$SYSROOT"

# --- Resolve link-time dependencies via the dep cache ---
# Env-var short-circuit lets an outer resolver run pass each prefix in
# directly without re-invoking cargo.
HOST_TARGET=""
resolve_dep() {
    local name="$1"
    if [ "${WASM_POSIX_RESOLUTION_POLICY:-}" = "source-only-v1" ]; then
        echo "ERROR: mc SourceOnly requires a resolver-provided $name" >&2
        exit 2
    fi
    if [ -z "$HOST_TARGET" ]; then
        HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"
    fi
    (cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TARGET" --quiet -- \
        build-deps resolve "$name")
}

GLIB_PREFIX="${WASM_POSIX_DEP_GLIB_DIR:-}"
[ -n "$GLIB_PREFIX" ] || GLIB_PREFIX="$(resolve_dep glib)"
NCURSES_PREFIX="${WASM_POSIX_DEP_NCURSES_DIR:-}"
[ -n "$NCURSES_PREFIX" ] || NCURSES_PREFIX="$(resolve_dep ncurses)"
PCRE2_PREFIX="${WASM_POSIX_DEP_PCRE2_DIR:-}"
[ -n "$PCRE2_PREFIX" ] || PCRE2_PREFIX="$(resolve_dep pcre2)"

for probe in \
    "$GLIB_PREFIX/lib/libglib-2.0.a" \
    "$NCURSES_PREFIX/lib/libncursesw.a" \
    "$PCRE2_PREFIX/lib/libpcre2-8.a"
do
    [ -f "$probe" ] || {
        echo "ERROR: resolved dependency is missing $probe" >&2
        exit 1
    }
done
echo "==> glib    at $GLIB_PREFIX"
echo "==> ncurses at $NCURSES_PREFIX"
echo "==> pcre2   at $PCRE2_PREFIX"

# --- Stage verified mc source ---
expected_source_marker="$(printf '%s\n%s\n%s' \
    "$MC_VERSION" "$SOURCE_URL" "$SOURCE_SHA256")"
if [ -d "$SRC_DIR" ] && \
   [ "$(cat "$SOURCE_MARKER" 2>/dev/null || true)" != "$expected_source_marker" ]; then
    rm -rf "$SRC_DIR" "$BIN_DIR"
fi
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Staging verified mc $MC_VERSION source..."
    kandelo_package_stage_verified_source mc "$SRC_DIR" \
        "$VERIFIED_SOURCE_DIR" "$SOURCE_URL" "$SOURCE_SHA256" "$WORK_DIR"
    # mc casts g_ascii_strcasecmp (two parameters) to GCompareDataFunc
    # (three) when building its event GTrees. That is undefined behaviour
    # in C; native ABIs tolerate it, and WebAssembly's typed call_indirect
    # traps on it, so mc aborted during events_init before drawing
    # anything. See the patch header for the full stack.
    patch -d "$SRC_DIR" -p1 < "$SCRIPT_DIR/src/wasm-callback-signatures.patch"
    printf '%s\n' "$expected_source_marker" >"$SOURCE_MARKER"
fi

cd "$SRC_DIR"

# --- Configure ---
if [ ! -f Makefile ]; then
    echo "==> Configuring mc for wasm32..."

    # glib is a static archive, so name the libraries mc's final link needs
    # directly instead of going through pkg-config: glib-2.0.pc's
    # `Requires: libpcre2-8` would otherwise have to resolve through a
    # second .pc search path. Setting both halves of a PKG_CHECK_MODULES
    # pair is autoconf's documented override and skips the probe entirely.
    export GLIB_CFLAGS="-I${GLIB_PREFIX}/include/glib-2.0 -I${GLIB_PREFIX}/lib/glib-2.0/include"
    export GLIB_LIBS="-L${GLIB_PREFIX}/lib -lglib-2.0 -L${PCRE2_PREFIX}/lib -lpcre2-8"
    # gmodule is optional in mc (m4.include/mc-glib.m4 only uses it to
    # decide whether to link X11, which we do not). Leave GMODULE_* unset
    # so the probe fails honestly and HAVE_GMODULE stays undefined.

    # Name the screen library explicitly rather than letting configure
    # discover it. mc's --with-ncurses-includes/--with-ncurses-libs only
    # feed the non-wide mc_CHECK_NCURSES_BY_PATH path; mc_WITH_NCURSESW
    # reads plain CPPFLAGS and AC_SEARCH_LIBS. And the search could not
    # work here in any case: the SDK links with -Wl,--allow-undefined
    # (sdk/src/lib/flags.ts), so every autoconf link probe succeeds
    # whether or not the library is present — AC_SEARCH_LIBS reports
    # "none required" and would leave mc linking against nothing, with
    # the missing symbols deferred to unresolved Wasm imports that only
    # fail at instantiation. build-nano.sh pins NCURSESW_LIBS for the
    # same reason. LIBS (not LDFLAGS) because automake puts $(LIBS) last
    # on the link line, after the objects that reference these archives.
    export CPPFLAGS="${CPPFLAGS:-} -I${NCURSES_PREFIX}/include"
    export LIBS="${LIBS:-} -L${NCURSES_PREFIX}/lib -lncursesw -ltinfow"

    # Function-existence cache seeds, for the same --allow-undefined
    # reason: AC_CHECK_FUNCS is a link test, so every probe below would
    # answer "yes" and mc would compile calls to functions that resolve
    # to nothing. Left undeclared, HAVE_STATLSTAT alone breaks the build
    # (src/vfs/local/local.c:164 calls statlstat, an SCO-ism musl has
    # never had). Each value was checked against the archives that
    # actually define the symbol, per the rule in sdk/config.site.
    #
    # Absent from musl (verified with wasm32posix-nm over sysroot/lib):
    export ac_cv_func_statlstat=no       # SCO lstat variant
    export ac_cv_func_getpt=no           # glibc-only; mc falls back to posix_openpt
    export ac_cv_func_fs_stat_dev=no     # BeOS/Haiku mount enumeration
    export ac_cv_func_listmntent=no      # HP-UX mount enumeration
    export ac_cv_func_next_dev=no        # BSD mount enumeration
    export ac_cv_func_shl_load=no        # HP-UX shared-library loader
    export ac_cv_func_rresvport=no       # rlogin-era privileged-port helper
    export ac_cv_func_pmap_set=no        # Sun RPC portmapper; no RPC in musl
    export ac_cv_func_pmap_getport=no
    export ac_cv_func_pmap_getmaps=no
    # libdl.a exists in the sysroot but defines no symbols: Kandelo has no
    # runtime dynamic loading, so this must answer honestly rather than
    # leave mc calling an import that can never be satisfied.
    export ac_cv_func_dlopen=no
    # Present, but in ncursesw rather than libc — configure only sees it
    # because we put the screen library on LIBS above.
    export ac_cv_func_resizeterm=yes

    wasm32posix-configure \
        --with-screen=ncursesw \
        --with-search-engine=glib \
        --without-x \
        --disable-nls \
        --disable-vfs-sftp \
        --disable-vfs-shell \
        --disable-vfs-ftp \
        --disable-doxygen-doc \
        --disable-tests \
        2>&1 | tail -40

    echo "==> Configure complete."
fi

# --- Build ---
echo "==> Building mc..."
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" 2>&1 | tail -40

echo "==> Collecting binary..."
mkdir -p "$BIN_DIR"
if [ ! -f "$SRC_DIR/src/mc" ]; then
    echo "ERROR: mc binary not found after build" >&2
    exit 1
fi
cp "$SRC_DIR/src/mc" "$BIN_DIR/mc.wasm"
ls -lh "$BIN_DIR/mc.wasm"

# --- Runtime data archive ---
# `make install` into a throwaway DESTDIR: it never touches the host /usr.
# mc will not start without share/mc (the default skin defines every colour
# pair the UI draws with), so this archive is a hard runtime requirement,
# not documentation.
echo "==> Installing mc data files into a DESTDIR staging prefix..."
MC_STAGE="$WORK_DIR/install-stage"
rm -rf "$MC_STAGE"
mkdir -p "$MC_STAGE"
make install DESTDIR="$MC_STAGE" 2>&1 | tail -20

# Assert each of the three trees mc needs at runtime. A missing one does
# not stop mc from starting, it degrades it silently — no colours, no
# file-type actions, no keybindings — which is exactly the kind of
# half-working install that should fail the build instead.
for required in \
    "$MC_STAGE/usr/share/mc/skins/default.ini" \
    "$MC_STAGE/usr/etc/mc/mc.ext.ini" \
    "$MC_STAGE/usr/etc/mc/mc.default.keymap"
do
    [ -f "$required" ] || {
        echo "ERROR: staged mc data is missing $required" >&2
        exit 1
    }
done

RUNTIME_STAGE="$WORK_DIR/mc-runtime-stage"
rm -rf "$RUNTIME_STAGE"
mkdir -p "$RUNTIME_STAGE/share" "$RUNTIME_STAGE/etc"
# Root the archive the way mc's compiled-in paths expect, so consumers
# mount it at /usr: share/mc (skins, syntax, help), etc/mc (configured
# --prefix=/usr puts sysconfdir at /usr/etc, so this is /usr/etc/mc, not
# /etc/mc) and libexec/mc (the ext.d/extfs.d helper scripts).
cp -R "$MC_STAGE/usr/share/mc" "$RUNTIME_STAGE/share/mc"
cp -R "$MC_STAGE/usr/etc/mc" "$RUNTIME_STAGE/etc/mc"
if [ -d "$MC_STAGE/usr/libexec/mc" ]; then
    mkdir -p "$RUNTIME_STAGE/libexec"
    cp -R "$MC_STAGE/usr/libexec/mc" "$RUNTIME_STAGE/libexec/mc"
fi
# Drop the man pages: several hundred KB that the runtime never reads.
rm -rf "$RUNTIME_STAGE/share/man"

MC_RUNTIME_ZIP="$WORK_DIR/mc-runtime.zip"
rm -f "$MC_RUNTIME_ZIP"
bash "$REPO_ROOT/images/vfs/scripts/create-deterministic-zip.sh" \
    "$RUNTIME_STAGE" "$MC_RUNTIME_ZIP"
echo "==> mc-runtime.zip: $(find "$RUNTIME_STAGE" -type f | wc -l | tr -d ' ') files"

# Apply normal artifact guards and install either to the direct-build mirror
# or to the caller-owned resolver/Formula output root.
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary mc "$BIN_DIR/mc.wasm" mc.wasm
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    cp "$MC_RUNTIME_ZIP" "$WASM_POSIX_DEP_OUT_DIR/mc-runtime.zip"
    echo "  installed $WASM_POSIX_DEP_OUT_DIR/mc-runtime.zip (resolver scratch)"
else
    install_local_runtime_file mc "$MC_RUNTIME_ZIP"
fi

echo "==> mc built successfully!"
