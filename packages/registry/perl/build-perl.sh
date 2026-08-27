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
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$SCRIPT_DIR/perl-work" wasm32
# shellcheck source=/dev/null
source "$REPO_ROOT/sdk/activate.sh"

SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://www.cpan.org/src/5.0/perl-${PERL_VERSION}.tar.gz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-4c155b4e6160682b38919b55ac319081b898db11857cf18a7d9ffed2648ccaff}"
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    SRC_DIR="$KANDELO_PACKAGE_WORK_DIR/source"
    BIN_DIR="$KANDELO_PACKAGE_WORK_DIR/bin"
else
    SRC_DIR="$SCRIPT_DIR/perl-src"
    BIN_DIR="$SCRIPT_DIR/bin"
fi
PERL_CROSS_COMMIT=0cc3a1c5432cab8f121f7a629f61893713e7d27a
if [ "${WASM_POSIX_RESOLUTION_POLICY:-}" = "source-only-v1" ]; then
    if [ -z "${WASM_POSIX_BUILD_GIT_PERL_CROSS_DIR:-}" ] || \
       [ "${WASM_POSIX_BUILD_GIT_PERL_CROSS_COMMIT:-}" != "$PERL_CROSS_COMMIT" ]; then
        echo "ERROR: Perl SourceOnly requires the exact perl_cross Git input (DIR and COMMIT $PERL_CROSS_COMMIT)" >&2
        exit 2
    fi
    WASM_POSIX_BUILD_GIT_PERL_CROSS_DIR="$(
        kandelo_package_require_existing_real_dir \
            "Perl perl_cross Git input" "$WASM_POSIX_BUILD_GIT_PERL_CROSS_DIR"
    )"
    export WASM_POSIX_BUILD_GIT_PERL_CROSS_DIR
fi
SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"
CONFIGURE_LOG="$KANDELO_PACKAGE_WORK_DIR/configure.log"
BUILD_LOG="$KANDELO_PACKAGE_WORK_DIR/build.log"

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
    # Create work-root-local readelf/objdump shims for perl-cross.
    TOOL_DIR="$KANDELO_PACKAGE_WORK_DIR/host-tools"
    mkdir -p "$TOOL_DIR"
    ln -sf "$LLVM_BIN/llvm-readelf" "$TOOL_DIR/readelf"
    ln -sf "$LLVM_BIN/llvm-objdump" "$TOOL_DIR/objdump"
    export PATH="$TOOL_DIR:$PATH"
fi

# --- Stage verified Perl source + exact perl-cross overlay ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Staging verified Perl $PERL_VERSION source..."
    kandelo_package_stage_verified_source perl "$SRC_DIR" \
        "${WASM_POSIX_DEP_SOURCE_DIR:-}" "$SOURCE_URL" "$SOURCE_SHA256" \
        "$KANDELO_PACKAGE_WORK_DIR"

    echo "==> Staging perl-cross $PERL_CROSS_VERSION overlay..."
    if [ -n "${WASM_POSIX_BUILD_GIT_PERL_CROSS_DIR:-}" ]; then
        tar --exclude=.git -cf - -C "$WASM_POSIX_BUILD_GIT_PERL_CROSS_DIR" . |
            tar xf - -C "$SRC_DIR"
    elif [ "${WASM_POSIX_RESOLUTION_POLICY:-}" = "source-only-v1" ]; then
        echo "ERROR: Perl SourceOnly requires the exact perl_cross Git input" >&2
        exit 2
    else
        CROSS_TARBALL="$KANDELO_PACKAGE_WORK_DIR/perl-cross-${PERL_CROSS_VERSION}.tar.gz"
        CROSS_URL="https://github.com/arsv/perl-cross/releases/download/${PERL_CROSS_VERSION}/perl-cross-${PERL_CROSS_VERSION}.tar.gz"
        curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors \
            -fsSL "$CROSS_URL" -o "$CROSS_TARBALL"
        printf '%s  %s\n' \
            b6202173b0a8a43fb312867d85a8cd33527f3f234b1b6e591cdaa9895c9920c7 \
            "$CROSS_TARBALL" | shasum -a 256 -c -
        tar xzf "$CROSS_TARBALL" -C "$SRC_DIR" --strip-components=1
    fi

    # Resolver-owned Git inputs are deliberately sealed read-only. The
    # overlay above copies those bytes into this caller-owned build tree, so
    # make only the copy writable before applying the host-compatibility
    # patches below.
    find "$SRC_DIR" ! -type l -exec chmod u+rwX,go-w {} +

    # perl-cross uses GNU-sed-only `\s` escapes in version detection, module
    # list normalization, and its manifest source list. BSD sed treats `\s`
    # as the literal letter `s`; that silently truncates module paths such as
    # ExtUtils and produces a malformed Makefile. Patch only the writable
    # copied overlay to portable ERE character classes.
    python3 - "$SRC_DIR" << 'PYVERSION'
