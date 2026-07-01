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
# Output: packages/registry/perl/bin/perl.wasm

PERL_VERSION="${WASM_POSIX_DEP_VERSION:-${PERL_VERSION:-5.40.3}}"
PERL_CROSS_VERSION="${PERL_CROSS_VERSION:-1.6.4}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://www.cpan.org/src/5.0/perl-${PERL_VERSION}.tar.gz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
WORK_DIR="${WASM_POSIX_DEP_WORK_DIR:-$SCRIPT_DIR}"
SRC_DIR="$WORK_DIR/perl-src"
BIN_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/bin}"
# Worktree-local SDK on PATH (no global npm link required).
# shellcheck source=/dev/null
source "$REPO_ROOT/sdk/activate.sh"
SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"
export WASM_POSIX_SYSROOT="$SYSROOT"

# --- Prerequisites ---
if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found after sourcing sdk/activate.sh." >&2
    exit 1
fi

if [ ! -f "$SYSROOT/lib/libc.a" ]; then
    echo "ERROR: sysroot not found. Run: bash build.sh && bash scripts/build-musl.sh" >&2
    exit 1
fi

# perl-cross's configure scripts require GNU tools (sed -r, readelf, objdump).
# scripts/dev-shell.sh provides those tools in the pure build environment.
# LLVM provides readelf and objdump that perl-cross needs
if [ -z "${LLVM_BIN:-}" ]; then
    if [ -n "${LLVM_PREFIX:-}" ]; then
        LLVM_BIN="$LLVM_PREFIX/bin"
    else
        echo "ERROR: LLVM_BIN is not set. Run through scripts/dev-shell.sh." >&2
        exit 1
    fi
fi
if [ -d "$LLVM_BIN" ]; then
    # Create temp dir with readelf/objdump symlinks for perl-cross
    TOOL_DIR="$WORK_DIR/.host-tools"
    mkdir -p "$TOOL_DIR"
    ln -sf "$LLVM_BIN/llvm-readelf" "$TOOL_DIR/readelf"
    ln -sf "$LLVM_BIN/llvm-objdump" "$TOOL_DIR/objdump"
    export PATH="$TOOL_DIR:$PATH"
fi

# --- Download Perl source + perl-cross overlay ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading Perl $PERL_VERSION..."
    TARBALL="$(basename "$SOURCE_URL")"
    curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors -fsSL "$SOURCE_URL" -o "/tmp/$TARBALL"
    if [ -n "$SOURCE_SHA256" ]; then
        echo "==> Verifying source sha256..."
        echo "$SOURCE_SHA256  /tmp/$TARBALL" | shasum -a 256 -c -
    fi
    mkdir -p "$SRC_DIR"
    tar xf "/tmp/$TARBALL" -C "$SRC_DIR" --strip-components=1
    rm "/tmp/$TARBALL"

    echo "==> Downloading perl-cross $PERL_CROSS_VERSION..."
    CROSS_TARBALL="perl-cross-${PERL_CROSS_VERSION}.tar.gz"
    CROSS_URL="https://github.com/arsv/perl-cross/releases/download/${PERL_CROSS_VERSION}/${CROSS_TARBALL}"
    curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors -fsSL "$CROSS_URL" -o "/tmp/$CROSS_TARBALL"
    # Overlay perl-cross on top of perl source tree
    tar xzf "/tmp/$CROSS_TARBALL" -C "$SRC_DIR" --strip-components=1
    rm "/tmp/$CROSS_TARBALL"

    echo "==> Source prepared with perl-cross overlay"

    # Patch perl-cross for non-ELF hosts (macOS uses Mach-O).
    # checksize() uses readelf to get sizeof from ELF symbol tables, which
    # fails on macOS. Patch to fall back to compile-and-run.
    echo "==> Patching perl-cross for macOS..."

    # Replace the readelf-only checksize() with a version that falls back
    # to compile-and-run when readelf returns no useful output.
    python3 - "$SRC_DIR/cnf/configure_type.sh" << 'PYEOF'
