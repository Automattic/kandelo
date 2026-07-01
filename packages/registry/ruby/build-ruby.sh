#!/usr/bin/env bash
set -euo pipefail

# Build Ruby 4.0.5 for wasm32-posix-kernel.
#
# Two-phase build:
#   1. Host-native miniruby (generates C source files during cross-compilation)
#   2. Cross-compile Ruby for wasm32 using the SDK toolchain
#
# Output: packages/registry/ruby/bin/ruby.wasm and ruby-runtime.zip
#
# Prerequisites:
#   - bash build.sh (kernel + sysroot)
#   - zlib built (auto-triggered if missing)
# The SDK toolchain is activated automatically via sdk/activate.sh below.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SRC_DIR="$SCRIPT_DIR/ruby-src"
SOURCE_MARKER="$SRC_DIR/.kandelo-ruby-version"
HOST_BUILD_DIR="$SCRIPT_DIR/ruby-host-build"
CROSS_BUILD_DIR="$SCRIPT_DIR/ruby-cross-build"
INSTALL_DIR="$SCRIPT_DIR/ruby-install"
BIN_DIR="$SCRIPT_DIR/bin"
RUNTIME_ZIP="$BIN_DIR/ruby-runtime.zip"
# Worktree-local SDK on PATH (no global npm link required).
# shellcheck source=/dev/null
source "$REPO_ROOT/sdk/activate.sh"
RUBY_VERSION="${WASM_POSIX_DEP_VERSION:-${RUBY_VERSION:-4.0.5}}"
RUBY_MAJOR_MINOR="$(echo "$RUBY_VERSION" | cut -d. -f1-2)"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://cache.ruby-lang.org/pub/ruby/${RUBY_MAJOR_MINOR}/ruby-${RUBY_VERSION}.tar.gz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-}"
PACKAGE_NAME="${WASM_POSIX_DEP_NAME:-ruby}"
# Explicit env wins; else the in-tree sysroot.
SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"

export WASM_POSIX_SYSROOT="$SYSROOT"

if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found after sourcing sdk/activate.sh." >&2
    exit 1
fi

if [ ! -f "$SYSROOT/lib/libc.a" ]; then
    echo "ERROR: sysroot not found. Run: bash build.sh" >&2
    exit 1
fi

if [ -d "$SRC_DIR" ] && [ "$(cat "$SOURCE_MARKER" 2>/dev/null || true)" != "$RUBY_VERSION" ]; then
    echo "==> Existing Ruby source is not $RUBY_VERSION; cleaning Ruby build directories..."
    rm -rf "$SRC_DIR" "$HOST_BUILD_DIR" "$CROSS_BUILD_DIR" "$INSTALL_DIR" "$BIN_DIR"
fi

if [ -x "$HOST_BUILD_DIR/miniruby" ]; then
    HOST_RUBY_VERSION="$("$HOST_BUILD_DIR/miniruby" -e 'print RUBY_VERSION' 2>/dev/null || true)"
    if [ "$HOST_RUBY_VERSION" != "$RUBY_VERSION" ]; then
        echo "==> Existing host miniruby is $HOST_RUBY_VERSION, expected $RUBY_VERSION; rebuilding..."
        rm -rf "$HOST_BUILD_DIR"
    fi
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

# Build libyaml if not already built (Ruby needs it for psych/YAML)
LIBYAML_DIR="$SCRIPT_DIR/libyaml-install"
if [ ! -f "$LIBYAML_DIR/lib/libyaml.a" ]; then
    echo "==> Building libyaml for wasm32..."
    LIBYAML_VERSION="0.2.5"
    LIBYAML_SHA256="c642ae9b75fee120b2d96c712538bd2cf283228d2337df2cf2988e3c02678ef4"
    LIBYAML_SRC="$SCRIPT_DIR/libyaml-src"
    if [ ! -d "$LIBYAML_SRC" ]; then
        curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors -fsSL "https://pyyaml.org/download/libyaml/yaml-${LIBYAML_VERSION}.tar.gz" \
            -o "/tmp/yaml-${LIBYAML_VERSION}.tar.gz"
        echo "$LIBYAML_SHA256  /tmp/yaml-${LIBYAML_VERSION}.tar.gz" | shasum -a 256 -c -
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
mkdir -p "$SYSROOT/lib/pkgconfig"
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
    curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors -fsSL "$SOURCE_URL" -o "/tmp/${TARBALL}"
    if [ -n "$SOURCE_SHA256" ]; then
        echo "==> Verifying source sha256..."
        echo "$SOURCE_SHA256  /tmp/${TARBALL}" | shasum -a 256 -c -
    fi
    mkdir -p "$SRC_DIR"
    tar xzf "/tmp/${TARBALL}" -C "$SRC_DIR" --strip-components=1
    rm "/tmp/${TARBALL}"
    printf '%s\n' "$RUBY_VERSION" > "$SOURCE_MARKER"
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

# Ruby's fork path takes a fork lock even when configured with --with-thread=none.
# In the single-threaded thread_none backend these hooks must be no-ops.
if ! grep -q 'rb_thread_acquire_fork_lock' "$SRC_DIR/thread_none.c"; then
    echo "==> Patching thread_none.c: adding fork lock no-op stubs..."
    perl -0pi -e 's/\nvoid\nrb_thread_sched_init/\nvoid\nrb_thread_acquire_fork_lock(void)\n{\n}\n\nvoid\nrb_thread_release_fork_lock(void)\n{\n}\n\nvoid\nrb_thread_reset_fork_lock(void)\n{\n}\n\nvoid\nrb_thread_sched_init/' "$SRC_DIR/thread_none.c"
fi

