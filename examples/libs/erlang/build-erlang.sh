#!/usr/bin/env bash
set -euo pipefail

# Build Erlang/OTP BEAM VM for wasm32-posix-kernel.
#
# Two-step cross-compilation:
#   1. Host bootstrap: builds from source to generate bootstrap erlc
#   2. Cross build: uses wasm32posix SDK toolchain
#
# Requires: host Erlang/OTP 28 in PATH (brew install erlang)
#
# Output: erlang-install/bin/beam.smp.wasm + OTP libraries

OTP_VERSION="${OTP_VERSION:-28.2}"
OTP_TAG="OTP-${OTP_VERSION}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SRC_DIR="$SCRIPT_DIR/erlang-src"
HOST_BUILD_DIR="$SCRIPT_DIR/erlang-host-build"
CROSS_BUILD_DIR="$SCRIPT_DIR/erlang-cross-build"
INSTALL_DIR="$SCRIPT_DIR/erlang-install"
SYSROOT="$REPO_ROOT/sysroot"

NPROC="$(sysctl -n hw.ncpu 2>/dev/null || nproc)"

# Homebrew LLVM
LLVM_PREFIX="$(brew --prefix llvm 2>/dev/null || echo /opt/homebrew/opt/llvm)"
LLVM_CLANG="$LLVM_PREFIX/bin/clang"

# --- Verify prerequisites ---
if [ ! -f "$SYSROOT/lib/libc.a" ]; then
    echo "ERROR: sysroot not found. Run: bash build.sh" >&2
    exit 1
fi

if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Run 'npm link' in sdk/ first." >&2
    exit 1
fi

if ! command -v erl &>/dev/null; then
    echo "ERROR: host Erlang not found. Install: brew install erlang" >&2
    exit 1
fi

# Verify host Erlang is OTP 28
HOST_OTP_REL=$(erl -eval 'io:format("~s", [erlang:system_info(otp_release)]), halt().' -noshell)
if [ "$HOST_OTP_REL" != "28" ]; then
    echo "ERROR: Host Erlang is OTP $HOST_OTP_REL, need OTP 28" >&2
    exit 1
fi

echo "==> Host Erlang: OTP $HOST_OTP_REL ($(erl -eval 'io:format("~s", [erlang:system_info(version)]), halt().' -noshell))"

# --- Download OTP source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading Erlang/OTP ${OTP_VERSION}..."
    TARBALL="otp_src_${OTP_VERSION}.tar.gz"
    URL="https://github.com/erlang/otp/releases/download/${OTP_TAG}/${TARBALL}"
    curl -fsSL "$URL" -o "/tmp/$TARBALL"
    mkdir -p "$SRC_DIR"
    tar xzf "/tmp/$TARBALL" -C "$SRC_DIR" --strip-components=1
    rm "/tmp/$TARBALL"
    echo "==> Source extracted to $SRC_DIR"
fi

export ERL_TOP="$SRC_DIR"

# --- Phase 1: Host bootstrap build ---
# We use the system Erlang as bootstrap, but we need the source tree configured
# for cross-compilation. First, build a host bootstrap from the same source.
if [ ! -f "$HOST_BUILD_DIR/bootstrap/bin/erlc" ]; then
    echo "==> Phase 1: Building host bootstrap..."
    mkdir -p "$HOST_BUILD_DIR"
    cd "$SRC_DIR"

    ./configure --enable-bootstrap-only 2>&1 | tail -10
    make -j"$NPROC" 2>&1 | tail -10

    # The bootstrap artifacts are in $ERL_TOP/bootstrap/
    if [ ! -f "$SRC_DIR/bootstrap/bin/erlc" ]; then
        echo "ERROR: Bootstrap build failed — erlc not found" >&2
        exit 1
    fi
    # Mark as done
    mkdir -p "$HOST_BUILD_DIR"
    ln -sf "$SRC_DIR/bootstrap" "$HOST_BUILD_DIR/bootstrap"
    echo "==> Host bootstrap complete."
    cd "$SCRIPT_DIR"
fi

# --- Phase 2: Create config.site for cross-compilation ---
CONFIG_SITE="$SCRIPT_DIR/config.site-wasm32-posix"
cat > "$CONFIG_SITE" << 'SITE_EOF'
# config.site for Erlang/OTP cross-compilation to wasm32-posix
#
# Our linker uses --allow-undefined, so ALL link-based function detection
# passes. We must explicitly override what we don't have.

