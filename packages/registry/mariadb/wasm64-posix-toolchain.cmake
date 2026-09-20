# CMake toolchain file for cross-compiling to wasm64 via kandelo SDK.
#
# Usage:
#   cmake -DCMAKE_TOOLCHAIN_FILE=.../wasm64-posix-toolchain.cmake ...
#
# Produces LP64 binaries where sizeof(long) = sizeof(void*) = 8.
# Requires: LLVM clang with wasm64 support.
#           kandelo sysroot64 built via scripts/build-musl.sh --arch wasm64posix

cmake_minimum_required(VERSION 3.13)

# --- System identification ---
set(CMAKE_SYSTEM_NAME Linux)
set(CMAKE_SYSTEM_PROCESSOR wasm64)
set(CMAKE_CROSSCOMPILING TRUE)

# --- Locate LLVM clang ---
# Search order, highest priority first:
#   1. $LLVM_BIN — exported by the Nix flake's shellHook (so this works
#      identically on Linux CI and Mac dev shells).
#   2. $LLVM_PREFIX/bin — sibling form of (1) the flake also exports.
#   3. clang/llvm-* on PATH.
set(_LLVM_SEARCH_PATHS)
if(DEFINED ENV{LLVM_BIN})
  list(APPEND _LLVM_SEARCH_PATHS "$ENV{LLVM_BIN}")
endif()
if(DEFINED ENV{LLVM_PREFIX})
  list(APPEND _LLVM_SEARCH_PATHS "$ENV{LLVM_PREFIX}/bin")
endif()

if(_LLVM_SEARCH_PATHS)
  find_program(LLVM_CLANG NAMES clang PATHS ${_LLVM_SEARCH_PATHS} NO_DEFAULT_PATH)
  find_program(LLVM_AR     NAMES llvm-ar     PATHS ${_LLVM_SEARCH_PATHS} NO_DEFAULT_PATH)
  find_program(LLVM_RANLIB NAMES llvm-ranlib PATHS ${_LLVM_SEARCH_PATHS} NO_DEFAULT_PATH)
  find_program(LLVM_NM     NAMES llvm-nm     PATHS ${_LLVM_SEARCH_PATHS} NO_DEFAULT_PATH)
endif()

find_program(LLVM_CLANG NAMES clang)
if(NOT LLVM_CLANG)
  message(FATAL_ERROR
    "LLVM clang not found. Searched: ${_LLVM_SEARCH_PATHS}. "
    "Run through scripts/dev-shell.sh or set LLVM_BIN/LLVM_PREFIX."
  )
endif()
find_program(LLVM_AR     NAMES llvm-ar)
find_program(LLVM_RANLIB NAMES llvm-ranlib)
find_program(LLVM_NM     NAMES llvm-nm)

# --- Sysroot ---
if(NOT WASM_POSIX_SYSROOT)
  if(DEFINED ENV{WASM_POSIX_SYSROOT})
    set(WASM_POSIX_SYSROOT "$ENV{WASM_POSIX_SYSROOT}")
  else()
    get_filename_component(_TOOLCHAIN_DIR "${CMAKE_CURRENT_LIST_FILE}" DIRECTORY)
    get_filename_component(WASM_POSIX_SYSROOT "${_TOOLCHAIN_DIR}/../../../sysroot64" ABSOLUTE)
  endif()
endif()

if(NOT EXISTS "${WASM_POSIX_SYSROOT}/lib/libc.a")
  message(FATAL_ERROR "Sysroot not found at ${WASM_POSIX_SYSROOT}. Run scripts/build-musl.sh --arch wasm64posix first.")
endif()

set(CMAKE_SYSROOT "${WASM_POSIX_SYSROOT}")

# --- Compilers ---
set(CMAKE_C_COMPILER "${LLVM_CLANG}")
set(CMAKE_CXX_COMPILER "${LLVM_CLANG}")
set(CMAKE_AR "${LLVM_AR}" CACHE FILEPATH "Archiver")
set(CMAKE_RANLIB "${LLVM_RANLIB}" CACHE FILEPATH "Ranlib")
set(CMAKE_NM "${LLVM_NM}" CACHE FILEPATH "NM")

