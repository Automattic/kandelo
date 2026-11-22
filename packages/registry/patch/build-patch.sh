#!/usr/bin/env bash
# Cross-compile GNU patch for Kandelo with the SDK's configure wrapper.
#
# A direct build writes packages/registry/patch/patch.wasm. Resolver builds
# write only below their declared work and output roots.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$HERE"
# shellcheck source=/dev/null
kandelo_package_prepare_build_roots "$HERE" wasm32
WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"
SRC="$WORK_DIR/patch-src"
OUT_BIN="$WORK_DIR/patch.wasm"
SYSROOT="$REPO_ROOT/sysroot"

PATCH_VERSION="$WASM_POSIX_DEP_VERSION"
SOURCE_URL="$WASM_POSIX_DEP_SOURCE_URL"
SOURCE_SHA256="$WASM_POSIX_DEP_SOURCE_SHA256"
VERIFIED_SOURCE_DIR="${WASM_POSIX_DEP_SOURCE_DIR:-}"
SOURCE_MARKER="$SRC/.kandelo-patch-source"

if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ] && [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
fi

source "$REPO_ROOT/sdk/activate.sh"
[ -f "$SYSROOT/lib/libc.a" ] || { echo "ERROR: sysroot missing; run scripts/build-musl.sh" >&2; exit 1; }
export WASM_POSIX_SYSROOT="$SYSROOT"

expected_source_marker="$(printf '%s\n%s\n%s' \
    "$PATCH_VERSION" "$SOURCE_URL" "$SOURCE_SHA256")"
if [ -d "$SRC" ] && \
   [ "$(cat "$SOURCE_MARKER" 2>/dev/null || true)" != "$expected_source_marker" ]; then
    rm -rf "$SRC" "$OUT_BIN"
fi
if [ ! -d "$SRC" ]; then
    echo "==> Staging verified GNU patch $PATCH_VERSION source..."
    kandelo_package_stage_verified_source patch "$SRC" \
        "$VERIFIED_SOURCE_DIR" "$SOURCE_URL" "$SOURCE_SHA256" "$WORK_DIR"
    printf '%s\n' "$expected_source_marker" >"$SOURCE_MARKER"
fi

cd "$SRC"

# gnulib run-time probes cannot execute while cross-compiling. Answer them
# with what musl on Kandelo provides, as the other GNU ports do.
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
export gl_cv_func_gettimeofday_clobber=no
export gl_cv_func_memchr_works=yes
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
export gl_cv_func_lstat_dereferences_slashed_symlink=yes
export gl_cv_func_stat_dir_slash=yes
export gl_cv_func_stat_file_slash=yes
export gl_cv_func_open_directory_works=yes
export gl_cv_func_open_slash=yes
export gl_cv_func_openat_works=yes
export gl_cv_func_fstatat_zero_flag=yes
export gl_cv_func_unlinkat_works=yes
export gl_cv_func_rename_slash_dst_works=yes
export gl_cv_func_rename_slash_src_works=yes
export gl_cv_func_rename_link_works=yes
export gl_cv_func_rename_dest_works=yes
export gl_cv_func_readlink_trailing_slash=yes
export gl_cv_func_readlink_truncate=yes
export gl_cv_func_symlink_works=yes
export gl_cv_func_futimens_works=yes
export gl_cv_func_utimensat_works=yes
export gl_cv_func_mkdir_trailing_slash_works=yes
export gl_cv_func_mkdir_trailing_dot_works=yes
export gl_cv_have_proc_self_fd=no
export gl_cv_func_fcntl_f_dupfd_cloexec=yes
export gl_cv_func_fcntl_f_dupfd_works=yes
export gl_cv_func_sigaction_works=yes
export gl_cv_func_setenv_works=yes
export gl_cv_func_unsetenv_works=yes
export gl_cv_func_getopt_gnu=yes
export gl_cv_func_getopt_long_gnu=yes
export gl_cv_func_getopt_posix=yes
export gl_cv_func_strndup_works=yes
export gl_cv_func_strnlen_working=yes
export gl_cv_func_dup2_works=yes
export gl_cv_func_working_mktime=yes
export gl_cv_func_nanosleep=yes
export gl_cv_struct_dirent_d_ino=yes
export gl_cv_struct_dirent_d_type=yes
export gl_cv_func_fflush_stdin=yes

# Interfaces musl does not provide.
export ac_cv_header_error_h=no
export ac_cv_func_error=no
export ac_cv_func_error_at_line=no
export ac_cv_func_canonicalize_file_name=no
export ac_cv_func_getprogname=no

export ac_cv_func_malloc_0_nonnull=yes
export ac_cv_func_realloc_0_nonnull=yes
export ac_cv_func_calloc_0_nonnull=yes
export ac_cv_func_strerror_r_char_p=no

# Wasm32 type sizes so configure does not guess from a failed run.
export ac_cv_sizeof_long=4
export ac_cv_sizeof_long_long=8
export ac_cv_sizeof_int=4
export ac_cv_sizeof_size_t=4

if [ ! -f Makefile ]; then
    echo "==> Configuring GNU patch..."
    # patch runs `ed` for ed-style diffs (`patch -e`); name the guest path
    # rather than letting configure search the build machine's PATH. The
    # base image's ed is still a posix-utils-lite placeholder, so ed-style
    # diffs are not reliable yet (docs/posix-status.md).
    wasm32posix-configure \
        --disable-nls \
        ac_cv_path_ED=/usr/bin/ed \
        2>&1 | tail -20
fi

echo "==> Building GNU patch..."
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" -C lib 2>&1 | tail -10
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" -C src patch 2>&1 | tail -20

if [ ! -f "$SRC/src/patch" ]; then
    echo "ERROR: patch binary not found after build" >&2
    exit 1
fi
cp "$SRC/src/patch" "$OUT_BIN"
ls -la "$OUT_BIN"
echo "==> patch.wasm built."

cd "$REPO_ROOT"
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary patch "$OUT_BIN" patch.wasm