import sys

path = sys.argv[1]
with open(path) as f:
    content = f.read()

# Find the checksize function and replace the readelf-based size detection
# with a fallback to compile-and-run for non-ELF hosts (macOS Mach-O)
old_block = "\tif not try_readelf --syms > try.out 2>>$cfglog; then\n\t\tresult 'unknown'\n\t\tdie \"Cannot determine sizeof($2), use -D${1}size=\"\n\t\treturn\n\tfi\n\n\tresult=`grep foo try.out | sed -r -e 's/.*: [0-9]+ +//' -e 's/ .*//' -e 's/^0+//g'`\n\tif [ -z \"$result\" ]; then\n\t\tresult \"unknown\"\n\t\tdie \"Cannot determine sizeof($2)\"\n\telif [ \"$result\" -gt 0 ]; then\n\t\tdefine $1 \"$result\"\n\t\tresult $result\\ `bytes $result`\n\telse\n\t\tresult \"unknown\"\n\t\tdie \"Cannot determine sizeof($2)\"\n\tfi"

new_block = """\t_result=""
\tif try_readelf --syms > try.out 2>>$cfglog; then
\t\t_result=`grep foo try.out | sed -r -e 's/.*: [0-9]+ +//' -e 's/ .*//' -e 's/^0+//g'`
\tfi

\t# Fall back to compile-and-run if readelf failed or returned nothing
\t# (e.g. macOS Mach-O objects that readelf can't parse usefully)
\tif [ -z "$_result" ] || ! [ "$_result" -gt 0 ] 2>/dev/null; then
\t\ttry_start
\t\ttry_includes $3
\t\ttry_add "#include <stdio.h>"
\t\ttry_add "int main(void) { printf(\\"%lu\\", (unsigned long)sizeof($2)); return 0; }"
\t\tif try_link && run ./try > try.out 2>>$cfglog; then
\t\t\t_result=`cat try.out | tr -d '\\n'`
\t\telse
\t\t\t_result=""
\t\tfi
\tfi

\tif [ -z "$_result" ]; then
\t\tresult "unknown"
\t\tdie "Cannot determine sizeof($2)"
\telif [ "$_result" -gt 0 ] 2>/dev/null; then
\t\tdefine $1 "$_result"
\t\tresult $_result\\ `bytes $_result`
\telse
\t\tresult "unknown"
\t\tdie "Cannot determine sizeof($2)"
\tfi"""

if old_block not in content:
    print("WARNING: checksize pattern not found (may already be patched)", file=sys.stderr)
    sys.exit(0)

content = content.replace(old_block, new_block)
with open(path, 'w') as f:
    f.write(content)
print("Patched checksize() in configure_type.sh")
PYEOF

    # Patch byteorder detection to fall back to compile-and-run when
    # objdump fails on Mach-O objects (macOS)
    python3 - "$SRC_DIR/cnf/configure_type_sel.sh" << 'PYEOF2'
import sys

path = sys.argv[1]
with open(path) as f:
    content = f.read()

old = """\t# Most targets use .data but PowerPC has .sdata instead
\tif try_compile && try_objdump -j .data -j .sdata -s; then
\t\tbo=`grep '11' try.out | grep '44' | sed -e 's/  .*//' -e 's/[^1-8]//g' -e 's/\\([1-8]\\)\\1/\\1/g'`
\telse
\t\tbo=''
\tfi

\tif [ -n "$bo" ]; then
\t\tdefine byteorder "$bo"
\t\tresult "$bo"
\telse
\t\tresult "unknown"
\t\tmsg "Cannot determine byteorder for this target,"
\t\tmsg "please supply -Dbyteorder= in the command line."
\t\tmsg "Common values: 1234 for 32bit little-endian, 4321 for 32bit big-endian."
\t\texit 255
\tfi"""

