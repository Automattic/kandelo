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

The browser runner consumes the normal package binary and current kernel,
constructs its test image through KandeloImageFs, and executes the guest
through BrowserKernel with a real worker-owned WebGL renderer:

```bash
scripts/dev-shell.sh bash -c 'cd apps/browser-demos && node_modules/.bin/playwright test test/graphics-cts-egl.spec.ts --workers 1 --project chromium --project firefox --project webkit'
```

It requires a passing result for every enumerated advertised GLES2 config,
without changing the upstream method or accepting its optional BAD_MATCH
branch for this advertised capability. Collection alone is not a guest
CTS result. Normal package/kernel provisioning must finish before execution.

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

The native cases cover image siblings and retained framebuffer storage,
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
`KANDELO_GRAPHICS_LIBC_CASES`; the default invocation runs all 211 cases.
`KANDELO_GRAPHICS_COMMAND_TRACE` appends submitted command bytes to a supplied
file for those test-only replays. Each browser test owns and removes its
private trace directory.

`KANDELO_GRAPHICS_SESSION_TRACE` records the selected native-double fd,
submitted command bytes and context retirement. The browser generation
case replays those actual C streams into two host session targets, checks
red/blue pixels and proves old-target retirement preserves the new one.
These records do not execute guest initialization or ioctl marshalling.

Raw BO cases also check reserved-name collision/retry, failed-flush suppression
and C group ordering across native raw-name allocation and publication. The
ordering fixture observes the peer's actual mutex attempt while device IO is
paused; it uses no scheduling delay. The source host gate checks name
exhaustion, metadata/native failures, retained raw object generations and retry
after failed view/canonical retirement, including the last context's teardown.
The GPU browser fixture samples independent raw views, respecifies and refreshes
them, deletes/reimports while a peer retains the old identity, and verifies that
BO retirement preserves an unrelated numeric replacement. It checks output
preflight, unchanged output while cleanup blocks the group, and accepted retry.
These checks do not establish CPU canonical coherence, forwarded BO imports or
general context-loss recovery.

Storage recovery cases also cover shared texture/RBO retarget rollback after
submitter retirement, nested copy-view/buffer binding restoration, candidate
allocation failure and cleanup that only partially accepts. Native receipts
preserve old storage/revisions and prevent duplicate deletion. Reused sessions
do not inherit retired cleanup errors. The GPU browser case partially retargets
two peer framebuffers, rejects the inverse and checks unchanged output while
blocked. Retry restores red pixels and the old source/revision. Accepted owned
storage remains committed while retired-view deletion blocks subsequent work;
canonical BO retirement waits, then both peer FBOs render fresh blue storage.
These remain focused source checks with synthetic kernel identity plumbing.

Eight source host cases cover repeated native rollback failure: texture/RBO
container deletion, framebuffer selectors, normal/converted vertex attributes,
same/different cached muxer owners, and retirement of context-local inverses
while shared peer objects survive. Five query/output regressions fail against
unchanged `e47d3766e0`. The browser GPU case injects a rejected texture deletion
and repeated native reattachment errors, verifies that local/peer queries and a
command batch fail while state is dirty, preserves output preflight/sentinels,
then accepts restoration and reads the original red pixels. This covers the
adopted inverse paths, not transport uncertainty or all storage rollback.

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
Forwarded BO registration, CPU canonical views and concurrent C/native
namespace ordering remain open. The standalone Chromium copy/respecification reproduction
lives in `tests/runtime-workarounds/CHROMIUM-COPY-TEX-RESPEC/`.


Bound-image protocol checks distinguish an old retained binding from a new
object with the same public number. Texture and renderbuffer cases verify
accepted import/orphan revisions, metadata and native-retarget rollback,
revision exhaustion and final collection. The GPU browser driver imports
into the unnamed old binding, checks the source/revision reply and red
pixels, and observes unchanged yellow pixels through the peer's reused
name. C now consumes these implicit-bound replies for shared per-object image
holds; public sharing still requires namespace ordering and failure recovery.


The uncertain-import peer cases cover texture and renderbuffer candidates
held after transport failure or an invalid completion. They destroy the
public image and submitting context while a private shared metadata peer
survives, then require BO release only after that peer retires. They fail
against unchanged table-11 sources before the shared quarantine change.
The private peer is not a public EGL context and retires before its display
generation; these cases prove C ownership, not peer rendering or public sharing.


