#!/usr/bin/env bash
set -euo pipefail

# Build MariaDB 10.5 LTS for kandelo.
#
# Usage:
#   bash build-mariadb.sh           # build for wasm32 (ILP32)
#   bash build-mariadb.sh --wasm64  # build for wasm64 (LP64)
#
# Two-step cross-compilation:
#   1. Host build: generates import_executables.cmake (native helper programs)
#   2. Cross build: uses CMake toolchain file for wasm32 or wasm64

MARIADB_VERSION="${WASM_POSIX_DEP_VERSION:-${MARIADB_VERSION:-10.5.28}}"
MARIADB_MAJOR="10.5"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# Worktree-local SDK on PATH (no global npm link required).
# shellcheck source=/dev/null
source "$REPO_ROOT/sdk/activate.sh"
GLUE_DIR="$REPO_ROOT/libc/glue"

# Default to xtask resolver's WASM_POSIX_DEP_TARGET_ARCH (set per
# manifest arch at build-deps time); fall back to wasm32 outside the
# resolver. CLI flags override — useful for direct manual invocation.
# Without this, `cargo xtask build-deps` for the wasm64 mariadb target
# silently rebuilt wasm32 (env var ignored, no --wasm64 in argv) and
# left mariadb-install-64/ empty, breaking the downstream
# build-mariadb-vfs.sh wasm64 step.
WASM_ARCH="${WASM_POSIX_DEP_TARGET_ARCH:-wasm32}"
while [ $# -gt 0 ]; do
    case "$1" in
        --wasm32) WASM_ARCH="wasm32"; shift ;;
        --wasm64) WASM_ARCH="wasm64"; shift ;;
        *) echo "Unknown argument: $1" >&2; exit 1 ;;
    esac
done

# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots \
    "$SCRIPT_DIR/mariadb-work-$WASM_ARCH" "$WASM_ARCH"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://archive.mariadb.org/mariadb-${MARIADB_VERSION}/source/mariadb-${MARIADB_VERSION}.tar.gz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-0b5070208da0116640f20bd085f1136527f998cc23268715bcbf352e7b7f3cc1}"

if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    SRC_DIR="$KANDELO_PACKAGE_WORK_DIR/source"
    HOST_BUILD_DIR="$KANDELO_PACKAGE_WORK_DIR/host-build"
    CROSS_BUILD_BASE="$KANDELO_PACKAGE_WORK_DIR/cross-build"
    INSTALL_BASE="$KANDELO_PACKAGE_WORK_DIR/install"
    BUILD_STATE_ROOT="$KANDELO_PACKAGE_WORK_DIR"
else
    SRC_DIR="$SCRIPT_DIR/mariadb-src"
    HOST_BUILD_DIR="$SCRIPT_DIR/mariadb-host-build"
    CROSS_BUILD_BASE="$SCRIPT_DIR/mariadb-cross-build"
    INSTALL_BASE="$SCRIPT_DIR/mariadb-install"
    BUILD_STATE_ROOT="$SCRIPT_DIR"
fi

if [ "$WASM_ARCH" = "wasm64" ]; then
    CROSS_BUILD_DIR="${CROSS_BUILD_BASE}-64"
    INSTALL_DIR="${INSTALL_BASE}-64"
    TOOLCHAIN_FILE="$SCRIPT_DIR/wasm64-posix-toolchain.cmake"
    SDK_SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot64}"
    WASM_TARGET="wasm64-unknown-unknown"
    # LLVM 21 wasm64 backend has -O2 miscompilation bugs (sign-extension of i32 to i64
    # in table lookups). Use -O1 until the LLVM wasm64 backend matures.
    : "${MARIADB_OPT_LEVEL:=-O1}"
else
    CROSS_BUILD_DIR="$CROSS_BUILD_BASE"
    INSTALL_DIR="$INSTALL_BASE"
    TOOLCHAIN_FILE="$SCRIPT_DIR/wasm32-posix-toolchain.cmake"
    SDK_SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"
    WASM_TARGET="wasm32-unknown-unknown"
fi
export WASM_POSIX_SYSROOT="$SDK_SYSROOT"

