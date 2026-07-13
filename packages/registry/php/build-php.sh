#!/usr/bin/env bash
set -euo pipefail

# Builds two PHP binaries from one source tree:
#
#   sapi/cli/php        → php.wasm     (CLI)
#   sapi/fpm/php-fpm    → php-fpm.wasm (FastCGI Process Manager;
#                                       fork-instrumented)
#
# The two builds were previously separate scripts (this one + the
# now-removed packages/registry/nginx/demo/build-php-fpm.sh). Unifying them lets a
# single autoconf invocation produce both sapis from one source tree
# and one set of patched config.h/Makefile.
#
# CFLAGS/LDFLAGS are set to FPM's stricter requirements. CLI ships
# with the same flags for debuggability.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
PHP_VERSION="${WASM_POSIX_DEP_VERSION:-${PHP_VERSION:-8.3.15}}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://www.php.net/distributions/php-${PHP_VERSION}.tar.gz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-67073c3c9c56c86461e0715d9e1806af5ddffe8e6e2eb9781f7923bbb5bd67fa}"
TARGET_ARCH="${WASM_POSIX_DEP_TARGET_ARCH:-wasm32}"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/kandelo-php.XXXXXX")"
cleanup() {
    status=$?
    trap - EXIT
    if [ "${WASM_POSIX_KEEP_BUILD_DIR:-0}" = "1" ]; then
        echo "==> Preserving PHP build directory: $WORK_DIR" >&2
    else
        rm -rf "$WORK_DIR"
    fi
    exit "$status"
}
trap cleanup EXIT
SRC_DIR="$WORK_DIR/source"
BIN_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/bin}"
CONFIG_CACHE="$WORK_DIR/config.cache"
GUEST_PREFIX="/usr"

if [ "$TARGET_ARCH" != "wasm32" ]; then
    echo "ERROR: PHP currently supports only wasm32, got $TARGET_ARCH" >&2
    exit 1
fi
# Worktree-local SDK on PATH (no global npm link required).
# shellcheck source=/dev/null
source "$REPO_ROOT/sdk/activate.sh"

if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found after sourcing sdk/activate.sh." >&2
    exit 1
fi

SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"
export WASM_POSIX_SYSROOT="$SYSROOT"

