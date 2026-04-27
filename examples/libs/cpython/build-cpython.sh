#!/usr/bin/env bash
set -euo pipefail

PYTHON_VERSION="${PYTHON_VERSION:-3.13.3}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$SCRIPT_DIR/cpython-src"
HOST_BUILD_DIR="$SCRIPT_DIR/cpython-host-build"
CROSS_BUILD_DIR="$SCRIPT_DIR/cpython-cross-build"
INSTALL_DIR="$SCRIPT_DIR/cpython-install"

REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# Worktree-local SDK on PATH (no global npm link required).
# shellcheck source=/dev/null
source "$REPO_ROOT/sdk/activate.sh"
# Explicit env wins; else the in-tree sysroot.
SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"
export WASM_POSIX_SYSROOT="$SYSROOT"

if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found after sourcing sdk/activate.sh." >&2
    exit 1
fi

# --- Resolve zlib via the dep cache ---
# Env-var short-circuit lets an outer resolver run pass the prefix
# through without re-invoking cargo.
HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"
resolve_dep() {
    local name="$1"
    (cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TARGET" --quiet -- build-deps resolve "$name")
}

ZLIB_PREFIX="${WASM_POSIX_DEP_ZLIB_DIR:-}"
if [ -z "$ZLIB_PREFIX" ]; then
    echo "==> Resolving zlib via cargo xtask build-deps..."
    ZLIB_PREFIX="$(resolve_dep zlib)"
fi
if [ ! -f "$ZLIB_PREFIX/lib/libz.a" ]; then
    echo "ERROR: zlib resolve returned '$ZLIB_PREFIX' but libz.a missing" >&2
    exit 1
fi
echo "==> zlib at $ZLIB_PREFIX"

# Ensure WASI stub libraries exist (CPython's wasi detection injects -lwasi-emulated-*)
for lib in libwasi-emulated-signal.a libwasi-emulated-getpid.a libwasi-emulated-process-clocks.a; do
    if [ ! -f "$SYSROOT/lib/$lib" ]; then
        wasm32posix-ar rcs "$SYSROOT/lib/$lib"
    fi
done

# Download CPython source
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading CPython $PYTHON_VERSION..."
    TARBALL="Python-${PYTHON_VERSION}.tgz"
    curl -fsSL "https://www.python.org/ftp/python/${PYTHON_VERSION}/${TARBALL}" -o "/tmp/${TARBALL}"
    mkdir -p "$SRC_DIR"
    tar xzf "/tmp/${TARBALL}" -C "$SRC_DIR" --strip-components=1
    rm "/tmp/${TARBALL}"
fi

# ─── Phase 1: Build host/native Python ───────────────────────────────
if [ ! -x "$HOST_BUILD_DIR/python" ] && [ ! -x "$HOST_BUILD_DIR/python.exe" ]; then
    echo "==> Building host Python (native build)..."
    mkdir -p "$HOST_BUILD_DIR"
    cd "$HOST_BUILD_DIR"
    "$SRC_DIR/configure" \
        --prefix="$HOST_BUILD_DIR/install" \
        --without-ensurepip \
        --disable-test-modules
    make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)"
    cd "$REPO_ROOT"
fi

if [ -x "$HOST_BUILD_DIR/python.exe" ]; then
    HOST_PYTHON="$HOST_BUILD_DIR/python.exe"
else
    HOST_PYTHON="$HOST_BUILD_DIR/python"
fi
echo "==> Host Python: $HOST_PYTHON"
"$HOST_PYTHON" --version

# ─── Phase 2: Modules/Setup.local is written post-configure (see Phase 4) ─

# ─── Phase 3: config.site ────────────────────────────────────────────
CONFIG_SITE="$SCRIPT_DIR/config.site-wasm32-posix"
cat > "$CONFIG_SITE" << 'SITE_EOF'
# config.site for wasm32-posix-kernel cross compilation
#
# IMPORTANT: Our linker uses --allow-undefined, so ALL link-based function
# detection passes. We must explicitly disable everything we don't have.

