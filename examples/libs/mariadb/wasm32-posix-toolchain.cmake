# CMake toolchain file for cross-compiling to wasm32 via wasm-posix-kernel SDK.
#
# Usage:
#   cmake -DCMAKE_TOOLCHAIN_FILE=.../wasm32-posix-toolchain.cmake ...
#
# Requires: LLVM 19+ clang with wasm32 support (Homebrew llvm)
#           wasm-posix-kernel sysroot built via scripts/build-musl.sh

cmake_minimum_required(VERSION 3.13)

# --- System identification ---
# Use "Linux" to activate POSIX code paths in MariaDB's CMake.
set(CMAKE_SYSTEM_NAME Linux)
set(CMAKE_SYSTEM_PROCESSOR wasm32)
set(CMAKE_CROSSCOMPILING TRUE)

# --- Locate LLVM clang ---
# Prefer Homebrew LLVM (macOS) over system clang.
find_program(LLVM_CLANG
  NAMES clang
  PATHS /opt/homebrew/opt/llvm/bin /usr/local/opt/llvm/bin
  NO_DEFAULT_PATH
)
if(NOT LLVM_CLANG)
  message(FATAL_ERROR "Homebrew LLVM clang not found. Install: brew install llvm")
endif()

find_program(LLVM_AR
  NAMES llvm-ar
  PATHS /opt/homebrew/opt/llvm/bin /usr/local/opt/llvm/bin
  NO_DEFAULT_PATH
)
find_program(LLVM_RANLIB
  NAMES llvm-ranlib
  PATHS /opt/homebrew/opt/llvm/bin /usr/local/opt/llvm/bin
  NO_DEFAULT_PATH
)
find_program(LLVM_NM
  NAMES llvm-nm
  PATHS /opt/homebrew/opt/llvm/bin /usr/local/opt/llvm/bin
  NO_DEFAULT_PATH
)

# --- Sysroot ---
# Allow override via WASM_POSIX_SYSROOT env or cmake var.
if(NOT WASM_POSIX_SYSROOT)
  if(DEFINED ENV{WASM_POSIX_SYSROOT})
    set(WASM_POSIX_SYSROOT "$ENV{WASM_POSIX_SYSROOT}")
  else()
    # Default: repo_root/sysroot (toolchain file is at examples/libs/mariadb/)
    get_filename_component(_TOOLCHAIN_DIR "${CMAKE_CURRENT_LIST_FILE}" DIRECTORY)
    get_filename_component(WASM_POSIX_SYSROOT "${_TOOLCHAIN_DIR}/../../../sysroot" ABSOLUTE)
  endif()
endif()

if(NOT EXISTS "${WASM_POSIX_SYSROOT}/lib/libc.a")
  message(FATAL_ERROR "Sysroot not found at ${WASM_POSIX_SYSROOT}. Run scripts/build-musl.sh first.")
endif()

set(CMAKE_SYSROOT "${WASM_POSIX_SYSROOT}")

# --- Compilers ---
set(CMAKE_C_COMPILER "${LLVM_CLANG}")
set(CMAKE_CXX_COMPILER "${LLVM_CLANG}")
set(CMAKE_AR "${LLVM_AR}" CACHE FILEPATH "Archiver")
set(CMAKE_RANLIB "${LLVM_RANLIB}" CACHE FILEPATH "Ranlib")
set(CMAKE_NM "${LLVM_NM}" CACHE FILEPATH "NM")

# --- Compiler flags (mirror sdk/src/lib/flags.ts COMPILE_FLAGS) ---
set(WASM32_FLAGS
  "--target=wasm32-unknown-unknown"
  "-matomics"
  "-mbulk-memory"
  "-mexception-handling"
  "-mllvm" "-wasm-enable-sjlj"
  "-fno-exceptions"
  "-fno-trapping-math"
  "--sysroot=${WASM_POSIX_SYSROOT}"
)
string(REPLACE ";" " " WASM32_FLAGS_STR "${WASM32_FLAGS}")

set(CMAKE_C_FLAGS_INIT "${WASM32_FLAGS_STR}")
set(CMAKE_CXX_FLAGS_INIT "${WASM32_FLAGS_STR} -nostdinc++ -isystem ${WASM_POSIX_SYSROOT}/include/c++/v1 -D_LIBCPP_HAS_MUSL_LIBC -D_LIBCPP_HAS_THREAD_API_PTHREAD -D_LIBCPP_PROVIDES_DEFAULT_RUNE_TABLE")