# wasm/machine.c: missing <stdint.h> for uint8_t
if ! grep -q '#include <stdint.h>' "$SRC_DIR/wasm/machine.c"; then
    echo "==> Patching wasm/machine.c: adding #include <stdint.h>..."
    sed -i.bak '1i\
#include <stdint.h>' "$SRC_DIR/wasm/machine.c"
    rm -f "$SRC_DIR/wasm/machine.c.bak"
fi

# Ruby's ivar inline caches pack shape id + attr index into uint64_t fields
# inside GC-managed objects that are only VALUE-aligned on wasm32. Wasm allows
# ordinary unaligned loads/stores, but 64-bit atomics trap unless the address is
# 8-byte aligned. Use Ruby's non-atomic fallback semantics for this cache on
# Kandelo and load/store bytewise so the compiler cannot reintroduce an
# alignment-sensitive atomic access.
if ! grep -q 'Kandelo avoids unaligned 64-bit wasm atomics' "$SRC_DIR/ruby_atomic.h"; then
    echo "==> Patching ruby_atomic.h: avoid unaligned 64-bit wasm atomics..."
    python3 - "$SRC_DIR/ruby_atomic.h" <<'PY'
import sys

path = sys.argv[1]
content = open(path, "r", encoding="utf-8").read()

load_old = """#if defined(HAVE_GCC_ATOMIC_BUILTINS_64)
    return __atomic_load_n(value, __ATOMIC_RELAXED);
"""
load_new = """#if defined(RUBY_KANDELO_POSIX)
    /* Kandelo avoids unaligned 64-bit wasm atomics for Ruby inline caches. */
    uint64_t val = 0;
    const volatile unsigned char *bytes = (const volatile unsigned char *)value;
    for (unsigned int i = 0; i < sizeof(val); i++) {
        val |= ((uint64_t)bytes[i]) << (i * 8);
    }
    return val;
#elif defined(HAVE_GCC_ATOMIC_BUILTINS_64)
    return __atomic_load_n(value, __ATOMIC_RELAXED);
"""
store_old = """#if defined(HAVE_GCC_ATOMIC_BUILTINS_64)
    __atomic_store_n(address, value, __ATOMIC_RELAXED);
"""
store_new = """#if defined(RUBY_KANDELO_POSIX)
    /* Kandelo avoids unaligned 64-bit wasm atomics for Ruby inline caches. */
    volatile unsigned char *bytes = (volatile unsigned char *)address;
    for (unsigned int i = 0; i < sizeof(value); i++) {
        bytes[i] = (unsigned char)(value >> (i * 8));
    }
#elif defined(HAVE_GCC_ATOMIC_BUILTINS_64)
    __atomic_store_n(address, value, __ATOMIC_RELAXED);
"""

if load_old not in content:
    raise SystemExit("ruby_atomic.h load pattern not found")
if store_old not in content:
    raise SystemExit("ruby_atomic.h store pattern not found")

content = content.replace(load_old, load_new, 1)
content = content.replace(store_old, store_new, 1)
open(path, "w", encoding="utf-8").write(content)
PY
fi

# Ruby's generic non-Emscripten wasm path assumes its own Asyncify runtime
# imports. Kandelo uses the normal SDK/libc runtime instead, so keep wasm-only
# sizing/platform decisions but route setjmp, VM exception handling, stack
# scanning, and entrypoint startup through the libc/POSIX path.
if ! grep -q 'RUBY_KANDELO_POSIX' "$SRC_DIR/gc.c"; then
    echo "==> Patching Ruby wasm runtime guards for Kandelo POSIX..."
fi
for file in main.c gc.c eval_intern.h include/ruby/ruby.h vm_core.h vm.c; do
    perl -0pi -e 's/defined\(__wasm__\) && !defined\(__EMSCRIPTEN__\)(?: && !defined\(RUBY_KANDELO_POSIX\))*/defined(__wasm__) && !defined(__EMSCRIPTEN__) && !defined(RUBY_KANDELO_POSIX)/g' "$SRC_DIR/$file"
done
perl -0pi -e 's/^#if defined\(__wasm__\)$/#if defined(__wasm__) && !defined(RUBY_KANDELO_POSIX)/mg' "$SRC_DIR/gc.c"
perl -0pi -e 's/^#elif defined\(__wasm__\)$/#elif defined(__wasm__) && !defined(RUBY_KANDELO_POSIX)/mg' "$SRC_DIR/gc.c"

if ! grep -q 'Kandelo initializes Ruby stack roots' "$SRC_DIR/thread_none.c"; then
    echo "==> Patching thread_none.c: Kandelo stack base without Ruby wasm runtime..."
    perl -0pi -e 's/\n#if defined\(RUBY_KANDELO_POSIX\)\nstatic volatile VALUE \*ruby_kandelo_stack_start;\n#endif\n/\n/g' "$SRC_DIR/thread_none.c"
    perl -0pi -e 's/#if defined\(__wasm__\) && !defined\(__EMSCRIPTEN__\)(?: && !defined\(RUBY_KANDELO_POSIX\))?\n# include "wasm\/machine\.h"\n#endif/#if defined(__wasm__) \&\& !defined(__EMSCRIPTEN__) \&\& !defined(RUBY_KANDELO_POSIX)\n# include "wasm\/machine.h"\n#endif/' "$SRC_DIR/thread_none.c"
    perl -0pi -e 's/#if defined\(RUBY_KANDELO_POSIX\)\n    th->ec->machine.stack_start = \(VALUE \*\)ruby_kandelo_stack_start;\n#elif defined\(__wasm__\) && !defined\(__EMSCRIPTEN__\)\n    th->ec->machine.stack_start = \(VALUE \*\)rb_wasm_stack_get_base\(\);\n#endif/#if defined(RUBY_KANDELO_POSIX)\n    \/* Kandelo initializes Ruby stack roots from RUBY_INIT_STACK. *\/\n    th->ec->machine.stack_start = (VALUE *)local_in_parent_frame;\n    th->ec->machine.stack_maxsize = 0;\n#elif defined(__wasm__) \&\& !defined(__EMSCRIPTEN__)\n    th->ec->machine.stack_start = (VALUE *)rb_wasm_stack_get_base();\n#endif/' "$SRC_DIR/thread_none.c"
    perl -0pi -e 's/#if defined\(__wasm__\) && !defined\(__EMSCRIPTEN__\)\n    th->ec->machine.stack_start = \(VALUE \*\)rb_wasm_stack_get_base\(\);\n#endif/#if defined(RUBY_KANDELO_POSIX)\n    \/* Kandelo initializes Ruby stack roots from RUBY_INIT_STACK. *\/\n    th->ec->machine.stack_start = (VALUE *)local_in_parent_frame;\n    th->ec->machine.stack_maxsize = 0;\n#elif defined(__wasm__) \&\& !defined(__EMSCRIPTEN__)\n    th->ec->machine.stack_start = (VALUE *)rb_wasm_stack_get_base();\n#endif/' "$SRC_DIR/thread_none.c"
