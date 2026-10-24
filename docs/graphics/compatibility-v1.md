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
| G01 | GLES2 object name creation, binding, deletion; ES2 §§2,6 | Reference-counted C name owner reserves buffer/texture/renderbuffer names, including implicit binds; shared shader/program allocation is serialized. Public C groups and full query/error coverage remain open | GLES encoder, registry, query | CTS GLES2 functional state/query/object groups; host object tests | partial; no demonstrated boundary |
| G02 | Context-local full state; ES2 state tables | Client state is context-owned; host groups separate shared names from local state/containers. Deleted image/buffer names retain binding/container references and program lifetime spans current owners. C attribute/index state belongs to each VAO. Multiple public contexts have focused native/source-browser coverage; full rollback, hints and CTS remain open | EGL, encoder, object groups, shadow, muxer, decoder | Alternating contexts/processes; real shared-object/deletion/viewport rendering; native thread-transfer/isolation | partial |
| G03 | Buffer allocation/update, indexed and client-array draws; ES2 §2 | Per-VAO mirrors, retained deleted buffers and coherent native vertex/index views. Fixed-point/wide-stride host views and bounded packed client staging are implemented. Maximum byte/short indices use native promotion. Bound index buffers plus client attributes use a bounded presence query; core buffer/vertex queries preserve logical state. Client staging now retains/restores actual ARRAY identity across peer deletion/reuse (operation table 6). Full size/limit/negative coverage remains open | GLES encoder, bridge | CTS buffer/vertex/indexed tests; invalid lengths and offsets | partial |
| G04 | Shader source/compile/link, reflection, deletion; ES2 §2 | Deleted current objects retain references; shader/program names share a namespace; latest link state is separate from the current executable. Core attribute/source/attachment reflection, acknowledged large-source uploads and validation entrypoints are implemented; complete executable/attribute/uniform validation still needs work | encoder, query, registry | CTS shader API and reflection; delete attached/current objects; rendered alternating owners and relinking | partial |
| G05 | Uniform scalar/vector/matrix and arrays; ES2 §2 | Checked renderer replies now supply complete element widths/values without C reflection caches and preserve failed-query outputs. Shared-peer/source-retirement/relink cases have focused evidence. Locations now remain stable across repeated/array-alias lookups, and checked chunked C lookup/reflection removes fixed buffers. Shader-name translation beyond WebGL limits and complete setter/type/array validation remain open | encoder, query | CTS uniform API/state queries; hostile reply sizes | partial |
| G06 | Texture formats, cube maps, pixel storage, subimages and copy; ES2 §3 | WebGL2 normalization, core parameter queries and context-owned default texture objects are implemented in host source; complete target/state/error and guest CTS audit remain open | encoder, bridge, muxer | CTS texture specification/negative/cube groups; rendered pixels | partial |
| G07 | Raster/depth/stencil/blend/clear/readback; ES2 §§3,4 | Main provides offscreen color/depth/stencil; no broad CTS evidence | bridge, query, present-target | CTS functional render families; real pixels all three engines | partial |
| G08 | FBO attachments/completeness and renderbuffers; ES2 §4 | Default/user identities and read/draw state remain distinct; attachment records retain deleted texture/RBO storage, including unbound containers and separate packed depth/stencil points. Core attachment/renderbuffer queries implemented; full storage/negative/CTS coverage remains open | encoder, registry, image references, presentation | CTS FBO and attachment queries; deletion/reallocation | partial |
| G09 | Ordered errors and non-mutating invalid calls; ES2 §2.5 | Native pending errors now remain with the outgoing session across switches/invalidation; queries merge duplicate native/retained flags. Some guest paths silently return; missing-name host calls may resolve to null | encoder, decoder, query | CTS negative API; malformed TLV/span/enum tests | partial |
| G10 | Every core function resolves; ES2 API | All 142 GLES2 core symbols are defined and resolved; native/private-Wasm audit passes. Full semantic and guest conformance remain pending | capability manifest, EGL resolver | Enumerate core header symbols, link and call; version-gated extensions | partial |
| E01 | EGL1.5 display initialization/config selection/queries; EGL §§3.2–3.4 | One shared attribute table drives enumeration, matching and queries; config operations validate initialization, handles and errors. Full display/config lifecycle and CTS validation remain pending; advertised 1.5 unchanged | EGL library, surface metadata | CTS query_config/choose_config/negative API | partial |
| E02 | EGL current-thread API/context/surface lifecycle; EGL §§3.5–3.7 | Error/API/current binding are thread-local; kernel-authoritative TID ownership, acknowledged replacement, release/exit, unique C handles, context-owned encoder and deferred destruction implemented for one context/surface per backend session. ABI 56 separates revocable display-generation roots from object sessions. C generation records retain old current descriptors, mappings, encoders and imported images while a new generation initializes. Host surface records retain native draw/read targets across context destruction and owner retirement. ABI 57 returns fresh surface IDs and acknowledged dimensions. Kernel/host cross-session draw/read selection validates process, live generation and TID, with canonical surface storage retained after owner retirement. Creation/bind failure preserves prior state. Public independent context/surface records route separate draw/read selectors. ABI 58 kernel/renderer construction joins live same-generation object groups; public C shared object records and the full error/lifecycle audit remain open | EGL, GLIO, registry, encoder | CTS query_context/multi_context/thread_cleanup; destroy-current and stale handles | partial |
| E03 | Pbuffers, window/pixmap platform entry points and queries; EGL §3.5 | Public window queries expose accepted dimensions and fixed attributes; pbuffer creation still fails and several core symbols are absent | EGL, host drawable/GLIO metadata | CTS create/query surface and resize | open |
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
| K03 | Shared OFD GEM/FB authority, PRIME and final references | Shared KMS FBs and inherited graphics cleanup/BO holds are implemented; general forked GEM handle-map sharing and full guest validation remain open | OFD, process/fork/spawn/exec/close, BO registry | Rust + real Node lifecycle/dup/fork/spawn tests | open |
| K04 | Legacy modeset/flip/vblank/master handoff | Main display owner and cleanup; cage changes automatic master and CLOSEFB | KMS, host scanout | Pending flip drop/exit/crash/master replacement, no stale event/scanout | partial |
| K05 | GPU scanout, CPU fallback and context loss | Main has GPU producer target; cage adds scanout blit | host GPU registry/present target/KMS pump | Render imports to scanout; orientation/pixels three engines | open |
| H01 | Command framing, complete validation and bounded results | Full structural prevalidation now protects batches; host source regressions pass | bridge, submit queue/drain | Malformed trailing command leaves earlier state untouched; query output sizes | partial |
| H02 | Synchronous query ordering and main forwarding parity | Forwarded queries now use copied input and one bounded reusable mailbox per channel, with timeout retirement; shared native contexts use the same muxer model | worker protocols, query, main-forward | Kernel import preflight at both pointer widths; rendered alternating forwarded owners on three engines | partial; full guest and memory-cycle gate pending |
| H03 | Process/worker/machine cleanup and resource retirement | Canonical surface BO holds and image-owned renderer cleanup now survive descriptor inheritance/local close; focused native lifecycle checks pass. Combined guest/memory-cycle validation remains pending | kernel and shared lifecycle, registries, muxer | fork/spawn/exec/close/death/crash; browser-memory repeated cycles including KMS consumers | partial |
| A01 | ABI and generated declarations match combined implementation | Main heap-safepoint ABI 52 and graphics session/thread-current/display-authority changes are combined under ABI 57 with acknowledged surface creation; generated outputs and resolver verified, full artifacts pending | shared ABI, snapshots, generated C/TS, package closure | ABI checker, generation diffs, normal SourceOnly rebuild | open |
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

### Revocable display roots and object sessions (ABI 56)

Display initialization now creates a kernel-owned generation root and
joins a separate object open description to it. The 16-byte input/output
`GlInitInfo` carries operation version, role, display fd and generation.
Only a live same-process display root with the matching generation can
authorize a join. Root descriptors may be duplicated; authority ends on
explicit termination or final close. Reusing an fd for a fresh root does
not authorize old children or stale joins.