# --- Basic types ---
ac_cv_sizeof_int=4
ac_cv_sizeof_long=4
ac_cv_sizeof_long_long=8
ac_cv_sizeof_void_p=4
ac_cv_sizeof_short=2
ac_cv_sizeof_float=4
ac_cv_sizeof_double=8
ac_cv_sizeof_size_t=4
ac_cv_sizeof_off_t=8
ac_cv_sizeof_time_t=8
ac_cv_sizeof_pid_t=4
ac_cv_sizeof_char=1
ac_cv_sizeof_wchar_t=4

ac_cv_c_bigendian=no

# --- Functions we HAVE ---
ac_cv_func_clock_gettime=yes
ac_cv_func_clock_getres=yes
ac_cv_func_mmap=yes
ac_cv_func_munmap=yes
ac_cv_func_poll=yes
ac_cv_func_select=yes
ac_cv_func_pipe=yes
ac_cv_func_pipe2=yes
ac_cv_func_fork=yes
ac_cv_func_socketpair=yes
ac_cv_func_socket=yes
ac_cv_func_bind=yes
ac_cv_func_listen=yes
ac_cv_func_accept=yes
ac_cv_func_connect=yes
ac_cv_func_getsockopt=yes
ac_cv_func_setsockopt=yes
ac_cv_func_getsockname=yes
ac_cv_func_getpeername=yes
ac_cv_func_recvfrom=yes
ac_cv_func_sendto=yes
ac_cv_func_shutdown=yes
ac_cv_func_kill=yes
ac_cv_func_sigaction=yes
ac_cv_func_sigprocmask=yes
ac_cv_func_sigtimedwait=yes
ac_cv_func_nanosleep=yes
ac_cv_func_usleep=yes
ac_cv_func_getcwd=yes
ac_cv_func_chdir=yes
ac_cv_func_fchdir=yes
ac_cv_func_mkdir=yes
ac_cv_func_rmdir=yes
ac_cv_func_unlink=yes
ac_cv_func_rename=yes
ac_cv_func_symlink=yes
ac_cv_func_readlink=yes
ac_cv_func_stat=yes
ac_cv_func_fstat=yes
ac_cv_func_lstat=yes
ac_cv_func_access=yes
ac_cv_func_umask=yes
ac_cv_func_dup=yes
ac_cv_func_dup2=yes
ac_cv_func_fcntl=yes
ac_cv_func_ftruncate=yes
ac_cv_func_lseek=yes
ac_cv_func_getpid=yes
ac_cv_func_getppid=yes
ac_cv_func_getuid=yes
ac_cv_func_geteuid=yes
ac_cv_func_getgid=yes
ac_cv_func_getegid=yes
ac_cv_func_waitpid=yes
ac_cv_func_alarm=yes
ac_cv_func_setitimer=yes
ac_cv_func_getitimer=yes
ac_cv_func_gethostname=yes
ac_cv_func_inet_pton=yes
ac_cv_func_strerror=yes
ac_cv_func_strerror_r=yes
ac_cv_func_posix_memalign=yes
ac_cv_func_openat=yes
ac_cv_func_fstatat=yes
ac_cv_func_readlinkat=yes
ac_cv_func_renameat=yes
ac_cv_func_unlinkat=yes
ac_cv_func_mkdirat=yes
ac_cv_func_eventfd=yes
ac_cv_func_getaddrinfo=yes
ac_cv_func_gethostbyname=yes

# --- pthreads ---
ac_cv_pthread=yes
ac_cv_func_pthread_create=yes
ac_cv_func_pthread_mutex_lock=yes
ac_cv_func_pthread_cond_wait=yes
ac_cv_func_pthread_rwlock_rdlock=yes
ac_cv_func_pthread_spin_lock=yes
ac_cv_func_pthread_attr_setguardsize=yes

