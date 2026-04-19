#!/usr/bin/env bash
set -euo pipefail

# Build MariaDB 10.5 LTS for wasm-posix-kernel.
#
# Usage:
#   bash build-mariadb.sh           # build for wasm32 (ILP32)
#   bash build-mariadb.sh --wasm64  # build for wasm64 (LP64)
#
# Two-step cross-compilation:
#   1. Host build: generates import_executables.cmake (native helper programs)
#   2. Cross build: uses CMake toolchain file for wasm32 or wasm64

MARIADB_VERSION="${MARIADB_VERSION:-10.5.28}"
MARIADB_MAJOR="10.5"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SRC_DIR="$SCRIPT_DIR/mariadb-src"
HOST_BUILD_DIR="$SCRIPT_DIR/mariadb-host-build"
GLUE_DIR="$REPO_ROOT/glue"

# Parse --wasm64 flag
WASM_ARCH="wasm32"
while [ $# -gt 0 ]; do
    case "$1" in
        --wasm64) WASM_ARCH="wasm64"; shift ;;
        *) echo "Unknown argument: $1" >&2; exit 1 ;;
    esac
done

if [ "$WASM_ARCH" = "wasm64" ]; then
    CROSS_BUILD_DIR="$SCRIPT_DIR/mariadb-cross-build-64"
    INSTALL_DIR="$SCRIPT_DIR/mariadb-install-64"
    TOOLCHAIN_FILE="$SCRIPT_DIR/wasm64-posix-toolchain.cmake"
    SYSROOT="$REPO_ROOT/sysroot64"
    WASM_TARGET="wasm64-unknown-unknown"
    # LLVM 21 wasm64 backend has -O2 miscompilation bugs (sign-extension of i32 to i64
    # in table lookups). Use -O1 until the LLVM wasm64 backend matures.
    : "${MARIADB_OPT_LEVEL:=-O1}"
else
    CROSS_BUILD_DIR="$SCRIPT_DIR/mariadb-cross-build"
    INSTALL_DIR="$SCRIPT_DIR/mariadb-install"
    TOOLCHAIN_FILE="$SCRIPT_DIR/wasm32-posix-toolchain.cmake"
    SYSROOT="$REPO_ROOT/sysroot"
    WASM_TARGET="wasm32-unknown-unknown"
fi

NPROC="$(sysctl -n hw.ncpu 2>/dev/null || nproc)"

# Homebrew bison (macOS system bison is too old for MariaDB)
if [ -x /opt/homebrew/opt/bison/bin/bison ]; then
    export PATH="/opt/homebrew/opt/bison/bin:$PATH"
fi

# --- Verify prerequisites ---
if [ ! -f "$SYSROOT/lib/libc.a" ]; then
    echo "ERROR: sysroot not found. Run: bash build.sh" >&2
    exit 1
fi

if [ ! -f "$TOOLCHAIN_FILE" ]; then
    echo "ERROR: Toolchain file not found at $TOOLCHAIN_FILE" >&2
    exit 1
fi

# Check for cmake
if ! command -v cmake &>/dev/null; then
    echo "ERROR: cmake not found. Install: brew install cmake" >&2
    exit 1
fi

# --- Download MariaDB source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading MariaDB $MARIADB_VERSION..."
    TARBALL="mariadb-${MARIADB_VERSION}.tar.gz"
    URL="https://archive.mariadb.org/mariadb-${MARIADB_VERSION}/source/${TARBALL}"
    curl -fsSL "$URL" -o "/tmp/$TARBALL"
    mkdir -p "$SRC_DIR"
    tar xzf "/tmp/$TARBALL" -C "$SRC_DIR" --strip-components=1
    rm "/tmp/$TARBALL"
    echo "==> Source extracted to $SRC_DIR"
fi

# --- Apply wasm32 source patches ---
echo "==> Applying wasm32 source patches..."