ac_cv_buggy_getaddrinfo=no
ac_cv_file__dev_ptmx=no
ac_cv_file__dev_ptc=no

# ─── Headers we don't have ────────────────────────────────────────────
ac_cv_header_sys_resource_h=no
ac_cv_header_netpacket_packet_h=no
ac_cv_header_linux_vm_sockets_h=no
ac_cv_header_sys_xattr_h=no
ac_cv_header_sys_sysmacros_h=no
ac_cv_header_linux_tipc_h=no
ac_cv_header_linux_random_h=no
ac_cv_header_linux_memfd_h=no
ac_cv_header_linux_can_h=no
ac_cv_header_linux_can_raw_h=no
ac_cv_header_linux_can_bcm_h=no
ac_cv_header_linux_can_j1939_h=no
ac_cv_header_sys_epoll_h=no
ac_cv_header_sys_timerfd_h=no
ac_cv_header_sys_sendfile_h=no
ac_cv_header_sys_random_h=no
ac_cv_header_sys_statvfs_h=no
ac_cv_header_spawn_h=no
ac_cv_header_shadow_h=no
ac_cv_header_utmp_h=no
ac_cv_header_syslog_h=no
ac_cv_header_stropts_h=no
ac_cv_header_pty_h=no
ac_cv_header_sys_auxv_h=no
ac_cv_header_sys_syscall_h=no
ac_cv_header_libintl_h=no

# ─── Headers we have ──────────────────────────────────────────────────
ac_cv_header_sys_un_h=yes

# ─── Functions we have ────────────────────────────────────────────────
ac_cv_func_eventfd=yes
ac_cv_func_pipe=yes
ac_cv_func_pipe2=yes
ac_cv_func_fdopendir=yes
ac_cv_func_fork=yes
ac_cv_func_fork1=no
ac_cv_func_preadv=yes
ac_cv_func_readv=yes
ac_cv_func_pwritev=yes
ac_cv_func_writev=yes
ac_cv_func_chmod=yes
ac_cv_func_fchmod=yes
ac_cv_func_fchmodat=yes
ac_cv_func_sigaction=yes
ac_cv_func_sigfillset=yes
ac_cv_func_setpgrp=yes
ac_cv_func_setsid=yes
ac_cv_func_getpgid=yes
ac_cv_func_clock_gettime=yes
ac_cv_func_clock_getres=yes
ac_cv_func_mmap=yes
ac_cv_func_munmap=yes
ac_cv_func_accept=yes
ac_cv_func_accept4=yes
ac_cv_func_socket=yes
ac_cv_func_socketpair=yes
ac_cv_func_bind=yes
ac_cv_func_listen=yes
ac_cv_func_connect=yes
ac_cv_func_getsockopt=yes
ac_cv_func_setsockopt=yes
ac_cv_func_getcwd=yes
ac_cv_func_dup=yes
ac_cv_func_dup2=yes
ac_cv_func_dup3=yes
ac_cv_func_fcntl=yes
ac_cv_func_ftruncate=yes
ac_cv_func_truncate=yes
ac_cv_func_lseek=yes
ac_cv_func_select=yes
ac_cv_func_poll=yes
ac_cv_func_shutdown=yes
ac_cv_func_getpeername=yes
ac_cv_func_getsockname=yes
ac_cv_func_recvfrom=yes
ac_cv_func_sendto=yes
ac_cv_func_gethostname=yes
ac_cv_func_getpid=yes
ac_cv_func_getppid=yes
ac_cv_func_getuid=yes
ac_cv_func_geteuid=yes
ac_cv_func_getgid=yes
ac_cv_func_getegid=yes
ac_cv_func_kill=yes
ac_cv_func_killpg=yes
ac_cv_func_waitpid=yes
ac_cv_func_wait=yes
ac_cv_func_nanosleep=yes
ac_cv_func_usleep=yes
ac_cv_func_chdir=yes
ac_cv_func_fchdir=yes
ac_cv_func_mkdir=yes
ac_cv_func_mkdirat=yes
ac_cv_func_rmdir=yes
ac_cv_func_unlink=yes
ac_cv_func_unlinkat=yes
ac_cv_func_rename=yes
ac_cv_func_renameat=yes
ac_cv_func_link=yes
ac_cv_func_linkat=yes
ac_cv_func_symlink=yes
ac_cv_func_symlinkat=yes
ac_cv_func_readlink=yes
ac_cv_func_readlinkat=yes
ac_cv_func_stat=yes
ac_cv_func_fstat=yes
ac_cv_func_lstat=yes
ac_cv_func_fstatat=yes
ac_cv_func_access=yes
ac_cv_func_faccessat=yes
ac_cv_func_umask=yes
ac_cv_func_utimensat=yes
ac_cv_func_futimens=yes
ac_cv_func_alarm=yes
ac_cv_func_pthread_kill=yes
ac_cv_func_pthread_sigmask=yes
ac_cv_func_sigpending=yes
ac_cv_func_sigprocmask=yes
ac_cv_func_mkfifo=yes
ac_cv_func_openat=yes
ac_cv_func_setpgid=yes
ac_cv_func_getpgrp=yes
ac_cv_func_setitimer=yes
ac_cv_func_getitimer=yes
ac_cv_func_sigtimedwait=yes
ac_cv_func_sigwait=yes
ac_cv_func_sigwaitinfo=yes
ac_cv_func_execv=yes
ac_cv_func_flock=yes
ac_cv_func_getaddrinfo=yes
ac_cv_func_gai_strerror=yes
ac_cv_func_getnameinfo=yes
ac_cv_func_inet_pton=yes
ac_cv_func_inet_ntoa=yes
ac_cv_func_inet_aton=yes

