# CMake toolchain file for cross-compiling to wasm64 via wasm-posix-kernel SDK.
#
# Usage:
#   cmake -DCMAKE_TOOLCHAIN_FILE=.../wasm64-posix-toolchain.cmake ...
#
# Produces LP64 binaries where sizeof(long) = sizeof(void*) = 8.
# Requires: LLVM 21+ clang with wasm64 support (Homebrew llvm)
#           wasm-posix-kernel sysroot64 built via scripts/build-musl.sh --arch wasm64posix

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
#   3. Homebrew LLVM — for Mac users running outside the flake.
set(_LLVM_SEARCH_PATHS)
if(DEFINED ENV{LLVM_BIN})
  list(APPEND _LLVM_SEARCH_PATHS "$ENV{LLVM_BIN}")
endif()
if(DEFINED ENV{LLVM_PREFIX})
  list(APPEND _LLVM_SEARCH_PATHS "$ENV{LLVM_PREFIX}/bin")
endif()
list(APPEND _LLVM_SEARCH_PATHS
  /opt/homebrew/opt/llvm/bin
  /usr/local/opt/llvm/bin
)

find_program(LLVM_CLANG NAMES clang PATHS ${_LLVM_SEARCH_PATHS} NO_DEFAULT_PATH)
if(NOT LLVM_CLANG)
  message(FATAL_ERROR
    "LLVM clang not found. Searched: ${_LLVM_SEARCH_PATHS}. "
    "Set LLVM_BIN (Nix dev shell exports this) or install Homebrew LLVM."
  )
endif()
find_program(LLVM_AR     NAMES llvm-ar     PATHS ${_LLVM_SEARCH_PATHS} NO_DEFAULT_PATH)
find_program(LLVM_RANLIB NAMES llvm-ranlib PATHS ${_LLVM_SEARCH_PATHS} NO_DEFAULT_PATH)
find_program(LLVM_NM     NAMES llvm-nm     PATHS ${_LLVM_SEARCH_PATHS} NO_DEFAULT_PATH)

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

# --- Compiler flags ---
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

# --- Linker flags ---
set(WASM64_LINK_FLAGS
  "-nostdlib"
  "-Wl,--entry=_start"
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
  "-Wl,-z,stack-size=1048576"
)
string(REPLACE ";" " " WASM64_LINK_FLAGS_STR "${WASM64_LINK_FLAGS}")

# --- Startup objects and runtime libraries ---
get_filename_component(_TOOLCHAIN_DIR2 "${CMAKE_CURRENT_LIST_FILE}" DIRECTORY)
set(_GLUE_OBJ_DIR "${_TOOLCHAIN_DIR2}/mariadb-glue-objs-64")

set(CMAKE_EXE_LINKER_FLAGS_INIT
  "${WASM64_LINK_FLAGS_STR} ${WASM_POSIX_SYSROOT}/lib/crt1.o ${_GLUE_OBJ_DIR}/channel_syscall.o ${_GLUE_OBJ_DIR}/compiler_rt.o -lc++ -lc++abi -lc"
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
