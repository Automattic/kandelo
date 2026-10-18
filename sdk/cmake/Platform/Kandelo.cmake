# CMake platform identity for Kandelo, shared by every CMake build in the
# repository (the SDK toolchain file, and builds such as libcxx that drive
# clang directly). Kandelo is a POSIX Unix; saying so here lets upstream CMake
# projects take their generic Unix paths without a Kandelo-named branch.
# `Generic` hid that: libc++abi, for example, then skipped
# cxa_thread_atexit.cpp, leaving thread_local destructors undefined.
# Kandelo is a POSIX-compatible Unix platform targeting WebAssembly.
set(UNIX 1)
set(CMAKE_EXECUTABLE_SUFFIX ".wasm")
set(CMAKE_STATIC_LIBRARY_PREFIX "lib")
set(CMAKE_STATIC_LIBRARY_SUFFIX ".a")