# ─── Functions we DON'T have ──────────────────────────────────────────
ac_cv_func_sem_clockwait=no
ac_cv_func_sem_open=no
ac_cv_func_sem_unlink=no
ac_cv_func_sem_getvalue=no
ac_cv_func_pthread_condattr_setclock=no
ac_cv_func_pthread_cond_timedwait_relative_np=no
ac_cv_func_pthread_getcpuclockid=no
ac_cv_func_pthread_init=no
ac_cv_func_posix_spawn=no
ac_cv_func_posix_spawnp=no
ac_cv_func_posix_spawn_file_actions_addclosefrom_np=no
ac_cv_func_sigaltstack=no
ac_cv_func_statvfs=no
ac_cv_func_fstatvfs=no
ac_cv_func_mknod=no
ac_cv_func_mknodat=no
ac_cv_func_makedev=no
ac_cv_func_shm_open=no
ac_cv_func_shm_unlink=no
ac_cv_func_getentropy=no
ac_cv_func_getrandom=no
ac_cv_func_mremap=no
ac_cv_func_madvise=no
ac_cv_func_posix_madvise=no
ac_cv_func_mprotect=no
ac_cv_func_mlockall=no
ac_cv_func_munlockall=no
ac_cv_func_memfd_create=no
ac_cv_func_sendfile=no
ac_cv_func_splice=no
ac_cv_func_copy_file_range=no
ac_cv_func_preadv2=no
ac_cv_func_pwritev2=no
ac_cv_func_epoll_create=no
ac_cv_func_epoll_create1=no
ac_cv_func_timerfd_create=no
ac_cv_func_inotify_init=no
ac_cv_func_inotify_init1=no
ac_cv_func_kqueue=no
ac_cv_func_sched_setaffinity=no
ac_cv_func_sched_setparam=no
ac_cv_func_sched_setscheduler=no
ac_cv_func_sched_rr_get_interval=no
ac_cv_func_sched_get_priority_max=no
ac_cv_func_setns=no
ac_cv_func_unshare=no
ac_cv_func_process_vm_readv=no
ac_cv_func_prlimit=no
ac_cv_func_getrlimit=no
ac_cv_func_setrlimit=no
ac_cv_func_forkpty=no
ac_cv_func_openpty=no
ac_cv_func_grantpt=no
ac_cv_func_ptsname=no
ac_cv_func_ptsname_r=no
ac_cv_func_posix_openpt=no
ac_cv_func_unlockpt=no
ac_cv_func_setproctitle=no
ac_cv_func_prctl=no
ac_cv_func_fopencookie=no
ac_cv_func_funopen=no
ac_cv_func_close_range=no
ac_cv_func_closefrom=no
ac_cv_func_fgetxattr=no
ac_cv_func_flistxattr=no
ac_cv_func_fsetxattr=no
ac_cv_func_fremovexattr=no
ac_cv_func_getxattr=no
ac_cv_func_listxattr=no
ac_cv_func_removexattr=no
ac_cv_func_setxattr=no
ac_cv_func_lgetxattr=no
ac_cv_func_llistxattr=no
ac_cv_func_lremovexattr=no
ac_cv_func_lsetxattr=no
ac_cv_func_dlopen=no
ac_cv_lib_dl_dlopen=no
ac_cv_func_login_tty=no
ac_cv_func_getlogin=no
ac_cv_func_syslog=no
ac_cv_func_openlog=no
ac_cv_func_closelog=no
ac_cv_func_setuid=no
ac_cv_func_seteuid=no
ac_cv_func_setreuid=no
ac_cv_func_setresuid=no
ac_cv_func_setgid=no
ac_cv_func_setegid=no
ac_cv_func_setregid=no
ac_cv_func_setresgid=no
ac_cv_func_initgroups=no
ac_cv_func_setgroups=no
ac_cv_func_getgroups=no
ac_cv_func_getgrouplist=no
ac_cv_func_tcgetattr=no
ac_cv_func_tcsetattr=no
ac_cv_func_tcflush=no
ac_cv_func_tcsendbreak=no
ac_cv_func_cfgetispeed=no
ac_cv_func_cfsetispeed=no
ac_cv_func_chown=no
ac_cv_func_fchown=no
ac_cv_func_fchownat=no
ac_cv_func_lchown=no
ac_cv_func_chroot=no
# Functions that don't exist in our musl (no header declarations)
ac_cv_func_fdwalk=no
ac_cv_func_chflags=no
ac_cv_func_lchflags=no
ac_cv_func__getpty=no
ac_cv_func_plock=no
ac_cv_func_rtpspawn=no
ac_cv_func_tmpnam_r=no
ac_cv_func_explicit_memset=no
ac_cv_func_getwd=no
ac_cv_func_lchmod=no
ac_cv_func_fexecve=no
ac_cv_func_lockf=no
ac_cv_func_ctermid=no
ac_cv_func_nice=no
ac_cv_func_getloadavg=no
ac_cv_func_getpriority=no
ac_cv_func_setpriority=no
ac_cv_func_sethostname=no
ac_cv_func_if_nameindex=no
ac_cv_func_getrusage=no
ac_cv_func_mkfifoat=no
ac_cv_func_bind_textdomain_codeset=no
ac_cv_func_siginterrupt=no
ac_cv_func_sigrelse=no
ac_cv_func_getresgid=no
ac_cv_func_getresuid=no
ac_cv_func_getsid=no
ac_cv_func_posix_fadvise=no
ac_cv_func_posix_fallocate=no
ac_cv_func_wait3=no
ac_cv_func_wait4=no
ac_cv_func_waitid=no
ac_cv_func_system=no
ac_cv_func_sync=no
ac_cv_func_confstr=no
ac_cv_func_fdatasync=no
ac_cv_func_futimes=no
ac_cv_func_lutimes=no
ac_cv_func_futimesat=no
ac_cv_func_strlcpy=no
ac_cv_func_strsignal=no
ac_cv_func_vfork=no
ac_cv_func_tcgetpgrp=no
ac_cv_func_tcsetpgrp=no
ac_cv_func_clock_settime=no
ac_cv_func_clock_nanosleep=no
ac_cv_func_getspent=no
ac_cv_func_getspnam=no
ac_cv_func_hstrerror=no
ac_cv_func_gethostbyaddr=no
ac_cv_func_gethostbyname=yes
ac_cv_func_gethostbyname_r=no
ac_cv_func_getprotobyname=no
ac_cv_func_getservbyname=no
ac_cv_func_getservbyport=no
ac_cv_func_getgrent=no
ac_cv_func_getgrgid=no
ac_cv_func_getgrgid_r=no
ac_cv_func_getgrnam_r=no
ac_cv_func_getpwent=no
ac_cv_func_getpwnam_r=no
ac_cv_func_getpwuid=no
ac_cv_func_getpwuid_r=no