new = """\t# Most targets use .data but PowerPC has .sdata instead
\tif try_compile && try_objdump -j .data -j .sdata -s; then
\t\tbo=`grep '11' try.out | grep '44' | sed -e 's/  .*//' -e 's/[^1-8]//g' -e 's/\\([1-8]\\)\\1/\\1/g'`
\telse
\t\tbo=''
\tfi

\t# Fall back to compile-and-run if objdump failed (macOS Mach-O)
\tif [ -z "$bo" ]; then
\t\ttry_start
\t\ttry_add "#include <stdio.h>"
\t\ttry_add "#include <stdint.h>"
\t\ttry_add "int main(void) {"
\t\tif [ "$uvsize" = 8 ]; then
\t\t\ttry_add "  union { uint64_t i; unsigned char c[8]; } u;"
\t\t\ttry_add "  u.i = 0x0807060504030201ULL;"
\t\t\ttry_add "  int i; for (i = 0; i < 8; i++) printf(\\"%d\\", (int)u.c[i]);"
\t\telse
\t\t\ttry_add "  union { uint32_t i; unsigned char c[4]; } u;"
\t\t\ttry_add "  u.i = 0x04030201;"
\t\t\ttry_add "  int i; for (i = 0; i < 4; i++) printf(\\"%d\\", (int)u.c[i]);"
\t\tfi
\t\ttry_add "  return 0;"
\t\ttry_add "}"
\t\tif try_link && run ./try > try.out 2>>$cfglog; then
\t\t\tbo=`cat try.out | tr -d '\\n'`
\t\tfi
\tfi

\tif [ -n "$bo" ]; then
\t\tdefine byteorder "$bo"
\t\tresult "$bo"
\telse
\t\tresult "unknown"
\t\tmsg "Cannot determine byteorder for this target,"
\t\tmsg "please supply -Dbyteorder= in the command line."
\t\tmsg "Common values: 1234 for 32bit little-endian, 4321 for 32bit big-endian."
\t\texit 255
\tfi"""

if old not in content:
    print("WARNING: byteorder pattern not found (may already be patched)", file=sys.stderr)
    sys.exit(0)

content = content.replace(old, new)
with open(path, 'w') as f:
    f.write(content)
print("Patched byteorder detection in configure_type_sel.sh")
PYEOF2

    # Also make readelf optional (macOS doesn't have native readelf, and
    # llvm-readelf can't parse Mach-O .o files produced by host cc)
    # Make readelf and objdump optional (macOS doesn't have native versions,
    # and llvm versions can't parse Mach-O .o files)
    sed -i.bak \
        -e "s/whichprog readelf READELF readelf || die \"Cannot find readelf\"/whichprog readelf READELF readelf || true/" \
        -e "s/whichprog objdump OBJDUMP objdump || die \"Cannot find objdump\"/whichprog objdump OBJDUMP objdump || true/" \
        "$SRC_DIR/cnf/configure_tool.sh"

    # Point ext/Errno's errno-constant scan at the sysroot errno headers.
    # Errno_pm.PL::get_files() discovers which headers define the E* constants
    # by preprocessing `#include <errno.h>` and scanning the output for
    # `# <line> "file"` linemarkers -- but perl-cross defines cpp/cpprun/
    # cppstdin as "$cc -E -P" (cnf/configure_tool.sh) and -P suppresses
    # linemarkers, so on the wasm cross target the scan discovers zero headers,
    # collects no constants, and Errno_pm.PL dies "No error definitions found".
    # Errno.pm is then never generated/staged and `use Errno` fails. The
    # constants exist as plain `#define E* <int>` in the sysroot (musl
    # arch/generic bits/errno.h); patch get_files() to fall back to the sysroot
    # errno headers when linemarker discovery yields nothing.
    chmod u+w "$SRC_DIR/ext/Errno/Errno_pm.PL"
    python3 - "$SRC_DIR/ext/Errno/Errno_pm.PL" << 'PYEOF3'
import sys

path = sys.argv[1]
with open(path) as f:
    content = f.read()

marker = "kd-gtxa: sysroot errno-header fallback"
if marker in content:
    print("Errno_pm.PL already patched for kd-gtxa", file=sys.stderr)
    sys.exit(0)