import os
import sys

root = sys.argv[1]
patches = [
    (
        "cnf/configure_version.sh",
        '\tq=`grep \'#define\' patchlevel.h | grep "$2" | head -1 | sed -r -e "s/#define $2\\s+//" -e "s/\\s.*//"`',
        '\tq=`grep \'#define\' patchlevel.h | grep "$2" | head -1 | sed -E -e "s/#define $2[[:space:]]+//" -e "s/[[:space:]].*//"`',
    ),
    (
        "cnf/configure_mods.sh",
        '\tv=`echo "$2" | sed -r -e \'s/\\s+/ /g\' -e \'s/^\\s+//\' -e \'s/\\s+$//\'`',
        '\tv=`echo "$2" | sed -E -e \'s/[[:space:]]+/ /g\' -e \'s/^[[:space:]]+//\' -e \'s/[[:space:]]+$//\'`',
    ),
    (
        "Makefile",
        "MANIFEST_CH = $(shell sed -e 's/\\s.*//' MANIFEST | grep '\\.[ch]$$')",
        "MANIFEST_CH = $(shell sed -E -e 's/[[:space:]].*//' MANIFEST | grep '\\.[ch]$$')",
    ),
]

for relative, old, new in patches:
    path = os.path.join(root, relative)
    with open(path) as source:
        content = source.read()
    if content.count(old) != 1:
        raise SystemExit(f"perl-cross portability pattern missing exactly once in {relative}")
    with open(path, "w") as destination:
        destination.write(content.replace(old, new))
PYVERSION

    # Errno.pm generation extracts the E* constants from errno.h. On a
    # non-darwin gcc host it preprocesses with `cc -E -dM`; on a darwin host it
    # falls back to reading errno.h as a plain file. That fallback finds nothing
    # when cross-compiling to musl, whose <errno.h> merely #includes
    # <bits/errno.h> where the real `#define E* n` live — so `make all` dies
    # with "No error definitions found". Force the preprocessor path so the
    # cross compiler (which knows the wasm sysroot) expands the include.
    python3 - "$SRC_DIR/ext/Errno/Errno_pm.PL" << 'PYERRNO'
import sys
path = sys.argv[1]
with open(path) as f:
    content = f.read()
import re
old = "    } elsif ($Config{gccversion} ne '' && $^O ne 'darwin' ) {"
new = "    } elsif ($Config{cc} ne '' ) {"
if content.count(old) != 1:
    raise SystemExit("Errno_pm.PL darwin-gate pattern missing exactly once")
content = content.replace(old, new)

# get_files() writes an errno.c wrapper then tries to discover the real
# errno.h path by parsing #line directives from `cppstdin < errno.c` — which
# emits nothing when cross-compiling from a darwin host, leaving @file empty.
# Hand the errno.c wrapper straight to process_file (now `cc -E -dM`) instead.
block = re.compile(r"\t# invoke CPP and read the output\n.*?\tclose\(CPPO\);\n", re.DOTALL)
if len(block.findall(content)) != 1:
    raise SystemExit("Errno_pm.PL get_files CPP block not matched exactly once")
content = block.sub("\tpush(@file, 'errno.c');\n", content)

with open(path, "w") as f:
    f.write(content)
PYERRNO

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
fi

