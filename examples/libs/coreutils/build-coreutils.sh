#!/usr/bin/env bash
set -euo pipefail

# Build GNU coreutils 9.5 for wasm32-posix-kernel.
#
# Uses the SDK's wasm32posix-configure wrapper for cross-compilation.
# Output: examples/libs/coreutils/bin/*.wasm

COREUTILS_VERSION="${COREUTILS_VERSION:-9.5}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SRC_DIR="$SCRIPT_DIR/coreutils-src"
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

# --- Download coreutils source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading coreutils $COREUTILS_VERSION..."
    TARBALL="coreutils-${COREUTILS_VERSION}.tar.xz"
    URL="https://ftpmirror.gnu.org/gnu/coreutils/${TARBALL}"
    curl -fsSL "$URL" -o "/tmp/$TARBALL"
    mkdir -p "$SRC_DIR"
    tar xJf "/tmp/$TARBALL" -C "$SRC_DIR" --strip-components=1
    rm "/tmp/$TARBALL"
    echo "==> Source extracted to $SRC_DIR"
fi

cd "$SRC_DIR"

# --- Configure ---
if [ ! -f Makefile ]; then
    echo "==> Configuring coreutils for wasm32..."

    # GNU coreutils + gnulib does hundreds of configure tests.
    # Cross-compilation link-based tests fail, so we override with correct
    # values for musl on wasm32.
    #
    # Strategy: disable features that require kernel support we don't have
    # (SELinux, ACLs, capabilities, xattr), and override function checks
    # for things musl provides.

    # Force some gnulib values for wasm32
    export gl_cv_func_working_getdelim=yes
    export gl_cv_func_working_strerror=yes
    export gl_cv_func_strerror_0_works=yes
    export gl_cv_func_strerror_r_works=yes
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
    export gl_cv_func_frexp_works=yes
    export gl_cv_func_frexpl_works=yes
    export gl_cv_func_ldexpl_works=yes
    export gl_cv_func_getcwd_null=yes
    export gl_cv_func_getcwd_path_max=yes
    export gl_cv_func_getcwd_abort_bug=no
    export gl_cv_func_fnmatch_posix=yes
    export gl_cv_func_gettimeofday_clobber=no
    export gl_cv_func_working_mktime=yes
    export gl_cv_func_working_timegm=yes
    export gl_cv_func_nanosleep=yes
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
    export gl_cv_func_re_compile_pattern_working=yes
    export gl_cv_func_link_follows_symlink=no
    export gl_cv_func_lstat_dereferences_slashed_symlink=yes
    export gl_cv_func_stat_dir_slash=yes
    export gl_cv_func_stat_file_slash=yes
    export gl_cv_func_rename_trailing_slash_bug=no
    export gl_cv_func_rename_dest_works=yes
    export gl_cv_func_rmdir_errno=yes
    export gl_cv_func_unlink_honors_slashes=yes
    export gl_cv_func_realpath_works=yes
    export gl_cv_func_open_directory_works=yes
    export gl_cv_have_proc_self_fd=no
    export gl_cv_func_fcntl_f_dupfd_cloexec=yes
    export gl_cv_func_fcntl_f_dupfd_works=yes
    export gl_cv_func_sigaction_works=yes
    export gl_cv_func_sleep_works=yes
    export gl_cv_func_usleep_works=yes
    export gl_cv_func_select_detects_ebadf=yes
    export gl_cv_func_setenv_works=yes
    export gl_cv_func_unsetenv_works=yes
    export gl_cv_func_getopt_gnu=yes
    export gl_cv_func_getopt_long_gnu=yes
    export gl_cv_func_getopt_posix=yes
    export gl_cv_func_stpncpy=yes
    export gl_cv_func_strndup_works=yes
    export gl_cv_func_strnlen_working=yes
    export gl_cv_func_strtod_works=yes
    export gl_cv_func_strtold_works=yes
    export gl_cv_func_strtoimax=yes
    export gl_cv_func_strtoumax=yes
    export gl_cv_func_dup2_works=yes
    export gl_cv_func_fdopendir_works=yes
    export gl_cv_func_fflush_stdin=yes
    export gl_cv_func_futimens_works=yes
    export gl_cv_func_utimensat_works=yes
    export gl_cv_func_working_utimes=yes
    export gl_cv_func_getgroups_works=yes
    export gl_cv_struct_dirent_d_ino=yes
    export gl_cv_struct_dirent_d_type=yes
    export gl_cv_func_mkdir_trailing_slash_bug=no
    export gl_cv_func_mkdir_trailing_dot_works=yes
    export gl_cv_have_raw_decl_alarm=yes
    export gl_cv_have_raw_decl_chdir=yes
    export gl_cv_have_raw_decl_close=yes
    export gl_cv_have_raw_decl_dup=yes
    export gl_cv_have_raw_decl_dup2=yes
    export gl_cv_have_raw_decl_fchdir=yes
    export gl_cv_have_raw_decl_fsync=yes
    export gl_cv_have_raw_decl_getcwd=yes
    export gl_cv_have_raw_decl_getpagesize=yes
    export gl_cv_have_raw_decl_getuid=yes
    export gl_cv_have_raw_decl_getgid=yes
    export gl_cv_have_raw_decl_geteuid=yes
    export gl_cv_have_raw_decl_getegid=yes
    export gl_cv_have_raw_decl_isatty=yes
    export gl_cv_have_raw_decl_lseek=yes
    export gl_cv_have_raw_decl_read=yes
    export gl_cv_have_raw_decl_readlink=yes
    export gl_cv_have_raw_decl_rmdir=yes
    export gl_cv_have_raw_decl_sleep=yes
    export gl_cv_have_raw_decl_unlink=yes
    export gl_cv_have_raw_decl_usleep=yes
    export gl_cv_have_raw_decl_write=yes

    # Additional cache variables for cross-compilation
    export ac_cv_func_getgroups_works=yes
    export ac_cv_func_strtod=yes
    export ac_cv_func_strtoimax=yes
    export ac_cv_func_strtoumax=yes
    export ac_cv_func_closedir_void=no
    export ac_cv_have_decl_strerror_r=yes
    export ac_cv_func_strerror_r=yes
    export ac_cv_func_strerror_r_char_p=no
    export ac_cv_func_fnmatch_works=yes
    export ac_cv_func_lstat_empty_string_bug=no
    export ac_cv_func_lstat_dereferences_slashed_symlink=yes
    export ac_cv_func_stat_empty_string_bug=no
    export ac_cv_func_malloc_0_nonnull=yes
    export ac_cv_func_realloc_0_nonnull=yes
    export ac_cv_func_calloc_0_nonnull=yes
    export ac_cv_func_chown_follows_symlink=no
    export ac_cv_header_sys_inotify_h=no

    # musl doesn't have glibc's error() / error_at_line() or <error.h>
    export ac_cv_header_error_h=no
    export ac_cv_func_error=no
    export ac_cv_func_error_at_line=no
    export ac_cv_have_decl_error_at_line=no
    export ac_cv_lib_error_at_line=no
    export ac_cv_have_decl_program_invocation_name=yes
    export ac_cv_have_decl_program_invocation_short_name=yes

    # Functions musl doesn't have (glibc/BSD/C23/macOS/Windows extensions)
    export ac_cv_func_rawmemchr=no
    export ac_cv_func_wmempcpy=no
    export ac_cv_func_canonicalize_file_name=no
    export ac_cv_func_getprogname=no
    export ac_cv_func_memset_explicit=no
    export ac_cv_func_explicit_memset=no
    export ac_cv_func_memset_s=no
    export ac_cv_func_renameat2=no
    export ac_cv_func_nanouptime=no
    export ac_cv_func_microuptime=no
    export ac_cv_func_pstat_getdynamic=no
    export ac_cv_func_pstat_getstatic=no
    export ac_cv_func__set_invalid_parameter_handler=no
    export ac_cv_func_fclonefileat=no
    export ac_cv_func_getattrat=no
    export ac_cv_func_pstat_getprocvm=no
    export ac_cv_func_mquery=no

    # Wasm32 type sizes
    export ac_cv_sizeof_long=4
    export ac_cv_sizeof_long_long=8
    export ac_cv_sizeof_unsigned_long=4
    export ac_cv_sizeof_int=4
    export ac_cv_sizeof_size_t=4

    wasm32posix-configure \
        --disable-nls \
        --without-selinux \
        --without-gmp \
        --disable-acl \
        --disable-xattr \
        --enable-single-binary=symlinks \
        --enable-no-install-program=stdbuf,pinky,who,users,uptime \
        2>&1 | tail -30

    echo "==> Configure complete."
fi

# --- Build ---
echo "==> Building coreutils..."
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" 2>&1 | tail -30

echo "==> Collecting binaries..."
mkdir -p "$BIN_DIR"

# The single binary is src/coreutils, symlinks point to it
if [ -f "$SRC_DIR/src/coreutils" ]; then
    cp "$SRC_DIR/src/coreutils" "$BIN_DIR/coreutils.wasm"
    echo "==> Built single-binary coreutils"
    ls -lh "$BIN_DIR/coreutils.wasm"
else
    echo "ERROR: coreutils binary not found after build" >&2
    exit 1
fi

echo ""
echo "==> coreutils built successfully!"
echo "Binary: $BIN_DIR/coreutils.wasm"

# Install into local-binaries/ so the resolver picks the freshly-built
# binary over the fetched release.
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary coreutils "$SCRIPT_DIR/bin/coreutils.wasm"