# Disable int-conversion warning-to-error
ac_cv_disable_int_conversion=yes

# ─── sizeof checks for cross compilation ──────────────────────────────
ac_cv_sizeof_int=4
ac_cv_sizeof_long=4
ac_cv_sizeof_long_long=8
ac_cv_sizeof_void_p=4
ac_cv_sizeof_short=2
ac_cv_sizeof_float=4
ac_cv_sizeof_double=8
ac_cv_sizeof_fpos_t=8
ac_cv_sizeof_size_t=4
ac_cv_sizeof_pid_t=4
ac_cv_sizeof_uintptr_t=4
ac_cv_sizeof_off_t=8
ac_cv_sizeof_time_t=8
ac_cv_sizeof_pthread_t=4
ac_cv_sizeof_pthread_key_t=4
ac_cv_sizeof_wchar_t=4
ac_cv_sizeof__Bool=1

ac_cv_alignof_size_t=4
ac_cv_alignof_max_align_t=8
ac_cv_c_bigendian=no
ac_cv_pthread=yes
SITE_EOF

echo "==> Created config.site: $CONFIG_SITE"

# ─── Phase 4: Cross-compile CPython for wasm32-posix ─────────────────
echo "==> Cross-compiling CPython for wasm32-posix..."
mkdir -p "$CROSS_BUILD_DIR"
cd "$CROSS_BUILD_DIR"