Checked image-mutation cases reject texture/RBO attachment replacement,
texture/RBO/FBO deletion and ordinary texture allocation. They retain old
backing after definite rejection, accept retry and forbid row uploads after
failed allocation, with a positive retry control. The equivalent device-double
rejection applies to the old queued path for baseline comparison. Uncertain
attachment replies pin the candidate object through group retirement;
transport, missing completion, wrong ACK and invalid status are covered.
Host checks cover staged metadata, reverse native rollback, active-unit
selection, separate draw/read defaults and queued/checked parity. Browser
GPU checks inject actual invalid native enums and compare preserved pixels;
C replay carries checked allocation/attachment/deletion through both renderer
routes. These are focused source checks, with synthetic kernel plumbing;
public C sharing, guest marshalling and complete context-loss recovery remain
separate requirements.


The framebuffer-bind regression rejects native selection, then detaches the
old retained image. C must select the same container as the renderer and
release the final image hold on accepted detachment. Its queued-path rejection
also runs against the preceding source revision. Host cases cover exact
binding spans, candidate creation/metadata failure, native bind rejection,
separate read/draw default rollback and queued/query parity. The source GPU
driver checks preserved pixels after failed native creation/binding and a
successful retry; public C record replay carries accepted binds through both
renderer routes. Indeterminate/context-loss reconciliation remains open.


Confirmed-image ownership cases retain backing through source-encoder
retirement while a private shared metadata peer keeps the named texture/RBO
alive. Both regressions fail against unchanged `4d0961a02a`. Other cases
reenter group name allocation during final GEM close to require image/device
cleanup outside the metadata mutex, and deliver older import/owned-state
completions after a newer import. They check exact retained image counts,
stale-row suppression, accepted retry and final zero tracked allocations.
These device-double interleavings do not prove parallel public EGL sharing.
C trace event 12 carries implicit-bound source/revision replies for validation
through both actual browser renderer routes. The affected browser selection
is `--grep "actual C|logical image views"`; it does not replace the full
source suite or the deferred normal guest, CTS and memory-cycle gates.


Buffer-bind rejection cases inject the same failure into old queued and new
checked paths. They reject both zero and positive bindings, require the old
C attribute/index interpretation to agree with native state, accept retry
and finish with zero tracked allocations. Both fail unchanged `332c7977ed`.
Host cases cover native/store/view metadata failure and cross-class transfer
rollback before a later successful bind. Client-array browser traces include
actual synchronous queries and submits in order; peer-deletion injection
recognizes both binding encodings. The GPU driver checks preserved native
buffer bytes after rejected creation/binding and accepted retry on both
targets. Buffer deletion and concurrent namespace ordering remain open.


Buffer-delete rejection cases preserve C attribute/index interpretation and
native selectors after failed deletion, then accept retry and require final
zero tracked allocations. Both fail unchanged `3fc319e85f`. Host deletion
checks restore multiple ordinary/converted attribute pointers and separate
index views after partial failure, including a wrapper that mutates before
reporting an error. Metadata copies precede effects; queued multi-name and
checked single-name paths share the transaction. Source GPU checks render
after temporary allocation/pointer/late selector/release rejection, require
all active native references cleared on acceptance, then reuse the number
with fresh data and render again. Generic C query replay validates the checked
deletions on native and forwarded routes. These checks do not prove concurrent
public C sharing or general recovery after multiple native failures.


Public shared-context cases validate creation failure/retry, source-handle
retirement, texture/RBO image lifetime through peer orphaning, standard name
transaction ordering and deferred cancellation. The fixture interposes native
mutex lock attempts and requires the peer to encounter a busy dispatch lock
while a real binder query is paused, then observes release and progress.
The adapted baseline keeps `cfdd9a9c9f` GLES unchanged and uses the current
EGL construction adapter solely to admit the public group; both ordering
cases fail. Source rendering traces check shared texture/FBO pixels through
source retirement and numeric reuse via native and forwarded routes. The
fixture tracks image revisions per native share group. Sanitizer recovery
is disabled so diagnostics fail the runner. Abrupt worker death, general
indeterminate recovery, raw WPK namespace mutation and full guest/CTS
sharing validation remain open.


