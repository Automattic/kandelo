# CMake toolchain file for cross-compiling espeak-ng + libpcaudio (with
# the kandelo backend) to wasm32 via the kandelo SDK.
#
# Adapted from packages/registry/mariadb/wasm32-posix-toolchain.cmake.
# espeak-ng doesn't probe nearly as many host features as MariaDB so we
# omit the long HAVE_* override list.

cmake_minimum_required(VERSION 3.13)

set(CMAKE_SYSTEM_NAME Linux)
set(CMAKE_SYSTEM_PROCESSOR wasm32)
set(CMAKE_CROSSCOMPILING TRUE)

# --- Locate LLVM clang ---
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
  "-fno-trapping-math"
  "--sysroot=${WASM_POSIX_SYSROOT}"
)
string(REPLACE ";" " " WASM32_FLAGS_STR "${WASM32_FLAGS}")
set(CMAKE_C_FLAGS_INIT "${WASM32_FLAGS_STR}")
set(CMAKE_CXX_FLAGS_INIT "${WASM32_FLAGS_STR}")

# --- Linker flags (mirror sdk/src/lib/flags.ts LINK_FLAGS) ---
# Path to the kandelo glue objs that the SDK normally injects. We hand
# them to CMake via CMAKE_EXE_LINKER_FLAGS_INIT so cmake's link rule
# picks them up for `add_executable` targets (espeak-ng-bin).
get_filename_component(_TOOLCHAIN_DIR2 "${CMAKE_CURRENT_LIST_FILE}" DIRECTORY)
set(_GLUE_OBJ_DIR "${_TOOLCHAIN_DIR2}/glue-objs")

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

set(CMAKE_EXE_LINKER_FLAGS_INIT
  "${WASM32_LINK_FLAGS_STR} ${WASM_POSIX_SYSROOT}/lib/crt1.o ${_GLUE_OBJ_DIR}/channel_syscall.o ${_GLUE_OBJ_DIR}/compiler_rt.o -lc"
)

# --- Type sizes for wasm32 ILP32 ---
set(CMAKE_SIZEOF_VOID_P 4)
set(CMAKE_C_SIZEOF_DATA_PTR 4)
set(CMAKE_CXX_SIZEOF_DATA_PTR 4)

# --- Search paths ---
set(CMAKE_FIND_ROOT_PATH "${WASM_POSIX_SYSROOT}")
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)

# Disable try_run; espeak-ng's check_symbol_exists / check_include_file
# only need to compile, not link.
set(CMAKE_TRY_COMPILE_TARGET_TYPE STATIC_LIBRARY)

# espeak-ng's USE_ASYNC option gates on find_package(Threads). Kandelo
# libc provides pthread but CMake's Threads detection runs a try_compile
# that may falsely conclude pthreads is missing under cross-compile. We
# advertise it explicitly.
set(THREADS_PTHREAD_ARG "0" CACHE STRING "" FORCE)
set(CMAKE_THREAD_LIBS_INIT "-lpthread" CACHE STRING "" FORCE)
set(CMAKE_HAVE_THREADS_LIBRARY 1 CACHE BOOL "" FORCE)
set(CMAKE_USE_WIN32_THREADS_INIT 0 CACHE BOOL "" FORCE)
set(CMAKE_USE_PTHREADS_INIT 1 CACHE BOOL "" FORCE)
set(THREADS_FOUND TRUE CACHE BOOL "" FORCE)
