# cmake

CMake 4.5.0 for Kandelo: `cmake`, `ctest` and `cpack`, cross-compiled with
the build machine's CMake and the SDK. `cmake-data.zip` holds what they read
at run time: `share/cmake-4.5` (Modules, Templates, ...), CMake's
`share/aclocal/cmake.m4` and the license files under `share/doc/cmake-4.5`.
The shell installs the programs as lazy files and the archive as a lazy
archive at `/usr/`; the build image holds them resident
(`images/vfs/lib/init/dev-tools.ts`). Their manual pages are `cmake-docs`.

## Platform identity

Inside Kandelo, `uname` reports sysname `wasm-posix` and version `kandelo`.
Upstream CMake would take `wasm-posix` as `CMAKE_SYSTEM_NAME`, find no
platform module and fall back to generic defaults that assume shared
libraries work. `patches/0001-kandelo-platform.patch` names the machine
`Kandelo`, the name cross builds already use (`sdk/cmake/`), takes
`CMAKE_SYSTEM_PROCESSOR` from `uname -m` (`wasm32`), and adds
`Modules/Platform/Kandelo.cmake` for native builds:

- **Modules, not shared libraries.** A Kandelo executable cannot be
  linked against a shared library, but its `dlopen` loads the side
  modules `cc -shared` builds (see "Plugin modules" in
  `docs/sdk-guide.md`). The platform sets `TARGET_SUPPORTS_SHARED_LIBS`
  false, so `add_library(SHARED)` follows policy CMP0164: a project
  requiring CMake 3.30 or later stops with "the target platform does not
  support dynamic linking"; an older one gets CMake's warning and a
  static library. It also sets `TARGET_SUPPORTS_MODULE_LIBS`, a global
  property this patch adds to `add_library()`, so `add_library(MODULE)`
  builds a side module, `lib<name>.so`. As on every platform, no target
  can link against a `MODULE` library. `find_library()` finds only `.a`
  files.
- `ENABLE_EXPORTS` on an executable adds `-Wl,--export-dynamic`
  (`CMAKE_EXE_EXPORTS_<LANG>_FLAG`), which exports its default-visibility
  symbols to the modules it loads. WebAssembly symbols are hidden unless
  declared otherwise, and libc's are hidden (see "Plugin modules" in
  `docs/sdk-guide.md`).
- `CMAKE_DL_LIBS` is `dl`: `-ldl` links Kandelo's `dlopen` loader, and
  the `dlopen` in `libc.a` is musl's static stub.
- `UNIX` is set and the usual Unix search prefixes (`/usr/local`, `/usr`)
  apply.
- Executables have no suffix, as the guest `cc` writes them.

Kandelo is not Linux, and CMake does not say it is. `CMAKE_SYSTEM_NAME` is
`Kandelo`; projects that branch on `Linux` take their generic Unix path.

## Bundled and system libraries

Kandelo packages provide zlib, Expat, JsonCpp and libcurl (built with
OpenSSL and the CA bundle at `/etc/ssl/certs/ca-certificates.crt`), which
`file(DOWNLOAD)`, `FetchContent` and `ctest_submit()` use. CMake builds its
bundled libuv, libarchive, liblzma, bzip2, zstd and RHash; the `libzstd`
package decompresses only, and `cpack` compresses.

Downloads need a machine with a network. With the Node host's TCP network
enabled (`enableTcpNetwork`), `file(DOWNLOAD)` fetches `http://` and
`https://` URLs; without it, name lookup fails and CMake reports
`6;"Could not resolve hostname"`, the truthful answer for a machine with
no network. `runGuestBuild`, which the guest tests use, runs builds
without a network.

libuv has no Kandelo platform upstream. `patches/0002-cmlibuv-kandelo-posix-backend.patch`
builds it with libuv's portable POSIX backend, as on QNX and Cygwin:
`poll(2)` for the event loop, `clock_gettime(2)` for time,
`/proc/self/exe` for `uv_exepath()`, no file-system events and no process
titles. Child processes are started with `fork()` and `execvp()`, so the
three programs are fork-instrumented.

## Not built

`ccmake` (needs curses forms), `cmake-gui` (Qt) and the debugger
(`cmake --debugger`, which uses cppdap) are not built, and their pages are
not shipped.
