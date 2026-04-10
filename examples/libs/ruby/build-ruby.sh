#!/usr/bin/env bash
set -euo pipefail

# Build Ruby 3.3.6 for wasm32-posix-kernel.
#
# Two-phase build:
#   1. Host-native miniruby (generates C source files during cross-compilation)
#   2. Cross-compile Ruby for wasm32 using the SDK toolchain
#
# Output: examples/libs/ruby/bin/ruby.wasm
#
# Prerequisites:
#   - bash build.sh (kernel + sysroot)
#   - npm link in sdk/
#   - zlib built (auto-triggered if missing)

RUBY_VERSION="${RUBY_VERSION:-3.3.6}"
RUBY_MAJOR_MINOR="$(echo "$RUBY_VERSION" | cut -d. -f1-2)"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SRC_DIR="$SCRIPT_DIR/ruby-src"
HOST_BUILD_DIR="$SCRIPT_DIR/ruby-host-build"
CROSS_BUILD_DIR="$SCRIPT_DIR/ruby-cross-build"
INSTALL_DIR="$SCRIPT_DIR/ruby-install"
BIN_DIR="$SCRIPT_DIR/bin"
SYSROOT="$REPO_ROOT/sysroot"

export WASM_POSIX_SYSROOT="$SYSROOT"

if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Run 'npm link' in sdk/ first." >&2
    exit 1
fi

if [ ! -f "$SYSROOT/lib/libc.a" ]; then
    echo "ERROR: sysroot not found. Run: bash build.sh" >&2
    exit 1
fi

# Build zlib if not already built
ZLIB_DIR="$SCRIPT_DIR/../zlib/zlib-install"
if [ ! -f "$ZLIB_DIR/lib/libz.a" ]; then
    echo "==> Building zlib..."
    bash "$SCRIPT_DIR/../zlib/build-zlib.sh"
fi

# Install zlib into sysroot
echo "==> Installing zlib into sysroot..."
cp "$ZLIB_DIR/include/zlib.h" "$ZLIB_DIR/include/zconf.h" "$SYSROOT/include/"
cp "$ZLIB_DIR/lib/libz.a" "$SYSROOT/lib/"
mkdir -p "$SYSROOT/lib/pkgconfig"
sed "s|^prefix=.*|prefix=$SYSROOT|" "$ZLIB_DIR/lib/pkgconfig/zlib.pc" \
    > "$SYSROOT/lib/pkgconfig/zlib.pc"

# Build libyaml if not already built (Ruby needs it for psych/YAML)
LIBYAML_DIR="$SCRIPT_DIR/libyaml-install"
if [ ! -f "$LIBYAML_DIR/lib/libyaml.a" ]; then
    echo "==> Building libyaml for wasm32..."
    LIBYAML_VERSION="0.2.5"
    LIBYAML_SRC="$SCRIPT_DIR/libyaml-src"
    if [ ! -d "$LIBYAML_SRC" ]; then
        curl -fsSL "https://pyyaml.org/download/libyaml/yaml-${LIBYAML_VERSION}.tar.gz" \
            -o "/tmp/yaml-${LIBYAML_VERSION}.tar.gz"
        mkdir -p "$LIBYAML_SRC"
        tar xzf "/tmp/yaml-${LIBYAML_VERSION}.tar.gz" -C "$LIBYAML_SRC" --strip-components=1
        rm "/tmp/yaml-${LIBYAML_VERSION}.tar.gz"
    fi
    cd "$LIBYAML_SRC"
    if [ ! -f Makefile ]; then
        wasm32posix-configure --prefix="$LIBYAML_DIR" --disable-shared --enable-static
    fi
    make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)"
    make install
    cd "$REPO_ROOT"
    echo "==> libyaml built"
fi

# Install libyaml into sysroot
cp "$LIBYAML_DIR/include/yaml.h" "$SYSROOT/include/"
cp "$LIBYAML_DIR/lib/libyaml.a" "$SYSROOT/lib/"
if [ -f "$LIBYAML_DIR/lib/pkgconfig/yaml-0.1.pc" ]; then
    sed "s|^prefix=.*|prefix=$SYSROOT|" "$LIBYAML_DIR/lib/pkgconfig/yaml-0.1.pc" \
        > "$SYSROOT/lib/pkgconfig/yaml-0.1.pc"