old = "    return uniq(@file);"
new = """    # kd-gtxa: sysroot errno-header fallback. perl-cross defines
    # cpp/cpprun/cppstdin as "$cc -E -P"; -P suppresses the `# <line> "file"`
    # linemarkers get_files() scans for, so on the wasm cross target the loop
    # above discovers zero headers -> no E* constants collected -> Errno.pm is
    # never generated and write_errno_pm() dies "No error definitions found".
    # Point the scan at the sysroot errno headers directly (musl ships the
    # constants as plain `#define E* <int>` there). Fallback-only: leaves the
    # upstream linemarker discovery intact wherever it already works.
    if (!@file) {
        my $sysroot = $ENV{WASM_POSIX_SYSROOT} || $Config{sysroot} || '';
        push @file, grep { -f $_ }
            "$sysroot/include/errno.h", "$sysroot/include/bits/errno.h";
    }
    return uniq(@file);"""

if old not in content:
    print("ERROR: Errno_pm.PL anchor 'return uniq(@file);' not found "
          "(perl layout changed?) -- refusing to ship perl without Errno",
          file=sys.stderr)
    sys.exit(1)

content = content.replace(old, new, 1)
with open(path, "w") as f:
    f.write(content)
print("Patched get_files() in ext/Errno/Errno_pm.PL (kd-gtxa sysroot errno fallback)")
PYEOF3
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
    #
    # `-fno-strict-aliasing` is load-bearing: perl's interpreter relies on
    # C type-punning patterns the C standard treats as UB, and clang -O2
    # optimizes the resulting code into a host miniperl that panics in
    # `magic_killbackrefs` (warnings.pm:620) the first time it traverses
    # weak refs. Reproduces with Nix's clang 21 in the pure-shell on Mac
    # arm64; perl's own hints/* set this flag for a reason on every
    # platform that builds perl with clang. (Adding it to HOSTCFLAGS
    # ensures the buildmini sub-configure inherits it — perl-cross
    # propagates HOSTCFLAGS into the host CC invocation.)
    #
    # The SAME UB miscompile hits the TARGET perl.wasm, not just the host
    # miniperl: with `-Doptimize=-O2` and no `-fno-strict-aliasing` in the
    # target `-Dccflags`, perl.wasm panics `magic_killbackrefs` /
    # `del_backref` the first time a loaded module traverses weak refs (e.g.
    # `use File::Spec`, `use Config`, `use Data::Dumper`). That is why the
    # earlier port only passed a trivial arithmetic smoke. `-Dccflags` below
    # carries `-fno-strict-aliasing` so the shipped interpreter is correct.
    #
    # `-Dosname=linux` (below): the wasm32-unknown-none target left osname
    # empty, so ExtUtils::MakeMaker's `$Config{osname} eq ...` probes hit
    # undef and every core module's Makefile.PL/pm_to_blib staging failed
    # (no generated runtime files). Kandelo presents a POSIX/linux-like
    # syscall surface, so a linux osname routes MakeMaker through MM_Unix
    # correctly and lets the core-module runtime tree generate + stage.
    #
    # `-Uusedl` (static extensions): Kandelo wasm has no working dlopen
    # (dlerror() is a stub -> "Can't load Cwd.so ... dlerror() not
    # implemented"). The default usedl=define builds each XS core module as a
    # .so that the runtime can never load, so File::Spec (-> File::Spec::Unix
    # -> Cwd, an XS module), POSIX, Fcntl, List::Util, etc. all fail. Building
    # extensions statically links their XS into perl.wasm with a boot table so
    # XSLoader::load resolves them without dlopen. The set of statically-linked
    # extensions is curated after configure by editing Makefile.config's
    # fullpath_static_ext (perl-cross has no -Dnoextensions handler); see that
    # patch below for which extensions are dropped and why.
    export HOSTCFLAGS="-Wno-format -fno-strict-aliasing"

    # perl-cross's `--mode=cross` spawns two sub-configures: one for
    # the host miniperl (`--mode=buildmini`) and one for the target
    # cross-perl (`--mode=target`). Args don't propagate to the sub-
    # configures except via $hco (built from `--host-*` opts). Without
    # `--host-cc`, the buildmini sub-configure auto-detects via
    # `whichprog cc CC gcc` — which on the GHA Ubuntu runner inside
    # `nix develop` falls through (gcc isn't in the nix-managed PATH;
    # only clang from llvmTree is) and lands on whatever `cc` resolves
    # to, then fails every header probe with "Cannot proceed without
    # <stdint.h>". Pin the host compiler to clang explicitly — it's
    # always on PATH in the nix shell (LLVM_BIN/clang) and ships its
    # own builtin <stdint.h>/<stdarg.h>, so the probes pass.
    ./configure \
        --target=wasm32-unknown-none \
        --prefix=/usr \
        --host-cc=clang \
        -Dcc=wasm32posix-cc \
        -Dld=wasm32posix-cc \
        -Dar=wasm32posix-ar \
        -Dranlib=wasm32posix-ranlib \
        -Dnm=wasm32posix-nm \
        -Doptimize="-O2" \
        -Dosname=linux \
        -Dccflags="-D_GNU_SOURCE -DNO_ENV_ARRAY_IN_MAIN -fvisibility=default -fno-strict-aliasing" \
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
        -Uusedl \
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
        2>&1 | tee "$WORK_DIR/configure.log" | tail -50

    echo "==> Configure complete."

    # Fix xconfig.h: perl-cross silently drops some -Dd_<feature>=define
    # overrides for the cross sub-configure (target xconfig.sh) — e.g.
    # d_nanosleep is set in host config.sh but missing from xconfig.sh,
    # so config_h.SH templates `#$d_nanosleep HAS_NANOSLEEP /**/` to
    # `# HAS_NANOSLEEP /**/`, an invalid preprocessor directive that
    # fails to compile every TU including perl.h.
    #
    # NOTE on portability: the prior version used `[ \t]` in BRE, but
    # BSD sed (macOS) treats `\t` inside `[]` as literal backslash-t,
    # so the substitution silently no-op'd on Mac while working on
    # GNU sed. Use ERE + [[:space:]] for portability across BSD/GNU.
    sed -i.bak -E -e 's/^# ([A-Z][A-Z0-9_]+)([[:space:]])/#define \1\2/' xconfig.h

    # Patch Makefile.config:
    # - Remove -lc (our toolchain links libc automatically)
    # - Add -fvisibility=default (wasm-ld strips hidden-vis symbols with --allow-undefined)
    # - Add -DNO_ENV_ARRAY_IN_MAIN (3-arg main doesn't get __main_argc_argv wrapper on wasm32)
    sed -i.bak \
        -e "s/^LIBS = .*/LIBS =/" \
        -e "/^CFLAGS = /s/$/ -fvisibility=default -DNO_ENV_ARRAY_IN_MAIN/" \
        Makefile.config

    # Curate the static extension set (perl-cross ignores -Dnoextensions, so we
    # edit fullpath_static_ext directly). Two reasons:
    #  - ext/re recompiles regcomp.c with -DPERL_EXT_RE_BUILD, whose symbols
    #    (Perl_reg_add_data, ...) collide with core regcomp.o at the static
    #    perl link ("duplicate symbol"). re is a debug pragma; drop it.
    #  - drop extensions whose XS needs libraries absent from the wasm sysroot
    #    (Compress::Raw::Zlib/Bzip2, Encode, Sys::Syslog, I18N::Langinfo,
    #    NDBM_File, Unicode::Collate/Normalize, PerlIO::encoding) or threads
    #    (we build -Uusethreads); with --allow-undefined those would link but
    #    add wasm imports the host cannot satisfy. Kept set uses standard
    #    libc/syscalls the kernel provides. Excluded modules -> follow-up.
    KEEP_STATIC_EXT="ext/B ext/Devel-Peek ext/Fcntl ext/File-DosGlob ext/File-Glob ext/Hash-Util ext/Hash-Util-FieldHash ext/Opcode ext/POSIX ext/PerlIO-mmap ext/PerlIO-via ext/SDBM_File ext/Sys-Hostname ext/attributes ext/mro cpan/Digest-MD5 cpan/Digest-SHA cpan/Filter-Util-Call cpan/MIME-Base64 cpan/Math-BigInt-FastCalc cpan/Scalar-List-Utils cpan/Socket cpan/Time-Piece dist/Data-Dumper dist/Devel-PPPort dist/IO dist/PathTools dist/Storable dist/Time-HiRes"
    sed -i.bak3 "s|^fullpath_static_ext = .*|fullpath_static_ext = ${KEEP_STATIC_EXT}|" Makefile.config
    echo "==> Curated fullpath_static_ext to $(echo "$KEEP_STATIC_EXT" | wc -w | tr -d ' ') extensions (dropped re + external-lib/threads)."

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
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" perl 2>&1 | tee "$WORK_DIR/build.log" | tail -80