if [ ! -f Makefile ]; then
    # Run configure directly (not via wasm32posix-configure) because CPython
    # requires --host=wasm32-unknown-wasi, not wasm32-unknown-none.
    PKG_CONFIG_PATH="$ZLIB_PREFIX/lib/pkgconfig" \
    CONFIG_SITE="$CONFIG_SITE" \
    CC=wasm32posix-cc \
    CXX=wasm32posix-c++ \
    AR=wasm32posix-ar \
    RANLIB=wasm32posix-ranlib \
    NM=wasm32posix-nm \
    STRIP=wasm32posix-strip \
    PKG_CONFIG=wasm32posix-pkg-config \
    "$SRC_DIR/configure" \
        --host=wasm32-unknown-wasi \
        --build="$(uname -m)-apple-darwin" \
        --with-build-python="$HOST_PYTHON" \
        --without-ensurepip \
        --disable-test-modules \
        --disable-shared \
        --disable-ipv6 \
        --without-mimalloc \
        --with-suffix=".wasm" \
        --prefix="$INSTALL_DIR" \
        CFLAGS="-O2 -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS" \
        CPPFLAGS="-I$ZLIB_PREFIX/include" \
        LDFLAGS="-L$ZLIB_PREFIX/lib"

    # Belt-and-suspenders: patch any HAVE_* that slipped through config.site
    # (header-based detection, not link-based)
    echo "==> Patching pyconfig.h..."
    if [ -f pyconfig.h ]; then
        python3 -c "
import re
with open('pyconfig.h', 'r') as f:
    content = f.read()