# --- Linker flags (mirror sdk/src/lib/flags.ts LINK_FLAGS) ---
set(WASM32_LINK_FLAGS
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
string(REPLACE ";" " " WASM32_LINK_FLAGS_STR "${WASM32_LINK_FLAGS}")

# --- Startup objects and runtime libraries ---
# crt1.o provides _start; glue objects provide syscall channel + compiler builtins;
# libc.a/libc++.a provide C/C++ standard libraries.
get_filename_component(_TOOLCHAIN_DIR2 "${CMAKE_CURRENT_LIST_FILE}" DIRECTORY)
set(_GLUE_OBJ_DIR "${_TOOLCHAIN_DIR2}/mariadb-glue-objs")

set(CMAKE_EXE_LINKER_FLAGS_INIT
  "${WASM32_LINK_FLAGS_STR} ${WASM_POSIX_SYSROOT}/lib/crt1.o ${_GLUE_OBJ_DIR}/channel_syscall.o ${_GLUE_OBJ_DIR}/compiler_rt.o -lc++ -lc++abi -lc"
)

# --- Type sizes for wasm32 ILP32 ---
# These prevent CMake from trying to run test programs.
set(CMAKE_SIZEOF_VOID_P 4)
set(CMAKE_C_SIZEOF_DATA_PTR 4)
set(CMAKE_CXX_SIZEOF_DATA_PTR 4)

# Hardcode type sizes — wasm32 is ILP32 with 64-bit off_t.
set(SIZEOF_CHAR 1 CACHE STRING "sizeof(char)")
set(SIZEOF_SHORT 2 CACHE STRING "sizeof(short)")
set(SIZEOF_INT 4 CACHE STRING "sizeof(int)")
set(SIZEOF_LONG 4 CACHE STRING "sizeof(long)")
set(SIZEOF_LONG_LONG 8 CACHE STRING "sizeof(long long)")
set(SIZEOF_OFF_T 8 CACHE STRING "sizeof(off_t)")
set(SIZEOF_CHARP 4 CACHE STRING "sizeof(char*)")
set(SIZEOF_VOIDP 4 CACHE STRING "sizeof(void*)")

# --- Search paths ---
set(CMAKE_FIND_ROOT_PATH "${WASM_POSIX_SYSROOT}")
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)   # Use host programs
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)     # Use target libraries
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)     # Use target headers
set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)

# --- Disable try_run ---
set(CMAKE_TRY_COMPILE_TARGET_TYPE STATIC_LIBRARY)

# --- Override false positives from static-library try_compile ---
# When CMAKE_TRY_COMPILE_TARGET_TYPE is STATIC_LIBRARY, check_function_exists
# always succeeds because it only compiles (no link). We must explicitly mark
# functions that do NOT exist in musl.
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
# Note: musl provides dl stubs; keep HAVE_DLOPEN default (1) to avoid Dl_info conflict
set(HAVE_ABI_CXA_DEMANGLE 0 CACHE INTERNAL "")
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

# --- Disable SSL/TLS for both server and client library ---
# The server uses -DWITH_SSL=OFF, but libmariadb (connector/C) has its own
# SSL handling. Prevent FindGnuTLS from being called by pre-setting results.
set(WITH_SSL "OFF" CACHE STRING "Disable SSL" FORCE)
set(GNUTLS_FOUND FALSE CACHE BOOL "" FORCE)
set(GNUTLS_LIBRARY "GNUTLS_LIBRARY-NOTFOUND" CACHE FILEPATH "" FORCE)
set(GNUTLS_INCLUDE_DIR "GNUTLS_INCLUDE_DIR-NOTFOUND" CACHE PATH "" FORCE)
set(OPENSSL_FOUND FALSE CACHE BOOL "" FORCE)

# --- Curses/terminfo stubs ---
# MariaDB's bundled editline requires curses. Our sysroot doesn't have it,
# but MariaDB only uses it for the interactive mysql CLI (not mariadbd).
# Satisfy the cmake check with stubs.
set(CURSES_FOUND TRUE CACHE BOOL "Curses found (stub)" FORCE)
set(CURSES_LIBRARY "${WASM_POSIX_SYSROOT}/lib/libc.a" CACHE FILEPATH "Curses library (stub)" FORCE)
set(CURSES_INCLUDE_PATH "${WASM_POSIX_SYSROOT}/include" CACHE PATH "Curses include path" FORCE)
set(CURSES_HAVE_CURSES_H FALSE CACHE BOOL "" FORCE)
set(CURSES_HAVE_NCURSES_H FALSE CACHE BOOL "" FORCE)

# --- Disable DTrace ---
# DTrace probes require host dtrace tool which can't target wasm32.
set(ENABLE_DTRACE OFF CACHE BOOL "Disable DTrace for wasm32" FORCE)