fi

# Ensure WASI stub libraries exist (Ruby's wasi detection injects -lwasi-emulated-*)
for lib in libwasi-emulated-signal.a libwasi-emulated-getpid.a libwasi-emulated-process-clocks.a libwasi-emulated-mman.a; do
    if [ ! -f "$SYSROOT/lib/$lib" ]; then
        wasm32posix-ar rcs "$SYSROOT/lib/$lib"
    fi
done

# --- Download Ruby source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading Ruby $RUBY_VERSION..."
    TARBALL="ruby-${RUBY_VERSION}.tar.gz"
    curl -fsSL "https://cache.ruby-lang.org/pub/ruby/${RUBY_MAJOR_MINOR}/${TARBALL}" \
        -o "/tmp/${TARBALL}"
    mkdir -p "$SRC_DIR"
    tar xzf "/tmp/${TARBALL}" -C "$SRC_DIR" --strip-components=1
    rm "/tmp/${TARBALL}"
    echo "==> Source extracted to $SRC_DIR"
fi

# ─── Source patches for wasm32-posix ──────────────────────────────────
# thread_none.c: missing thread_sched_atfork stub (called by thread.c unconditionally)
if ! grep -q 'thread_sched_atfork' "$SRC_DIR/thread_none.c"; then
    echo "==> Patching thread_none.c: adding thread_sched_atfork stub..."
    sed -i.bak '/^#define thread_sched_to_dead/a\
\
static void\
thread_sched_atfork(struct rb_thread_sched *sched)\
{\
}' "$SRC_DIR/thread_none.c"
    rm -f "$SRC_DIR/thread_none.c.bak"
fi

# wasm/machine.c: missing <stdint.h> for uint8_t
if ! grep -q '#include <stdint.h>' "$SRC_DIR/wasm/machine.c"; then
    echo "==> Patching wasm/machine.c: adding #include <stdint.h>..."
    sed -i.bak '1i\
#include <stdint.h>' "$SRC_DIR/wasm/machine.c"
    rm -f "$SRC_DIR/wasm/machine.c.bak"
fi


# ─── Phase 1: Build host-native Ruby ─────────────────────────────────
if [ ! -x "$HOST_BUILD_DIR/miniruby" ]; then
    echo "==> Building host Ruby (native build)..."
    mkdir -p "$HOST_BUILD_DIR"
    cd "$HOST_BUILD_DIR"
    "$SRC_DIR/configure" \
        --prefix="$HOST_BUILD_DIR/install" \
        --disable-install-doc \
        --disable-install-rdoc \
        --disable-jit-support \
        --with-out-ext=openssl,fiddle,readline
    make miniruby -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)"
    cd "$REPO_ROOT"
fi

HOST_MINIRUBY="$HOST_BUILD_DIR/miniruby"
echo "==> Host miniruby: $HOST_MINIRUBY"
"$HOST_MINIRUBY" -e 'puts "Ruby #{RUBY_VERSION} miniruby OK"'

# ─── Phase 2: Cross-compile Ruby for wasm32-posix ────────────────────
echo "==> Cross-compiling Ruby for wasm32-posix..."
mkdir -p "$CROSS_BUILD_DIR"
cd "$CROSS_BUILD_DIR"

if [ ! -f Makefile ]; then
    # Create config.site with cross-compilation overrides
    CONFIG_SITE="$SCRIPT_DIR/config.site-wasm32-posix"
    cat > "$CONFIG_SITE" << 'SITE_EOF'
# config.site for Ruby wasm32-posix-kernel cross compilation
#
# --allow-undefined means ALL link-based function detection passes.
# We must explicitly disable everything we don't have.

