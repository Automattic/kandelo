#!/usr/bin/env bash
set -euo pipefail

# Build GNU wget 1.24.5 for wasm32-posix-kernel.
#
# Links against pre-built OpenSSL and zlib if available.
# Uses the SDK's wasm32posix-configure wrapper for cross-compilation.
#
# Output: examples/libs/wget/bin/wget.wasm

WGET_VERSION="${WGET_VERSION:-1.24.5}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SRC_DIR="$SCRIPT_DIR/wget-src"
BIN_DIR="$SCRIPT_DIR/bin"
SYSROOT="$REPO_ROOT/sysroot"

# --- Prerequisites ---
if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Run 'npm link' in sdk/ first." >&2
    exit 1
fi

if [ ! -f "$SYSROOT/lib/libc.a" ]; then
    echo "ERROR: sysroot not found. Run: bash build.sh && bash scripts/build-musl.sh" >&2
    exit 1
fi

export WASM_POSIX_SYSROOT="$SYSROOT"

# --- Locate OpenSSL and zlib ---
OPENSSL_DIR="$REPO_ROOT/examples/libs/openssl/openssl-install"
ZLIB_DIR="$REPO_ROOT/examples/libs/zlib/zlib-install"

SSL_FLAGS=()
EXTRA_CFLAGS=""
EXTRA_LDFLAGS=""

if [ -f "$OPENSSL_DIR/lib/libssl.a" ] && [ -f "$OPENSSL_DIR/lib/libcrypto.a" ]; then
    echo "==> Found OpenSSL at $OPENSSL_DIR"
    SSL_FLAGS+=("--with-ssl=openssl")
    EXTRA_CFLAGS="-I$OPENSSL_DIR/include"
    EXTRA_LDFLAGS="-L$OPENSSL_DIR/lib"
else
    echo "==> OpenSSL not found, building without SSL support"
    SSL_FLAGS+=("--without-ssl")
fi

if [ -f "$ZLIB_DIR/lib/libz.a" ]; then
    echo "==> Found zlib at $ZLIB_DIR"
    EXTRA_CFLAGS="$EXTRA_CFLAGS -I$ZLIB_DIR/include"
    EXTRA_LDFLAGS="$EXTRA_LDFLAGS -L$ZLIB_DIR/lib"
else
    echo "==> zlib not found, building without zlib support"
    SSL_FLAGS+=("--without-zlib")
fi

# --- Download wget source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading wget $WGET_VERSION..."
    TARBALL="wget-${WGET_VERSION}.tar.gz"
    URL="https://ftp.gnu.org/gnu/wget/${TARBALL}"
    curl -fsSL "$URL" -o "/tmp/$TARBALL"
    mkdir -p "$SRC_DIR"
    tar xzf "/tmp/$TARBALL" -C "$SRC_DIR" --strip-components=1
    rm "/tmp/$TARBALL"
    echo "==> Source extracted to $SRC_DIR"
fi

cd "$SRC_DIR"

