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

The 103 current cases cover image siblings and retained framebuffer storage,
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


The checked uniform-value cases read scalar/vector/matrix widths without
prior reflection, protect destination guards and preserve outputs after
allocation, transport or reply failure. The actual C vec4 regression fails
against unchanged c0d87638be. Driver-level shared-context browser checks
cover native and forwarded values for matrix/vector/array/boolean types,
source retirement, failed-link executable retention, successful relink
invalidation, deletion pending/current release and final native shader/
program cleanup. They use source host code with a synthetic kernel scratch
adapter; public C sharing and normal guest marshalling remain separate.


The checked name/reflection cases transfer 140,001-byte lookup strings and
70,000-byte reflected names with bounded protocol records. They test each
phase's malformed/transport/GL failure, cancellation, replacement and
unchanged public outputs. These C transfer checks supply device-double
lookup success, not a renderer accepting arbitrarily long identifiers.
Host tests cover shared stable locations, array aliases, index exhaustion,
metadata rollback and context-local pending storage. The shared-uniform
browser cases additionally check an actual 249-character uniform, checked
reflection chunks and a long inactive-name transfer through both routes
in all engines. Source/name translation for active names beyond WebGL's
limits remains required work.


Shared reservation source tests distinguish C-owned names from native
objects realized on first bind. Delayed declarations must preserve a
peer's texture/renderbuffer pixels and buffer bytes; unused reservations
and declarations after deletion must not create objects. The browser
case checks native/forwarded dispatch in all engines, exact native buffer/
texture/renderbuffer creation counts and final deletion. Existing unit
lifetime fixtures explicitly bind before retaining their native identity.
These source checks do not establish public C sharing or guest marshalling.


The C image-record cases check retained 2D/cube/RBO bindings and FBO
references, logical binding queries after EGLImage import, target mismatch
rollback, unrealized/wrong-type/default attachments, allocation failure,
100 deletion/reuse cycles and growth to a reported 64-unit limit. The
allocation counter measures tracked C records. The native device double
models native texture types and per-session/unit bindings. Public WPK names
also cover attachment without a prior C bind, type checking, native-authority
binding queries and reuse after BO-owner revocation. Query selection
is explicit fixture state rather than inferred from truncated stack
pointers. An actual C stream also renders red, rejects a cube-to-2D bind,
deletes the cube and uploads blue through the preserved binding. Browser
replay checks both routes in all engines and final native cleanup. Shared
image storage, sampler independence and full submit recovery remain open.


The acknowledged image-binding cases inject native allocation rejection,
transport failure and malformed reply status/value/completion. A failed
first 2D bind can be retried as a cube, and image targeting still uses the
prior C binding. Host checks cover texture/RBO creation, native and namespace
allocation failures, failed candidate cleanup, queued/query parity, retained
object collection, pending errors and request/reply span validation.
Actual C trace replay now includes checked bind requests and verifies their
replies. The new rendering trace injects native texture-creation failure,
retries that name as a cube and uploads blue through the surviving red 2D
texture. Both renderer routes and all three engines check pixels and final
native cleanup. These do not prove storage replacement or indeterminate
transport recovery.


GPU image-storage checks now cover independent logical objects and canonical
pixel storage. Four C cases check definite texture/RBO replacement rollback,
checked import rejection and ambiguous completion retaining the input image.
Row-upload counts have a positive retry control. Seven host cases cover the
private source namespace, allocator, query bounds, logical native-view
queries and real host-import source registration. The three-engine native
GPU driver checks independent parameters, canonical writes and sampling,
texture/mipmap/RBO orphaning, reimport, allocation/retarget failure, retained
peer identity and final native cleanup. It uses actual renderer paths with
synthetic kernel scratch plumbing, not guest marshalling or public C sharing.
Forwarded BO registration, CPU canonical views and full shared C storage
holds remain open. The standalone Chromium copy/respecification reproduction
lives in `tests/runtime-workarounds/CHROMIUM-COPY-TEX-RESPEC/`.


Bound-image protocol checks distinguish an old retained binding from a new
object with the same public number. Texture and renderbuffer cases verify
accepted import/orphan revisions, metadata and native-retarget rollback,
revision exhaustion and final collection. The GPU browser driver imports
into the unnamed old binding, checks the source/revision reply and red
pixels, and observes unchanged yellow pixels through the peer's reused
name. Public C shared-image hold publication remains a separate requirement.