fi
if ! grep -q 'Kandelo initializes pthread Ruby stack roots' "$SRC_DIR/thread_pthread.c"; then
    echo "==> Patching thread_pthread.c: Kandelo stack base without nonportable pthread stack APIs..."
    perl -0pi -e 's/#else\n        rb_raise\(rb_eNotImpError, "ruby engine can initialize only in the main thread"\);\n#endif/#elif defined(RUBY_KANDELO_POSIX)\n        \/* Kandelo initializes pthread Ruby stack roots from the native thread frame. *\/\n        th->ec->machine.stack_start = (VALUE *)local_in_parent_frame;\n        th->ec->machine.stack_maxsize = 0;\n#else\n        rb_raise(rb_eNotImpError, "ruby engine can initialize only in the main thread");\n#endif/' "$SRC_DIR/thread_pthread.c"
fi

if ! grep -q 'Kandelo cross build has rb_reg_onig_match' "$SRC_DIR/ext/strscan/strscan.c"; then
    echo "==> Patching strscan.c: avoid strict-prototype mkmf false negative..."
    perl -0pi -e 's|/\* rb_reg_onig_match is available in Ruby 3\.3 and later\. \*/|/* rb_reg_onig_match is available in Ruby 3.3 and later. */\n#if defined(RUBY_KANDELO_POSIX) \&\& !defined(HAVE_RB_REG_ONIG_MATCH)\n/* Kandelo cross build has rb_reg_onig_match; mkmf probes it with a conflicting prototype. */\n# define HAVE_RB_REG_ONIG_MATCH 1\n#endif|' "$SRC_DIR/ext/strscan/strscan.c"
fi

if ! grep -q 'Kandelo cross build has json parser Ruby APIs' "$SRC_DIR/ext/json/parser/parser.c"; then
    echo "==> Patching json/parser.c: avoid strict-prototype mkmf false negatives..."
    perl -0pi -e 's|#include "\.\./json\.h"|#include "../json.h"\n#if defined(RUBY_KANDELO_POSIX)\n/* Kandelo cross build has json parser Ruby APIs; mkmf probes them with conflicting prototypes. */\n# if !defined(HAVE_RB_HASH_BULK_INSERT)\n#  define HAVE_RB_HASH_BULK_INSERT 1\n# endif\n# if !defined(HAVE_RB_STR_TO_INTERNED_STR)\n#  define HAVE_RB_STR_TO_INTERNED_STR 1\n# endif\n#endif\n/* Kandelo cross build has json parser Ruby APIs. */|' "$SRC_DIR/ext/json/parser/parser.c"
fi

if grep -q 'Kandelo wasm32-posix socket dependencies' "$SRC_DIR/ext/socket/extconf.rb" && grep -q 'HAVE_GETPEEREID' "$SRC_DIR/ext/socket/extconf.rb"; then
    echo "==> Repairing socket extconf Kandelo branch: avoid unavailable getpeereid..."
    perl -0pi -e 's/\n    -DHAVE_GETPEEREID=1//' "$SRC_DIR/ext/socket/extconf.rb"
