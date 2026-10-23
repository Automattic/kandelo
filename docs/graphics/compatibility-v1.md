# Graphics compatibility inventory, version 1

This is the implementation and evidence ledger for the GLES 2.0, EGL 1.5,
GBM and single-display legacy DRM/KMS baseline. It is not a conformance
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
| G01 | GLES2 object name creation, binding, deletion; ES2 §§2,6 | Monotonic guest names and per-process WebGL maps; incomplete is/query functions | GLES encoder, registry, query | CTS GLES2 functional state/query/object groups; host object tests | partial; no demonstrated boundary |
| G02 | Context-local full state; ES2 state tables | Cube/2D targets, dither and pixel-store state now replay separately; invalid-state rollback, hints and multi-context/thread ownership still need work | shadow, muxer, decoder | Alternating contexts/processes; real rendered cube/2D and mask tests | open |
| G03 | Buffer allocation/update, indexed and client-array draws; ES2 §2 | Chunked encoder and transient client staging; bound index buffer plus client attributes rejected | GLES encoder, bridge | CTS buffer/vertex/indexed tests; invalid lengths and offsets | partial |
| G04 | Shader source/compile/link, reflection, deletion; ES2 §2 | Shader/program forwarding exists; deletion/reference state and several queries incomplete | encoder, query, registry | CTS shader API and reflection; delete attached/current objects | partial |
| G05 | Uniform scalar/vector/matrix and arrays; ES2 §2 | Metadata-based result widths; query truncation and link invalidation need audit | encoder, query | CTS uniform API/state queries; hostile reply sizes | partial |
| G06 | Texture formats, cube maps, pixel storage, subimages and copy; ES2 §3 | WebGL2 normalization exists; complete target/state/error audit missing | encoder, bridge, muxer | CTS texture specification/negative/cube groups; rendered pixels | partial |
| G07 | Raster/depth/stencil/blend/clear/readback; ES2 §§3,4 | Main provides offscreen color/depth/stencil; no broad CTS evidence | bridge, query, present-target | CTS functional render families; real pixels all three engines | partial |
| G08 | FBO attachments/completeness and renderbuffers; ES2 §4 | FBO redirection exists; imported renderbuffer siblings absent on main | encoder, registry, presentation | CTS FBO and attachment queries; deletion/reallocation | partial |
| G09 | Ordered errors and non-mutating invalid calls; ES2 §2.5 | Some guest paths silently return; missing-name host calls may resolve to null | encoder, decoder, query | CTS negative API; malformed TLV/span/enum tests | open |
| G10 | Every core function resolves; ES2 API | Handwritten eglGetProcAddress list incomplete; old branch generates declarations | capability manifest, EGL resolver | Enumerate core header symbols, link and call; version-gated extensions | open |
| E01 | EGL1.5 display initialization/config selection/queries; EGL §§3.2–3.4 | Single config ignores selection attributes; missing eglGetConfigs; advertised 1.5 | EGL library, surface metadata | CTS query_config/choose_config/negative API | open |
| E02 | EGL current-thread API/context/surface lifecycle; EGL §§3.5–3.7 | Fixed handles, no actual current tracking, no sharing/multiple contexts | EGL, GLIO, registry, encoder | CTS query_context/multi_context/thread_cleanup; destroy-current and stale handles | open |
| E03 | Pbuffers, window/pixmap platform entry points and queries; EGL §3.5 | Pbuffer always fails; several core symbols absent; GBM sizing exists | EGL, host drawable/GLIO metadata | CTS create/query surface and resize | open |
| E04 | Surfaceless make-current and framebuffer errors; KHR_surfaceless_context | Main requires a live surface; cage adds a path needing validation | EGL, host query/decoder | CTS surfaceless_context plus zero-FBO operations | open |
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
| H02 | Synchronous query ordering and main forwarding parity | Main forward channel has no query callback; old branch adds exact bounded forwarding | worker protocols, query, main-forward | Node contract tests and rendered browser forwarded/direct comparison | open |
| H03 | Process/worker/machine cleanup and resource retirement | Main authoritative final BO destruction; preserve its recent memory and exec fixes | kernel and shared lifecycle, registries, muxer | fork/spawn/exec/close/death/crash; browser-memory repeated cycles including KMS consumers | partial |
| A01 | ABI and generated declarations match combined implementation | Both branches independently used 51; old branch 44 is stale | shared ABI, snapshots, generated C/TS, package closure | ABI checker, generation diffs, normal SourceOnly rebuild | open |
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

## Implementation evidence

No candidate validation recorded yet. Baseline provisioning started with
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
combined contract uses ABI 52 and fork record version 20. Main's cursor
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