# --- Configure ---
if [ ! -f Makefile ]; then
    echo "==> Configuring wget for wasm32..."

    # gnulib cross-compilation overrides
    export gl_cv_func_working_getdelim=yes
    export gl_cv_func_working_strerror=yes
    export gl_cv_func_strerror_0_works=yes
    export gl_cv_func_printf_sizes_c99=yes
    export gl_cv_func_printf_long_double=yes
    export gl_cv_func_printf_infinite=yes
    export gl_cv_func_printf_infinite_long_double=yes
    export gl_cv_func_printf_directive_a=yes
    export gl_cv_func_printf_directive_f=yes
    export gl_cv_func_printf_directive_n=no
    export gl_cv_func_printf_directive_ls=yes
    export gl_cv_func_printf_positions=yes
    export gl_cv_func_printf_flag_grouping=yes
    export gl_cv_func_printf_flag_leftadjust=yes
    export gl_cv_func_printf_flag_zero=yes
    export gl_cv_func_printf_precision=yes
    export gl_cv_func_printf_enomem=yes
    export gl_cv_func_snprintf_truncation_c99=yes
    export gl_cv_func_snprintf_retval_c99=yes
    export gl_cv_func_snprintf_directive_n=no
    export gl_cv_func_snprintf_size1=yes
    export gl_cv_func_vsnprintf_zerosize_c99=yes
    export gl_cv_func_getcwd_null=yes
    export gl_cv_func_getcwd_path_max=yes
    export gl_cv_func_getcwd_abort_bug=no
    export gl_cv_func_fnmatch_posix=yes
    export gl_cv_func_gettimeofday_clobber=no
    export gl_cv_func_memchr_works=yes
    export gl_cv_func_mbrlen_empty_input=yes
    export gl_cv_func_mbrtowc_empty_input=yes
    export gl_cv_func_mbrtowc_incomplete_state=yes
    export gl_cv_func_mbrtowc_sanitycheck=yes
    export gl_cv_func_mbrtowc_null_arg1=yes
    export gl_cv_func_mbrtowc_null_arg2=yes
    export gl_cv_func_mbrtowc_retval=yes
    export gl_cv_func_mbrtowc_nul_retval=yes
    export gl_cv_func_mbrtowc_regular_locale_utf8=yes
    export gl_cv_func_mbrtowc_stores_incomplete=no
    export gl_cv_func_mbrtoc32_empty_input=yes
    export gl_cv_func_mbrtoc32_regular_locale_utf8=yes
    export gl_cv_func_mbrtoc32_retval=yes
    export gl_cv_func_mbrtoc32_C_locale_utf8=no
    export gl_cv_C_locale_sans_EILSEQ=yes
    export gl_cv_func_btowc_nul=yes
    export gl_cv_func_wcrtomb_retval=yes
    export gl_cv_func_iswcntrl_works=yes
    export gl_cv_func_wcwidth_works=yes
    export gl_cv_func_re_compile_pattern_working=no
    export gl_cv_func_lstat_dereferences_slashed_symlink=yes
    export gl_cv_func_stat_dir_slash=yes
    export gl_cv_func_stat_file_slash=yes
    export gl_cv_func_realpath_works=yes
    export gl_cv_func_open_directory_works=yes
    export gl_cv_have_proc_self_fd=no
    export gl_cv_func_fcntl_f_dupfd_cloexec=yes
    export gl_cv_func_fcntl_f_dupfd_works=yes
    export gl_cv_func_sigaction_works=yes
    export gl_cv_func_select_detects_ebadf=yes
    export gl_cv_func_setenv_works=yes
    export gl_cv_func_unsetenv_works=yes
    export gl_cv_func_getopt_gnu=yes
    export gl_cv_func_getopt_long_gnu=yes
    export gl_cv_func_getopt_posix=yes
    export gl_cv_func_stpncpy=yes
    export gl_cv_func_strndup_works=yes
    export gl_cv_func_strnlen_working=yes
    export gl_cv_func_dup2_works=yes
    export gl_cv_func_working_mktime=yes
    export gl_cv_func_working_timegm=yes
    export gl_cv_func_nanosleep=yes
    export gl_cv_struct_dirent_d_ino=yes
    export gl_cv_struct_dirent_d_type=yes
    export gl_cv_func_fflush_stdin=yes

    # Functions musl doesn't have
    export ac_cv_header_error_h=no
    export ac_cv_func_error=no
    export ac_cv_func_error_at_line=no
    export ac_cv_have_decl_program_invocation_name=yes
    export ac_cv_have_decl_program_invocation_short_name=yes
    export ac_cv_func_rawmemchr=no
    export ac_cv_func_wmempcpy=no
    export ac_cv_func_canonicalize_file_name=no
    export ac_cv_func_getprogname=no
    export ac_cv_func_memset_explicit=no
    export ac_cv_func_explicit_memset=no
    export ac_cv_func_memset_s=no
    export ac_cv_func_mquery=no
    export ac_cv_func_pstat_getprocvm=no
    export ac_cv_func_pstat_getdynamic=no
    export ac_cv_func_pstat_getstatic=no
    export ac_cv_func__set_invalid_parameter_handler=no

    # Cross-compilation values
    export ac_cv_func_closedir_void=no
    export ac_cv_func_malloc_0_nonnull=yes
    export ac_cv_func_realloc_0_nonnull=yes
    export ac_cv_func_calloc_0_nonnull=yes
    export ac_cv_func_strerror_r=yes
    export ac_cv_func_strerror_r_char_p=no
    export ac_cv_have_decl_strerror_r=yes
    export ac_cv_header_sys_inotify_h=no

    # Wasm32 type sizes
    export ac_cv_sizeof_long=4
    export ac_cv_sizeof_long_long=8
    export ac_cv_sizeof_unsigned_long=4
    export ac_cv_sizeof_int=4
    export ac_cv_sizeof_size_t=4

    # wget-specific: getaddrinfo detection for cross-compile
    export ac_cv_func_getaddrinfo=yes
    export ac_cv_func_gai_strerror=yes

    # RAND_egd was removed in OpenSSL 3.x
    export ac_cv_func_RAND_egd=no

    # group_member is a glibc extension not in musl.
    # wget uses it unconditionally in utils.c without #ifdef guard.
    # Patch the source to add a declaration before use.
    if ! grep -q 'group_member stub' "$SRC_DIR/src/utils.c"; then
        sed -i.bak '/#include "wget.h"/a\
/* musl lacks group_member(); stub always returns 0. group_member stub */\
static inline int group_member(int gid) { (void)gid; return 0; }
' "$SRC_DIR/src/utils.c"
        rm -f "$SRC_DIR/src/utils.c.bak"
    fi

    wasm32posix-configure \
        --disable-nls \
        --disable-iri \
        --without-metalink \
        --disable-pcre \
        --disable-pcre2 \
        --without-libuuid \
        --without-libpsl \
        "${SSL_FLAGS[@]}" \
        CFLAGS="$EXTRA_CFLAGS" \
        LDFLAGS="$EXTRA_LDFLAGS" \
        2>&1 | tail -30

    echo "==> Configure complete."
fi

# --- Build ---
echo "==> Building wget..."
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" 2>&1 | tail -30

echo "==> Collecting binary..."
mkdir -p "$BIN_DIR"

if [ -f "$SRC_DIR/src/wget" ]; then
    cp "$SRC_DIR/src/wget" "$BIN_DIR/wget.wasm"
    echo "==> Built wget"
    ls -lh "$BIN_DIR/wget.wasm"
else
    echo "ERROR: wget binary not found after build" >&2
    exit 1
fi

echo ""
echo "==> wget built successfully!"
echo "Binary: $BIN_DIR/wget.wasm"
