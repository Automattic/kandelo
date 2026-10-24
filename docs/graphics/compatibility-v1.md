# Graphics compatibility inventory, version 1

This is the implementation and evidence ledger for the GLES 2.0, EGL 1.5,
GBM and single-display legacy DRM/KMS baseline. Userspace graphics uses
the existing wasm32 SDK; Node/browser host parity is required. Kernel DRM
pointer-marshalling tests retain both guest address widths. It is not a conformance
claim. An ordinary defect remains open until implementation and executable
validation cover it; a passing demo does not close an API family.

## Reproducible starting points

- Main: `d51ac6d2ce658e9a775d1118db6fbcf49ba510cb`, fetched 2026-10-23.
  This worktree initially equals main, ABI 51, GL operation table 2.
- Cage PR [1539](https://github.com/Automattic/kandelo/pull/1539):
  `7d85a281a5b2b7ae5c7f804a10b918ae6dfa20ff`, by mho22
  (`yannick@capsules.codes`). Its independent ABI 51 cannot replace main's
  epoll ABI 51. Integration of its incompatible interfaces requires ABI 52
  or a later fresh version if main advances.
- Older graphics branch: `e528dc0e8a` (Brandon Payton), plus read-only
  inspection of uncommitted files in
  `/Users/brandon/emdash/worktrees/Kandelo/emdash/generic-kms-gles-runtime`.
  That tree's presentation helper predates main's present targets and GPU
  buffers. Do not replace main's implementation wholesale.
- Khronos VK-GL-CTS: `a119e62de3bb38dae67f05abee8acd011e0c729c`.
  See [test provenance](../../tests/graphics/README.md). No CTS result is
  claimed by recording this pin.

## Sources and contract scope

- [OpenGL ES 2.0.25](https://registry.khronos.org/OpenGL/specs/es/2.0/es_full_spec_2.0.pdf)
  (sections 2–6): commands, objects, rendering, errors and state tables.
- [EGL 1.5](https://registry.khronos.org/EGL/specs/eglspec.1.5.pdf):
  display/config, context/surface, current-thread state, images and sync.
- [KHR_image_base](https://registry.khronos.org/EGL/extensions/KHR/EGL_KHR_image_base.txt),
  [OES_EGL_image](https://registry.khronos.org/OpenGL/extensions/OES/OES_EGL_image.txt),
  [EXT_image_dma_buf_import](https://registry.khronos.org/EGL/extensions/EXT/EGL_EXT_image_dma_buf_import.txt)
  and its modifiers extension: independent sibling lifetime, orphaning,
  plane metadata, formats and modifiers.
- [KHR_surfaceless_context](https://registry.khronos.org/EGL/extensions/KHR/EGL_KHR_surfaceless_context.txt):
  current context without draw/read surfaces; framebuffer zero is undefined.
- [OES_surfaceless_context](https://registry.khronos.org/OpenGL/extensions/OES/OES_surfaceless_context.txt):
  absent default framebuffer, incompleteness and initial viewport/scissor.
- [Mesa GBM header](https://gitlab.freedesktop.org/mesa/mesa/-/blob/main/src/gbm/main/gbm.h):
  allocation/import, plane metadata, mapping and surface lock/release.
- [Linux DRM UAPI](https://www.kernel.org/doc/html/latest/gpu/drm-uapi.html):
  open-description authority, master, object queries, framebuffers and flips.
- Consumer paths: wlroots GLES2 renderer and DRM backend, cage, sway,
  SDL2 KMSDRM, existing Wayland compositor and LÖVE. Consumer startup is
  integration evidence, not an alternative specification.

## Inventory

Status: **open** = implementation or validation incomplete;
**partial** = existing implementation with named gaps; **verified** = named
checks run on this tree. Evidence must include engine/host, artifact identity,
command and result before a row becomes verified. A boundary needs an actual
reproduction and correct observable failure; none is inferred from a stub.

| ID | Required behavior / source | Current implementation and known failure | Owner / dependencies | Executable validation | Status / boundary |
|---|---|---|---|---|---|
| G01 | GLES2 object name creation, binding, deletion; ES2 §§2,6 | Reserved guest buffer names and host shared-object maps; core object predicates implemented, full query/error coverage still open | GLES encoder, registry, query | CTS GLES2 functional state/query/object groups; host object tests | partial; no demonstrated boundary |
| G02 | Context-local full state; ES2 state tables | Client state is context-owned; host groups separate shared names from local state/containers. Deleted image/buffer names retain binding/container references and program lifetime spans current owners. C attribute/index state belongs to each VAO. Full rollback, hints and multiple public contexts remain open | EGL, encoder, object groups, shadow, muxer, decoder | Alternating contexts/processes; real shared-object/deletion/viewport rendering; native thread-transfer/isolation | partial |
| G03 | Buffer allocation/update, indexed and client-array draws; ES2 §2 | Per-VAO mirrors, retained deleted buffers and coherent native vertex/index views. Fixed-point/wide-stride host views and bounded packed client staging are implemented. Maximum byte/short indices use native promotion. Bound index buffers plus client attributes use a bounded presence query; core buffer/vertex queries preserve logical state. Full size/limit/negative coverage remains open | GLES encoder, bridge | CTS buffer/vertex/indexed tests; invalid lengths and offsets | partial |
| G04 | Shader source/compile/link, reflection, deletion; ES2 §2 | Deleted current objects retain references; shader/program names share a namespace; latest link state is separate from the current executable. Core attribute/source/attachment reflection, acknowledged large-source uploads and validation entrypoints are implemented; complete executable/attribute/uniform validation still needs work | encoder, query, registry | CTS shader API and reflection; delete attached/current objects; rendered alternating owners and relinking | partial |
| G05 | Uniform scalar/vector/matrix and arrays; ES2 §2 | Metadata-based result widths; query truncation and link invalidation need audit | encoder, query | CTS uniform API/state queries; hostile reply sizes | partial |
| G06 | Texture formats, cube maps, pixel storage, subimages and copy; ES2 §3 | WebGL2 normalization, core parameter queries and context-owned default texture objects are implemented in host source; complete target/state/error and guest CTS audit remain open | encoder, bridge, muxer | CTS texture specification/negative/cube groups; rendered pixels | partial |
| G07 | Raster/depth/stencil/blend/clear/readback; ES2 §§3,4 | Main provides offscreen color/depth/stencil; no broad CTS evidence | bridge, query, present-target | CTS functional render families; real pixels all three engines | partial |
| G08 | FBO attachments/completeness and renderbuffers; ES2 §4 | Default/user identities and read/draw state remain distinct; attachment records retain deleted texture/RBO storage, including unbound containers and separate packed depth/stencil points. Core attachment/renderbuffer queries implemented; full storage/negative/CTS coverage remains open | encoder, registry, image references, presentation | CTS FBO and attachment queries; deletion/reallocation | partial |
| G09 | Ordered errors and non-mutating invalid calls; ES2 §2.5 | Native pending errors now remain with the outgoing session across switches/invalidation; queries merge duplicate native/retained flags. Some guest paths silently return; missing-name host calls may resolve to null | encoder, decoder, query | CTS negative API; malformed TLV/span/enum tests | partial |
| G10 | Every core function resolves; ES2 API | Handwritten eglGetProcAddress list incomplete; old branch generates declarations | capability manifest, EGL resolver | Enumerate core header symbols, link and call; version-gated extensions | open |
| E01 | EGL1.5 display initialization/config selection/queries; EGL §§3.2–3.4 | One shared attribute table drives enumeration, matching and queries; config operations validate initialization, handles and errors. Full display/config lifecycle and CTS validation remain pending; advertised 1.5 unchanged | EGL library, surface metadata | CTS query_config/choose_config/negative API | partial |
| E02 | EGL current-thread API/context/surface lifecycle; EGL §§3.5–3.7 | Error/API/current binding are thread-local; kernel-authoritative TID ownership, acknowledged replacement, release/exit, unique C handles, context-owned encoder and deferred destruction implemented for one context/surface per backend session. Creation/bind failure preserves prior state. Multiple public EGL contexts, sharing, display generations and the full error/lifecycle audit remain open | EGL, GLIO, registry, encoder | CTS query_context/multi_context/thread_cleanup; destroy-current and stale handles | partial |
| E03 | Pbuffers, window/pixmap platform entry points and queries; EGL §3.5 | Pbuffer always fails; several core symbols absent; GBM sizing exists | EGL, host drawable/GLIO metadata | CTS create/query surface and resize | open |
| E04 | Surfaceless make-current and framebuffer errors; KHR_surfaceless_context / OES_surfaceless_context | Explicit kernel/host bind, initial zero viewport/scissor, undefined framebuffer-zero status and native operation errors implemented; user FBOs remain usable. Real source-browser checks pass; guest CTS/current artifacts remain pending | EGL, host query/decoder | CTS surfaceless_context plus zero-FBO operations | partial |
| E05 | EGLImage identity, source/target lifetime; KHR_image_base | GPU image/alias/FBO references now retain GEM storage; CPU coherence and complete object semantics remain open | EGL, GLES alias model, kernel BO references | Producer handles closed, destroy image, surviving texture/renderbuffer; varied order | open |
| E06 | Respecification orphans sibling without altering others; OES_EGL_image | Texture redefinition now detaches storage and updates retained FBO references; sampler independence and complete negative API coverage remain open | GLES storage model, host object/attachment tracking | Redefine imported texture, sample both siblings, retained FBO | open |
| E07 | dma-buf validation, multiple import and format/modifier enumeration; EXT import | Cage supports one linear plane; must audit metadata and rollback | EGL, PRIME, GBM | CPU/GPU imports, bad fd/stride/offset/modifier; repeated import lifetime | open |
| E08 | EGL1.5 sync, waits, core images, thread release and errors | Several symbols absent despite advertised version; ordinary implementation gaps | EGL, ordered submits, host completion | CTS sync/negative API and getProcAddress | open |
| B01 | GBM allocation/import/export and plane metadata | Dumb/GPU tiers; cage adds modifier allocators | GBM, DRM BOs, host registry | SDK guest fixtures both widths; unsupported format/flags | partial |
| B02 | GBM map/unmap coherence and authority | Kernel authoritative BO references; changed-run publication on main | GBM, kernel maps, DRI registry | Importer writes, stale readers, unmap/exit/exec; browser pixels | partial |
| B03 | Surface ring lock/release/destroy ownership | Main two-BO ring; audit lock/destroy/outstanding buffer lifetime | GBM, EGL native windows | Ring exhaustion, invalid/double release, destroy with locks | partial |
| K01 | Single display resources and consistent object IDs | Integrated dynamic mode catalog, properties and device-wide IDs; broader device/host validation pending | kernel dri/kms, host mode metadata | Rust ioctl and Node mode tests; preserve preferred/catalog semantics | partial |
| K02 | Probe all nested outputs before writing | Property, enum and expanded connector outputs now preprobe all destinations; focused Rust regressions pass | syscall nested-output helpers | Valid first/invalid later buffers, unchanged sentinels and top-level bytes | open |
| K03 | Shared OFD GEM/FB authority, PRIME and final references | Main documents forked KMS gaps; cage shares FB table | OFD, process/fork/spawn/exec/close, BO registry | Rust + real Node lifecycle/dup/fork/spawn tests | open |
| K04 | Legacy modeset/flip/vblank/master handoff | Main display owner and cleanup; cage changes automatic master and CLOSEFB | KMS, host scanout | Pending flip drop/exit/crash/master replacement, no stale event/scanout | partial |
| K05 | GPU scanout, CPU fallback and context loss | Main has GPU producer target; cage adds scanout blit | host GPU registry/present target/KMS pump | Render imports to scanout; orientation/pixels three engines | open |
| H01 | Command framing, complete validation and bounded results | Full structural prevalidation now protects batches; host source regressions pass | bridge, submit queue/drain | Malformed trailing command leaves earlier state untouched; query output sizes | partial |
| H02 | Synchronous query ordering and main forwarding parity | Forwarded queries now use copied input and one bounded reusable mailbox per channel, with timeout retirement; shared native contexts use the same muxer model | worker protocols, query, main-forward | Kernel import preflight at both pointer widths; rendered alternating forwarded owners on three engines | partial; full guest and memory-cycle gate pending |
| H03 | Process/worker/machine cleanup and resource retirement | Main authoritative final BO destruction; preserve its recent memory and exec fixes | kernel and shared lifecycle, registries, muxer | fork/spawn/exec/close/death/crash; browser-memory repeated cycles including KMS consumers | partial |
| A01 | ABI and generated declarations match combined implementation | Main heap-safepoint ABI 52 and graphics session/thread-current changes are combined under ABI 55; generated outputs and resolver verified, full artifacts pending | shared ABI, snapshots, generated C/TS, package closure | ABI checker, generation diffs, normal SourceOnly rebuild | open |
| P01 | Real upstream compositor integration | wlroots/cage/sway recipes and consumers integrated; combined artifacts and compositor validation pending | SDK, package recipes, resolver, VFS | Source builds both declared widths; Node semantics; rendered cage/sway and existing apps | open |

## Separate expansions

GLES3 requires its complete API, GLSL ES 3.00, state/query tables, formats,
transform feedback, instancing, uniform blocks, sync and CTS groups before
advertising it. WebGL2 backing alone is not GLES3 support. Atomic KMS needs
mutable property state, plane enumeration, transaction validation, test-only
commit, events and rollback. Explicit synchronization needs cross-API fence
ownership, completion and import/export semantics; serialized command order
alone does not supply that contract. Multiple displays and non-linear or
multi-plane dma-bufs require distinct format/layout and display authority.
These are outside this baseline and cannot excuse EGL1.5 core sync gaps.
Wasm64 userspace graphics is also a separate expansion: today libdrm's recipe
explicitly accepts only wasm32, and the graphics archive builders target
wasm32 and run only for that sysroot. Extending it requires architecture-aware
archive builders, the libdrm recipe, high-address GL query marshalling and
executed wasm64 coverage. This records absent support, not a hard platform
boundary and not a reduction of an existing advertised graphics API.

## Implementation evidence

Baseline provisioning started with
`scripts/agent-job start -- ./run.sh setup`; job
`run.sh-setup-1023-104545-b7c9`. Runtime edits must be followed by a current-tree
rebuild; this initial build is only baseline/provisioning evidence.

### Command batch validation

The focused malformed-trailer regression fails against unchanged main's
bridge: `clearColor(1,1,1,1)` executes before the invalid final record returns
`EINVAL`. Its original log is
`.context/baseline-gl-command-atomicity-source.log`. Full-batch validation
adapted from Brandon Payton's `4fec7d0dd3` now rejects framing/payload errors
before dispatch. This is structural validation, not transactional rollback
of valid GL commands which later encounter GL errors. The source-only WebGL
selection passed 120 tests in 12 files on 2026-10-23, with no skips.
Rendered, guest, conformance and complete lifecycle validation remain open.

### KMS integration and nested output validation

The sysfs/netlink and KMS changes were adapted from mho22's `f758e3fe4b`
and `ea2bae402f`, retaining that author on both derived commits. The
current combined contract uses ABI 54 and fork record version 20. Main's cursor
references, complete mode catalog and deferred cleanup effects are retained.
The first integrated DRI selection passed 50 Rust tests after migrating its
connector lookup to the new device-wide object ID.

Three new regression tests failed on the integrated cage implementation:
property ID/value pairs, property enum/value pairs, and connector
mode/encoder/property/value outputs. They now pass after preprobing every
output before any write. The tests exercise null, full-width invalid and
end-of-memory addresses in each position, assert unchanged top-level and
nested bytes, and assert no host writes on failure. Logs:
`.context/kms-output-baseline-final.log`, `.context/kms-output-fixed.log`.
This closes the reproduced write-order defect, not the full KMS baseline.

The initial setup job failed during package provisioning; its artifacts are
not current-tree validation. Sources changed while that job was active,
so no failure from it is attributed to main or to the candidate without a
stable-tree reproduction. A full rebuild and broader suites remain required.

### EGLImage storage ownership

The selected cage EGL/GLES import implementation is integrated. Independent
image control blocks now retain GL siblings, and an import-owner table
balances repeated PRIME imports which return the same GEM handle. Texture
respecification switches the named texture to independent storage. Framebuffer
attachments retain storage separately from names, including deletion while
another framebuffer is bound; respecification updates the retained attachment.
Context teardown retires attachments and siblings and resets the encoder.

The four initial ownership regressions fail against `ce8cd9dbcf` under
UndefinedBehaviorSanitizer. They pass after repair. An additional unbound
framebuffer regression failed before attachment ownership and now passes.
The native device-double tests exercise actual library code and encoded
commands, but provide no rendered pixel evidence. ASan in the declared
LLVM21 environment deadlocked in its startup initializer on macOS27, before
main; `.context/native-harness-sample.txt` records that stack. It is a
validation-tool limitation, not a graphics API boundary.

Guest coverage is added in `programs/egl_image_ownership.c` and
`host/test/egl-image-ownership.test.ts`. It closes producer handles, imports
the same BO twice, varies image/texture/renderbuffer/FBO destruction order,
and checks host retirement ordering. Its execution and real browser pixel
validation remain required.

This does not close E05/E06 completely: CPU-tier image copies are not live
shared storage, texture siblings still need independent sampler state,
and all invalid-operation and multi-context transitions need broader CTS
coverage. These remain implementation gaps, not platform boundaries.

### Context isolation and device uploads

Adapted the texture-target/dither/pixel-store isolation model from Brandon
Payton's older graphics work without importing its incompatible operation
tags or replacing main's presentation targets. The old and current operation
tables assign different query/blend tags; copying the old table would break
current binaries. GL operation version 2 and its existing tags are preserved.

Two source tests fail on the previous host implementation (cube-vs-2D slots,
and dither/pixel-store restoration). Real rendering through the shared
bridge/muxer fails on main `d51ac6d2ce` in Chromium, Firefox and WebKit:
the first context produces red instead of yellow and GL_INVALID_OPERATION
(1282). All three engines pass after repair. The rendered test also checks a
real foreign texture upload with nonzero unpack skips and another context's
alignment: it reads RGBA [17,29,41,255] and verifies physical state restoration.
Two source regressions separately reproduced skipped-row contamination and
failure cleanup before the foreign-upload repair.

A further kernel-adapter regression shows a synchronous clear-color query
reading another owner's native state when no guest commands are pending.
Restoring through the same muxer used by submissions repairs that path,
while keeping destination preflight before GL execution. Viewport/scissor
queries already read the shadow and were retained as existing behavior.
The combined source gate passes 198 tests in 13 files without skips.

Evidence: `.context/graphics-state-baseline.log`,
`.context/graphics-state-browser-baseline.log`,
`.context/graphics-state-foreign-browser.log`,
`.context/foreign-upload-baseline.log`,
`.context/graphics-query-baseline-clear.log`, and
`.context/graphics-source-query-fixed.log`. These prove the named host
contracts, not complete GLES2/EGL compatibility or compositor integration.

### Broader validation status

The canonical serialized Rust workspace suite passes 2,992 tests across 44
unit/doc binaries, with no failures or ignored tests. Its job is
`graphics-rust-serial-1023-115303-a5a2`. A preceding run overrode the
repository's required RUST_TEST_THREADS=1 with 4 and failed on shared image
export state; it is invalid validation and is retained, not attributed to
this graphics change. The initial four KMS failures were fixed by selecting
explicit master/cursor-capability preconditions in the imported tests.

The CTS subset builds through the normal resolver for wasm32 at artifact
closure `66d2fdd5462558a721c2445316484a4e6f5cd88ae1d554be53effcb3221e63c7`
(before its manifest was corrected to the existing wasm32 graphics scope).
Guest execution is still required; a linked artifact is not a CTS pass.
The full setup graph now classifies the new package as test support.

### Forwarded synchronous queries

Adapted Brandon Payton's `2d4258ad3ffd77a3e9dd223d78e5e6005355454e`
query transport, retaining main's operation table, destination authority and
presentation model. The worker adapter copies commands and query input out
of guest storage. One fixed 65,556-byte mailbox per channel supplies the
existing 64 KiB kernel query limit without a guest memory reference or a
new allocation per query. Timeout permanently retires the mailbox so a late
completion cannot satisfy another request. Replies are bounded before any
kernel destination write. Legacy channels without query support return
ENOSYS. Shared forwarded contexts restore their owner before drawing and
querying, and invalidate the muxer on retirement.

Two kernel import regressions fail before this repair, one for each pointer
width. The source selection now passes 203 tests in 13 files with no skips;
the browser protocol/probe selection passes all 8 tests. Real blocking
worker-to-main queries and rendering pass in Chromium, Firefox and WebKit:
two owners alternate green/red frames, retain their own clear color, and
recreate contexts three times while reusing each channel's mailbox. The
persistent-realm memory probe is enabled and reports no forbidden payloads.
Together with the existing rendered state/upload test, this is 6 browser
passes. These are host contract tests, not guest CTS or compositor evidence.

Logs: `.context/graphics-forward-baseline.log`,
`.context/graphics-forward-source-final.log`,
`.context/graphics-forward-boundary-fixed.log`,
`.context/graphics-forward-browser-final.log`. The initial browser mailbox
assertion compared SAB wrapper identity across structured clone; its failure
is preserved in `.context/graphics-forward-browser.log`. The corrected
assertion observes shared backing, since clones have distinct wrappers.

### Current browser launch integration

The imported cage/sway browser tests used a bare profile URL from the older
branch. They now resolve the current shell image and profile together, and
both profiles appear in the gallery roster. Imported guest/compositor tests
require their artifacts instead of treating missing products as skipped
coverage. The persistent browser-memory sequence now launches cage, observes
its GL-rendered terminal and input repaint, and leaves it live for ordinary
machine-switch teardown. Execution of those integration cases is pending the
combined build.

The gallery/identity source selection passes 38 tests in two files without
skips. Its initial 35-pass/one-fail run reproduced an existing roster assertion
that omitted Freeciv before the cage/sway additions. The assertion now pins
the complete existing order plus the two new entries. Logs:
`.context/graphics-gallery-baseline.log`, `.context/graphics-gallery-fixed.log`.

### Numeric query protocol

Numeric binding queries now translate native buffer, texture, framebuffer,
renderbuffer and program objects back to guest names for both integer and
float forms. Host-owned framebuffer redirects report name zero. A vector
reply must fit completely before writing its destination; the former path
silently returned a truncated success. Four regressions fail before repair.
The resulting source selection passes 207 tests in 13 files, with no skips.
The six rendered browser cases also pass, including ordinary 2D/cube texture,
program and buffer name queries in all three engines. Image-alias logical
names, deletion references and numeric conversion rules remain part of the
open query/object audit; this is not complete GLES query coverage.
Logs: `.context/graphics-query-shape-baseline.log`,
`.context/graphics-query-shape-fixed.log`,
`.context/graphics-query-shape-browser.log`.

### Shader and program references

Adapted deferred object ownership and accepted-program-switch handling from
Brandon Payton's older graphics work (`2d4258ad3ffd` and `8594aae153c6`),
preserving main's native-object shadow layout. Program attachment sets retain
deleted shaders. A deleted current program retains its native executable and
name until a successful switch releases it; DELETE_STATUS remains observable.
Native errors from rejected switches/attachments are preserved, and ownership
changes commit only on acceptance. Final program release retires its uniform
location handles and attached shader references. Context destruction unbinds
a physically current program only when it belongs to that context.

Three initial source regressions fail before repair. Additional tests cover
rejected attachment and context cleanup without disturbing another owner.
The resulting graphics source gate passes 212 tests in 13 files without skips,
and host declaration generation passes. The rendered program-lifetime case
fails against recorded main in all three engines, then passes on the candidate:
deleted current executables survive alternating green/red draws, an unlinked
program is rejected without changing current state, and final references retire.
The complete source-rendered selection now passes 9 cases across Chromium,
Firefox and WebKit. Logs: `.context/graphics-program-lifetime-baseline.log`,
`.context/graphics-program-lifetime-final.log`,
`.context/graphics-program-lifetime-browser-baseline.log`,
`.context/graphics-program-lifetime-browser-fixed.log`.

This remains bounded ownership evidence. Several core reflection APIs and
broader shader/uniform validation remain missing. The later relink repair
below addresses the distinct installed-executable model described by the
[WebGL program-object clarification](https://registry.khronos.org/webgl/specs/latest/1.0/#5.14.9)
and GLES2 §2.10.

The C encoder now allocates shader and program names from one shared monotonic
namespace, rejects an invalid shader type with zero and INVALID_ENUM, and
rejects namespace exhaustion before wrapping through name zero. This does not
complete native allocation-failure propagation through asynchronous creation.

### Link state and installed executables

A current logical program now owns its installed native executable separately
from its latest link target. Relinking an installed executable creates a new
native target, reproduces the logical shader attachments and explicit attribute
bindings, then attempts the link. A failed link is queryable without replacing
the executable used for draws or muxer replay. A later successful link installs
the replacement, invalidates old uniform handles and releases the prior
executable. Switching away releases a retained executable; deletion-pending
programs remain alive until their logical current reference ends.

Native shader deletion now waits for the last logical attachment, keeping a
deletion-pending shader available to a replacement native link target. Its
logical DELETE_STATUS remains observable. Context destruction retires both
the latest link target and the retained executable, without disturbing another
owner. Uniform updates reject missing or foreign location handles before
native calls; successful relink retires handles from the earlier generation.

Five of six new model regressions fail on `f2436b4d57`. The repaired source
gate passes 243 tests in 14 files without skips and declaration generation
passes. The model covers failed relink/replay, successful replacement,
recovery, deletion-pending attachments, allocation failure and exact-once
teardown. Three encoder test fixtures now supply the current program and
location owner instead of an unowned synthetic location; their encoding
assertions are unchanged. Logs: `.context/graphics-program-link-baseline.log`,
`.context/graphics-program-link-fixed.log`,
`.context/graphics-program-link-final.log`.

The rendered lifetime case now also checks failed relinking during alternating
green/red draws, recovery to a blue executable and retirement of the old
executable. This updated browser case has not yet run; the earlier nine-pass
browser result predates these latest changes. Full CTS shader/reflection and
guest execution remain pending. No hard platform boundary is claimed.

### EGL configuration selection and enumeration

The existing single RGBA8/depth24/stencil8, non-multisampled window config now
has one shared attribute table for eglGetConfigs, eglChooseConfig and
eglGetConfigAttrib. Selection uses the specification's minima, masks,
exact matches, defaults and CONFIG_ID override. Unknown attributes, invalid
values, unknown config handles, absent output counts and uninitialized
displays fail without partially publishing outputs. Config queries no longer
return successful zero for every unknown enum. Core enumeration, selection
and attribute-query functions also resolve through eglGetProcAddress.

This preserves the existing ES2 renderable mask, surface capabilities and
EGL version. EGL's empty selection list defaults to an ES1 renderable filter,
which correctly matches none of this backend's ES2-only configs. The CTS
adapter now enumerates all configs with eglGetConfigs rather than accidentally
applying that filter. Its upstream assertion method remains unchanged and
the pinned-source provenance verifier passes. Pbuffers and broader EGL
lifecycle/API gaps remain open; this is not an EGL conformance claim.

Three new native cases reproduce against `607a10699b`: mismatched requests
incorrectly select a config, uninitialized config queries succeed, and core
enumeration does not resolve. The prior ten cases pass on that baseline;
the repaired harness passes all thirteen under UBSan. Additional assertions
cover masks, duplicate attributes, explicit IDs, zero-capacity output arrays,
validation after an earlier mismatch and unchanged outputs after rejection.
Logs: `.context/graphics-egl-config-baseline.log`,
`.context/graphics-egl-config-final.log`,
`.context/graphics-continued-cts-provenance.log`. SDK/guest rebuilding and
guest CTS execution remain deferred.

### Numeric conversion and complete query vectors

Integer state queries round ordinary floating state to nearest and use the
GLES2 §6.1.2/table 4.4 conversion for normalized color/depth state. Masks and
integer object names retain their 32-bit representation. Boolean queries
test floating values against zero before any integer conversion. Invalid
native numeric queries retain the GL error and leave output bytes untouched;
the C query wrappers also preserve their caller's output after ioctl failure.

Compressed-format vectors use their actual reported count. Boolean conversion
allocates enough storage for vectors longer than four elements. Client-side
unpack-subimage state is observable in integer, float and boolean forms.
GLES compiler/format-count enums absent from WebGL are derived from the actual
source compiler, absent binary loader and native compressed-format vector.

The expanded native harness resolves recorded query allocations without
dereferencing truncated host pointers, then exercises the real library's
query/copy/conversion path. On `b85a4c8e0861`, six prior cases pass and four
new cases fail: shared names, fractional booleans, longer vectors and
unchanged output after query failure. The candidate passes all ten under
UBSan. Six host numeric regressions fail before repair; the final source gate
passes 237 tests without skips and declaration generation passes. One
intermediate failure exposed a fake context whose getError returned undefined;
it now models NO_ERROR, with the existing state-selection assertion preserved.
Logs: `.context/graphics-query-expanded-baseline.log`,
`.context/graphics-namespace-boolean-fixed.log`,
`.context/graphics-numeric-conversion-baseline.log`,
`.context/graphics-state-query-final.log`. Guest and browser execution of these
newest changes remains pending; complete query API coverage is still open.

### State rejection and native limits

State argument checks reject invalid enums, dimensions, masks, blend factors
and pixel-store values before changing the owner's replay state. Rejection
latches a GL error and does not discard subsequent valid commands in the
batch. Existing EXT_blend_minmax modes remain accepted. Clear and blend colors
are clamped before recording. Driver-rejected blend calls retain prior state.

Viewport sizes use cached native maximum dimensions. Texture selection uses
the native combined-unit limit and grows both target arrays for valid units
above the initial 32 slots. Switching or invalidating the current owner
retains the full range of units that must be cleared for the next owner.
These are shared host paths, used by both Node adapters and browser renderers.

The initial 10 argument regressions and three limit/replay regressions fail
before their respective repairs. Additional coverage includes invalid blend
factors, clamped colors and replay after explicit invalidation. The resulting
source gate passes 237 tests in 13 files without skips, including the numeric
query repairs below. Host declaration generation also passes. Real browser
execution of these newest changes is pending. Logs:
`.context/graphics-invalid-state-baseline.log`,
`.context/graphics-native-limits-baseline.log`,
`.context/graphics-state-query-final.log`.

A later teardown regression found that resetting an outgoing shadow before
muxer invalidation lost the high-unit clearing range. The muxer now also uses
the cached native unit limit, which outlives logical context teardown. The
new reset-before-invalidation case fails before repair; the resulting source
gate passes 244 tests in 14 files without skips. Logs:
`.context/graphics-unit-retirement-baseline.log`,
`.context/graphics-unit-retirement-fixed.log`.

### EGL thread error and API state

EGL error status and the bound client API now use thread-local storage. An
unsupported API bind reports BAD_PARAMETER and preserves the prior API.
Errors in one thread cannot be consumed or replaced by another thread's
eglGetError. This is the first part of E02; current-context ownership and
thread release remain separate implementation work.

Both new native cases fail on `003fdb1133`. The current harness passes all
fifteen cases under UBSan, including a real pthread checking its initial
state while its creator retains an unread error. Logs:
`.context/graphics-egl-thread-error-baseline.log`,
`.context/graphics-egl-thread-error-fixed.log`. Guest thread execution remains
pending the deferred rebuild.

### Current references and deferred EGL destruction

Current bindings now belong to individual threads. A mutex protects the
single backend context's owner and lifecycle transitions; binding a context
owned by another thread fails with BAD_ACCESS. Explicit release and pthread
exit flush queued commands before releasing ownership. eglReleaseThread resets
thread API/error state and leaves unreferenced, non-deleted objects alive.
The command encoder exposes no command buffer to an unbound thread, and its
query/error path cannot read the bound thread's pending renderer error.

Current references defer context/surface destruction and display termination.
Pending objects retire when those references end, preserving image siblings
until actual context teardown. C-visible context and surface handles are
monotonic, so a destroyed handle does not acquire a later object's identity.
A rejected window bind preserves the prior current binding. Failed surface
creation no longer publishes a replacement native window or consumes its
pending target. The guest ownership fixture explicitly releases its current
reference before checking final teardown.

Owner records are heap-backed pthread-key values, retired by eglReleaseThread
or the key destructor. They never retain pointers into C TLS beyond that
storage's lifetime. A first model used a retained TLS address; the native
thread-exit regression exposed the missing flush, and the heap-backed model
passes it. The initial three current/destroy regressions fail before repair.
The expanded native harness passes twenty cases under UBSan. Both real
library sources also compile to wasm32 objects with the declared graphics
archive flags and unwrapped LLVM compiler; this proves compilation, not
guest execution. Logs: `.context/graphics-egl-current-baseline.log`,
`.context/graphics-egl-current-expanded-baseline.log`,
`.context/graphics-egl-current-first-fixed.log`,
`.context/graphics-egl-current-rollback-final.log`,
`.context/graphics-egl-current-wasm-compile.log`.

This is a single-context foundation. The backend still identifies one context
and surface as ID 1 and routes submits/queries by process. Simultaneous
contexts, share groups, independent read/draw surfaces and overlapping
terminated/reinitialized display generations require kernel/host routing and
encoder changes. Reinitialization while an old terminated generation still
has a current reference presently fails NOT_INITIALIZED; this remains an
ordinary implementation gap, not a platform boundary. Fork/crash transitions,
complete backend-failure propagation, guest threads and the browser-memory
gate remain pending. No full EGL thread/lifecycle conformance is claimed.

### Integration checkpoint after the build pause

The user requested cancellation of this workspace's builds while another ABI
52 build ran, then authorized continuing implementation without waiting for
that build. Both private build process groups were terminated and their
completed cache entries retained. No full-build success or final SourceOnly
projection publication is claimed. Commands and progress are recorded in
`.context/graphics-build-pause.json`.

Origin/main was fetched at `1ddfafc871638785a26675a28899e9af69c0274a`.
That commit independently introduces ABI 52 for a required heap-safepoint
import. This branch's graphics ABI 52 is not interchangeable with main's ABI
52. Main through `f3cb7041f6` is now integrated, including multicast routing
and the heap-safepoint import. The first combined implementation used ABI
53; the subsequent session protocol advances it to ABI 54, with graphics
package ABI floors advanced to match. Normal artifact
rebuilds and combined-tree validation remain required. The earlier measurements retain their original
baseline and artifact identities. Expensive rebuild and integration checks
remain deferred at the user's request while implementation continues.

ABI 53 metadata regeneration and verification passed after the merge:
`scripts/dev-shell.sh bash scripts/check-abi-version.sh update`, followed
by resolver bundle generation, its consistency test and the ABI checker.
Logs: `.context/graphics-abi53-generation.log` and
`.context/graphics-abi53-verification.log`. This builds a kernel for ABI
export inspection; it does not publish or validate package/image artifacts.

### Renderer creation acknowledgement

`host_gl_create_context` now returns an acknowledged result through the
Rust host trait and Wasm import. The kernel installs its context only after
zero success; negative errno is preserved, while malformed positive or
minimum-integer results fail with `EIO`. The default Rust host rejects an
unimplemented renderer with `ENOSYS`. TypeScript hosts reject missing, lost
or throwing rendering backends, roll back KMS ownership and allow retry.
An unrelated later modeset cannot revive a failed creation request. EGL's
existing ioctl-failure path returns `EGL_NO_CONTEXT` and `EGL_BAD_ALLOC`,
consistent with [EGL 1.5 allocation errors](https://registry.khronos.org/EGL/specs/eglspec.1.5.pdf).

Forwarded creation uses the existing independent 65,556-byte device mailbox
for a synchronous result. Timeouts retire it permanently; late creation
requests cannot allocate a renderer. Failure requests ordered renderer
cleanup. This extends the explicit memory-boundary audit for that one
message's mailbox; oversized, growable and guest-memory backing remain
rejected. Production automatic forwarding setup is still an ordinary open
gap, and the current kernel remains limited to one context per GL session.

Before the fix, all five initial source regressions fail against merge
`95ad65f40f9352eca6e8d6543ddc08b8396a19e9`:
`.context/graphics-context-create-baseline.log`. Updated bounded checks:

| Check | Result | Evidence |
|---|---|---|
| Host source graphics/KMS/scratch | 265 passed, 16 files, no skips | `.context/graphics-context-create-host-verified.log` |
| Rust `runtime-core` GLIO tests, native host target, serial | 10 passed, no failures/ignored | `.context/graphics-context-create-rust.log` |
| Actual EGL/GLES C sources with device double and UBSan | 21 cases passed | `.context/graphics-context-create-native.log` |
| Browser protocol/memory-boundary audit and negative probes | 9 passed, no skips | `.context/graphics-context-create-boundary-fixed.log` |
| Real source-rendered Chromium/Firefox/WebKit | 12 passed, no skips | `.context/graphics-context-create-browser-loss.log` |
| Host declarations, both Node/browser entry points | passed | `.context/graphics-context-create-typecheck.log` |
| ABI regeneration/check and resolver consistency | passed | `.context/graphics-context-create-abi.log` |

Browser checks use Playwright 1.63.0's bundled Chromium 153.0.8010.12,
Firefox 155.0 and WebKit 26.6 from the worktree lockfile/browser manifest.
They include real context loss, failed creation while lost, restoration and
successful retry, copied command/query storage, alternating rendered owners
and failed relink recovery. These are source-host checks, not guest,
compositor, full browser-memory or complete CTS evidence. Normal ABI 55
SDK/package/image builds and the broader combined-tree suites remain
required in the deferred rebuild/test phase.

### Independent open-description graphics sessions (ABI 54)

The kernel already kept a command mapping on each GL open description, but
host bindings were keyed only by process. A second open overwrote the first
binding, and close/unmap could destroy another session's renderer. Two new
registry regressions reproduce both failures on `9488882656`:
`.context/graphics-session-baseline.log` (14 pass, 2 fail).

Every GL open description now owns a fresh session identity and creating
process. Host imports, registry entries, submit queues, forwarding messages,
queries, surfaces and cleanup carry that identity. Context creation returns
a separate fresh kernel-issued context id through the now-InOut request;
EGL passes that identity for foreign texture imports. Wasm's signed-i32
JavaScript argument representation preserves the unsigned identity.
Process-only registry operations refuse ambiguity. A scoped retirement
clears its command-memory view and leaves sibling sessions live; growth
invalidates every cached view. KMS ownership remains claimed until the last
claiming session retires. Forwarding notification failure is reported after
local session retirement rather than retaining other session records.

Renderer memory stays with its creating process when a descriptor is
inherited or transferred. Foreign-process GL operations fail with `EACCES`;
unmap/exec cleanup does not discard the original owner's session. Final
open-description cleanup names that original owner. Native tests exercise
this ownership model, duplicate descriptors and final close. Full guest
fork/exec/SCM_RIGHTS/crash coverage remains required.

ABI 54 records the changed host import signatures, context result field and
ioctl output direction. The snapshot, generated C/TypeScript declarations,
standalone resolver and graphics package ABI floors match. This is still
one context and surface per backend session. The public EGL facade remains
single-context; its multiple contexts/share groups, per-context encoder
state, kernel thread-current authority, independent read/draw surfaces and
overlapping display generations remain ordinary open work. This foundation
does not claim full E02, G02 or graphics conformance.

The focused checks use the current sources rather than installed guest
artifacts. Browser tests retain their original cross-process cases and add
the same rendered/query checks for two sessions within one process. Results on the ABI 54 source tree:

| Check | Result | Evidence |
|---|---|---|
| Host graphics/KMS/scratch source gate | 272 passed, 16 files, no skips | `.context/graphics-session-host-verified.log` |
| Host declarations, Node/browser entry points | passed | `.context/graphics-session-host-verified.log` |
| Native Rust `runtime-core` filters `gl` and `dri` | 44 and 80 passed respectively, no failures/ignored (overlapping selections, not a combined count) | `.context/graphics-session-rust-scoped.log` |
| Shared ioctl-contract tests | 12 passed | `.context/graphics-session-rust-scoped.log` |
| Native actual EGL/GLES sources with UBSan/device double | 21 cases passed; foreign binding asserts the returned context identity | `.context/graphics-session-native-verified.log` |
| EGL source compiled with normal wasm32 archive flags | passed, private object only | `.context/graphics-session-wasm-compile.log` |
| Browser protocol and memory-boundary negative checks | 9 passed | `.context/graphics-session-memory-boundary.log` |
| Chromium/Firefox/WebKit source rendering | 15 passed, no skips; cross-process and same-process sessions | `.context/graphics-session-browser-verified.log` |
| ABI 54 generation/check and resolver consistency | passed | `.context/graphics-session-abi54.log`, `.context/graphics-session-abi54-final-check.log` |

The browser versions match the preceding renderer-acknowledgement check.
No installed SDK archive, guest executable, package or image was rebuilt by
these checks. Full Rust workspace/package automation, guest CTS,
compositors, full browser-memory and POSIX suites remain required after
normal ABI 55 provisioning. Those deferred checks are not substituted by
these source-host/native results.

### Authoritative thread binding and atomic resize (ABI 55)

GLIO_MAKE_CURRENT now carries context, draw-surface and read-surface ids.
The kernel obtains the caller's TID from dispatch state, rejects another
thread's ownership and permits only one current session per TID. A failed
host acknowledgement leaves the prior binding untouched. All-zero release
revokes ownership without a renderer operation; canonical thread-exit
cleanup also releases it. Submit, query and foreign-texture operations
check current-thread authority before host execution. Destroying a current
context or attached surface fails EBUSY; an unused surface can be destroyed
while the context remains surfaceless.

Both native and forwarded hosts initialize viewport/scissor once, from
the first drawable or to zero when surfaceless. Later binds preserve client
state. Forwarded acknowledgements use the existing independent bounded
mailbox; retirement cannot publish late creation or bind state. Messages
copy exactly four drawable scalars and never forward guest memory.

The destruction guard exposed Wayland's old destroy/recreate resize path.
GLIO_UPDATE_SURFACE now replaces an existing GPU window target without
changing its surface identity or current references. EGL flushes before
the update; rejection keeps the old native buffer, attached size, binding
and client state. This currently covers existing GPU window targets on the
same native renderer. Forwarded GPU updates and mixed canvas targets remain
ordinary surface-model gaps. Initial surface creation still needs complete
failure propagation. No full E02/E03/E04 conformance is claimed.

Baseline evidence: the new kernel ownership regression fails on
`c5237892a7`, and its native surfaceless-bind regression also fails there
(21 pass, 1 fail): `.context/graphics-current-kernel-baseline.log` and
`.context/graphics-current-wire-native-baseline.log`. The later
failed-release regression fails against the archived intermediate C source
`.context/graphics-current-release-before.c`; its log is
`.context/graphics-current-release-baseline.log`.

Focused source evidence for ABI 55 (2026-10-23):

| Check | Result | Evidence |
|---|---|---|
| Native Rust runtime-core `gl` / `dri` filters | 48 / 80 passed; overlapping selections, no failures or ignored | `.context/graphics-current-retarget-rust.log` |
| Shared ioctl-contract tests | 12 passed | `.context/graphics-current-retarget-rust.log` |
| Actual native EGL/GLES with UBSan/device double | 25 cases passed | `.context/graphics-current-retarget-native.log` |
| Host graphics/KMS/scratch plus Node/browser declarations | 281 passed in 16 files; declarations passed | `.context/graphics-current-final-host.log` |
| Browser protocol/memory-boundary negative checks | 10 passed | `.context/graphics-current-final-memory-boundary.log` |
| Chromium/Firefox/WebKit source rendering | 18 passed, no skips | `.context/graphics-current-final-browser.log` |
| Private wasm32 EGL and Wayland-EGL objects | compiled with archive flags and generated protocol header | `.context/graphics-current-compile.log` |
| ABI 55 generation/check and resolver | passed | `.context/graphics-current-retarget-abi55.log` |

Browser versions match the preceding checks. The private Wayland header
uses the exact cached wayland-protocols 1.47 XML, whose hash is in the compile
log; no old cached library was linked. These checks do not install archives
or build guest programs/packages/images. Normal ABI 55 provisioning and
full Rust/package, guest CTS/compositor, browser-memory and POSIX validation
remain deferred and required. Multiple public contexts/share groups,
context-owned encoder state and display generations remain implementation
work. Subsequent surfaceless framebuffer repairs are recorded below.

### Native error ownership across renderer switches

The native renderer keeps error flags independently of the guest shadow.
Before this repair, switching owners without first consuming an error let
the next session's glGetError take it. Two muxer regressions fail against
`c519d52dc1` (14 pass, 2 fail), and an actual invalid native texture command
reproduces the wrong-owner result in Chromium, Firefox and WebKit (3 fail):
`.context/graphics-error-owner-baseline.log` and
`.context/graphics-error-owner-baseline-browser.log`.

The shared Node/browser muxer now drains native flags into the outgoing
session before switches and invalidation. It discards flags from unowned
host operations. Queries merge native and retained flags before returning
one, preserving duplicate-flag semantics. Failed drains retain only the
outgoing error array for a retry, let cleanup proceed and prevent switching
to a new owner until draining succeeds. Queue dispatch contains renderer
exceptions as EIO, retires the consumed frame and permits a later retry.

On the ABI 55 source tree, 288 host cases in 16 files and both Node/browser
declarations pass: `.context/graphics-error-owner-final-host.log`. The real
browser suite passes 21 cases across the same three engine versions, with
no skips: `.context/graphics-error-owner-final-browser.log`. Each new browser
case checks both a direct owner switch and invalidation through forwarded
make-current, and includes the memory-boundary probe. Early source runs
exposed non-clearing/incomplete device doubles and a cleanup exception;
those runs are retained in `.context/graphics-error-owner-host.log`.

This is a GL contract bug fix without a wire-layout change; ABI remains 55.
No guest artifacts were rebuilt. Full negative-API/CTS, guest compositor,
browser-memory and POSIX validation remain required after normal current
artifact provisioning. Performance was not measured.

### Surfaceless default framebuffer and rejected readback

`GL_OES_surfaceless_context` specifies an incomplete default framebuffer
when no drawable is associated. A context-owned native FBO with no
attachments now represents that state. It has no guest name and guest
attachment operations cannot alter it. The status query returns
`GL_FRAMEBUFFER_UNDEFINED_OES` (`0x8219`); native completeness checking
rejects clear, arrays/indexed draws, texture copy and readback with
`GL_INVALID_FRAMEBUFFER_OPERATION`. A complete user FBO remains usable.
The shared host extension string now includes this implemented extension.

First-bind allocation is acknowledged before publication; a failed
allocation leaves the old drawable and viewport/scissor intact. Switching
drawables preserves user FBO bindings. Independent native read/draw state
survives muxer replay, and deleting a bound user FBO restores the correct
window or absent default target. Nonzero FBO names are created on first
bind; invalid targets do not allocate or mutate bindings.

Readback now checks native errors before returning bytes. Failure retains
the GL flag and returns a negative host-query result, so the existing
kernel probe-before-write and libc copy-on-success path preserve guest
output. The focused readback regression fails on `17b334712b` (45 pass,
1 fail): `.context/graphics-surfaceless-read-baseline.log`. A real
surfaceless regression also fails on that revision in all three engines:
`.context/graphics-surfaceless-verified-baseline-browser.log` (3 fail).
The first browser fixture's index upload had an incorrect packet shape;
the verified baseline corrects it before any production change.

Focused ABI 55 source validation (2026-10-23):

| Check | Result | Evidence |
|---|---|---|
| Host graphics/KMS/scratch and Node/browser declarations | 295 cases passed in 16 files, declarations passed | `.context/graphics-surfaceless-verified-final-host.log` |
| Chromium/Firefox/WebKit source WebGL | 24 cases passed, no skips | `.context/graphics-surfaceless-final-browser.log` |
| Browser protocol/memory-boundary negative checks | 10 passed, no skips | `.context/graphics-surfaceless-memory-boundary.log` |

The browser check uses a real Worker and the ordinary acknowledged main
forwarder. It verifies all six framebuffer-dependent operation errors,
unchanged canvas pixels and copy destination storage, failed readback,
default attachment rejection, successful user-FBO clear/draw/readback,
split read/draw bindings and bound deletion. Allocation rollback/retry,
retirement and replay are also covered in Node source-host tests. The
engine versions match the preceding checks. Early host runs found an old
single-FBO fixture assumption and a missing delete operation in the device
double; logs remain under `.context/graphics-surfaceless-host.log` and
`.context/graphics-surfaceless-final-host.log`.

No wire layout changed; ABI remains 55. No SDK archive, guest program,
package or image was rebuilt. These checks do not execute guest CTS or
prove the complete GLES/EGL baseline. Normal current-artifact provisioning,
full browser-memory, guest compositor/CTS and POSIX suites remain required
in the deferred rebuild/test phase. Performance was not measured.

### EGL-owned client encoder state

The command cursor, client vertex arrays, pixel storage, client-side error,
name allocation, image aliases/attachments, uniform metadata and returned
strings previously lived in process statics. They now belong to an opaque
heap record allocated for each successful context creation. The calling
thread's current binding selects that record; all 131 defined public GL
entry points check that authority before touching client state. The record
survives release and transfer to another thread. Destruction releases its
retained image references without selecting it or using another current
context's stream. Returned strings expire with their owning context rather
than retaining a previous renderer's values after context recreation.

Client allocation precedes backend creation. Allocation failure therefore
publishes no backend context; backend rejection retires the unpublished
record. This is a dependency for multiple contexts, not their public API
implementation: the current EGL facade and backend session still admit one
context. Shared object groups, independent context command mappings and
surface/display generations remain ordinary implementation work.

On `53d5933bdc`, three new native cases fail: allocation rollback,
unbound-thread interference with the owner's upload layout/error and stale
renderer strings after context recreation. The transfer case already passes
and remains a regression against accidentally storing context state in TLS.
The complete baseline has 26 passes and 3 failures:
`.context/graphics-encoder-state-complete-baseline.log`. The earlier
baseline asserted an unbound caller's return values; the complete baseline
instead checks interference with the live owner's state.

All 29 actual EGL/GLES native cases pass with UBSan:
`.context/graphics-encoder-state-verified-native.log`. Both libraries compile
to private wasm32 objects with the normal archive flags:
`.context/graphics-encoder-state-wasm.log`. Clang AST inspection verifies
the current-record guard on all 131 public definitions, and a private
relocatable link resolves the new cross-archive accessors:
`.context/graphics-encoder-state-verified-audit.log`. The initial AST command
incorrectly used partial overlay headers as a native sysroot; the verified
audit uses the actual wasm32 sysroot. No runtime defect is inferred.

The kernel wire contract remains ABI 55. Internal EGL/GLES accessors require
the paired SDK archives to be rebuilt through the normal path. These checks
produce no installed archive, guest program, package or image. No new host
or browser execution is claimed for this C-only change. Guest thread/CTS,
full browser-memory, compositor and POSIX checks remain required after
current-artifact provisioning in the deferred phase. Performance was not
measured.

### Host shared-object group ownership

The host now separates shareable name maps and shader/program/uniform
metadata from execution-local state, errors, VAOs and FBOs. Each context
starts in its own group. Internal construction can join a fresh target on
the same native renderer; it does not copy maps or allocator counters.
Retiring one context preserves its group's resources for other members.
Pending program deletion and installed executables consider all logical
current references; a failed relink through an inactive peer preserves
another member's executable. Native programs without logical references
are physically unbound before deletion so teardown can complete.

This is an internal ownership foundation. GLIO and public EGL do not yet
construct shared contexts, and no sharing extension or API support is
claimed. Before enabling that path, shared buffer/texture/renderbuffer
deletion needs references from every context binding and container. Kernel
display-generation authority, independent context sessions/mappings,
surface identity/ownership and C shared-name routing also remain open.
Ordinary missing behavior is not a platform boundary.

Focused source validation on ABI 55: 299 host tests in 16 files, plus both
Node/browser declarations, pass in
`.context/graphics-object-group-verified-host.log`. Real WebGL checks pass
27 cases across Chromium, Firefox and WebKit, without skips:
`.context/graphics-object-group-browser.log`. The new direct source-host
case shares a texture and uniform/program namespace, renders alternating
contexts with different viewport state, retires one member and renders
again before final cleanup. It is not guest or forwarded sharing evidence.
Unit cases cover constructor rejection, independent errors/containers,
shared allocator state, final resource retirement, deferred program
deletion and peer relink failure. Early checks exposed a missing empty-set
guard and counter continuity at context retirement; corrected evidence is
the verified log. There was no previous guest sharing implementation to
claim as a before/after compatibility result.

No wire or ABI version changed. No installed artifacts were rebuilt; full
guest CTS/compositor, browser-memory and POSIX validation remain required
after normal provisioning. Performance was not measured.

### Deleted texture and renderbuffer references

[GLES2 Appendix C](https://registry.khronos.org/OpenGL/specs/es/2.0/es_full_spec_2.0.pdf)
distinguishes a deleted name from the object still retained by another
context binding or container. The host now tracks texture/renderbuffer
retirement and FBO attachment identity separately from the name maps.
Deletion clears only the caller's bindings and bound FBO attachments;
unbound containers retain their storage. Reusing the name constructs a
distinct native object. Queries on surviving bindings preserve the old
name until rebinding releases it. Packed depth/stencil points retain
independent references. Rejected native attachment updates preserve the
prior record. BO-owned texture tags do not replace the kernel's canonical
retirement authority or cause a second native deletion.

Three source regressions fail on `8c69689ecd` (50 pass, 3 fail):
`.context/graphics-image-delete-baseline.log`. The enhanced shared-texture
browser case also fails on that revision in all three engines, as does the
new shared-renderbuffer case:
`.context/graphics-image-delete-baseline-browser.log` and
`.context/graphics-rbo-delete-baseline-browser.log` (3 failures each).
Those browser runs import the exact archived pre-change WebGL source tree
under `.context/graphics-image-delete-before/`; no baseline assertion was
weakened.

On the repaired ABI 55 source tree, 306 host tests in 16 files and both
Node/browser declarations pass:
`.context/graphics-image-delete-verified-host.log`. Thirty real WebGL
cases pass across Chromium, Firefox and WebKit without skips:
`.context/graphics-image-delete-final-browser.log`. The texture case
renders green through a surviving deleted binding while the reused name
refers to new blue storage, then retires the old native object on rebinding.
The renderbuffer case checks unbound FBO storage, another context's old
binding, independent replacement storage and final group retirement. These
are direct host-internal group tests, not guest or forwarded sharing.
The browser protocol/memory-boundary checks also pass all ten cases:
`.context/graphics-image-delete-memory-boundary.log`.

Logical image sibling/sampler identity, full buffer storage semantics and
public EGL/group/display-generation routing remain ordinary open work.
This does not complete the sharing baseline. No wire change or artifact
rebuild occurred; ABI remains 55. Full guest CTS/compositor, browser-memory
and POSIX validation remain required in the deferred provisioning phase.
Performance was not measured.


### Deleted buffers and vertex array ownership

Buffer names now retire separately from native objects. The host retains
objects referenced by another context's array binding or by any bound or
unbound vertex array object (VAO), including disabled attributes and element
bindings. Deletion clears the caller's array binding and active VAO's buffer
references. Queries on surviving bindings retain their original numeric
name. Reusing a deleted name creates independent storage; the final binding,
VAO or context release retires the original object once.

A private empty native buffer clears active attribute references through
native deletion without deleting the real object retained elsewhere. This
translation preserves the saved attribute format and global array binding.
Native bind/pointer rejection preserves the corresponding ownership record;
allocation failure before clearing leaves the old name and references live.

The C encoder now owns attribute definitions, enables and the element binding
per VAO, with a separate default VAO. Buffer generations prevent deletion of
a reused name from clearing an older unbound VAO reference. Generated names
reserve entries and skip arbitrary names created by binding. Staging failures
release temporary names and suppress the draw, and negative draw ranges do
not enter client memory staging. Named-VAO client pointer restrictions follow
[OES_vertex_array_object](https://registry.khronos.org/OpenGL/extensions/OES/OES_vertex_array_object.txt).

Before repair, the expanded native suite has 30 passes and six failures on
`e8a7ce1e51`: `.context/graphics-buffer-vao-complete-native-baseline.log`.
The initial two host regressions fail on that revision:
`.context/graphics-buffer-vao-host-baseline.log`. The two rendered regression
cases fail in all three engines when importing the exact archived pre-change
WebGL tree: `.context/graphics-buffer-vao-verified-baseline-browser.log`
(six failures). The earlier browser baseline omitted explicit generated
names and also exercised implicit allocation; use the verified baseline for
the deletion comparison.

Current focused evidence, ABI 55:

| Gate | Result | Evidence |
|---|---|---|
| Native actual EGL/GLES sources with device double and UBSan | 36 cases passed | `.context/graphics-buffer-vao-verified-native.log` |
| Host graphics source gate and Node/browser declarations | 314 cases in 16 files; declarations passed | `.context/graphics-buffer-vao-final-verified-host.log` |
| Real Chromium/Firefox/WebKit source WebGL | 36 cases passed, no skips | `.context/graphics-buffer-vao-final-browser.log` |
| Browser protocol/memory-boundary negative checks | 10 passed, no skips | `.context/graphics-buffer-vao-memory-boundary.log` |
| Private wasm32 EGL/GLES objects and relocatable paired link | Passed | `.context/graphics-buffer-vao-wasm.log` |

The new browser cases render green from an unbound peer VAO's old attribute
or index storage while the reused name renders blue. They check caller-only
clearing, old binding names, independent default VAO references and final
native deletion. These remain direct host-internal group checks, not public
EGL or forwarded shared-context evidence.

The initial index-buffer test correctly found a surviving default-VAO
reference; the final case explicitly releases it before asserting deletion.
An accidental default Vitest invocation began ordinary fixture setup and was
stopped; it is not the focused graphics result. Subsequent checks use
`vitest.graphics.config.ts` with no global provisioning.

This does not close G01–G03. Unlike GLES2,
[WebGL2 buffer binding](https://registry.khronos.org/webgl/specs/2.0/#5.1)
classifies native buffers as element data or other data. The storage stage
below implements separate native views over one logical buffer; this
difference is not a hard platform boundary.
The conversion/staging stage below addresses fixed-point and client size
gaps. Combined bound indices/client attributes, complete negative/limit/query
behavior and C shared-group routing remain open. No wire change occurred; ABI remains 55. Full SDK/archive,
kernel, package and image rebuilds, guest CTS/compositor, browser-memory and
POSIX validation remain deferred until the implementation is ready for the
combined build/test phase. Performance was not measured.


### Coherent vertex and index buffer storage

Each logical host buffer now tracks its data length, usage and an
authoritative native view. A second native view allows the same GLES name
to serve both vertex and index bindings despite WebGL's classification rule.
Successful data replacement or partial updates invalidate other views.
Binding, subsequent partial updates and draws synchronize the required views,
including buffers retained by another context or an unbound VAO. Native
vertex-array pointers continue to refer to stable view objects. Queries and
retirement resolve both views to the original logical identity, so deleted
names, name reuse and final-reference cleanup keep the preceding ownership
contract.

Synchronization reads native bytes in independent chunks of at most 64 KiB
and uploads them to the other class. It preserves native copy bindings and
does not retain a full CPU copy of the buffer. It translates the native
classification rule using the standard
[WebGL2 readback API](https://registry.khronos.org/webgl/specs/2.0/).
Readback can have a performance cost;
performance was not measured. Rejected updates leave size/usage and the
source unchanged. Failed synchronization suppresses the draw, keeps the view
invalid for a later retry and restores copy bindings. Failure to construct a
second view restores the previous binding and retires the temporary object.

On the exact archived `937539798b` WebGL source tree, the two new rendered
cases fail in all three engines (six failures):
`.context/graphics-buffer-storage-verified-baseline-browser.log`. The archive
is `.context/graphics-buffer-storage-before/`. The earlier baseline used the
live source tree; the archived run is the authoritative comparison.

Current focused evidence, ABI 55:

| Gate | Result | Evidence |
|---|---|---|
| Host graphics source gate and Node/browser declarations | 320 cases in 16 files; declarations passed | `.context/graphics-buffer-storage-final-verified-host.log` |
| Real Chromium/Firefox/WebKit source WebGL | 42 cases passed, no skips | `.context/graphics-buffer-storage-verified-browser.log` |
| Browser protocol/memory-boundary negative checks | 10 passed, no skips | `.context/graphics-buffer-storage-memory-boundary.log` |

The new real rendering cases start with either vertex or index classification,
allocate 131080 bytes, update through both targets, redefine the store through
the index binding and render the changed colors through a peer VAO. Reusing
the deleted name renders independent magenta storage while the peer still
renders the old yellow data. Both old native views retire at the final
reference, and final group teardown deletes the two replacement views.
The cases verify the 64 KiB transfer bound, both numeric binding names
and preserved copy bindings. Source-host tests additionally inject
allocation, readback and native update failures and verify retry/cleanup.
These are host-internal group checks; public EGL sharing and guest execution
remain unvalidated.

This stage changes no wire layout, C source or installed artifacts. ABI stays
55. The following stage addresses fixed-point and client staging. The full
G03 audit still includes combined bound indices/client attributes, complete
buffer/vertex queries and negative API/limit behavior. Public sharing also needs C/kernel/EGL group routing.
The authorized deferral of normal SDK/kernel/package/image rebuilds and full
CTS/compositor, browser-memory and POSIX runs remains in effect until the
implementation reaches the combined build/test phase.


### Packed client arrays and fixed-point vertex views

Client staging now packs referenced elements into their original vertex
indices, using command-safe chunks and at most 65520 bytes of scratch space.
It leaves unused prefixes, stride gaps and unreferenced client indices
unread. DrawArrays preserves its first vertex; DrawElements builds a bounded
presence mask for byte/short client indices. The previous single-record
65523-byte client-array limit is removed. Signed wasm32 buffer-size and
pointer-arithmetic checks remain explicit. Allocation failure frees the
scratch/mask and temporary names, restores bindings and suppresses the draw.

The host uses derived vertex views for GL_FIXED or strides greater than
WebGL's 255-byte limit. Fixed components use signed 16.16 conversion to
floating point; normalization is ignored for that type, following
[GLES2 sections 2.1 and 2.8](https://registry.khronos.org/OpenGL/specs/es/2.0/es_full_spec_2.0.pdf).
Derived views pack only the attribute elements, retain the logical format,
offset and stride in the VAO and refresh after raw storage updates. Source
and output scratch spans are independently bounded to 64 KiB. Raw source
bytes remain unchanged. Disabled attributes and unbound VAOs retain derived
views; layout replacement and final-reference/container teardown release
unused views. Failed conversion leaves the view invalid for retry and
suppresses drawing. Native copy and array bindings are restored.

Against `2863d10661`, the expanded native suite passes 37 cases and fails six:
`.context/graphics-client-packed-verified-baseline-native.log`. Both large
uploads hit the old limit, three guard-page cases fault in the old bulk
copy, and the scratch-allocation case fails its assertions. These are
Kandelo client-staging defects. The earlier baseline guard fixtures could
hit the size limit first on a 16 KiB-page host; the verified cases keep the
source span below that cap to expose the invalid reads directly.

The new actual-C fixed-point stream also fails in all three browsers when
replayed against the exact archived `2863d10661` WebGL source tree (three
failures, three float cases pass):
`.context/graphics-client-fixed-baseline-browser.log`. The new fixed-point
shared-VBO case fails in all three engines:
`.context/graphics-fixed-vbo-baseline-browser.log`. The archive is
`.context/graphics-fixed-before/`.

Current focused evidence, ABI 55:

| Gate | Result | Evidence |
|---|---|---|
| Native actual EGL/GLES sources with device double and UBSan | 43 cases passed | `.context/graphics-client-packed-verified-native.log` |
| Host graphics source gate and Node/browser declarations | 324 cases in 16 files; declarations passed | `.context/graphics-fixed-final-host.log` |
| Real Chromium/Firefox/WebKit source WebGL | 51 cases passed, no skips | `.context/graphics-fixed-final-browser.log` |
| Browser protocol/memory-boundary negative checks | 10 passed, no skips | `.context/graphics-fixed-memory-boundary.log` |
| Private wasm32 EGL/GLES objects and relocatable paired link | Passed | `.context/graphics-fixed-wasm.log` |

Two new browser cases compile the actual current C sources with the native
device double, record their submitted commands and replay those exact bytes
through the real host decoder. They render 17000-element float and fixed
client arrays, including a 1024-byte fixed source stride, negative values,
fractional values and normalization enabled. The bytes render cyan and all
temporary buffer views retire. This proves native C encoding through actual
browser rendering; it does not execute Wasm guest marshalling or installed
SDK archives. The expanded shared-buffer case checks a fixed-point VBO with
a wide stride, updates/redefinition through both targets, peer visibility,
name reuse and retirement of raw and converted native views.

An initial parallel Playwright invocation shared its artifact directory
with the baseline run and lost a trace during cleanup. Its failure is not
runtime evidence. The final 51-case run owns its output directory under
`.context/graphics-fixed-browser-artifacts/` and completes serially.

G03 remains partial. Combined bound indices/client attributes, full vertex
and buffer queries, all negative/limit conditions and guest integration are
still open. WebGL2 also
[always enables fixed-index primitive restart](https://registry.khronos.org/webgl/specs/2.0/#PRIMITIVE_RESTART_FIXED_INDEX);
The following stage supplies wider native index streams for GLES2 values
255/65535. The remaining G03 gaps are ordinary implementation work. No wire layout
changed; ABI remains 55. Normal SDK/kernel/package/image provisioning and
full CTS/compositor, browser-memory and POSIX runs remain deferred until the
combined implementation reaches its build/test phase. Performance was not
measured.


### Maximum index values and draw validation

GLES2 byte and short indices now widen to native 16- and 32-bit values before
WebGL execution. This preserves 255 and 65535 as ordinary vertices despite
[WebGL2 fixed-index restart](https://registry.khronos.org/webgl/specs/2.0/#PRIMITIVE_RESTART_FIXED_INDEX).
The helper reads only the requested source range, writes bounded chunks to
a private index buffer and issues one native draw. The original index order,
count and primitive mode remain intact across chunk boundaries; strip and
fan topology are preserved. Original storage and logical VAO ownership do
not change. Native element/copy bindings are restored and the temporary
handle is deleted on success or failure.

Both the C frontend and host reject invalid core draw modes and index types
before client-memory or storage reads. Negative counts, unaligned short
index offsets and out-of-range native reads fail before transfer allocation.
Only GLES2 core byte/short index types are accepted; a uint-index extension
is not advertised. Native 32-bit indices here are an internal translation.

On `36fc54b959`, the native suite has 45 passes and one failure: the invalid
mode case reaches an invalid client pointer before reporting the enum error.
Evidence: `.context/graphics-index-baseline-native.log`. The actual-C maximum
byte/short index streams fail in all three browsers against that revision's
exact archived host source (six failures):
`.context/graphics-index-baseline-browser.log`. The shared-buffer strip
cases also fail in all engines (six failures):
`.context/graphics-index-vbo-baseline-browser.log`. The source archive is
`.context/graphics-index-before/`.

Current focused evidence, ABI 55:

| Gate | Result | Evidence |
|---|---|---|
| Native actual EGL/GLES sources with device double and UBSan | 46 cases passed | `.context/graphics-index-native.log` |
| Host graphics source gate and Node/browser declarations | 329 cases in 16 files; declarations passed | `.context/graphics-index-final-host.log` |
| Real Chromium/Firefox/WebKit source WebGL | 63 cases passed, no skips | `.context/graphics-index-final-browser.log` |
| Browser protocol/memory-boundary negative checks | 10 passed, no skips | `.context/graphics-index-memory-boundary.log` |
| Private wasm32 EGL/GLES objects and relocatable paired link | Passed | `.context/graphics-index-wasm.log` |

The actual-C cases submit 33000 maximum byte or short indices, spanning
multiple promotion chunks, and render the indexed client's cyan vertex.
The VBO cases put the maximum index in the middle of a triangle strip,
check cyan pixels, update to a degenerate strip and observe black, then
restore the shared data. Deleted names and reused names retain independent
old/new pixels and the original binding query value; final cleanup deletes
all source and temporary native handles. Unit tests verify a single draw
across chunk boundaries, exact widened values, source bytes left unchanged,
binding restoration, range/enum validation and failed-transfer retry.

This is native-C-to-browser and direct host rendering evidence. Wasm guest
marshalling, public shared EGL contexts and installed SDK archives remain
unvalidated. Promotion uses synchronous readback and temporary GPU storage;
performance was not measured. G03 still needs combined bound index buffers
and client attributes, complete buffer/vertex queries and broader negative/
limit coverage. No wire layout changed; ABI remains 55. Normal full
SDK/kernel/package/image provisioning and CTS/compositor, browser-memory and
POSIX validation remain deferred until the combined build/test phase.


### Logical buffer/vertex queries and mixed client/index draws

Operation-table v3 adds buffer size/usage, vertex metadata/current values,
object predicates, enable predicates and bounded index-usage queries. The
C library exports the eleven corresponding GLES2 entrypoints through
`eglGetProcAddress`. Buffer queries resolve logical stores, including an
old deleted object retained by a binding and native views invalidated by
another-target write. Host vertex queries retain GLES formats and strides;
C queries also retain original client pointers, buffer names and offsets
after private packed staging. Capability calls reject WebGL2-only enums
without changing native or logical state.

A draw combining client attributes with a bound byte/short index buffer
flushes commands before querying the authoritative index storage. The
8204-byte reply contains status, maximum index, an 8192-byte presence
bitset and a completion marker. It fits the existing 65536-byte query
limit and independent 65556-byte forwarding mailbox. Readback scratch is
bounded at 64 KiB; client staging copies only referenced vertices. The
original element binding survives staging. Client-only indexed draws now
use the same compact bitset instead of one byte per possible vertex.

Every new query uses a status/payload/completion envelope. API failures
leave the GL error flag with the host exactly once; transport or truncated
replies become client errors. Caller outputs remain unchanged on failure,
including allocation failure. Buffer allocation/update calls now reject
invalid core targets, usages, signed sizes and absent bindings before
reading client data; zero-length updates still reach logical range checks.

Existing operation tags and layouts are unchanged. The graphics-specific
`OP_VERSION` advances from 2 to 3 under its documented independent
versioning policy; global `ABI_VERSION` remains 55. Focused kernel tests
accept versions 1, 2 and 3 and reject 0 and 4. Snapshot regeneration and
checking succeeded without generated-file changes. An older op-table-2
kernel rejects a v3 library at initialization; installed artifacts still
need the normal combined rebuild, rather than restamping.

The exact `fafcf3074a` native baseline passes 46 old cases and fails all
five additions (missing query resolvers, bound-index/client-array rejection
and its error path): `.context/graphics-query-baseline-native.log`.
The new direct host-query browser case fails in all three engines against
that exact archived host source, `.context/graphics-query-before/`:
`.context/graphics-query-baseline-browser.log`.

Focused evidence on the v3 source tree:

| Gate | Result | Evidence |
|---|---|---|
| Native actual EGL/GLES with device double and UBSan | 51 passed | `.context/graphics-query-final-native.log` |
| Host graphics source gate and Node/browser declarations | 336 cases in 16 files; declarations passed | `.context/graphics-query-final-verified-host.log` |
| Real Chromium/Firefox/WebKit source WebGL | 72 passed, no skips | `.context/graphics-query-final-browser.log` |
| Kernel operation-table negotiation and graphics lifecycle | 16 GLIO cases; 4 additional lifecycle cases passed | `.context/graphics-query-glio-rust.log`, `.context/graphics-query-rust.log` |
| Browser protocol/memory-boundary negative checks | 10 passed | `.context/graphics-query-memory-boundary.log` |
| Private wasm32 EGL/GLES objects and paired relocatable link | Passed | `.context/graphics-query-wasm.log` |
| Public-entrypoint current-context authority audit | All 142 defined public GL functions guarded | `.context/graphics-query-audit.log` |
| ABI snapshot/source consistency | Passed; global ABI 55, generated files unchanged | `.context/graphics-query-abi-check.log` |

The two additional captured-C bound-index streams render cyan at the
maximum byte/short vertex in all three engines. Their native device double
supplies the controlled index query response; captured command replay does
not execute that query. Separate real-browser tests query native WebGL
storage, including stale element views, sparse indices, original formats,
deleted/reused names, independent context values and single GL errors.
This does not establish end-to-end guest query marshalling or public EGL
sharing. Source inventory still lacks eight GLES2 core functions:
`glGetActiveAttrib`, `glGetAttachedShaders`,
`glGetFramebufferAttachmentParameteriv`, `glGetRenderbufferParameteriv`,
`glGetShaderSource`, `glGetTexParameterfv`, `glGetTexParameteriv` and
`glValidateProgram`. The C attribute mirror still has a fixed 16-slot limit;
native limits and all negative/size cases require further audit. G01–G04
remain partial, and the other inventory families remain open as listed.

Snapshot verification compiled the focused kernel component. Normal full
SDK/archive/program/package/image provisioning, guest CTS, cage/sway,
full browser-memory and POSIX validation remain deferred to the combined
build/test phase. Performance was not measured.


### GLES2 core object entrypoints and program validation

The final eight missing GLES2 core symbols now have implementations and
`eglGetProcAddress` mappings: active attributes, attached shaders, shader
source, framebuffer attachments, renderbuffer parameters, integer/float
texture parameters and program validation. The source/resolver inventory
now contains all 142 GLES2 core entrypoints; there are 150 public GL
functions including the existing extra entrypoints. This is symbol and
focused behavior coverage, not a GLES2 conformance claim.

Original shader bytes belong to the shared shader object, survive pending
deletion while attached and retire with the final shader reference. Source
length queries count those bytes rather than the driver's decoded string.
Zero-string source replacement now clears the source; negative counts
report an error. Active attribute queries report their full name length,
size/type and requested name range; program queries calculate the maximum
attribute name length. Attached-shader queries return logical names even
while deletion is pending. Program validation invokes the native driver
against the logical program and records wrong-kind/missing-name errors.

Operation-table v4 adds six checked query tags and one validation command.
String/list queries first fetch metadata, then bounded result chunks; each
reply stays within the existing 65536-byte query ceiling. The C library
accumulates results privately and publishes outputs only after every
chunk succeeds. Zero-sized output buffers still validate the object and
return the appropriate metadata/count. API failures preserve output and
retain single host ownership of GL errors. Existing operation layouts
remain unchanged; global ABI stays 55. Snapshot regeneration/checking
produced no generated-file changes, and focused kernel negotiation tests
accept versions 1–4 and reject 0 and 5.

Attachment queries use the actual retained attachment record, including
old deleted names after public name reuse, texture level and cube face.
The C EGLImage mapping translates a matching host texture back to its
public texture/renderbuffer identity. Separate query identity fields
survive deletion of an unbound sibling's public name. Image-backed
renderbuffer dimensions and component sizes reflect the known host RGBA8
BO storage. Core framebuffer attachment enums are checked before changing
C image bookkeeping. Native renderbuffer parameters report actual driver
storage, and texture parameters accept the four core GLES2 query names.

The reference contracts are the Khronos
[active attribute](https://registry.khronos.org/OpenGL-Refpages/es2.0/xhtml/glGetActiveAttrib.xml),
[attached shader](https://registry.khronos.org/OpenGL-Refpages/es2.0/xhtml/glGetAttachedShaders.xml),
[shader source](https://registry.khronos.org/OpenGL-Refpages/es2.0/xhtml/glGetShaderSource.xml),
[framebuffer attachment](https://registry.khronos.org/OpenGL-Refpages/es2.0/xhtml/glGetFramebufferAttachmentParameteriv.xml),
[renderbuffer](https://registry.khronos.org/OpenGL-Refpages/es2.0/xhtml/glGetRenderbufferParameteriv.xml),
[texture parameter](https://registry.khronos.org/OpenGL-Refpages/es2.0/xhtml/glGetTexParameter.xml)
and [program validation](https://registry.khronos.org/OpenGL-Refpages/es2.0/xhtml/glValidateProgram.xml)
reference pages. Inspected source copies are under
`.context/graphics-core-spec/`.

Exact `e2b20591ff` baseline: the native suite passes 51 prior cases and
fails all four additions at their missing resolver checks:
`.context/graphics-core-baseline-native.log`. The new direct WebGL case
fails on all three engines against that exact archived host source under
`.context/graphics-core-before/`:
`.context/graphics-core-baseline-browser.log`.

Focused evidence on the v4 source tree:

| Gate | Result | Evidence |
|---|---|---|
| Native actual EGL/GLES with device double and UBSan | 55 passed | `.context/graphics-core-final-native.log` |
| Host graphics-only source gate and Node/browser declarations | 344 cases in 16 files; declarations passed | `.context/graphics-core-verified-host.log` |
| Real Chromium/Firefox/WebKit source WebGL | 75 passed, no skips | `.context/graphics-core-browser.log` |
| Kernel graphics negotiation/lifecycle and shared GL contracts | 16 GLIO cases; 5 shared cases passed | `.context/graphics-core-rust.log`, `.context/graphics-core-final-shared-rust.log` |
| Browser protocol/memory-boundary negative checks | 10 passed | `.context/graphics-core-memory-boundary.log` |
| Private wasm32 EGL/GLES objects and paired relocatable link | Passed | `.context/graphics-core-final-wasm.log` |
| Public GL current-context and core resolver inventory | All 150 definitions guarded; 142/142 core names defined/resolved | `.context/graphics-core-audit.log` |
| ABI snapshot/source consistency | Passed; global ABI 55, generated files unchanged | `.context/graphics-core-abi-check.log` |

Native tests exercise 70000-byte controlled query replies, truncation,
zero-capacity queries, second-chunk failure with unchanged caller storage,
allocation failure, single backend errors, and image-backed renderbuffer
identity after deletion while unbound. The native device double still
supplies query data rather than executing guest u32 input marshalling.
The host's large-source query case seeds logical storage directly; the C
source-upload path still has its separate single-TLV size limit. Browser
checks exercise real compiled attribute reflection, validation status,
pending-delete shader source and names, raw original bytes, actual native
renderbuffer values, texture parameters and retained cube attachments.
They do not execute the guest libraries through the kernel.

The first two host invocations accidentally used the default configuration
and entered fixture provisioning before being terminated. Their exact
sessions ended with status 137; they do not supply passing host evidence.
They generated the program index and compiled some ordinary guest test
fixtures, but did not complete the integration suite. The verified gate
above uses `vitest.graphics.config.ts` without fixture provisioning.
Snapshot verification compiled the focused kernel component. Normal full
SDK/archive/program/package/image provisioning and guest CTS, cage/sway,
full browser-memory and POSIX validation remain deferred.

GLES2 remains partial: default texture-zero object translation, the C
single-TLV shader upload size limit, fixed 16-slot attribute mirrors,
uniform/reflection edge cases and full negative/limit/error coverage are
ordinary implementation gaps. Public EGL sharing, independent surfaces,
display generations, sibling sampler/storage identity and the other
inventory families remain open. No new platform boundary is claimed.
Performance was not measured.


### Context-owned default textures

GLES default 2D and cube texture objects now have private native storage
and sampler state. They remain separate from shared public texture maps
and from each other. A logical null binding continues to mean name zero;
only the native binding resolves it to the private stand-in. Creation
binds the object on every native unit whose logical binding is zero,
including units not selected by the client, and restores the active unit.
Later muxer replay resolves those same default objects. Naming/binding a
public texture preserves existing default state, and deleting a bound
public texture restores the caller's default object. Deleting name zero
is ignored, binding queries report zero and the public object predicate
remains false for zero.

Storage, subimage, compressed-image, copy and mipmap paths prepare the
appropriate default object before issuing the native operation. Parameter
queries and setters use only the four core GLES2 parameter names; foreign
ES3 targets/parameter enums are rejected before private allocation or
state changes. Allocation or partial-binding failure restores affected
units, deletes the temporary native handle, preserves named bindings and
suppresses the dependent operation. Private objects retire when their
individual context is destroyed, even while shared objects and another
context survive.

These are the GLES2 default-object semantics described in the
[OpenGL ES 2.0 specification, sections 3.7 and appendix C](https://registry.khronos.org/OpenGL/specs/es/2.0/es_full_spec_2.0.pdf).
The [WebGL2 texture-object rule](https://registry.khronos.org/webgl/specs/latest/2.0/#TEXTUREOBJECTS)
rejects modifying/querying a null native binding, so a native stand-in is
required to implement the GLES state. This uses the existing commands and
query envelopes; global ABI remains 55 and operation-table version 4.
No protocol, kernel, C library or installed archive changed in this batch.

The new default-texture rendering cases fail in all three engines against
the exact `486dfb0a16` host source archive at
`.context/graphics-texture-zero-before/` (six failures at the initial
default-parameter query):
`.context/graphics-texture-zero-final-baseline-browser.log`.


Focused current evidence:

| Gate | Result | Evidence |
|---|---|---|
| Host graphics source gate and Node/browser declarations | 350 cases in 17 files; declarations passed | `.context/graphics-texture-zero-checked-host.log` |
| Real Chromium/Firefox/WebKit source WebGL | 81 passed, no skips | `.context/graphics-texture-zero-browser.log` |
| Browser protocol/memory-boundary negative checks | 10 passed | `.context/graphics-texture-zero-memory-boundary.log` |

The six new host cases check initial parameters, separate target/context
objects, all 64 units in the native test model, named-binding preservation,
zero-name deletion, rollback/retry, enum rejection and per-context native
retirement. The existing odd-record decoder fixture now binds a named
texture explicitly, keeping its assertions about unaligned uniform records
independent of lazy default-object creation. Earlier focused host runs
failed only that fixture's old assumption about the complete call list;
the corrected current gate above has no skips or failures.

The real-browser 2D and cube cases render distinct red/green context
textures through an initially unselected sampler unit, alternate owners,
invalidate/replay, and retain pixels after deleting zero. They update the
default image through subimage, copy-subimage and copy-image calls, render
a named blue texture, then recover the original default pixels after
named deletion. Queries still report binding name zero and false object
predicate. ES3-only parameter mutation is rejected while native state
stays unchanged. Destroying one context deletes its private native object
and leaves the peer's storage renderable; final peer teardown retires its
own object. These direct host tests use internal groups; public shared
EGL contexts and full guest marshalling remain unvalidated.

This closes the default-object implementation gap at the host source
layer. G06 remains partial: the C texture-unit mirror is fixed at 32,
complete formats/negative/storage/limit coverage and guest CTS remain
open, as do EGLImage sibling sampler identity and public context/surface/
display-generation routing. C shader upload and attribute limits remain
ordinary gaps in their inventory families. No outside-runtime defect or
new platform boundary is asserted. Normal full SDK/kernel/program/package/
image provisioning, guest CTS, cage/sway, full browser-memory and POSIX
validation remain deferred to the combined build/test phase. Performance
was not measured.


### Acknowledged shader source uploads

The C library no longer silently drops shader source longer than 65527
bytes. Small sources retain their existing inline command layout; large
calls use operation-table v5's acknowledged upload query. Concatenation
honors null-terminated and explicitly sized strings, including empty
strings and lengths that exclude trailing bytes. Checked arithmetic
rejects unrepresentable totals before reading source bytes. C scratch is
one 65536-byte request and one 12-byte response, allocated before BEGIN;
there is no complete C-side concatenation buffer. Each CHUNK carries at
most 65520 source bytes under the existing 64 KiB query input cap.

The new `QOP_SHADER_SOURCE_UPLOAD` input is four little-endian words:
action, shader name, context-local monotonic token, and total/offset. BEGIN,
CHUNK, COMMIT and ABORT are actions 1–4. Only CHUNK has trailing bytes.
Every success returns the token in the existing checked status/payload/
completion envelope. The host holds at most one pending source per
context, validates contiguous offsets and total length, and installs the
source only after a complete COMMIT. Native rejection preserves the prior
source and metadata. Shared peers see the completed shader source; their
in-progress uploads remain independent. Final shader deletion cancels
uploads retaining that object. Valid inline replacement, a newer BEGIN,
explicit ABORT and context teardown also release pending ownership.

ABORT consumes its token even if BEGIN was not observed, preventing a
late BEGIN from recreating cancelled storage. An older abort cannot cancel
a newer upload. C cancellation reuses its preallocated buffers. If the
device also rejects cancellation, pending ownership remains with the
context until replacement or teardown; the client does not report proven
release. A malformed/lost COMMIT acknowledgement reports a device error
and is never replayed. Its outcome is indeterminate to the caller: the
native commit may already have executed. Native tests explicitly exercise
this case. Coherent context-loss/device-failure propagation remains an
ordinary G09/E02 audit item, not a claimed conformance result or a new
hard platform boundary.

Command submission errors now latch a client error. Queries/uploads stop
when their preceding submission fails, and automatic command-buffer
flush failure suppresses the dependent record. Consumed failed batches
are not silently retried. Host-owned source metadata is reserved before
native installation and restored if the driver rejects the new source.

Fresh main was fetched and remains `f3cb7041f6`, already integrated. The
additive query advances `OP_VERSION` from 4 to 5; existing tags/layouts
remain unchanged and global ABI stays 55. Snapshot regeneration/checking
succeeded without generated-file changes. Focused kernel negotiation
accepts versions 1–5 and rejects 0 and 6. Normal installed archives remain
subject to the later combined rebuild.

The exact `8008d1bafb` native baseline passes 55 prior cases and fails all
four additions: three because no large upload commits and one because
submission failure still permits a query to modify its output:
`.context/graphics-shader-upload-baseline-native.log`. All six new browser
cases (direct and forwarded in three engines) fail against the exact host
archive `.context/graphics-shader-upload-before/`:
`.context/graphics-shader-upload-baseline-browser.log`.

Focused current evidence:

| Gate | Result | Evidence |
|---|---|---|
| Native actual EGL/GLES with device double and UBSan | 59 passed | `.context/graphics-shader-upload-verified-native.log` |
| Host graphics-only source gate and Node/browser declarations | 359 cases in 18 files; declarations passed | `.context/graphics-shader-upload-verified-host.log` |
| Real Chromium/Firefox/WebKit source WebGL | 87 passed, no skips | `.context/graphics-shader-upload-final-browser.log` |
| Kernel graphics negotiation/lifecycle and shared GL contracts | 16 GLIO and 5 shared cases passed | `.context/graphics-shader-upload-rust.log` |
| Browser protocol/memory-boundary negative checks | 10 passed | `.context/graphics-shader-upload-memory-boundary.log` |
| Private wasm32 EGL/GLES objects and paired relocatable link | Passed | `.context/graphics-shader-upload-wasm.log` |
| Public authority and core resolver inventory | All 150 public definitions guarded; 142/142 core symbols defined/resolved | `.context/graphics-shader-upload-audit.log` |
| ABI snapshot/source consistency | Passed; global ABI 55 | `.context/graphics-shader-upload-abi-check.log` |

Native cases concatenate a 140000-byte comment with other source strings,
verify three chunks and one commit, and exercise client allocation/size
failure, failed submission, host errors, bad completion/echo, abort failure
followed by replacement, retry and indeterminate commit acknowledgement.
The fixture resolves heap query pointers through its recorded allocation
ranges; it does not dereference truncated native addresses. A test-only
protocol trace captures actual C submitted commands and upload query
inputs in order. This is stronger than replaying commands without their
queries, but still does not execute guest/kernel u32 pointer marshalling.

The browser replays those actual C frames, compiles the large shader,
retrieves matching original bytes and native driver source, and renders
cyan. The forwarded variants reuse one independent 65556-byte mailbox,
submit inputs through a disposable worker's shared Wasm memory and verify
that copied query/command input crosses to main. Explicit teardown
retires the native shader; the memory boundary probe reports no failures.
The first forwarding fixture timed out with root-relative imports inside
a blob worker; corrected absolute module URLs and worker error handling
pass in all engines (`.context/graphics-shader-upload-checked-browser.log`)
and in the full gate above. No browser defect is asserted.

G04 and G09 remain partial. C attribute/texture-unit mirrors, complete
shader/uniform/error/limit coverage, public EGL contexts/sharing/surfaces/
display generations, sibling sampler identity and the remaining inventory
families still need implementation and validation. Snapshot verification
compiled the focused kernel component; normal full SDK/archive/program/
package/image provisioning, guest CTS, cage/sway, full browser-memory and
POSIX validation remain deferred. Performance was not measured.