# ─── Type sizes (wasm32 ILP32) ──────────────────────────────────────
ac_cv_sizeof_int=4
ac_cv_sizeof_short=2
ac_cv_sizeof_long=4
ac_cv_sizeof_long_long=8
ac_cv_sizeof_voidp=4
ac_cv_sizeof___int64=0
ac_cv_sizeof_off_t=8
ac_cv_sizeof_size_t=4
ac_cv_sizeof_time_t=8
ac_cv_sizeof_clock_t=8
ac_cv_sizeof_dev_t=8
ac_cv_sizeof_ino_t=8
ac_cv_sizeof_nlink_t=4
ac_cv_sizeof_struct_stat_st_size=8
ac_cv_sizeof_struct_stat_st_blocks=8
ac_cv_sizeof_struct_stat_st_ino=8

# ─── Endianness ─────────────────────────────────────────────────────
ac_cv_c_bigendian=no

# ─── Memory functions ───────────────────────────────────────────────
ac_cv_func_malloc_0_nonnull=yes
ac_cv_func_realloc_0_nonnull=yes

# ─── Functions we have ──────────────────────────────────────────────
ac_cv_func_fork=yes
ac_cv_func_pipe2=yes
ac_cv_func_dup=yes
ac_cv_func_dup2=yes
ac_cv_func_dup3=yes
ac_cv_func_fcntl=yes
ac_cv_func_ftruncate=yes
ac_cv_func_truncate=yes
ac_cv_func_lseek=yes
ac_cv_func_select=yes
ac_cv_func_poll=yes
ac_cv_func_getcwd=yes
ac_cv_func_chdir=yes
ac_cv_func_fchdir=yes
ac_cv_func_mkdir=yes
ac_cv_func_rmdir=yes
ac_cv_func_unlink=yes
ac_cv_func_rename=yes
ac_cv_func_link=yes
ac_cv_func_symlink=yes
ac_cv_func_readlink=yes
ac_cv_func_stat=yes
ac_cv_func_fstat=yes
ac_cv_func_lstat=yes
ac_cv_func_access=yes
ac_cv_func_umask=yes
ac_cv_func_chmod=yes
ac_cv_func_fchmod=yes
ac_cv_func_kill=yes
ac_cv_func_killpg=yes
ac_cv_func_waitpid=yes
ac_cv_func_nanosleep=yes
ac_cv_func_clock_gettime=yes
ac_cv_func_clock_getres=yes
ac_cv_func_mmap=yes
ac_cv_func_munmap=yes
ac_cv_func_socket=yes
ac_cv_func_socketpair=yes
ac_cv_func_bind=yes
ac_cv_func_listen=yes
ac_cv_func_connect=yes
ac_cv_func_accept=yes
ac_cv_func_shutdown=yes
ac_cv_func_getpeername=yes
ac_cv_func_getsockname=yes
ac_cv_func_getsockopt=yes
ac_cv_func_setsockopt=yes
ac_cv_func_getpid=yes
ac_cv_func_getppid=yes
ac_cv_func_getuid=yes
ac_cv_func_geteuid=yes
ac_cv_func_getgid=yes
ac_cv_func_getegid=yes
ac_cv_func_sigaction=yes
ac_cv_func_sigprocmask=yes
ac_cv_func_sigfillset=yes
ac_cv_func_setpgid=yes
ac_cv_func_getpgrp=yes
ac_cv_func_getpgid=yes
ac_cv_func_setsid=yes
ac_cv_func_setitimer=yes
ac_cv_func_getitimer=yes
ac_cv_func_alarm=yes
ac_cv_func_flock=yes
ac_cv_func_mkfifo=yes
ac_cv_func_openat=yes
ac_cv_func_fstatat=yes
ac_cv_func_utimensat=yes
ac_cv_func_futimens=yes
ac_cv_func_readlinkat=yes
ac_cv_func_symlinkat=yes
ac_cv_func_linkat=yes
ac_cv_func_unlinkat=yes
ac_cv_func_renameat=yes
ac_cv_func_mkdirat=yes
ac_cv_func_faccessat=yes
ac_cv_func_fchmodat=yes
ac_cv_func_gethostname=yes
ac_cv_func_getaddrinfo=yes
ac_cv_func_getnameinfo=yes
ac_cv_func_inet_pton=yes
ac_cv_func_inet_ntoa=yes
ac_cv_func_inet_aton=yes
ac_cv_func_execv=yes
ac_cv_func_execve=yes
ac_cv_func_preadv=yes
ac_cv_func_pwritev=yes
ac_cv_func_readv=yes
ac_cv_func_writev=yes
ac_cv_func_eventfd=yes
ac_cv_func_pipe=yes
ac_cv_func_sigpending=yes
ac_cv_func_recvfrom=yes
ac_cv_func_sendto=yes
ac_cv_func_gethostbyname=yes
ac_cv_func_usleep=yes
ac_cv_func_sigwait=yes
ac_cv_func_sigtimedwait=yes
ac_cv_func_sigwaitinfo=yes