echo "==> Collecting binary..."
mkdir -p "$BIN_DIR"

if [ -f "$SRC_DIR/perl" ]; then
    cp "$SRC_DIR/perl" "$BIN_DIR/perl.wasm"
    SIZE=$(wc -c < "$BIN_DIR/perl.wasm" | tr -d ' ')
    echo "==> Built perl.wasm ($(echo "$SIZE" | numfmt --to=iec 2>/dev/null || echo "${SIZE} bytes"))"
else
    echo "ERROR: perl binary not found after build" >&2
    echo "==> Last 100 lines of build.log:"
    tail -100 "$WORK_DIR/build.log"
    exit 1
fi

echo ""
echo "==> Perl $PERL_VERSION built successfully!"
echo "Binary: $BIN_DIR/perl.wasm"

# --- Build + package the generated core-module runtime library ---
# `make perl` links the interpreter but STOPS before perl-cross's
# `nonxs_ext extensions pods` sub-targets. Those sub-targets are what
# GENERATE core runtime files (e.g. lib/XSLoader.pm from
# dist/XSLoader/XSLoader_pm.PL) and stage the pure-perl core-module tree
# into perl-src/lib/ via pm_to_blib. Without them the shipped bottle has no
# XSLoader.pm, so loading File::Spec (-> Cwd -> XSLoader) fails at runtime --
# the reported gap. These steps run under miniperl (the host build perl), so
# they need no wasm-target execution.
#
# We run `make -k` (keep-going) rather than a plain `make` because two known
# wasm boundaries make the FULL build return non-zero, and neither blocks the
# runtime this package ships (the curated static extensions above still build
# and their .pm still stage):
#   1. ext/Errno: Errno_pm.PL's errno-constant extraction finds none under the
#      wasm sysroot ("No error definitions found") -> follow-up kd-gtxa.
#   2. The extensions dropped from fullpath_static_ext (external-lib/threads/re)
#      have their Makefile.PL/pm_to_blib skipped -> follow-up kd-14n8. The
#      curated static set (POSIX/Fcntl/Cwd/List::Util/...) is linked into
#      perl.wasm and their pure-perl .pm stage via pm_to_blib, so File::Spec
#      (-> Cwd XS), POSIX, etc. load at runtime without dlopen.
# We then verify the required generated files exist and package perl-src/lib/
# (the staged privlib) as the perl-runtime.zip output that the Homebrew
# formula installs + points PERL5LIB at, and that the resolver ships alongside
# perl.wasm.
echo "==> Building + staging Perl runtime modules (make -k)..."
set +e
make -k -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" 2>&1 | tee "$WORK_DIR/build-all.log" | tail -40
ALL_RC=${PIPESTATUS[0]}
set -e
if [ "$ALL_RC" -ne 0 ]; then
    echo "==> 'make -k' exited $ALL_RC (expected: Errno + dropped external-lib exts);" >&2
    echo "    verifying the required generated runtime files were still staged below." >&2