# --- Resolve cache deps via cargo xtask build-deps ---
HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"
resolve_dep() {
    local name="$1"
    (cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TARGET" --quiet -- build-deps --arch "$TARGET_ARCH" resolve "$name")
}

ZLIB_PREFIX="${WASM_POSIX_DEP_ZLIB_DIR:-}"
[ -z "$ZLIB_PREFIX" ] && { echo "==> Resolving zlib..."; ZLIB_PREFIX="$(resolve_dep zlib)"; }
SQLITE_PREFIX="${WASM_POSIX_DEP_SQLITE_DIR:-}"
[ -z "$SQLITE_PREFIX" ] && { echo "==> Resolving sqlite..."; SQLITE_PREFIX="$(resolve_dep sqlite)"; }
OPENSSL_PREFIX="${WASM_POSIX_DEP_OPENSSL_DIR:-}"
[ -z "$OPENSSL_PREFIX" ] && { echo "==> Resolving openssl..."; OPENSSL_PREFIX="$(resolve_dep openssl)"; }
LIBXML2_PREFIX="${WASM_POSIX_DEP_LIBXML2_DIR:-}"
[ -z "$LIBXML2_PREFIX" ] && { echo "==> Resolving libxml2..."; LIBXML2_PREFIX="$(resolve_dep libxml2)"; }
LIBICONV_PREFIX="${WASM_POSIX_DEP_LIBICONV_DIR:-}"
[ -z "$LIBICONV_PREFIX" ] && { echo "==> Resolving GNU libiconv..."; LIBICONV_PREFIX="$(resolve_dep libiconv)"; }
LIBZIP_PREFIX="${WASM_POSIX_DEP_LIBZIP_DIR:-}"
[ -z "$LIBZIP_PREFIX" ] && { echo "==> Resolving libzip..."; LIBZIP_PREFIX="$(resolve_dep libzip)"; }
LIBCURL_PREFIX="${WASM_POSIX_DEP_LIBCURL_DIR:-}"
[ -z "$LIBCURL_PREFIX" ] && { echo "==> Resolving libcurl..."; LIBCURL_PREFIX="$(resolve_dep libcurl)"; }
# ICU and libcxx back only the runtime-loadable intl side module. Keep them as
# explicit direct dependencies so the recipe never succeeds because a prior
# local build happened to leave C++ headers or ICU archives in the sysroot.
ICU_PREFIX="${WASM_POSIX_DEP_ICU_DIR:-}"
[ -z "$ICU_PREFIX" ] && { echo "==> Resolving icu..."; ICU_PREFIX="$(resolve_dep icu)"; }
LIBCXX_PREFIX="${WASM_POSIX_DEP_LIBCXX_DIR:-}"
[ -z "$LIBCXX_PREFIX" ] && { echo "==> Resolving libcxx..."; LIBCXX_PREFIX="$(resolve_dep libcxx)"; }
[ -f "$ZLIB_PREFIX/lib/libz.a" ] || { echo "ERROR: zlib resolve missing libz.a"; exit 1; }
[ -f "$SQLITE_PREFIX/lib/libsqlite3.a" ] || { echo "ERROR: sqlite resolve missing libsqlite3.a"; exit 1; }
[ -f "$OPENSSL_PREFIX/lib/libssl.a" ] || { echo "ERROR: openssl resolve missing libssl.a"; exit 1; }
[ -f "$LIBXML2_PREFIX/lib/libxml2.a" ] || { echo "ERROR: libxml2 resolve missing libxml2.a"; exit 1; }
[ -f "$LIBICONV_PREFIX/lib/libiconv.a" ] || { echo "ERROR: GNU libiconv resolve missing libiconv.a"; exit 1; }
[ -f "$LIBZIP_PREFIX/lib/libzip.a" ] || { echo "ERROR: libzip resolve missing libzip.a"; exit 1; }
[ -f "$LIBCURL_PREFIX/lib/libcurl.a" ] || { echo "ERROR: libcurl resolve missing libcurl.a"; exit 1; }
[ -f "$ICU_PREFIX/lib/libicuuc.a" ] || { echo "ERROR: icu resolve missing libicuuc.a"; exit 1; }
[ -f "$ICU_PREFIX/lib/libicui18n.a" ] || { echo "ERROR: icu resolve missing libicui18n.a"; exit 1; }
[ -f "$ICU_PREFIX/lib/libicuio.a" ] || { echo "ERROR: icu resolve missing libicuio.a"; exit 1; }
[ -f "$ICU_PREFIX/lib/libicudata.a" ] || { echo "ERROR: icu resolve missing libicudata.a"; exit 1; }
[ -f "$ICU_PREFIX/share/icu.dat" ] || { echo "ERROR: icu resolve missing share/icu.dat"; exit 1; }
[ -f "$LIBCXX_PREFIX/lib/libc++.a" ] || { echo "ERROR: libcxx resolve missing libc++.a"; exit 1; }
[ -f "$LIBCXX_PREFIX/lib/libc++abi.a" ] || { echo "ERROR: libcxx resolve missing libc++abi.a"; exit 1; }
[ -f "$LIBCXX_PREFIX/lib/libc++-pic.a" ] || { echo "ERROR: libcxx resolve missing libc++-pic.a"; exit 1; }
[ -f "$LIBCXX_PREFIX/lib/libc++abi-pic.a" ] || { echo "ERROR: libcxx resolve missing libc++abi-pic.a"; exit 1; }
[ -d "$LIBCXX_PREFIX/include/c++/v1" ] || { echo "ERROR: libcxx resolve missing include/c++/v1"; exit 1; }
echo "==> zlib at $ZLIB_PREFIX"
echo "==> sqlite at $SQLITE_PREFIX"
echo "==> openssl at $OPENSSL_PREFIX"
echo "==> libxml2 at $LIBXML2_PREFIX"
echo "==> GNU libiconv at $LIBICONV_PREFIX"
echo "==> libzip at $LIBZIP_PREFIX"
echo "==> libcurl at $LIBCURL_PREFIX"
echo "==> icu at $ICU_PREFIX"
echo "==> libcxx at $LIBCXX_PREFIX"

# The SDK's C++ driver reads libc++ from the worktree-local sysroot. Point that
# declared toolchain location at the resolver-owned dependency, matching the
# existing MariaDB/SpiderMonkey package contract. The intl side-module link
# below names the PIC archives explicitly; these non-PIC names are only for
# configure probes and any main-module C++ checks.
mkdir -p "$SYSROOT/lib" "$SYSROOT/include/c++"
ln -sf "$LIBCXX_PREFIX/lib/libc++.a" "$SYSROOT/lib/libc++.a"
ln -sf "$LIBCXX_PREFIX/lib/libc++abi.a" "$SYSROOT/lib/libc++abi.a"
ln -sf "$LIBCXX_PREFIX/lib/libc++.a" "$SYSROOT/lib/libstdc++.a"
rm -rf "$SYSROOT/include/c++/v1"
ln -sfn "$LIBCXX_PREFIX/include/c++/v1" "$SYSROOT/include/c++/v1"

# Compose PKG_CONFIG_PATH for all deps so wasm32posix-configure's
# pkg-config probes can find them in the cache instead of the sysroot.
DEP_PKG_CONFIG_PATH="$ZLIB_PREFIX/lib/pkgconfig:$SQLITE_PREFIX/lib/pkgconfig:$OPENSSL_PREFIX/lib/pkgconfig:$LIBXML2_PREFIX/lib/pkgconfig:$LIBICONV_PREFIX/lib/pkgconfig:$LIBZIP_PREFIX/lib/pkgconfig:$LIBCURL_PREFIX/lib/pkgconfig:$ICU_PREFIX/lib/pkgconfig"

# Compose -I and -L flags for defense-in-depth (autoconf raw probes).
DEP_CPPFLAGS="-I$ZLIB_PREFIX/include -I$SQLITE_PREFIX/include -I$OPENSSL_PREFIX/include -I$LIBXML2_PREFIX/include -I$LIBICONV_PREFIX/include -I$LIBZIP_PREFIX/include -I$LIBCURL_PREFIX/include"
DEP_LDFLAGS="-L$ZLIB_PREFIX/lib -L$SQLITE_PREFIX/lib -L$OPENSSL_PREFIX/lib -L$LIBXML2_PREFIX/lib -L$LIBICONV_PREFIX/lib -L$LIBZIP_PREFIX/lib -L$LIBCURL_PREFIX/lib"

# Some locally rebuilt dependency prefixes used during PHP/kernel
# conformance iteration intentionally contain only headers and static
# archives, not pkg-config metadata. PHP's configure probes support explicit
# <LIB>_CFLAGS/<LIB>_LIBS overrides, so provide them unconditionally. This
# keeps the package build independent of host pkg-config installation details
# while still using the normal PHP dependency-discovery path.
ZLIB_CFLAGS_VALUE="-I$ZLIB_PREFIX/include"
ZLIB_LIBS_VALUE="-L$ZLIB_PREFIX/lib -lz"
SQLITE_CFLAGS_VALUE="-I$SQLITE_PREFIX/include"
SQLITE_LIBS_VALUE="-L$SQLITE_PREFIX/lib -lsqlite3"
OPENSSL_CFLAGS_VALUE="-I$OPENSSL_PREFIX/include"
OPENSSL_LIBS_VALUE="-L$OPENSSL_PREFIX/lib -lssl -lcrypto"
LIBXML_CFLAGS_VALUE="-I$LIBXML2_PREFIX/include/libxml2 -I$LIBXML2_PREFIX/include"
LIBXML_LIBS_VALUE="-L$LIBXML2_PREFIX/lib -lxml2 -L$LIBICONV_PREFIX/lib -liconv -lcharset -lz"
ICONV_CFLAGS_VALUE="-I$LIBICONV_PREFIX/include"
ICONV_LIBS_VALUE="-L$LIBICONV_PREFIX/lib -liconv -lcharset"
LIBZIP_CFLAGS_VALUE="-I$LIBZIP_PREFIX/include"
LIBZIP_LIBS_VALUE="-L$LIBZIP_PREFIX/lib -lzip -L$ZLIB_PREFIX/lib -lz"
CURL_CFLAGS_VALUE="-I$LIBCURL_PREFIX/include -DCURL_STATICLIB"
CURL_LIBS_VALUE="-L$LIBCURL_PREFIX/lib -lcurl"

prefix_map_flags() {
    local producer_path="$1"
    local stable_path="$2"
    printf '%s' "-ffile-prefix-map=$producer_path=$stable_path -fdebug-prefix-map=$producer_path=$stable_path -fmacro-prefix-map=$producer_path=$stable_path"
}

# Shared modules retain line-table directory entries after linking, unlike the
# optimized CLI/FPM binaries. Map every producer-controlled absolute prefix so
# package artifacts do not encode the checkout, cache, or temporary build path.
REPRODUCIBLE_PREFIX_MAPS="$(prefix_map_flags "$WORK_DIR" /usr/src/php-build)"
REPRODUCIBLE_PREFIX_MAPS+=" $(prefix_map_flags "$REPO_ROOT" /usr/src/kandelo)"
REPRODUCIBLE_PREFIX_MAPS+=" $(prefix_map_flags "$ZLIB_PREFIX" /usr/src/kandelo-deps/zlib)"
REPRODUCIBLE_PREFIX_MAPS+=" $(prefix_map_flags "$SQLITE_PREFIX" /usr/src/kandelo-deps/sqlite)"
REPRODUCIBLE_PREFIX_MAPS+=" $(prefix_map_flags "$OPENSSL_PREFIX" /usr/src/kandelo-deps/openssl)"
REPRODUCIBLE_PREFIX_MAPS+=" $(prefix_map_flags "$LIBXML2_PREFIX" /usr/src/kandelo-deps/libxml2)"
REPRODUCIBLE_PREFIX_MAPS+=" $(prefix_map_flags "$LIBICONV_PREFIX" /usr/src/kandelo-deps/libiconv)"
REPRODUCIBLE_PREFIX_MAPS+=" $(prefix_map_flags "$LIBZIP_PREFIX" /usr/src/kandelo-deps/libzip)"
REPRODUCIBLE_PREFIX_MAPS+=" $(prefix_map_flags "$LIBCURL_PREFIX" /usr/src/kandelo-deps/libcurl)"
REPRODUCIBLE_PREFIX_MAPS+=" $(prefix_map_flags "$ICU_PREFIX" /usr/src/kandelo-deps/icu)"
REPRODUCIBLE_PREFIX_MAPS+=" $(prefix_map_flags "$LIBCXX_PREFIX" /usr/src/kandelo-deps/libcxx)"

echo "==> Downloading PHP $PHP_VERSION..."
TARBALL="$WORK_DIR/php.tar.gz"
curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors -fsSL "$SOURCE_URL" -o "$TARBALL"
echo "==> Verifying source sha256..."
echo "$SOURCE_SHA256  $TARBALL" | shasum -a 256 -c -
mkdir -p "$SRC_DIR"
tar xzf "$TARBALL" -C "$SRC_DIR" --strip-components=1

rm -rf "$BIN_DIR"
mkdir -p "$BIN_DIR"

cd "$SRC_DIR"

# Apply patches for Wasm compatibility
echo "==> Patching PHP for Wasm..."

# The upstream no-phar test fixture is a self-extracting PHP stub embedded at
# fixed byte offsets. It masks CRC values with the literal 0xffffffff; on
# wasm32/PHP with 32-bit longs that literal is a float and PHP 8.3 emits
# E_DEPRECATED before the fixture output. Use an equal-width integer mask so
# the fixture remains byte-offset-compatible and works on both 32-bit and
# 64-bit PHP runtimes. The fixture is also a signed phar archive used by other
# tests, so refresh its SHA1 phar signature after changing the stub bytes.
if [ -f ext/phar/tests/files/nophar.phar ] \
   && grep -aq '0xffffffff' ext/phar/tests/files/nophar.phar; then
    python3 - <<'PY'
from pathlib import Path
import hashlib
p = Path("ext/phar/tests/files/nophar.phar")
b = bytearray(p.read_bytes().replace(b"0xffffffff", b"(-1)      "))
if b[-4:] != b"GBMB":
    raise SystemExit("nophar.phar: missing phar signature magic")
algo = int.from_bytes(b[-8:-4], "little")
if algo != 2:
    raise SystemExit(f"nophar.phar: expected SHA1 signature algorithm 2, got {algo}")
b[-28:-8] = hashlib.sha1(bytes(b[:-28])).digest()
p.write_bytes(b)
PY
fi

# Disable inline assembly in Zend (safety net — Wasm doesn't match arch guards anyway)
if ! grep -q 'ZEND_USE_ASM_ARITHMETIC 0' Zend/zend_multiply.h 2>/dev/null; then
    if [ -f Zend/zend_multiply.h ]; then
        sed -i.bak '1i\
#define ZEND_USE_ASM_ARITHMETIC 0
' Zend/zend_multiply.h && rm -f Zend/zend_multiply.h.bak
    fi
fi

# When ZEND_MAX_EXECUTION_TIMERS is enabled, zend_executor_globals embeds a
# `struct sigaction`. Some translation units include zend_globals.h without
# having included <signal.h> first, leaving that struct incomplete. Include the
# standard timer/signal declarations at the header that owns those fields.
if [ -f Zend/zend_globals.h ] \
   && ! grep -q "wasm-zend-max-execution-timers include patch applied" Zend/zend_globals.h; then
    sed -i.bak '/#include <sys\/types.h>/a\
#ifdef ZEND_MAX_EXECUTION_TIMERS\
# include <signal.h>\
# include <time.h>\
#endif\
/* wasm-zend-max-execution-timers include patch applied */' Zend/zend_globals.h
    rm -f Zend/zend_globals.h.bak
fi

# The Wasm timeout path below is driven by a host-side cooperative timer. PHP's
# native implementation requires Linux SIGEV_THREAD_ID delivery, which Kandelo
# does not implement, so keep the native entry points as no-ops and make the
# cooperative hook the sole owner of Wasm max-execution timers.
if [ -f Zend/zend_max_execution_timer.c ] \
   && ! grep -q "wasm native max-execution timer disabled" Zend/zend_max_execution_timer.c; then
    python3 - <<'PY'
from pathlib import Path

p = Path("Zend/zend_max_execution_timer.c")
s = p.read_text()
opening = "#ifdef ZEND_MAX_EXECUTION_TIMERS\n\n"
replacement = (
    opening
    + "#if defined(__wasm32__) || defined(__wasm64__)\n\n"
    + "#include \"zend.h\"\n\n"
    + "/* wasm native max-execution timer disabled; zend_execute_API.c owns the host hook */\n"
    + "ZEND_API void zend_max_execution_timer_init(void) {}\n"
    + "void zend_max_execution_timer_settime(zend_long seconds) { (void) seconds; }\n"
    + "void zend_max_execution_timer_shutdown(void) {}\n\n"
    + "#else\n\n"
)
if s.count(opening) != 1:
    raise SystemExit("Zend timer patch: expected one ZEND_MAX_EXECUTION_TIMERS guard")
s = s.replace(opening, replacement, 1)
closing = "\n#endif\n"
index = s.rfind(closing)
if index < 0:
    raise SystemExit("Zend timer patch: final guard not found")
s = s[:index] + "\n#endif /* wasm native timer */" + s[index:]
p.write_text(s)
PY
fi

# WebAssembly cannot receive native async POSIX signals while a process worker
# is executing a CPU-bound Wasm loop. PHP's VM already cooperatively checks
# EG(vm_interrupt) on loop backedges; provide a wasm-posix timer hook that the
# host runs from the kernel worker and uses to set EG(timed_out)+EG(vm_interrupt)
# in shared process memory. This preserves PHP's general max_execution_time
# behavior on wasm without special-casing the kernel for PHP.
if [ -f Zend/zend_execute_API.c ] \
   && ! grep -q "wasm-vm-interrupt-timer patch applied" Zend/zend_execute_API.c; then
    python3 - <<'PY'
from pathlib import Path
p = Path("Zend/zend_execute_API.c")
s = p.read_text()
s = s.replace(
    "static void zend_set_timeout_ex(zend_long seconds, bool reset_signals);\n",
    "static void zend_set_timeout_ex(zend_long seconds, bool reset_signals);\n"
    "#if defined(__wasm32__) || defined(__wasm64__)\n"
    "extern void __wasm_posix_vm_interrupt_after(void *timed_out, void *vm_interrupt, zend_long seconds);\n"
    "#endif\n"
    "/* wasm-vm-interrupt-timer patch applied */\n",
)
s = s.replace(
    "#elif defined(ZEND_MAX_EXECUTION_TIMERS)\n"
    "\tzend_max_execution_timer_settime(seconds);\n",
    "#elif defined(ZEND_MAX_EXECUTION_TIMERS)\n"
    "# if defined(__wasm32__) || defined(__wasm64__)\n"
    "\t/*\n"
    "\t * Schedule the cooperative Wasm VM interrupt only for the normal\n"
    "\t * timeout phase (or for seconds=0 cancellation). PHP's native\n"
    "\t * ZEND_MAX_EXECUTION_TIMERS path sets EG(timed_out) before arming\n"
    "\t * hard_timeout, and that hard timeout must continue to be enforced\n"
    "\t * by the POSIX timer signal path so PHP reports n+hard seconds and\n"
    "\t * exits like a normal POSIX build.\n"
    "\t */\n"
    "\tif (seconds <= 0 || !zend_atomic_bool_load_ex(&EG(timed_out))) {\n"
    "\t\t__wasm_posix_vm_interrupt_after(&EG(timed_out), &EG(vm_interrupt), seconds);\n"
    "\t}\n"
    "# endif\n"
    "\tzend_max_execution_timer_settime(seconds);\n",
)
s = s.replace(
    "#else\n"
    "\tzend_atomic_bool_store_ex(&EG(timed_out), false);\n"
    "\tzend_set_timeout_ex(0, 1);\n"
    "#endif\n\n"
    "\tzend_error_noreturn(E_ERROR, \"Maximum execution time of \" ZEND_LONG_FMT \" second%s exceeded\", EG(timeout_seconds), EG(timeout_seconds) == 1 ? \"\" : \"s\");\n",
    "#else\n"
    "\tzend_atomic_bool_store_ex(&EG(timed_out), false);\n"
    "\tzend_set_timeout_ex(0, 1);\n"
    "# if defined(__wasm32__) || defined(__wasm64__)\n"
    "\t/*\n"
    "\t * When the cooperative Wasm VM interrupt observes the soft timeout\n"
    "\t * before the POSIX signal is delivered, the disarm above prevents PHP's\n"
    "\t * native signal handler from arming hard_timeout. Re-arm the cooperative\n"
    "\t * interrupt for the shutdown hard-timeout window so runaway shutdown\n"
    "\t * handlers terminate like they do on a POSIX build.\n"
    "\t */\n"
    "\tif (EG(hard_timeout) > 0) {\n"
    "\t\t__wasm_posix_vm_interrupt_after(&EG(timed_out), &EG(vm_interrupt), EG(hard_timeout));\n"
    "\t\tEG(hard_timeout) = 0;\n"
    "\t}\n"
    "# endif\n"
    "#endif\n\n"
    "\tzend_error_noreturn(E_ERROR, \"Maximum execution time of \" ZEND_LONG_FMT \" second%s exceeded\", EG(timeout_seconds), EG(timeout_seconds) == 1 ? \"\" : \"s\");\n",
)
p.write_text(s)
PY
fi

# The cooperative VM interrupt above preserves normal max_execution_time
# behavior, but it cannot asynchronously interrupt a CPU-bound Wasm function.
# If PHP first regains control after both max_execution_time and hard_timeout
# elapsed, report the native hard-timeout diagnostic that upstream emits from
# its signal handler.
if [ -f Zend/zend_execute_API.c ] \
   && ! grep -q "wasm-vm-interrupt-hard-timeout patch applied" Zend/zend_execute_API.c; then
    python3 - <<'PY'
from pathlib import Path

p = Path("Zend/zend_execute_API.c")
s = p.read_text()

def replace_once(old: str, new: str, label: str) -> None:
    global s
    if old not in s:
        raise SystemExit(f"Zend hard-timeout patch: could not find {label}")
    s = s.replace(old, new, 1)

if '#include "zend_hrtime.h"' not in s:
    replace_once(
        '#include "zend_call_stack.h"\n',
        '#include "zend_call_stack.h"\n'
        '#if defined(__wasm32__) || defined(__wasm64__)\n'
        '#include "zend_hrtime.h"\n'
        '#endif\n',
        "zend_call_stack include",
    )

replace_once(
    "static void zend_set_timeout_ex(zend_long seconds, bool reset_signals);\n"
    "#if defined(__wasm32__) || defined(__wasm64__)\n"
    "extern void __wasm_posix_vm_interrupt_after(void *timed_out, void *vm_interrupt, zend_long seconds);\n"
    "#endif\n"
    "/* wasm-vm-interrupt-timer patch applied */\n",
    "static void zend_set_timeout_ex(zend_long seconds, bool reset_signals);\n"
    "#if defined(__wasm32__) || defined(__wasm64__)\n"
    "extern void __wasm_posix_vm_interrupt_after(void *timed_out, void *vm_interrupt, zend_long seconds);\n"
    "\n"
    "static zend_hrtime_t zend_wasm_timeout_deadline = 0;\n"
    "static zend_hrtime_t zend_wasm_hard_timeout_deadline = 0;\n"
    "\n"
    "#define ZEND_WASM_HRTIME_MAX ((zend_hrtime_t) -1)\n"
    "#define ZEND_WASM_INTERRUPT_EARLY_NS UINT64_C(100000000)\n"
    "\n"
    "static zend_always_inline zend_hrtime_t zend_wasm_timeout_seconds_to_ns(zend_long seconds)\n"
    "{\n"
    "\tif (seconds <= 0) {\n"
    "\t\treturn 0;\n"
    "\t}\n"
    "\tif ((zend_hrtime_t) seconds > ZEND_WASM_HRTIME_MAX / (zend_hrtime_t) ZEND_NANO_IN_SEC) {\n"
    "\t\treturn ZEND_WASM_HRTIME_MAX;\n"
    "\t}\n"
    "\treturn (zend_hrtime_t) seconds * (zend_hrtime_t) ZEND_NANO_IN_SEC;\n"
    "}\n"
    "\n"
    "static zend_always_inline zend_hrtime_t zend_wasm_deadline_after(zend_hrtime_t now, zend_hrtime_t delay_ns)\n"
    "{\n"
    "\tif (delay_ns > ZEND_WASM_HRTIME_MAX - now) {\n"
    "\t\treturn ZEND_WASM_HRTIME_MAX;\n"
    "\t}\n"
    "\treturn now + delay_ns;\n"
    "}\n"
    "\n"
    "static zend_always_inline void zend_wasm_clear_timeout_deadlines(void)\n"
    "{\n"
    "\tzend_wasm_timeout_deadline = 0;\n"
    "\tzend_wasm_hard_timeout_deadline = 0;\n"
    "}\n"
    "\n"
    "static zend_always_inline void zend_wasm_record_timeout_deadline(zend_long seconds)\n"
    "{\n"
    "\tzend_hrtime_t now = zend_hrtime();\n"
    "\tzend_hrtime_t timeout_ns = zend_wasm_timeout_seconds_to_ns(seconds);\n"
    "\tzend_wasm_timeout_deadline = zend_wasm_deadline_after(now, timeout_ns);\n"
    "\tif (EG(hard_timeout) > 0) {\n"
    "\t\tzend_hrtime_t hard_ns = zend_wasm_timeout_seconds_to_ns(EG(hard_timeout));\n"
    "\t\tzend_wasm_hard_timeout_deadline = zend_wasm_deadline_after(zend_wasm_timeout_deadline, hard_ns);\n"
    "\t} else {\n"
    "\t\tzend_wasm_hard_timeout_deadline = 0;\n"
    "\t}\n"
    "}\n"
    "\n"
    "static zend_always_inline bool zend_wasm_hard_timeout_expired(void)\n"
    "{\n"
    "\tzend_hrtime_t now;\n"
    "\tif (EG(hard_timeout) <= 0 || zend_wasm_hard_timeout_deadline == 0) {\n"
    "\t\treturn false;\n"
    "\t}\n"
    "\tnow = zend_hrtime();\n"
    "\treturn now >= zend_wasm_hard_timeout_deadline\n"
    "\t\t|| zend_wasm_hard_timeout_deadline - now <= ZEND_WASM_INTERRUPT_EARLY_NS;\n"
    "}\n"
    "\n"
    "static ZEND_COLD void zend_wasm_hard_timeout_exit(void)\n"
    "{\n"
    "\tconst char *error_filename = NULL;\n"
    "\tuint32_t error_lineno = 0;\n"
    "\tchar log_buffer[2048];\n"
    "\tint output_len = 0;\n"
    "\n"
    "\tif (zend_is_compiling()) {\n"
    "\t\terror_filename = ZSTR_VAL(zend_get_compiled_filename());\n"
    "\t\terror_lineno = zend_get_compiled_lineno();\n"
    "\t} else if (zend_is_executing()) {\n"
    "\t\terror_filename = zend_get_executed_filename();\n"
    "\t\tif (error_filename[0] == '[') {\n"
    "\t\t\terror_filename = NULL;\n"
    "\t\t\terror_lineno = 0;\n"
    "\t\t} else {\n"
    "\t\t\terror_lineno = zend_get_executed_lineno();\n"
    "\t\t}\n"
    "\t}\n"
    "\tif (!error_filename) {\n"
    "\t\terror_filename = \"Unknown\";\n"
    "\t}\n"
    "\n"
    "\toutput_len = snprintf(log_buffer, sizeof(log_buffer), \"\\nFatal error: Maximum execution time of \" ZEND_LONG_FMT \"+\" ZEND_LONG_FMT \" seconds exceeded (terminated) in %s on line %d\\n\", EG(timeout_seconds), EG(hard_timeout), error_filename, error_lineno);\n"
    "\tif (output_len > 0) {\n"
    "\t\tzend_quiet_write(2, log_buffer, MIN(output_len, sizeof(log_buffer)));\n"
    "\t}\n"
    "\t_exit(124);\n"
    "}\n"
    "#endif\n"
    "/* wasm-vm-interrupt-hard-timeout patch applied */\n",
    "wasm timeout declaration",
)

replace_once(
    "#elif defined(ZEND_MAX_EXECUTION_TIMERS)\n"
    "# if defined(__wasm32__) || defined(__wasm64__)\n"
    "\t/*\n"
    "\t * Schedule the cooperative Wasm VM interrupt only for the normal\n"
    "\t * timeout phase (or for seconds=0 cancellation). PHP's native\n"
    "\t * ZEND_MAX_EXECUTION_TIMERS path sets EG(timed_out) before arming\n"
    "\t * hard_timeout, and that hard timeout must continue to be enforced\n"
    "\t * by the POSIX timer signal path so PHP reports n+hard seconds and\n"
    "\t * exits like a normal POSIX build.\n"
    "\t */\n"
    "\tif (seconds <= 0 || !zend_atomic_bool_load_ex(&EG(timed_out))) {\n"
    "\t\t__wasm_posix_vm_interrupt_after(&EG(timed_out), &EG(vm_interrupt), seconds);\n"
    "\t}\n"
    "# endif\n"
    "\tzend_max_execution_timer_settime(seconds);\n",
    "#elif defined(ZEND_MAX_EXECUTION_TIMERS)\n"
    "# if defined(__wasm32__) || defined(__wasm64__)\n"
    "\t/*\n"
    "\t * Host-side timers set Zend's cooperative VM interrupt flags. They\n"
    "\t * cannot asynchronously unwind an already-running Wasm function, so keep\n"
    "\t * absolute deadlines here and report the native hard-timeout diagnostic\n"
    "\t * if PHP first regains control after max_execution_time+hard_timeout.\n"
    "\t */\n"
    "\tif (seconds <= 0) {\n"
    "\t\tzend_wasm_clear_timeout_deadlines();\n"
    "\t\t__wasm_posix_vm_interrupt_after(&EG(timed_out), &EG(vm_interrupt), seconds);\n"
    "\t} else if (!zend_atomic_bool_load_ex(&EG(timed_out))) {\n"
    "\t\tzend_wasm_record_timeout_deadline(seconds);\n"
    "\t\t__wasm_posix_vm_interrupt_after(&EG(timed_out), &EG(vm_interrupt), seconds);\n"
    "\t}\n"
    "# endif\n"
    "\tzend_max_execution_timer_settime(seconds);\n",
    "wasm timeout scheduling",
)

replace_once(
    "#else\n"
    "\tzend_atomic_bool_store_ex(&EG(timed_out), false);\n"
    "\tzend_set_timeout_ex(0, 1);\n"
    "# if defined(__wasm32__) || defined(__wasm64__)\n"
    "\t/*\n"
    "\t * When the cooperative Wasm VM interrupt observes the soft timeout\n"
    "\t * before the POSIX signal is delivered, the disarm above prevents PHP's\n"
    "\t * native signal handler from arming hard_timeout. Re-arm the cooperative\n"
    "\t * interrupt for the shutdown hard-timeout window so runaway shutdown\n"
    "\t * handlers terminate like they do on a POSIX build.\n"
    "\t */\n"
    "\tif (EG(hard_timeout) > 0) {\n"
    "\t\t__wasm_posix_vm_interrupt_after(&EG(timed_out), &EG(vm_interrupt), EG(hard_timeout));\n"
    "\t\tEG(hard_timeout) = 0;\n"
    "\t}\n"
    "# endif\n"
    "#endif\n\n"
    "\tzend_error_noreturn(E_ERROR, \"Maximum execution time of \" ZEND_LONG_FMT \" second%s exceeded\", EG(timeout_seconds), EG(timeout_seconds) == 1 ? \"\" : \"s\");\n",
    "#else\n"
    "# if defined(__wasm32__) || defined(__wasm64__)\n"
    "\tif (zend_wasm_hard_timeout_expired()) {\n"
    "\t\tzend_wasm_hard_timeout_exit();\n"
    "\t}\n"
    "# endif\n"
    "\tzend_atomic_bool_store_ex(&EG(timed_out), false);\n"
    "\t/* A responsive VM timeout follows POSIX zend_timeout(): disarm before shutdown. */\n"
    "\tzend_set_timeout_ex(0, 1);\n"
    "# if defined(__wasm32__) || defined(__wasm64__)\n"
    "\t/* Give shutdown execution a fresh ordinary timeout phase. */\n"
    "\tif (EG(timeout_seconds) > 0) {\n"
    "\t\tzend_wasm_record_timeout_deadline(EG(timeout_seconds));\n"
    "\t\t__wasm_posix_vm_interrupt_after(&EG(timed_out), &EG(vm_interrupt), EG(timeout_seconds));\n"
    "\t}\n"
    "# endif\n"
    "#endif\n\n"
    "\tzend_error_noreturn(E_ERROR, \"Maximum execution time of \" ZEND_LONG_FMT \" second%s exceeded\", EG(timeout_seconds), EG(timeout_seconds) == 1 ? \"\" : \"s\");\n",
    "wasm zend_timeout body",
)

replace_once(
    "#elif ZEND_MAX_EXECUTION_TIMERS\n"
    "\tzend_max_execution_timer_settime(0);\n"
    "#elif defined(HAVE_SETITIMER)\n",
    "#elif ZEND_MAX_EXECUTION_TIMERS\n"
    "\tzend_max_execution_timer_settime(0);\n"
    "# if defined(__wasm32__) || defined(__wasm64__)\n"
    "\tzend_wasm_clear_timeout_deadlines();\n"
    "\t__wasm_posix_vm_interrupt_after(&EG(timed_out), &EG(vm_interrupt), 0);\n"
    "# endif\n"
    "#elif defined(HAVE_SETITIMER)\n",
    "zend_unset_timeout max execution timer body",
)

p.write_text(s)
PY
fi

# The cooperative Wasm timeout does not use SIGRTMIN. Keep PHP from replacing
# or unblocking the application's SIGRTMIN disposition merely because a caller
# asks zend_set_timeout() to reset the native timer signal handler.
if [ -f Zend/zend_execute_API.c ] \
   && ! grep -q "wasm-vm-interrupt-no-sigrtmin patch applied" Zend/zend_execute_API.c; then
    python3 - <<'PY'
from pathlib import Path

p = Path("Zend/zend_execute_API.c")
s = p.read_text()
block = """\tif (reset_signals) {
\t\tsigset_t sigset;
\t\tstruct sigaction act;

\t\tact.sa_sigaction = zend_timeout_handler;
\t\tsigemptyset(&act.sa_mask);
\t\tact.sa_flags = SA_ONSTACK | SA_SIGINFO;
\t\tsigaction(SIGRTMIN, &act, NULL);
\t\tsigemptyset(&sigset);
\t\tsigaddset(&sigset, SIGRTMIN);
\t\tsigprocmask(SIG_UNBLOCK, &sigset, NULL);
\t}
"""
replacement = (
    "# if !defined(__wasm32__) && !defined(__wasm64__)\n"
    + block
    + "# endif\n"
    + "\t/* wasm-vm-interrupt-no-sigrtmin patch applied */\n"
)
if s.count(block) != 1:
    raise SystemExit("Zend SIGRTMIN patch: expected one native max-timer signal block")
p.write_text(s.replace(block, replacement, 1))
PY
fi

# PHP's DBA extension keeps an in-process lock guard because some platforms
# allow same-process read/write opens that the extension wants to reject. For
# DB-lock mode, upstream replaces info->path with the stream's opened_path only
# after the first guard check. On wasm-posix this means a later relative-path
# open can miss an already-open canonical-path handle and report "Read during
# write: allowed" for the built-in flatfile/inifile handlers. Repeat the guard
# after DB-lock path canonicalization, before taking the stream lock.
if [ -f ext/dba/dba.c ] \
   && ! grep -q "wasm-dba-db-lock-path-conflict patch applied" ext/dba/dba.c; then
    python3 - <<'PY'
from pathlib import Path

p = Path("ext/dba/dba.c")
s = p.read_text()

find_func = '''static dba_info *php_dba_find(const zend_string *path)
{
\tzend_resource *le;
\tdba_info *info;
\tzend_long numitems, i;

\tnumitems = zend_hash_next_free_element(&EG(regular_list));
\tfor (i=1; i<numitems; i++) {
\t\tif ((le = zend_hash_index_find_ptr(&EG(regular_list), i)) == NULL) {
\t\t\tcontinue;
\t\t}
\t\tif (le->type == le_db || le->type == le_pdb) {
\t\t\tinfo = (dba_info *)(le->ptr);
\t\t\tif (zend_string_equals(path, info->path)) {
\t\t\t\treturn (dba_info *)(le->ptr);
\t\t\t}
\t\t}
\t}

\treturn NULL;
}
/* }}} */
'''

helper = find_func + '''

static bool php_dba_lock_conflicts(const dba_info *info, int lock_mode)
{
\tdba_info *other;

\tif ((other = php_dba_find(info->path)) == NULL) {
\t\treturn false;
\t}

\treturn ( (lock_mode&LOCK_EX)        && (other->lock.mode&(LOCK_EX|LOCK_SH)) )
\t    || ( (other->lock.mode&LOCK_EX) && (lock_mode&(LOCK_EX|LOCK_SH))        );
}
/* wasm-dba-db-lock-path-conflict patch applied */
'''

if find_func not in s:
    raise SystemExit("DBA lock patch: could not find php_dba_find")
s = s.replace(find_func, helper, 1)

s = s.replace(
    "\tdba_info *info, *other;\n",
    "\tdba_info *info;\n",
    1,
)

old_check = '''\tif (hptr->flags & DBA_LOCK_ALL) {
\t\tif ((other = php_dba_find(info->path)) != NULL) {
\t\t\tif (   ( (lock_mode&LOCK_EX)        && (other->lock.mode&(LOCK_EX|LOCK_SH)) )
\t\t\t    || ( (other->lock.mode&LOCK_EX) && (lock_mode&(LOCK_EX|LOCK_SH))        )
\t\t\t   ) {
\t\t\t\terror = "Unable to establish lock (database file already open)"; /* force failure exit */
\t\t\t}
\t\t}
\t}
'''

new_check = '''\tif ((hptr->flags & DBA_LOCK_ALL) && php_dba_lock_conflicts(info, lock_mode)) {
\t\terror = "Unable to establish lock (database file already open)"; /* force failure exit */
\t}
'''

if old_check not in s:
    raise SystemExit("DBA lock patch: could not find initial conflict check")
s = s.replace(old_check, new_check, 1)

old_after_stream_open = '''\t\tif (!info->lock.fp) {
\t\t\tdba_close(info);
\t\t\t/* stream operation already wrote an error message */
\t\t\tFREE_PERSISTENT_RESOURCE_KEY();
\t\t\tRETURN_FALSE;
\t\t}
\t\tif (!error && !php_stream_supports_lock(info->lock.fp)) {
'''

new_after_stream_open = '''\t\tif (!info->lock.fp) {
\t\t\tdba_close(info);
\t\t\t/* stream operation already wrote an error message */
\t\t\tFREE_PERSISTENT_RESOURCE_KEY();
\t\t\tRETURN_FALSE;
\t\t}
\t\tif (!error && is_db_lock && (hptr->flags & DBA_LOCK_ALL) && php_dba_lock_conflicts(info, lock_mode)) {
\t\t\terror = "Unable to establish lock (database file already open)"; /* force failure exit */
\t\t}
\t\tif (!error && !php_stream_supports_lock(info->lock.fp)) {
'''

if old_after_stream_open not in s:
    raise SystemExit("DBA lock patch: could not find post-stream-open lock block")
s = s.replace(old_after_stream_open, new_after_stream_open, 1)

p.write_text(s)
PY
fi

# PHP requires one shared-memory backend to be compiled even when callers use
# opcache.file_cache_only=1. The MAP_ANON backend is the only viable build-time
# choice for this target, but Kandelo does not yet provide cross-process
# MAP_SHARED: the normal opcache SHM mode would therefore give FPM workers
# divergent cache/lock state. Enable the backend only so the file-cache path can
# be built, then add a target guard below that rejects opcache startup unless
# file-cache-only mode is explicitly configured. This is a documented runtime
# boundary, not a claim that the configure probe's fork-sharing semantics pass.
if [ -f configure ] && ! grep -q "wasm-opcache patch applied" configure; then
    perl -i.bak -0pe 's/      have_shm_mmap_anon=no\n      ;;/      have_shm_mmap_anon=yes\n      ;; # wasm-opcache patch applied/' configure
    rm -f configure.bak
fi

if [ -f ext/opcache/ZendAccelerator.c ] \
   && ! grep -q "kandelo-opcache-file-cache-only" ext/opcache/ZendAccelerator.c; then
    python3 - <<'PY'
from pathlib import Path

p = Path("ext/opcache/ZendAccelerator.c")
s = p.read_text()
marker = "\tfile_cache_only = ZCG(accel_directives).file_cache_only;\n"
guard = """#if defined(__wasm__) /* kandelo-opcache-file-cache-only */
\tif (!ZCG(accel_directives).file_cache_only) {
\t\taccel_startup_ok = false;
\t\tzend_accel_error_noreturn(
\t\t\tACCEL_LOG_FATAL,
\t\t\t\"Kandelo requires opcache.file_cache_only=1 because cross-process MAP_SHARED is unavailable.\");
\t\treturn SUCCESS;
\t}
#endif
\tfile_cache_only = ZCG(accel_directives).file_cache_only;
"""
if marker not in s:
    raise SystemExit("opcache file-cache-only guard: startup marker not found")
p.write_text(s.replace(marker, guard, 1))
PY
fi

# PHP's configure enables Zend max-execution timers only on Linux hosts even
# when --enable-zend-max-execution-timers is explicitly requested. Allow Wasm
# through that compile-time gate because the target-specific implementation
# above replaces Linux SIGEV_THREAD_ID with Kandelo's cooperative host hook;
# this does not claim that native thread-targeted timer delivery is available.
if [ -f configure ] && ! grep -q "wasm-zend-max-execution-timers patch applied" configure; then
    perl -i.bak -0pe "s/  \\*linux\\*\\) :\\n     ;; #\\(\\n  \\*\\) :\\n    ZEND_MAX_EXECUTION_TIMERS='no' ;;/  *linux*|wasm32*|wasm64*) :\\n     ;; #(\\n  *) :\\n    ZEND_MAX_EXECUTION_TIMERS='no' ;; # wasm-zend-max-execution-timers patch applied/" configure
    rm -f configure.bak
fi

# ext/sockets gates its Linux classic-BPF socket option implementation only on
# SO_ATTACH_REUSEPORT_CBPF. Kandelo's musl headers expose that socket option
# number but do not provide <linux/filter.h>'s `struct sock_filter`/
# `struct sock_fprog` definitions. Build the rest of the sockets extension and
# omit only the BPF option arm when the platform lacks those Linux filter
# declarations.
if [ -f ext/sockets/sockets.c ] \
   && ! grep -q "wasm-sockets-cbpf-guard patch applied" ext/sockets/sockets.c; then
    python3 - <<'PY'
from pathlib import Path
p = Path("ext/sockets/sockets.c")
s = p.read_text()
s = s.replace(
    "#ifdef SO_ATTACH_REUSEPORT_CBPF\n",
    "#if defined(SO_ATTACH_REUSEPORT_CBPF) && defined(HAVE_LINUX_FILTER_H) /* wasm-sockets-cbpf-guard patch applied */\n",
)
p.write_text(s)
PY
fi

echo "==> Configuring PHP for Wasm (CLI + FPM, single tree)..."
# Keep autoconf's cache inside the disposable build directory. Package builds
# must not race on or leave generated state in the registry recipe directory.
rm -f "$CONFIG_CACHE"
if [ -f Makefile ] && ! grep -q 'ext/zend_test' Makefile; then
    echo "==> Existing PHP Makefile lacks zend_test shared-extension rules; reconfiguring..."
    rm -f Makefile config.cache
fi
if [ -f Makefile ] && ! grep -q 'ext/zip' Makefile; then
    echo "==> Existing PHP Makefile lacks the zip shared-extension rules; reconfiguring..."
    rm -f Makefile config.cache
fi
if [ -f Makefile ] && grep -q -- '-rpath' Makefile; then
    echo "==> Existing PHP Makefile contains ELF rpath flags unsupported by wasm-ld; reconfiguring..."
    rm -f Makefile config.cache
fi
if [ -f Makefile ]; then
    # Keep the local configure output aligned with the PHPT coverage profile
    # this script now requests. These are bundled/general-purpose extensions,
    # not test-only shims; enabling them lets upstream PHPTs exercise the
    # Kandelo POSIX surface instead of being skipped as "extension not loaded".
    for ext in bcmath calendar dba ftp iconv pcntl posix shmop soap sockets sysvmsg sysvsem sysvshm; do
        if ! grep -q "phpext_${ext}_ptr" main/internal_functions.c 2>/dev/null; then
            echo "==> Existing PHP Makefile lacks ${ext}; reconfiguring..."
            rm -f Makefile config.cache
            break
        fi
    done
fi
if [ -f Makefile ] && ! grep -q '#define ICONV_ALIASED_LIBICONV 1' main/php_config.h 2>/dev/null; then
    echo "==> Existing PHP Makefile does not use GNU libiconv aliases; reconfiguring..."
    rm -f Makefile config.cache
fi
if [ -f Makefile ] && ! grep -q '^#define PHP_OS "Kandelo"$' main/php_config.h 2>/dev/null; then
    echo "==> Existing PHP Makefile embeds the build host OS; reconfiguring..."
    rm -f Makefile config.cache
fi
if [ ! -f Makefile ]; then
    # LDFLAGS notes (kept OUTSIDE the line-continuation block below
    # because `# comment` lines inside a `\`-continued bash block
    # terminate the continuation — env vars set on lines before the
    # comment apply only to the comment itself, which is a no-op
    # statement. The result: PKG_CONFIG_PATH was silently dropped on
    # the wasm32posix-configure invocation, libxml-2.0 lookup failed,
    # and the whole PHP build aborted at "Package requirements
    # (libxml-2.0 >= 2.9.0) were not met").
    #
    # -ldl: pulls libc/glue/dlopen.c into the link, providing the `dlopen`
    # symbol PHP uses to load Zend extensions like opcache.so. Without
    # this, PHP runs but reports "Dynamic loading not supported" when
    # `zend_extension=opcache` is set.
    #
    # -Wl,--export-all: exports every defined symbol from php.wasm so
    # opcache.so (a side module loaded via dlopen) can resolve its
    # imports against PHP main. Without this only the SDK's hand-picked
    # `__heap_base`/`__tls_base`/etc. are exported and opcache.so fails
    # to instantiate ("Import #N env.<sym>: function import requires a
    # callable"). The size cost (~5 MB) is worth the runtime correctness.
    #
    # -u<sym>: force the linker to pull these libc symbols out of
    # libc.a even though PHP itself doesn't call them. opcache.so
    # imports them (some are sandbox/security helpers it never actually
    # invokes on our wasm port — but the import has to resolve at
    # instantiation time).
    #
    # curl.so absorbs libcurl.a but deliberately leaves libc, zlib, and
    # OpenSSL unresolved so the process keeps one copy of each library's
    # state. The second -u group is the measured subset that base PHP does not
    # otherwise pull into php.wasm; --export-all then exposes those symbols to
    # the side module. The post-build import-closure test guards this list.
    # The following group forces libc symbols intl.so imports but base PHP
    # never references (allocator, wide-char, math, and the pthread mutex/
    # cond/TLS that ICU's UMutex uses). They must resolve to php.wasm's own
    # musl so intl.so shares one libc state — one allocator, one pthread key
    # table; without -u they never enter php.wasm and intl.so fails to load.
    #
    # -Wl,-z,stack-size=4194304: 4 MB wasm stack. The default wasm-ld
    # stack is 64 KB, which sits ~100 KB above PHP's `alloc_globals`
    # data segment. Opcache's PASS_6 (DFA-based SSA optimization) calls
    # zend_build_ssa, which uses do_alloca() for its DFG bitsets and
    # var-rename worklist; on large functions like WordPress's
    # wp-includes/ID3/module.audio-video.asf.php Analyze() (1700+ lines),
    # the alloca'd buffer plus the deep zend_ssa_rename recursion can
    # underflow the stack into alloc_globals, scribbling garbage onto
    # AG(mm_heap). The next _efree call then traps with "memory access
    # out of bounds" because it tries to dereference the now-bogus heap
    # pointer. 4 MB gives PASS_6 enough headroom for any function that
    # passes its own `blocks*vars > 4M` size guard.
    #
    # ac_cv_lib_iconv_libiconv=yes: PHP's autoconf probe calls `libiconv()`
    # with an old-style no-argument prototype. That is tolerated by native ELF
    # linkers but invalid for WebAssembly's typed call graph, so wasm-ld rejects
    # the probe before configure can discover that GNU libiconv's header maps
    # iconv/iconv_open/iconv_close to libiconv/libiconv_open/libiconv_close.
    # Preseeding the cache with the known result keeps the cross-compile build
    # aligned with the actual library/header ABI rather than falling back to
    # musl's narrower iconv implementation.
    #
    # ac_cv_lib_zip_*: PHP checks newer libzip APIs by linking each probe into
    # the complete PHP dependency graph. On this cross target, unrelated
    # archive members can make that whole-program probe fail even though a
    # direct link against the exact resolver-built libzip archive succeeds.
    # Seed only symbols verified by the libzip recipe's upstream source graph;
    # this preserves the actual 1.11.4 API instead of silently compiling an
    # older, reduced ZipArchive surface.
    #
    # musl exposes Linux unshare() as an ENOSYS stub. PHP must not advertise
    # pcntl_unshare() when this target cannot provide namespace isolation, so
    # override the cross probe with the target's real capability.
    PKG_CONFIG_PATH="$DEP_PKG_CONFIG_PATH" \
    CPPFLAGS="$DEP_CPPFLAGS" \
    LDFLAGS="$DEP_LDFLAGS -ldl -Wl,--export-all \
-u setgid -u setuid -u initgroups -u writev -u asctime \
-u rand -u srand -u remove \
-u inet_pton -u inet_ntop -u sched_yield -u alarm -u basename \
-u OCSP_basic_verify -u OCSP_cert_status_str -u OCSP_crl_reason_str \
-u OCSP_response_status_str -u SSL_alert_desc_string_long \
-u aligned_alloc -u div -u modf -u round -u tanhf \
-u swprintf -u wcstod -u wcstof -u wcstol -u wcstold \
-u wcstoll -u wcstoul -u wcstoull -u wmemchr -u wmemcmp \
-u pthread_cond_broadcast -u pthread_cond_destroy -u pthread_cond_signal \
-u pthread_cond_timedwait -u pthread_cond_wait -u pthread_detach \
-u pthread_getspecific -u pthread_key_create -u pthread_self \
-u pthread_setspecific \
-Wl,-z,stack-size=4194304" \
    ZLIB_CFLAGS="$ZLIB_CFLAGS_VALUE" \
    ZLIB_LIBS="$ZLIB_LIBS_VALUE" \
    SQLITE_CFLAGS="$SQLITE_CFLAGS_VALUE" \
    SQLITE_LIBS="$SQLITE_LIBS_VALUE" \
    OPENSSL_CFLAGS="$OPENSSL_CFLAGS_VALUE" \
    OPENSSL_LIBS="$OPENSSL_LIBS_VALUE" \
    LIBXML_CFLAGS="$LIBXML_CFLAGS_VALUE" \
    LIBXML_LIBS="$LIBXML_LIBS_VALUE" \
    ICONV_CFLAGS="$ICONV_CFLAGS_VALUE" \
    ICONV_LIBS="$ICONV_LIBS_VALUE" \
    LIBZIP_CFLAGS="$LIBZIP_CFLAGS_VALUE" \
    LIBZIP_LIBS="$LIBZIP_LIBS_VALUE" \
    ac_cv_lib_zip_zip_file_set_mtime=yes \
    ac_cv_lib_zip_zip_file_set_encryption=yes \
    ac_cv_lib_zip_zip_libzip_version=yes \
    ac_cv_lib_zip_zip_register_progress_callback_with_state=yes \
    ac_cv_lib_zip_zip_register_cancel_callback_with_state=yes \
    ac_cv_lib_zip_zip_compression_method_supported=yes \
    CURL_CFLAGS="$CURL_CFLAGS_VALUE" \
    CURL_LIBS="$CURL_LIBS_VALUE" \
    PHP_UNAME="Kandelo wasm32-posix-kernel" \
    ac_cv_lib_iconv_libiconv=yes \
    ac_cv_lib_curl_curl_easy_perform=yes \
    ac_cv_func_unshare=no \
    wasm32posix-configure \
        --disable-all \
        --disable-rpath \
        --disable-cgi \
        --disable-phpdbg \
        --enable-cli \
        --enable-fpm \
        --enable-opcache \
        --enable-intl=shared \
        --enable-mbstring \
        --disable-mbregex \
        --enable-ctype \
        --enable-tokenizer \
        --enable-filter \
        --enable-bcmath \
        --enable-calendar \
        --enable-dba \
        --enable-ftp \
        --with-iconv="$LIBICONV_PREFIX" \
        --with-curl=shared \
        --enable-pcntl \
        --enable-phar=shared \
        --enable-posix \
        --enable-shmop \
        --enable-soap \
        --enable-sockets \
        --enable-sysvmsg \
        --enable-sysvsem \
        --enable-sysvshm \
        --enable-zend-test=shared \
        --without-valgrind \
        --without-pcre-jit \
        --disable-fiber-asm \
        --disable-zend-signals \
        --enable-zend-max-execution-timers \
        --enable-session \
        --with-sqlite3 \
        --enable-pdo \
        --with-pdo-sqlite \
        --with-pdo-mysql=mysqlnd \
        --with-mysqli=mysqlnd \
        --enable-fileinfo \
        --enable-exif \
        --with-zlib \
        --with-openssl \
        --with-libxml \
        --enable-xml \
        --enable-dom \
        --enable-simplexml \
        --enable-xmlreader \
        --enable-xmlwriter \
        --with-zip=shared \
        --cache-file="$CONFIG_CACHE" \
        --prefix="$GUEST_PREFIX" \
        --sysconfdir=/etc \
        --localstatedir=/var \
        --with-config-file-path=/etc \
        --with-config-file-scan-dir=/etc/php.d \
        CFLAGS="-O2 -gline-tables-only $REPRODUCIBLE_PREFIX_MAPS -DZEND_USE_ASM_ARITHMETIC=0"
    # CFLAGS includes -gline-tables-only for debug stack traces.
    # The debug-trace value is worth keeping. CLI inherits the same
    # flags; it just produces a slightly larger binary.

    # Patch config.h: disable features that pass link-time checks
    # (--allow-undefined) but are not currently usable through Kandelo's PHP
    # runtime. In particular, the musl resolver exposes res_search(3), but
    # PHP's DNS record APIs can block on external DNS record queries in generic
    # arginfo probes. Disable the DNS search-family feature macros together so
    # PHP does not register dns_get_record()/dns_get_mx() without a usable
    # resolver backend.
    echo "==> Patching main/php_config.h for Wasm..."
    sed -i.bak \
        -e 's/^#define HAVE_DNS_SEARCH 1/\/* #undef HAVE_DNS_SEARCH *\//' \
        -e 's/^#define HAVE_DNS_SEARCH_FUNC 1/\/* #undef HAVE_DNS_SEARCH_FUNC *\//' \
        -e 's/^#define HAVE_RES_NSEARCH 1/\/* #undef HAVE_RES_NSEARCH *\//' \
        -e 's/^#define HAVE_RES_NDESTROY 1/\/* #undef HAVE_RES_NDESTROY *\//' \
        -e 's/^#define HAVE_RES_SEARCH 1/\/* #undef HAVE_RES_SEARCH *\//' \
        -e 's/^#define HAVE_FUNOPEN 1/\/* #undef HAVE_FUNOPEN *\//' \
        -e 's/^#define HAVE_STD_SYSLOG 1/\/* #undef HAVE_STD_SYSLOG *\//' \
        -e 's/^#define HAVE_SETPROCTITLE 1/\/* #undef HAVE_SETPROCTITLE *\//' \
        -e 's/^#define HAVE_SETPROCTITLE_FAST 1/\/* #undef HAVE_SETPROCTITLE_FAST *\//' \
        -e 's/^#define HAVE_RAND_EGD 1/\/* #undef HAVE_RAND_EGD *\//' \
        -e 's/^#define HAVE_FORKX 1/\/* #undef HAVE_FORKX *\//' \
        -e 's/^#define HAVE_RFORK 1/\/* #undef HAVE_RFORK *\//' \
        -e 's/^#define PHP_OS .*/#define PHP_OS "Kandelo"/' \
        -e 's/^#define PHP_UNAME .*/#define PHP_UNAME "Kandelo wasm32-posix-kernel"/' \
        main/php_config.h && rm -f main/php_config.h.bak

    # Do not bake the host build prefix into PHP's runtime extension_dir.
    # Upstream configure expands it from --prefix, but Kandelo programs run in
    # a guest filesystem where the build checkout does not exist. Use the
    # guest path populated by the VFS images and mounted by the PHPT harness so
    # normal PHP invocations like `php -n -d extension=phar.so` work without
    # requiring absolute, harness-specific extension paths.
    sed -i.bak \
        -e 's|^#define CONFIGURE_COMMAND .*|#define CONFIGURE_COMMAND "Kandelo reproducible package build"|' \
        -e 's|^#define PHP_EXTENSION_DIR .*|#define PHP_EXTENSION_DIR       "/usr/lib/php/extensions"|' \
        main/build-defs.h && rm -f main/build-defs.h.bak

    # Remove -MMD/-MF/-MT dependency tracking flags from Makefile.
    # libtool doesn't understand these flags and misidentifies the source file,
    # causing "mv: rename foo.o" errors during compilation.
    echo "==> Patching Makefile to remove dependency tracking flags..."
    sed -i.bak \
        -e 's/ -MMD -MF [^ ]* -MT [^ ]*//g' \
        Makefile && rm -f Makefile.bak

    # Patch libtool to allow shared-library builds. PHP's configure
    # detects our wasm cross-compile target as not supporting shared
    # libraries (`build_libtool_libs=no`) — when libtool then sees
    # `-shared` in opcache's link command it calls
    # `func_fatal_configuration` which is not even defined in this
    # libtool variant, so the make rule dies with
    # `func_fatal_configuration: command not found`. Flip the flag so
    # libtool emits PIC-compiled `.libs/*.o` objects from the
    # opcache `.lo` rules; we then link `opcache.so` directly with
    # `wasm32posix-cc -shared` after `make`.
    echo "==> Patching libtool to enable shared-library mode..."
    sed -i.bak 's/^build_libtool_libs=no$/build_libtool_libs=yes/' libtool \
        && rm -f libtool.bak
fi

if [ -f main/build-defs.h ]; then
    sed -i.bak \
        -e 's|^#define CONFIGURE_COMMAND .*|#define CONFIGURE_COMMAND "Kandelo reproducible package build"|' \
        -e 's|^#define PHP_EXTENSION_DIR .*|#define PHP_EXTENSION_DIR       "/usr/lib/php/extensions"|' \
        main/build-defs.h && rm -f main/build-defs.h.bak
fi

# SQLite's feature probes are link probes, and the SDK links with
# -Wl,--allow-undefined. A call to a symbol libsqlite3.a does not export still
# links, so the probe reports "present" for everything and AC_DEFINEs the macro
# either way. The probe therefore cannot be trusted: pin each macro to what the
# Kandelo SQLite package actually ships.
#
# sqlite3_expanded_sql() and the column-metadata family
# (sqlite3_column_table_name() and friends) are present — the latter because
# libsqlite3.a is built with -DSQLITE_ENABLE_COLUMN_METADATA, see
# packages/registry/sqlite/build-sqlite.sh. Runtime loadable extensions are
# intentionally omitted.
#
# Both directions matter. A macro left defined for a symbol the package does not
# export lets wasm-ld emit it as an `env.` import, which worker-main.ts fills
# with a throwing stub: the first call kills the *calling process* (the host
# reports the trap and the kernel marks that pid SIGSEGV-terminated; the kernel
# itself is unaffected). A macro undefined for a symbol the package does export
# silently compiles the feature out — here, the "table" key of
# PDOStatement::getColumnMeta() (#577).
# PHP's fopencookie probe is also distorted by wasm cross-linking. Kandelo's
# musl sysroot provides fopencookie(3), and PHP uses it for generic stream →
# stdio casts rather than requiring every user stream wrapper to implement its
# own stream_cast method.
if [ -f main/php_config.h ]; then
    sed -i.bak \
        -e 's|^/\* #undef HAVE_SQLITE3_EXPANDED_SQL \*/|#define HAVE_SQLITE3_EXPANDED_SQL 1|' \
        -e 's|^/\* #undef HAVE_SQLITE3_COLUMN_TABLE_NAME \*/|#define HAVE_SQLITE3_COLUMN_TABLE_NAME 1|' \
        -e 's|^/\* #undef SQLITE_OMIT_LOAD_EXTENSION \*/|#define SQLITE_OMIT_LOAD_EXTENSION 1|' \
        -e 's|^/\* #undef HAVE_FOPENCOOKIE \*/|#define HAVE_FOPENCOOKIE 1|' \
        -e 's|^/\* #undef HAVE_PRCTL \*/|#define HAVE_PRCTL 1|' \
        -e 's|^#define HAVE_FORKX 1|/* #undef HAVE_FORKX */|' \
        -e 's|^#define HAVE_RFORK 1|/* #undef HAVE_RFORK */|' \
        -e 's|^#define PHP_OS .*|#define PHP_OS "Kandelo"|' \
        -e 's|^#define PHP_UNAME .*|#define PHP_UNAME "Kandelo wasm32-posix-kernel"|' \
        main/php_config.h && rm -f main/php_config.h.bak
    # PHP's generated object dependencies do not reliably notice the
    # php_config.h feature override above after an incremental rebuild. Force
    # the stream-casting unit to be rebuilt so generic stream→FILE* casts use
    # fopencookie instead of falling back to wrapper-specific stream_cast hooks.
    rm -f main/streams/cast.o main/streams/cast.lo main/streams/.libs/cast.o
    rm -f ext/pcntl/pcntl.o ext/pcntl/pcntl.lo ext/pcntl/.libs/pcntl.o
    # pdo_sqlite reads HAVE_SQLITE3_COLUMN_TABLE_NAME at compile time to decide
    # whether getColumnMeta() reports a "table" key. Rebuild the statement unit
    # so an incremental tree does not keep an object compiled before the
    # override above.
    rm -f ext/pdo_sqlite/sqlite_statement.o ext/pdo_sqlite/sqlite_statement.lo \
        ext/pdo_sqlite/.libs/sqlite_statement.o
    # The same dependency-tracking gap can leave ext/iconv compiled against an
    # older config after switching from musl iconv to GNU libiconv. Rebuild this
    # unit so the libiconv header aliases are reflected in the final binary.
    if grep -q '#define ICONV_ALIASED_LIBICONV 1' main/php_config.h; then
        rm -f ext/iconv/iconv.o ext/iconv/iconv.lo ext/iconv/.libs/iconv.o
    fi
fi

# `make` per-file rules embed `INCLUDES` from configure but ignore
# `CPPFLAGS` (which only contains `-D_GNU_SOURCE`); `INCLUDES` for
# our libxml2 ends up as `-I.../include/libxml` because PHP's
# `ext/libxml/config.m4` adds the `/libxml` suffix. The real PHP
# sources `#include <libxml/parser.h>`, which needs the parent
# `-I.../include`. Pass it via `EXTRA_CFLAGS`, which the per-file
# rules append last.
EXTRA_INC_LIBXML="-I${LIBXML2_PREFIX}/include"

echo "==> Building PHP CLI..."
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" EXTRA_CFLAGS="$EXTRA_INC_LIBXML" cli

echo "==> Building PHP FPM..."
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" EXTRA_CFLAGS="$EXTRA_INC_LIBXML" fpm

echo "==> Both PHP binaries built successfully!"

FORK_INSTRUMENT="$REPO_ROOT/scripts/run-wasm-fork-instrument.sh"

# Build opcache as a shared Zend extension (.so side module).
# PHP's `make` produces PIC-compiled `.libs/ext/opcache/*.o` because
# opcache's `[[outputs]]` config is "always shared", but the bundled
# libtool refuses to emit the final `.so` on this target (see the
# build_libtool_libs patch above). Skip libtool's link step entirely
# and feed the PIC objects to the SDK's `wasm32posix-cc -shared`,
# which routes through `wasm-ld --shared --experimental-pic`.
echo "==> Building opcache.so (Zend extension)..."
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" \
    EXTRA_CFLAGS="$EXTRA_INC_LIBXML" \
    ext/opcache/ZendAccelerator.lo \
    ext/opcache/zend_accelerator_blacklist.lo \
    ext/opcache/zend_accelerator_debug.lo \
    ext/opcache/zend_accelerator_hash.lo \
    ext/opcache/zend_accelerator_module.lo \
    ext/opcache/zend_persist.lo \
    ext/opcache/zend_persist_calc.lo \
    ext/opcache/zend_file_cache.lo \
    ext/opcache/zend_shared_alloc.lo \
    ext/opcache/zend_accelerator_util_funcs.lo \
    ext/opcache/shared_alloc_shm.lo \
    ext/opcache/shared_alloc_mmap.lo \
    ext/opcache/shared_alloc_posix.lo
wasm32posix-cc -shared -fPIC -o "$BIN_DIR/opcache.so" \
    ext/opcache/.libs/ZendAccelerator.o \
    ext/opcache/.libs/zend_accelerator_blacklist.o \
    ext/opcache/.libs/zend_accelerator_debug.o \
    ext/opcache/.libs/zend_accelerator_hash.o \
    ext/opcache/.libs/zend_accelerator_module.o \
    ext/opcache/.libs/zend_persist.o \
    ext/opcache/.libs/zend_persist_calc.o \
    ext/opcache/.libs/zend_file_cache.o \
    ext/opcache/.libs/zend_shared_alloc.o \
    ext/opcache/.libs/zend_accelerator_util_funcs.o \
    ext/opcache/.libs/shared_alloc_shm.o \
    ext/opcache/.libs/shared_alloc_mmap.o \
    ext/opcache/.libs/shared_alloc_posix.o
echo "==> Applying fork instrumentation to opcache.so side module..."
"$FORK_INSTRUMENT" "$BIN_DIR/opcache.so" -o "$BIN_DIR/opcache.so.instr" --entry env.fork
mv "$BIN_DIR/opcache.so.instr" "$BIN_DIR/opcache.so"
echo "==> opcache.so: $(wc -c < "$BIN_DIR/opcache.so") bytes"

# Build ext/curl as a normal shared PHP extension. libcurl.a is PIC and is
# absorbed into curl.so; libc, zlib, and OpenSSL remain imports from php.wasm
# so dlopen does not create duplicate process-global library state.
echo "==> Building curl.so (extension)..."
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" \
    EXTRA_CFLAGS="$EXTRA_INC_LIBXML -I$LIBCURL_PREFIX/include -DCURL_STATICLIB" \
    ext/curl/interface.lo \
    ext/curl/multi.lo \
    ext/curl/share.lo \
    ext/curl/curl_file.lo
wasm32posix-cc -shared -fPIC -o "$BIN_DIR/curl.so" \
    ext/curl/.libs/interface.o \
    ext/curl/.libs/multi.o \
    ext/curl/.libs/share.o \
    ext/curl/.libs/curl_file.o \
    "$LIBCURL_PREFIX/lib/libcurl.a"
echo "==> curl.so: $(wc -c < "$BIN_DIR/curl.so") bytes"

# Build Phar as a shared extension too. The PHP package intentionally keeps
# shared extensions loadable through normal `extension=...` INI directives so
# subprocesses and PHPT fixtures that opt in to extensions use the same path as
# a general PHP runtime. Shipping phar.so avoids relying on a statically linked
# Phar module while still letting callers decide whether to load it.
echo "==> Building phar.so (extension)..."
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" \
    EXTRA_CFLAGS="$EXTRA_INC_LIBXML" \
    ext/phar/util.lo \
    ext/phar/tar.lo \
    ext/phar/zip.lo \
    ext/phar/stream.lo \
    ext/phar/func_interceptors.lo \
    ext/phar/dirstream.lo \
    ext/phar/phar.lo \
    ext/phar/phar_object.lo \
    ext/phar/phar_path_check.lo
wasm32posix-cc -shared -fPIC -o "$BIN_DIR/phar.so" \
    ext/phar/.libs/dirstream.o \
    ext/phar/.libs/func_interceptors.o \
    ext/phar/.libs/phar.o \
    ext/phar/.libs/phar_object.o \
    ext/phar/.libs/phar_path_check.o \
    ext/phar/.libs/stream.o \
    ext/phar/.libs/tar.o \
    ext/phar/.libs/util.o \
    ext/phar/.libs/zip.o
echo "==> phar.so: $(wc -c < "$BIN_DIR/phar.so") bytes"

# Build zend_test as a normal shared extension. Upstream php-src uses this
# extension to exercise engine edge cases through --EXTENSIONS--. Shipping it
# as an opt-in module keeps the PHP runtime general-purpose while letting the
# PHPT harness run those tests without pretending the extension is present.
echo "==> Building zend_test.so (extension)..."
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" \
    EXTRA_CFLAGS="$EXTRA_INC_LIBXML" \
    ext/zend_test/test.lo \
    ext/zend_test/observer.lo \
    ext/zend_test/fiber.lo \
    ext/zend_test/iterators.lo \
    ext/zend_test/object_handlers.lo
wasm32posix-cc -shared -fPIC -o "$BIN_DIR/zend_test.so" \
    ext/zend_test/.libs/*.o
echo "==> zend_test.so: $(wc -c < "$BIN_DIR/zend_test.so") bytes"

# Build ext/zip as a normal shared PHP extension. libzip is linked statically
# into the side module; its zlib and libc/PHP imports resolve from php.wasm,
# whose --export-all link is forced to retain the few libc functions used only
# by libzip.
echo "==> Building zip.so (extension)..."
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" \
    EXTRA_CFLAGS="$EXTRA_INC_LIBXML -I$LIBZIP_PREFIX/include" \
    ext/zip/php_zip.lo \
    ext/zip/zip_stream.lo
wasm32posix-cc -shared -fPIC -o "$BIN_DIR/zip.so" \
    ext/zip/.libs/php_zip.o \
    ext/zip/.libs/zip_stream.o \
    "$LIBZIP_PREFIX/lib/libzip.a"
echo "==> zip.so: $(wc -c < "$BIN_DIR/zip.so") bytes"

# Build intl as a shared .so, same libtool workaround as opcache: make compiles
# the PIC objects under ext/intl/**/.libs/ but the bundled libtool can't emit the
# final .so on this target, so we link it with `wasm32posix-cc -shared`. intl
# statically absorbs ICU and libc++/libc++abi so neither enters php.wasm; the ICU
# common data stays out of the .so as icu.dat (loaded by intl-icu-data-loader.c).
echo "==> Building intl.so (PHP extension)..."
# Ask PHP's generated Makefile for the shared extension's complete object list
# and build those targets directly. Invoking intl.la would deliberately reach
# the unsupported libtool side-module link, while `|| true` would also hide a
# genuine compile failure and could link a partial extension.
INTL_LO_TARGETS_RAW="$(make -s --no-print-directory -f Makefile -f - print-intl-objects <<'MAKE'
.PHONY: print-intl-objects
print-intl-objects:
	@printf '%s\n' $(shared_objects_intl)
MAKE
)"
mapfile -t INTL_LO_TARGETS <<< "$INTL_LO_TARGETS_RAW"
[ "${#INTL_LO_TARGETS[@]}" -gt 0 ] || {
    echo "ERROR: PHP Makefile did not declare shared_objects_intl" >&2
    exit 1
}
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" \
    EXTRA_CFLAGS="$EXTRA_INC_LIBXML" \
    "${INTL_LO_TARGETS[@]}"