# ─── Functions we DON'T have ────────────────────────────────────────
ac_cv_func_pthread_create=no
ac_cv_func_pthread_attr_setinheritsched=no
ac_cv_func_pthread_attr_init=no
ac_cv_func_pthread_condattr_setclock=no
ac_cv_func_pthread_getcpuclockid=no
ac_cv_func_pthread_setname_np=no
ac_cv_func_pthread_getattr_np=no
ac_cv_func_pthread_attr_getstack=no
ac_cv_func_sem_open=no
ac_cv_func_sem_close=no
ac_cv_func_sem_unlink=no
ac_cv_func_sem_getvalue=no
ac_cv_func_sem_init=no
ac_cv_func_sem_destroy=no
ac_cv_func_sem_wait=no
ac_cv_func_sem_trywait=no
ac_cv_func_sem_post=no
ac_cv_func_posix_spawn=no
ac_cv_func_posix_spawnp=no
ac_cv_func_dlopen=no
ac_cv_lib_dl_dlopen=no
ac_cv_func_dladdr=no
ac_cv_func_sigaltstack=no
ac_cv_func_statvfs=no
ac_cv_func_fstatvfs=no
ac_cv_func_mknod=no
ac_cv_func_mknodat=no
ac_cv_func_shm_open=no
ac_cv_func_shm_unlink=no
ac_cv_func_getentropy=no
ac_cv_func_getrandom=no
ac_cv_func_mremap=no
ac_cv_func_madvise=no
ac_cv_func_mprotect=no
ac_cv_func_memfd_create=no
ac_cv_func_sendfile=no
ac_cv_func_splice=no
ac_cv_func_copy_file_range=no
ac_cv_func_epoll_create=no
ac_cv_func_epoll_create1=no
ac_cv_func_timerfd_create=no
ac_cv_func_inotify_init=no
ac_cv_func_inotify_init1=no
ac_cv_func_kqueue=no
ac_cv_func_kevent=no
ac_cv_func_sched_setaffinity=no
ac_cv_func_sched_yield=no
ac_cv_func_sched_get_priority_max=no
ac_cv_func_setns=no
ac_cv_func_unshare=no
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
ac_cv_func_login_tty=no
ac_cv_func_setproctitle=no
ac_cv_func_prctl=no
ac_cv_func_fopencookie=no
ac_cv_func_close_range=no
ac_cv_func_closefrom=no
ac_cv_func_getxattr=no
ac_cv_func_fgetxattr=no
ac_cv_func_setxattr=no
ac_cv_func_chown=no
ac_cv_func_fchown=no
ac_cv_func_fchownat=no
ac_cv_func_lchown=no
ac_cv_func_chroot=no
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
ac_cv_func_getrusage=no
ac_cv_func_confstr=no
ac_cv_func_fdatasync=no
ac_cv_func_futimes=no
ac_cv_func_lutimes=no
ac_cv_func_strlcpy=no
ac_cv_func_strlcat=no
ac_cv_func_strsignal=no
ac_cv_func_vfork=no
ac_cv_func_tcgetattr=no
ac_cv_func_tcsetattr=no
ac_cv_func_tcflush=no
ac_cv_func_tcgetpgrp=no
ac_cv_func_tcsetpgrp=no
ac_cv_func_clock_settime=no
ac_cv_func_clock_nanosleep=no
ac_cv_func_getpriority=no
ac_cv_func_setpriority=no
ac_cv_func_nice=no
ac_cv_func_getloadavg=no
ac_cv_func_wait3=no
ac_cv_func_wait4=no
ac_cv_func_waitid=no
ac_cv_func_system=no
ac_cv_func_sync=no
ac_cv_func_fdwalk=no
ac_cv_func_chflags=no
ac_cv_func_lchflags=no
ac_cv_func_lockf=no
ac_cv_func_ctermid=no
ac_cv_func_fexecve=no
ac_cv_func_sethostname=no
ac_cv_func_if_nameindex=no
ac_cv_func_mkfifoat=no
ac_cv_func_siginterrupt=no
ac_cv_func_getresgid=no
ac_cv_func_getresuid=no
ac_cv_func_getsid=no
ac_cv_func_posix_fadvise=no
ac_cv_func_posix_fallocate=no
ac_cv_func_syslog=no
ac_cv_func_openlog=no
ac_cv_func_closelog=no
ac_cv_func_getlogin=no
ac_cv_func_getpwent=no
ac_cv_func_getpwnam_r=no
ac_cv_func_getpwuid=no
ac_cv_func_getpwuid_r=no
ac_cv_func_getgrent=no
ac_cv_func_getgrgid=no
ac_cv_func_getgrgid_r=no
ac_cv_func_getgrnam_r=no
ac_cv_func_getspent=no
ac_cv_func_getspnam=no
ac_cv_func_hstrerror=no
ac_cv_func_gethostbyaddr=no
ac_cv_func_gethostbyname_r=no
ac_cv_func_getprotobyname=no
ac_cv_func_getservbyname=no
ac_cv_func_getservbyport=no
ac_cv_func_daemon=no
# ucontext functions — declared in header but not implemented in our musl
ac_cv_func_getcontext=no
ac_cv_func_setcontext=no
ac_cv_func_makecontext=no
ac_cv_func_swapcontext=no
# glibc-specific
ac_cv_func_malloc_trim=no
# macOS/BSD-specific (don't leak from build host)
ac_cv_func_getattrlist=no
ac_cv_func_fgetattrlist=no
ac_cv_header_sys_attr_h=no
ac_cv_func___cospi=no
ac_cv_func___sinpi=no
ac_cv_func_fcopyfile=no
ac_cv_header_copyfile_h=no
ac_cv_func_setruid=no
ac_cv_func_setrgid=no
ac_cv_func_getpwnam=no
ac_cv_func_getgrnam=no
ac_cv_header_sys_prctl_h=no