# --- Functions we DON'T have ---
ac_cv_func_epoll_create=no
ac_cv_func_epoll_create1=no
ac_cv_func_epoll_ctl=no
ac_cv_func_kqueue=no
ac_cv_func_mprotect=no
ac_cv_func_mremap=no
ac_cv_func_madvise=no
ac_cv_func_mlockall=no
ac_cv_func_getrlimit=no
ac_cv_func_setrlimit=no
ac_cv_func_sched_setaffinity=no
ac_cv_func_sched_getaffinity=no
ac_cv_func_sched_yield=yes
ac_cv_func_dlopen=yes
ac_cv_func_dlsym=yes
ac_cv_func_dlclose=yes
ac_cv_func_sendfile=no
ac_cv_func_writev=yes
ac_cv_func_readv=yes
ac_cv_func_pread=yes
ac_cv_func_pwrite=yes
ac_cv_func_preadv=yes
ac_cv_func_pwritev=yes
ac_cv_func_getrusage=no
ac_cv_func_setuid=no
ac_cv_func_setgid=no
ac_cv_func_seteuid=no
ac_cv_func_setegid=no
ac_cv_func_setreuid=no
ac_cv_func_setregid=no
ac_cv_func_getpwuid=no
ac_cv_func_getpwnam=no
ac_cv_func_getgrnam=no
ac_cv_func_getgrgid=no
ac_cv_func_endpwent=no
ac_cv_func_getpwent=no
ac_cv_func_chown=no
ac_cv_func_fchown=no
ac_cv_func_lchown=no
ac_cv_func_chroot=no
ac_cv_func_prctl=no
ac_cv_func_syslog=no
ac_cv_func_openlog=no
ac_cv_func_closelog=no
ac_cv_func_getentropy=no
ac_cv_func_getrandom=no
ac_cv_func_memfd_create=no
ac_cv_func_close_range=no
ac_cv_func_fdatasync=no
ac_cv_func_sync=no
ac_cv_func_inotify_init=no
ac_cv_func_inotify_init1=no
ac_cv_func_timerfd_create=no
ac_cv_func_signalfd=no
ac_cv_func_accept4=yes
ac_cv_func_getifaddrs=no
ac_cv_func_freeifaddrs=no
ac_cv_func_if_nametoindex=no

# --- Headers we don't have ---
ac_cv_header_sys_epoll_h=no
ac_cv_header_sys_event_h=no
ac_cv_header_sys_timerfd_h=no
ac_cv_header_sys_signalfd_h=no
ac_cv_header_sys_inotify_h=no
ac_cv_header_sys_resource_h=no
ac_cv_header_sys_sysctl_h=no
ac_cv_header_sys_sendfile_h=no
ac_cv_header_syslog_h=no
ac_cv_header_utmp_h=no
ac_cv_header_shadow_h=no
ac_cv_header_net_if_h=yes
ac_cv_header_netinet_in_h=yes
ac_cv_header_arpa_inet_h=yes
ac_cv_header_sys_un_h=yes
ac_cv_header_poll_h=yes
ac_cv_header_dlfcn_h=yes

# BEAM-specific
ac_cv_func_strlcpy=no
ac_cv_func_strlcat=no
ac_cv_func_mallopt=no
ac_cv_header_malloc_h=no

# Disable sctp
ac_cv_header_netinet_sctp_h=no
SITE_EOF

echo "==> Created config.site: $CONFIG_SITE"

# --- Phase 3: Cross-compile ERTS for wasm32-posix ---
echo "==> Phase 3: Cross-compiling Erlang/OTP for wasm32-posix..."
cd "$SRC_DIR"

# Clean build artifacts BUT preserve bootstrap (MAKE_CLEAN=clean, not make clean)
make MAKE_CLEAN=clean 2>/dev/null || true