NPROC="$(sysctl -n hw.ncpu 2>/dev/null || nproc)"
HOST_CC_COMMAND="${HOST_CC:-}"
HOST_CXX_COMMAND="${HOST_CXX:-}"
if [ -n "${NIX_CC_FOR_BUILD:-}" ]; then
    if [ -z "$HOST_CC_COMMAND" ]; then
        [ -x "$NIX_CC_FOR_BUILD/bin/cc" ] || {
            echo "ERROR: NIX_CC_FOR_BUILD does not provide bin/cc: $NIX_CC_FOR_BUILD" >&2
            exit 1
        }
        HOST_CC_COMMAND="$NIX_CC_FOR_BUILD/bin/cc"
    fi
    if [ -z "$HOST_CXX_COMMAND" ]; then
        [ -x "$NIX_CC_FOR_BUILD/bin/c++" ] || {
            echo "ERROR: NIX_CC_FOR_BUILD does not provide bin/c++: $NIX_CC_FOR_BUILD" >&2
            exit 1
        }
        HOST_CXX_COMMAND="$NIX_CC_FOR_BUILD/bin/c++"
    fi
fi
HOST_CC_COMMAND="${HOST_CC_COMMAND:-${CC_FOR_BUILD:-cc}}"
HOST_CXX_COMMAND="${HOST_CXX_COMMAND:-${CXX_FOR_BUILD:-c++}}"

HOST_HELPERS=(
    "$HOST_BUILD_DIR/extra/comp_err"
    "$HOST_BUILD_DIR/scripts/comp_sql"
    "$HOST_BUILD_DIR/dbug/factorial"
    "$HOST_BUILD_DIR/sql/gen_lex_hash"
    "$HOST_BUILD_DIR/sql/gen_lex_token"
)

host_helpers_ready() {
    [ -f "$HOST_BUILD_DIR/import_executables.cmake" ] || return 1
    local helper
    for helper in "${HOST_HELPERS[@]}"; do
        [ -x "$helper" ] || return 1
    done
}

# --- Verify prerequisites ---
if [ ! -f "$SDK_SYSROOT/lib/libc.a" ]; then
    if [ "$WASM_ARCH" = "wasm64" ]; then
        echo "ERROR: sysroot64 not found at $SDK_SYSROOT. Run: bash scripts/build-musl.sh --arch wasm64posix" >&2
    else
        echo "ERROR: sysroot not found at $SDK_SYSROOT. Run: bash scripts/build-musl.sh" >&2
    fi
    exit 1
fi

if [ ! -f "$TOOLCHAIN_FILE" ]; then
    echo "ERROR: Toolchain file not found at $TOOLCHAIN_FILE" >&2
    exit 1
fi

# Check for cmake
if ! command -v cmake &>/dev/null; then
    echo "ERROR: cmake not found. Run through scripts/dev-shell.sh." >&2
    exit 1
fi

if ! command -v bison &>/dev/null; then
    echo "ERROR: bison not found. Run through scripts/dev-shell.sh." >&2
    exit 1
fi

# --- Stage verified MariaDB source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Staging verified MariaDB $MARIADB_VERSION source..."
    kandelo_package_stage_verified_source mariadb "$SRC_DIR" \
        "${WASM_POSIX_DEP_SOURCE_DIR:-}" "$SOURCE_URL" "$SOURCE_SHA256" \
        "$KANDELO_PACKAGE_WORK_DIR"
    echo "==> Source extracted to $SRC_DIR"
fi

# --- Apply wasm32 source patches ---
echo "==> Applying wasm32 source patches..."

# 1. Patch mariadb_connector_c.cmake: disable SSL for cross-builds
CONC_CMAKE="$SRC_DIR/cmake/mariadb_connector_c.cmake"
if grep -q 'IF(NOT CONC_WITH_SSL)' "$CONC_CMAKE" 2>/dev/null; then
    echo "  Patching cmake/mariadb_connector_c.cmake (disable SSL for cross-build)..."
    sed -i.bak 's/IF(NOT CONC_WITH_SSL)/IF(NOT CONC_WITH_SSL AND NOT CONC_WITH_SSL STREQUAL "OFF")/' "$CONC_CMAKE"
fi

