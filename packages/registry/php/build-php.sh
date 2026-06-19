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

PHP_VERSION="${PHP_VERSION:-8.3.15}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$SCRIPT_DIR/php-src"
INSTALL_DIR="$SCRIPT_DIR/php-install"

REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
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
    (cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TARGET" --quiet -- build-deps resolve "$name")
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
[ -f "$ZLIB_PREFIX/lib/libz.a" ] || { echo "ERROR: zlib resolve missing libz.a"; exit 1; }
[ -f "$SQLITE_PREFIX/lib/libsqlite3.a" ] || { echo "ERROR: sqlite resolve missing libsqlite3.a"; exit 1; }
[ -f "$OPENSSL_PREFIX/lib/libssl.a" ] || { echo "ERROR: openssl resolve missing libssl.a"; exit 1; }
[ -f "$LIBXML2_PREFIX/lib/libxml2.a" ] || { echo "ERROR: libxml2 resolve missing libxml2.a"; exit 1; }
[ -f "$LIBICONV_PREFIX/lib/libiconv.a" ] || { echo "ERROR: GNU libiconv resolve missing libiconv.a"; exit 1; }
echo "==> zlib at $ZLIB_PREFIX"
echo "==> sqlite at $SQLITE_PREFIX"
echo "==> openssl at $OPENSSL_PREFIX"
echo "==> libxml2 at $LIBXML2_PREFIX"
echo "==> GNU libiconv at $LIBICONV_PREFIX"

# Compose PKG_CONFIG_PATH for all deps so wasm32posix-configure's
# pkg-config probes can find them in the cache instead of the sysroot.
DEP_PKG_CONFIG_PATH="$ZLIB_PREFIX/lib/pkgconfig:$SQLITE_PREFIX/lib/pkgconfig:$OPENSSL_PREFIX/lib/pkgconfig:$LIBXML2_PREFIX/lib/pkgconfig:$LIBICONV_PREFIX/lib/pkgconfig"

# Compose -I and -L flags for defense-in-depth (autoconf raw probes).
DEP_CPPFLAGS="-I$ZLIB_PREFIX/include -I$SQLITE_PREFIX/include -I$OPENSSL_PREFIX/include -I$LIBXML2_PREFIX/include -I$LIBICONV_PREFIX/include"
DEP_LDFLAGS="-L$ZLIB_PREFIX/lib -L$SQLITE_PREFIX/lib -L$OPENSSL_PREFIX/lib -L$LIBXML2_PREFIX/lib -L$LIBICONV_PREFIX/lib"

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

if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading PHP $PHP_VERSION..."
    TARBALL="php-${PHP_VERSION}.tar.gz"
    curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors -fsSL "https://www.php.net/distributions/${TARBALL}" -o "/tmp/${TARBALL}"
    mkdir -p "$SRC_DIR"
    tar xzf "/tmp/${TARBALL}" -C "$SRC_DIR" --strip-components=1
    rm "/tmp/${TARBALL}"
fi

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
    "static zend_always_inline void zend_wasm_arm_hard_timeout(zend_long seconds)\n"
    "{\n"
    "\tzend_hrtime_t now = zend_hrtime();\n"
    "\tzend_hrtime_t hard_ns = zend_wasm_timeout_seconds_to_ns(seconds);\n"
    "\tzend_wasm_timeout_deadline = 0;\n"
    "\tzend_wasm_hard_timeout_deadline = zend_wasm_deadline_after(now, hard_ns);\n"
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
    "\tzend_set_timeout_ex(0, 1);\n"
    "# if defined(__wasm32__) || defined(__wasm64__)\n"
    "\tif (EG(hard_timeout) > 0) {\n"
    "\t\tzend_wasm_arm_hard_timeout(EG(hard_timeout));\n"
    "\t\t__wasm_posix_vm_interrupt_after(&EG(timed_out), &EG(vm_interrupt), EG(hard_timeout));\n"
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

# opcache's MAP_ANON shared-memory probe is an AC_RUN_IFELSE that fails
# under cross-compilation; the fallback only sets have_shm_mmap_anon=yes
# for *linux* hosts (configure ext/opcache/config.m4). Without this
# patch, configure rejects --enable-opcache with "No supported shared
# memory caching support". For our wasm target the runtime semantics
# are fine: each php-fpm worker is its own wasm instance, so an
# MAP_SHARED|MAP_ANON allocation is naturally per-process — exactly the
# per-worker opcache the user wants. Flip the cross-compile fallback's
# *) branch from "no" to "yes" so opcache builds. The pattern
# "      have_shm_mmap_anon=no" followed by "      ;;" appears only in
# that fallback (the AC_RUN_IFELSE failure branch is one-line:
# `e) have_shm_mmap_anon=no ;;`).
if [ -f configure ] && ! grep -q "wasm-opcache patch applied" configure; then
    perl -i.bak -0pe 's/      have_shm_mmap_anon=no\n      ;;/      have_shm_mmap_anon=yes\n      ;; # wasm-opcache patch applied/' configure
    rm -f configure.bak
fi

# PHP's configure enables Zend max-execution timers only on Linux hosts even
# when --enable-zend-max-execution-timers is explicitly requested. Kandelo's
# wasm target provides the Linux timer_create/timer_settime ABI, including the
# Linux SIGEV_THREAD_ID notification mode used by Zend, so allow wasm targets
# through the same configure gate. The follow-up timer_create probe still
# decides whether the feature is actually compiled in.
if [ -f configure ] && ! grep -q "wasm-zend-max-execution-timers patch applied" configure; then
    perl -i.bak -0pe "s/  \\*linux\\*\\) :\\n     ;; #\\(\\n  \\*\\) :\\n    ZEND_MAX_EXECUTION_TIMERS='no' ;;/  *linux*|wasm32*|wasm64*) :\\n     ;; #(\\n  *) :\\n    ZEND_MAX_EXECUTION_TIMERS='no' ;; # wasm-zend-max-execution-timers patch applied/" configure
    rm -f configure.bak
fi

# Default opcache.enable to "0" (was "1"). Rationale: PHP's built-in dev
# server (`php -S`) uses the cli-server SAPI, which IS in opcache's
# supported_sapis list (only the bare `cli` SAPI is gated by
# `opcache.enable_cli`). With the upstream default of "1", every CLI
# invocation under cli-server pays opcache MINIT cost (128MB SHM
# allocation + per-request validation) — heavy enough to push the
# wordpress-site-editor E2E test (packages/registry/wordpress/test/) past its
# 10-minute install deadline on CI runners. Our LAMP/WP/nginx-php
# php-fpm demos explicitly set opcache.enable=1 in /etc/php.ini, so
# flipping the compile-time default to "0" preserves the per-worker
# bytecode-cache win for FPM while leaving CLI / cli-server behavior
# pre-PR-identical.
if [ -f ext/opcache/zend_accelerator_module.c ] \
   && ! grep -q "wasm-opcache enable=0 patch applied" ext/opcache/zend_accelerator_module.c; then
    sed -i.bak \
        -e 's|STD_PHP_INI_BOOLEAN("opcache.enable"             , "1"|STD_PHP_INI_BOOLEAN("opcache.enable"             , "0"|' \
        ext/opcache/zend_accelerator_module.c
    # Drop a marker comment so re-running the patch is idempotent.
    if ! grep -q "wasm-opcache enable=0 patch applied" ext/opcache/zend_accelerator_module.c; then
        sed -i.bak2 '/STD_PHP_INI_BOOLEAN("opcache.enable"             , "0"/i\
/* wasm-opcache enable=0 patch applied — see packages/registry/php/build-php.sh */
' ext/opcache/zend_accelerator_module.c
    fi
    rm -f ext/opcache/zend_accelerator_module.c.bak ext/opcache/zend_accelerator_module.c.bak2
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
# Drop a stale config.cache from a previous build whose env (CPPFLAGS,
# PKG_CONFIG_PATH, etc.) may not match this run. autoconf would
# otherwise reject the cache with "changes in the environment can
# compromise the build" — recovering requires a fresh cache anyway.
rm -f "$SCRIPT_DIR/config.cache"
if [ -f Makefile ] && ! grep -q 'ext/zend_test' Makefile; then
    echo "==> Existing PHP Makefile lacks zend_test shared-extension rules; reconfiguring..."
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
    PKG_CONFIG_PATH="$DEP_PKG_CONFIG_PATH" \
    CPPFLAGS="$DEP_CPPFLAGS" \
    LDFLAGS="$DEP_LDFLAGS -ldl -Wl,--export-all \
-u setgid -u setuid -u initgroups -u writev -u asctime \
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
    ac_cv_lib_iconv_libiconv=yes \
    wasm32posix-configure \
        --disable-all \
        --disable-rpath \
        --disable-cgi \
        --disable-phpdbg \
        --enable-cli \
        --enable-fpm \
        --enable-opcache \
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
        --cache-file="$SCRIPT_DIR/config.cache" \
        --prefix="$INSTALL_DIR" \
        CFLAGS="-O2 -gline-tables-only -DZEND_USE_ASM_ARITHMETIC=0"
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
        main/php_config.h && rm -f main/php_config.h.bak

    # Do not bake the host build prefix into PHP's runtime extension_dir.
    # Upstream configure expands it from --prefix, but Kandelo programs run in
    # a guest filesystem where the build checkout does not exist. Use the
    # guest path populated by the VFS images and mounted by the PHPT harness so
    # normal PHP invocations like `php -n -d extension=phar.so` work without
    # requiring absolute, harness-specific extension paths.
    sed -i.bak \
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
        -e 's|^#define PHP_EXTENSION_DIR .*|#define PHP_EXTENSION_DIR       "/usr/lib/php/extensions"|' \
        main/build-defs.h && rm -f main/build-defs.h.bak
fi

# SQLite's feature probes can be distorted by cross-linker behavior even when
# the resolved library has the symbol. Keep the PHP build config aligned with
# the Kandelo SQLite package: sqlite3_expanded_sql() is always present in our
# SQLite 3.49.x build, and column metadata is enabled by the SQLite package so
# pdo_sqlite can expose table names without leaving unresolved imports.
# PHP's fopencookie probe is also distorted by wasm cross-linking. Kandelo's
# musl sysroot provides fopencookie(3), and PHP uses it for generic stream →
# stdio casts rather than requiring every user stream wrapper to implement its
# own stream_cast method.
if [ -f main/php_config.h ]; then
    sed -i.bak \
        -e 's|^/\* #undef HAVE_SQLITE3_EXPANDED_SQL \*/|#define HAVE_SQLITE3_EXPANDED_SQL 1|' \
        -e 's|^/\* #undef HAVE_SQLITE3_COLUMN_TABLE_NAME \*/|#define HAVE_SQLITE3_COLUMN_TABLE_NAME 1|' \
        -e 's|^/\* #undef HAVE_FOPENCOOKIE \*/|#define HAVE_FOPENCOOKIE 1|' \
        -e 's|^/\* #undef HAVE_PRCTL \*/|#define HAVE_PRCTL 1|' \
        -e 's|^#define HAVE_FORKX 1|/* #undef HAVE_FORKX */|' \
        -e 's|^#define HAVE_RFORK 1|/* #undef HAVE_RFORK */|' \
        main/php_config.h && rm -f main/php_config.h.bak
    # PHP's generated object dependencies do not reliably notice the
    # php_config.h feature override above after an incremental rebuild. Force
    # the stream-casting unit to be rebuilt so generic stream→FILE* casts use
    # fopencookie instead of falling back to wrapper-specific stream_cast hooks.
    rm -f main/streams/cast.o main/streams/cast.lo main/streams/.libs/cast.o
    rm -f ext/pcntl/pcntl.o ext/pcntl/pcntl.lo ext/pcntl/.libs/pcntl.o
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
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" EXTRA_CFLAGS="$EXTRA_INC_LIBXML" ext/opcache/opcache.la || true
mkdir -p "$SCRIPT_DIR/bin"
wasm32posix-cc -shared -fPIC -o "$SCRIPT_DIR/bin/opcache.so" \
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
"$FORK_INSTRUMENT" "$SCRIPT_DIR/bin/opcache.so" -o "$SCRIPT_DIR/bin/opcache.so.instr" --entry env.fork
mv "$SCRIPT_DIR/bin/opcache.so.instr" "$SCRIPT_DIR/bin/opcache.so"
echo "==> opcache.so: $(wc -c < "$SCRIPT_DIR/bin/opcache.so") bytes"

# Build Phar as a shared extension too. The PHP package intentionally keeps
# shared extensions loadable through normal `extension=...` INI directives so
# subprocesses and PHPT fixtures that opt in to extensions use the same path as
# a general PHP runtime. Shipping phar.so avoids relying on a statically linked
# Phar module while still letting callers decide whether to load it.
echo "==> Building phar.so (extension)..."
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" EXTRA_CFLAGS="$EXTRA_INC_LIBXML" ext/phar/phar.la || true
wasm32posix-cc -shared -fPIC -o "$SCRIPT_DIR/bin/phar.so" \
    ext/phar/.libs/dirstream.o \
    ext/phar/.libs/func_interceptors.o \
    ext/phar/.libs/phar.o \
    ext/phar/.libs/phar_object.o \
    ext/phar/.libs/phar_path_check.o \
    ext/phar/.libs/stream.o \
    ext/phar/.libs/tar.o \
    ext/phar/.libs/util.o \
    ext/phar/.libs/zip.o
echo "==> phar.so: $(wc -c < "$SCRIPT_DIR/bin/phar.so") bytes"

# Build zend_test as a normal shared extension. Upstream php-src uses this
# extension to exercise engine edge cases through --EXTENSIONS--. Shipping it
# as an opt-in module keeps the PHP runtime general-purpose while letting the
# PHPT harness run those tests without pretending the extension is present.
echo "==> Building zend_test.so (extension)..."
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" EXTRA_CFLAGS="$EXTRA_INC_LIBXML" ext/zend_test/zend_test.la || true
wasm32posix-cc -shared -fPIC -o "$SCRIPT_DIR/bin/zend_test.so" \
    ext/zend_test/.libs/*.o
echo "==> zend_test.so: $(wc -c < "$SCRIPT_DIR/bin/zend_test.so") bytes"

# Copy to bin/ with .wasm extension (needed for Vite browser demos)
mkdir -p "$SCRIPT_DIR/bin"
cp sapi/cli/php "$SCRIPT_DIR/bin/php.wasm"
cp sapi/fpm/php-fpm "$SCRIPT_DIR/bin/php-fpm.wasm"

# CLI and FPM both retain libc paths that can reach kernel_fork
# (system/popen/fork wrappers for CLI, worker forks for FPM), so both
# must be fork-instrumented. wasm-opt runs first, then fork
# instrumentation as the tail step because the instrumenter hardcodes
# mutable-global offsets and any later pass that reorders globals would
# invalidate them. wasm-fork-instrument auto-discovers fork paths via
# call-graph analysis; no onlylist file is required.
WASM_OPT="$(command -v wasm-opt 2>/dev/null || true)"
if [ -n "$WASM_OPT" ]; then
    echo "==> Optimizing CLI binary with wasm-opt -O2..."
    "$WASM_OPT" -O2 "$SCRIPT_DIR/bin/php.wasm" -o "$SCRIPT_DIR/bin/php.wasm"

    echo "==> Optimizing FPM binary with wasm-opt -O2..."
    "$WASM_OPT" -O2 "$SCRIPT_DIR/bin/php-fpm.wasm" -o "$SCRIPT_DIR/bin/php-fpm.wasm"
fi

echo "==> Applying fork instrumentation to CLI..."
"$FORK_INSTRUMENT" "$SCRIPT_DIR/bin/php.wasm" -o "$SCRIPT_DIR/bin/php.wasm.instr"
mv "$SCRIPT_DIR/bin/php.wasm.instr" "$SCRIPT_DIR/bin/php.wasm"

echo "==> Applying fork instrumentation to FPM..."
"$FORK_INSTRUMENT" "$SCRIPT_DIR/bin/php-fpm.wasm" -o "$SCRIPT_DIR/bin/php-fpm.wasm.instr"
mv "$SCRIPT_DIR/bin/php-fpm.wasm.instr" "$SCRIPT_DIR/bin/php-fpm.wasm"

chmod 0755 "$SCRIPT_DIR/bin/php.wasm" "$SCRIPT_DIR/bin/php-fpm.wasm"

ls -la "$SCRIPT_DIR/bin/php.wasm" "$SCRIPT_DIR/bin/php-fpm.wasm"

# Install into local-binaries/ so the resolver picks the freshly-built
# binaries over the fetched release.
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary php "$SCRIPT_DIR/bin/php.wasm"     php.wasm
install_local_binary php "$SCRIPT_DIR/bin/php-fpm.wasm" php-fpm.wasm
install_local_binary php "$SCRIPT_DIR/bin/opcache.so"
install_local_binary php "$SCRIPT_DIR/bin/phar.so"
install_local_binary php "$SCRIPT_DIR/bin/zend_test.so"