fi
if ! grep -q 'Kandelo wasm32-posix socket dependencies' "$SRC_DIR/ext/socket/extconf.rb"; then
    echo "==> Patching socket extconf: avoid link-based mkmf false negatives..."
    SOCKET_EXTCONF_TMP="$(mktemp)"
    awk '
      BEGIN { inserted = 0 }
      $0 == "require '\''mkmf'\''" && inserted == 0 {
        print
        print ""
        print "if ENV[\"WASM_POSIX_CROSS_COMPILE\"] == \"1\""
        print "  # Kandelo wasm32-posix socket dependencies are available in the sysroot,"
        print "  # but link-based mkmf probes can fail on duplicate static libc glue."
        print "  $INCFLAGS << \" -I$(topdir) -I$(top_srcdir)\""
        print "  $defs.concat %w["
        print "    -DHAVE_SYS_UIO_H=1"
        print "    -DHAVE_NETINET_TCP_H=1"
        print "    -DHAVE_NETINET_UDP_H=1"
        print "    -DHAVE_ARPA_INET_H=1"
        print "    -DHAVE_IFADDRS_H=1"
        print "    -DHAVE_SYS_IOCTL_H=1"
        print "    -DHAVE_NET_IF_H=1"
        print "    -DHAVE_SYS_PARAM_H=1"
        print "    -DHAVE_SYS_UN_H=1"
        print "    -DHAVE_TYPE_SOCKLEN_T=1"
        print "    -DHAVE_TYPE_STRUCT_SOCKADDR_UN=1"
        print "    -DHAVE_TYPE_STRUCT_SOCKADDR_STORAGE=1"
        print "    -DHAVE_TYPE_STRUCT_ADDRINFO=1"
        print "    -DHAVE_TYPE_STRUCT_IN_PKTINFO=1"
        print "    -DHAVE_STRUCT_IN_PKTINFO_IPI_SPEC_DST=1"
        print "    -DHAVE_TYPE_STRUCT_IN6_PKTINFO=1"
        print "    -DHAVE_TYPE_STRUCT_IP_MREQ=1"
        print "    -DHAVE_TYPE_STRUCT_IP_MREQN=1"
        print "    -DHAVE_TYPE_STRUCT_IPV6_MREQ=1"
        print "    -DHAVE_TYPE_STRUCT_TCP_INFO=1"
        print "    -DHAVE_SENDMSG=1"
        print "    -DHAVE_RECVMSG=1"
        print "    -DHAVE_FREEADDRINFO=1"
        print "    -DHAVE_GAI_STRERROR=1"
        print "    -DGAI_STRERROR_CONST=1"
        print "    -DHAVE_ACCEPT4=1"
        print "    -DHAVE_INET_NTOP=1"
        print "    -DHAVE_INET_PTON=1"
        print "    -DHAVE_GETSERVBYPORT=1"
        print "    -DHAVE_GETIFADDRS=1"
        print "    -DHAVE_IF_INDEXTONAME=1"
        print "    -DHAVE_IF_NAMETOINDEX=1"
        print "    -DHAVE_SOCKETPAIR=1"
        print "    -DHAVE_GETHOSTNAME=1"
        print "    -DHAVE_GETNAMEINFO=1"
        print "    -DHAVE_GETADDRINFO=1"
        print "    -DENABLE_IPV6=1"
        print "    -DINET6=1"
        print "    -DRSTRING_SOCKLEN=(socklen_t)RSTRING_LEN"
        print "  ]"
        print "  $objs = %w["
        print "    init constants basicsocket socket ipsocket tcpsocket tcpserver sockssocket"
        print "    udpsocket unixsocket unixserver option ancdata raddrinfo ifaddr"
        print "  ].map { |obj| \"#{obj}.#{$OBJEXT}\" }"
        print "  $distcleanfiles << \"constants.h\" << \"constdefs.*\""
        print "  $VPATH << '\''$(topdir)'\'' << '\''$(top_srcdir)'\''"
        print "  create_makefile(\"socket\")"
        print "else"
        inserted = 1
        next
      }
      { print }
      END {
        if (inserted == 1) {
          print ""
          print "end"
        }
      }
    ' "$SRC_DIR/ext/socket/extconf.rb" > "$SOCKET_EXTCONF_TMP"
    mv "$SOCKET_EXTCONF_TMP" "$SRC_DIR/ext/socket/extconf.rb"
fi
if grep -q 'Kandelo wasm32-posix socket dependencies' "$SRC_DIR/ext/socket/extconf.rb" && ! grep -q 'HAVE_NETPACKET_PACKET_H' "$SRC_DIR/ext/socket/extconf.rb"; then
    echo "==> Repairing socket extconf Kandelo branch: add packet socket headers..."
    perl -0pi -e 's/(\n    -DHAVE_ARPA_INET_H=1\n)/$1    -DHAVE_NETPACKET_PACKET_H=1\n    -DHAVE_NET_ETHERNET_H=1\n/' "$SRC_DIR/ext/socket/extconf.rb"
fi

if ! grep -q 'Kandelo wasm32-posix uses Unix98 PTY APIs' "$SRC_DIR/ext/pty/extconf.rb"; then
    echo "==> Patching pty extconf: force Unix98 PTY probes for Kandelo cross builds..."
    perl -0pi -e 's|require '\''mkmf'\''|require '\''mkmf'\''\n\nif ENV["WASM_POSIX_CROSS_COMPILE"] == "1"\n  # Kandelo wasm32-posix uses Unix98 PTY APIs; mkmf cannot infer these\n  # reliably while cross-compiling and otherwise falls through to _getpty.\n  have_header("termios.h")\n  have_header("sys/ioctl.h")\n  \$defs << "-DHAVE_POSIX_OPENPT=1"\n  \$defs << "-DHAVE_PTSNAME_R=1"\n  \$defs << "-DHAVE_SETSID=1"\n  \$defs << "-DHAVE_UNISTD_H=1"\n  create_makefile("pty")\nelse|' "$SRC_DIR/ext/pty/extconf.rb"
    printf '\nend\n' >> "$SRC_DIR/ext/pty/extconf.rb"
elif grep -q '^[[:space:]]*<< "-DHAVE_POSIX_OPENPT=1"' "$SRC_DIR/ext/pty/extconf.rb"; then
    echo "==> Repairing pty extconf Kandelo probe definitions..."
    perl -0pi -e 's/^[[:space:]]*<< "-DHAVE_POSIX_OPENPT=1"/  \$defs << "-DHAVE_POSIX_OPENPT=1"/mg; s/^[[:space:]]*<< "-DHAVE_PTSNAME_R=1"/  \$defs << "-DHAVE_PTSNAME_R=1"/mg' "$SRC_DIR/ext/pty/extconf.rb"
elif grep -q 'create_makefile("pty")' "$SRC_DIR/ext/pty/extconf.rb" && grep -q '^[[:space:]]*exit$' "$SRC_DIR/ext/pty/extconf.rb"; then
    echo "==> Repairing pty extconf Kandelo branch: avoid SystemExit dummy makefile..."
    perl -0pi -e 's/^\s*exit\nend\n\n\$INCFLAGS/else\n\n\$INCFLAGS/m' "$SRC_DIR/ext/pty/extconf.rb"
    printf '\nend\n' >> "$SRC_DIR/ext/pty/extconf.rb"
