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

The 84 current cases cover image siblings and retained framebuffer storage,
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
enum rejection and maximum byte/short indexed client streams, logical buffer
and original client-attribute queries, unchanged query outputs on failure,
single ownership of backend GL errors, and bound byte/short index buffers
combined with client attributes (including failed-query cleanup/retry),
chunked shader/attribute/list queries with zero-sized outputs, failure
after a successful first chunk, core parameter queries and retained
EGLImage renderbuffer query identities, and rollback of both display-root
and object descriptors after a failed display-generation join. That case
checks unchanged output arguments, clean retry and root revocation. The
device double checks the actual initialization structs; guest kernel ioctl
marshalling still requires the normal rebuilt-artifact tests.
Generation cases also cover reinitialization before current release,
allocation and replacement-bind rollback, stale public handles, independent
encoder state, GEM cleanup on the importing description, two-thread
overlap and termination while a GL call acquires an image reference.
They also check uninitialized-display failures with unchanged query output,
image identities across repeated allocation and generation replacement,
and release of a temporary image reference after failed installation.
Native query
tests resolve the library's recorded heap allocation explicitly because the
guest wire format uses u32 pointers. They do not execute guest marshalling or
substitute for WebAssembly/browser tests.


The source WebGL contract suite also compiles selected current native C
cases through this harness, captures actual submitted bytes and replays them
through the browser decoder. Its float/fixed and maximum-index client-array cases are cross-layer
source evidence, not guest execution or unmodified CTS. Selection uses
`KANDELO_GRAPHICS_LIBC_CASES`; the default invocation still runs all 67 cases.
`KANDELO_GRAPHICS_COMMAND_TRACE` appends submitted command bytes to a supplied
file for those test-only replays. Each browser test owns and removes its
private trace directory.

`KANDELO_GRAPHICS_SESSION_TRACE` records the selected native-double fd,
submitted command bytes and context retirement. The browser generation
case replays those actual C streams into two host session targets, checks
red/blue pixels and proves old-target retirement preserves the new one.
These records do not execute guest initialization or ioctl marshalling.

The source host/browser surface cases also check retained presentation
storage across context replacement, failed resize preserving pixels,
independent native draw/read selectors and framebuffer-zero rebinding,
and final retirement after owner/selector release. The public-C records replay now checks same-generation multi-context
draw/read routing through native worker imports and main forwarding.
These source replays still do not establish normal guest integration or CTS.

The native index-usage query double supplies a controlled maximum/presence
reply; it does not dereference the guest's u32 input pointer on a 64-bit
native host. Replayed command traces omit synchronous queries. Separate
real-browser tests exercise the host's v3 query implementation against
native WebGL storage, including stale vertex/index views. Together these
are focused source evidence; guest end-to-end query marshalling and CTS
still require the normal rebuilt artifacts.


The host source gate (`host/vitest.graphics.config.ts`) includes independent
models of texture-zero allocation, per-unit binding and retirement. The
real WebGL state-contract suite also renders context-owned default 2D/cube
textures, including deletion recovery and subimage/copy operations, in all
three engines. These checks execute shared host source; they do not imply
public EGL sharing or guest CTS execution.


`KANDELO_GRAPHICS_PROTOCOL_TRACE` records test-only frames containing the
actual submitted command bytes and heap input bytes of acknowledged shader
upload queries. The browser suite replays those ordered frames directly
and through main-thread forwarding, then checks compiled shader source and
rendered pixels. The native allocation registry resolves only recorded
live heap ranges; other stack-input query doubles retain their documented
limitations. These traces do not replace guest/kernel marshalling tests.

`KANDELO_GRAPHICS_EGL_TRACE` records accepted public-C session creation,
context/surface IDs, current selection, command bytes and retirement. The
browser records case replays these calls through native host imports in a
worker and through main forwarding, probes actual draw/read pixels after
C clear batches, and checks native resource deletion. Its adapter supplies
the kernel dispatch role and uses a synthetic scratch module; it does not
execute Rust guest ioctl marshalling.

Native Wayland window descriptor ownership, resize rollback and final
buffer cleanup have a separate device/protocol-double regression:

```bash
scripts/dev-shell.sh bash tests/graphics/run-wayland-window-unit.sh /path/to/installed/wayland-protocols/stable/linux-dmabuf/linux-dmabuf-v1.xml
```

This check uses the provisioned SDK headers and dev-shell wayland-scanner.
The optional XML argument defaults to its installed path under sysroot.
It executes the actual native-window C source with UBSan; it does not run
Wayland peers, normal guest artifacts or a compositor.

The ABI 58 driver-level sharing source case constructs contexts through
native host imports and forwarding, using the reviewed share-context/
source-session identities. It checks common texture storage, independent
context containers, source/peer destruction, deleted-name retention and
reuse with actual pixels in all three engines. It uses a synthetic kernel
scratch adapter and does not execute Rust marshalling or public C sharing.

The C name-owner cases exercise the private shared-encoder constructor and
atomic namespace allocator directly. Their two-thread start barrier checks
common reservations without sharing encoder execution state; constructor
and batch allocation failures preserve the owner/output, and inactive-VAO
buffer cycles verify bounded tracked allocation lifetime. These are private
metadata tests, not public EGL sharing. The implicit/generated texture
regression also replays actual C calls and bytes into both renderer paths,
reads red/green/red storage in all three engines and checks native cleanup.


The retained-ARRAY cases exercise balanced private staging capture on
success, allocation failure and zero-count draws. Actual C vertex-first
and index-first streams are replayed in all three browser engines through
native worker imports and main forwarding. The fixture injects an explicit
renderer peer deletion/reuse after the temporary bind, then checks that
capturing an attribute from the restored ARRAY draws the original red
buffer rather than its blue replacement. It checks final native buffer,
VAO, texture, FBO and renderbuffer retirement. Program setup and peer
operations are fixture-provided; this proves the host's saved identity
with actual C staging bytes, not public C sharing or Rust marshalling.
Host tests separately cover failed native restore/retry, retained capture
cleanup and malformed/nested BEGIN/END. Complete context-loss recovery
and interrupted private-name cleanup remain open.
