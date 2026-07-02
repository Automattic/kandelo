#!/usr/bin/env bash
set -euo pipefail

# Builds two PHP binaries from one source tree:
#
#   sapi/cli/php        → php.wasm     (CLI)
#   sapi/fpm/php-fpm    → php-fpm.wasm (FastCGI Process Manager;
#                                       fork-instrumented)
#
# The two builds were previously separate scripts (this one + the
# now-removed packages/registry/nginx/demo/build-php-fpm.sh). Unifying them lets a
# single autoconf invocation produce both sapis from one source tree
# and one set of patched config.h/Makefile.
#
# CFLAGS/LDFLAGS are set to FPM's stricter requirements. CLI ships
# with the same flags for debuggability.

PHP_VERSION="${PHP_VERSION:-8.3.15}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$SCRIPT_DIR/php-src"
INSTALL_DIR="$SCRIPT_DIR/php-install"

REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# Worktree-local SDK on PATH (no global npm link required).
# shellcheck source=/dev/null
source "$REPO_ROOT/sdk/activate.sh"

if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found after sourcing sdk/activate.sh." >&2
    exit 1
fi

SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"
export WASM_POSIX_SYSROOT="$SYSROOT"

# --- Resolve cache deps via cargo xtask build-deps ---
HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"
resolve_dep() {
    local name="$1"
    (cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TARGET" --quiet -- build-deps resolve "$name")
}

ZLIB_PREFIX="${WASM_POSIX_DEP_ZLIB_DIR:-}"
[ -z "$ZLIB_PREFIX" ] && { echo "==> Resolving zlib..."; ZLIB_PREFIX="$(resolve_dep zlib)"; }
SQLITE_PREFIX="${WASM_POSIX_DEP_SQLITE_DIR:-}"
[ -z "$SQLITE_PREFIX" ] && { echo "==> Resolving sqlite..."; SQLITE_PREFIX="$(resolve_dep sqlite)"; }
OPENSSL_PREFIX="${WASM_POSIX_DEP_OPENSSL_DIR:-}"
[ -z "$OPENSSL_PREFIX" ] && { echo "==> Resolving openssl..."; OPENSSL_PREFIX="$(resolve_dep openssl)"; }
LIBXML2_PREFIX="${WASM_POSIX_DEP_LIBXML2_DIR:-}"
[ -z "$LIBXML2_PREFIX" ] && { echo "==> Resolving libxml2..."; LIBXML2_PREFIX="$(resolve_dep libxml2)"; }
# ICU + libcxx back the intl side module only; they are linked into intl.so, not
# php.wasm (see the intl.so build below), so base PHP stays ICU-free.
ICU_PREFIX="${WASM_POSIX_DEP_ICU_DIR:-}"
[ -z "$ICU_PREFIX" ] && { echo "==> Resolving icu..."; ICU_PREFIX="$(resolve_dep icu)"; }
LIBCXX_PREFIX="${WASM_POSIX_DEP_LIBCXX_DIR:-}"
[ -z "$LIBCXX_PREFIX" ] && { echo "==> Resolving libcxx..."; LIBCXX_PREFIX="$(resolve_dep libcxx)"; }
[ -f "$ZLIB_PREFIX/lib/libz.a" ] || { echo "ERROR: zlib resolve missing libz.a"; exit 1; }
[ -f "$SQLITE_PREFIX/lib/libsqlite3.a" ] || { echo "ERROR: sqlite resolve missing libsqlite3.a"; exit 1; }
[ -f "$OPENSSL_PREFIX/lib/libssl.a" ] || { echo "ERROR: openssl resolve missing libssl.a"; exit 1; }
[ -f "$LIBXML2_PREFIX/lib/libxml2.a" ] || { echo "ERROR: libxml2 resolve missing libxml2.a"; exit 1; }
[ -f "$ICU_PREFIX/lib/libicuuc.a" ] || { echo "ERROR: icu resolve missing libicuuc.a"; exit 1; }
[ -f "$ICU_PREFIX/share/icu.dat" ] || { echo "ERROR: icu resolve missing share/icu.dat"; exit 1; }
[ -f "$LIBCXX_PREFIX/lib/libc++.a" ] || { echo "ERROR: libcxx resolve missing libc++.a"; exit 1; }
# A -shared PIC side module needs the position-independent libc++ (libcxx
# revision >= 6); the non-PIC pair above is for the main php.wasm link.
[ -f "$LIBCXX_PREFIX/lib/libc++-pic.a" ] || { echo "ERROR: libcxx resolve missing libc++-pic.a — rebuild libcxx (revision >= 6)"; exit 1; }
[ -f "$LIBCXX_PREFIX/lib/libc++abi-pic.a" ] || { echo "ERROR: libcxx resolve missing libc++abi-pic.a — rebuild libcxx (revision >= 6)"; exit 1; }
echo "==> zlib at $ZLIB_PREFIX"
echo "==> sqlite at $SQLITE_PREFIX"
echo "==> openssl at $OPENSSL_PREFIX"
echo "==> libxml2 at $LIBXML2_PREFIX"
echo "==> icu at $ICU_PREFIX"
echo "==> libcxx at $LIBCXX_PREFIX"

# Make libc++ visible in the sysroot so ext/intl (C++) compiles and intl.so
# links against it (mirrors packages/registry/mariadb/build-mariadb.sh).
mkdir -p "$SYSROOT/lib" "$SYSROOT/include/c++"
ln -sf  "$LIBCXX_PREFIX/lib/libc++.a"    "$SYSROOT/lib/libc++.a"
ln -sf  "$LIBCXX_PREFIX/lib/libc++abi.a" "$SYSROOT/lib/libc++abi.a"
rm -rf  "$SYSROOT/include/c++/v1"
ln -sfn "$LIBCXX_PREFIX/include/c++/v1"  "$SYSROOT/include/c++/v1"
# Enabling a C++ extension makes PHP's PHP_REQUIRE_CXX append -lstdc++ to the
# main SAPI link (upstream assumes GNU libstdc++, but our runtime is LLVM
# libc++). intl bundles its own libc++, so the main SAPIs reference no C++
# symbols and -lstdc++ only needs to resolve — bridge the name to our libc++.
ln -sf  "$LIBCXX_PREFIX/lib/libc++.a"    "$SYSROOT/lib/libstdc++.a"

# Compose PKG_CONFIG_PATH so wasm32posix-configure's pkg-config probes can find
# the deps in the cache instead of the sysroot. ICU is included so PHP_SETUP_ICU
# detects it and enables the (shared) intl extension.
DEP_PKG_CONFIG_PATH="$ZLIB_PREFIX/lib/pkgconfig:$SQLITE_PREFIX/lib/pkgconfig:$OPENSSL_PREFIX/lib/pkgconfig:$LIBXML2_PREFIX/lib/pkgconfig:$ICU_PREFIX/lib/pkgconfig"

# Compose -I and -L flags for defense-in-depth (autoconf raw probes).
# ICU's -I/-L are deliberately omitted so ICU can't leak into the main link;
# ext/intl gets ICU_CFLAGS/ICU_LIBS from configure and intl.so links ICU below.
DEP_CPPFLAGS="-I$ZLIB_PREFIX/include -I$SQLITE_PREFIX/include -I$OPENSSL_PREFIX/include -I$LIBXML2_PREFIX/include"
DEP_LDFLAGS="-L$ZLIB_PREFIX/lib -L$SQLITE_PREFIX/lib -L$OPENSSL_PREFIX/lib -L$LIBXML2_PREFIX/lib"

if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading PHP $PHP_VERSION..."
    TARBALL="php-${PHP_VERSION}.tar.gz"
    curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors -fsSL "https://www.php.net/distributions/${TARBALL}" -o "/tmp/${TARBALL}"
    mkdir -p "$SRC_DIR"
    tar xzf "/tmp/${TARBALL}" -C "$SRC_DIR" --strip-components=1
    rm "/tmp/${TARBALL}"
fi

cd "$SRC_DIR"

# Apply patches for Wasm compatibility
echo "==> Patching PHP for Wasm..."

# Disable inline assembly in Zend (safety net — Wasm doesn't match arch guards anyway)
if ! grep -q 'ZEND_USE_ASM_ARITHMETIC 0' Zend/zend_multiply.h 2>/dev/null; then
    if [ -f Zend/zend_multiply.h ]; then
        sed -i.bak '1i\
#define ZEND_USE_ASM_ARITHMETIC 0
' Zend/zend_multiply.h && rm -f Zend/zend_multiply.h.bak
    fi
fi

# opcache's MAP_ANON shared-memory probe is an AC_RUN_IFELSE that fails
# under cross-compilation; the fallback only sets have_shm_mmap_anon=yes
# for *linux* hosts (configure ext/opcache/config.m4). Without this
# patch, configure rejects --enable-opcache with "No supported shared
# memory caching support". For our wasm target the runtime semantics
# are fine: each php-fpm worker is its own wasm instance, so an
# MAP_SHARED|MAP_ANON allocation is naturally per-process — exactly the
# per-worker opcache the user wants. Flip the cross-compile fallback's
# *) branch from "no" to "yes" so opcache builds. The pattern
# "      have_shm_mmap_anon=no" followed by "      ;;" appears only in
# that fallback (the AC_RUN_IFELSE failure branch is one-line:
# `e) have_shm_mmap_anon=no ;;`).
if [ -f configure ] && ! grep -q "wasm-opcache patch applied" configure; then
    perl -i.bak -0pe 's/      have_shm_mmap_anon=no\n      ;;/      have_shm_mmap_anon=yes\n      ;; # wasm-opcache patch applied/' configure
    rm -f configure.bak
fi

# Default opcache.enable to "0" (was "1"). Rationale: PHP's built-in dev
# server (`php -S`) uses the cli-server SAPI, which IS in opcache's
# supported_sapis list (only the bare `cli` SAPI is gated by
# `opcache.enable_cli`). With the upstream default of "1", every CLI
# invocation under cli-server pays opcache MINIT cost (128MB SHM
# allocation + per-request validation) — heavy enough to push the
# wordpress-site-editor E2E test (packages/registry/wordpress/test/) past its
# 10-minute install deadline on CI runners. Our LAMP/WP/nginx-php
# php-fpm demos explicitly set opcache.enable=1 in /etc/php.ini, so
# flipping the compile-time default to "0" preserves the per-worker
# bytecode-cache win for FPM while leaving CLI / cli-server behavior
# pre-PR-identical.
if [ -f ext/opcache/zend_accelerator_module.c ] \
   && ! grep -q "wasm-opcache enable=0 patch applied" ext/opcache/zend_accelerator_module.c; then
    sed -i.bak \
        -e 's|STD_PHP_INI_BOOLEAN("opcache.enable"             , "1"|STD_PHP_INI_BOOLEAN("opcache.enable"             , "0"|' \
        ext/opcache/zend_accelerator_module.c
    # Drop a marker comment so re-running the patch is idempotent.
    if ! grep -q "wasm-opcache enable=0 patch applied" ext/opcache/zend_accelerator_module.c; then
        sed -i.bak2 '/STD_PHP_INI_BOOLEAN("opcache.enable"             , "0"/i\
/* wasm-opcache enable=0 patch applied — see packages/registry/php/build-php.sh */
' ext/opcache/zend_accelerator_module.c
    fi
    rm -f ext/opcache/zend_accelerator_module.c.bak ext/opcache/zend_accelerator_module.c.bak2
fi

echo "==> Configuring PHP for Wasm (CLI + FPM, single tree)..."
# Drop a stale config.cache from a previous build whose env (CPPFLAGS,
# PKG_CONFIG_PATH, etc.) may not match this run. autoconf would
# otherwise reject the cache with "changes in the environment can
# compromise the build" — recovering requires a fresh cache anyway.
rm -f "$SCRIPT_DIR/config.cache"
if [ ! -f Makefile ]; then
    # LDFLAGS notes (kept OUTSIDE the line-continuation block below
    # because `# comment` lines inside a `\`-continued bash block
    # terminate the continuation — env vars set on lines before the
    # comment apply only to the comment itself, which is a no-op
    # statement. The result: PKG_CONFIG_PATH was silently dropped on
    # the wasm32posix-configure invocation, libxml-2.0 lookup failed,
    # and the whole PHP build aborted at "Package requirements
    # (libxml-2.0 >= 2.9.0) were not met").
    #
    # -ldl: pulls libc/glue/dlopen.c into the link, providing the `dlopen`
    # symbol PHP uses to load Zend extensions like opcache.so. Without
    # this, PHP runs but reports "Dynamic loading not supported" when
    # `zend_extension=opcache` is set.
    #
    # -Wl,--export-all: exports every defined symbol from php.wasm so
    # opcache.so (a side module loaded via dlopen) can resolve its
    # imports against PHP main. Without this only the SDK's hand-picked
    # `__heap_base`/`__tls_base`/etc. are exported and opcache.so fails
    # to instantiate ("Import #N env.<sym>: function import requires a
    # callable"). The size cost (~5 MB) is worth the runtime correctness.
    #
    # -u<sym>: force the linker to pull these libc symbols out of
    # libc.a even though PHP itself doesn't call them. opcache.so
    # imports them (some are sandbox/security helpers it never actually
    # invokes on our wasm port — but the import has to resolve at
    # instantiation time).
    #
    # The second -u group forces libc symbols intl.so imports but base PHP
    # never references (allocator, wide-char, math, and the pthread mutex/
    # cond/TLS that ICU's UMutex uses). They must resolve to php.wasm's own
    # musl so intl.so shares one libc state — one allocator, one pthread key
    # table; without -u they never enter php.wasm and intl.so fails to load.
    #
    # -Wl,-z,stack-size=4194304: 4 MB wasm stack. The default wasm-ld
    # stack is 64 KB, which sits ~100 KB above PHP's `alloc_globals`
    # data segment. Opcache's PASS_6 (DFA-based SSA optimization) calls
    # zend_build_ssa, which uses do_alloca() for its DFG bitsets and
    # var-rename worklist; on large functions like WordPress's
    # wp-includes/ID3/module.audio-video.asf.php Analyze() (1700+ lines),
    # the alloca'd buffer plus the deep zend_ssa_rename recursion can
    # underflow the stack into alloc_globals, scribbling garbage onto
    # AG(mm_heap). The next _efree call then traps with "memory access
    # out of bounds" because it tries to dereference the now-bogus heap
    # pointer. 4 MB gives PASS_6 enough headroom for any function that
    # passes its own `blocks*vars > 4M` size guard.
    PKG_CONFIG_PATH="$DEP_PKG_CONFIG_PATH" \
    CPPFLAGS="$DEP_CPPFLAGS" \
    LDFLAGS="$DEP_LDFLAGS -ldl -Wl,--export-all \
-u setgid -u setuid -u initgroups -u writev -u asctime \
-u aligned_alloc -u div -u modf -u round -u tanhf \
-u swprintf -u wcstod -u wcstof -u wcstol -u wcstold \
-u wcstoll -u wcstoul -u wcstoull -u wmemchr -u wmemcmp \
-u pthread_cond_broadcast -u pthread_cond_destroy -u pthread_cond_signal \
-u pthread_cond_timedwait -u pthread_cond_wait -u pthread_detach \
-u pthread_getspecific -u pthread_key_create -u pthread_self \
-u pthread_setspecific \
-Wl,-z,stack-size=4194304" \
    wasm32posix-configure \
        --disable-all \
        --disable-cgi \
        --disable-phpdbg \
        --enable-cli \
        --enable-fpm \
        --enable-opcache \
        --enable-intl=shared \
        --enable-mbstring \
        --disable-mbregex \
        --enable-ctype \
        --enable-tokenizer \
        --enable-filter \
        --enable-phar \
        --without-valgrind \
        --without-pcre-jit \
        --disable-fiber-asm \
        --disable-zend-signals \
        --enable-session \
        --with-sqlite3 \
        --enable-pdo \
        --with-pdo-sqlite \
        --with-pdo-mysql=mysqlnd \
        --with-mysqli=mysqlnd \
        --enable-fileinfo \
        --enable-exif \
        --with-zlib \
        --with-openssl \
        --with-libxml \
        --enable-xml \
        --enable-dom \
        --enable-simplexml \
        --enable-xmlreader \
        --enable-xmlwriter \
        --cache-file="$SCRIPT_DIR/config.cache" \
        --prefix="$INSTALL_DIR" \
        CFLAGS="-O2 -gline-tables-only -DZEND_USE_ASM_ARITHMETIC=0"
    # CFLAGS includes -gline-tables-only for debug stack traces.
    # The debug-trace value is worth keeping. CLI inherits the same
    # flags; it just produces a slightly larger binary.

    # Patch config.h: disable features that pass link-time checks (--allow-undefined)
    # but don't actually exist in our musl sysroot
    echo "==> Patching main/php_config.h for Wasm..."
    sed -i.bak \
        -e 's/^#define HAVE_DNS_SEARCH 1/\/* #undef HAVE_DNS_SEARCH *\//' \
        -e 's/^#define HAVE_DNS_SEARCH_FUNC 1/\/* #undef HAVE_DNS_SEARCH_FUNC *\//' \
        -e 's/^#define HAVE_RES_NSEARCH 1/\/* #undef HAVE_RES_NSEARCH *\//' \
        -e 's/^#define HAVE_RES_NDESTROY 1/\/* #undef HAVE_RES_NDESTROY *\//' \
        -e 's/^#define HAVE_DN_EXPAND 1/\/* #undef HAVE_DN_EXPAND *\//' \
        -e 's/^#define HAVE_DN_SKIPNAME 1/\/* #undef HAVE_DN_SKIPNAME *\//' \
        -e 's/^#define HAVE_FOPENCOOKIE 1/\/* #undef HAVE_FOPENCOOKIE *\//' \
        -e 's/^#define HAVE_FUNOPEN 1/\/* #undef HAVE_FUNOPEN *\//' \
        -e 's/^#define HAVE_STD_SYSLOG 1/\/* #undef HAVE_STD_SYSLOG *\//' \
        -e 's/^#define HAVE_SETPROCTITLE 1/\/* #undef HAVE_SETPROCTITLE *\//' \
        -e 's/^#define HAVE_SETPROCTITLE_FAST 1/\/* #undef HAVE_SETPROCTITLE_FAST *\//' \
        -e 's/^#define HAVE_PRCTL 1/\/* #undef HAVE_PRCTL *\//' \
        -e 's/^#define HAVE_RAND_EGD 1/\/* #undef HAVE_RAND_EGD *\//' \
        main/php_config.h && rm -f main/php_config.h.bak

    # Remove -MMD/-MF/-MT dependency tracking flags from Makefile.
    # libtool doesn't understand these flags and misidentifies the source file,
    # causing "mv: rename foo.o" errors during compilation.
    echo "==> Patching Makefile to remove dependency tracking flags..."
    sed -i.bak \
        -e 's/ -MMD -MF [^ ]* -MT [^ ]*//g' \
        Makefile && rm -f Makefile.bak

    # Patch libtool to allow shared-library builds. PHP's configure
    # detects our wasm cross-compile target as not supporting shared
    # libraries (`build_libtool_libs=no`) — when libtool then sees
    # `-shared` in opcache's link command it calls
    # `func_fatal_configuration` which is not even defined in this
    # libtool variant, so the make rule dies with
    # `func_fatal_configuration: command not found`. Flip the flag so
    # libtool emits PIC-compiled `.libs/*.o` objects from the
    # opcache `.lo` rules; we then link `opcache.so` directly with
    # `wasm32posix-cc -shared` after `make`.
    echo "==> Patching libtool to enable shared-library mode..."
    sed -i.bak 's/^build_libtool_libs=no$/build_libtool_libs=yes/' libtool \
        && rm -f libtool.bak
fi

# `make` per-file rules embed `INCLUDES` from configure but ignore
# `CPPFLAGS` (which only contains `-D_GNU_SOURCE`); `INCLUDES` for
# our libxml2 ends up as `-I.../include/libxml` because PHP's
# `ext/libxml/config.m4` adds the `/libxml` suffix. The real PHP
# sources `#include <libxml/parser.h>`, which needs the parent
# `-I.../include`. Pass it via `EXTRA_CFLAGS`, which the per-file
# rules append last.
EXTRA_INC_LIBXML="-I${LIBXML2_PREFIX}/include"

echo "==> Building PHP CLI..."
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" EXTRA_CFLAGS="$EXTRA_INC_LIBXML" cli

echo "==> Building PHP FPM..."
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" EXTRA_CFLAGS="$EXTRA_INC_LIBXML" fpm

echo "==> Both PHP binaries built successfully!"

# Build opcache as a shared Zend extension (.so side module).
# PHP's `make` produces PIC-compiled `.libs/ext/opcache/*.o` because
# opcache's `[[outputs]]` config is "always shared", but the bundled
# libtool refuses to emit the final `.so` on this target (see the
# build_libtool_libs patch above). Skip libtool's link step entirely
# and feed the PIC objects to the SDK's `wasm32posix-cc -shared`,
# which routes through `wasm-ld --shared --experimental-pic`.
echo "==> Building opcache.so (Zend extension)..."
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" EXTRA_CFLAGS="$EXTRA_INC_LIBXML" ext/opcache/opcache.la || true
mkdir -p "$SCRIPT_DIR/bin"
wasm32posix-cc -shared -fPIC -o "$SCRIPT_DIR/bin/opcache.so" \
    ext/opcache/.libs/ZendAccelerator.o \
    ext/opcache/.libs/zend_accelerator_blacklist.o \
    ext/opcache/.libs/zend_accelerator_debug.o \
    ext/opcache/.libs/zend_accelerator_hash.o \
    ext/opcache/.libs/zend_accelerator_module.o \
    ext/opcache/.libs/zend_persist.o \
    ext/opcache/.libs/zend_persist_calc.o \
    ext/opcache/.libs/zend_file_cache.o \
    ext/opcache/.libs/zend_shared_alloc.o \
    ext/opcache/.libs/zend_accelerator_util_funcs.o \
    ext/opcache/.libs/shared_alloc_shm.o \
    ext/opcache/.libs/shared_alloc_mmap.o \
    ext/opcache/.libs/shared_alloc_posix.o
echo "==> opcache.so: $(wc -c < "$SCRIPT_DIR/bin/opcache.so") bytes"

# Build intl as a shared .so, same libtool workaround as opcache: make compiles
# the PIC objects under ext/intl/**/.libs/ but the bundled libtool can't emit the
# final .so on this target, so we link it with `wasm32posix-cc -shared`. intl
# statically absorbs ICU and libc++/libc++abi so neither enters php.wasm; the ICU
# common data stays out of the .so as icu.dat (loaded by intl-icu-data-loader.c).
echo "==> Building intl.so (PHP extension)..."
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" EXTRA_CFLAGS="$EXTRA_INC_LIBXML" ext/intl/intl.la || true

# Compile the icu.dat loader (PIC) that feeds ICU its common data at dlopen.
wasm32posix-cc -fPIC -O2 -c "$SCRIPT_DIR/intl-icu-data-loader.c" \
    -I"$ICU_PREFIX/include" -o ext/intl/kandelo_icu_data_loader.o

# Collect every PIC object libtool produced for ext/intl (top dir + the
# collator/, dateformat/, formatter/, … subdirs each have their own .libs/).
mapfile -t INTL_OBJS < <(find ext/intl -path '*/.libs/*.o' | sort)
[ "${#INTL_OBJS[@]}" -gt 0 ] || { echo "ERROR: no ext/intl PIC objects found — did 'make ext/intl/intl.la' compile?" >&2; exit 1; }
echo "==> linking intl.so from ${#INTL_OBJS[@]} objects + ICU static libs + libc++"

# wasm-ld resolves archive back-references without --start-group, so the ICU
# archives are listed in dependency order (i18n -> io -> uc -> data), then
# libc++/libc++abi. A -shared PIC module requires every input to be PIC, so the
# libc++ PIC variants are named explicitly to win over the non-PIC sysroot ones.
wasm32posix-cc -shared -fPIC -o "$SCRIPT_DIR/bin/intl.so" \
    "${INTL_OBJS[@]}" \
    ext/intl/kandelo_icu_data_loader.o \
    "$ICU_PREFIX/lib/libicui18n.a" \
    "$ICU_PREFIX/lib/libicuio.a" \
    "$ICU_PREFIX/lib/libicuuc.a" \
    "$ICU_PREFIX/lib/libicudata.a" \
    "$LIBCXX_PREFIX/lib/libc++-pic.a" \
    "$LIBCXX_PREFIX/lib/libc++abi-pic.a"
echo "==> intl.so: $(wc -c < "$SCRIPT_DIR/bin/intl.so") bytes"

# Copy to bin/ with .wasm extension (needed for Vite browser demos)
mkdir -p "$SCRIPT_DIR/bin"
cp sapi/cli/php "$SCRIPT_DIR/bin/php.wasm"
cp sapi/fpm/php-fpm "$SCRIPT_DIR/bin/php-fpm.wasm"

# CLI and FPM both retain libc paths that can reach kernel_fork
# (system/popen/fork wrappers for CLI, worker forks for FPM), so both
# must be fork-instrumented. wasm-opt runs first, then fork
# instrumentation as the tail step because the instrumenter hardcodes
# mutable-global offsets and any later pass that reorders globals would
# invalidate them. wasm-fork-instrument auto-discovers fork paths via
# call-graph analysis; no onlylist file is required.
WASM_OPT="$(command -v wasm-opt 2>/dev/null || true)"
if [ -n "$WASM_OPT" ]; then
    echo "==> Optimizing CLI binary with wasm-opt -O2..."
    "$WASM_OPT" -O2 "$SCRIPT_DIR/bin/php.wasm" -o "$SCRIPT_DIR/bin/php.wasm"

    echo "==> Optimizing FPM binary with wasm-opt -O2..."
    "$WASM_OPT" -O2 "$SCRIPT_DIR/bin/php-fpm.wasm" -o "$SCRIPT_DIR/bin/php-fpm.wasm"
fi

FORK_INSTRUMENT="$REPO_ROOT/scripts/run-wasm-fork-instrument.sh"
echo "==> Applying fork instrumentation to CLI..."
"$FORK_INSTRUMENT" "$SCRIPT_DIR/bin/php.wasm" -o "$SCRIPT_DIR/bin/php.wasm.instr"
mv "$SCRIPT_DIR/bin/php.wasm.instr" "$SCRIPT_DIR/bin/php.wasm"

echo "==> Applying fork instrumentation to FPM..."
"$FORK_INSTRUMENT" "$SCRIPT_DIR/bin/php-fpm.wasm" -o "$SCRIPT_DIR/bin/php-fpm.wasm.instr"
mv "$SCRIPT_DIR/bin/php-fpm.wasm.instr" "$SCRIPT_DIR/bin/php-fpm.wasm"

ls -la "$SCRIPT_DIR/bin/php.wasm" "$SCRIPT_DIR/bin/php-fpm.wasm"

# Install into local-binaries/ so the resolver picks the freshly-built
# binaries over the fetched release.
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary php "$SCRIPT_DIR/bin/php.wasm"     php.wasm
install_local_binary php "$SCRIPT_DIR/bin/php-fpm.wasm" php-fpm.wasm
install_local_binary php "$SCRIPT_DIR/bin/opcache.so"
install_local_binary php "$SCRIPT_DIR/bin/intl.so"