Roots cannot map command memory or create contexts/surfaces and never
allocate a host renderer. Context/surface creation and positive binding
require live root authority. Already-current children retain submit and
query access after revocation, then release and destroy normally. Root
cleanup sends no renderer unbind; object cleanup retains its exact
session identity. The same kernel authority applies to Node and browser
hosts.

The actual EGL library opens both descriptions with close-on-exec,
publishes initialization only after joining and mapping succeed, and
closes both on rollback. Termination revokes the root before its existing
deferred object retirement. The public facade still allows one context
and surface and still refuses reinitialization while an old current
generation is retained. Public sharing, independent draw/read surfaces
and overlapping display generations remain ordinary E02/E03 gaps.

New kernel regressions cover roles, owner/generation mismatch, unchanged
failed initialization output, root mapping/object rejection, revocation
while current, submit/query retention, fd reuse and final duplicate close.
The new native initialization rollback case fails against exact HEAD
`2fcfc70c1f` while its other 59 cases pass:
`.context/graphics-display-authority-baseline-native.log`.

Focused source validation (2026-10-23):

| Check | Result | Evidence |
|---|---|---|
| Native actual EGL/GLES with device double and UBSan | 60 passed | `.context/graphics-display-authority-native.log` |
| Kernel graphics and shared GL contracts | 20 GLIO and 5 shared cases passed | `.context/graphics-display-authority-verified-rust.log` |
| Kernel graphics lifecycle, DRI and ioctl contracts | 4 GL lifecycle, 50 DRI and 12 shared ioctl cases passed; filters overlap other focused checks | `.context/graphics-display-authority-lifecycle-rust.log` |
| Host graphics source gate and Node/browser declarations | 359 cases in 18 files; declarations passed | `.context/graphics-display-authority-host.log` |
| Real Chromium/Firefox/WebKit source WebGL | 87 passed, no skips | `.context/graphics-display-authority-browser.log` |
| Browser protocol/memory-boundary negative checks | 10 passed | `.context/graphics-display-authority-memory-boundary.log` |
| Private wasm32 EGL/GLES objects and paired relocatable link | Passed | `.context/graphics-display-authority-wasm.log` |
| Public authority and core resolver inventory | All 150 public definitions guarded; 142/142 core symbols defined/resolved | `.context/graphics-display-authority-audit.log` |
| ABI 56 generation and source consistency | Passed; initialization InOut16 and struct offsets recorded | `.context/graphics-display-authority-abi56-update.log`, `.context/graphics-display-authority-abi56-check.log` |
| Standalone resolver regeneration and checks | Passed | `.context/graphics-display-authority-resolver56.log` |

Graphics operation version remains 5. Global ABI 56 is incompatible with
prior initialization and requires normal artifact rebuilding. No SDK
archive, program, package or image was restamped or rebuilt here. Browser
source rendering and native device doubles do not execute this new
handshake through guest Wasm/kernel marshalling. Guest CTS, cage/sway,
full browser-memory and required POSIX/conformance gates remain deferred
until the combined implementation and normal artifacts are ready.

Next implementation is the public C generation/context/share-group model,
kernel-owned independent surface identities and cross-session draw/read
routing, and host surface-owned targets with acknowledged publication.
Device/context-loss propagation after indeterminate replies, fixed C
attribute/texture-unit mirrors, EGLImage sibling sampler/storage identity,
remaining EGL 1.5 APIs and the other inventory rows remain open. This
authority foundation does not close an API family.

### Retained C display generations and image identities

The EGL library now keeps a heap record per initialized generation instead
of process-global descriptors, command mappings and object state. The
public display selects its active generation; a current thread retains
its original generation, mapping and encoder. Termination revokes that
generation and its public image handles immediately. A new initialization
can complete before old current resources are released, including when
another thread owns them. Successful replacement retires the former
generation only after backend acceptance. Failed initialization or binding
preserves the old current resources and query outputs.

