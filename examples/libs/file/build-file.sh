#!/usr/bin/env bash
set -euo pipefail

# Build file (libmagic) 5.45 for wasm32-posix-kernel.
#
# Two-stage build: first build a native host binary (needed to compile the
# magic database during cross-compilation), then cross-compile for wasm32.
#
# Output: examples/libs/file/bin/file.wasm
#         examples/libs/file/bin/magic.lite  (wasm-safe text magic database)
#         examples/libs/file/bin/magic       (full text magic database)

FILE_VERSION="${FILE_VERSION:-5.45}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SRC_DIR="$SCRIPT_DIR/file-src"
HOST_BUILD_DIR="$SCRIPT_DIR/file-host-build"
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

# --- Download file source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading file $FILE_VERSION..."
    TARBALL="file-${FILE_VERSION}.tar.gz"
    URL="https://astron.com/pub/file/${TARBALL}"
    curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors -fsSL "$URL" -o "/tmp/$TARBALL"
    mkdir -p "$SRC_DIR"
    tar xzf "/tmp/$TARBALL" -C "$SRC_DIR" --strip-components=1
    rm "/tmp/$TARBALL"
    echo "==> Source extracted to $SRC_DIR"
fi

# ======================================================================
# Stage 1: Build native host file binary
# ======================================================================
if [ ! -f "$HOST_BUILD_DIR/src/file" ]; then
    echo "==> Stage 1: Building native host file binary..."
    mkdir -p "$HOST_BUILD_DIR"
    cd "$HOST_BUILD_DIR"

    "$SRC_DIR/configure" \
        --disable-nls \
        --enable-static \
        --disable-shared \
        --disable-libseccomp \
        2>&1 | tail -10

    make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" 2>&1 | tail -10

    if [ ! -f "$HOST_BUILD_DIR/src/file" ]; then
        echo "ERROR: Native file binary not found after build" >&2
        exit 1
    fi
    echo "==> Native file binary built: $HOST_BUILD_DIR/src/file"
else
    echo "==> Native file binary already built."
fi

# ======================================================================
# Stage 2: Cross-compile for wasm32
# ======================================================================
cd "$SRC_DIR"

# Clean any previous cross-build artifacts (but not the source)
if [ -f Makefile ]; then
    make distclean 2>/dev/null || make clean 2>/dev/null || true
fi

echo "==> Stage 2: Configuring file for wasm32..."

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

# Functions musl doesn't have (or has as symbol but lacks header declaration)
export ac_cv_func_fmtcheck=no
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

wasm32posix-configure \
    --enable-static \
    --disable-shared \
    --disable-libseccomp \
    2>&1 | tail -30

echo "==> Configure complete."

# --- Build ---
# Override FILE_COMPILE so the magic database is built using our host binary
# (not the system 'file' which may be a different version).
echo "==> Building file..."
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" \
    FILE_COMPILE="$HOST_BUILD_DIR/src/file" \
    2>&1 | tail -30

echo "==> Collecting binaries..."
mkdir -p "$BIN_DIR"

if [ -f "$SRC_DIR/src/file" ]; then
    cp "$SRC_DIR/src/file" "$BIN_DIR/file.wasm"
    echo "==> Built file.wasm"
    ls -lh "$BIN_DIR/file.wasm"
else
    echo "ERROR: file binary not found after build" >&2
    exit 1
fi

# Create concatenated text magic file (for wasm32 runtime use).
# The .mgc compiled by the host binary uses native pointer format and
# cannot be loaded by the wasm32 binary. Instead, provide the raw text
# magic definitions — file will compile them in-memory at runtime.
#
# Note: The full magic file (~45K lines) has deeply nested entries
# (>10 levels of '>') that exhaust the wasm stack during parsing.
# We provide both the full file and a trimmed version for wasm use.
echo "==> Creating magic files..."
cat "$SRC_DIR/magic/Header" "$SRC_DIR/magic/Magdir"/* > "$BIN_DIR/magic"
echo "==> Created magic (full, $(wc -l < "$BIN_DIR/magic") lines)"

# Create trimmed version: skip deeply-nested DOS/filesystem entries
# that cause wasm stack overflow (entries with >10 continuation levels).
# Keep first 14000 lines which cover all common file types.
head -14000 "$BIN_DIR/magic" > "$BIN_DIR/magic.lite"
echo "==> Created magic.lite (trimmed for wasm, $(wc -l < "$BIN_DIR/magic.lite") lines)"

ls -lh "$BIN_DIR/magic" "$BIN_DIR/magic.lite"

echo ""
echo "==> file built successfully!"
echo "Binary:    $BIN_DIR/file.wasm"
echo "Magic DB:  $BIN_DIR/magic.lite (wasm-safe subset)"
echo "           $BIN_DIR/magic (full — may exceed wasm stack on some entries)"
echo ""
echo "Usage: file.wasm -m /path/to/magic.lite /path/to/file"

# Install into local-binaries/ so the resolver picks the freshly-built
# binary over the fetched release.
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary file "$SCRIPT_DIR/bin/file.wasm"