fi
if grep -q 'Kandelo wasm32-posix uses Unix98 PTY APIs' "$SRC_DIR/ext/pty/extconf.rb" && ! grep -q 'HAVE_SETSID' "$SRC_DIR/ext/pty/extconf.rb"; then
    echo "==> Repairing pty extconf Kandelo branch: add session/unistd definitions..."
    perl -0pi -e 's/(\$defs << "-DHAVE_PTSNAME_R=1"\n)/$1  \$defs << "-DHAVE_SETSID=1"\n  \$defs << "-DHAVE_UNISTD_H=1"\n/' "$SRC_DIR/ext/pty/extconf.rb"
fi
if grep -q 'Kandelo wasm32-posix uses Unix98 PTY APIs' "$SRC_DIR/ext/pty/extconf.rb"; then
    echo "==> Repairing pty extconf Kandelo branch: add Ruby internal include path..."
    perl -0pi -e 's/(\$defs << "-DHAVE_UNISTD_H=1"\n)(?!  \$INCFLAGS << " -I\$\((?:topdir|top_srcdir)\))/$1  \$INCFLAGS << " -I\$(topdir) -I\$(top_srcdir)"\n/' "$SRC_DIR/ext/pty/extconf.rb"
fi

if ! grep -q 'Kandelo wasm32-posix has io/console dependencies' "$SRC_DIR/ext/io/console/extconf.rb"; then
    echo "==> Patching io/console extconf: avoid link-based mkmf false negatives..."
    perl -0pi -e 's|require '\''mkmf'\''|require '\''mkmf'\''\n\nif ENV["WASM_POSIX_CROSS_COMPILE"] == "1"\n  # Kandelo wasm32-posix has io/console dependencies in the sysroot and Ruby\n  # static core, but link-based mkmf probes can fail on duplicate libc glue.\n  have_header("termios.h")\n  have_header("sys/ioctl.h")\n  \$defs << "-DHAVE_RB_SYSERR_FAIL_STR=1"\n  \$defs << "-DHAVE_RB_INTERNED_STR_CSTR=1"\n  \$defs << "-DHAVE_RB_IO_PATH=1"\n  \$defs << "-DHAVE_RB_IO_DESCRIPTOR=1"\n  \$defs << "-DHAVE_RB_IO_GET_WRITE_IO=1"\n  \$defs << "-DHAVE_RB_IO_CLOSED_P=1"\n  \$defs << "-DHAVE_RB_IO_OPEN_DESCRIPTOR=1"\n  \$defs << "-DHAVE_RB_RACTOR_LOCAL_STORAGE_VALUE_NEWKEY=1"\n  \$defs << "-DHAVE_CFMAKERAW=1"\n  \$defs << "-DHAVE_TTYNAME_R=1"\n  create_makefile("io/console")\nelse|' "$SRC_DIR/ext/io/console/extconf.rb"
    printf '\nend\n' >> "$SRC_DIR/ext/io/console/extconf.rb"
fi

for uri_common in \
    "$SRC_DIR/lib/uri/common.rb" \
    "$SRC_DIR/lib/rubygems/vendor/uri/lib/uri/common.rb" \
    "$SRC_DIR/lib/bundler/vendor/uri/lib/uri/common.rb"; do
    if [ -f "$uri_common" ] && ! grep -q 'Kandelo avoids URI unary fstrings' "$uri_common"; then
        echo "==> Patching ${uri_common#$SRC_DIR/}: avoid Ruby 4 wasm fstring crash in URI tables..."
        perl -0pi -e 's|TBLENCWWWCOMP_ = \{\} # :nodoc:|TBLENCWWWCOMP_ = {} # :nodoc:\n  # Kandelo avoids URI unary fstrings here because Ruby 4.0 wasm builds can mis-handle\n  # byte strings generated after the parser/scheme setup above.|' "$uri_common"
        perl -0pi -e "s|TBLENCWWWCOMP_\\[-i\\.chr\\] = -\\('%%%02X' % i\\)|TBLENCWWWCOMP_[i.chr.freeze] = ('%%%02X' % i).freeze|" "$uri_common"
        perl -0pi -e "s|TBLDECWWWCOMP_\\[-\\('%%%X%X' % \\[h, l\\]\\)\\] = -i\\.chr|TBLDECWWWCOMP_[('%%%X%X' % [h, l]).freeze] = i.chr.freeze|" "$uri_common"
        perl -0pi -e "s|TBLDECWWWCOMP_\\[-\\('%%%x%X' % \\[h, l\\]\\)\\] = -i\\.chr|TBLDECWWWCOMP_[('%%%x%X' % [h, l]).freeze] = i.chr.freeze|" "$uri_common"
        perl -0pi -e "s|TBLDECWWWCOMP_\\[-\\('%%%X%x' % \\[h, l\\]\\)\\] = -i\\.chr|TBLDECWWWCOMP_[('%%%X%x' % [h, l]).freeze] = i.chr.freeze|" "$uri_common"
        perl -0pi -e "s|TBLDECWWWCOMP_\\[-\\('%%%x%x' % \\[h, l\\]\\)\\] = -i\\.chr|TBLDECWWWCOMP_[('%%%x%x' % [h, l]).freeze] = i.chr.freeze|" "$uri_common"
    fi
done

KANDELO_COROUTINE_DIR="$SRC_DIR/coroutine/kandelo"
mkdir -p "$KANDELO_COROUTINE_DIR"
cat > "$KANDELO_COROUTINE_DIR/Context.h" <<'COROEOF'
#ifndef COROUTINE_KANDELO_CONTEXT_H
#define COROUTINE_KANDELO_CONTEXT_H 1

#include <errno.h>
#include <stddef.h>

#define COROUTINE __attribute__((noreturn)) void
#define COROUTINE_LIMITED_ADDRESS_SPACE

struct coroutine_context;
typedef COROUTINE(* coroutine_start)(struct coroutine_context *from, struct coroutine_context *self);