fi

# Stage the statically-linked extensions' .pm into lib/. perl-cross's static
# recipe runs `make -C <dir> ... static` (builds the .a) but never runs the
# module's pm_to_blib, and it touches a `<dir>/pm_to_blib` stamp so a later
# `make pm_to_blib` no-ops -- so File::Spec/POSIX/Cwd .pm never reach lib/ even
# though their XS is linked into perl.wasm. Remove the stamp and run each
# curated static ext's pm_to_blib (uses miniperl, no wasm-target execution).
echo "==> Staging static-extension .pm (pm_to_blib)..."
STATIC_EXT_DIRS="$(sed -n 's/^fullpath_static_ext = //p' Makefile.config)"
for d in $STATIC_EXT_DIRS; do
    [ -d "$d" ] || continue
    rm -f "$d/pm_to_blib"
    make -C "$d" PERL_CORE=1 LIBPERL=libperl.a pm_to_blib >/dev/null 2>&1 || \
        echo "  WARN: pm_to_blib failed for $d (checked by the post-check below)" >&2
done

PRIVLIB_SRC="$SRC_DIR/lib"
# Fail loudly if the generated core runtime files this package exists to ship
# are still absent -- do not publish a silently-incomplete runtime. Cwd.pm is
# the file whose absence made File::Spec fail in the original report.
missing=""
for f in XSLoader.pm Config.pm File/Spec.pm File/Spec/Unix.pm Cwd.pm Errno.pm; do
    [ -f "$PRIVLIB_SRC/$f" ] || missing="$missing $f"