Client-array and vertex failure checks also cover completion without a repeated
private END, ticket allocation failure, zero/cancelled captures, reconciliation
before muxer replay, and normal/converted/default pointer rollback. Attribute
metadata capacity precedes native effects. Promoted-index restoration retains
its private buffer without redrawing; converted/final buffer cleanup share
completion dependencies. The stateful double validates native WebGL rules
separately from GLES adaptation. Real native faults verify unchanged output,
complete pointer/selector restoration, old blue pixels and a subsequent green
fixed-point attribute draw in each browser engine. No normal guest or full CTS
claim follows from these source checks.

Raw CPU/GPU upload cases reserve native candidate ownership before creation,
keep rejected cleanup after namespace/view metadata failure, and transfer a
successful GPU view without repeating obsolete carrier deletion. CPU cases
reject each utility restore, including unit selection and unpack fields, require
query sentinels and block new uploads until repair. Nested reservation failure
restores the prior active unit before any upload. Physical repairs and cleanup
survive the submitting context's retirement. Seventeen selected regressions fail
unchanged `c76083e495` production source; the successful GPU transfer case also
covers the already-owned nested image cleanup path.

Two additional real WebGL cases in each engine reject CPU unpack restoration or
GPU carrier binding restoration after valid native effects. They independently
reject candidate deletion, require unchanged query output and exact restored
native state, then finish cleanup once and read the original blue/red textures.
CPU upload is counted once; the GPU canonical source remains live. These tests
exercise shared host source directly, with no normal guest/CTS or full
browser-memory claim.

Raw BO revocation has nine additional source cases for failed attachment/unit
inverses, unit-capture restoration, mutation-plan reservation, draw/read/active
finalization, and submitting/final-member retirement. Native effects precede
the injected rollback failure; old logical references and query sentinels must
survive until exact native restoration. All nine fail unchanged `a894455bb1`
production source; thirty-seven unselected cases are not passing baseline
coverage.

A dedicated source worker also runs attachment and unit failures in each real
browser engine. It checks complete green shared images after repair, exact old
sampling views and separate native selectors. The attachment case retires the
submitting container while its peer remains blocked. No dead container may be
rebound. A subsequent successful BO retirement removes logical references and
canonical/native views, then final teardown requires one deletion per created
native resource and zero native liveness. Guest ioctl marshalling, full memory
reclamation and compositor conformance remain separate gates.

Ten raw-candidate C cases cover rejected/unknown deletion, repeated admission,
blocked object queries, shared-peer and final-group retirement, input/record
allocation failure, accepted deletion with a lost reply, and cube rendering
after reconciliation. The device double now models a confirmed raw candidate's
realized 2D target independently of C reservation; its existing BO-revocation
probe clears that native liveness explicitly. Nine cases fail unchanged
`82817f89e9`; final-group cleanup already passes that baseline.

The native source-browser C replay now registers a real GPU BO for the raw
allocation event, executes the ordinary host raw import, rejects retired-map
capacity before logical deletion, then consumes the C encoder's checked cleanup
and fresh cube commands. Each engine must render red/green and finish native
cleanup. Forwarded BO-source registration remains open; this new scenario
enables only native dispatch while retaining all earlier native/forwarded cases.
Normal guest marshalling and conformance remain separate gates.

Five surface-limit C cases cover pre-context configuration queries, current
context/error preservation, malformed replies and allocation failures, cache
refresh after reinitialization, and rendering through a retained current old
generation. All five fail unchanged `3c04b350dd` production source. The device
double uses an independent wire-tag constant so the baseline still compiles;
no old production source is modified. The source-browser replay queries each
engine's real limits before creating a logical context, renders red, replaces
the display generation while keeping the old current context, queries again
and renders green. Native and forwarded paths must preserve physical
texture/renderbuffer/framebuffer bindings and retire the old resources.

The kernel gate verifies exact input/output shapes, destination probing,
mapped object-session/live-root authority, no new general state-query
authority and preservation of another thread's current context. Host tests
cover actual texture/renderbuffer minima, invalid native limits, unavailable
error capture, pending outgoing-owner flags, native/main forwarding and KMS
non-ownership. These source tests do not execute normal guest ioctl
marshalling or establish pbuffer creation, upstream CTS, full browser-memory
or compositor compatibility.