struct coroutine_context {
    coroutine_start start;
    void *argument;
};

static inline void
coroutine_initialize_main(struct coroutine_context *context)
{
    context->start = NULL;
    context->argument = NULL;
}

static inline void
coroutine_initialize(
    struct coroutine_context *context,
    coroutine_start start,
    void *stack,
    size_t size
) {
    (void)stack;
    (void)size;
    context->start = start;
    context->argument = NULL;
}

static inline struct coroutine_context *
coroutine_transfer(struct coroutine_context *current, struct coroutine_context *target)
{
    (void)current;
    (void)target;
    errno = ENOSYS;
    return NULL;
}

static inline void
coroutine_destroy(struct coroutine_context *context)
{
    context->start = NULL;
    context->argument = NULL;
}

#endif /* COROUTINE_KANDELO_CONTEXT_H */
COROEOF

cat > "$KANDELO_COROUTINE_DIR/Context.c" <<'COROEOF'
#include "Context.h"

int ruby_kandelo_coroutine_backend;
COROEOF

if ! grep -q 'kandelo_require_libraries_state' "$SRC_DIR/ruby.c"; then
    echo "==> Patching ruby.c: keeping command-line -r preload roots visible..."
    patch -d "$SRC_DIR" -p1 < "$SCRIPT_DIR/patches/kandelo-require-libraries-roots.patch"
fi

reject_asyncify_coroutine() {
    if [ -f Makefile ] && grep -Eq '^(COROUTINE_TYPE = asyncify|COROUTINE_H = coroutine/asyncify/Context\.h)$|wasm/(setjmp|fiber|runtime|machine)|--asyncify|asyncify_' Makefile; then
        cat >&2 <<'EOF'
ERROR: Ruby selected upstream WASI Asyncify build inputs.
Kandelo packages must use Kandelo libc setjmp/SJLJ and wasm-fork-instrument,
not Ruby's legacy wasm/asyncify coroutine, setjmp, or POSTLINK path.
EOF
        exit 1
    fi
}

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
rm -rf "$CROSS_BUILD_DIR" "$INSTALL_DIR" "$BIN_DIR"
mkdir -p "$CROSS_BUILD_DIR"
cd "$CROSS_BUILD_DIR"
BASERUBY_WRAPPER="$CROSS_BUILD_DIR/kandelo-baseruby"
cat > "$BASERUBY_WRAPPER" <<EOF
#!/usr/bin/env bash
exec "$HOST_MINIRUBY" -I"$CROSS_BUILD_DIR" -I"$SRC_DIR/lib" --disable=gems "\$@"
EOF
chmod +x "$BASERUBY_WRAPPER"
cat > "$CROSS_BUILD_DIR/rbconfig.rb" <<'RBCONFIG_EOF'
module RbConfig
  CONFIG = {"EXECUTABLE_EXTS" => ""}
end
RBCONFIG_EOF

if [ ! -f Makefile ]; then
    # Create config.site with cross-compilation overrides
    CONFIG_SITE="$CROSS_BUILD_DIR/config.site-wasm32-posix"
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
ac_cv_func_select_large_fdset=no
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

# ─── Pthread and functions we DON'T have ────────────────────────────
# Kandelo implements pthread_create via clone() and host thread workers.
# Keep higher-level pthread feature probes conservative, but use Ruby's real
# pthread backend instead of thread_none so Thread.new and Process.detach work.
ac_cv_func_pthread_create=yes
ac_cv_func_pthread_attr_setinheritsched=yes
ac_cv_func_pthread_attr_init=yes
ac_cv_func_pthread_condattr_setclock=no
ac_cv_func_pthread_getcpuclockid=no
ac_cv_func_pthread_setname_np=no
ac_cv_func_pthread_set_name_np=no
ac_cv_func_pthread_getattr_np=no
ac_cv_func_pthread_attr_get_np=no
ac_cv_func_pthread_attr_getstack=no
ac_cv_func_pthread_get_stackaddr_np=no
ac_cv_func_pthread_get_stacksize_np=no
ac_cv_func_thr_stksegment=no
ac_cv_func_pthread_stackseg_np=no
ac_cv_func_pthread_getthrds_np=no
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
rb_cv_stack_grow_dir_wasm32=-1
rb_cv_stack_grow_direction=-1
ac_cv_func_getpgrp_void=yes
ac_cv_func_setpgrp_void=yes

# ─── Compiler features (can't link-test in cross-compilation) ─────
rb_cv_function_name_string=__func__
SITE_EOF

    echo "==> Created config.site: $CONFIG_SITE"

    # Configure as Kandelo's wasm32-posix host, not upstream WASI. Ruby's
    # wasi target wires in wasm/asyncify setjmp/fiber sources and a POSTLINK
    # asyncify transform; Kandelo uses libc's wasm SJLJ lowering, the
    # local-root-spill pass, and explicit wasm-fork-instrument below.
    # Prism remains available explicitly, but its Ruby 4 compiler path traps on
    # Kandelo wasm32-posix while compiling Psych::Visitors::ToRuby.
    # Ruby parser/compiler paths are stack-heavy, and local-root spilling
    # adds small linear-stack frames to preserve VALUE visibility for GC.
    CONFIG_SITE="$CONFIG_SITE" \
    CC=wasm32posix-cc \
    LD=wasm32posix-cc \
    AR=wasm32posix-ar \
    RANLIB=wasm32posix-ranlib \
    NM=wasm32posix-nm \
    STRIP=wasm32posix-strip \
    PKG_CONFIG=wasm32posix-pkg-config \
    PKG_CONFIG_PATH="$SYSROOT/lib/pkgconfig:$ZLIB_PREFIX/lib/pkgconfig" \
    BASERUBY="$BASERUBY_WRAPPER" \
    WASM_POSIX_CROSS_COMPILE=1 \
    CFLAGS="-O2" \
    CPPFLAGS="-DRUBY_KANDELO_POSIX=1 -I$SYSROOT/include -I$ZLIB_PREFIX/include" \
    LDFLAGS="-L$SYSROOT/lib -L$ZLIB_PREFIX/lib -Wl,-z,stack-size=1048576" \
    "$SRC_DIR/configure" \
        --host=wasm32-unknown-none \
        --build="$(uname -m)-apple-darwin" \
        --prefix="/usr" \
        --with-baseruby="$BASERUBY_WRAPPER" \
        --with-thread=pthread \
        --with-coroutine=kandelo \
        --with-parser=parse.y \
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
        --with-ext=stringio,zlib,monitor,psych,digest,digest/md5,digest/sha1,digest/sha2,json,json/parser,json/generator,strscan,date,etc,fcntl,io/console,pty,socket,continuation \
        --with-out-ext=openssl,fiddle,readline,syslog,nkf,bigdecimal \
        2>&1 | tail -50

    echo "==> Configure complete."

    reject_asyncify_coroutine

    if [ -f Makefile ]; then
        echo "==> Ensuring Ruby generated POSTLINK is disabled (root-spill/fork instrumentation run explicitly after make)..."
        perl -0pi -e 's/^POSTLINK\s*=.*$/POSTLINK = :/mg' Makefile
    fi

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

