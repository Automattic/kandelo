#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

source "$REPO_ROOT/sdk/activate.sh"

HELLO_VERSION="${WASM_POSIX_DEP_VERSION:-2.12.3}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://ftpmirror.gnu.org/gnu/hello/hello-${HELLO_VERSION}.tar.gz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-0d5f60154382fee10b114a1c34e785d8b1f492073ae2d3a6f7b147687b366aa0}"
WORK_DIR="${WASM_POSIX_DEP_WORK_DIR:-$SCRIPT_DIR}"
SRC_DIR="$WORK_DIR/hello-src"
SOURCE_MARKER="$SRC_DIR/.kandelo-hello-source"
BUILD_DIR="$WORK_DIR/hello-wasm-build"
BIN_DIR="$WORK_DIR/bin"
SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"
TARGET_ARCH="${WASM_POSIX_DEP_TARGET_ARCH:-wasm32}"

export WASM_POSIX_SYSROOT="$SYSROOT"

if [ "$TARGET_ARCH" != "wasm32" ]; then
    echo "ERROR: GNU hello is currently packaged for wasm32 only, got $TARGET_ARCH" >&2
    exit 2
fi

if [ ! -f "$SYSROOT/lib/libc.a" ]; then
    echo "ERROR: sysroot not found at $SYSROOT. Run scripts/build-musl.sh first." >&2
    exit 1
fi

download_source() {
    local tarball="$1"
    echo "==> Downloading GNU hello $HELLO_VERSION..."
    curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors -fsSL "$SOURCE_URL" -o "$tarball"

    local actual_sha
    actual_sha="$(shasum -a 256 "$tarball" | awk '{print $1}')"
    if [ "$actual_sha" != "$SOURCE_SHA256" ]; then
        echo "ERROR: hello source sha256 mismatch" >&2
        echo "  expected: $SOURCE_SHA256" >&2
        echo "  actual:   $actual_sha" >&2
        exit 1
    fi
}

expected_marker="$(printf '%s\n%s\n%s\n' "$HELLO_VERSION" "$SOURCE_URL" "$SOURCE_SHA256")"
if [ -d "$SRC_DIR" ] && [ "$(cat "$SOURCE_MARKER" 2>/dev/null || true)" != "$expected_marker" ]; then
    echo "==> Existing GNU hello source does not match requested version/source; cleaning..."
    rm -rf "$SRC_DIR" "$BUILD_DIR" "$BIN_DIR"
fi

if [ ! -d "$SRC_DIR" ]; then
    tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/kandelo-hello-src.XXXXXX")"
    trap 'rm -rf "$tmpdir"' EXIT
    tarball="$tmpdir/hello-${HELLO_VERSION}.tar.gz"
    download_source "$tarball"
    mkdir -p "$SRC_DIR"
    tar xzf "$tarball" -C "$SRC_DIR" --strip-components=1
    printf '%s\n' "$expected_marker" > "$SOURCE_MARKER"
    trap - EXIT
    rm -rf "$tmpdir"
fi

mkdir -p "$BUILD_DIR" "$BIN_DIR"
cd "$BUILD_DIR"

if [ ! -f Makefile ]; then
    echo "==> Configuring GNU hello for wasm32..."

    # GNU hello uses gnulib probes. Cross-compilation cannot execute probe
    # programs, so provide the target answers used by nearby GNU ports.
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
    export ac_cv_func_closedir_void=no
    export ac_cv_func_malloc_0_nonnull=yes
    export ac_cv_func_realloc_0_nonnull=yes
    export ac_cv_func_calloc_0_nonnull=yes
    export ac_cv_func_strerror_r=yes
    export ac_cv_func_strerror_r_char_p=no
    export ac_cv_have_decl_strerror_r=yes
    export ac_cv_header_sys_inotify_h=no
    export ac_cv_sizeof_long=4
    export ac_cv_sizeof_long_long=8
    export ac_cv_sizeof_unsigned_long=4
    export ac_cv_sizeof_int=4
    export ac_cv_sizeof_size_t=4

    export CONFIG_SITE="${CONFIG_SITE:-$REPO_ROOT/sdk/config.site}"

    "$SRC_DIR/configure" \
        --host=wasm32-unknown-none \
        --prefix=/usr \
        --disable-nls \
        CC=wasm32posix-cc \
        AR=wasm32posix-ar \
        RANLIB=wasm32posix-ranlib
fi

echo "==> Building GNU hello..."
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)"

HELLO_BINARY="$BUILD_DIR/hello"
if [ ! -f "$HELLO_BINARY" ]; then
    echo "ERROR: hello binary not found after build" >&2
    exit 1
fi

cp "$HELLO_BINARY" "$BIN_DIR/hello.wasm"

export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    source "$REPO_ROOT/scripts/wasm-artifact-guards.sh"
    wasm_require_no_legacy_asyncify "$BIN_DIR/hello.wasm"
    wasm_require_no_fork_instrumentation "$BIN_DIR/hello.wasm"
    mkdir -p "$WASM_POSIX_DEP_OUT_DIR"
    cp "$BIN_DIR/hello.wasm" "$WASM_POSIX_DEP_OUT_DIR/hello.wasm"
    echo "  installed $WASM_POSIX_DEP_OUT_DIR/hello.wasm"
else
    source "$REPO_ROOT/scripts/install-local-binary.sh"
    install_local_binary hello "$BIN_DIR/hello.wasm"
fi

ls -lh "$BIN_DIR/hello.wasm"