done
if [ -n "$missing" ]; then
    echo "ERROR: required generated runtime files missing from $PRIVLIB_SRC:$missing" >&2
    echo "       (make -k rc=$ALL_RC) -- see $WORK_DIR/build-all.log" >&2
    exit 1
fi
echo "==> Generated runtime files present (XSLoader.pm, Config.pm, File::Spec, Cwd.pm, Errno.pm)."

# `make perl` above linked perl.wasm before any extension was built; with
# `-Uusedl` the `make -k` pass compiles the core XS extensions and relinks
# perl.wasm to statically embed them (with the XSLoader boot table). Re-collect
# that interpreter -- it is the one that can load Cwd/POSIX/Fcntl without
# dlopen. (No-op for a usedl=define build where make -k does not relink perl.)
if [ -f "$SRC_DIR/perl" ]; then
    cp "$SRC_DIR/perl" "$BIN_DIR/perl.wasm"
    echo "==> Re-collected perl.wasm after make -k ($(wc -c < "$BIN_DIR/perl.wasm" | tr -d ' ') bytes)."
fi

echo "==> Packaging Perl runtime library (lib/perl5/$PERL_VERSION)..."
RUNTIME_STAGE="$WORK_DIR/perl-runtime-stage"
rm -rf "$RUNTIME_STAGE"
mkdir -p "$RUNTIME_STAGE/lib/perl5/$PERL_VERSION"
# Ship the staged privlib. Keep unicore/ (utf8 + regex need it) and the
# generated *.pm/*.pl; drop *.bak left by the configure sed patches and the
# *.orig backups so the runtime zip carries only real library files.
cp -R "$PRIVLIB_SRC/." "$RUNTIME_STAGE/lib/perl5/$PERL_VERSION/"
find "$RUNTIME_STAGE" -type f \( -name '*.bak' -o -name '*.orig' \) -delete 2>/dev/null || true
RUNTIME_ZIP="$BIN_DIR/perl-runtime.zip"
rm -f "$RUNTIME_ZIP"
( cd "$RUNTIME_STAGE" && zip -q -r -X "$RUNTIME_ZIP" lib )
echo "==> Packaged runtime: $RUNTIME_ZIP ($(du -h "$RUNTIME_ZIP" | cut -f1))"

# Install into local-binaries/ so the resolver picks the freshly-built
# binary + runtime over the fetched release.
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary perl "$BIN_DIR/perl.wasm"
install_local_binary perl "$RUNTIME_ZIP"