# Compile the icu.dat loader (PIC) that feeds ICU its common data at dlopen.
wasm32posix-cc -fPIC -O2 -c "$SCRIPT_DIR/intl-icu-data-loader.c" \
    -I"$ICU_PREFIX/include" -o ext/intl/kandelo_icu_data_loader.o

# Collect every PIC object libtool produced for ext/intl (top dir + the
# collator/, dateformat/, formatter/, … subdirs each have their own .libs/).
mapfile -t INTL_OBJS < <(find ext/intl -path '*/.libs/*.o' | sort)
[ "${#INTL_OBJS[@]}" -gt 0 ] || { echo "ERROR: no ext/intl PIC objects found — did 'make ext/intl/intl.la' compile?" >&2; exit 1; }
echo "==> linking intl.so from ${#INTL_OBJS[@]} objects + ICU static libs + libc++"

# wasm-ld resolves archive back-references without --start-group, so the ICU
# archives are listed in dependency order (i18n -> io -> uc -> data), then
# libc++/libc++abi. A -shared PIC module requires every input to be PIC, so the
# libc++ PIC variants are named explicitly to win over the non-PIC sysroot ones.
wasm32posix-cc -shared -fPIC -Wl,--export=__tls_base -o "$BIN_DIR/intl.so" \
    "${INTL_OBJS[@]}" \
    ext/intl/kandelo_icu_data_loader.o \
    "$ICU_PREFIX/lib/libicui18n.a" \
    "$ICU_PREFIX/lib/libicuio.a" \
    "$ICU_PREFIX/lib/libicuuc.a" \
    "$ICU_PREFIX/lib/libicudata.a" \
    "$LIBCXX_PREFIX/lib/libc++-pic.a" \
    "$LIBCXX_PREFIX/lib/libc++abi-pic.a"