# ─── Headers we don't have ──────────────────────────────────────────
ac_cv_header_sys_resource_h=no
ac_cv_header_sys_epoll_h=no
ac_cv_header_sys_timerfd_h=no
ac_cv_header_sys_sendfile_h=no
ac_cv_header_sys_random_h=no
ac_cv_header_sys_statvfs_h=no
ac_cv_header_spawn_h=no
ac_cv_header_shadow_h=no
ac_cv_header_utmp_h=no
ac_cv_header_syslog_h=no
ac_cv_header_pty_h=no
ac_cv_header_sys_auxv_h=no
ac_cv_header_sys_syscall_h=no
ac_cv_header_libintl_h=no
ac_cv_header_sys_xattr_h=no
ac_cv_header_linux_random_h=no
ac_cv_header_grp_h=no
ac_cv_header_pwd_h=no

# ─── Headers we have ────────────────────────────────────────────────
ac_cv_header_sys_un_h=yes
ac_cv_header_pthread_h=yes

# ─── Cross-compilation run checks ──────────────────────────────────
rb_cv_negative_time_t=yes
rb_cv_stack_grow_direction=-1
ac_cv_func_getpgrp_void=yes
ac_cv_func_setpgrp_void=yes
SITE_EOF

    echo "==> Created config.site: $CONFIG_SITE"

    # Ruby's wasi detection automatically selects asyncify coroutine,
    # adds wasm/ support files, and sets up wasm-opt POSTLINK.
    # We use --host=wasm32-unknown-wasi to trigger this.
    # WASI_SDK_PATH must be set (Ruby errors if missing) but we override
    # CC/AR/RANLIB/NM so it's only used for the existence check.
    CONFIG_SITE="$CONFIG_SITE" \
    WASI_SDK_PATH="$SYSROOT" \
    CC=wasm32posix-cc \
    LD=wasm32posix-cc \
    AR=wasm32posix-ar \
    RANLIB=wasm32posix-ranlib \
    NM=wasm32posix-nm \
    STRIP=wasm32posix-strip \
    PKG_CONFIG=wasm32posix-pkg-config \
    CFLAGS="-O2 -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS" \
    LDFLAGS="" \
    "$SRC_DIR/configure" \
        --host=wasm32-unknown-wasi \
        --build="$(uname -m)-apple-darwin" \
        --prefix="$INSTALL_DIR" \
        --with-baseruby="$HOST_MINIRUBY" \
        --disable-shared \
        --enable-static \
        --disable-install-doc \
        --disable-install-rdoc \
        --disable-jit-support \
        --disable-yjit \
        --disable-rjit \
        --without-gmp \
        --without-openssl \
        --without-fiddle \
        --without-readline \
        --with-static-linked-ext \
        --with-out-ext=openssl,fiddle,readline,io/console,pty,syslog,etc,nkf \
        2>&1 | tail -50

    echo "==> Configure complete."

    # Patch config.h: disable HAVE_* that slipped through link-based detection
    echo "==> Patching config.h..."
    # Find the generated config.h — location varies by host triple
    CONFIG_H=""
    for candidate in \
        ".ext/include/wasm32-wasi/ruby/config.h" \
        ".ext/include/wasm32-none/ruby/config.h" \
        "config.h"; do
        if [ -f "$candidate" ]; then
            CONFIG_H="$candidate"
            break
        fi
    done

    if [ -z "$CONFIG_H" ]; then
        echo "WARNING: config.h not found, skipping patch"
    else
        echo "==> Patching $CONFIG_H..."
        python3 -c "