# --- HAND-MAINTAINED MIRROR OF THE SDK LINK CONTRACT. IT HAS DRIFTED. ---
#
# The flags below are a hand-copied mirror of the SDK's compile/link contract
# (sdk/src/lib/flags.ts, plus the conditional branches in sdk/src/bin/cc.ts),
# wasm64 arch aside. This file did not previously say so at all. Nothing keeps
# the copy in step with the original, and it is behind today.
#
# Converting MariaDB to the SDK wrapper (sdk/bin/wasm64posix-cc) was
# DELIBERATELY DEFERRED, not overlooked. MariaDB's CMake drives raw clang by
# design -- it inspects and rewrites the compiler command line, runs its own
# link probes, and builds host-side generator executables in the same
# configure pass -- so pointing CMAKE_C_COMPILER at a wrapper is a real port,
# not a substitution. That port has not been scheduled.
#
# MEASURED DRIFT against the SDK at 2026-09-20, all four absent here, exactly
# as in the wasm32 file beside it:
#
#   -Wl,--export=__abi_version      (flags.ts:333) The export the loader reads
#       to bind an artifact to a kernel ABI. Without it the host reports
#       "artifact lacks an __abi_version export -- legacy binary predates the
#       ABI marker rollout" and the ABI check cannot run at all.
#
#   -Wl,--no-stack-first            (cc.ts:403-406) Conditional: LLD 22 made
#       --stack-first the default, and LLD 21 neither defaults to it nor
#       accepts the negation. The SDK emits it only when lldMajor >= 22.
#       Built with LLD 22, this file silently gets the opposite shadow-stack
#       placement from every other package.
#
#   -D__unix__=1 -D__unix=1         (flags.ts:12-13) Kandelo is a Unix/POSIX
#       userspace and says so through the conventional macros, which is how
#       upstream feature selection stays truthful.
#
#   -mllvm -wasm-use-legacy-eh=false  (flags.ts:25) THE CONSEQUENTIAL ONE.
#       LLVM 21 defaults -wasm-use-legacy-eh to TRUE, so omitting the flag is
#       not neutral: it selects legacy `try`/`catch` lowering. The SDK passes
#       =false explicitly to get modern `try_table`/`catch_ref` (flags.ts:18-24
#       records the 2026-05-14 disassembly check that established this). So
#       MariaDB is still compiled on legacy EH while every package built
#       through the SDK moved to try_table/catch_ref.
#
# Do not "catch up" by hand-adding flags here -- hand-copying is what produced
# this drift. A missing flag is an SDK change; re-mirror deliberately, or do
# the wrapper port.
#
# --- Compiler flags (mirror sdk/src/lib/flags.ts COMPILE_FLAGS) ---
set(WASM64_FLAGS
  "--target=wasm64-unknown-unknown"
  "-matomics"
  "-mbulk-memory"
  "-mexception-handling"
  "-mllvm" "-wasm-enable-sjlj"
  "-fno-trapping-math"
  "--sysroot=${WASM_POSIX_SYSROOT}"
)
string(REPLACE ";" " " WASM64_FLAGS_STR "${WASM64_FLAGS}")

set(CMAKE_C_FLAGS_INIT "${WASM64_FLAGS_STR}")
set(CMAKE_CXX_FLAGS_INIT "${WASM64_FLAGS_STR} -nostdinc++ -isystem ${WASM_POSIX_SYSROOT}/include/c++/v1 -D_LIBCPP_HAS_MUSL_LIBC -D_LIBCPP_HAS_THREAD_API_PTHREAD -D_LIBCPP_PROVIDES_DEFAULT_RUNE_TABLE")

# --- Linker flags (mirror sdk/src/lib/flags.ts LINK_FLAGS; see the drift
# --- note above the compiler flags) ---
set(WASM64_LINK_FLAGS
  "-nostdlib"
  "-Wl,--no-entry"
  "-Wl,--export=_start"
  "-Wl,--export=__heap_base"
  "-Wl,--import-memory"
  "-Wl,--shared-memory"
  "-Wl,--max-memory=1073741824"
  "-Wl,--allow-undefined"
  "-Wl,--global-base=1114112"
  "-Wl,--table-base=3"
  "-Wl,--export-table"
  "-Wl,--growable-table"
  "-Wl,--export=__wasm_init_tls"
  "-Wl,--export=__tls_base"
  "-Wl,--export=__tls_size"
  "-Wl,--export=__tls_align"
  "-Wl,--export=__stack_pointer"
  "-Wl,--export=__wasm_thread_init"
  # This toolchain drives raw clang (CMAKE_C_COMPILER/CMAKE_CXX_COMPILER
  # above are set from find_program(LLVM_CLANG NAMES clang), not
  # wasm32posix-cc), so it never goes through the SDK driver and gets no
  # SDK-applied stack-size default. Unlike the SDK-driven packages that had
  # this same flag removed, deleting it here does not fall through to any
  # default at all — it silently drops to wasm-ld's own ~64 KiB default
  # instead. This toolchain must therefore keep naming its own stack size.
  # Do not delete this without also giving mariadb a real default some
  # other way.
  "-Wl,-z,stack-size=1048576"
)
string(REPLACE ";" " " WASM64_LINK_FLAGS_STR "${WASM64_LINK_FLAGS}")