echo "==> intl.so: $(wc -c < "$BIN_DIR/intl.so") bytes"

# Make the program package's runtime closure self-contained. ICU remains the
# build dependency/source of truth; PHP's archive carries these exact resolved
# bytes so normal local/fetched materialization can stage the declared guest
# file without inspecting the library cache.
cp "$ICU_PREFIX/share/icu.dat" "$BIN_DIR/icu.dat"
chmod 0644 "$BIN_DIR/icu.dat"

# Copy to bin/ with .wasm extension (needed for Vite browser demos)
cp sapi/cli/php "$BIN_DIR/php.wasm"
cp sapi/fpm/php-fpm "$BIN_DIR/php-fpm.wasm"

# CLI and FPM both retain libc paths that can reach kernel_fork
# (system/popen/fork wrappers for CLI, worker forks for FPM), so both
# must be fork-instrumented. wasm-opt runs first, then fork
# instrumentation as the tail step because the instrumenter hardcodes
# mutable-global offsets and any later pass that reorders globals would
# invalidate them. wasm-fork-instrument auto-discovers fork paths via
# call-graph analysis; no onlylist file is required.
WASM_OPT="$(command -v wasm-opt 2>/dev/null || true)"
if [ -z "$WASM_OPT" ]; then
    echo "ERROR: wasm-opt is required for deterministic PHP package outputs" >&2
    exit 1