# The key: OTP's cross-compilation needs --host to be a recognized config.sub triplet.
# wasm32-unknown-wasi is recognized and closest to our platform.
CONFIG_SITE="$CONFIG_SITE" \
CC="wasm32posix-cc" \
CXX="wasm32posix-c++" \
AR="wasm32posix-ar" \
RANLIB="wasm32posix-ranlib" \
LD="wasm32posix-cc" \
LDFLAGS="-Wl,--allow-multiple-definition" \
CFLAGS="-O2 -DNO_JUMP_TABLE -fno-stack-protector -D__linux__ -D_GNU_SOURCE" \
LIBS="" \
./configure \
    --host=wasm32-unknown-wasi \
    --build="$(uname -m)-apple-darwin" \
    --disable-jit \
    --disable-hipe \
    --without-termcap \
    --without-wx \
    --without-odbc \
    --without-ssl \
    --without-crypto \
    --without-ssh \
    --without-megaco \
    --without-diameter \
    --without-snmp \
    --without-ftp \
    --without-tftp \
    --without-observer \
    --without-debugger \
    --without-dialyzer \
    --without-jinterface \
    --without-et \
    --without-eldap \
    --without-common_test \
    --without-eunit \
    --without-tools \
    --without-runtime_tools \
    --without-reltool \
    --without-xmerl \
    --without-mnesia \
    --without-os_mon \
    --without-public_key \
    --without-asn1 \
    --disable-kernel-poll \
    --disable-sctp \
    --disable-sharing-preserving \
    --prefix="$INSTALL_DIR" \
    erl_xcomp_sysroot="$SYSROOT" \
    erl_xcomp_bigendian=no \
    erl_xcomp_poll=yes \
    erl_xcomp_kqueue=no \
    erl_xcomp_clock_gettime_cpu_time=no \
    erl_xcomp_getaddrinfo=yes \
    erl_xcomp_linux_nptl=yes \
    erl_xcomp_linux_usable_sigaltstack=yes \
    erl_xcomp_linux_usable_sigusrx=yes \
    erl_xcomp_putenv_copy=no \
    erl_xcomp_reliable_fpe=no \
    erl_xcomp_dlsym_brk_wrappers=no \
    erl_xcomp_posix_memalign=yes \
    erl_xcomp_after_morecore_hook=no \
    erl_xcomp_code_model_small=no \
    2>&1 | tee "$SCRIPT_DIR/configure.log" | tail -50

echo "==> Configure complete. Patching config.h files..."

# Post-configure: fix false positives from --allow-undefined linker
# Our linker passes all link tests, so configure enables many functions
# that don't actually exist in our musl sysroot.
patch_config_h() {
    local config_h="$1"
    [ -f "$config_h" ] || return 0

    python3 -c "
import re, sys
with open('$config_h', 'r') as f:
    content = f.read()

# Functions/features to force-disable (false positives from --allow-undefined)
disable = {
    # brk/sbrk GNU variants
    'HAVE___BRK', 'HAVE___SBRK', 'HAVE__BRK', 'HAVE__SBRK',
    'HAVE_BRK', 'HAVE_SBRK', 'HAVE__END_SYMBOL', 'HAVE_END_SYMBOL',
    # Solaris-specific
    'HAVE_CLOCK_GET_ATTRIBUTES', 'HAVE_GETHRTIME', 'HAVE_GETHRVTIME',
    'HAVE_IEEE_HANDLER', 'HAVE_FPSETMASK',
    # GNU extensions not in musl
    'HAVE_DLVSYM', 'HAVE_FWRITE_UNLOCKED', 'HAVE_CLOSEFROM',
    'HAVE_CONFLICTING_FREAD_DECLARATION',
    # Linux-specific not in our kernel
    'HAVE_CLOCK_GETTIME_MONOTONIC_RAW', 'HAVE_SETNS',
    'HAVE_NETPACKET_PACKET_H', 'HAVE_SO_BSDCOMPAT',
    'HAVE_SCHED_xETAFFINITY',
    # Network functions not in our musl
    'HAVE_GETHOSTBYNAME2', 'HAVE_GETIPNODEBYADDR', 'HAVE_GETIPNODEBYNAME',
    'HAVE_GETPROTOENT', 'HAVE_ENDPROTOENT', 'HAVE_SETPROTOENT',
    'HAVE_RES_GETHOSTBYNAME',
    # Interface functions not in our musl
    'HAVE_IF_FREENAMEINDEX', 'HAVE_IF_INDEXTONAME', 'HAVE_IF_NAMEINDEX',
    'HAVE_IFADDRS_H',
    # PTY/terminal not through standard APIs
    'HAVE_OPENPTY', 'HAVE_WORKING_POSIX_OPENPT', 'HAVE_PTY_H',
    # Memory functions not in our kernel
    'HAVE_POSIX_FADVISE', 'HAVE_POSIX_MADVISE',
    # Time functions not in our musl
    'HAVE_POSIX2TIME', 'HAVE_TIME2POSIX', 'HAVE_PPOLL',
    # Misc not available
    'HAVE_ELF_H', 'HAVE_LIBUTIL', 'HAVE_VSYSLOG',
    'HAVE_SYS_STROPTS_H', 'HAVE_MALLOPT',
    # Struct members that don't exist
    'HAVE_STRUCT_IFREQ_IFR_HWADDR', 'HAVE_STRUCT_IFREQ_IFR_IFINDEX',
    'HAVE_STRUCT_IFREQ_IFR_MAP',
}

count = 0
for name in disable:
    pattern = rf'^#define {name}\b.*$'
    new = f'/* #undef {name} */'
    content, n = re.subn(pattern, new, content, flags=re.MULTILINE)
    count += n

with open('$config_h', 'w') as f:
    f.write(content)
print(f'Patched {count} defines in $config_h')
"
}

