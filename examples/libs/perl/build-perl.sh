#!/usr/bin/env bash
set -euo pipefail

# Build Perl 5.40.3 for wasm32-posix-kernel.
#
# Uses perl-cross (https://github.com/arsv/perl-cross) for cross-compilation.
# perl-cross replaces Perl's Configure with a proper configure script that
# supports cross-compilation without running target binaries.
#
# Two-phase build (handled internally by perl-cross's Makefile):
#   1. Build host miniperl + generate_uudmap (native)
#   2. Cross-compile perl for wasm32
#
# Output: examples/libs/perl/bin/perl.wasm

PERL_VERSION="${PERL_VERSION:-5.40.3}"
PERL_CROSS_VERSION="${PERL_CROSS_VERSION:-1.6.4}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SRC_DIR="$SCRIPT_DIR/perl-src"
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

# perl-cross's configure scripts require GNU tools (sed -r, readelf, objdump)
# On macOS, prepend Homebrew GNU tool paths and LLVM binutils
for tool in gnu-sed coreutils findutils grep; do
    gnubin="/opt/homebrew/opt/$tool/libexec/gnubin"
    [ -d "$gnubin" ] && export PATH="$gnubin:$PATH"
done
# LLVM provides readelf and objdump that perl-cross needs
LLVM_BIN="/opt/homebrew/opt/llvm/bin"
if [ -d "$LLVM_BIN" ]; then
    # Create temp dir with readelf/objdump symlinks for perl-cross
    TOOL_DIR="$SCRIPT_DIR/.host-tools"
    mkdir -p "$TOOL_DIR"
    ln -sf "$LLVM_BIN/llvm-readelf" "$TOOL_DIR/readelf"
    ln -sf "$LLVM_BIN/llvm-objdump" "$TOOL_DIR/objdump"
    export PATH="$TOOL_DIR:$PATH"
fi

# --- Download Perl source + perl-cross overlay ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading Perl $PERL_VERSION..."
    TARBALL="perl-${PERL_VERSION}.tar.gz"
    URL="https://www.cpan.org/src/5.0/${TARBALL}"
    curl -fsSL "$URL" -o "/tmp/$TARBALL"
    mkdir -p "$SRC_DIR"
    tar xzf "/tmp/$TARBALL" -C "$SRC_DIR" --strip-components=1
    rm "/tmp/$TARBALL"

    echo "==> Downloading perl-cross $PERL_CROSS_VERSION..."
    CROSS_TARBALL="perl-cross-${PERL_CROSS_VERSION}.tar.gz"
    CROSS_URL="https://github.com/arsv/perl-cross/releases/download/${PERL_CROSS_VERSION}/${CROSS_TARBALL}"
    curl -fsSL "$CROSS_URL" -o "/tmp/$CROSS_TARBALL"
    # Overlay perl-cross on top of perl source tree
    tar xzf "/tmp/$CROSS_TARBALL" -C "$SRC_DIR" --strip-components=1
    rm "/tmp/$CROSS_TARBALL"

    echo "==> Source prepared with perl-cross overlay"
fi

cd "$SRC_DIR"