import re

with open('$CONFIG_H', 'r') as f:
    content = f.read()

# Add HAVE_PTHREAD_H — our sysroot provides pthread.h with full type
# definitions. Ruby needs this for mutex/cond type definitions in
# thread_native.h even without actual thread creation support.
if 'HAVE_PTHREAD_H' not in content:
    content += '\n/* Added by build-ruby.sh — wasm32-posix has pthread.h */\n'
    content += '#define HAVE_PTHREAD_H 1\n'

# Force-disable functions/features not available in wasm32-posix
disable = {
    'HAVE_DLOPEN', 'HAVE_DYNAMIC_LOADING',
    'HAVE_PTHREAD_CREATE',
    'HAVE_PTHREAD_ATTR_SETINHERITSCHED', 'HAVE_PTHREAD_ATTR_INIT',
    'HAVE_PTHREAD_CONDATTR_SETCLOCK', 'HAVE_PTHREAD_GETCPUCLOCKID',
    'HAVE_PTHREAD_SETNAME_NP', 'HAVE_PTHREAD_GETATTR_NP',
    'HAVE_PTHREAD_ATTR_GETSTACK', 'HAVE_PTHREAD_NP_H',
    'HAVE_SEM_OPEN', 'HAVE_SEM_CLOSE', 'HAVE_SEM_UNLINK',
    'HAVE_SEM_INIT', 'HAVE_SEM_DESTROY', 'HAVE_SEM_WAIT',
    'HAVE_SEM_TRYWAIT', 'HAVE_SEM_POST', 'HAVE_SEM_GETVALUE',
    'HAVE_FORKPTY', 'HAVE_OPENPTY', 'HAVE_LOGIN_TTY',
    'HAVE_GRANTPT', 'HAVE_PTSNAME', 'HAVE_PTSNAME_R',
    'HAVE_POSIX_OPENPT', 'HAVE_UNLOCKPT',
    'HAVE_POSIX_SPAWN', 'HAVE_POSIX_SPAWNP',
    'HAVE_SIGALTSTACK', 'HAVE_GETENTROPY', 'HAVE_GETRANDOM',
    'HAVE_SHM_OPEN', 'HAVE_SHM_UNLINK',
    'HAVE_MREMAP', 'HAVE_MADVISE', 'HAVE_MPROTECT', 'HAVE_MEMFD_CREATE',
    'HAVE_SENDFILE', 'HAVE_SPLICE', 'HAVE_COPY_FILE_RANGE',
    'HAVE_EPOLL_CREATE', 'HAVE_EPOLL_CREATE1',
    'HAVE_TIMERFD_CREATE', 'HAVE_INOTIFY_INIT', 'HAVE_INOTIFY_INIT1',
    'HAVE_KQUEUE', 'HAVE_KEVENT',
    'HAVE_SCHED_SETAFFINITY', 'HAVE_SCHED_YIELD',
    'HAVE_SETNS', 'HAVE_UNSHARE', 'HAVE_PRLIMIT',
    'HAVE_GETRLIMIT', 'HAVE_SETRLIMIT',
    'HAVE_GETRUSAGE', 'HAVE_CONFSTR', 'HAVE_FDATASYNC',
    'HAVE_STRLCPY', 'HAVE_STRLCAT', 'HAVE_STRSIGNAL',
    'HAVE_VFORK', 'HAVE_TCGETATTR', 'HAVE_TCSETATTR',
    'HAVE_TCFLUSH', 'HAVE_TCGETPGRP', 'HAVE_TCSETPGRP',
    'HAVE_CLOCK_SETTIME', 'HAVE_CLOCK_NANOSLEEP',
    'HAVE_GETPRIORITY', 'HAVE_SETPRIORITY', 'HAVE_NICE',
    'HAVE_WAIT3', 'HAVE_WAIT4', 'HAVE_WAITID',
    'HAVE_SYSTEM', 'HAVE_SYNC', 'HAVE_LOCKF',
    'HAVE_CHOWN', 'HAVE_FCHOWN', 'HAVE_FCHOWNAT', 'HAVE_LCHOWN',
    'HAVE_CHROOT', 'HAVE_SETUID', 'HAVE_SETEUID',
    'HAVE_SETREUID', 'HAVE_SETRESUID',
    'HAVE_SETGID', 'HAVE_SETEGID', 'HAVE_SETREGID', 'HAVE_SETRESGID',
    'HAVE_INITGROUPS', 'HAVE_SETGROUPS', 'HAVE_GETGROUPS',
    'HAVE_SYSLOG', 'HAVE_DAEMON',
    'HAVE_CLOSE_RANGE', 'HAVE_CLOSEFROM',
    'HAVE_GETPWENT', 'HAVE_GETPWUID', 'HAVE_GETPWNAM_R', 'HAVE_GETPWUID_R',
    'HAVE_GETGRENT', 'HAVE_GETGRGID', 'HAVE_GETGRGID_R', 'HAVE_GETGRNAM_R',
    'HAVE_GRP_H', 'HAVE_PWD_H',
    'HAVE_SYS_RESOURCE_H', 'HAVE_SYS_EPOLL_H', 'HAVE_SYS_TIMERFD_H',
    'HAVE_SYS_SENDFILE_H', 'HAVE_SYS_RANDOM_H', 'HAVE_SYS_STATVFS_H',
    'HAVE_SPAWN_H', 'HAVE_SHADOW_H', 'HAVE_UTMP_H', 'HAVE_SYSLOG_H',
    'HAVE_PTY_H', 'HAVE_SYS_AUXV_H', 'HAVE_SYS_SYSCALL_H',
    'HAVE_LIBINTL_H', 'HAVE_SYS_XATTR_H', 'HAVE_LINUX_RANDOM_H',
    'HAVE_GETLOGIN',
    'HAVE_PRCTL', 'HAVE_SETPROCTITLE',
    'USE_ELF',
    # ucontext — header exists but no implementation
    'HAVE_GETCONTEXT', 'HAVE_SETCONTEXT', 'HAVE_MAKECONTEXT', 'HAVE_SWAPCONTEXT',
    # glibc-specific
    'HAVE_MALLOC_TRIM',
    # macOS/BSD-specific (leaks through from build host detection)
    'HAVE_GETATTRLIST', 'HAVE_FGETATTRLIST', 'HAVE_SYS_ATTR_H',
    'HAVE___COSPI', 'HAVE___SINPI',
    'HAVE_FCOPYFILE', 'HAVE_COPYFILE_H',
    'HAVE_SETRUID', 'HAVE_SETRGID',
    'HAVE_GETPWNAM', 'HAVE_GETGRNAM',
    'HAVE_SYS_PRCTL_H',
}

