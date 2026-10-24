# Graphics conformance provenance

Upstream: https://github.com/KhronosGroup/VK-GL-CTS
Revision: `a119e62de3bb38dae67f05abee8acd011e0c729c` (inspected 2026-10-23).
License: Apache-2.0 for the inspected EGL/GLES2 modules; preserve individual
source notices when importing files.

Inspected sources include `modules/egl/teglSurfacelessContextTests.cpp`,
`teglQueryContextTests.cpp`, `teglImageTests.cpp`, and the GLES2 package
registration. The upstream harness uses its EGL library dispatch and
native-display factories, logging/result framework and C++ utilities. A
Kandelo adapter must supply a GBM display, native window and executable
entry point through the ordinary SDK; it must not change assertions or
replace guest EGL/GLES calls with direct host WebGL calls.

Enabled upstream assertions: the surfaceless method described below.
No guest CTS execution result is claimed until its runner has completed.
Do not label translated or inspired regressions as unmodified CTS tests.
Track enabled cases and exact source hashes here as they are integrated.

See [the versioned compatibility inventory](../../docs/graphics/compatibility-v1.md)
for required coverage and separate expansions.

The first port is `cts/surfaceless-case.inc`: the unchanged
`SurfacelessContextCase::executeForConfig` method, with its original license
notice. `cts/upstream.json` records the complete upstream file hash and exact
method hash. The standalone adapter supplies GBM display/config enumeration,
EGL dispatch, logs and results; it does not replace guest EGL calls. It runs
this method for every enumerated configuration. This is an adapted CTS
subset, not an execution of the complete dEQP framework or its filter groups.

Verify the assertions with:

```
python3 tests/graphics/verify-cts-source.py /path/to/pinned/VK-GL-CTS
```

Build the wasm32 guest through the normal package resolver. The existing
graphics SDK archives and libdrm recipe are wasm32-only; this package does
not advertise a wasm64 graphics build:

```
scripts/dev-shell.sh cargo xtask build-deps resolve graphics-cts-egl --arch wasm32
```

The native libc device-double suite checks image ownership and command
encoding under UndefinedBehaviorSanitizer. AddressSanitizer is optional via
`KANDELO_GRAPHICS_SANITIZERS=address,undefined`; its LLVM 21 runtime
deadlocked before main on macOS 27 during this investigation. It executes the
actual EGL/GLES library sources with recorded device calls; it provides no
pixel-rendering evidence. To compare a source revision:

```
scripts/dev-shell.sh bash tests/graphics/run-libc-unit.sh ce8cd9dbcf
scripts/dev-shell.sh bash tests/graphics/run-libc-unit.sh
```

The forty-six current cases cover image siblings and retained framebuffer storage,
redefinition, cleanup, invalid handles, repeated contexts, the shared
shader/program namespace, boolean numeric conversion, vectors longer than
four elements, unchanged query output after device failure and EGL config
selection/enumeration/negative queries, thread-local errors, API binding,
current-context exclusion/transfer, thread-exit flushing, deferred context/
surface/display teardown, stale handles, bind rollback and failed context
allocation followed by retry, surfaceless backend binding, failed-release
rollback, backend bind errors and atomic native-window retargeting,
encoder allocation rollback, unbound-thread isolation, state transfer
between threads and context-owned string caching, deleted array/index binding
reset, per-VAO client attributes and indices, reused-name generation isolation,
reserved name allocation and draw-staging allocation failure/retry, large
client uploads, sparse-index/prefix/stride guard pages, packed byte output,
scratch allocation rollback and signed-size overflow rejection, early draw
enum rejection and maximum byte/short indexed client streams.
Native query
tests resolve the library's recorded heap allocation explicitly because the
guest wire format uses u32 pointers. They do not execute guest marshalling or
substitute for WebAssembly/browser tests.


The source WebGL contract suite also compiles selected current native C
cases through this harness, captures actual submitted bytes and replays them
through the browser decoder. Its float/fixed and maximum-index client-array cases are cross-layer
source evidence, not guest execution or unmodified CTS. Selection uses
`KANDELO_GRAPHICS_LIBC_CASES`; the default invocation still runs all 46 cases.
`KANDELO_GRAPHICS_COMMAND_TRACE` appends submitted command bytes to a supplied
file for those test-only replays. Each browser test owns and removes its
private trace directory.