# --- Startup objects and runtime libraries ---
# WHY: CMake reloads this toolchain in nested compiler probes. Carry the
# resolver-owned glue authority into those probes so the strict contract below
# validates the same prepared objects instead of failing on an absent cache key.
list(APPEND CMAKE_TRY_COMPILE_PLATFORM_VARIABLES
  WASM_POSIX_MARIADB_GLUE_OBJ_DIR)
include("${CMAKE_CURRENT_LIST_DIR}/mariadb-glue-object-contract.cmake")
kandelo_mariadb_glue_object_flags(MARIADB_GLUE_OBJECT_FLAGS)

set(CMAKE_EXE_LINKER_FLAGS_INIT
  "${WASM64_LINK_FLAGS_STR} ${WASM_POSIX_SYSROOT}/lib/crt1.o ${MARIADB_GLUE_OBJECT_FLAGS} -lc++ -lc++abi -lc"
)

# --- Type sizes for wasm64 LP64 ---
set(CMAKE_SIZEOF_VOID_P 8)
set(CMAKE_C_SIZEOF_DATA_PTR 8)
set(CMAKE_CXX_SIZEOF_DATA_PTR 8)

# Hardcode type sizes — wasm64 is LP64: long and pointers are 8 bytes.
set(SIZEOF_CHAR 1 CACHE STRING "sizeof(char)")
set(SIZEOF_SHORT 2 CACHE STRING "sizeof(short)")
set(SIZEOF_INT 4 CACHE STRING "sizeof(int)")
set(SIZEOF_LONG 8 CACHE STRING "sizeof(long)")
set(SIZEOF_LONG_LONG 8 CACHE STRING "sizeof(long long)")
set(SIZEOF_OFF_T 8 CACHE STRING "sizeof(off_t)")
set(SIZEOF_CHARP 8 CACHE STRING "sizeof(char*)")
set(SIZEOF_VOIDP 8 CACHE STRING "sizeof(void*)")

# --- Search paths ---
set(CMAKE_FIND_ROOT_PATH "${WASM_POSIX_SYSROOT}")
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)

# --- Disable try_run ---
set(CMAKE_TRY_COMPILE_TARGET_TYPE STATIC_LIBRARY)