Eight pbuffer C cases exercise creation/query/current destruction, zero
size, invalid attributes, a protected-page unknown attribute, native
limit clamping, definite allocation pressure, unknown failure without an
automatic retry, and 1,296 small size/budget combinations. The independent
grid oracle enumerates allowed areas rather than repeating the production
rectangle algorithm. All eight cases fail unchanged `6fab3f17af` through
the revision-argument runner. The unsupported config-selection mask is now
PIXMAP_BIT; PBUFFER_BIT is supported.

Source host coverage adds zero/single-zero/ordinary dimensions and no-post
presentation in both adapters. Stateful native failure tests retain
selector inverses and candidate deletion across creator retirement and
keep accepted resized storage through old deletion failure. The private
unchanged-production baseline selects three such regressions, with seven
unselected tests explicitly skipped; each fails at its intended semantic
assertion. Test doubles report the actual active texture enum so a repair
can restore the physical texture unit rather than assuming unit zero.

Real browser C replays render private red/green pbuffers while the visible
canvas stays blue, in native and forwarded modes. Zero-sized replays check
zero viewport sizing and canvas preservation without asserting
out-of-bounds pixel values. All earlier rendered scenarios remain enabled.
These checks supplement normal guest/CTS and full memory/compositor gates;
they do not replace them.


Eleven surface/platform C cases cover core/EXT GBM windows, rendering/format
checks, duplicate windows, requested versus actual render buffers, stored
colorspace, wide EGLAttrib aliases and protected-page attribute parsing.
Surface operation checks require pending GL work and current ownership to
survive errors. Pixmap, NO_TEXTURE and client-buffer failures follow the
current configuration/API instead of pretending to allocate native resources.
All eleven cases execute and fail unchanged `8152b269f6`: ten at missing API
resolution and one at valid pbuffer sRGB creation. This is inventory/behavior
evidence, not eleven independently reproduced ownership defects.

The separate actual-GBM source fixture uses provisioned public DRM headers
and a DRM allocation double. It verifies live metadata, format/usage,
foreign/protected-page pointers, unchanged output on rejection, retirement
and cleanup after partial constructor failure:

```
scripts/dev-shell.sh bash tests/graphics/run-gbm-unit.sh
```

The actual-C browser platform-window replay checks red/green and linear
quarter-intensity gray, native and forwarded dispatch, native cleanup and
GL errors in Chromium, Firefox and WebKit. The current affected selection
also reruns pbuffer and independent-surface cases, 24 total with no skips.
These remain source replays, separate from normal guest CTS, compositor and
full browser-memory validation.


Seven completion/swap C cases distinguish submission from accepted finish,
exercise empty queues and retained current destruction, and check failed
submission, failed query, GL error propagation and current swap ownership.
They all fail unchanged `f377d77983` through the revision runner. Host checks
cover native failure/loss, prior errors, malformed spans, main forwarding and
both kernel pointer widths. Actual-C browser completion replays defer pixel
reads until accepted finish and require two real native finish calls in each
engine/dispatch mode. The affected selection is 30 cases including the prior
24 surface replays. These checks do not implement EGL sync objects or replace
normal guest, compositor, memory and POSIX validation.


Core `eglCreateImage` and KHR `eglCreateImageKHR` share the same retained
image registry for dma-buf imports. Native cases cover both attribute
widths, complete required fields, guarded list endings, wide keys and
values, preservation/hint validation, allocation/import rejection, mixed
core/KHR destruction and retained texture/renderbuffer/FBO siblings.
The core-image browser source replay preserves red sibling pixels after
public image destruction while one texture becomes blue, then renders
green through the surviving sibling. It runs on all three engines.
The device double records source registration and checked source queries;
the replay supplies canonical GPU BO storage and kernel identity plumbing.
It does not execute rebuilt guest ioctl marshalling. Forwarded BO-source
registration remains an ordinary gap, so this new GPU import scenario has
native dispatch coverage only; the remaining applicable C replays still
exercise both routes.


