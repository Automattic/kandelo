#!/usr/bin/env bash
set -euo pipefail

# Build GNU gzip for wasm32-posix-kernel.
#
# Uses the SDK's wasm32posix-configure wrapper for cross-compilation.
# gzip has its own deflate implementation (does NOT link zlib).
# Output: bin/gzip.wasm under the resolver work root (beside this
# script when run standalone).

GZIP_VERSION="${WASM_POSIX_DEP_VERSION:-${GZIP_VERSION:-1.13}}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://ftpmirror.gnu.org/gzip/gzip-${GZIP_VERSION}.tar.xz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-7454eb6935db17c6655576c2e1b0fabefd38b4d0936e0f87f48cd062ce91a057}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/sdk/activate.sh"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
# WHY: two resolves of this recipe can run at once in one checkout (two
# test files missing the cache together). Each keeps its source and build
# tree under its own resolver work root so neither deletes the other's.
# A standalone run keeps them beside this script.
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
SRC_DIR="$KANDELO_PACKAGE_WORK_DIR/gzip-src"
BIN_DIR="$KANDELO_PACKAGE_WORK_DIR/bin"
SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"

# A resolver caller owns the declared work and output roots. Keep the
# reviewed checkout read-only and suppress the developer-only local mirror.
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
    echo "ERROR: sysroot not found. Run: bash build.sh && bash scripts/build-musl.sh" >&2
    exit 1
fi

export WASM_POSIX_SYSROOT="$SYSROOT"

# --- Stage verified gzip source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Staging verified gzip $GZIP_VERSION source..."
    # WHY: use the manifest's resolver-verified release, rather than
    # redownloading an unverified release from a separate script default.
    kandelo_package_stage_verified_source gzip "$SRC_DIR" \
        "${WASM_POSIX_DEP_SOURCE_DIR:-}" "$SOURCE_URL" "$SOURCE_SHA256" \
        "$KANDELO_PACKAGE_WORK_DIR"
fi

cd "$SRC_DIR"

# --- Configure ---
if [ ! -f Makefile ]; then
    echo "==> Configuring gzip for wasm32..."

    # gnulib cross-compilation overrides (same pattern as tar/grep)
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

    # musl doesn't have utimens/lutimens (uses utimensat instead)
    export ac_cv_func_utimens=no
    export ac_cv_func_lutimens=no

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

    wasm32posix-configure \
        --disable-nls \
        2>&1 | tail -30

    echo "==> Configure complete."
fi

# --- Build ---
echo "==> Building gzip..."
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" 2>&1 | tail -30

echo "==> Collecting binary..."
mkdir -p "$BIN_DIR"

if [ -f "$SRC_DIR/gzip" ]; then
    cp "$SRC_DIR/gzip" "$BIN_DIR/gzip.wasm"
    echo "==> Built gzip"
    ls -lh "$BIN_DIR/gzip.wasm"
else
    echo "ERROR: gzip binary not found after build" >&2
    exit 1
fi

echo ""
echo "==> gzip built successfully!"
echo "Binary: $BIN_DIR/gzip.wasm"

# Install into local-binaries/ so the resolver picks the freshly-built
# binary over the fetched release.
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary gzip "$BIN_DIR/gzip.wasm"