# --- Override false positives from static-library try_compile ---
set(HAVE_BFILL 0 CACHE INTERNAL "")
set(HAVE_BZERO 0 CACHE INTERNAL "")
set(HAVE_GETPASSPHRASE 0 CACHE INTERNAL "")
set(HAVE_GETPASS 0 CACHE INTERNAL "")
set(HAVE_AIO_READ 0 CACHE INTERNAL "")
set(HAVE_AIO_WRITE 0 CACHE INTERNAL "")
set(HAVE_TIMER_CREATE 0 CACHE INTERNAL "")
set(HAVE_TIMER_SETTIME 0 CACHE INTERNAL "")
set(HAVE_KQUEUE 0 CACHE INTERNAL "")
set(HAVE_SETNS 0 CACHE INTERNAL "")
set(HAVE_LINUX_UNISTD_H 0 CACHE INTERNAL "")
set(HAVE_SYS_IOCTL_H 1 CACHE INTERNAL "")
set(HAVE_TCGETATTR 1 CACHE INTERNAL "")
set(HAVE_TELL 0 CACHE INTERNAL "")
set(HAVE_PRINTSTACK 0 CACHE INTERNAL "")
set(HAVE_BACKTRACE 0 CACHE INTERNAL "")
set(HAVE_BACKTRACE_SYMBOLS 0 CACHE INTERNAL "")
set(HAVE_BACKTRACE_SYMBOLS_FD 0 CACHE INTERNAL "")
set(HAVE_ACCEPT4 0 CACHE INTERNAL "")
set(HAVE_ABI_CXA_DEMANGLE 0 CACHE INTERNAL "")
set(HAVE_CXX_NEW 0 CACHE INTERNAL "")
set(HAVE_CRYPT 0 CACHE INTERNAL "")
set(HAVE_CUSERID 0 CACHE INTERNAL "")
set(HAVE_FEDISABLEEXCEPT 0 CACHE INTERNAL "")
set(HAVE_GETHRTIME 0 CACHE INTERNAL "")
set(HAVE_GETIFADDRS 0 CACHE INTERNAL "")
set(HAVE_GETMNTENT 0 CACHE INTERNAL "")
set(HAVE_GETHOSTBYADDR_R 0 CACHE INTERNAL "")
set(HAVE_INITGROUPS 0 CACHE INTERNAL "")
set(HAVE_MALLINFO 0 CACHE INTERNAL "")
set(HAVE_MALLINFO2 0 CACHE INTERNAL "")
set(HAVE_MEMALIGN 0 CACHE INTERNAL "")
set(HAVE_MLOCKALL 0 CACHE INTERNAL "")
set(HAVE_MMAP64 0 CACHE INTERNAL "")
set(HAVE_PTHREAD_ATTR_CREATE 0 CACHE INTERNAL "")
set(HAVE_PTHREAD_CONDATTR_CREATE 0 CACHE INTERNAL "")
set(HAVE_PTHREAD_GETAFFINITY_NP 0 CACHE INTERNAL "")
set(HAVE_PTHREAD_GETATTR_NP 0 CACHE INTERNAL "")
set(HAVE_PTHREAD_YIELD_NP 0 CACHE INTERNAL "")
set(HAVE_READ_REAL_TIME 0 CACHE INTERNAL "")
set(HAVE_READDIR_R 0 CACHE INTERNAL "")
set(HAVE_RWLOCK_INIT 0 CACHE INTERNAL "")
set(HAVE_SETMNTENT 0 CACHE INTERNAL "")
set(HAVE_SIGTHREADMASK 0 CACHE INTERNAL "")
set(HAVE_THR_YIELD 0 CACHE INTERNAL "")
set(HAVE_UCONTEXT_H 0 CACHE INTERNAL "")
set(HAVE_VFORK 0 CACHE INTERNAL "")
set(HAVE_MALLOC_ZONE 0 CACHE INTERNAL "")
set(HAVE_POSIX_FALLOCATE 0 CACHE INTERNAL "")
set(HAVE_SYS_PRCTL_H 0 CACHE INTERNAL "")
set(HAVE_SYS_SYSCALL_H 0 CACHE INTERNAL "")
set(HAVE_LINK_H 0 CACHE INTERNAL "")
set(HAVE_MALLOC_H 0 CACHE INTERNAL "")
set(HAVE_SETUPTERM 0 CACHE INTERNAL "")
set(HAVE_VIDATTR 0 CACHE INTERNAL "")

# --- Disable SSL/TLS ---
set(WITH_SSL "OFF" CACHE STRING "Disable SSL" FORCE)
set(GNUTLS_FOUND FALSE CACHE BOOL "" FORCE)
set(GNUTLS_LIBRARY "GNUTLS_LIBRARY-NOTFOUND" CACHE FILEPATH "" FORCE)
set(GNUTLS_INCLUDE_DIR "GNUTLS_INCLUDE_DIR-NOTFOUND" CACHE PATH "" FORCE)
set(OPENSSL_FOUND FALSE CACHE BOOL "" FORCE)

# --- Curses/terminfo stubs ---
set(CURSES_FOUND TRUE CACHE BOOL "Curses found (stub)" FORCE)
set(CURSES_LIBRARY "${WASM_POSIX_SYSROOT}/lib/libc.a" CACHE FILEPATH "Curses library (stub)" FORCE)
set(CURSES_INCLUDE_PATH "${WASM_POSIX_SYSROOT}/include" CACHE PATH "Curses include path" FORCE)
set(CURSES_HAVE_CURSES_H FALSE CACHE BOOL "" FORCE)
set(CURSES_HAVE_NCURSES_H FALSE CACHE BOOL "" FORCE)

# --- PCRE2 paths ---
set(PCRE2_INCLUDE_DIR "${WASM_POSIX_SYSROOT}/include" CACHE PATH "PCRE2 include dir" FORCE)
set(PCRE_INCLUDE_DIRS "${WASM_POSIX_SYSROOT}/include" CACHE PATH "PCRE include dirs" FORCE)
set(NEEDS_PCRE2_DEBIAN_HACK FALSE CACHE BOOL "No PCRE2 debian hack needed" FORCE)

# --- Disable DTrace ---
set(ENABLE_DTRACE OFF CACHE BOOL "Disable DTrace for wasm64" FORCE)