fi
echo "==> Optimizing CLI binary with wasm-opt -O2..."
"$WASM_OPT" -O2 "$BIN_DIR/php.wasm" -o "$BIN_DIR/php.wasm"

echo "==> Optimizing FPM binary with wasm-opt -O2..."
"$WASM_OPT" -O2 "$BIN_DIR/php-fpm.wasm" -o "$BIN_DIR/php-fpm.wasm"

echo "==> Applying fork instrumentation to CLI..."
"$FORK_INSTRUMENT" "$BIN_DIR/php.wasm" -o "$BIN_DIR/php.wasm.instr"
mv "$BIN_DIR/php.wasm.instr" "$BIN_DIR/php.wasm"

echo "==> Applying fork instrumentation to FPM..."
"$FORK_INSTRUMENT" "$BIN_DIR/php-fpm.wasm" -o "$BIN_DIR/php-fpm.wasm.instr"
mv "$BIN_DIR/php-fpm.wasm.instr" "$BIN_DIR/php-fpm.wasm"

chmod 0755 "$BIN_DIR/php.wasm" "$BIN_DIR/php-fpm.wasm"

ls -la "$BIN_DIR/php.wasm" "$BIN_DIR/php-fpm.wasm"

# Install into local-binaries/ so the resolver picks the freshly-built
# binaries over the fetched release.
if [ -z "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    source "$REPO_ROOT/scripts/install-local-binary.sh"
    install_local_binary php "$BIN_DIR/php.wasm" php.wasm
    install_local_binary php "$BIN_DIR/php-fpm.wasm" php-fpm.wasm
    install_local_binary php "$BIN_DIR/opcache.so"
    install_local_binary php "$BIN_DIR/curl.so"
    install_local_binary php "$BIN_DIR/phar.so"
    install_local_binary php "$BIN_DIR/zend_test.so"
    install_local_binary php "$BIN_DIR/zip.so"
    install_local_binary php "$BIN_DIR/intl.so"
    install_local_runtime_file php "$BIN_DIR/icu.dat"
fi