# --- Configure ---
if [ ! -f config.sh ]; then
    echo "==> Configuring Perl for wasm32..."

    # perl-cross's configure does compile/link tests with the cross-compiler.
    # Since our toolchain uses --allow-undefined, link tests for missing functions
    # will pass. We must explicitly override with -D/-U flags for correctness.

    # Host build inherits use64bitint, which makes UV=uint64_t (unsigned long long).
    # On macOS aarch64, Perl's format macros use %l (unsigned long) but UV is
    # unsigned long long — same size but different type. Suppress host warnings.
    export HOSTCFLAGS="-Wno-format"

    ./configure \
        --target=wasm32-unknown-none \
        --prefix=/usr \
        -Dcc=wasm32posix-cc \
        -Dld=wasm32posix-cc \
        -Dar=wasm32posix-ar \
        -Dranlib=wasm32posix-ranlib \
        -Dnm=wasm32posix-nm \
        -Doptimize="-O2" \
        -Dccflags="-D_GNU_SOURCE -DNO_ENV_ARRAY_IN_MAIN -fvisibility=default" \
        -Dldflags="" \
        -Dlddlflags="" \
        -Dccdlflags="" \
        -Dlibs="" \
        -Dperllibs="" \
        \
        -Uusethreads \
        -Uuseithreads \
        -Uusemultiplicity \
        -Uuselargefiles \
        -Duse64bitint \
        -Duseperlio \
        \
        -Dcharsize=1 \
        -Dshortsize=2 \
        -Dintsize=4 \
        -Dlongsize=4 \
        -Dlonglongsize=8 \
        -Dptrsize=4 \
        -Ddoublesize=8 \
        -Dlongdblsize=8 \
        -Di16size=2 \
        -Di32size=4 \
        -Di64size=8 \
        -Duvsize=4 \
        -Divsize=4 \
        -Dnvsize=8 \
        -Dsizesize=4 \
        -Dfpossize=8 \
        -Dlseeksize=8 \
        -Duidsize=4 \
        -Dgidsize=4 \
        -Dtimesize=8 \
        -Dssizetype="int" \
        -Dsizetype="size_t" \
        -Dbyteorder=1234 \
        \
        -Dd_fork=define \
        -Dd_vfork=undef \
        -Dd_pseudofork=undef \
        -Dd_exec=define \
        -Dd_waitpid=define \
        -Dd_wait4=undef \
        -Dd_getpid_proto=define \
        -Dd_getppid=define \
        -Dd_getpgrp=define \
        -Dd_setpgid=define \
        -Dd_setsid=define \
        -Dd_getuid=define \
        -Dd_geteuid=define \
        -Dd_getgid=define \
        -Dd_getegid=define \
        -Dd_kill=define \
        -Dd_killpg=define \
        -Dd_alarm=define \
        -Dd_setitimer=define \
        -Dd_getitimer=define \
        -Dd_sigaction=define \
        -Dd_sigprocmask=define \
        -Dd_sigfillset=define \
        -Dd_nanosleep=define \
        -Dd_usleep=define \
        -Dd_usleepproto=define \
        -Dd_clock_gettime=define \
        \
        -Dd_socket=define \
        -Dd_oldsock=undef \
        -Dd_sockpair=define \
        -Dd_bind=define \
        -Dd_listen=define \
        -Dd_accept=define \
        -Dd_connect=define \
        -Dd_shutdown=define \
        -Dd_getsockopt=define \
        -Dd_setsockopt=define \
        -Dd_recvmsg=define \
        -Dd_sendmsg=define \
        -Dd_getsockname=define \
        -Dd_getpeername=define \
        -Dd_gethostname=define \
        -Dd_gethostbyname=define \
        -Dd_getaddrinfo=define \
        -Dd_getnameinfo=define \
        -Dd_inetpton=define \
        -Dd_inetntop=define \
        -Dd_inet_aton=define \
        -Dd_htonl=define \
        \
        -Dd_open3=define \
        -Dd_fcntl=define \
        -Dd_flock=define \
        -Dd_lockf=undef \
        -Dd_dup2=define \
        -Dd_dup3=define \
        -Dd_pipe=define \
        -Dd_pipe2=define \
        -Dd_select=define \
        -Dd_poll=define \
        -Dd_stat=define \
        -Dd_fstat=define \
        -Dd_lstat=define \
        -Dd_fstatat=define \
        -Dd_truncate=define \
        -Dd_ftruncate=define \
        -Dd_access=define \
        -Dd_faccessat=define \
        -Dd_umask=define \
        -Dd_link=define \
        -Dd_symlink=define \
        -Dd_readlink=define \
        -Dd_rename=define \
        -Dd_unlink=define \
        -Dd_mkdir=define \
        -Dd_rmdir=define \
        -Dd_chdir=define \
        -Dd_fchdir=define \
        -Dd_mkfifo=define \
        -Dd_getcwd=define \
        -Dd_mmap=define \
        -Dd_munmap=define \
        -Dd_utimensat=define \
        -Dd_futimens=define \
        \
        -Dd_dlopen=undef \
        -Dd_dlerror=undef \
        -Dd_dlsym=undef \
        -Dd_dlclose=undef \
        -Dd_libm_lib_version=undef \
        -Dd_mprotect=undef \
        -Dd_mremap=undef \
        -Dd_madvise=undef \
        -Dd_getrlimit=undef \
        -Dd_setrlimit=undef \
        -Dd_eaccess=undef \
        -Dd_setlinebuf=undef \
        -Dd_statvfs=undef \
        -Dd_fstatvfs=undef \
        \
        -Dd_getpwent=undef \
        -Dd_getpwnam=undef \
        -Dd_getpwuid=undef \
        -Dd_getpwnam_r=undef \
        -Dd_getpwuid_r=undef \
        -Dd_endpwent=undef \
        -Dd_setpwent=undef \
        -Dd_getgrent=undef \
        -Dd_getgrnam=undef \
        -Dd_getgrgid=undef \
        -Dd_getgrnam_r=undef \
        -Dd_getgrgid_r=undef \
        -Dd_endgrent=undef \
        -Dd_setgrent=undef \
        -Dd_getspnam=undef \
        -Dd_getspnam_r=undef \
        -Dd_getlogin=undef \
        -Dd_getlogin_r=undef \
        \
        -Dd_chown=undef \
        -Dd_fchown=undef \
        -Dd_lchown=undef \
        -Dd_chroot=undef \
        -Dd_sethostname=undef \
        -Dd_setuid=undef \
        -Dd_seteuid=undef \
        -Dd_setreuid=undef \
        -Dd_setresuid=undef \
        -Dd_setgid=undef \
        -Dd_setegid=undef \
        -Dd_setregid=undef \
        -Dd_setresgid=undef \
        -Dd_getrusage=undef \
        -Dd_nice=undef \
        -Dd_getpriority=undef \
        -Dd_setpriority=undef \
        -Dd_tcgetpgrp=undef \
        -Dd_tcsetpgrp=undef \
        -Dd_syslog=undef \
        \
        -Dd_shm=undef \
        -Dd_shmget=undef \
        -Dd_shmctl=undef \
        -Dd_shmat=undef \
        -Dd_shmdt=undef \
        -Dd_sem=undef \
        -Dd_semget=undef \
        -Dd_semctl=undef \
        -Dd_semop=undef \
        -Dd_msg=undef \
        -Dd_msgget=undef \
        -Dd_msgctl=undef \
        -Dd_msgsnd=undef \
        -Dd_msgrcv=undef \
        \
        -Dd_crypt=undef \
        -Dd_times=undef \
        -Dd_system=undef \
        2>&1 | tee "$SCRIPT_DIR/configure.log" | tail -50

    echo "==> Configure complete."

    # Patch Makefile.config:
    # - Remove -lc (our toolchain links libc automatically)
    # - Add -fvisibility=default (wasm-ld strips hidden-vis symbols with --allow-undefined)
    # - Add -DNO_ENV_ARRAY_IN_MAIN (3-arg main doesn't get __main_argc_argv wrapper on wasm32)
    sed -i.bak \
        -e "s/^LIBS = .*/LIBS =/" \
        -e "/^CFLAGS = /s/$/ -fvisibility=default -DNO_ENV_ARRAY_IN_MAIN/" \
        Makefile.config

    # Patch Makefile for wasm32 linking:
    # Our toolchain uses --allow-undefined which creates env.* imports for unresolved
    # symbols instead of linking to definitions from other .o files. Combined with
    # default --gc-sections, this strips almost all Perl code. Fixes:
    # 1. Remove -Wl,-E (causes duplicate symbols with channel_syscall.c fork/exec glue)
    # 2. Link op.o perl.o and all $(obj) .o files directly instead of libperl.a
    #    (archives + --allow-undefined = symbols resolve as imports, not definitions)
    # 3. Add --no-gc-sections (--allow-undefined + GC strips needed code)
    sed -i.bak \
        -e '/^perl\$x: LDFLAGS += -Wl,-E/d' \
        -e 's|\$(CC) \$(LDFLAGS) -o \$@ \$(filter %\$o,\$^) \$(LIBPERL) \$(statars) \$(LIBS) \$(extlibs)|$(CC) $(LDFLAGS) -Wl,--no-gc-sections -o $@ perlmain$o op$o perl$o $(obj) $(dynaloader_o) $(statars) $(LIBS) $(extlibs)|' \
        Makefile
fi

# --- Build ---
echo "==> Building Perl (this takes a while)..."
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" perl 2>&1 | tee "$SCRIPT_DIR/build.log" | tail -80

echo "==> Collecting binary..."
mkdir -p "$BIN_DIR"

if [ -f "$SRC_DIR/perl" ]; then
    cp "$SRC_DIR/perl" "$BIN_DIR/perl.wasm"
    SIZE=$(wc -c < "$BIN_DIR/perl.wasm" | tr -d ' ')
    echo "==> Built perl.wasm ($(echo "$SIZE" | numfmt --to=iec 2>/dev/null || echo "${SIZE} bytes"))"
else
    echo "ERROR: perl binary not found after build" >&2
    echo "==> Last 100 lines of build.log:"
    tail -100 "$SCRIPT_DIR/build.log"
    exit 1
fi

echo ""
echo "==> Perl $PERL_VERSION built successfully!"
echo "Binary: $BIN_DIR/perl.wasm"