disabled = 0
for name in disable:
    new_content = re.sub(
        rf'^#define {name}\b.*$',
        f'/* #undef {name} */',
        content,
        flags=re.MULTILINE,
    )
    if new_content != content:
        disabled += 1
        content = new_content

with open('$CONFIG_H', 'w') as f:
    f.write(content)
print(f'Disabled {disabled} HAVE_* defines in $CONFIG_H')
"
    fi
fi

# Pre-create .revision.time and revision.h to skip VCS revision detection
# BASERUBY (host miniruby) needs -I for stdlib to run file2lastrev.rb,
# so we pass it through BASERUBY to make.
if [ ! -f .revision.time ]; then
    touch .revision.time
fi
if [ ! -f revision.h ]; then
    cat > revision.h << 'REVEOF'
#define RUBY_REVISION "wasm32-posix"
#define RUBY_FULL_REVISION "wasm32-posix"
REVEOF
fi

# execinfo.h (backtrace) not available — create header with declarations only
if [ ! -f "$SYSROOT/include/execinfo.h" ]; then
    echo "==> Creating stub execinfo.h..."
    cat > "$SYSROOT/include/execinfo.h" << 'EXECEOF'
/* Stub execinfo.h for wasm32-posix — no backtrace support */
#ifndef _EXECINFO_H
#define _EXECINFO_H
int backtrace(void **buffer, int size);
char **backtrace_symbols(void *const *buffer, int size);
void backtrace_symbols_fd(void *const *buffer, int size, int fd);
#endif
EXECEOF
fi