content = re.sub(
    r'^#define STACK_GROW_DIRECTION\b.*$',
    '#define STACK_GROW_DIRECTION -1',
    content,
    flags=re.MULTILINE,
)

# Force-disable functions/features not available in wasm32-posix
disable = {
    'HAVE_DLOPEN', 'HAVE_DYNAMIC_LOADING',
    'HAVE_PTHREAD_CONDATTR_SETCLOCK', 'HAVE_PTHREAD_GETCPUCLOCKID',
    'HAVE_PTHREAD_SETNAME_NP', 'HAVE_PTHREAD_SET_NAME_NP',
    'HAVE_PTHREAD_GETATTR_NP',
    'HAVE_PTHREAD_ATTR_GET_NP', 'HAVE_PTHREAD_ATTR_GETSTACK',
    'HAVE_PTHREAD_GET_STACKADDR_NP', 'HAVE_PTHREAD_GET_STACKSIZE_NP',
    'HAVE_THR_STKSEGMENT', 'HAVE_PTHREAD_STACKSEG_NP',
    'HAVE_PTHREAD_GETTHRDS_NP', 'HAVE_PTHREAD_NP_H',
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

content = re.sub(
    r'^#define SET_CURRENT_THREAD_NAME\\(name\\)\\b.*$',
    '/* #undef SET_CURRENT_THREAD_NAME */',
    content,
    flags=re.MULTILINE,
)
content = re.sub(
    r'^#define SET_ANOTHER_THREAD_NAME\\(thid,name\\)\\b.*$',
    '/* #undef SET_ANOTHER_THREAD_NAME */',
    content,
    flags=re.MULTILINE,
)

with open('$CONFIG_H', 'w') as f:
    f.write(content)
print(f'Disabled {disabled} HAVE_* defines in $CONFIG_H')
"
    fi
fi

reject_asyncify_coroutine

if [ -f Makefile ]; then
    echo "==> Patching Ruby static archive rule for generated extension initializers..."
    perl -0pi -e 's/^(CPPFLAGS = )(?!.*RUBY_KANDELO_POSIX)/$1-DRUBY_KANDELO_POSIX=1 /m' Makefile
    perl -0pi -e 's/^\t\t\$\(Q\).*ARFLAGS.*LIBRUBY_A_OBJS.*$/\t\t\$(Q) \$(AR) \$(ARFLAGS) \$@ \$(LIBRUBY_A_OBJS)/m' Makefile
    rm -f libruby-static.a
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
export WASM_POSIX_CROSS_COMPILE=1
RUBY_MAKE_ARGS=(
    -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)"
)
make "${RUBY_MAKE_ARGS[@]}" 2>&1 || {
    echo "ERROR: full Ruby build failed; refusing to publish miniruby as ruby.wasm." >&2
    exit 1
}

if [ ! -f exts.mk ]; then
    echo "ERROR: Ruby extension makefile was not generated" >&2
    exit 1
fi

STATIC_EXTINITS="continuation date_core digest digest/md5 digest/sha1 digest/sha2 etc fcntl io/console json/ext/generator json/ext/parser monitor psych pty socket stringio strscan zlib"
STATIC_EXTOBJS="ext/extinit.o ext/continuation/continuation.a ext/date/date_core.a ext/digest/digest.a ext/digest/md5/md5.a ext/digest/sha1/sha1.a ext/digest/sha2/sha2.a ext/etc/etc.a ext/fcntl/fcntl.a ext/io/console/console.a ext/json/generator/generator.a ext/json/parser/parser.a ext/monitor/monitor.a ext/psych/psych.a ext/pty/pty.a ext/socket/socket.a ext/stringio/stringio.a ext/strscan/strscan.a ext/zlib/zlib.a"
STATIC_ENCOBJS="enc/encinit.o enc/libenc.a enc/libtrans.a"
STATIC_EXTLIBS="-lyaml -lz"
STATIC_LINK_PATHS="-L. -L$SYSROOT/lib -L$ZLIB_PREFIX/lib"
FINAL_RUBY_LDFLAGS="$STATIC_LINK_PATHS -Wl,-z,stack-size=1048576"

echo "==> Relinking Ruby with static extensions and encodings..."
make -f exts.mk \
    libdir="/usr/lib" \
    LIBRUBY_EXTS=./.libruby-with-ext.time \
    "EXTENCS=$STATIC_ENCOBJS" \
    "BASERUBY=$BASERUBY_WRAPPER" \
    "MINIRUBY=$BASERUBY_WRAPPER -I. -rwasm32-none-fake" \
    static