This implements the reinitialization/lifetime rule in
[EGL 1.5 section 3.2](https://registry.khronos.org/EGL/specs/eglspec.1.5.pdf).
It does not make terminated context/surface handles usable through public
lookups; current-context queries retain their existing identities until
release. The touched context, surface and image operations reject an
uninitialized display before dereferencing its generation record. A full
EGL error audit remains open.

Each imported image retains its importing generation. Final sibling
cleanup therefore closes its GEM handle on the original open description,
even when a new generation uses the same numeric handle. Public image
identities now use monotonic tokens rather than heap addresses; allocation
reuse cannot revive a deleted handle. Image lookup obtains a temporary
reference under the image/owner lock before a GL sibling is installed.
Termination cannot free a validated image in that interval. Every failed
installation releases the temporary reference. The context lock precedes
the image lock; sibling reference operations never acquire the context
lock, including encoder destruction during generation retirement.

The native device double now models independent descriptors, mappings,
current owners and command streams. Seven added cases cover generation
overlap, allocation rollback, failed replacement binding, release before
new binding, two-thread ownership, paused image acquisition during
termination, rendered command routing, and stale image identities. All
seven fail against the exact prior library/header at `7507e19cf0`; its
60 older cases pass. The initial new test incorrectly expected the native
query double to supply unpack alignment. It now checks the actual C-owned
row-length mirror; the double does not claim native state-query evidence.

Focused source validation (2026-10-23):

| Check | Result | Evidence |
|---|---|---|
| Native actual EGL/GLES with device double and UBSan | 67 passed | `.context/graphics-generation-authoritative-native.log` |
| Exact prior-library comparison | 60 passed; all 7 added cases failed | `.context/graphics-generation-authoritative-baseline-native.log` |
| Host graphics source gate and Node/browser declarations | 359 cases in 18 files; declarations passed | `.context/graphics-generation-host.log` |
| Real Chromium/Firefox/WebKit source WebGL | 90 passed, no skips | `.context/graphics-generation-authoritative-browser.log` |
| Browser protocol/memory-boundary negative checks | 10 passed | `.context/graphics-generation-abi-memory.log` |
| Private wasm32 EGL/GLES objects, paired relocatable link and source audit | Passed; 150 public definitions guarded and 142/142 core symbols defined/resolved | `.context/graphics-generation-authoritative-wasm-audit.log` |
| ABI snapshot/source consistency | Passed; global ABI 56 and graphics operation version 5 unchanged | `.context/graphics-generation-abi-memory.log` |

The new browser case captures actual C submissions and retirement records
for the old and new device descriptions. It replays those streams into
independent host targets, reads red then blue pixels, and verifies that
old-target destruction preserves the new target before final retirement.
It uses the source renderer, not guest initialization or kernel ioctl
marshalling. The inherited kernel root-authority tests are recorded in
the ABI 56 section above; no Rust source changed in this C ownership batch.
Main was fetched again and remains `f3cb7041f6`, already integrated.

Public EGL still admits one context and surface within each generation.
Multiple contexts/share groups, independently owned draw/read surfaces,
image sampler/storage identity and the other inventory gaps remain open.
The private C ownership changes use the existing ABI 56 wire. Normal SDK
archives, programs, packages and images still need rebuilding together;
no stale artifact was restamped. Guest CTS, cage/sway, full browser-memory
and required POSIX/conformance validation remain deferred until the
combined implementation is ready. This source evidence closes the C
generation-overlap restriction, not the full E02 lifecycle inventory.

### Host surface resources and separate native draw/read selection

Native presentation storage now belongs to a surface resource record,
separate from a context's errors, state and containers. The existing
binding fields address that canonical record. Destroying a context keeps
an explicit live surface's texture, framebuffer and depth/stencil storage;
replacement on the same renderer reuses it. A different renderer is
rejected without retiring the old surface, and creation remains retryable.
An unpublished staging target still retires with its creating context.

Host draw/read selectors retain their actual surface records. One context
counts once when both selectors name the same surface. Owner retirement
prevents new selection but retains storage until its last selecting
context releases it. User FBOs remain local context state. Native default
framebuffer selection resolves draw/read targets separately; rebinding
framebuffer zero through `GL_FRAMEBUFFER` issues separate native binds
when the targets differ. A rejected native bind restores both previous
bindings without changing the logical state.

Resize allocates a candidate color/depth/stencil target, checks it and
restores native texture/renderbuffer/read/draw bindings before publication.
Failure frees only candidate resources and preserves the old target,
dimensions and pixels. Successful replacement updates every selecting
context's default references while preserving user FBOs and other read
targets, then retires the former allocation. The explicit-size allocation
helper needs neither another canvas nor another WebGL context. It does
not expose guest pbuffers; their EGL API remains incomplete.

Forwarded make-current now prepares default storage without publishing
current state. It commits only after the bounded reply mailbox accepts
acknowledgement; cancellation or a lost completion race frees its candidate.
No new forwarding message, guest-memory view or shared-memory reservation
was introduced. The host implementation is shared by Node and browser.

Two unchanged-API pixel regressions run against the exact prior source
archive `81c634d856`: context destruction deletes a live target, and failed
resize loses its red pixels. Both fail on Chromium, Firefox and WebKit,
six failures total, with actual target/pixel assertions rather than import
failures. Evidence: `.context/graphics-surface-owner-baseline-browser.log`.
An additional focused regression first reproduced framebuffer-zero read
selection being replaced by the draw target:
`.context/graphics-surface-owner-zero-baseline-host.log`.

Focused source validation (2026-10-24):

| Check | Result | Evidence |
|---|---|---|
| Host graphics source gate and Node/browser declarations | 370 cases in 19 files; declarations passed | `.context/graphics-surface-owner-complete-host.log` |
| Real Chromium/Firefox/WebKit source WebGL | 99 passed, no skips | `.context/graphics-surface-owner-stable-browser.log` |
| Browser protocol/memory-boundary negative checks | 10 passed | `.context/graphics-surface-owner-abi-memory.log` |
| ABI snapshot/source consistency | Passed; global ABI 56 and operation version 5 unchanged | `.context/graphics-surface-owner-abi-memory.log` |

New host cases cover owner/context retirement, separate selectors, resize
fanout, same-renderer/PID/live-identity preflight, cancelled preparation,
failed allocation/storage/completeness/lost-renderer retries, framebuffer
zero and native rejection rollback. The three new browser cases per
engine check retained red pixels, failed-resize retry, green readback from
a read surface while clearing a different draw surface blue, explicit
framebuffer-zero restoration, independent resize and final deletion after
owner/selector release. All use actual WebGL resources and pixels.
An intermediate run missed the framebuffer constant import and was stopped;
the stable 99-case run followed the fix. No engine defect is claimed.

This closes native host ownership gaps, not public independent EGL surface
routing. The guest wire still scopes surface ID 1 to its object session,
creation lacks a native result acknowledgement, and cross-session bind/
generation/BO retention needs the kernel/C surface protocol. Host private
selectors check process, renderer, identity and live ownership; they do not
grant guest generation authority. GPU BO deletion remains owned by the BO
registry, and canonical surface-held kernel BO references are still open.
Public multiple contexts/share groups, full context-loss/error propagation
and the remaining ledger inventory stay open.

Rust and C production sources did not change in this host batch. Earlier
kernel/native/private-Wasm results are recorded above, not rerun claims.
Main was fetched and remains `f3cb7041f6`, already integrated. Normal SDK,
program, package and image rebuilds and guest CTS, cage/sway, full
browser-memory and POSIX/conformance gates remain required and deferred until the
combined implementation is ready. Draft PR #1574 tracks this progress.


## Kernel surface BO ownership and inherited cleanup (2026-10-24)

A surface now owns a kernel BO reference independently of its GEM handle.
Closing the last handle preserves CPU or GPU target storage until surface
retirement. An update retains its candidate before entering the backend,
transfers ownership only on acknowledgement, and releases only the
candidate on rejection. Same-target updates keep one reference. A pending
candidate remains in canonical cleanup state if transport terminates
indeterminately; full context-loss/error propagation remains open.

Cleanup identity and active/pending surface holds belong to a shared lease
on the inherited open description. Fork relinks that lease without copying
command mappings or current-thread authority. Foreign GL initialization is
rejected. Child close, exec, forced removal, spawn close-on-exec and failed
spawn cannot revoke the parent's renderer. Final description close retires
the native owner and backing once.

Owner-image cleanup also retains weak reachability to its leases. Exec,
exit, forced removal and command-buffer unmap revoke the old renderer even
when the owner has closed every local descriptor and a child retains the
open description. Weak references do not prolong storage lifetime. Native
unbind or surface destruction is ordered before host BO destruction;
subsequent child close does not repeat either effect. This fixes one
inherited graphics resource family; general GEM handle-map sharing is
still open under K03.

Evidence includes actual kernel BO registry counts, real process-table
fork/spawn/removal and ordered host effects through the native device
double. These are kernel lifecycle assertions, not rendered guest proof.
Ten new regressions fail against unchanged production at `51a3cce50a`:
`.context/graphics-surface-bo-baseline-rust.log`. Additional owner-close
cases first reproduced missed exec/exit/removal cleanup and command-memory
unmap in `.context/graphics-surface-bo-closed-owner-baseline.log` and
`.context/graphics-surface-bo-closed-owner-unmap-baseline.log`.

| Focused check | Result | Evidence |
|---|---|---|
| GLIO surface/session/native lifecycle | 34 passed, including 14 added cases | `.context/graphics-surface-bo-related-rust.log` |
| Related runtime-core selections | 4 GL lifecycle, 50 DRI, 48 fork-module, 56 process-table, 22 OFD-module and 42 spawn-filter cases passed; overlapping scopes | `.context/graphics-surface-bo-related-rust.log` |
| Shared GL layouts/operations/query boundary | 5 passed | `.context/graphics-surface-bo-shared-gl-related.log` |
| Shared ioctl contracts | 12 passed | `.context/graphics-surface-bo-related-rust.log` |
| ABI source/snapshot consistency | Passed; global ABI 56 and operation version 5 unchanged | `.context/graphics-surface-bo-abi.log` |

The initial shared-GL filter selected zero cases. The corrected `gl_tests`
selection passed four module cases; `gl_` adds the query wire boundary for
the five-case result above. Rust formatting was applied
to changed helpers, graphics ioctl arms and new tests; the complete related
selection passed afterward. ABI checking compiles the kernel for export
inspection, not the normal combined SDK/program/package/image closure.
No public wire, host imports, fork serialization or shared-memory ceilings
changed. Existing valid ABI 56 programs keep their layouts and protocol.

This closes kernel-held surface BO ownership in the present one-surface
session model. Global surface IDs, creation acknowledgements, public
independent draw/read routing, same-generation binding authority, multiple
public contexts/share groups and the remaining ledger inventory stay open.
The next incompatible surface wire requires a fresh ABI after checking main.
Host and C production sources did not change in this batch; the preceding
370 host, 99 rendered browser and 67 native C results remain historical
source evidence. Full guest CTS, compositor consumers, browser-memory and
POSIX/conformance suites and normal product rebuilds remain required and
deferred until the combined implementation is ready. Draft PR #1574
continues to track the active goal.


## Acknowledged surface creation, ABI 57 (2026-10-24)

Surface creation previously published ID 1 in every session before a void
host callback. It could report success without a backend drawable. ABI 57
changes GLIO_CREATE_SURFACE to a 36-byte input/output argument: the existing
32-byte attributes plus a zero-on-input surface ID. On success, it returns
a fresh kernel ID and accepted width/height. The host creation import now
returns status and writes dimensions into its private kernel scratch copy.
The original target GEM handle remains local in the guest reply.
GLIO_UPDATE_SURFACE keeps its existing 32-byte input attribute wire.

Creation validates metadata and output identity before backend entry. The
candidate BO hold precedes backend execution. A negative/invalid native
result or malformed dimensions leaves the caller's bytes, context/current
binding and public surface identity unchanged; candidate destruction
precedes releasing its backing. Accepted creation transfers the hold and
publishes the returned ID. The C generation records that ID and size and
binds with the actual ID instead of assuming 1.

The host prepares an independent native target, preserving prior state and
bindings on allocation failure. Explicit surface dimensions stay with its
storage rather than following another context's shared canvas. Creation
can precede logical context creation, including KMS context replacement.
The main-thread renderer receives copied, explicitly selected scalar
metadata and acknowledges eight dimension bytes through the existing
65,556-byte device mailbox. It commits only after completion is accepted;
a retired request frees its unpublished allocation. Destruction checks
the expected ID, so stale candidate cleanup cannot retire its successor.
Creation and swap share that same mailbox. Swap selects the owner, blits
its completed private target and flushes before acknowledgement. The source
type audit and runtime memory probe allow only these reviewed mailbox fields; they still reject guest memories, extra shared buffers and
growable/resized mailboxes. No memory ceiling was raised.

Focused evidence:

| Check | Result | Evidence |
|---|---|---|
| Kernel surface/session lifecycle | 36 passed, including fresh-ID and rejected-creation regressions | `.context/graphics-surface-wire-final-c-glio.log` |
| Related native runtime-core scopes | 4 GL lifecycle, 50 DRI, 48 fork-module, 56 process-table, 22 OFD-module and 42 spawn-filter passed; overlapping selections | `.context/graphics-surface-wire-related-rust.log` |
| Shared GL/query and ioctl contracts | 5 GL/query and 13 ioctl cases passed | `.context/graphics-surface-wire-related-rust.log` |
| Actual EGL/GLES C sources with device double and UBSan | 68 passed; device IDs start at 131 and binds must match the returned ID | `.context/graphics-surface-wire-final-c-glio.log` |
| Host graphics source gate and Node/browser declarations | 374 cases in 19 files, declarations passed | `.context/graphics-surface-wire-stable-host-memory.log` |
| Actual source WebGL in Chromium/Firefox/WebKit | 102 passed, no skips | `.context/graphics-surface-wire-present-browser.log` |
| Private wasm32 EGL/GLES objects and paired relocatable link | Passed; 150 guarded public GL definitions and 142/142 core symbols/resolver entries | `.context/graphics-surface-wire-wasm-memory.log` |
| ABI source/snapshot consistency | Passed, ABI 57 / operation version 5 | `.context/graphics-surface-wire-final-abi-memory.log` |
| Standalone resolver regeneration and tests | Passed | `.context/graphics-surface-wire-abi-resolver-memory.log` |
| Source protocol/memory-boundary negative checks | 12 passed | `.context/graphics-surface-wire-stable-host-memory.log` |

The new rendered worker/main-forward case creates storage before its logical
context, verifies accepted dimensions, reads retained red pixels after
owner retirement, replaces the surface, reads green pixels, rejects another
live-surface creation and verifies stale destruction preserves green. Swap blits that completed
private target to the actual default canvas; the test reads its visible
green pixel as well. Native ordinary-canvas swap uses the same blit helper,
and its host regression verifies that the blit runs. Forwarded swap is
acknowledged through the same mailbox, without enlarging it. This
is source host rendering through a real worker and WebGL, not a rebuilt
guest/kernel integration claim.

The fresh-ID regression fails on unchanged production at `22e87867e0`;
the malformed-host-metadata case also fails meaningfully on the previous
host source. Logs are `.context/graphics-surface-wire-baseline-rust.log`
and `.context/graphics-surface-wire-baseline-source-host.log`. Intermediate
Rust/host runs exposed tests still supplying the old size, ID or implicit
config; they were updated to the new wire. The first memory check used an
incorrect Node loader; the corrected check then caught the missing explicit
type-audit allowance for the new mailbox. Both were fixed before the final
12-case result. An initial host command selected normal fixture setup and
was stopped at its exact process/session (exit 137); the source-only config
was then used. Those partially produced fixtures are not validation of the
normal ABI 57 artifact closure and must be rebuilt normally for integration.

Main remains `f3cb7041f6`, already integrated. Snapshot, generated constants,
C ioctl marshalling and standalone resolver are regenerated together.
Checking the snapshot compiles the kernel only for export inspection.
The public facade still has one context/surface per generation; independent
public surface objects, same-generation cross-session selection/current
references and guest share-group routing remain open. This batch supplies
their fresh-ID/creation-acknowledgement prerequisite, not full routing.
Complete EGL queries/pbuffers, context-loss/error propagation and the rest
of the inventory remain ordinary work. Normal SDK/program/package/image
rebuilds, guest CTS, cage/sway, full browser-memory and POSIX/conformance
remain required and deferred until implementation is ready. Draft PR #1574
continues to track the active goal.


## Canonical cross-session draw/read surfaces (2026-10-24)

Kernel surfaces now have a canonical shared record containing identity,
PID/display generation, dimensions and active/pending BO holds. The owner
and current draw/read selectors retain that record, including the case
where both selectors name it. They do not duplicate its one BO hold or
allocate another surface for each context. Make-current resolves live
same-process/same-generation surface IDs across object sessions, rejects
another thread's selected surface before backend entry, and replaces prior
references only after renderer acceptance.

Explicit surface destruction remains busy while any current selector uses
it. Owner close, terminate or command-memory unmap retires its authority
without destroying storage still selected by another context. Retired IDs
cannot grant new selection; existing current operations retain their actual
targets. Release, replacement, thread cleanup, close, partial unmap, exec,
exit or forced removal retire the last references once. Weak image-owned
cleanup also finds a current context whose final local fd closed while a
child retains its description. A rejected replacement keeps its backing.

The host resolves the same independent native records in direct and
main-forward make-current. Framebuffer zero and swap use selected resources;
a context needs no fake owned surface. Retargeting a borrowed GPU BO prepares
all affected default bindings and drawable sizes, preserving user FBOs,
other read surfaces and viewport/scissor state. Publication performs no
native calls or allocation after preparation. This removes the former
partial update path through replaceDefaultFramebuffer. Kernel BO metadata
retains original width/height independently of stride padding.

Focused evidence:

| Check | Result | Evidence |
|---|---|---|
| Kernel GLIO surface/context lifecycle | 44 passed, including 8 added cross-session cases | `.context/graphics-surface-routing-final-rust.log` |
| Related runtime-core selections | 4 GL lifecycle, 50 DRI-filter, 26 DRI-module, 48 fork-module, 56 process-table, 22 OFD-module, 42 spawn-filter cases passed; overlapping selections | `.context/graphics-surface-routing-final-rust.log` |
| Shared GL/query and ioctl contracts | 5 and 13 passed | `.context/graphics-surface-routing-final-rust.log` |
| Host graphics source and Node/browser declarations | 375 cases in 19 files, declarations passed | `.context/graphics-surface-routing-stable-host.log` |
| Actual source WebGL, native worker and main-forward paths | 111 passed across Chromium/Firefox/WebKit, no skips | `.context/graphics-surface-routing-stable-browser.log` |
| Source protocol/memory-boundary checks | 12 passed | `.context/graphics-surface-routing-memory-boundary.log` |
| ABI source/snapshot consistency | Passed; ABI 57 / operation version 5 unchanged | `.context/graphics-surface-routing-abi.log` |

The eight new kernel cases cover independent selectors, failed replacement,
PID/generation/unknown/mixed-null/TID rejection, same-thread transfer,
closed-local-description rebind/thread cleanup, shared BO retargeting,
owner terminate/unmap against six selector teardown paths, and
foreign-process/inherited-description authority rejection. They use actual
process-table inheritance/removal and BO registry reference
counts with a native host double. The first three regressions fail against
unchanged production at `1197c7f971`:
`.context/graphics-surface-routing-baseline-rust.log`. The new direct-host
cross-session case also fails meaningfully on that source:
`.context/graphics-surface-routing-baseline-host.log`.

Nine new browser executions cover three paths in all three engines: direct
host imports in a dedicated worker with a real OffscreenCanvas, main-thread
forwarding from a real worker, and native GPU BO retargeting. They read red
and green source surfaces, clear a different draw surface blue while still
reading green, retain pixels after both owners retire, reject stale new
selection, and present the selected owned draw target to visible canvas.
The GPU case destroys the former native BO after retarget, reads blue from
the replacement and green from its independent read surface. Final cleanup
checks actual native framebuffer, texture and renderbuffer retirement.
The native import fixture uses a synthetic kernel scratch module; it does
not execute Rust ioctl marshalling or normal guest artifacts. Its explicit
BO destroy events stand in for the kernel ownership path tested separately
above. These are source renderer and native kernel proofs, not a combined
CTS result.

Older forwarded fixtures now create real surfaces with distinct identities
before binding rather than supplying unowned positive IDs. A new lifecycle
matrix initially lacked its context command mapping; the fixture was fixed
to map owner and context sessions before use, then all 44 cases passed.
No browser/runtime defect is claimed.

This is private-state and additive binding work under ABI 57. The existing
12-byte make-current wire, valid own-surface/surfaceless requests, host
imports, forwarding messages and serialized fork bytes keep their layouts.
No new shared-memory ceiling or mailbox is introduced. C production sources
are unchanged; the earlier 68 native C and private-Wasm audits remain
historical evidence at `1197c7f971`, not rerun results for this batch.

The public EGL facade still needs multiple context/group/surface records
within each generation and the corresponding sharing and lifecycle APIs.
Complete EGL queries/pbuffers, GLES errors/limits, full context-loss and
indeterminate-operation propagation, general forked GEM handle authority
and the remaining inventory are still ordinary gaps. Normal ABI 57 SDK,
program/package/image rebuilds, guest CTS, cage/sway, full browser-memory
and POSIX/conformance remain required and deferred until implementation is
ready. Main remains fetched `f3cb7041f6`, already integrated. Draft PR #1574
tracks this progress; the full goal remains active.


## Public independent EGL records and descriptor ownership (2026-10-24)

The public C facade now owns separate context and surface records within
each initialized generation. Each context retains its own encoder and
command mapping. Additional records join the live root through additional
object sessions; sessions may carry a context, a surface, or both. A surface
is independent of the context which happened to share its descriptor.
Make-current names the actual draw/read identities, which may differ and
belong to other sessions in the same generation. Swap validates the current
draw surface and presents through the current context's descriptor.

One monotonic public identity space keeps contexts, surfaces and images
distinct across kinds and generations. Destruction invalidates a handle
immediately, while current bindings retain the record and storage until
kernel-authoritative destruction succeeds. Busy destruction is retried
without displacing another thread. A native window cannot acquire a second
surface while its prior deleted/current surface still owns the window.
Failed allocation, creation or current replacement leaves the previous
binding and encoder intact. Default context version is 1, so the ES2-only
configuration requires an explicit version 2 request. Valid sharing is
currently rejected rather than silently ignored; implementing actual guest
share groups remains ordinary required work.

GEM names are open-description local. Surface creation/retarget and foreign
texture binding now export/import through PRIME when crossing descriptors.
Export capabilities and temporary local names close on success or failure;
idempotent imports preserve an existing image-owned base-descriptor name.
Images retain their importing generation's owner independently of temporary
context-local names. Native Wayland buffers own separate render descriptors
and close them after their BOs retire, including failed allocation/resize.
They can be created before any context is current. Resizing updates queried
surface dimensions only after the target is accepted.

`eglQuerySurface` is defined and resolved. Window queries expose accepted
width/height, config, render buffer, colorspace, swap/multisample behavior
and unknown pixel-resolution values. Pbuffer-only queries on a window
succeed without modifying the output. Invalid or deleted handles, unknown
attributes and failed queries preserve caller output. These semantics follow
[EGL 1.5 sections 3.5.5–3.5.6 and 3.7](https://registry.khronos.org/EGL/specs/eglspec.1.5.pdf).
The prior native test which swapped a deleted/current public surface now
expects BAD_SURFACE while retained current GL remains usable.

Focused evidence for this C batch:

| Check | Result | Evidence |
|---|---|---|
| Actual EGL/GLES C with device double and UBSan | 75 cases passed, including 7 added records/ownership cases | `.context/graphics-egl-record-final-native.log` |
| Actual native-window C with device/protocol doubles and UBSan | Descriptor ownership, resize rejection, four allocation failure paths and final cleanup passed | `.context/graphics-egl-record-wayland-native.log` |
| Host graphics source and Node/browser declarations | 375 cases in 19 files and declarations passed | `.context/graphics-egl-record-stable-host.log` |
| Actual source WebGL in Chromium/Firefox/WebKit | 117 passed, no skips | `.context/graphics-egl-record-stable-browser.log` |
| Source protocol/memory-boundary negatives | 12 passed | `.context/graphics-egl-record-memory-boundary.log` |
| Private wasm32 EGL/GLES objects, paired relocatable link and native-window object | Passed; 150 guarded GL definitions, all 142 GLES2 core symbols/resolver entries | `.context/graphics-egl-record-final-c-wasm.log` |

The independent-records native case fails meaningfully on unchanged C
production at `8c1a6d1e72` (second context creation), with the expanded device
double: `.context/graphics-egl-record-baseline-c.log`. The 68 prior cases
passed against unchanged production with that expanded double before the
C refactor: `.context/graphics-egl-record-double-existing.log`.

Six new browser executions replay actual accepted C control calls and
encoder bytes in all three engines, through both native host imports in a
dedicated OffscreenCanvas worker and real worker-to-main forwarding. Two
contexts and three surfaces retain independent red/green/blue pixels, draw
blue while reading green, preserve green storage after its context retires,
and retire all native framebuffer/texture/renderbuffer objects. Pixel
queries are explicit renderer probes after actual C clear batches; they do
not invent guest query pointers. The adapter supplies kernel dispatch and
identity translation, with a synthetic kernel scratch module. It does not
execute normal Rust guest ioctl marshalling, CTS or a compositor. Initial
replay errors read the context ID from the wrong field and expected the
wrong explicit surface retirement order; the adapter/expectation were fixed
before the complete 117-case pass. No runtime defect is claimed.

The native-window check uses provisioned SDK headers and pinned installed
wayland-protocols 1.47 XML with dev-shell wayland-scanner. These private
compilations do not rebuild or restamp SDK archives or normal programs.
There is no incompatible wire change: ABI 57 / graphics operation version
5 and the prior Rust lifecycle evidence remain unchanged. Final private
compilation includes all three EGL/GLES/native-window objects and their
combined relocatable link, after the final C/native regression changes.

Guest share groups, pbuffers/platform surface entry points, sync/core images,
the remaining GLES API/error/limit/storage audit, context-loss propagation,
forked GEM authority and the rest of the inventory remain ordinary gaps.
Normal SDK/program/package/image rebuilds, guest CTS, cage/sway, full
browser-memory and POSIX/conformance remain required and deferred until
implementation is ready. The full goal remains active; draft PR #1574
continues to carry incremental progress.


## Shared kernel/renderer context construction, ABI 58 (2026-10-24)

Context creation now carries an explicit `share_context_id`. Zero creates
an independent group; a positive ID must name a live source context owned
by the same process and display generation. The kernel checks authority
before backend entry or publishing a target. Sharing may use a source
currently owned by another thread; it does not transfer its current
binding. Unknown IDs, foreign owners, other generations, retired sources,
nonzero reserved/output fields and revoked roots fail without publishing
caller output or a new context. Backend failure preserves the source and
allows retry. A surviving peer can become the source after the original
context is destroyed.

The 16-byte creation argument is now four u32 fields: client version at
0, share context at 4, reserved at 8 and returned context ID at 12. This
explicit meaning replaces a formerly reserved word, so ABI_VERSION moves
to 58. Snapshot, generated C/TypeScript constants and the standalone
resolver are regenerated together; field offsets have shared-layout tests.
Graphics command operation version stays 5. Main was fetched again at
`f3cb7041f6`, still ABI 52 and already an ancestor. Normal artifacts for
older ABIs still require a normal rebuild; none are restamped here.

The host resolves the kernel context identity to its actual source binding.
A fresh target joins the source's existing object maps after native
compatibility checks, before successful acknowledgement. Local bindings,
errors, default textures, framebuffer objects and vertex-array containers
remain independent. Shared maps and retained storage survive the original
context, deletion and numeric name reuse. Membership allocation precedes
removing the target from its old empty group, preventing a failed
allocation from stranding that owner.

Forwarded creation sends only an optional numeric source session ID through
the existing fixed creation mailbox. The kernel-worker adapter translates
the kernel context ID to that session; browser main validates the live
source and renderer. A cancelled completion removes the unpublished target
without deleting source objects. A malformed creation mailbox on an
already-live context cannot destroy it. No guest memory, extra device
buffer or raised memory ceiling is introduced. The Node/shared host path
uses the same native construction checks; forwarding is the browser
fallback for the same operation.

Focused evidence:

| Check | Result | Evidence |
|---|---|---|
| Kernel GLIO lifecycle | 46 passed, including 2 added sharing authority/rollback cases | `.context/graphics-share-final-rust.log` |
| Shared GL layouts and ioctl-filter tests | 4 and 18 passed | `.context/graphics-share-final-rust.log` |
| Host graphics source and Node/browser declarations | 381 cases in 19 files, declarations passed | `.context/graphics-share-stable-host.log` |
| Actual source WebGL in Chromium/Firefox/WebKit | 123 passed, no skips | `.context/graphics-share-stable-browser.log` |
| Source protocol/memory-boundary negatives | 12 passed | `.context/graphics-share-memory-boundary.log` |
| Actual native EGL/GLES C with device double and UBSan | 75 passed | `.context/graphics-share-final-c-wasm.log` |
| Private wasm32 EGL/GLES compile/link and entrypoint inventory | Passed; all 150 guards and 142/142 GLES2 core symbols/resolvers | `.context/graphics-share-final-c-wasm.log` |
| ABI snapshot/generated consistency and standalone resolver regeneration/tests | Passed, ABI 58 / operation version 5 | `.context/graphics-share-final-abi.log` |

The new kernel positive/rollback regression fails against unchanged
production at `1671da6106`: sharing is rejected before it reaches the
backend failure. Both native-host construction tests fail on the unchanged
host source. Evidence: `.context/graphics-share-kernel-baseline.log` and
`.context/graphics-share-host-baseline.log`. Rejection tests also cover
malformed attributes, absent/foreign/stale sources and incompatible native
renderers. Forwarding checks source-ID translation, unchanged source after
rejected/cancelled creation, scalar-only messages and retry after a lost
acknowledgement. A source registry guard was tightened so an allocation
exception cannot strand a target between groups.

Six new real-browser executions use four driver-level contexts with
shared and independent groups through native worker imports and main
forwarding. They read red through a peer, update it green and read the
change in the source, retain green after source destruction, join through
a surviving peer, delete/reuse a name while another context retains the
old green FBO attachment, and check final native texture/FBO/renderbuffer
retirement. Each context's local FBO can independently use numeric name 7.
These are actual WebGL pixels with a synthetic kernel scratch adapter,
not Rust guest marshalling or a public C sharing claim.

The public EGL C facade still rejects a valid share context until its
client-side names, image aliases and retained references have a real
shared ownership layer. Simply sharing encoder state or copying counters
would lose context isolation and retained storage identity. That C work,
remaining EGL/GLES APIs and semantic audits, and the complete GBM/KMS
inventory remain ordinary required work. Normal SDK/program/package/image
rebuilds, guest CTS, cage/sway, full browser-memory and POSIX/conformance
remain deferred until implementation is ready. The full goal remains
active and draft PR #1574 tracks this construction prerequisite.


## Reference-counted C name ownership (2026-10-24)

C encoders now retain an independent name-owner record. That owner contains
buffer/texture/renderbuffer reservations and the common shader/program
allocator, protected by a metadata mutex. A private encoder constructor can
retain an existing owner; it does not copy counters or share the encoder's
command cursor, error, bindings, arrays or container state. Public EGL
sharing remains rejected because image/storage references are not yet
shared safely. This is the C ownership prerequisite, not completion of the
public shared-context API.

Buffer records now carry explicit references from the namespace, array
binding, every vertex-array element binding and every captured attribute.
Deletion removes the public name and the caller's active references;
unbound VAOs retain the actual old record after numeric name reuse.
Replacing bindings, deleting VAOs and final encoder destruction release
those references. Only the last encoder releases the common namespace.
Group/record reference overflow and constructor failure are checked before
publication. Metadata locks are released before command emission or device
calls, so a paused operation cannot hold them across another thread's EGL
termination or generation replacement.

Name generation reserves an entire batch before publishing output or
advancing counters. Failed allocation frees its candidate reservations and
leaves caller output and allocator state unchanged. Implicit texture and
renderbuffer binding also reserves the chosen name; a later `GenTextures`
or `GenRenderbuffers` skips it. This fixes the former collision between
binding texture 1 and generating a texture. Negative generation/deletion
counts for those families now report INVALID_VALUE. The naming rules are
specified by [GLES 2.0 sections 2.9, 3.7.13 and 4.4.2](https://registry.khronos.org/OpenGL/specs/es/2.0/es_full_spec_2.0.pdf).

Focused evidence:

| Check | Result | Evidence |
|---|---|---|
| Actual native EGL/GLES C with device double and UBSan | 81 passed, including six new name-owner/storage cases | `.context/graphics-c-groups-final-c-wasm.log` |
| Private wasm32 EGL/GLES compile/link and entrypoint audit | Passed; all 150 guards and 142/142 GLES2 core symbols/resolvers | `.context/graphics-c-groups-final-c-wasm.log` |
| Actual source WebGL in Chromium/Firefox/WebKit | 129 passed, no skips | `.context/graphics-c-groups-browser.log` |

The implicit-name regression fails against unchanged `5985c3c727` C:
`.context/graphics-c-groups-baseline-native.log`. The first 75 prior cases
passed with the new ownership model before the new cases were added:
`.context/graphics-c-groups-first-native.log`. The private-owner tests
create shared and independent encoder owners, keep reservations after
source destruction, start two allocation threads together and verify 256
distinct reservations, inject constructor/mid-batch failure and verify full
rollback. They test internal C ownership, not EGL-created shared contexts.
A 100-cycle inactive-VAO/delete/reuse case returns to its original tracked
allocation count after each cycle and to zero after complete teardown.
The allocation registry itself is now mutex protected for these concurrent
native checks.

Six additional browser executions replay actual C control calls and command
bytes through native worker imports and main forwarding. The C case binds
implicit texture 1, generates another name, allocates both, clears them red
and green through one local FBO, and re-reads the first texture as red.
Final native texture/FBO/renderbuffer retirement passes. The existing
synthetic scratch adapter still supplies kernel dispatch; no normal guest
marshalling or CTS is executed by this replay.

Host/kernel production and wire layouts did not change. The 381 host cases,
Node/browser declarations, 46 GLIO plus shared-layout/ioctl checks, twelve
memory-boundary negatives and ABI/resolver checks at `5985c3c727` remain
historical evidence for those unchanged sources, not newly repeated gates.
ABI 58 / operation version 5 stay unchanged. Normal artifacts and the broad
integration/conformance phase remain deferred as requested.

At this checkpoint, required C work included image alias/object records
and peer binding/FBO references, shared program/reflection/link metadata,
and retained ARRAY restoration during client staging. The last item is
implemented below. Public sharing remains rejected until the other models
are complete. All other open EGL,
GLES, GBM/KMS, fork authority and full-validation requirements remain part
of the active goal; ordinary gaps are not platform boundaries.


## Retained ARRAY identity during client staging (2026-10-24)

Client-array uploads temporarily bind private buffers. Restoring the
application's saved numeric name could select a replacement object if a
peer deleted and reused that name while the upload crossed a submit
boundary. The C encoder now retains its actual buffer record before
staging and transfers that reference back afterward without name lookup.
The capture belongs to the encoder and final destruction releases it.

The host has one context-local saved ARRAY binding. Empty-payload
`OP_BEGIN_CLIENT_ARRAY` (0x0105) and `OP_END_CLIENT_ARRAY` (0x0106) retain
and restore the actual native view across submissions. A saved zero
binding is distinct from no capture. Retired-buffer collection includes
this pin across all group members and canonicalizes separate index/vertex
views. Restore reuses the existing ARRAY view without allocating or
synchronizing storage; ordinary data/draw operations synchronize it before
use. Native restore rejection preserves the pin and current shadow for
retry, and dependent draws fail with INVALID_OPERATION while capture is
pending. Nested/missing captures are errors; malformed payloads reject the
whole submitted batch before mutation. Context destruction releases pins.

This is additive operation-table version 6. Existing tags, layouts, host
imports and syscall meanings are unchanged, so global ABI stays 58 under
the independently versioned command-table policy in `shared::gl`.
GLIO_INIT still accepts versions 1 through 6 and rejects zero/future tables.
The ABI snapshot and generated outputs remain consistent without changes.

Focused evidence:

| Check | Result | Evidence |
|---|---|---|
| Actual native EGL/GLES C with device double and UBSan | 84 cases passed | `.context/graphics-array-save-final-c-wasm.log` |
| Private wasm32 EGL/GLES objects/link and entrypoint audit | Passed; 150 guards and 142/142 GLES2 core symbols/resolvers | `.context/graphics-array-save-final-c-wasm.log` |
| Host graphics source and Node/browser declarations | 386 cases in 19 files and declarations passed | `.context/graphics-array-save-stable-host.log` |
| Real Chromium/Firefox/WebKit source rendering | 141 passed, no skips | `.context/graphics-array-save-stable-browser.log` |
| Kernel GLIO lifecycle, shared layouts and ioctl-filter cases | 47, 4 and 18 passed | `.context/graphics-array-save-rust-abi.log` |
| ABI source/snapshot/generated consistency | Passed, ABI 58 / operation table 6 | `.context/graphics-array-save-rust-abi.log` |
| Browser protocol/memory-boundary negatives | 12 passed | `.context/graphics-array-save-memory-boundary.log` |

Three new host regressions fail against unchanged production before the
new tags are recognized (`.context/graphics-array-save-baseline-host.log`).
New host checks also cover index-first buffers with separate ARRAY views,
failed native restoration/retry, context retirement, zero captures and
prevalidated malformed records. Three new native C cases cover balanced
capture/end on normal draws, staging allocation failure and zero-count
draws, plus vertex-first and index-first rendered trace scenarios.

Twelve new browser executions replay those actual C staging streams
through native worker imports and main forwarding in all three engines.
The adapter explicitly injects a renderer peer's deletion/reuse of buffer
17 after the temporary upload bind. The old buffer has no VAO reference
at that point: its saved ARRAY pin alone preserves it. The first draw is
green; an attribute captured from the restored old ARRAY then draws red,
not the replacement's blue. Both initial native buffer classifications
pass, and all tracked buffers, VAOs, textures, FBOs and renderbuffers are
retired at final teardown. Program setup and peer injection are renderer
fixture operations. This is real WebGL rendering of actual C bytes with a
synthetic kernel adapter, not public EGL sharing or Rust guest marshalling.

Image alias/storage/sampler references and program/link/query metadata
remain prerequisites for public C sharing. Abruptly interrupted staging
also needs private temporary-name ownership/cleanup in a future shared C
group; current successful and allocation-failure cleanup do not establish
that broader lifecycle contract. Indeterminate submit/context-loss
propagation remains in G09/E02. The failed native restore test proves a
retained pin and explicit renderer retry, not complete C recovery from an
indeterminate submission. These ordinary gaps remain required work.

No normal SDK/program/package/image artifact was rebuilt or restamped.
Kernel compilation was limited to ABI export inspection; other builds
were source-host declarations and private test objects. Standalone resolver ABI 58 results remain historical from
`5985c3c727`; no epoch change requires regeneration here. Normal artifacts,
guest CTS, cage/sway, full browser-memory and POSIX/conformance remain
deferred until implementation is ready. The complete goal stays active.


## Authoritative uniform values without C caches (2026-10-24)

The former C cache defaulted to one value unless an application had
previously enumerated a uniform's type. It also matched truncated names,
shared one record across array elements and survived relinking. A plain
vec4 getter could therefore leave three values untouched even in one
context. The new native regression reproduces that failure against
unchanged `c0d87638be` before the implementation:
`.context/graphics-uniform-baseline-native.log`.

`glGetUniformfv` and `glGetUniformiv` now use one renderer reply containing
the actual element width and values. The entire per-context width/name
cache and its reflection-order coupling are removed. The shared host group
already owns program/location associations; the query checks program type,
location ownership and successful link state, then reads the native value
without installing the program. It supports scalar, vector and square
matrix counts 1/2/3/4/9/16, returns one array element, preserves matrix
column order and converts booleans or integer/float results. These rules
follow [GLES 2.0 sections 6.1.2 and 6.1.8](https://registry.khronos.org/OpenGL/specs/es/2.0/es_full_spec_2.0.pdf).

Additive `QOP_GET_UNIFORM_VALUES` (0x001F) takes program, signed location
and a 0/1 integer-result selector in 12 bytes. The fixed 76-byte reply has
status at 0, count at 4, sixteen value words at 8 and completion magic at
72; unused values are zero. Protocol-shape errors reject before writing.
GL errors carry checked failure status and remain in the context's error
queue. C validates status, completion and allowed count before copying
only the returned values. Transport/allocation failure and malformed or
failed replies leave all caller output unchanged. Table version advances
to 7 within ABI 58: existing commands, queries, syscall layouts and imports
are unchanged. INIT admits compatible versions 1 through 7; a regression
explicitly includes 1, 5, 6 and 7 and rejects zero/future tables.

Focused evidence:

| Check | Result | Evidence |
|---|---|---|
| Actual native EGL/GLES C with device double and UBSan | 86 cases passed | `.context/graphics-uniform-final-c-wasm.log` |
| Private wasm32 EGL/GLES objects/link and public entrypoint audit | Passed, 150 guards and 142/142 GLES2 core definitions/resolvers | `.context/graphics-uniform-final-c-wasm.log` |
| Host graphics source and Node/browser declarations | 396 cases in 19 files and declarations passed | `.context/graphics-uniform-stable-host.log` |
| Real Chromium/Firefox/WebKit source rendering | 147 passed, no skips | `.context/graphics-uniform-stable-browser.log` |
| Kernel GLIO, shared GL layouts and ioctl-filter cases | 47, 4 and 18 passed | `.context/graphics-uniform-rust-abi.log` |
| ABI source/snapshot/generated consistency | Passed, ABI 58 / table 7 | `.context/graphics-uniform-rust-abi.log` |
| Browser protocol/memory-boundary negatives | 12 passed | `.context/graphics-uniform-memory-boundary.log` |

Two new native cases check every permitted width without prior reflection,
float/integer destination guards, no-output calls, transport and allocation
failure, GL failure status, invalid counts and missing completion. Ten new
host cases check widths through a sharing peer, conversions, program/type/
location/link rejection, native error capture, shared relink invalidation
and malformed spans. The native device double supplies integer results
explicitly; actual renderer conversion is checked separately.

Six added browser executions construct driver-level shared contexts
through native worker imports and real worker-to-main forwarding. They
read vec4, mat3, mat4, distinct vec3 array elements, bvec4 and scalar values
through a peer without installing its program, then destroy the source and
read again. They render red, provoke a failed link, reject the uniform
query while the previous installed executable still renders red, relink
successfully, reject old locations and read fresh zero-initialized values.
Deletion-pending queries work while the program is current; after release,
queries report INVALID_VALUE. Native textures/FBOs/renderbuffers and every
created shader/program retire at final teardown. A test-instrumentation
wrapper initially dropped createShader's argument; the expanded checks
passed after forwarding its arguments. No engine defect is claimed.
These tests use a synthetic kernel scratch adapter and source host code;
they do not execute public C sharing or Rust guest marshalling.

This removes the C uniform-width metadata prerequisite for sharing. It
does not finish the program/uniform contract: stable repeated location
identity, long names, active-uniform truncation, uniform setters and the
full link/executable error audit remain open. C image alias/storage/sampler
ownership, interrupted staging cleanup, context loss, remaining EGL/GLES/
GBM/KMS requirements and the full normal-artifact/conformance phase remain
required. Normal SDK/program/package/image rebuilds, CTS, compositors,
full browser-memory and POSIX checks stay deferred until implementation
is ready. Kernel compilation here only inspects ABI exports; standalone
resolver ABI 58 checks remain historical from `5985c3c727`. The complete
goal stays active.


## Stable locations and checked uniform names (2026-10-24)

A successful link now owns one public location per canonical active name.
Repeated queries and sharing peers reuse that index, including array base
names and `[0]`. Valid decimal indices normalize leading zeros. Successful
relink or final program deletion invalidates the group's location/name
records; indices remain monotonic and never recycle. Reaching GLint's
positive range reports OUT_OF_MEMORY for a new index while existing
locations still work. Metadata allocation failure rolls back every map
before publication. Program/type/link validation also applies to the
legacy location query without changing its wire. The former test expected
a new index on repeated lookup; it now checks stable live identity and
monotonic replacement. A separate new regression fails unchanged
`3bd2d988ea` (`.context/graphics-uniform-locations-baseline-host.log`).
These rules follow [GLES 2.0 section 2.10.4](https://registry.khronos.org/OpenGL/specs/es/2.0/es_full_spec_2.0.pdf).

The C lookup no longer has a 256-byte input buffer (248 name bytes after
its header). It uses a checked inline request for short names and one
context-owned transfer for larger names. Each message remains within the
existing 64 KiB query limit. BEGIN reserves owned bytes, contiguous CHUNKs
fill them and COMMIT looks up the then-live program. Tokens prevent stale
requests or cancellation from removing newer work; abort is idempotent,
replacement frees old bytes, and context retirement releases pending
storage. No lookup buffer is shared with another context or the guest.
C preallocates request/reply buffers so cancellation needs no allocation
after transport failure; completion/status/token validation precedes
returning a location. A failed abort can leave one context-owned transfer
until replacement or destruction, not a reported successful lookup.

`glGetActiveUniform` now uses checked metadata plus bounded name chunks,
reusing the object-query accumulation path. Caller-selected truncation and
zero-size metadata queries work; negative bufSize reports INVALID_VALUE.
Complete results publish length, size, type and name together. A later
chunk, allocation or GL failure leaves all public outputs unchanged.
The fixture's 70,000-byte name spans multiple replies; no fixed 256-byte
reflection limit remains in C. This is transfer evidence, not evidence
that the renderer accepts a shader identifier that long.

Operation table 8 adds:

| Query | Request | Checked reply |
|---|---|---|
| `QOP_GET_ACTIVE_UNIFORM_INFO` (0x0020) | program, uniform index, byte offset, capacity (16 bytes) | status, total name length, size, type, name bytes/padding, completion marker (`20 + capacity` bytes) |
| `QOP_LOOKUP_UNIFORM` (0x0021) | action, program, token, length/offset, optional bytes (16–65536 bytes) | status, echoed token, signed location, completion marker (16 bytes) |

Lookup actions are INLINE=0, BEGIN=1, CHUNK=2, COMMIT=3 and ABORT=4.
INLINE length equals its following bytes; BEGIN carries total size, CHUNK
its offset, and COMMIT/ABORT use zero. Protocol shape errors reject before
writes; GL errors use the checked failure envelope. Existing tags/layouts,
imports and syscalls remain compatible, so ABI stays 58. INIT accepts
tables 1 through 8; the focused regression includes 1/5/6/7/8 and rejects
zero/future versions. Snapshot/generated outputs remain consistent.

Focused evidence:

| Check | Result | Evidence |
|---|---|---|
| Actual native EGL/GLES C with device double and UBSan | 89 cases passed | `.context/graphics-uniform-reflection-final-c-wasm.log` |
| Private wasm32 EGL/GLES objects/link and entrypoint audit | Passed, 150 guards and 142/142 GLES2 core definitions/resolvers | `.context/graphics-uniform-reflection-final-c-wasm.log` |
| Host graphics source and Node/browser declarations | 405 cases in 19 files and declarations passed | `.context/graphics-uniform-reflection-stable-host.log` |
| Real Chromium/Firefox/WebKit source rendering | 147 passed, no skips | `.context/graphics-uniform-reflection-stable-browser.log` |
| Kernel GLIO, shared GL layouts and ioctl-filter cases | 47, 4 and 18 passed | `.context/graphics-uniform-reflection-rust-abi.log` |
| ABI source/snapshot/generated consistency | Passed, ABI 58 / table 8 | `.context/graphics-uniform-reflection-rust-abi.log` |
| Browser protocol/memory-boundary negatives | 12 passed | `.context/graphics-uniform-reflection-memory-boundary.log` |

The new C lookup and reflection regressions both fail against unchanged
`3bd2d988ea` with the current fixture:
`.context/graphics-uniform-reflection-baseline-native.log`. Three new C
cases cover 249/300/65520/140001-byte lookups, each transfer phase's
transport/status/token/completion failure, failed abort followed by
replacement, allocation failure, long reflection, truncation and output
rollback. The device double supplies lookup success; renderer acceptance
is separate. Nine new host cases cover stable aliases across peers,
chunk assembly, independent pending owners, stale cancellation, program
retirement during transfer, map-allocation rollback, counter exhaustion,
malformed spans, inactive/reserved names and checked reflection.

The six shared-uniform browser executions now also use checked lookups,
verify repeated/base/[0]/peer identity, read an actual 249-character shader
uniform, enumerate reflected names/types/sizes in 17-byte chunks and send
a 70,007-byte inactive name across bounded requests. All prior value,
relink, rendered-pixel and final program/shader cleanup assertions remain.
This is source host rendering through native worker imports and main
forwarding with a synthetic kernel adapter, not public C sharing or Rust
guest ioctl marshalling.

WebGL specifies a 256-character lookup-string and shader-token limit
([WebGL restrictions](https://registry.khronos.org/webgl/specs/latest/1.0/)).
A long root absent from actual reflection is safely inactive and returns
-1 without WebGL-only name errors. Active identifiers/paths exceeding that
limit still need source/name translation and reverse reflection mapping.
The new C transfer protocol alone does not implement that translation.
This remains ordinary required GLES compatibility work, not a demonstrated
impossibility or a reason to lower the baseline. No browser defect is
claimed. Uniform setter/type/count semantics and the remaining program/
link audit also remain open.

Public C sharing still needs coherent image/storage/sampler objects and
bindings. Interrupted staging cleanup, context loss, the remaining EGL/
GLES/GBM/KMS inventory and the normal-artifact/conformance phase remain
required. Normal SDK/program/package/image rebuilds, CTS, cage/sway, full
browser-memory and POSIX checks stay deferred until implementation is
ready. Kernel compilation here only inspected ABI exports; the ABI 58
standalone resolver is unchanged from `5985c3c727`. The full goal is active.