echo "==> Building Ruby (wasm32)..."
# Ruby needs MINIRUBY/BASERUBY to point to host ruby with stdlib loaded
RUBY_MAKE_ARGS=(
    MINIRUBY="$HOST_MINIRUBY -I$SRC_DIR/lib"
    BASERUBY="$HOST_MINIRUBY -I$SRC_DIR/lib --disable=gems"
    -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)"
)
make "${RUBY_MAKE_ARGS[@]}" 2>&1 || {
    echo "==> Full build failed, trying miniruby only..."
    make miniruby "${RUBY_MAKE_ARGS[@]}" 2>&1
}

# Collect binary
mkdir -p "$BIN_DIR"
if [ -f ruby ]; then
    cp ruby "$BIN_DIR/ruby.wasm"
elif [ -f miniruby ]; then
    echo "==> Only miniruby built successfully (no full extension support)"
    cp miniruby "$BIN_DIR/ruby.wasm"
fi

# Install stdlib
echo "==> Installing Ruby stdlib..."
mkdir -p "$INSTALL_DIR"
make install MINIRUBY="$HOST_MINIRUBY -I$SRC_DIR/lib" DESTDIR="" 2>/dev/null || {
    echo "==> make install failed, copying lib manually..."
    mkdir -p "$INSTALL_DIR/lib/ruby/${RUBY_MAJOR_MINOR}.0"
    cp -r "$SRC_DIR/lib/"* "$INSTALL_DIR/lib/ruby/${RUBY_MAJOR_MINOR}.0/" 2>/dev/null || true
}

echo ""
echo "==> Ruby built successfully!"
ls -lh "$BIN_DIR/ruby.wasm"
