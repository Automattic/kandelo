# libuv loop backend

This initial wasm32 library builds the exact libuv 1.52.1 sources in the
verified Node.js 26.13.0 archive through upstream CMake and Kandelo's normal
SDK/resolver/cache. It is groundwork for the unchanged upstream Node runtime;
Node's SpiderMonkey embedding does not use this library yet.

The standalone libuv 1.52.1 release differs from Node's copy in
src/unix/fs.c, src/uv-common.c, src/win/fs-event.c and src/win/tcp.c.
The recipe therefore selects deps/uv from the pinned Node archive, keeping
its existing patch set. The added patch selects upstream posix-poll.c and
posix-hrtime.c for CMAKE_SYSTEM_NAME=Kandelo. It never defines __linux__.

Consumers must use the installed CMake target libuv::uv_a or
pkg-config --cflags --libs libuv-static. Both supply
UV_PLATFORM_KANDELO=1, which selects the matching public uv_loop_t layout.
Omitting it creates an incompatible layout; it is a required compile flag.

The thread-entry patch replaces upstream's incompatible function-pointer
cast with a real pointer-returning pthread wrapper. A successful creation
transfers the allocated callback/argument pair to the child, which copies
and frees it before calling the original void callback. Creation failure
frees the pair in the caller. This is a C callback-signature portability
fix, not an engine or kernel workaround.

Filesystem event watching uses upstream's no-fsevents.c: initialization
returns UV_ENOSYS. Process-title get/set also return UV_ENOSYS rather than
upstream no-proctitle.c's successful no-ops. No title/argument storage is
allocated. These are explicit gaps, not implemented functionality.

This is an initial event-loop backend, not complete libuv support. OS-specific
resource/CPU/network-interface reporting and executable-path functions have
not been added; consumers of missing functions fail to link. Target-header AST
and archive-symbol inventory found 318 declared public functions, with these
ten missing: uv_cpu_info, uv_exepath, uv_get_available_memory,
uv_get_constrained_memory, uv_get_free_memory, uv_get_total_memory,
uv_interface_addresses, uv_loadavg, uv_resident_set_memory and uv_uptime.
The other 308 having symbols is not runtime conformance evidence. Process spawn,
signal behavior, socket operations, DNS, cancellation, fork recovery, OOM and
full teardown still need focused validation. No product image includes this
library, and it is not in the local-supported build set. No generated upstream
man pages are shipped; upstream's documentation is Sphinx source, not an
installed man-page set.

The self-judging test/backend-controls.c uses real guest clocks, descriptors,
threads and files. Its CMake consumer checks public ABI layouts and exercises
empty loops, timers/ref/close, prepare/check phases, cross-thread async wakeups,
thread-pool work, pipe polling and async filesystem effects, plus explicit
unsupported boundaries. Results and artifact identities belong in the upstream
Node evidence ledger; this source alone is not proof that any host passes.

## Focused checks

Run these from the repository root. The build script resolves the declared
library, builds a static guest executable, and applies the normal fork
instrumenter. These checks use an empty guest filesystem, not a partial or
canonical product image. The browser fixture explicitly disables canonical
/etc seeding and historical ABI-fixture provisioning; it retains the real
BrowserKernel, workers, syscalls and image writer.

```bash
scripts/dev-shell.sh bash packages/registry/libuv/test/build-controls.sh "$PWD/.scratch/libuv-controls"
scripts/dev-shell.sh node_modules/.bin/tsx scripts/run-libuv-backend-controls.ts \
  .scratch/libuv-controls/libuv-backend-controls.wasm .context/libuv-node-controls.json
scripts/dev-shell.sh bash -c '
  export KANDELO_LIBUV_CONTROLS_WASM="$PWD/.scratch/libuv-controls/libuv-backend-controls.wasm"
  apps/browser-demos/node_modules/.bin/playwright test \
    --config tests/nodejs/upstream/libuv-browser/playwright.config.ts \
    --project chromium --project firefox --project webkit
'
```

The browser runner needs the normal image-builder helpers. If absent, build
them with `scripts/dev-shell.sh bash crates/kandelo-image-module/build-wasm.sh`.
It does not need a canonical rootfs image. Current identified-artifact results,
failed attempts and limits are in
[libuv-backend-engine-check.json](../../../tests/nodejs/upstream/libuv-backend-engine-check.json).