# 2. my_gethwaddr: Enable Linux code path for wasm (SIOCGIFCONF + SIOCGIFHWADDR)
HWADDR_FILE="$SRC_DIR/mysys/my_gethwaddr.c"
if ! grep -q '__wasm' "$HWADDR_FILE" 2>/dev/null; then
    echo "  Patching mysys/my_gethwaddr.c (enable MAC address retrieval for wasm)..."
    sed -i.bak 's/defined(__linux__) || defined(__sun) || defined(_WIN32)/defined(__linux__) || defined(__sun) || defined(_WIN32) || defined(__wasm32__) || defined(__wasm64__)/' "$HWADDR_FILE"
    sed -i.bak 's/#elif defined(_AIX) || defined(__linux__) || defined(__sun)/#elif defined(_AIX) || defined(__linux__) || defined(__sun) || defined(__wasm32__) || defined(__wasm64__)/' "$HWADDR_FILE"
fi

# Apply any .patch files from patches/ directory
PATCH_DIR="$SCRIPT_DIR/patches"
if [ -d "$PATCH_DIR" ]; then
    for patch in "$PATCH_DIR"/*.patch; do
        [ -f "$patch" ] || continue
        echo "  Applying $(basename "$patch")..."
        if patch -p1 -N --dry-run --silent -d "$SRC_DIR" < "$patch" 2>/dev/null; then
            patch -p1 -N -d "$SRC_DIR" < "$patch"
        else
            echo "  (already applied)"
        fi
    done
fi

# --- Step 1: Host build (native executables for cross-compile) ---
if ! host_helpers_ready; then
    echo "==> Step 1: Host build (generating import_executables.cmake)..."
    mkdir -p "$HOST_BUILD_DIR"
    cd "$HOST_BUILD_DIR"

    # `WITH_SSL=OFF` + `CONC_WITH_SSL=OFF`: the host build only
    # produces helper executables (the import_executables target).
    # None of those helpers need SSL, but libmariadb's
    # CMakeLists.txt:336 unconditionally calls FIND_PACKAGE(GnuTLS
    # REQUIRED) unless CONC_WITH_SSL=OFF — and the patch we apply
    # earlier to cmake/mariadb_connector_c.cmake already wires the
    # OFF code path. Without these flags, configure dies with
    # "Could NOT find GnuTLS (missing: GNUTLS_LIBRARY
    # GNUTLS_INCLUDE_DIR)" on any host that doesn't have GnuTLS
    # ≥3.4.2 installed (Nix dev shell, fresh CI runner, etc.).
    cmake "$SRC_DIR" \
        -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
        -DCMAKE_C_COMPILER="$HOST_CC_COMMAND" \
        -DCMAKE_CXX_COMPILER="$HOST_CXX_COMMAND" \
        -DWITH_UNIT_TESTS=OFF \
        -DWITH_MARIABACKUP=OFF \
        -DPLUGIN_CONNECT=NO \
        -DPLUGIN_ROCKSDB=NO \
        -DPLUGIN_TOKUDB=NO \
        -DPLUGIN_MROONGA=NO \
        -DPLUGIN_SPIDER=NO \
        -DPLUGIN_OQGRAPH=NO \
        -DPLUGIN_PERFSCHEMA=NO \
        -DPLUGIN_SPHINX=NO \
        -DPLUGIN_COLUMNSTORE=NO \
        -DPLUGIN_S3=NO \
        -DPLUGIN_CRACKLIB_PASSWORD_CHECK=NO \
        -DWITH_SSL=OFF \
        -DCONC_WITH_SSL=OFF \
        -DWITH_PCRE=bundled \
        -DWITH_EDITLINE=bundled \
        -DWITH_ZLIB=bundled \
        2>&1 | tail -20

    # Only build the helper executables needed for import_executables.cmake.
    # Keep the full log for diagnostics. Piping make directly into tail under
    # pipefail can report SIGPIPE as a failure when the build is merely verbose.
    HOST_IMPORT_LOG="$HOST_BUILD_DIR/import_executables.log"
    if ! make -j"$NPROC" import_executables >"$HOST_IMPORT_LOG" 2>&1; then
        tail -40 "$HOST_IMPORT_LOG"
        exit 1
    fi
    tail -5 "$HOST_IMPORT_LOG"

    if [ ! -f "$HOST_BUILD_DIR/import_executables.cmake" ]; then
        echo "ERROR: import_executables.cmake not generated" >&2
        exit 1
    fi
    if ! host_helpers_ready; then
        echo "ERROR: host helper executables were not generated" >&2
        exit 1
    fi
    echo "==> Host build complete."
fi

# --- Resolver helper (used for compiled dependencies outside SourceOnly) ---
HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"
resolve_dep() {
    local name="$1"
    (cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TARGET" --quiet -- build-deps --arch="$WASM_ARCH" resolve "$name")
}

# --- Resolve libcxx via the dep cache, then project a private sysroot ---
LLVM_PREFIX="${LLVM_PREFIX:?LLVM_PREFIX not set. Run through scripts/dev-shell.sh.}"
LLVM_CLANG="$LLVM_PREFIX/bin/clang"
if [ ! -x "$LLVM_CLANG" ]; then
    echo "ERROR: clang not found at $LLVM_CLANG. Run through scripts/dev-shell.sh." >&2
    exit 1
fi

LIBCXX_PREFIX="${WASM_POSIX_DEP_LIBCXX_DIR:-}"
if [ -z "$LIBCXX_PREFIX" ]; then
    echo "==> Resolving libcxx via cargo xtask build-deps..."
    LIBCXX_PREFIX="$(resolve_dep libcxx)"
fi
[ -f "$LIBCXX_PREFIX/lib/libc++.a" ] || {
    echo "ERROR: libcxx resolve missing libc++.a at $LIBCXX_PREFIX" >&2
    exit 1
}
[ -f "$LIBCXX_PREFIX/lib/libc++abi.a" ] || {
    echo "ERROR: libcxx resolve missing libc++abi.a at $LIBCXX_PREFIX" >&2
    exit 1
}
[ -d "$LIBCXX_PREFIX/include/c++/v1" ] || {
    echo "ERROR: libcxx resolve missing include/c++/v1 at $LIBCXX_PREFIX" >&2
    exit 1
}

# The resolver normally provides these variables. Export the same authority for
# direct invocation after resolving its fallback so the shared helper can build
# one mutable projection without changing the worktree SDK sysroot or cache.
export WASM_POSIX_DEP_WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"
export WASM_POSIX_DEP_LIBCXX_DIR="$LIBCXX_PREFIX"
SYSROOT="$(
    kandelo_package_prepare_private_sysroot mariadb "$SDK_SYSROOT" libcxx
)"
export WASM_POSIX_SYSROOT="$SYSROOT"

echo "==> libcxx resolved at $LIBCXX_PREFIX (projected into $SYSROOT)"

PCRE2_PREFIX="${WASM_POSIX_DEP_PCRE2_DIR:-}"
if [ -n "$PCRE2_PREFIX" ]; then
    for path in \
        "$PCRE2_PREFIX/lib/libpcre2-8.a" \
        "$PCRE2_PREFIX/lib/libpcre2-posix.a" \
        "$PCRE2_PREFIX/include/pcre2.h" \
        "$PCRE2_PREFIX/include/pcre2posix.h"; do
        [ -f "$path" ] || {
            echo "ERROR: pcre2 bottle prefix is missing $path" >&2
            exit 1
        }
    done
    cp "$PCRE2_PREFIX/lib/libpcre2-8.a" "$SYSROOT/lib/"
    cp "$PCRE2_PREFIX/lib/libpcre2-posix.a" "$SYSROOT/lib/"
    cp "$PCRE2_PREFIX/include/pcre2.h" "$SYSROOT/include/"
    cp "$PCRE2_PREFIX/include/pcre2posix.h" "$SYSROOT/include/"
    echo "==> PCRE2 installed to sysroot from bottle prefix $PCRE2_PREFIX"
else
    if [ "${WASM_POSIX_RESOLUTION_POLICY:-}" = "source-only-v1" ]; then
        PCRE2_SOURCE_DIR="$(kandelo_package_source_dependency_dir pcre2-source)"
    else
        # Preserve the legacy direct-build dependency spelling outside
        # SourceOnly; only the resolver-owned SourceOnly path is injective.
        PCRE2_SOURCE_DIR="${WASM_POSIX_DEP_PCRE2_SOURCE_SRC_DIR:-}"
    fi
    if [ -z "$PCRE2_SOURCE_DIR" ] &&
        [ "${WASM_POSIX_RESOLUTION_POLICY:-}" != "source-only-v1" ]; then
        echo "==> Resolving pcre2-source via cargo xtask build-deps..."
        PCRE2_SOURCE_DIR="$(resolve_dep pcre2-source)"
    fi
    [ -d "$PCRE2_SOURCE_DIR" ] || { echo "ERROR: pcre2-source resolve returned '$PCRE2_SOURCE_DIR' but dir missing" >&2; exit 1; }
    [ -f "$PCRE2_SOURCE_DIR/CMakeLists.txt" ] || { echo "ERROR: pcre2-source missing CMakeLists.txt at '$PCRE2_SOURCE_DIR'" >&2; exit 1; }

    # Direct package builds retain the source dependency. Formula builds pass
    # the exact pcre2 keg above so they do not rebuild an already bottled edge.
    if [ "$WASM_ARCH" = "wasm64" ]; then
        PCRE2_BUILD="$BUILD_STATE_ROOT/pcre2-wasm-build-64"
    else
        PCRE2_BUILD="$BUILD_STATE_ROOT/pcre2-wasm-build"
    fi
    if [ ! -f "$PCRE2_BUILD/libpcre2-8.a" ]; then
        echo "==> Building PCRE2 for $WASM_ARCH from source at $PCRE2_SOURCE_DIR..."
        PCRE2_SIZEOF_VOID_P=4
        [ "$WASM_ARCH" = "wasm64" ] && PCRE2_SIZEOF_VOID_P=8

        rm -rf "$PCRE2_BUILD"
        mkdir -p "$PCRE2_BUILD"
        cd "$PCRE2_BUILD"

        cmake "$PCRE2_SOURCE_DIR" \
            -DCMAKE_C_COMPILER="$LLVM_CLANG" \
            -DCMAKE_C_FLAGS="--target=$WASM_TARGET -matomics -mbulk-memory -mexception-handling -fno-exceptions -fno-trapping-math --sysroot=$SYSROOT -O2 -DNDEBUG" \
            -DCMAKE_AR="$LLVM_PREFIX/bin/llvm-ar" \
            -DCMAKE_RANLIB="$LLVM_PREFIX/bin/llvm-ranlib" \
            -DCMAKE_SYSTEM_NAME=Linux \
            -DCMAKE_SYSTEM_PROCESSOR="$WASM_ARCH" \
            -DCMAKE_CROSSCOMPILING=TRUE \
            -DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY \
            -DCMAKE_SIZEOF_VOID_P=$PCRE2_SIZEOF_VOID_P \
            -DPCRE2_BUILD_TESTS=OFF \
            -DPCRE2_BUILD_PCRE2GREP=OFF \
            -DBUILD_SHARED_LIBS=OFF \
            -DPCRE2_SUPPORT_JIT=OFF \
            -DPCRE2_SUPPORT_UNICODE=ON \
            2>&1 | tail -3

        make -j"$NPROC" pcre2-8-static pcre2-posix-static 2>&1 | tail -3
    fi

    cp "$PCRE2_BUILD/libpcre2-8.a" "$SYSROOT/lib/"
    cp "$PCRE2_BUILD/libpcre2-posix.a" "$SYSROOT/lib/"
    cp "$PCRE2_BUILD/pcre2.h" "$SYSROOT/include/"
    cp "$PCRE2_SOURCE_DIR/src/pcre2posix.h" "$SYSROOT/include/"
    cd "$SCRIPT_DIR"
    echo "==> PCRE2 installed to sysroot from cached source"
fi

# --- Pre-compile glue objects ---
WASM_COMPILE_FLAGS="--target=$WASM_TARGET -matomics -mbulk-memory -mexception-handling -mllvm -wasm-enable-sjlj -fno-trapping-math --sysroot=$SYSROOT"

if [ "$WASM_ARCH" = "wasm64" ]; then
    GLUE_OBJ_DIR="$BUILD_STATE_ROOT/mariadb-glue-objs-64"
else
    GLUE_OBJ_DIR="$BUILD_STATE_ROOT/mariadb-glue-objs"
fi
mkdir -p "$GLUE_OBJ_DIR"

NEED_GLUE_REBUILD=0
if [ ! -f "$GLUE_OBJ_DIR/channel_syscall.o" ]; then
    NEED_GLUE_REBUILD=1
elif [ "$GLUE_DIR/channel_syscall.c" -nt "$GLUE_OBJ_DIR/channel_syscall.o" ] || \
     [ "$GLUE_DIR/compiler_rt.c" -nt "$GLUE_OBJ_DIR/compiler_rt.o" ]; then
    NEED_GLUE_REBUILD=1
fi
if [ "$NEED_GLUE_REBUILD" = "1" ]; then
    echo "==> Compiling glue objects..."
    $LLVM_CLANG $WASM_COMPILE_FLAGS -O2 -c "$GLUE_DIR/channel_syscall.c" -o "$GLUE_OBJ_DIR/channel_syscall.o"
    $LLVM_CLANG $WASM_COMPILE_FLAGS -O2 -c "$GLUE_DIR/compiler_rt.c" -o "$GLUE_OBJ_DIR/compiler_rt.o"
    echo "==> Glue objects compiled."
fi

# --- Step 2: Cross build ---
echo "==> Step 2: Cross build for $WASM_ARCH..."
rm -rf -- "$CROSS_BUILD_DIR"
mkdir -p "$CROSS_BUILD_DIR"
cd "$CROSS_BUILD_DIR"

export WASM_POSIX_SYSROOT="$SYSROOT"

cmake "$SRC_DIR" \
    -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
    -DCMAKE_TOOLCHAIN_FILE="$TOOLCHAIN_FILE" \
    -DWASM_POSIX_MARIADB_GLUE_OBJ_DIR="$GLUE_OBJ_DIR" \
    -DCMAKE_INSTALL_PREFIX="$INSTALL_DIR" \
    -DIMPORT_EXECUTABLES="$HOST_BUILD_DIR/import_executables.cmake" \
    \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_C_FLAGS_RELEASE="${MARIADB_OPT_LEVEL:--O2} -DNDEBUG" \
    -DCMAKE_CXX_FLAGS_RELEASE="${MARIADB_OPT_LEVEL:--O2} -DNDEBUG" \
    \
    -DWITH_UNIT_TESTS=OFF \
    -DWITH_MARIABACKUP=OFF \
    -DSECURITY_HARDENED=OFF \
    -DWITH_SAFEMALLOC=OFF \
    -DWITH_EMBEDDED_SERVER=OFF \
    -DENABLED_PROFILING=OFF \
    -DWITHOUT_DYNAMIC_PLUGIN=ON \
    -DDISABLE_SHARED=ON \
    \
    -DWITH_SSL=OFF \
    -DCONC_WITH_SSL=OFF \
    -DWITH_PCRE=system \
    -DWITH_EDITLINE=bundled \
    -DWITH_ZLIB=system \
    -DWITH_SYSTEMD=no \
    -DWITH_WSREP=OFF \
    -DDISABLE_THREADPOOL=ON \
    \
    -DPLUGIN_INNODB=STATIC \
    -DPLUGIN_INNOBASE=STATIC \
    -DPLUGIN_XTRADB=NO \
    -DPLUGIN_CONNECT=NO \
    -DPLUGIN_ROCKSDB=NO \
    -DPLUGIN_TOKUDB=NO \
    -DPLUGIN_MROONGA=NO \
    -DPLUGIN_SPIDER=NO \
    -DPLUGIN_OQGRAPH=NO \
    -DPLUGIN_SPHINX=NO \
    -DPLUGIN_COLUMNSTORE=NO \
    -DPLUGIN_S3=NO \
    -DPLUGIN_PERFSCHEMA=NO \
    -DPLUGIN_CRACKLIB_PASSWORD_CHECK=NO \
    -DPLUGIN_AUTH_GSSAPI=NO \
    -DPLUGIN_AUTH_PAM=NO \
    -DPLUGIN_FEEDBACK=NO \
    -DPLUGIN_QUERY_RESPONSE_TIME=NO \
    -DPLUGIN_SERVER_AUDIT=NO \
    -DPLUGIN_DISKS=NO \
    -DPLUGIN_METADATA_LOCK_INFO=NO \
    -DPLUGIN_QUERY_CACHE_INFO=NO \
    -DPLUGIN_LOCALE_INFO=NO \
    -DPLUGIN_SIMPLE_PASSWORD_CHECK=NO \
    \
    -DPLUGIN_ARIA=STATIC \
    -DPLUGIN_MYISAM=STATIC \
    -DPLUGIN_MYISAMMRG=STATIC \
    -DPLUGIN_CSV=STATIC \
    -DPLUGIN_HEAP=STATIC \
    -DPLUGIN_PARTITION=STATIC \
    \
    -DSTACK_DIRECTION=-1 \
    -DHAVE_LLVM_LIBCPP=OFF \
    2>&1 | tail -40

echo "==> CMake configuration complete. Starting build..."

# Build mysqld. Capture full output to a log so a failed build doesn't
# bury the actual diagnostic in `tail -N`. Show the tail on success and
# the relevant error context on failure.
MARIADBD_LOG="$CROSS_BUILD_DIR/build-mariadbd.log"
if make -j"$NPROC" mariadbd > "$MARIADBD_LOG" 2>&1; then
    tail -10 "$MARIADBD_LOG"
else
    echo "==> mariadbd build failed; printing error context:" >&2
    grep -B 2 -E "[Ee]rror|fatal|undefined" "$MARIADBD_LOG" | tail -50 >&2
    echo "" >&2
    echo "Full log: $MARIADBD_LOG" >&2
    exit 1
fi

# Build mysqltest client (mariadb-test target)
echo "==> Building mysqltest..."
MYSQLTEST_LOG="$CROSS_BUILD_DIR/build-mysqltest.log"
if make -j"$NPROC" mariadb-test > "$MYSQLTEST_LOG" 2>&1; then
    tail -10 "$MYSQLTEST_LOG"
else
    echo "==> mariadb-test build failed; printing error context:" >&2
    grep -B 2 -E "[Ee]rror|fatal|undefined" "$MYSQLTEST_LOG" | tail -50 >&2
    echo "" >&2
    echo "Full log: $MYSQLTEST_LOG" >&2
    exit 1
fi

# Check if mariadbd was built (10.5+ renames mysqld → mariadbd)
MYSQLD_BIN="$CROSS_BUILD_DIR/sql/mariadbd"
if [ -f "$MYSQLD_BIN" ]; then
    echo "==> MariaDB mysqld built successfully!"
    ls -lh "$MYSQLD_BIN"
    file "$MYSQLD_BIN" || true

    # Install the manifest/resolver-facing artifact. Keep the no-extension
    # copy as a local-build compatibility alias for older demo/test workflows.
    mkdir -p "$INSTALL_DIR/bin" "$INSTALL_DIR/share/mysql"
    cp "$MYSQLD_BIN" "$INSTALL_DIR/bin/mariadbd.wasm"
    cp "$MYSQLD_BIN" "$INSTALL_DIR/bin/mariadbd"

    # Copy the declared bootstrap SQL runtime members. These files are part of
    # MariaDB's package contract, so missing upstream source is a build error.
    for system_table in \
        mysql_system_tables.sql \
        mysql_system_tables_data.sql; do
        [ -f "$SRC_DIR/scripts/$system_table" ] || {
            echo "ERROR: MariaDB source is missing scripts/$system_table" >&2
            exit 1
        }
        cp "$SRC_DIR/scripts/$system_table" "$INSTALL_DIR/share/mysql/"
    done

    # Copy error message files (generated by comp_err during build)
    SHARE_BUILD="$CROSS_BUILD_DIR/sql/share"
    if [ -d "$SHARE_BUILD" ]; then
        echo "==> Copying error message files..."
        for lang in bulgarian chinese czech danish dutch english estonian french german greek hindi hungarian italian japanese korean norwegian norwegian-ny polish portuguese romanian russian serbian slovak spanish swedish ukrainian; do
            if [ -d "$SHARE_BUILD/$lang" ] && [ -f "$SHARE_BUILD/$lang/errmsg.sys" ]; then
                mkdir -p "$INSTALL_DIR/share/$lang"
                cp "$SHARE_BUILD/$lang/errmsg.sys" "$INSTALL_DIR/share/$lang/"
            fi
        done
        echo "==> Error message files copied."
    fi

    echo "==> MariaDB install directory: $INSTALL_DIR"
else
    echo "ERROR: mysqld not found after build" >&2
    echo "Check build log in $CROSS_BUILD_DIR for errors."
    exit 1
fi

# --- Install mysqltest ---
MYSQLTEST_BIN="$CROSS_BUILD_DIR/client/mariadb-test"
if [ -f "$MYSQLTEST_BIN" ]; then
    echo "==> mysqltest built successfully!"
    ls -lh "$MYSQLTEST_BIN"
    cp "$MYSQLTEST_BIN" "$INSTALL_DIR/bin/mysqltest.wasm"
else
    echo "WARNING: mysqltest not found at $MYSQLTEST_BIN (skipping)" >&2
fi

# --- Copy mysql-test suite data ---
# MariaDB 10.5 layout: main test suite is in mysql-test/main/ (not t/ and r/).
# The .test and .result files are both in main/.
MYSQL_TEST_SRC="$SRC_DIR/mysql-test"
if [ -d "$MYSQL_TEST_SRC" ]; then
    echo "==> Copying mysql-test suite data..."
    MYSQL_TEST_DST="$INSTALL_DIR/mysql-test"
    mkdir -p "$MYSQL_TEST_DST"
    for subdir in main include std_data suite; do
        if [ -d "$MYSQL_TEST_SRC/$subdir" ]; then
            cp -R "$MYSQL_TEST_SRC/$subdir" "$MYSQL_TEST_DST/"
        fi
    done
    # Copy top-level helper files needed by mysqltest
    for f in unstable-tests suite.pm; do
        [ -f "$MYSQL_TEST_SRC/$f" ] && cp "$MYSQL_TEST_SRC/$f" "$MYSQL_TEST_DST/"
    done
    echo "==> mysql-test data copied to $MYSQL_TEST_DST"
else
    echo "WARNING: mysql-test directory not found in source tree" >&2
fi

if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    if [ -n "${KANDELO_VFS_PRODUCT_SOURCE_ROLES:-}" ]; then
        echo "ERROR: sealed MariaDB builds must select source roles through MARIADB_VFS_SOURCE_ROLES" >&2
        exit 2
    fi
    case "${MARIADB_VFS_SOURCE_ROLES:-}" in
        "") ;;
        system-tables,test-suite)
            export KANDELO_VFS_PRODUCT_SOURCE_ROLES="$MARIADB_VFS_SOURCE_ROLES"
            ;;
        *)
            echo "ERROR: unsupported MariaDB VFS source-role selection: ${MARIADB_VFS_SOURCE_ROLES}" >&2
            exit 2
            ;;
    esac
    kandelo_package_project_requested_vfs_source_role system-tables \
        "$INSTALL_DIR/share/mysql"
    kandelo_package_project_requested_vfs_source_role test-suite \
        "$INSTALL_DIR/mysql-test"
fi

# Install into local-binaries/ so the resolver picks the freshly-built
# binary over the fetched release. Use $INSTALL_DIR (set per WASM_ARCH
# above) — hard-coding mariadb-install/ lost the wasm64 build's output
# at mariadb-install-64/, which then made build-mariadb-vfs.sh's wasm64
# branch fail with "mariadbd.wasm not found".
source "$REPO_ROOT/scripts/install-local-binary.sh"
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    WASM_POSIX_INSTALL_LOCAL_MIRROR=0 \
        WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto \
        WASM_POSIX_DEP_TARGET_ARCH="$WASM_ARCH" \
        install_local_binary mariadb "$INSTALL_DIR/bin/mariadbd.wasm" mariadbd.wasm
    [ -f "$INSTALL_DIR/bin/mysqltest.wasm" ] && \
        WASM_POSIX_INSTALL_LOCAL_MIRROR=0 \
            WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto \
            WASM_POSIX_DEP_TARGET_ARCH="$WASM_ARCH" \
            install_local_binary mariadb "$INSTALL_DIR/bin/mysqltest.wasm" mysqltest.wasm || true
    for system_table in \
        mysql_system_tables.sql \
        mysql_system_tables_data.sql; do
        WASM_POSIX_INSTALL_LOCAL_MIRROR=0 \
            WASM_POSIX_DEP_TARGET_ARCH="$WASM_ARCH" \
            install_local_runtime_file mariadb \
                "$INSTALL_DIR/share/mysql/$system_table" \
                "share/mysql/$system_table"
    done
else
    WASM_POSIX_DEP_TARGET_ARCH="$WASM_ARCH" \
        install_local_binary mariadb "$INSTALL_DIR/bin/mariadbd.wasm" mariadbd.wasm
    [ -f "$INSTALL_DIR/bin/mysqltest.wasm" ] && \
        WASM_POSIX_DEP_TARGET_ARCH="$WASM_ARCH" \
            install_local_binary mariadb "$INSTALL_DIR/bin/mysqltest.wasm" mysqltest.wasm || true
    for system_table in \
        mysql_system_tables.sql \
        mysql_system_tables_data.sql; do
        WASM_POSIX_DEP_TARGET_ARCH="$WASM_ARCH" \
            install_local_runtime_file mariadb \
                "$INSTALL_DIR/share/mysql/$system_table" \
                "share/mysql/$system_table"
    done
fi