# Ruby's generated LDFLAGS include CFLAGS. Passing those compile flags through
# the final wasm32 link produces a smaller executable shape that loses the
# validated Ruby GC/root behavior. Keep the final link to linker paths plus the
# explicit 1 MiB stack, matching the known-good fullmake package artifact.
make \
    "LDFLAGS=$FINAL_RUBY_LDFLAGS" \
    "EXTOBJS=$STATIC_EXTOBJS $STATIC_ENCOBJS" \
    "EXTLIBS=$STATIC_EXTLIBS" \
    "EXTLDFLAGS=$STATIC_LINK_PATHS" \
    "EXTINITS=$STATIC_EXTINITS" \
    SHOWFLAGS= \
    ruby

# Collect binary
mkdir -p "$BIN_DIR"
if [ -f ruby ]; then
    cp ruby "$BIN_DIR/ruby.wasm"
else
    echo "ERROR: full Ruby binary not found after build" >&2
    exit 1
fi

ROOT_SPILL="$REPO_ROOT/scripts/run-wasm-local-root-spill.sh"
FORK_INSTRUMENT="$REPO_ROOT/scripts/run-wasm-fork-instrument.sh"
echo "==> Applying wasm-local-root-spill to ruby.wasm..."
"$ROOT_SPILL" --profile ruby "$BIN_DIR/ruby.wasm" -o "$BIN_DIR/ruby.wasm.roots"
mv "$BIN_DIR/ruby.wasm.roots" "$BIN_DIR/ruby.wasm"
echo "==> Applying wasm-fork-instrument to ruby.wasm..."
"$FORK_INSTRUMENT" "$BIN_DIR/ruby.wasm" -o "$BIN_DIR/ruby.wasm.instr"
mv "$BIN_DIR/ruby.wasm.instr" "$BIN_DIR/ruby.wasm"

# Install stdlib and default RubyGems/Bundler files under the guest /usr
# prefix. The package publishes this tree as ruby-runtime.zip for VFS images.
echo "==> Installing Ruby runtime..."
mkdir -p "$INSTALL_DIR"
RUBY_LIB_DIR="$INSTALL_DIR/usr/lib/ruby/${RUBY_MAJOR_MINOR}.0"
make install \
    DESTDIR="$INSTALL_DIR" 2>/dev/null || {
    echo "==> make install failed, copying lib manually..."
    mkdir -p "$RUBY_LIB_DIR"
    cp -r "$SRC_DIR/lib/"* "$RUBY_LIB_DIR/" 2>/dev/null || true
}
if [ -d "$CROSS_BUILD_DIR/.ext/common" ]; then
    cp -R "$CROSS_BUILD_DIR/.ext/common"/. "$RUBY_LIB_DIR"/
fi
for ext_lib_dir in "$SRC_DIR/ext/monitor/lib" "$SRC_DIR/ext/socket/lib"; do
    if [ -d "$ext_lib_dir" ]; then
        cp -R "$ext_lib_dir"/. "$RUBY_LIB_DIR"/
    fi
done
RUBY_ARCH_DIR="$RUBY_LIB_DIR/wasm32-none"
mkdir -p "$RUBY_ARCH_DIR"
cp rbconfig.rb "$RUBY_ARCH_DIR/rbconfig.rb"
RUBY_ARCH_DIR="$RUBY_LIB_DIR/wasm32-unknown-none"
mkdir -p "$RUBY_ARCH_DIR"
cp rbconfig.rb "$RUBY_ARCH_DIR/rbconfig.rb"

if [ ! -d "$RUBY_LIB_DIR/rubygems" ]; then
    echo "ERROR: Ruby runtime tree is missing rubygems at $RUBY_LIB_DIR/rubygems" >&2
    exit 1
fi
mkdir -p "$INSTALL_DIR/usr/bin"
cat >"$INSTALL_DIR/usr/bin/gem" <<'EOF'
#!/usr/bin/env ruby
require "rubygems/gem_runner"
Gem::GemRunner.new.run(ARGV)
EOF
cat >"$INSTALL_DIR/usr/bin/bundle" <<'EOF'
#!/usr/bin/env ruby
require "bundler/friendly_errors"
Bundler.with_friendly_errors do
  require "bundler/cli"
  Bundler::CLI.start(ARGV, debug: true)
end
EOF
cat >"$INSTALL_DIR/usr/bin/bundler" <<'EOF'
#!/usr/bin/env ruby
load File.expand_path("bundle", __dir__)
EOF
chmod 755 "$INSTALL_DIR/usr/bin/gem" "$INSTALL_DIR/usr/bin/bundle" "$INSTALL_DIR/usr/bin/bundler"

rm -f "$RUNTIME_ZIP"
RUNTIME_STAGE="$(mktemp -d)"
trap 'rm -rf "$RUNTIME_STAGE"' EXIT
mkdir -p "$RUNTIME_STAGE/usr/lib"
cp -R "$INSTALL_DIR/usr/lib/ruby" "$RUNTIME_STAGE/usr/lib/ruby"
cp -R "$INSTALL_DIR/usr/bin" "$RUNTIME_STAGE/usr/bin"
(cd "$RUNTIME_STAGE" && zip -r -q "$RUNTIME_ZIP" usr)
echo "==> Ruby runtime archive: $RUNTIME_ZIP"

echo ""
echo "==> Ruby built successfully!"
ls -lh "$BIN_DIR/ruby.wasm"
ls -lh "$RUNTIME_ZIP"

# Install into local-binaries/ so the resolver picks the freshly-built
# package outputs over the fetched release.
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary "$PACKAGE_NAME" "$SCRIPT_DIR/bin/ruby.wasm"
install_local_binary "$PACKAGE_NAME" "$RUNTIME_ZIP"