# 1. Patch mariadb_connector_c.cmake: disable SSL for cross-builds
CONC_CMAKE="$SRC_DIR/cmake/mariadb_connector_c.cmake"
if grep -q 'IF(NOT CONC_WITH_SSL)' "$CONC_CMAKE" 2>/dev/null; then
    echo "  Patching cmake/mariadb_connector_c.cmake (disable SSL for cross-build)..."
    sed -i '' 's/IF(NOT CONC_WITH_SSL)/IF(NOT CONC_WITH_SSL AND NOT CONC_WITH_SSL STREQUAL "OFF")/' "$CONC_CMAKE"
fi

# 2. my_gethwaddr: Enable Linux code path for wasm (SIOCGIFCONF + SIOCGIFHWADDR)
HWADDR_FILE="$SRC_DIR/mysys/my_gethwaddr.c"
if ! grep -q '__wasm' "$HWADDR_FILE" 2>/dev/null; then
    echo "  Patching mysys/my_gethwaddr.c (enable MAC address retrieval for wasm)..."
    sed -i '' 's/defined(__linux__) || defined(__sun) || defined(_WIN32)/defined(__linux__) || defined(__sun) || defined(_WIN32) || defined(__wasm32__) || defined(__wasm64__)/' "$HWADDR_FILE"
    sed -i '' 's/#elif defined(_AIX) || defined(__linux__) || defined(__sun)/#elif defined(_AIX) || defined(__linux__) || defined(__sun) || defined(__wasm32__) || defined(__wasm64__)/' "$HWADDR_FILE"
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
if [ ! -f "$HOST_BUILD_DIR/import_executables.cmake" ]; then
    echo "==> Step 1: Host build (generating import_executables.cmake)..."
    mkdir -p "$HOST_BUILD_DIR"
    cd "$HOST_BUILD_DIR"

    cmake "$SRC_DIR" \
        -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
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
        -DWITH_SSL=bundled \
        -DWITH_PCRE=bundled \
        -DWITH_EDITLINE=bundled \
        -DWITH_ZLIB=bundled \
        2>&1 | tail -20

    # Only build the helper executables needed for import_executables.cmake
    make -j"$NPROC" import_executables 2>&1 | tail -5

    if [ ! -f "$HOST_BUILD_DIR/import_executables.cmake" ]; then
        echo "ERROR: import_executables.cmake not generated" >&2
        exit 1
    fi
    echo "==> Host build complete."
fi

# --- Set up libc++ headers for C++ support ---
LLVM_PREFIX="$(brew --prefix llvm 2>/dev/null || echo /opt/homebrew/opt/llvm)"
LLVM_CLANG="$LLVM_PREFIX/bin/clang"
LLVM_CXX_HEADERS="$LLVM_PREFIX/include/c++/v1"

if [ ! -f "$SYSROOT/include/c++/v1/__config" ]; then
    echo "==> Installing libc++ headers into sysroot..."
    mkdir -p "$SYSROOT/include/c++/v1"
    cp -R "$LLVM_CXX_HEADERS/"* "$SYSROOT/include/c++/v1/"

    # Fix __config_site for wasm32/musl target
    CONFIG_SITE="$SYSROOT/include/c++/v1/__config_site"
    if [ -f "$CONFIG_SITE" ]; then
        sed -i '' 's/_LIBCPP_HAS_MUSL_LIBC 0/_LIBCPP_HAS_MUSL_LIBC 1/' "$CONFIG_SITE"
        sed -i '' 's/_LIBCPP_HAS_THREAD_API_PTHREAD 0/_LIBCPP_HAS_THREAD_API_PTHREAD 1/' "$CONFIG_SITE"
        sed -i '' 's/^#define _LIBCPP_PSTL_BACKEND_LIBDISPATCH/\/* #undef _LIBCPP_PSTL_BACKEND_LIBDISPATCH *\/\n#define _LIBCPP_PSTL_BACKEND_SERIAL/' "$CONFIG_SITE"
    fi

    echo "==> libc++ headers installed"
fi

# --- Build libc++ if not already built ---
if [ ! -f "$SYSROOT/lib/libc++.a" ] || [ "$(wc -c < "$SYSROOT/lib/libc++.a" | tr -d ' ')" -lt 1000 ]; then
    echo "==> Building libc++ (required for C++ exception support)..."
    bash "$REPO_ROOT/scripts/build-libcxx.sh"
fi