# Patch all config.h files generated by configure
for ch in $(find "$SRC_DIR" -path "*/wasm32-unknown-wasi/config.h" 2>/dev/null); do
    patch_config_h "$ch"
done
# Also patch the main ERTS config.h
ERTS_CONFIG="$SRC_DIR/erts/wasm32-unknown-wasi/config.h"
patch_config_h "$ERTS_CONFIG"

# Patch run_erl.c: LOG_ERR is NULL when syslog disabled, needs to be int
RUN_ERL="$SRC_DIR/erts/etc/unix/run_erl.c"
if grep -q '#    define LOG_ERR NULL' "$RUN_ERL" 2>/dev/null; then
    sed -i '' 's/#    define LOG_ERR NULL/#    define LOG_ERR 3/' "$RUN_ERL"
    sed -i '' 's/#    define LOG_WARNING NULL/#    define LOG_WARNING 4/' "$RUN_ERL"
    sed -i '' 's/#    define LOG_INFO NULL/#    define LOG_INFO 6/' "$RUN_ERL"
    echo "==> Patched run_erl.c syslog defines"
fi

# Patch epmd.c: closelog() called unconditionally but we don't have syslog
EPMD_C="$SRC_DIR/erts/epmd/src/epmd.c"
if grep -q '    closelog();' "$EPMD_C" 2>/dev/null && ! grep -q 'HAVE_SYSLOG_H.*closelog' "$EPMD_C" 2>/dev/null; then
    sed -i '' 's/    closelog();/#ifdef HAVE_SYSLOG_H\n    closelog();\n#endif/' "$EPMD_C"
    echo "==> Patched epmd.c closelog"
fi

# Patch sys_drivers.c: skip forker (fork+exec erl_child_setup) on wasm32
SYS_DRIVERS="$SRC_DIR/erts/emulator/sys/unix/sys_drivers.c"
if ! grep -q '__wasm32__' "$SYS_DRIVERS" 2>/dev/null; then
    sed -i '' '/forker_port = erts_drvport2id(port_num);/a\
\
#ifdef __wasm32__\
    /* On wasm32, we cannot fork+exec erl_child_setup. */\
    forker_fd = -1;\
    return (ErlDrvData)port_num;\
#endif\
' "$SYS_DRIVERS"
    echo "==> Patched sys_drivers.c to skip forker on wasm32"
fi

echo "==> Starting build..."

# Build
make -j"$NPROC" 2>&1 | tee "$SCRIPT_DIR/build.log" | tail -50

echo "==> Build complete. Creating release..."

# Create release
make release RELEASE_ROOT="$INSTALL_DIR" 2>&1 | tail -20

# Find the BEAM emulator
BEAM_BIN=$(find "$INSTALL_DIR" -name "beam.smp" -o -name "beam" 2>/dev/null | head -1)
if [ -n "$BEAM_BIN" ]; then
    echo "==> Erlang/OTP built successfully!"
    ls -lh "$BEAM_BIN"
    cp "$BEAM_BIN" "$SCRIPT_DIR/beam.wasm"
    echo "==> BEAM emulator: $SCRIPT_DIR/beam.wasm"
else
    echo "==> Looking for BEAM in build tree..."
    find "$SRC_DIR/bin" "$SRC_DIR/erts" -name "beam*" -type f 2>/dev/null | head -10
    echo "ERROR: BEAM emulator not found after build" >&2
    exit 1
fi

echo "==> Erlang/OTP ${OTP_VERSION} build complete!"
echo "==> Install directory: $INSTALL_DIR"