if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    # Capture the exact patched source before configure/build adds generated
    # files or symlinks. The product builder applies its own reviewed filter.
    kandelo_package_project_requested_vfs_source_role standard-library \
        "$SRC_DIR"
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
    # `-fno-strict-aliasing` is load-bearing on BOTH the host miniperl and
    # the target perl.wasm: perl's interpreter relies on C type-punning
    # patterns the C standard treats as UB, and clang -O2 miscompiles the
    # resulting weak-backref bookkeeping in sv.c. The first `use warnings`
    # then dies with `panic: del_backref, svp=0` at warnings.pm's stash
    # cleanup (`delete @warnings::{qw(NORMAL FATAL MESSAGE LEVEL)}` walks the
    # deleted constant subs' CV->glob backrefs). Because nearly every module
    # does `use warnings`, the whole standard library is unusable without it.
    # perl's own hints/* set this flag for a reason on every platform that
    # builds perl with clang.
    #
    # HOSTCFLAGS carries it to the host miniperl (perl-cross's buildmini
    # sub-configure propagates HOSTCFLAGS into the host CC invocation);
    # -Doptimize below carries it to the target cross-compile.
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
    #
    # -Dosname=linux: the wasm32-unknown-none target leaves osname empty, which
    # makes ExtUtils::MakeMaker abort ("CONFIG key 'osname' does not exist")
    # when building every extension. This is not a claim that Kandelo emulates
    # Linux — Kandelo is POSIX-centric. It is a guest-app compatibility
    # convenience: `linux` is the value CPAN/core modules branch on most
    # smoothly (via $^O / $Config{osname}), and picking it is purely metadata
    # that does not compromise POSIX behavior.
    #
    # -Dusedl=undef: Kandelo has no runtime dlopen for perl's XS (C) extensions,
    # so build every extension statically into perl.wasm instead of as loadable
    # .so files. Without this, perl-cross leaves usedl=define with
    # dlsrc=dl_dlopen.xs even though d_dlopen is undef (below); it then emits
    # ~48 .so extensions whose DynaLoader load fails at runtime with "dlerror()
    # not implemented", breaking every XS module (List::Util, Scalar::Util,
    # Data::Dumper, POSIX, Fcntl, ...) and therefore most of CPAN. usedl=undef
    # switches dlsrc to dl_none.xs, folds the extensions into static_ext, and
    # links them into the interpreter — the same static-extension approach the
    # ruby package uses for ripper and io-wait.
    #
    # --disable-mod=re: the `re` pragma extension deliberately recompiles core
    # regex translation units (regcomp.c, regexec.c, ...) with PERL_EXT_RE_BUILD
    # to provide a debug/pluggable engine. As a loadable .so that is harmless,
    # but static-linking it (usedl=undef) beside libperl gives wasm-ld duplicate
    # definitions of Perl_reg_add_data and friends — perl 5.40's ext/re/re_top.h
    # does not rename every duplicated symbol, and wasm-ld rejects duplicate
    # object symbols where native ld silently takes the first archive
    # definition. perl-cross selects extensions with --disable-mod (it ignores
    # perl's own -Dnoextensions), so drop `re` here. The core regex engine
    # stays compiled in; only the optional `use re` pluggable-engine pragma is
    # unavailable.
    ./configure \
        --target=wasm32-unknown-none \
        --disable-mod=re \
        --prefix=/usr \
        --host-cc=clang \
        -Dosname=linux \
        -Dcc=wasm32posix-cc \
        -Dld=wasm32posix-cc \
        -Dar=wasm32posix-ar \
        -Dranlib=wasm32posix-ranlib \
        -Dnm=wasm32posix-nm \
        -Doptimize="-O2 -fno-strict-aliasing" \
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
        -Dusedl=undef \
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
        2>&1 | tee "$CONFIGURE_LOG" | tail -50

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

    # Stage static extensions' Perl-side .pm files. perl-cross builds each
    # static XS extension by running only MakeMaker's `static` target, which
    # produces the .a linked into perl.wasm but never runs `pm_to_blib` — so
    # under usedl=undef the extensions' .pm (List/Util.pm, POSIX.pm,
    # Data/Dumper.pm, ...) are never copied into lib/ and install.perl omits
    # them, leaving `Can't locate List/Util.pm in @INC` at runtime even though
    # the XS is compiled in. The dynamic-ext rule invokes the default target
    # (pure_all), which does run pm_to_blib; make the static rule do the same
    # so the .pm land in lib/ alongside the compiled-in XS.
    sed -i.bak2 \
        -e 's|LINKTYPE=static static$|LINKTYPE=static static pure_all|' \
        Makefile
fi

# --- Build ---
echo "==> Building Perl (this takes a while)..."
# `all` (not just `perl`) so the non-XS extension trees are assembled and their
# generated modules (XSLoader.pm etc.) exist for the stdlib install below; the
# `perl` target alone links the interpreter but leaves those ungenerated.
if ! make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" all > "$BUILD_LOG" 2>&1; then
    echo "==> 'make all' FAILED; last 160 lines:"
    tail -160 "$BUILD_LOG"
    exit 1
fi
tail -15 "$BUILD_LOG"

echo "==> Collecting binary..."
mkdir -p "$BIN_DIR"

if [ -f "$SRC_DIR/perl" ]; then
    cp "$SRC_DIR/perl" "$BIN_DIR/perl.wasm"
    SIZE=$(wc -c < "$BIN_DIR/perl.wasm" | tr -d ' ')
    echo "==> Built perl.wasm ($(echo "$SIZE" | numfmt --to=iec 2>/dev/null || echo "${SIZE} bytes"))"