Core fence client APIs now have native C cases for preallocation rollback,
known-token reconciliation after unknown replies, per-record wire storage,
finite/zero/FOREVER waits, current versus creator flush selection, retained
sessions after context destruction, public destruction with two waiters,
display reinitialization and cancellation cleanup. The revision runner's
initial three cases fail unchanged `81e9638207`. Actual-C browser traces
exercise real native/forwarded fence create/status/release and flush,
correct red pixels and final native cleanup on all three engines. The
adapter yields for native completion rather than copying the device
mock's signaled status. These are source checks; normal guest marshalling,
CTS and full browser-memory gates remain required. Server-side eglWaitSync,
server-ordering integration remains open.


Five KHR fence cases cover dynamic resolution, mixed core/KHR handles,
KHR-specific invalid-type errors, protected-page narrow attribute keys,
four-byte output canaries, and a finite timeout greater than u32 while a
wait survives public destruction and display reinitialization. They fail
unchanged `7efae46e42`. The KHR rendered replay uses the same actual wire
and native fences as core, with independent native/forwarded coverage in
Chromium, Firefox and WebKit. The control trace records whether the driver
required completion; a prior unsignaled observation may complete sooner
in the real browser. EGL_KHR_fence_sync and GL_OES_EGL_sync are declared;
EGL_KHR_wait_sync and server-side eglWaitSyncKHR remain unavailable.


Owned submit source checks now cover native import widths 4/8 and main
forwarding when a renderer callback rewrites a later valid input record.
All three fail unchanged `86b06464fe`. Snapshot unit cases cover selected
subviews, shared/nonshared inputs, captured native accessors, invalid
spans, single admission/consumption, discard and no cached-view revival
after rebind or teardown. Six browser cases render the original blue
record despite rewriting input to green, using independent device-sized
storage. Native/forwarded EGL core/KHR fence controls remain enabled.
The submit drain is still synchronous; execution/drawable lifetime and
server-wait barriers remain ordinary implementation work.


Owned drawable allocation leases supplement command snapshots. Eleven host
cases check storage surviving resize/owner destruction, reference clones,
private cleanup retry, selected-error capture failure, exhaustion, inverse
retention and native dependency holds. Two before-source cases fail at
premature deletion on `2c7075a919`. Six browser cases preserve old red and
replacement blue pixels, retire public owners, render green into retained
storage and check exact final native deletion with and without partial
cleanup failure. The source fixture normalizes its module URLs so its
native cleanup probe shares the production module instance. These checks
cover owned surface allocations; the borrowed GPU allocation checks below
extend the same model. Server-wait ordering and normal guest lifecycle
validation remain open.

Fifteen context-execution source cases retain old native identities through
public context revocation, session removal and multiple replacements. The three
before-source cases fail unchanged `67e5275ea7` at premature native deletion.
Additional cases cover allocation refusal, clone/release authority, shared
groups, explicit surfaces, selected-peer error capture, rejected cleanup
and accepted-prefix preservation. Six browser cases render red old storage,
blue replacement storage and green through retained old execution, then
check private cleanup retry and exact deletion while the replacement stays
usable. These source adapters exercise real WebGL pixels in all three
engines, but do not run rebuilt guest marshalling or deferred server waits.

Borrowed GPU allocation cases extend the storage leases to canonical BO
receipts. Three before-source cases fail `3e28c24078`: publication after a
native storage error, replayed accepted cleanup, and premature borrowed
allocation deletion. Additional host cases cover malformed metadata,
conflicting creation, identifier reuse, rejected selector restoration,
hidden retirement, selected-peer flags and old execution-group discovery.
Six browser cases retain red old and blue replacement storage, retire
public owners, render green through the old hold and require exact final
deletions with and without rejected texture cleanup. They remain source
adapters, not normal guest or compositor integration evidence.


`run-gbm-unit.sh` compiles actual GBM source with a native DRM allocation
double under UBSan. It checks live native handles, allocation rollback,
modifier pointer/count validation, layout rejection before allocation,
linear plane-count queries, fourcc names and legacy name aliases. It also
compares all 38 public header functions against the compiled object's
external definitions. It needs the normal provisioned public DRM headers.
This is source/API evidence, not SDK guest execution, rendered GBM
front/back storage or complete GBM compatibility.