# Functions to force-disable (not available in our wasm32-posix environment)
disable = {
    'HAVE_FDWALK', 'HAVE_CHFLAGS', 'HAVE_LCHFLAGS', 'HAVE__GETPTY',
    'HAVE_PLOCK', 'HAVE_RTPSPAWN', 'HAVE_TMPNAM_R', 'HAVE_EXPLICIT_MEMSET',
    'HAVE_GETWD', 'HAVE_LCHMOD', 'HAVE_FEXECVE', 'HAVE_LOCKF',
    'HAVE_CTERMID', 'HAVE_NICE', 'HAVE_GETLOADAVG', 'HAVE_GETPRIORITY',
    'HAVE_SETPRIORITY', 'HAVE_SETHOSTNAME', 'HAVE_IF_NAMEINDEX',
    'HAVE_GETRUSAGE', 'HAVE_MKFIFOAT', 'HAVE_BIND_TEXTDOMAIN_CODESET',
    'HAVE_SIGINTERRUPT', 'HAVE_SIGRELSE', 'HAVE_GETRESGID', 'HAVE_GETRESUID',
    'HAVE_GETSID', 'HAVE_POSIX_FADVISE', 'HAVE_POSIX_FALLOCATE',
    'HAVE_WAIT3', 'HAVE_WAIT4', 'HAVE_WAITID', 'HAVE_SYSTEM', 'HAVE_SYNC',
    'HAVE_CONFSTR', 'HAVE_FDATASYNC', 'HAVE_FUTIMES', 'HAVE_LUTIMES',
    'HAVE_FUTIMESAT', 'HAVE_STRLCPY', 'HAVE_STRSIGNAL', 'HAVE_VFORK',
    'HAVE_TCGETPGRP', 'HAVE_TCSETPGRP', 'HAVE_CLOCK_SETTIME',
    'HAVE_CLOCK_NANOSLEEP', 'HAVE_LOGIN_TTY',
    # Semaphores
    'HAVE_SEM_CLOCKWAIT', 'HAVE_SEM_OPEN', 'HAVE_SEM_UNLINK', 'HAVE_SEM_GETVALUE',
    # Process
    'HAVE_POSIX_SPAWN', 'HAVE_POSIX_SPAWNP',
    # Memory
    'HAVE_MREMAP', 'HAVE_MADVISE', 'HAVE_MEMFD_CREATE',
    # I/O
    'HAVE_SENDFILE', 'HAVE_SPLICE', 'HAVE_COPY_FILE_RANGE',
    'HAVE_PREADV2', 'HAVE_PWRITEV2',
    # Event
    'HAVE_EPOLL', 'HAVE_EPOLL_CREATE1', 'HAVE_TIMERFD_CREATE',
    # Scheduler
    'HAVE_SCHED_SETAFFINITY', 'HAVE_SCHED_SETPARAM', 'HAVE_SCHED_SETSCHEDULER',
    # Linux-specific
    'HAVE_SETNS', 'HAVE_UNSHARE', 'HAVE_PROCESS_VM_READV', 'HAVE_PRLIMIT',
    'HAVE_CLOSE_RANGE',
    # PTY
    'HAVE_FORKPTY', 'HAVE_OPENPTY',
    # Pthread
    'HAVE_PTHREAD_CONDATTR_SETCLOCK', 'HAVE_PTHREAD_GETCPUCLOCKID',
    # Dynamic loading
    'HAVE_DLOPEN', 'HAVE_DYNAMIC_LOADING',
    # Security/random
    'HAVE_GETENTROPY', 'HAVE_GETRANDOM', 'HAVE_SIGALTSTACK',
    'HAVE_SHM_OPEN', 'HAVE_SHM_UNLINK',
    # Misc headers that imply functionality
    'HAVE_SYS_EPOLL_H', 'HAVE_SYS_TIMERFD_H', 'HAVE_SYS_SENDFILE_H',
    'HAVE_SYS_RANDOM_H', 'HAVE_SYS_STATVFS_H', 'HAVE_SPAWN_H',
    'HAVE_SHADOW_H', 'HAVE_UTMP_H', 'HAVE_SYSLOG_H', 'HAVE_STROPTS_H',
    'HAVE_PTY_H', 'HAVE_SYS_AUXV_H', 'HAVE_SYS_SYSCALL_H',
    'HAVE_LIBINTL_H', 'HAVE_LIBRESOLV',
    # Network functions we don't have
    'HAVE_GETHOSTBYADDR',
    'HAVE_GETHOSTBYNAME_R', 'HAVE_GETHOSTBYNAME_R_6_ARG',
    'HAVE_GETPROTOBYNAME',
    'HAVE_GETSERVBYNAME', 'HAVE_GETSERVBYPORT',
    'HAVE_HSTRERROR', 'HAVE_GETSPENT', 'HAVE_GETSPNAM',
    # Group/passwd
    'HAVE_GETGRENT', 'HAVE_GETGRGID', 'HAVE_GETGRGID_R', 'HAVE_GETGRNAM_R',
    'HAVE_GETPWENT', 'HAVE_GETPWNAM_R', 'HAVE_GETPWUID', 'HAVE_GETPWUID_R',
}