# --- Build PCRE2 if not present ---
if [ ! -f "$SYSROOT/lib/libpcre2-8.a" ]; then
    echo "==> Building PCRE2 for $WASM_ARCH..."
    PCRE2_VERSION="10.44"
    PCRE2_DIR="$SCRIPT_DIR/pcre2-${PCRE2_VERSION}"
    PCRE2_BUILD="$SCRIPT_DIR/pcre2-wasm-build"

    if [ ! -f "$PCRE2_DIR/CMakeLists.txt" ]; then
        rm -rf "$PCRE2_DIR"
        curl -fsSL "https://github.com/PCRE2Project/pcre2/releases/download/pcre2-${PCRE2_VERSION}/pcre2-${PCRE2_VERSION}.tar.gz" -o "$SCRIPT_DIR/pcre2.tar.gz"
        tar xzf "$SCRIPT_DIR/pcre2.tar.gz" -C "$SCRIPT_DIR"
        rm "$SCRIPT_DIR/pcre2.tar.gz"
    fi

    PCRE2_SIZEOF_VOID_P=4
    [ "$WASM_ARCH" = "wasm64" ] && PCRE2_SIZEOF_VOID_P=8

    rm -rf "$PCRE2_BUILD"
    mkdir -p "$PCRE2_BUILD"
    cd "$PCRE2_BUILD"

    cmake "$PCRE2_DIR" \
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

    cp "$PCRE2_BUILD/libpcre2-8.a" "$SYSROOT/lib/"
    cp "$PCRE2_BUILD/libpcre2-posix.a" "$SYSROOT/lib/"
    cp "$PCRE2_BUILD/pcre2.h" "$SYSROOT/include/"
    cp "$PCRE2_DIR/src/pcre2posix.h" "$SYSROOT/include/"

    cd "$SCRIPT_DIR"
    echo "==> PCRE2 installed to sysroot"
fi

# --- Pre-compile glue objects ---
WASM_COMPILE_FLAGS="--target=$WASM_TARGET -matomics -mbulk-memory -mexception-handling -mllvm -wasm-enable-sjlj -fno-trapping-math --sysroot=$SYSROOT"

if [ "$WASM_ARCH" = "wasm64" ]; then
    GLUE_OBJ_DIR="$SCRIPT_DIR/mariadb-glue-objs-64"
else
    GLUE_OBJ_DIR="$SCRIPT_DIR/mariadb-glue-objs"
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
mkdir -p "$CROSS_BUILD_DIR"
cd "$CROSS_BUILD_DIR"

export WASM_POSIX_SYSROOT="$SYSROOT"

cmake "$SRC_DIR" \
    -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
    -DCMAKE_TOOLCHAIN_FILE="$TOOLCHAIN_FILE" \
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

# Build mysqld
make -j"$NPROC" mariadbd 2>&1 | tail -20

# Build mysqltest client (mariadb-test target)
echo "==> Building mysqltest..."
make -j"$NPROC" mariadb-test 2>&1 | tail -20

# Check if mariadbd was built (10.5+ renames mysqld → mariadbd)
MYSQLD_BIN="$CROSS_BUILD_DIR/sql/mariadbd"
if [ -f "$MYSQLD_BIN" ]; then
    echo "==> MariaDB mysqld built successfully!"
    ls -lh "$MYSQLD_BIN"
    file "$MYSQLD_BIN" || true

    # Install to output directory
    mkdir -p "$INSTALL_DIR/bin" "$INSTALL_DIR/share/mysql"
    cp "$MYSQLD_BIN" "$INSTALL_DIR/bin/"
    cp "$MYSQLD_BIN" "$INSTALL_DIR/bin/mariadbd.wasm"  # For Vite browser bundling

    # Copy system tables SQL for bootstrap
    if [ -d "$SRC_DIR/scripts" ]; then
        cp "$SRC_DIR/scripts/mysql_system_tables.sql" "$INSTALL_DIR/share/mysql/" 2>/dev/null || true
        cp "$SRC_DIR/scripts/mysql_system_tables_data.sql" "$INSTALL_DIR/share/mysql/" 2>/dev/null || true
    fi

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