else
    echo "ERROR: perl binary not found after build" >&2
    echo "==> Last 100 lines of build.log:"
    tail -100 "$BUILD_LOG"
    exit 1
fi

echo ""
echo "==> Perl $PERL_VERSION built successfully!"
echo "Binary: $BIN_DIR/perl.wasm"

# Install into local-binaries/ so the resolver picks the freshly-built
# binary over the fetched release.
source "$REPO_ROOT/scripts/install-local-binary.sh"
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    WASM_POSIX_INSTALL_LOCAL_MIRROR=0 \
        WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto \
        install_local_binary perl "$BIN_DIR/perl.wasm"
else
    WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto \
        install_local_binary perl "$SCRIPT_DIR/bin/perl.wasm"
fi

# --- Standard library runtime archive ---
# `make install.perl` copies the COMPLETE built standard library (generated .pm
# such as XSLoader.pm/Config.pm plus every core/dist/cpan/ext module in its
# final @INC layout) into a throwaway DESTDIR staging prefix — it never writes
# to the host system's /usr. Package the installed lib/perl5 as perl-runtime.zip
# so browser bundles and VFS images ship a real stdlib, the way cpython ships
# python-runtime.zip. (install.perl, not install: install.man needs
# cross-unfriendly ExtUtils config and ships nothing the runtime needs.)
echo "==> Installing the Perl standard library into a DESTDIR staging prefix..."
PERL_STAGE="$KANDELO_PACKAGE_WORK_DIR/install-stage"
rm -rf "$PERL_STAGE"
mkdir -p "$PERL_STAGE"
make install.perl DESTDIR="$PERL_STAGE" 2>&1 | tail -40

PERL_PRIVLIB_DIR="$PERL_STAGE/usr/lib/perl5/$PERL_VERSION"
[ -d "$PERL_PRIVLIB_DIR" ] || {
    echo "ERROR: installed Perl stdlib not found at $PERL_PRIVLIB_DIR" >&2
    exit 1
}
# XSLoader.pm is a generated, dual-life module that installs to the archlib
# (.../5.40.3/<archname>/), not the privlib — assert it landed somewhere under
# lib/perl5 so a broken install (missing generated files) fails loudly.
[ -n "$(find "$PERL_STAGE/usr/lib/perl5" -name XSLoader.pm -print -quit)" ] || {
    echo "ERROR: installed Perl stdlib is missing generated XSLoader.pm" >&2
    exit 1
}

RUNTIME_STAGE="$KANDELO_PACKAGE_WORK_DIR/perl-runtime-stage"
rm -rf "$RUNTIME_STAGE"
mkdir -p "$RUNTIME_STAGE/lib"
# Root the archive at lib/perl5 so consumers mount it at /usr/lib/perl5 — the
# interpreter's compiled-in @INC — and can self-locate every module.
cp -R "$PERL_STAGE/usr/lib/perl5" "$RUNTIME_STAGE/lib/perl5"
# Drop documentation from the runtime archive — .pod files and the pod/ tree
# are several MB and never loaded when running code.
find "$RUNTIME_STAGE/lib/perl5" -type d -name pod -prune -exec rm -rf {} + 2>/dev/null || true
find "$RUNTIME_STAGE/lib/perl5" -type f -name '*.pod' -delete 2>/dev/null || true
if [ -f "$SRC_DIR/Copying" ]; then
    mkdir -p "$RUNTIME_STAGE/share/licenses/perl"
    cp "$SRC_DIR/Copying" "$RUNTIME_STAGE/share/licenses/perl/Copying"
fi
PERL_RUNTIME_ZIP="$KANDELO_PACKAGE_WORK_DIR/perl-runtime.zip"
rm -f "$PERL_RUNTIME_ZIP"
bash "$REPO_ROOT/images/vfs/scripts/create-deterministic-zip.sh" \
    "$RUNTIME_STAGE" "$PERL_RUNTIME_ZIP"
echo "==> perl-runtime.zip: $(find "$RUNTIME_STAGE" -type f | wc -l | tr -d ' ') files"

if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    cp "$PERL_RUNTIME_ZIP" "$WASM_POSIX_DEP_OUT_DIR/perl-runtime.zip"
    echo "  installed $WASM_POSIX_DEP_OUT_DIR/perl-runtime.zip (resolver scratch)"
else
    install_local_runtime_file perl "$PERL_RUNTIME_ZIP"
fi