for name in disable:
    content = re.sub(
        rf'^#define {name} 1$',
        f'/* #undef {name} */',
        content,
        flags=re.MULTILINE,
    )

with open('pyconfig.h', 'w') as f:
    f.write(content)
print(f'Disabled {len(disable)} HAVE_* defines')
"
    fi

    # Remove modules needing unbuilt external libraries directly from Makefile
    # (Setup.local *disabled* and Setup.stdlib commenting don't affect the
    # already-generated Makefile, so we must edit it directly)
    echo "==> Removing _ssl, _hashlib, _decimal from Makefile..."
    sed -i.bak \
        -e 's/ _ssl / /' \
        -e 's/ _hashlib / /' \
        -e 's/ _decimal / /' \
        -e 's|Modules/_ssl\.o ||g' \
        -e 's|Modules/_hashopenssl\.o ||g' \
        -e 's|Modules/_decimal/_decimal\.o ||g' \
        -e 's/^MODULE__DECIMAL_LDFLAGS=.*/MODULE__DECIMAL_LDFLAGS=/' \
        -e 's/^MODULE__SSL_LDFLAGS=.*/MODULE__SSL_LDFLAGS=/' \
        -e 's/^MODULE__HASHLIB_LDFLAGS=.*/MODULE__HASHLIB_LDFLAGS=/' \
        -e 's/^MODULE__DECIMAL_STATE=yes/MODULE__DECIMAL_STATE=disabled/' \
        -e 's/^MODULE__SSL_STATE=yes/MODULE__SSL_STATE=disabled/' \
        -e 's/^MODULE__HASHLIB_STATE=yes/MODULE__HASHLIB_STATE=disabled/' \
        -e 's/^LIBMPDEC_A=.*/LIBMPDEC_A=/' \
        -e 's/^CONFIGURE_LDFLAGS_NODIST=.*/CONFIGURE_LDFLAGS_NODIST=/' \
        Makefile && rm -f Makefile.bak
fi

echo "==> Building CPython (wasm32)..."
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" 2>&1 || {
    echo "==> Build failed. Check output above for errors."
    exit 1
}

# Copy binary
mkdir -p "$SCRIPT_DIR/bin"
if [ -f python.wasm ]; then
    cp python.wasm "$SCRIPT_DIR/bin/python.wasm"
elif [ -f python ]; then
    cp python "$SCRIPT_DIR/bin/python.wasm"
fi

echo "==> CPython built successfully!"
ls -la "$SCRIPT_DIR/bin/python.wasm"

# Install into local-binaries/ so the resolver picks the freshly-built
# binary over the fetched release.
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary cpython "$SCRIPT_DIR/bin/python.wasm"

# Manifest declares `wasm = "python.wasm"` (not cpython.wasm), so the
# resolver's $WASM_POSIX_DEP_OUT_DIR scratch needs the file under that
# exact name. The helper's default-fallback uses <program>.<ext> which
# doesn't match here.
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    cp "$SCRIPT_DIR/bin/python.wasm" "$WASM_POSIX_DEP_OUT_DIR/python.wasm"
    echo "  installed $WASM_POSIX_DEP_OUT_DIR/python.wasm (manifest output name)"
fi
