# Graphics compatibility inventory, version 1

This is the implementation and evidence ledger for the GLES 2.0, EGL 1.5,
GBM and single-display legacy DRM/KMS baseline. Userspace graphics uses
the normal wasm32 and wasm64 SDKs; compositor packages currently build for
wasm32. Node/browser host parity is required. Kernel DRM pointer-marshalling
tests retain both guest address widths. It is not a conformance
claim. An ordinary defect remains open until implementation and executable
validation cover it; a passing demo does not close an API family.

## Landing scope

On 2026-10-29 the user split delivery into the bounded cage/sway landing
in [PR #1574](https://github.com/Automattic/kandelo/pull/1574) and a
follow-up for the remaining graphics baseline. The landing runtime cut is
`21f3d451bb`; its contract, executable acceptance and pending evidence are
in [Cage and sway landing](cage-sway-landing.md). This changes delivery
scope, not the API inventory or its completion standard. All incomplete
rows below remain open or partial.

The follow-up branch `brandonpayton/graphics-baseline-follow-up` preserves
`65b498d284`, including the later expanded upstream EGL query harness
(`ed1856dbb4`) and context-local GLES hint implementation (`65b498d284`).
[Follow-up PR #1594](https://github.com/Automattic/kandelo/pull/1594) is
stacked on #1574. Neither increment is part of the landing runtime cut.
Remaining baseline implementation and broad conformance belong to that
follow-up; no missing API is reclassified as a platform boundary.

## Unpublished ABI policy

Use one ABI above current main for the combined effort, as requested by
the user on 2026-10-24. Main `e4bca8639e4b` uses program ABI 55 and kernel-host version 2. The
combined source uses **program ABI 56 and kernel-host version 3**, preserving
main's program-only contract digest and exact host/kernel version check.
Keep these numbers across increments
and regenerate outputs when their inputs change. Rebuild normal artifacts
from the final coherent source before relying on them. Earlier ABI 52-59
references below record unpublished development history, not released
artifact sets or compatibility promises between those source revisions.

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

## Current completion checkpoints, 2026-10-29

The cage/sway landing integrates main `e4bca8639e4b` via
`30dfe6bb0d`; `85c56d342d` additionally restages verified port sources. The unpublished program ABI remains 56, now declared in
main's program-ABI crate, with host 3 / GL table 17 / fork record 21.
Earlier generated-output and focused ABI/Rust/host checks remain recorded
at their exact sources. The resumed full xtask suite passes at
`ba845edaf4`, including all 811 unit cases and later integration targets.
Combined-main normal builds and acceptance are running and remain pending.

Prior candidate `9088f31021` passed normal product/freshness/closure/ABI
checks, Freeciv and the complete three-engine browser-memory gate. Its
Node selection passed 23/25 with two unexplained Sway timeouts; browser
acceptance passed 13/15 with two Sway prompt-observation failures. The
Cage idle repair passed all engines. A stronger Sway exit observation is
prepared, and a fresh-artifact traced diagnostic passed all three Node
Sway cases, without clearing the earlier failed combined selection.
Exact source and artifact evidence is recorded below and in the bounded
[cage/sway landing contract](cage-sway-landing.md).

The broader graphics follow-up remains incomplete. Pinned libc/POSIX/
Sortix at `d081e6d453` completed with zero unexpected failures, and
focused later GLES increments have dual-width Node/three-engine evidence.
Those results do not establish full combined conformance. Ordinary work
remains in server waits, GL-source/forwarded images, GLES/EGL state,
errors, rollback, context loss and the other inventory gaps. The enabled
upstream CTS subset does not establish broad conformance.

## Inventory

Status: **open** = implementation or validation incomplete;
**partial** = existing implementation with named gaps; **verified** = named
checks run on this tree. Evidence must include engine/host, artifact identity,
command and result before a row becomes verified. A boundary needs an actual
reproduction and correct observable failure; none is inferred from a stub.

| ID | Required behavior / source | Current implementation and known failure | Owner / dependencies | Executable validation | Status / boundary |
|---|---|---|---|---|---|
| G01 | GLES2 object name creation, binding, deletion; ES2 §§2,6 | Reference-counted C name owner reserves buffer/texture/renderbuffer names, including implicit binds; shared shader/program allocation is serialized. Checked buffer/texture/RBO binding and buffer/texture/RBO/FBO deletion preserve C ownership on definite rejection. Public C groups join the native owner; dispatch serialization spans standard name lookup/mutation/publication. Raw WPK publication shares that scope, skips native names and retries C reservations. GPU raw views retain independent object identities; BO revocation retries definite failures. Known unpublished C candidates retain one group cleanup slot and gate name/object queries until checked retirement; general indeterminate reconciliation and full query/error coverage remain open | GLES encoder, registry, query | CTS GLES2 functional state/query/object groups; host object tests | partial; no demonstrated boundary |
| G02 | Context-local full state; ES2 state tables | Client state is context-owned; host groups separate shared names from local state/containers. Deleted image/buffer names retain binding/container references and program lifetime spans current owners. C attribute/index state belongs to each VAO. Multiple public contexts have focused native/source-browser coverage; full rollback, hints and CTS remain open | EGL, encoder, object groups, shadow, muxer, decoder | Alternating contexts/processes; real shared-object/deletion/viewport rendering; native thread-transfer/isolation | partial |
| G03 | Buffer allocation/update, indexed and client-array draws; ES2 §2 | Native buffer realization now occurs on first bind; delayed reservations cannot reject or replace a peer object. Per-VAO mirrors, retained deleted buffers and coherent native vertex/index views. Fixed-point/wide-stride host views and bounded packed client staging are implemented. Maximum byte/short indices use native promotion. Bound index buffers plus client attributes use a bounded presence query; core buffer/vertex queries preserve logical state. Client staging now retains/restores actual ARRAY identity across peer deletion/reuse (operation table 6). Checked buffer binds preserve C pointer interpretation on definite rejection. Buffer deletion also waits for native acceptance; standard name-based buffer transactions serialize across peers; native binding/copy-view restoration retains failed inverses and candidate cleanup. Vertex pointer metadata/native inverses and query/muxer-driven client-array completion now have focused failure evidence. Full size/limit/negative/guest coverage remains open | GLES encoder, bridge | CTS buffer/vertex/indexed tests; invalid lengths and offsets | partial |
| G04 | Shader source/compile/link, reflection, deletion; ES2 §2 | Deleted current objects retain references; shader/program names share a namespace; latest link state is separate from the current executable. Core attribute/source/attachment reflection, acknowledged large-source uploads and validation entrypoints are implemented; complete executable/attribute/uniform validation still needs work | encoder, query, registry | CTS shader API and reflection; delete attached/current objects; rendered alternating owners and relinking | partial |
| G05 | Uniform scalar/vector/matrix and arrays; ES2 §2 | Checked renderer replies now supply complete element widths/values without C reflection caches and preserve failed-query outputs. Shared-peer/source-retirement/relink cases have focused evidence. Locations now remain stable across repeated/array-alias lookups, and checked chunked C lookup/reflection removes fixed buffers. Shader-name translation beyond WebGL limits and complete setter/type/array validation remain open | encoder, query | CTS uniform API/state queries; hostile reply sizes | partial |
| G06 | Texture formats, cube maps, pixel storage, subimages and copy; ES2 §3 | Texture reservations now remain separate from native realization, including delayed shared declarations. C bindings/attachments retain typed object records, acknowledged binds publish references/dimensionality after renderer acceptance, logical image views separate per-object sampling state from canonical GPU pixels, and texture-unit storage follows the reported limit. WebGL2 normalization, core parameter queries and context-owned default texture objects are implemented in host source; complete target/state/error and guest CTS audit remain open | encoder, bridge, muxer | CTS texture specification/negative/cube groups; rendered pixels | partial |
| G07 | Raster/depth/stencil/blend/clear/readback; ES2 §§3,4 | Main provides offscreen color/depth/stencil; no broad CTS evidence | bridge, query, present-target | CTS functional render families; real pixels all three engines | partial |
| G08 | FBO attachments/completeness and renderbuffers; ES2 §4 | Default/user identities and read/draw state remain distinct; C and host attachment records retain deleted texture/RBO identities, including unbound containers; host records also retain native storage and separate packed depth/stencil points. Core attachment/renderbuffer queries, acknowledged C attachment/deletion and texture/RBO allocation are implemented. Metadata capacity precedes native effects; definite failures preserve ownership. Failed deletion/selector inverses are retained per physical context and block dependent work until restored. Image utility/retarget/orphan rollback now retains native inverse plans across peer ownership and pending candidate/retired-view cleanup. Owned surface storage now reserves candidate/retirement receipts and selector inverses before allocation and retains failed cleanup after creator retirement. Other rollback sites, full negative coverage and CTS remain open | encoder, registry, image references, presentation | CTS FBO and attachment queries; deletion/reallocation | partial |
| G09 | Ordered errors and non-mutating invalid calls; ES2 §2.5 | Native pending errors now remain with the outgoing session across switches/invalidation; queries merge duplicate native/retained flags. Definite C buffer/texture/RBO bind rejection preserves prior references. Native buffer/image deletion and FBO selector/container rollback now retain failed inverses, block dependent queries/batches and repair before muxer switching. Buffer binding/copy-view, vertex pointer and image utility/retarget recovery retain failed inverses and cleanup receipts; private ARRAY completion reconciles before query/muxer use. Raw upload and BO revocation retain failed utility/attachment/unit inverses through owner retirement. Indeterminate transport and other recovery sites remain open. Full C/native error validation remains open; some guest paths silently return and missing-name host calls may resolve to null | encoder, decoder, query | CTS negative API; malformed TLV/span/enum tests | partial |
| G10 | Every core function resolves; ES2 API | All 142 GLES2 core symbols are defined and resolved; native/private-Wasm audit passes. Full semantic and guest conformance remain pending | capability manifest, EGL resolver | Enumerate core header symbols, link and call; version-gated extensions | partial |
| E01 | EGL1.5 display initialization/config selection/queries; EGL §§3.2–3.4 | Two RGBA8 configs describe ABGR8888/ARGB8888 windows; one shared attribute table drives enumeration, matching and queries; config operations validate initialization, handles and errors. Full display/config lifecycle and CTS validation remain pending; advertised 1.5 unchanged | EGL library, surface metadata | CTS query_config/choose_config/negative API | partial |
| E02 | EGL current-thread API/context/surface lifecycle; EGL §§3.5–3.7 | Error/API/current binding are thread-local; kernel-authoritative TID ownership, acknowledged replacement, release/exit, unique C handles, context-owned encoder and deferred destruction implemented for one context/surface per backend session. ABI 56 separates revocable display-generation roots from object sessions. C generation records retain old current descriptors, mappings, encoders and imported images while a new generation initializes. Host surface records retain native draw/read targets across context destruction and owner retirement. Fresh surface IDs and acknowledged dimensions belong to the same unpublished epoch. Kernel/host cross-session draw/read selection validates process, live generation and TID, with canonical surface storage retained after owner retirement. Creation/bind failure preserves prior state. Public independent context/surface records route separate draw/read selectors. Kernel/renderer construction joins live same-generation object groups; public C construction joins the same retained owner and native group; the full error/lifecycle audit remains open | EGL, GLIO, registry, encoder | CTS query_context/multi_context/thread_cleanup; destroy-current and stale handles | partial |
| E03 | Pbuffers, window/pixmap platform entry points and queries; EGL §3.5 | Public window queries expose accepted dimensions and fixed attributes. Operation table 16 adds immutable renderer limits before context creation, cached per display generation without changing current ownership. Pbuffer creation, zero logical dimensions, stored query attributes and no-post swaps are implemented in source; native/forwarded storage setup and retirement retain failed cleanup. Largest requests honor limits and search definite allocation failures. Legacy/core/EXT GBM windows match their config native visual; CPU fronts pack the accepted byte order. Live format/usage validation, surface setters and configuration-specific texture/pixmap/client-buffer failures are implemented in source. Requested render-buffer/colorspace attributes are retained. Broader lifecycle/negative coverage and normal guest CTS remain open | EGL, host drawable/GLIO metadata | CTS create/query surface and resize | partial |
| E04 | Surfaceless make-current and framebuffer errors; KHR_surfaceless_context / OES_surfaceless_context | Explicit kernel/host bind, initial zero viewport/scissor, undefined framebuffer-zero status and native operation errors implemented; user FBOs remain usable. Real source-browser checks pass; guest CTS/current artifacts remain pending | EGL, host query/decoder | CTS surfaceless_context plus zero-FBO operations | partial |
| E05 | EGLImage identity, source/target lifetime; KHR_image_base | GPU image/FBO holds retain GEM backing; separate private source handles and logical native views preserve object state and storage identity. Confirmed C holds belong to retained shared object records with revision-ordered publication; uncertain import/attachment candidates belong to the shared group. Raw GPU views use the same independent storage model; BO retirement tracks every retained raw generation and retries native cleanup. CPU layout mirrors now retain mapped/native siblings with changed-byte publication and retryable readback/writeback; four-format normal guest evidence is recorded below. Forwarded BO registration and complete lifecycle validation remain open | EGL, GLES object/storage model, kernel BO references | Producer handles closed, destroy image, surviving texture/renderbuffer; varied order | partial |
| E06 | Respecification orphans sibling without altering others; OES_EGL_image | GPU view replacement preserves sibling parameters and canonical pixels, retargets logical FBOs and handles definite rejection before C backing release. C retains backing by object identity and rejects stale association completions. Raw GPU respecification and refresh preserve private canonical storage and independent parameters. CPU native mirrors retain distinct layout identities and backing storage; full CPU respecification, multi-failure recovery and guest CTS remain open | GLES storage model, host object/attachment tracking | Redefine imported texture, sample both siblings, retained FBO | partial |
| E07 | dma-buf validation, multiple import and format/modifier enumeration; EXT import | Core EGLAttrib and KHR EGLint image creation share retained dma-buf storage and destruction. Parsing rejects wide aliases, missing mandatory fields and malformed modifier pairs before import, validates preservation and hint values, and ignores valid YUV hints for supported RGB formats. The explicit CPU import request validates dimensions, format, pitch, offset and backing bounds before publication; normal four-format mapped/native checks pass. Full negative/rollback coverage remains open | EGL, PRIME, GBM | CPU/GPU imports, bad fd/stride/offset/modifier; repeated import lifetime | open |
| E08 | EGL1.5 sync, waits, core images, thread release and errors | Core image symbols resolve for retained dma-buf imports. Native fence candidates, waiter leases and retryable cleanup now have retained source models. Table 17 adds caller-known create/status/release tokens, accepted-reply publication, cancellation and mapped object-session authority without a current context. Native and forwarded source rendering pass. Core C create/destroy/query/client-wait now use generation-owned records, retained sessions, serialized replies, monotonic timeouts and cancellation-safe waiter references; public glFlush requests acknowledged native flush. Focused C and three-engine source evidence is recorded below. The four KHR_fence_sync aliases share these records with width-correct lists/output and 64-bit timeouts; EGL_KHR_fence_sync and client GL_OES_EGL_sync are declared. eglWaitSync server ordering remains open; EGL_KHR_wait_sync is not advertised. GL-source images and full lifecycle/errors/guest validation remain open | EGL, ordered submits, host completion | CTS sync/negative API and getProcAddress | open |
| B01 | GBM allocation/import/export and plane metadata | Dumb/GPU tiers and modifier admission use checked metadata; borrowed surface leases preserve old GPU storage after public retirement/ID reuse. Explicit CPU layout mirrors retain native/mapped siblings. Distinct GBM wrappers over one duplicated/transferred DRM file now share GEM-name lifetime while retaining separate private descriptors; focused both-width/three-engine guests pass. Full negative/lifecycle and combined validation remain open | GBM, DRM BOs, host registry | SDK guest fixtures both widths; unsupported format/flags | partial |
| B02 | GBM map/unmap coherence and authority | Kernel-owned mapping BO references and live-parent fork/vfork inheritance; independent host aliases by process/address with post-clone priming, changed-run publication, and successful frozen-retry/kernel-wait visibility boundaries. Partial munmap trims/splits retain canonical offsets and references across fork, including anonymous reuse of the hole; focused both-width Node/browser checks pass. Fixed anonymous/private-file and new device replacement retire only affected intervals; DRI/PRIME admission flushes old aliases before same-BO population, with allocator/reference rollback on rejection. Both-width Node/three-engine guest evidence is recorded below. Device mremap shrink/no-op retain backing; growth has Linux GEM EFAULT behavior. Broader remap flags/partial-file coverage, cleanup/failure and final combined conformance remain open | GBM, kernel maps, DRI registry | Importer writes, stale readers, unmap/exit/exec; browser pixels | partial |
| B03 | Surface ring lock/release/destroy ownership | Retained EGL leases and a bounded GPU pool publish a top-row-first copy only after accepted swaps, preserving the private render back and locked fronts. Rendered retention/exhaustion/retirement and asymmetric KMS visibility/orientation pass both guest widths in all three engines, through WebGL and 2D scanout. WRITE/LINEAR/CURSOR fronts retain CPU storage with a private GPU render back, with normal both-width/three-engine image and scanout evidence below. Forwarding and broader combined validation remain open | GBM, EGL native windows | Ring exhaustion, invalid/double release, destroy with locks; asymmetric KMS pixels | partial |
| K01 | Single display resources and consistent object IDs | Integrated dynamic mode catalog, properties and device-wide IDs; broader device/host validation pending | kernel dri/kms, host mode metadata | Rust ioctl and Node mode tests; preserve preferred/catalog semantics | partial |
| K02 | Probe all nested outputs before writing | Property, enum and expanded connector outputs now preprobe all destinations; focused Rust regressions pass | syscall nested-output helpers | Valid first/invalid later buffers, unchanged sentinels and top-level bytes | open |
| K03 | Shared OFD GEM/FB authority, PRIME and final references | Shared GEM namespace/allocator, KMS FBs and inherited graphics cleanup/BO holds are implemented; final combined guest validation and remaining KMS-file authority gaps stay open | OFD, process/fork/spawn/exec/close, BO registry | Rust + real Node lifecycle/dup/fork/spawn tests | open |
| K04 | Legacy modeset/flip/vblank/master handoff | Main display owner and cleanup; cage changes automatic master and CLOSEFB | KMS, host scanout | Pending flip drop/exit/crash/master replacement, no stale event/scanout | partial |
| K05 | GPU scanout, CPU fallback and context loss | Device-wide render-node-first resources are independent of master. Selected GPU framebuffers use native blit or owned readback for a 2D/different native display. Focused three-engine rendering passes; complete format views, CPU/GPU coherence and lost-resource reconstruction remain open | host GPU registry/present target/KMS pump | Render imports to scanout; orientation/pixels three engines | partial |
| H01 | Command framing, complete validation and bounded results | Owned bounded submission snapshots make structural validation and dispatch observe the same bytes in native and forwarded paths; one-shot frames restore cached views and discard on purge. Source execution leases retain revoked context owners and owned drawable allocations independently; borrowed GPU allocations also have independent source leases; drain remains synchronous pending per-work drawable selection and server-wait ordering. Kernel query dispatch preprobes nonempty guest destinations, rejects nonzero reserved fields/null inputs, and rejects oversized host replies without copying output. Focused Rust/host source evidence is recorded below; complete guest coverage remains open | bridge, submit queue/drain | Malformed trailing command leaves earlier state untouched; query output sizes | partial |
| H02 | Synchronous query ordering and main forwarding parity | Forwarded queries now use copied input and one bounded reusable mailbox per channel, with timeout retirement; shared native contexts use the same muxer model | worker protocols, query, main-forward | Kernel import preflight at both pointer widths; rendered alternating forwarded owners on three engines | partial; full guest and memory-cycle gate pending |
| H03 | Process/worker/machine cleanup and resource retirement | Canonical surface BO holds and image-owned renderer cleanup now survive descriptor inheritance/local close; focused native lifecycle checks pass. Raw BO retirement retains failed native cleanup across final member teardown and blocks affected operations until retry. Combined guest/memory-cycle validation remains pending | kernel and shared lifecycle, registries, muxer | fork/spawn/exec/close/death/crash; browser-memory repeated cycles including KMS consumers | partial |
| A01 | ABI and generated declarations match combined implementation | Main `cb0a8226c965` program ABI 55/kernel-host 2 and graphics development contracts are consolidated under program ABI 56/kernel-host 3. Regeneration and combined validation are in progress; operation table stays 17. Previous ABI 54/55 results remain historical evidence. Normal artifacts and combined consumer/conformance gates remain pending | shared ABI, snapshots, generated C/TS, package closure | ABI checker, generation diffs, normal SourceOnly rebuild | open |
| P01 | Real upstream compositor integration | At d081e6d453, explicitly provisioned CTS and actual cage/sway sessions pass all nine cases across three engines. The older combined consumer run passed Node21/21 and browser110/114; the newest two-config source still needs normal complete products, gallery and browser-memory validation | SDK, package recipes, resolver, VFS | Source builds both declared widths; Node semantics; rendered cage/sway and existing apps | open |

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
Normal graphics guests now use both wasm32 and wasm64 SDKs, including
rendered browser and kernel pointer-marshalling checks. Upstream
compositor packages currently build for wasm32; extending their recipes
and executed package acceptance to wasm64 is a separate packaging
expansion. This does not excuse missing behavior in the existing
userspace graphics API or its wide-pointer marshalling.

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
current combined contract uses program ABI 56, kernel-host version 3 and
fork record version 21. Main's cursor
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


## Shared reservations do not replace realized objects (2026-10-24)

The shared-image trace exposed an earlier namespace hazard. C reserves a
name before its command buffer necessarily reaches the renderer. A peer
can bind that name first. The old texture/renderbuffer generation records
then replaced the namespace's native object with a fresh allocation;
buffers instead reported INVALID_OPERATION. Either result breaks the
reservation/identity model needed for image sharing. Six new host cases
fail against unchanged `602727a276`:
`.context/graphics-reservation-baseline-host.log`.

Buffer, texture and renderbuffer name declarations now perform no native
allocation or namespace mutation. The C owner already reserves names
atomically. Their first accepted Bind operation creates and publishes the
native object. A delayed declaration therefore cannot reset a peer's
storage, reject an already-realized name, or recreate a deleted object.
An unbound reserved image cannot be attached to an FBO. These distinctions
follow [GLES 2.0 sections 2.9, 3.7.13 and 4.4.3](https://registry.khronos.org/OpenGL/specs/es/2.0/es_full_spec_2.0.pdf).

Existing name declarations remain structurally validated, including whole
batch rejection before any earlier command executes. No command/query tag,
wire, import, syscall, ABI snapshot or C API changes. ABI 58 / table 8 are
unchanged: this corrects GLES name semantics, with compatible existing
command records. Framebuffer/VAO naming is a separate remaining audit;
this change covers the three shared-name families above.

Focused evidence:

| Check | Result | Evidence |
|---|---|---|
| Host graphics source and Node/browser declarations | 413 cases in 19 files and declarations passed | `.context/graphics-reservation-stable-host.log` |
| Real Chromium/Firefox/WebKit source rendering | 153 passed, no skips | `.context/graphics-reservation-stable-browser.log` |
| Browser protocol/memory-boundary negatives | 12 passed | `.context/graphics-reservation-memory-boundary.log` |

Eight added host cases cover delayed declarations across sharing peers,
no native realization before bind and invalid attachment of an unrealized
texture/renderbuffer. Sixteen older lifetime fixtures assumed Gen created
a native object; they now perform the required first bind before retaining
an identity or attaching it. Their prior deletion, failed replacement,
retained binding/container and teardown assertions remain. The old duplicate
buffer-declaration test now expects no GL error; a rejected native bind
still preserves the old binding.

Six new browser executions exercise native worker imports and main
forwarding. A peer creates a red texture, green renderbuffer and buffer
bytes 0/1/2/3 before delayed declarations arrive. Another context then
attaches those public names and reads the original red/green pixels. An
index view of the buffer reports maximum 3 and all four index bits. Unused
reservations stay unrealized; declarations after deletion do not recreate
names. Native creation counts are exactly two buffer views, one texture
and one renderbuffer, with complete final deletion/isLive checks. Both
contexts retain zero error status. These are driver-level source paths
with a synthetic kernel adapter, not public C sharing or Rust guest ioctl
marshalling. Existing actual-C trace replay cases also pass in the full
153-case source browser gate.

C/kernel/wire sources are unchanged from `602727a276`. Its 89 native C
cases, private wasm32 link/150 guards/142 core symbols, 47 GLIO plus 4
layout/18 ioctl cases and ABI consistency are historical evidence, not
newly repeated standalone runs in this host batch. No normal artifact was
rebuilt or restamped. Standalone ABI 58 resolver and native Wayland results
remain historical as recorded earlier. Origin/main was fetched again at
`f3cb7041f64b657c1ead57d579ccb61867ecf1cf` (ABI 52), already an ancestor.

The image trace still shows C aliases translating multiple logical names
to one BO texture, conflating sampler state and backing identity. Simply
moving those alias tables into the name owner will not fix it. Retained C
texture/renderbuffer/binding/FBO records and host logical image/storage
views remain required before public sharing. The current C rejection stays.
Shader-name translation, remaining API/error/lifecycle work and the full
normal-artifact/CTS/compositor/browser-memory/POSIX phase remain open and
required; expensive rebuilds and broad guest checks remain deferred until
implementation is ready. The complete goal stays active.


## Retained C texture/renderbuffer records (2026-10-24)

C 2D/cube texture bindings, the renderbuffer binding and framebuffer
attachments now retain explicit name-owner records, as buffer bindings
already did. Namespace ownership and binding/container ownership are
separate. Deletion removes the public name and this encoder's matching
bindings; an inactive FBO keeps the actual old record after numeric reuse.
Replacement, detach, framebuffer destruction and final encoder destruction
release references. Temporary deletion pins protect records while image
and attachment cleanup runs; metadata locks are released before device
calls. Image attachment refresh now matches the retained record instead
of a potentially reused numeric name.

A texture's first bind fixes its dimensionality. A later bind to the wrong
target reports INVALID_OPERATION before changing C bindings or emitting
that bind. This repairs the sequence that previously rejected a native
2D bind of a cube texture but changed the C 2D mirror anyway; deleting the
cube then cleared the unrelated 2D binding. Unknown/unrealized or wrong-type
texture/RBO attachments fail before C metadata publication. Framebuffer
zero remains immutable. These rules follow [GLES 2.0 sections 3.7.13,
4.4 and appendix C](https://registry.khronos.org/OpenGL/specs/es/2.0/es_full_spec_2.0.pdf).

Binding queries for an EGLImage-aliased 2D texture return its logical C
name in integer, float and boolean forms, hiding its private BO carrier.
Ordinary texture/renderbuffer and raw WPK binding queries retain native
authority, including BO-owner revocation. Public WPK BO texture names enter
the C registry after the existing acknowledged bind ioctl; hidden EGLImage
carrier names do not. This preserves direct FBO attachment without a prior
C bind. Checked liveness probes reconcile revoked raw WPK names before
bind/attachment validation, allowing a now-unused name to acquire a new
type. These use existing query and device contracts.

The former fixed 32-unit mirror becomes an initial inline capacity. The
first ActiveTexture queries and caches the renderer's actual combined-unit
limit, validates the selector and grows independent 2D/cube binding records
when needed. Allocation failure preserves the prior selector/bindings, and
teardown releases the expanded allocation and all its references. This
closes the C fixed-unit limitation noted in earlier checkpoints without
lowering the advertised limit.

Focused evidence:

| Check | Result | Evidence |
|---|---|---|
| Actual native EGL/GLES C with device double and UBSan | 96 cases passed | `.context/graphics-image-records-final-c-wasm.log` |
| Private wasm32 EGL/GLES objects/link and entrypoint audit | Passed, 150 guards and 142/142 GLES2 core definitions/resolvers | `.context/graphics-image-records-final-c-wasm.log` |
| Real Chromium/Firefox/WebKit source rendering | 159 passed, no skips | `.context/graphics-image-records-final-browser.log` |
| Browser protocol/memory-boundary negatives | 12 passed | `.context/graphics-image-records-final-memory-boundary.log` |

Three new regressions fail against unchanged `47b9d405a0`:
`.context/graphics-image-records-baseline-native.log`. A bound EGLImage's
query returns the BO carrier instead of name 17; a rejected target bind
followed by deletion clears the wrong 2D binding; and inactive FBOs fail
to retain their C texture/RBO records after deletion. The device double
models native dimensionality and per-session/unit bindings. Its selected
query kind is explicit test state; it does not reconstruct truncated
native stack pointers from the guest-sized wire.

Seven added native cases cover logical query forms, type reuse after
deletion, 100 texture/RBO/inactive-FBO reuse cycles with stable tracked
allocation counts, reported 64-unit growth and rollback, rejected or
allocation-failed attachments preserving prior references, public WPK
texture attachment/type checks and owner revocation, and a rendering trace.
Final teardown returns tracked allocations to zero. These counts
measure C ownership, not GPU memory or browser reservation reclamation.

Six new browser executions replay the actual C rendering trace through
native worker imports and main forwarding. They read red from texture 18,
reject a 2D bind of cube texture 17, delete 17, then upload blue through the
still-correct binding and read blue from the same FBO. Native final texture/
FBO/renderbuffer deletion and error checks pass in all engines. The replay
uses actual C control calls and bytes with a synthetic kernel adapter;
it does not execute Rust guest marshalling or public C sharing. The
additional upload probe observes real pixels after the C upload batch.

The new private C registration helper links the paired EGL/GLES archives;
no host/kernel production or wire source changed. ABI 58 / table 8 remain
unchanged. The 413 host cases and declarations at `47b9d405a0`, and the 47
GLIO, 4 layout/18 ioctl and ABI checks at `602727a276`, remain historical
results for those unchanged sources, not newly repeated gates. No normal
SDK/program/package/image archive was rebuilt or restamped.

These records retain logical identity, not a completed shared image-storage
model. Alias/image references are still encoder-local, and host aliases
still conflate a logical texture's parameters with its BO texture. Public
C sharing remains rejected. Native bind/storage-change acknowledgements,
old-image release after accepted replacement, indeterminate submit/context-loss
handling and coherent CPU/GPU views remain required. FBO/VAO name lifecycle,
shader-name translation, remaining EGL/GLES/GBM/KMS behavior and the normal
artifact/CTS/compositor/browser-memory/POSIX phase also stay open. Expensive
rebuilds and broad guest validation remain deferred until implementation
is ready; the full goal stays active.


## Acknowledged C texture/renderbuffer bindings (2026-10-24)

Public C texture and renderbuffer binds now wait for native acceptance
before replacing their retained binding references. A texture's first
successful renderer bind fixes its C dimensionality; a rejected allocation
leaves the reserved record unrealized, so retrying that name with another
target can succeed. Earlier queued commands flush before the query. All
candidate C references are released on failure, and the prior binding,
image-target selection and first client error remain intact. No metadata
mutex is held across device calls.

The queued and checked host paths share candidate creation and native bind
validation. Namespace bookkeeping is allocated before the physical bind;
a failed reservation or bind releases the candidate and leaves prior native
and shadow state intact. A successful query bind collects retired image
objects whose last binding reference ended. Existing native errors remain
observable. Texture zero continues to use context-owned default textures.

Additive query `QOP_BIND_IMAGE_OBJECT` (`0x22`) takes three u32 words:
kind (texture 1/renderbuffer 2), target and native-resolved name. Its exact
12-byte checked reply contains status, accepted=1 on success and completion
magic. Invalid request/reply spans fail before mutation. The C encoder
checks both the envelope and accepted value. The operation table advances
to 9; existing query/command layouts, syscalls, imports and ABI 58 remain
unchanged, following the additive-table policy in `shared::gl`. This is a
synchronous boundary for each public C image-object bind; no performance
claim is made. It does not establish storage-change acknowledgement.

Focused evidence:

| Check | Result | Evidence |
|---|---|---|
| Actual native EGL/GLES C with device double and UBSan | 99 cases passed | `.context/graphics-bind-ack-expanded-native.log` |
| Private wasm32 EGL/GLES paired link and entrypoint audit | Passed; 150 guards, 142/142 core definitions/resolvers | `.context/graphics-bind-ack-final-c-wasm.log` |
| Host graphics source and Node/browser declarations | 427 cases in 20 files and declarations passed | `.context/graphics-bind-ack-final-host.log` |
| Real Chromium/Firefox/WebKit source rendering | 165 passed, no skips | `.context/graphics-bind-ack-final-browser.log` |
| Browser protocol/memory-boundary negatives | 12 passed | `.context/graphics-bind-ack-memory-boundary.log` |
| Kernel GLIO, shared layouts/ioctl contracts and ABI inspection | 47, 4 and 13 cases passed; ABI 58 / table 9 consistent | `.context/graphics-bind-ack-rust-abi.log` |

Two new C regressions fail unchanged `b1e73185ae`:
`.context/graphics-bind-ack-baseline-native.log`. After a definite native
allocation rejection, the old C target tag prevents a legal cube retry;
binding metadata could also direct later image targeting to the rejected
candidate. Three added cases cover accepted/rejected texture and RBO binds,
request/response allocation, flush and transport failure, malformed checked replies, unchanged
C image selection, legal retry and a rendered trace. Final tracked C
allocations return to zero. Fourteen host cases additionally cover native
candidate/namespace allocation failure, zero binds, queued/query parity,
last-reference collection, pending errors and complete span validation.

Six new browser executions replay actual C bind requests and encoded
uploads through native worker imports and real main forwarding. They
render red into texture 18, inject creation failure for candidate 17,
verify the checked rejection and OUT_OF_MEMORY, then bind 17 as a cube.
After deleting the cube, an upload through the retained 2D binding reads
blue from the original FBO. Final native resource deletion and error checks
pass. Existing C replays also consume the new checked bind requests. The
fixture still supplies synthetic kernel dispatch and identity translation;
it does not execute Rust guest marshalling or public C sharing.

The first host invocation accidentally used the default configuration,
starting unrelated guest-program fixture provisioning. That exact process
and its descendants were stopped; no result from that invocation is used
as validation. The final source gate uses `vitest.graphics.config.ts` and
no guest setup. The deferred normal SDK/program/package/image rebuild and
full guest/CTS/compositor/browser-memory/POSIX phase remains required. The
kernel build for ABI export inspection is separate from normal guest
artifact preparation. No existing artifact was restamped to claim freshness.

Definite bind rejection is now accounted for. A transport failure after
native acceptance can still leave C and renderer state uncertain; context
loss/reconciliation remains required. Shared C image/storage/sampler
ownership, independent host views, storage-change ACK and atomic old-image
release remain the next prerequisites for public C sharing. The other
GLES/EGL/GBM/KMS inventory remains open and the complete goal stays active.


## Logical GPU image storage and native views (2026-10-24)

GPU EGLImage targets now keep separate logical texture/renderbuffer objects
and canonical BO storage. A private source token is obtained through the
existing foreign-BO bind ioctl's additive `IMAGE_SOURCE_TARGET` mode. It
never enters the public GLuint map, so importing a BO cannot replace a
legal texture with the same numeric value as the BO's former carrier ID.
The existing public WPK raw-texture mode remains distinct; its C wrapper
rejects private source mode and non-2D targets before issuing the ioctl.

Checked `QOP_IMAGE_TARGET` (`0x23`, kind/name/source, 12 bytes) imports
storage and returns its current source token. `QOP_IMAGE_SOURCE_STATE`
(`0x24`, kind/name, 8 bytes) reads that token; zero means owned/orphaned
storage. Both use exact 12-byte checked replies. The private mode and
operation table 10 are mirrored in Rust/C/TS and checked together. Existing
ioctl layouts, imports, syscalls, ABI 58 and snapshot stay unchanged under
the additive operation-table policy. Earlier binaries remain valid; normal
new guest artifacts still require the deferred rebuild phase.

The host share group owns native-view records and reverse identity maps.
Each imported texture has its own native sampling view and parameters,
while FBO attachments address canonical source pixels and keep their
logical type/name for queries. TexSubImage/copy updates and framebuffer
writes affect the canonical image. Sampling views refresh from it before
each draw; this establishes visibility without claiming a version-cache
optimization. View copying restores actual active texture, binding, RBO,
and separate read/draw FBO state. No new shared-memory ceiling or guest
address space crosses into a persistent browser realm.

Respecification prepares independent native storage and preserves needed
base pixels and parameters. It retargets all referencing group FBOs and
current bindings before replacing ownership, and restores the old view on
definite rejection. Base image replacement need not copy the overwritten
base; GenerateMipmap and non-base specification preserve its existing
pixels. RBO respecification similarly stages a native RBO. Final name/
binding/container collection frees owned views and utility FBOs, while BO
canonical storage follows its kernel-held lifetime. These rules follow
[OES_EGL_image](https://registry.khronos.org/OpenGL/extensions/OES/OES_EGL_image.txt)
and [KHR_image_base](https://registry.khronos.org/EGL/extensions/KHR/EGL_KHR_image_base.txt).

C no longer substitutes source tokens into GL binds or FBO attachments.
It stages image-hold capacity before import, publishes a hold after checked
acceptance, and releases old backing after the host confirms orphaning.
A rejected imported TexImage allocation stops subsequent row-upload records,
so they cannot accidentally modify the old canonical image. Ambiguous
import replies retain the candidate image until encoder retirement rather
than freeing potentially accepted backing. These holds remain encoder-local;
this is not complete shared C ownership or general context-loss recovery.

Focused evidence:

| Check | Result | Evidence |
|---|---|---|
| Actual native EGL/GLES C with device double and UBSan | 103 cases passed | `.context/graphics-image-views-final-interop-c-wasm.log` |
| Private wasm32 EGL/GLES paired link and entrypoint audit | Passed; 150 guards and 142/142 core definitions/resolvers | `.context/graphics-image-views-final-interop-c-wasm.log` |
| Host graphics source and Node/browser declarations | 434 cases in 21 files and declarations passed | `.context/graphics-image-views-stable-host.log` |
| Real Chromium/Firefox/WebKit source rendering | 168 passed, no skips | `.context/graphics-image-views-stable-browser.log` |
| Browser protocol/memory-boundary negatives | 12 passed | `.context/graphics-image-views-memory-boundary.log` |
| Kernel GLIO, layouts, ioctl contracts and ABI inspection | 47/4/13 passed; ABI 58 / table 10 consistent | `.context/graphics-image-views-stable-rust-abi.log` |
| Runtime registry, reproduction and driver tests | Registry consistent, Chromium reproduction matches, 11 driver cases passed | `.context/graphics-image-views-final-runtime-rust-abi.log`, `.context/graphics-image-views-runtime-driver.log` |

Three new C regressions fail unchanged `d28f208655`:
`.context/graphics-image-views-baseline-native.log`. Texture/RBO allocation
rejection prematurely releases old backing, and an image import is
published without checked acceptance. Four new cases now cover those paths,
retry, candidate holds after ambiguous transport/completion and final
cleanup. The texture case observes zero row-upload records on rejection
and positive uploads on accepted retry. Its allocation counts measure C
heap ownership. The existing RBO attachment fixture now supplies logical
RBO type/name, matching the host representation, and keeps its previous
public-query and retention assertions. Two old host renderer doubles now
provide a valid NO_ERROR result; cleanup assertions remain unchanged.

Seven new host cases check independent source/name namespaces, allocator
failure/exhaustion, unknown/malformed requests, canonical binding/realization
queries, RBO metadata and actual kernel-host private source registration.
Three new rendered executions use real native imports/queries/submission
in Chromium, Firefox and WebKit. They preserve a public texture numbered
`0x60000000`, distinguish sibling min filters, observe shared red/green
texture and RBO writes and sample updated pixels. They then check texture,
mipmap and RBO orphaning, reimport, allocation and FBO-retarget rejection,
name reuse, peer-held old pixels, source-context retirement and complete
native deletion. The driver supplies synthetic kernel scratch/identity
plumbing; it is not public C sharing or Rust guest ioctl marshalling.
The new GPU-source path is native-worker evidence; generic existing
forwarded source cases also pass, but forwarded BO source registration
and CPU canonical views still require implementation and validation.

A Chromium pixel failure reduced to a standalone reproduction without
Kandelo. Copied pixels can survive later TexImage2D respecification on
Playwright Chromium 153.0.8010.12/macOS/new headless; the default headless
shell did not reproduce. Omitting the overwritten base copy fixes the
rendered case. The registered [runtime reproduction](../../tests/runtime-workarounds/CHROMIUM-COPY-TEX-RESPEC/entry.md)
includes a no-copy control; Firefox 155.0 and WebKit 26.6 controls did not
reproduce. Registry browser runs now use the same Chromium channel as the
product gate. No upstream message was sent and no stable-browser fix is
claimed. See the entry for scope, failed reductions and removal criteria.

Normal SDK/program/package/image rebuilds and broad guest CTS, cage/sway,
full browser-memory and POSIX validation remain deferred. The kernel build
here only inspects ABI exports. No stale artifact was restamped. Public C
sharing remains rejected until image holds are shared by retained object
identity and concurrent storage commits are coherent. CPU layout/coherence,
raw WPK namespace/mutability audit, image zero behavior, broader formats,
indeterminate transport or failed restoration/context-loss recovery and the
other EGL/GLES/GBM/KMS inventory remain required. The full goal stays active.


## Bound image identity and accepted revisions (2026-10-24)

Operation table 11 adds `QOP_BOUND_IMAGE_TARGET` (`0x25`, kind/target/
source, 12-byte input) and `QOP_BOUND_IMAGE_STATE` (`0x26`, kind/target,
8-byte input). Their exact 16-byte checked reply contains status, source,
revision and completion marker. These resolve the selected context's
actual logical binding, including an unnamed object retained after a peer
has deleted and reused its public number. The table-10 explicit-name
queries and their 12-byte replies remain valid. ABI 58, ioctl layouts,
imports, syscalls and the structural snapshot stay unchanged.

The host share group owns an unsigned, monotonically increasing revision
for each retained object's accepted image association. Import and orphan
replacement advance it; definite metadata/native-retarget failure restores
the old value. Exhaustion fails with `GL_OUT_OF_MEMORY` before publication
rather than wrapping. Final native-view collection removes the revision.
This is an image-association revision, not a version cache for pixel writes.
It provides ordering information for the upcoming shared C hold commits;
C still uses the table-10 queries and encoder-local holds at this checkpoint.

Six additional host cases cover retained identity versus a reused name,
complete request/reply validation, texture/RBO import and orphan revisions,
metadata/native retarget failure, exhaustion and final collection. The
three-engine GPU driver additionally imports into the retained old binding,
checks its revisions and red pixels, and proves the peer's newly reused
name remains yellow through import and source-context retirement.

Focused validation is recorded in `.context/graphics-bound-image-final-*`:
440 host cases in 21 files plus Node/browser declarations; 103 native C
UBSan cases, private wasm32 paired link and 150/142 authority/core audits;
47 kernel GLIO, four shared GL layout and 13 ioctl-contract cases; ABI 58 /
table 11 consistency. The rendered source suite contains 168 executions
across Chromium, Firefox and WebKit, with no skips. These use source host
code with synthetic kernel scratch plumbing, not rebuilt guest artifacts.
The full compatibility goal and deferred integration gates above remain open.


## Shared quarantine for indeterminate imports (2026-10-24)

C uncertain-import candidates now belong to the shared object group. A
lost transport response or malformed completion can leave a native view
reachable by a peer, so retiring the submitting encoder alone cannot
release its candidate image. Group publication uses the metadata mutex;
final image release runs after that mutex is unlocked and the last encoder
has retired. Confirmed image aliases still need their separate migration
to retained object records; public EGL context sharing remains rejected.

Two actual C regressions create a private shared metadata peer, inject
transport failure and missing completion for texture/RBO image imports,
destroy the public image and retire the submitting encoder. BO close must
wait until the private peer retires. These fail unchanged `e10546f459` at
source encoder retirement and pass with the shared quarantine. The private
peer has no public EGL context record and is retired before its owning
display generation; this is not public C sharing or display-retirement
rendering evidence.

The complete focused native run now passes 105 UBSan cases, private wasm32
paired linking, 150 authority guards and 142/142 core definitions/resolvers:
`.context/graphics-image-quarantine-final-native-v2.log`. Baseline failures
are in `.context/graphics-image-quarantine-baseline-native-v2.log`. The 12
source browser-memory/protocol negatives pass in
`.context/graphics-image-quarantine-memory-boundary.log`; the full memory
and guest integration gates remain deferred. Host/browser/Rust production
code is unchanged from the preceding table-11 checkpoint.


## Acknowledged image mutations and allocation (2026-10-24)

C texture/RBO attachment replacement and texture/RBO/FBO deletion no longer
release old object/image references before native acceptance. Each call
prepares its bookkeeping and inputs, issues a checked query, then publishes
accepted ownership. An attachment with indeterminate completion retains its
candidate object and image with the shared group, while keeping the prior
C attachment. Final group retirement releases those references outside the
metadata mutex. This preserves backing; it is not complete reconciliation
of native/C state after a lost acknowledgement.

`glTexImage2D` now acknowledges allocation before encoding any pixel rows,
including ordinary owned textures and CPU image copies. Rejected allocation
cannot turn later rows into writes to the previous storage. RBO storage
uses the same checked allocation route. Accepted GPU orphaning still uses
the existing source-state query before releasing the old C image hold.
Copy/compressed/mipmap commands retain their existing encoding; this change
does not claim their complete validation or shared C commit ordering.

Operation table 12 adds three exact checked queries, mirrored in Rust/C/TS:

| Query | Input | Reply |
|---|---|---|
| `QOP_IMAGE_OBJECT_DELETE` (`0x27`) | kind/name, 8 bytes; kinds texture/RBO/FBO | 12-byte status/accepted/completion |
| `QOP_IMAGE_ATTACHMENT` (`0x28`) | kind/target/point/object-target/name/level, 24 bytes | Same checked ACK |
| `QOP_IMAGE_STORAGE` (`0x29`) | opcode plus unchanged allocation payload; texture 40 bytes with dataLen zero, RBO 20 bytes | Same checked ACK |

Existing query and command layouts stay valid, as do ABI 58, ioctl structs,
host imports and syscalls. Storage queries execute the actual command
dispatch's validation, format translation and native storage operations;
there is no second storage implementation. Queued and checked attachment/
deletion paths likewise use common transactions. Malformed input/output
spans fail before native mutation or reply publication.

Host attachment changes allocate their complete new container metadata
before the native call. Texture/RBO deletion stages retirement capacity,
affected active attachments and native binding actions before effects.
Definite failure restores attempted native changes in reverse order and
preserves logical names, bindings and container references. Each texture
unit selection is checked before binding, including restoration of the
active unit. FBO deletion checks separate draw/read default replacement
before deleting the native container, retaining the old container on
rejection. Errors from failed restoration remain observable; general
multi-failure/context-loss recovery remains required.

Eight additional native C cases cover definite attachment/deletion failure,
ordinary allocation row suppression, successful retry and uncertain
attachment completion through a private metadata peer's retirement. Six
of the definite-failure regressions fail unchanged `f32a1bb1e9`; the
baseline device double rejects the equivalent queued operations as well.
The uncertain cases inject transport loss, missing completion, a wrong
accepted value and invalid status. Private peers have no public EGL
context record and retire before their owning display generation.

Seventeen new host cases check exact spans/selectors, metadata allocation,
attachment replacement/detach, retirement reservation, partial native
rollback, all affected texture units, separate draw/read defaults, pending
errors, and common queued/query behavior for allocation and ownership.
The GPU browser driver injects actual invalid native enums, checks retained
yellow/red/blue pixels after attachment and deletion rejection, and retries
accepted operations. It additionally checks old pixels after invalid owned
texture/RBO allocation and a successful texture allocation/upload retry.
C trace replay records the new checked operations and validates their
replies through native and forwarded dispatch in all three engines.

Focused source evidence is recorded in
`.context/graphics-image-transactions-storage-final-*`: 113 native C UBSan
cases, private wasm32 paired link, 150 public authority guards and 142/142
core definitions/resolvers; 457 host cases in 22 files plus Node/browser
declarations; 47 kernel GLIO, four shared GL layout and 13 ioctl-contract
cases; ABI 58 / table 12 consistency. The 168 source rendering executions pass across Chromium,
Firefox and WebKit, with no skips, using synthetic kernel scratch/identity
plumbing. The 12 browser-memory/protocol negatives pass in
`.context/graphics-image-transactions-final-memory-boundary.log`.
The six baseline failures are recorded in
`.context/graphics-image-transactions-baseline-native.log` and
`.context/graphics-image-transactions-baseline-owned-native.log`. Full
normal guest artifacts, public C sharing, upstream CTS, compositor,
full browser-memory and POSIX gates remain deferred. Confirmed C image
holds, revision-ordered shared publication, namespace ordering through
concurrent peer deletion/reuse and indeterminate/context-loss reconciliation
remain required before enabling public C sharing.


The C framebuffer-bind mirror is still published before its queued native
bind is acknowledged. Failed framebuffer creation/binding can therefore
leave C container selection stale; that binding transaction is the next
required correction. Confirmed per-object image holds must not be enabled
for public sharing on the strength of attachment/deletion ACKs alone.


## Acknowledged framebuffer container selection (2026-10-24)

The preceding C framebuffer-bind gap is now corrected for checked definite
acceptance/rejection. `glBindFramebuffer` publishes its current container
mirror only after `QOP_BIND_FRAMEBUFFER` (`0x2a`, target/name, exact 8-byte
input and 12-byte checked ACK) accepts. Operation table 13 is mirrored in
Rust/C/TS; existing layouts, ABI 58 and its structural snapshot stay valid.
Lost acknowledgements and context loss still require general reconciliation.

Queued and checked host binds now share realization and rollback. Candidate
namespace capacity and rollback actions precede the bind. Failed creation,
metadata allocation or native selection preserves the prior logical/native
bindings and cleans the unpublished candidate. Selecting framebuffer zero
checks separate EGL draw/read defaults one at a time; second-selector failure
restores both old bindings in reverse order before returning rejection.

A new actual C regression fails unchanged `058adba94a` after a rejected
framebuffer bind: subsequent accepted detachment consults the wrong C
container, keeping old image backing after its last real attachment ends.
The device double rejects the equivalent old queued bind as well. The
current case preserves C selection, releases backing at accepted detach,
accepts a later bind and ends with zero tracked allocations. Five new host
cases cover exact spans/selectors, native creation/bind failure, namespace
allocation, split-default rollback and queued/query parity. An older surface
regression now checks both actual native bindings after rollback and retry,
instead of relying on the order of its last native call.

The GPU browser driver additionally rejects native FBO creation and injects
a real invalid-enum bind, checks preserved blue pixels and accepts retry.
Actual C record traces carry the checked binds through native and forwarded
routes, including separate draw/read default pixels. These remain source
host tests with synthetic kernel dispatch/identity plumbing, not rebuilt
guest marshalling or public C sharing.

Focused evidence: `.context/graphics-fbo-bind-final-host-v2.log` records 462
host cases in 22 files plus Node/browser declarations;
`.context/graphics-fbo-bind-final-native.log` records 114 native C UBSan
cases, private wasm32 paired link, 150 authority guards and 142/142 core
symbols/resolvers. `.context/graphics-fbo-bind-final-rust-abi.log` records
47 GLIO, four GL layout and 13 ioctl-contract cases with ABI 58 / table 13
consistency. `.context/graphics-fbo-bind-final-browser.log` records 168
rendered source executions across Chromium, Firefox and WebKit with no
skips; `.context/graphics-fbo-bind-final-memory-boundary.log` records 12
source protocol/memory-boundary negatives. The baseline failure is in
`.context/graphics-fbo-bind-baseline-native-v2.log`. Full shared C image
holds, revision-ordered publication and concurrent namespace ordering remain
open, alongside the existing full compatibility inventory and deferred
normal artifact/integration gates.


## Confirmed C image storage follows retained objects (2026-10-24)

Confirmed image holds now belong to the shared `wpk_object_name` record,
with its source token and accepted association revision. Namespace,
binding and container references keep that same record alive. Destroying
the public image and submitting encoder therefore cannot release backing
while a named object survives in the group. Per-encoder alias vectors and
per-FBO image/query mirrors are removed; checked host queries supply
binding, attachment and renderbuffer metadata.

C imports and orphan-state reads now consume the existing table-11
implicit-bound queries. An import retains both object and image before
native mutation. Confirmed publication advances only to a newer revision;
an older completion releases its unused candidate rather than replacing
the newer hold. An old owned-storage reply cannot clear a newer import
or permit subsequent pixel rows into that imported image. Indeterminate
imports still quarantine candidate object/image references until final
group retirement. No host protocol or ABI layout changes in this increment:
ABI 58 and operation table 13 remain unchanged.

Final object references unlink dead records under the metadata mutex and
defer image/device release until after unlocking. Replacement similarly
releases old or unused image holds outside the mutex. This permits cleanup
to issue device operations without holding group metadata serialization.

Six new C cases cover texture and renderbuffer ownership. Two destroy the
source encoder with only a private shared metadata peer surviving; both
fail unchanged `4d0961a02a` at premature BO close. Two reenter the group
name allocator from final GEM close, checking that cleanup is outside the
mutex. Two delay an accepted import or owned-state completion until a
newer import has published, check exact image holds, suppress stale texture
rows, then accept a later orphan/retry and verify final cleanup. These are
device-double completion interleavings, not real parallel EGL sharing.
The private peer has no public EGL record and retires before its display
generation. Existing C assertions remain enabled; query fixtures now supply
the host metadata that the removed C mirrors previously answered.

Current focused evidence:

| Check | Result | Evidence |
|---|---|---|
| Native C with UBSan | 120 passed | `.context/graphics-object-images-final-native.log` |
| Private wasm32 paired link and AST audit | Passed; 150 authority guards, 142/142 core definitions/resolvers | Same native log |
| Affected actual-C and logical-image-view source rendering | 66 passed across Chromium/Firefox/WebKit, no skips | `.context/graphics-object-images-final-browser.log` |
| Source protocol/memory-boundary negatives | 12 passed | `.context/graphics-object-images-final-memory-boundary.log` |
| Namespace-lifetime regression baseline | Both cases fail unchanged `4d0961a02a` | `.context/graphics-object-images-baseline-native.log` |

Browser C trace replay validates the new implicit-bound source/revision
replies through native and forwarded dispatch. Source rendering still uses
synthetic kernel scratch/identity plumbing. The 462 host cases and
Node/browser declarations, full 168-execution source browser suite, and
47/4/13 Rust/ABI results in the preceding checkpoint remain historical
unchanged-host/kernel evidence; they were not rerun for this C-only
production migration. Normal SDK/package/program/image builds, upstream
CTS, compositor consumers, full browser-memory and POSIX gates remain
deferred. Public C sharing is still rejected: concurrent C/native name
ordering through peer deletion/reuse, buffer mutation acknowledgement and
indeterminate/native-restoration/context-loss reconciliation remain open,
along with CPU canonical coherence and the rest of this inventory.


## Acknowledged buffer binding and client interpretation (2026-10-24)

C previously changed its retained ARRAY/ELEMENT record before queued native
binding. A rejected unbind could make `glVertexAttribPointer` treat a buffer
offset as client memory, or make `glDrawElements` lose its retained index
buffer. A rejected positive bind could cause the inverse mismatch. Both
new native C regressions fail unchanged `332c7977ed` after injecting the
equivalent failure into its old queued path.

Operation table 14 adds `QOP_BIND_BUFFER` (`0x2b`): exact eight-byte
little-endian target/name input and 12-byte checked acceptance reply. C
publishes binding name/object/serial only after positive acceptance. The
host checked and queued paths share candidate creation, native view
classification/synchronization and accepted shadow updates. Namespace,
store and view-map capacity precedes binding. Definite creation, metadata,
bind or transfer failure removes unpublished candidates and restores prior
native selection; retry can realize/synchronize the buffer. Existing record
layouts, ABI 58 and its structural snapshot remain unchanged.

Eleven new host cases cover both targets, zero/rebind, exact request/reply
spans, invalid target, native creation/binding rejection, each metadata
map, failed cross-class synchronization, retry and queued/query parity.
The two C cases check both failed zero and positive binds, subsequent
attribute buffer identity or index-draw/staging behavior, accepted retry
and final zero tracked allocations. These remain definite-failure tests;
concurrent peer namespace ordering and indeterminate restoration are open.

The client-array browser adapter now records and replays synchronous
queries alongside submitted commands, preserving their actual order. The
peer-deletion driver injects after either queued or acknowledged staging
binds, still requiring the deletion to occur and the same rendered pixels.
The native GPU driver additionally rejects buffer creation and injects a
real invalid-enum buffer bind, checks preserved numeric binding and native
bytes for both targets, and accepts retry. Browser tests use source host
paths with synthetic kernel scratch/identity plumbing; they do not execute
normal guest marshalling or public C sharing.

Focused evidence:

| Check | Result | Evidence |
|---|---|---|
| Native C UBSan, private wasm32 paired link and AST audit | 122 passed; 150 authority guards, 142/142 core definitions/resolvers | `.context/graphics-buffer-bind-first-native.log` |
| Host graphics source and Node/browser declarations | 473 cases in 23 files and declarations passed | `.context/graphics-buffer-bind-final-host.log` |
| Real source WebGL | 168 passed across Chromium/Firefox/WebKit, no skips | `.context/graphics-buffer-bind-second-browser.log` |
| Source protocol/memory-boundary negatives | 12 passed | `.context/graphics-buffer-bind-final-memory-boundary.log` |
| Rust GLIO/layout/ioctl and ABI inspection | 47/4/13 passed; ABI 58, operation table 14 consistent | `.context/graphics-buffer-bind-first-rust-abi.log` |
| C regression baseline | Both cases fail unchanged `332c7977ed` | `.context/graphics-buffer-bind-baseline-native.log` |

The first full browser run correctly failed command-only client-array replay,
the peer injection's queued-bind trigger, and the new GPU fixture's initial
buffer-upload packet. The adapters now replay actual checked binds, inject
after either encoding and send valid allocation/subimage packets; the same
pixel, injection, ownership and cleanup assertions pass in the final run.
A mistaken memory-check path failed before running cases; the corrected
canonical source check above passes. No normal SDK/program/package/image
rebuild is claimed.
Buffer deletion acknowledgement, concurrent C/native name ordering,
indeterminate/context-loss reconciliation and the preceding full inventory
remain unfinished. Normal artifact, CTS, compositor, full browser-memory
and POSIX gates remain user-deferred until the implementation phase ends.


## Acknowledged buffer deletion and native VAO rollback (2026-10-24)

C buffer deletion now pins the selected object while native acceptance is
pending, then releases namespace, active ARRAY/ELEMENT and active-VAO
attribute references after a positive reply. Definite rejection leaves
these records and subsequent pointer/index interpretation intact. The new
`QOP_DELETE_BUFFER` (`0x2c`) accepts an exact four-byte name and returns a
12-byte checked acceptance reply. Operation table 15 is mirrored in Rust,
C and TypeScript; prior layouts and ABI 58 remain unchanged.

Queued batched and checked host deletion use one transaction. Copies of
namespace, retired-object and active attribute metadata precede effects.
Native clearing uses a temporary buffer to preserve legal attribute
formats/offsets before deleting its native bindings. Every native setup,
attribute, ARRAY, ELEMENT and temporary-release step is checked. Definite
failure reverses all attempted steps, including the failing one, restoring
original normal/converted vertex views and the separate native index view.
Only complete acceptance publishes metadata. Final native storage collection
still respects inactive VAOs, peer bindings and saved client-array pins.

Both new C cases fail unchanged `3fc319e85f` after equivalent queued native
delete rejection. They prove attribute-buffer identity or retained-index
interpretation survives, then accept retry, use client indices after
accepted deletion, and finish with zero tracked allocations. Twelve host
cases cover ordinary/converted views, temporary allocation, partial pointer,
late ELEMENT and temporary-delete failure, a pointer wrapper that mutates
before reporting failure, metadata allocation, batched duplicates and exact
query spans/absent names. Existing shared-retirement cases remain enabled.

The GPU source driver renders green using two attributes and an index in
one logical buffer with separate native vertex/index views. It rejects
temporary allocation and injects real invalid-enum pointer, late ELEMENT
and temporary-release failures. Each rejection preserves green rendering.
Accepted deletion clears both native attributes and ARRAY/ELEMENT bindings;
reusing the public number for fresh blue data renders blue. Actual C record
replay carries checked deletion through native and forwarded routes. The
source fixtures still supply synthetic kernel dispatch/identity plumbing.

| Check | Result | Evidence |
|---|---|---|
| Native C UBSan and private wasm32 paired link/audit | 124 passed; 150 authority guards, 142/142 core definitions/resolvers | `.context/graphics-buffer-delete-first-native.log` |
| Host graphics source and Node/browser declarations | 485 cases in 23 files and declarations passed | `.context/graphics-buffer-delete-first-host.log` |
| Real source WebGL | 168 passed across Chromium/Firefox/WebKit, no skips | `.context/graphics-buffer-delete-first-browser.log` |
| Source protocol/memory-boundary negatives | 12 passed | `.context/graphics-buffer-delete-final-memory-boundary.log` |
| Rust GLIO/layout/ioctl and ABI inspection | 47/4/13 passed; ABI 58, operation table 15 consistent | `.context/graphics-buffer-delete-first-rust-abi.log` |
| C baseline | Both cases fail unchanged `3fc319e85f` | `.context/graphics-buffer-delete-baseline-native.log` |

This closes definite buffer-deletion publication/rollback for the tested
paths. Concurrent C/native name ordering through peer deletion/reuse and
multiple-failure/indeterminate/context-loss recovery remain open before
public C sharing. CPU image coherence, forwarded BO-source registration
and the full preceding compatibility inventory remain unfinished. Normal
SDK/program/package/image rebuilds, CTS, compositor consumers, full browser
memory and POSIX validation remain deferred until the implementation phase
is ready; these source results do not establish those contracts.


## Public C object groups and serialized name transactions (2026-10-24)

`eglCreateContext` now accepts a live same-generation source context. It
joins the source's retained C object owner and passes the existing backend
identity through ABI-58 shared construction. Invalid or delete-pending
sources fail with `EGL_BAD_CONTEXT`; failed native creation unwinds the
unpublished encoder/session and preserves the source/current state. Public
handles remain distinct and local bindings/FBOs/VAOs remain context-owned.
This is ordinary shared-context support with the gaps below, not complete
sharing or graphics conformance.

A separate group dispatch mutex now spans standard buffer/texture/RBO
binding/deletion and texture/RBO framebuffer-attachment name lookup,
checked native mutation and C publication. A peer cannot delete/reuse a
public number between retaining its C record and resolving it natively.
The metadata mutex remains outside device IO and final image cleanup;
name reservation remains independently serialized by metadata. Scoped
cleanup releases dispatch ownership on every function return. Cancellation
is disabled while acquiring/owning the transaction, then the caller's
prior cancellation state is restored after unlocking.

Six new C cases cover public source-retirement image lifetime and peer
orphaning for texture/RBO, creation failure/retry and delete-pending source
rejection, shared texture/FBO rendering traces, concurrent name deletion/
reuse, and deferred cancellation. The concurrency fixture pauses a real
binding query, observes the peer's actual mutex attempt and requires that
lock to be busy before permitting native completion. It then requires the
old retained binding to survive deletion of the peer's replacement. The
cancellation variant requires peer progress after transaction release and
thread retirement. This covers ordinary pthread cancellation, not abrupt
worker crash or normal guest fork/exec integration.

For the ordering baseline, unchanged `cfdd9a9c9f` GLES source is paired
with the current EGL shared-construction adapter, because that earlier EGL
facade rejected all public sharing. Both cases fail the busy-lock assertion;
this is an adapted GLES baseline, not an unchanged whole-tree public-sharing
result. `.context/graphics-public-sharing-gate-baseline-native-v2.log`
records both failures. Its first provisioning attempt included overlay
headers without their native fixture projection and did not compile; v2
uses the same EGL/GLES/KHR header projection as the ordinary C runner.

The public rendering trace shares a real ordinary texture between distinct
C contexts/FBOs, checks red then green, destroys the source, checks blue,
then deletes/reuses the number and checks fresh yellow storage. Browser
replay reads the C source backend identity and translates it to native
context or forwarded session identities. Native and forwarded identities
are distinct: the first browser run used a native context ID as a forwarded
session ID and correctly failed those adapters. The corrected adapter
preserves all original independent-context and peer-injection assertions.
Fixtures still supply synthetic kernel dispatch/identity plumbing; this is
not rebuilt guest marshalling or a full CTS result.

The native fixture now keeps accepted image-source revisions with a native
share group rather than a descriptor. A temporary out-of-bounds fixture
source search was found by UBSan and corrected before the final run. The
runner now makes sanitizer diagnostics fatal, so a printed case result
cannot hide a recovered sanitizer error. Current evidence below uses that
fatal setting and contains no sanitizer diagnostics.

Current focused evidence:

| Check | Result | Evidence |
|---|---|---|
| Native C, fatal UBSan | 130 passed, no sanitizer diagnostics | `.context/graphics-public-sharing-final-native.log` |
| Private wasm32 paired link and AST audit | Passed; 150 authority guards, 142/142 core definitions/resolvers | Same native log |
| Real source WebGL | 174 passed across Chromium/Firefox/WebKit, no skips | `.context/graphics-public-sharing-final-browser.log` |
| Source protocol/memory-boundary negatives | 12 passed | `.context/graphics-public-sharing-final-memory-boundary.log` |
| Adapted pre-gate GLES baseline | Both ordering/cancellation cases fail | `.context/graphics-public-sharing-gate-baseline-native-v2.log` |

ABI 58 and operation table 15 are unchanged; host production and Rust code
are unchanged from `cfdd9a9c9f`. Its 485 host cases/Node-browser declarations
and 47/4/13 Rust/ABI results remain historical evidence. Raw WPK public-name
publication/revocation outside this standard dispatch scope, indeterminate
completion, repeated native restoration failure and context-loss/crash
recovery remain ordinary implementation gaps. CPU canonical image coherence,
forwarded BO-source registration, image-zero/layout/format coverage and the
full preceding baseline inventory remain unfinished. Normal combined builds,
CTS, cage/sway, full browser-memory and POSIX gates remain deferred until the
implementation is ready. No hard platform boundary is inferred.

## Raw BO texture namespace, identity and retirement (2026-10-24)

Public `wpkEglBindBoTexture` now owns the shared C dispatch scope across
checked flush, native allocation and C adoption. A failed flush stops
publication. The native allocator skips realized texture names and
exhausts its positive-i32 result range truthfully. C reservations remain
separate: a collision discards only the unpublished native candidate
through the existing checked deletion query and retries with another
name. A reserved or failed ordinary realization is never silently
converted into an external texture. Private image-source registration
stays separate from public-name adoption. Cross-archive scope helpers
change no device ABI or operation-table layout.

GPU raw names now own logical views, independent of the private canonical
BO texture. Parameters and respecification affect the raw object, leaving
canonical pixels intact. Explicit refresh reimports BO pixels into the
same live object. Deleting and reimporting allocates another identity;
peers retain their deleted bindings and FBO attachments until the custom
raw BO owner contract revokes them. These are the same canonical/view
storage helpers used for GPU EGLImage siblings. CPU raw imports still
upload snapshots; this does not complete CPU canonical coherence.

Raw ownership is a shared object-to-BO ledger, including deleted objects
retained by peers. Retirement matches identity rather than the reused
public number, detaches affected FBOs and bindings, and preserves an
unrelated replacement. Native detachments and utility-state restoration
are checked before logical publication. Failed native cleanup keeps the
canonical BO and a retry journal, even after the last context member
retires. Cleanup views retain shared metadata/native/error ownership and
carry no guest memory authority. Submit, query, present and raw binding
retry pending retirement; an affected group fails while its raw views
remain pending. Invalid output pointers and malformed command spans fail
preflight before retirement attempts. Final view/canonical deletion
failures stay reachable for retry. General rollback failure and context
loss are still open; this is no global recovery claim.

Three new C regressions fail unchanged `26c33f2296`: reserved-name
collision, raw publication after rejected flush, and publication outside
the shared dispatch scope. The concurrency fixture observes the peer's
actual mutex attempt while native allocation is paused, with no delay
used as an ordering assertion. Ten new source host cases cover allocator
exhaustion, stale-cache and reused-number identity, metadata/upload
failure, GPU views and parameters, peer-retained generations, rejected
revocation/retry, final member retirement and canonical deletion retry.
The canonical-storage fixture now registers a private source rather than
simulating the superseded direct raw alias.

The GPU browser case samples green canonical pixels, respecifies a raw
view red without changing the BO, refreshes green, and retains an old raw
generation across peer deletion/reimport. BO retirement rejects an actual
native detach twice, preserves query output while pending, then retries.
An invalid query destination is rejected without consuming the second
native fault. Accepted cleanup clears both raw generations while the
ordinary replacement still renders blue. The old raw FBO becomes
incomplete. Existing native and forwarded checks remain enabled. The
first run used fixture revisions changed during execution: two engines
saw an obsolete query constant, and Firefox returned a newly added field
against the earlier expectation. The settled-source rerun is the current
evidence; no assertions were removed.

Current focused evidence:

| Check | Result | Evidence |
|---|---|---|
| Native C, fatal UBSan | 133 passed, no sanitizer diagnostics | `.context/graphics-raw-names-final-native.log` |
| Private wasm32 paired link and AST audit | Passed; 150 authority guards, 142/142 core definitions/resolvers | Same native log |
| Host graphics source and Node/browser declarations | 495 cases in 23 files and declarations passed | `.context/graphics-raw-names-settled-host.log` |
| Real source WebGL | 174 passed across Chromium/Firefox/WebKit, no skips | `.context/graphics-raw-names-final-browser.log` |
| Source protocol/memory-boundary negatives | 12 passed | `.context/graphics-raw-names-final-memory-boundary.log` |
| Unchanged pre-increment C baseline | All three new raw-name cases fail | `.context/graphics-raw-names-baseline-native.log` |

ABI 58 and operation table 15 are unchanged. Rust executable behavior,
wire layouts, generated outputs and exports are unchanged; the earlier
`cfdd9a9c9f` 47/4/13 Rust/ABI evidence remains historical. Only its BO raw
view documentation changed here. No normal SDK/program/package/image
artifacts were refreshed or restamped. Normal combined main integration,
upstream CTS, cage/sway, full browser-memory and POSIX gates remain in the
authorized deferred build/test phase.

The next ownership work is indeterminate transport reconciliation,
multiple restoration failures, context-loss propagation and crash cleanup.
CPU canonical coherence/layout/format coverage, forwarded BO-source
registration, image-zero behavior, remaining GLES/EGL1.5/GBM/KMS APIs and
the complete preceding inventory remain unfinished. Ordinary defects
remain implementation gaps; no hard platform boundary is inferred.

## Retained native selector/container repair (2026-10-24)

Failed native rollback previously discarded its inverse actions after one
attempt. Image deletion could leave a native FBO detached while the
logical attachment still retained the old texture/RBO; buffer deletion
could leave active attributes cleared while C and host ownership stayed
unchanged. A later query, draw or muxer switch could proceed over that
inconsistent state. Reporting the original error alone did not repair it.

Buffer deletion, texture/RBO deletion and framebuffer selection/deletion
now reserve a native inverse journal before mutation. The journal belongs
to the physical WebGL context, spanning independent logical owners and
object groups. It records every attempted inverse, including the failing
step, and retains the plan when any restoration rejects. The next admitted
operation retries restoration before using native state. Dependent calls
within a restoration group require their selector to accept; independent
groups are attempted even when another fails. Queries leave outputs
unchanged while blocked; command batches stop before subsequent records.
Malformed TLV batches reject before trying repair. Kernel query pointer
preflight still precedes native effects. Muxer switching repairs before
its cached-owner shortcut, preserving errors with the original context.
Current/surface preparation, GPU allocation and raw BO revocation also
respect pending repairs. Forwarded submit failures retain an error flag
instead of escaping as an unhandled renderer message exception.

Inverses are typed method/argument records, rather than arbitrary
callbacks. Only native objects, scalars, error flags and context-local
shadow lifetime are retained, with no command buffer, guest memory or
full binding. Attachment inverses snapshot canonical/native identity;
later metadata changes cannot redirect them. These adopted inverses
change local selectors and containers, not shared storage contents.
Owner teardown retires them before deleting local containers, so a later
owner cannot replay a dead framebuffer. Shared peer objects remain live.
This is not a general guarantee for failed deletion during teardown.

Eight new source host cases cover texture/RBO reattachment, FBO selectors,
normal/converted attributes, both muxer cache paths and owner retirement.
Five failure regressions run against unchanged `e47d3766e0` production
sources and fail when the subsequent query returns success over dirty
native state. The isolated baseline copies the new tests, selects those
five cases and leaves all production sources at that commit. Its 46
unselected tests are not counted as passing coverage.

The GPU browser case rejects texture deletion after native FBO detach,
then repeatedly rejects the inverse reattachment with actual invalid-enum
errors. It observes the missing native attachment, unchanged query output,
rejection of a peer query and command batch, and invalid-output preflight
without another repair attempt. Accepted retry restores the original
binding and red pixels, after which ordinary deletion succeeds. Existing
raw BO, native/forwarded replay and sibling assertions remain enabled.

Current focused evidence:

| Check | Result | Evidence |
|---|---|---|
| Host graphics source and Node/browser declarations | 503 cases in 23 files and declarations passed | `.context/graphics-native-repair-fourth-host.log` |
| Real source WebGL | 174 passed across Chromium/Firefox/WebKit, no skips | `.context/graphics-native-repair-first-browser.log` |
| Source protocol/memory-boundary negatives | 12 passed | `.context/graphics-native-repair-memory-boundary.log` |
| Unchanged pre-increment host baseline | All five selected failure regressions fail | `.context/graphics-native-repair-baseline-host.log` |

C production, Rust, wire layout, generated outputs and exports are
unchanged. ABI 58 and operation table 15 remain current. The earlier
`e47d3766e0` 133 C/fatal-UBSan/private-link results and `cfdd9a9c9f`
47/4/13 Rust/ABI results are historical unchanged-source evidence. Source
browser traces do compile selected actual C cases, but this is not a new
full native C run. The first teardown fixture omitted live context IDs
required by shared construction; it correctly failed and was fixed before
the current 503-case run. No assertion was weakened.

This does not complete general recovery. Image import/orphan/retarget
utilities, buffer bind/view/staging and other restoration sites still
need the retained-inverse model or an equivalent content-aware recovery
transaction. Transport completion uncertainty, native context loss and
recreation, failed resource deletion/worker crash, and complete KMS
failure propagation remain ordinary implementation work. CPU coherence,
forwarded BO-source registration, remaining APIs and the full inventory
remain open. Normal combined builds, upstream CTS, cage/sway, full
browser-memory and POSIX gates stay deferred until implementation is
ready. No new artifacts were restamped and no hard boundary is inferred.

## Shared storage recovery and native retirement ownership (2026-10-24)

Image utility work, import/orphan/retarget and buffer binding/copy-view
synchronization now use retained native recovery. Nested repair records
restore copy selectors before the outer buffer binding can finish.
Unpublished buffer candidates remain owned through failed restoration or
cleanup, including an exception while VAO metadata is allocated. They do
not replace accepted logical buffer references or become authoritative
storage while synchronization is incomplete.

Image retargeting stages all peer FBOs and selected native bindings,
checking selectors before dependent attachment/binding calls. A finalizer
restores actual utility selectors on success or failure. Rejected storage
replacement restores its old source/view/revision and retains a shared
inverse until every attempted native change is restored. Its lifetime
spans the submitting context's retirement. Native container retirement
prunes dead attachment targets; utility selector inverses select zero
instead of rebinding retired objects. Surviving peer containers retain
old canonical pixels and can accept a later replacement.

Native ownership receipts are reserved before candidate allocation and
before old-view publication/retirement changes. Their slots receive the
native handles as creation occurs. Successful installation transfers
ownership; rejection/exception retires the candidate. Per-resource
cleanup completion is retained, so one accepted deletion is not repeated
when another resource rejects. Final image collection keeps its receipt
until cleanup completes. Pending cleanup gates admitted GL operations and prevents
canonical GPU BO retirement. Accepted new storage/source/revision remains
committed when only obsolete-view cleanup fails. No opaque mutation is
blindly retried: recovery replays selectors/attachments or idempotent
native deletion, not the original storage operation.

Repair and cleanup records contain typed native handles/scalars and error
ownership, without callbacks or guest bindings. Shared inverses do not
retain an object-group member set. Cleanup can continue after its original
logical owner retires; reused sessions now receive fresh error arrays so
retired cleanup flags cannot migrate into a new context.

Eleven new source host cases cover both buffer targets, nested copy
restoration, VAO allocation failure, texture/RBO peer retargeting after
submitter retirement, image utility restoration with partial candidate
cleanup, accepted storage with rejected old-view cleanup, reservation
failure before native allocation/deletion, and reused-session errors.
Ten selected cases fail unchanged `171972ea64` production sources. The
receipt-capacity case accesses the new ownership map and is excluded from
that baseline. The isolated baseline enables 10 cases; its 39 unselected
cases are not passing coverage. The first baseline attempt omitted the
unchanged scratch-module fixture and did not load the image tests; v2
includes that fixture and records the complete selected failures.

An older bridge fixture rejected every native bind, including rollback,
while expecting queued success. It now permits restoring the old native
object and preserves all original ownership assertions. New persistent
failure cases separately require EIO, unchanged output, pending cleanup
and successful retry. Assertions were not relaxed to admit dirty state.

The GPU browser case partially retargets two peer FBOs away from an
imported BO, rejects the second retarget and all inverse reattachments,
and observes the first changed native attachment. A peer query fails
without modifying its output. Retry restores both red FBOs and the old
source/revision. A subsequent accepted orphan commits owned storage, but
old-view texture deletion rejects. The old BO's retirement waits while
queries remain blocked. Accepted cleanup then retires that canonical BO;
both peers render blue through the owned storage. Existing native and
forwarded C replay, raw BO and sibling assertions remain enabled. These
use synthetic kernel identity/scratch plumbing. Forwarded BO-source
registration remains unimplemented; normal guest validation is deferred.

Current focused evidence:

| Check | Result | Evidence |
|---|---|---|
| Host graphics source and Node/browser declarations | 514 cases in 23 files and declarations passed | `.context/graphics-storage-repair-final-settled-host.log` |
| Real source WebGL | 174 passed across Chromium/Firefox/WebKit, no skips | `.context/graphics-storage-repair-final-browser.log` |
| Source protocol/memory-boundary negatives | 12 passed | `.context/graphics-storage-repair-final-memory-boundary.log` |
| Unchanged pre-increment host baseline | All 10 selected regressions fail; both files load | `.context/graphics-storage-repair-baseline-host-v2.log` |

The first browser run also passed 174 cases. The final run includes the
additional exceptional buffer-candidate guard and fresh error ownership
on session retirement. C production, Rust, wire layouts, generated
outputs and exports are unchanged: ABI 58, operation table 15. The
`e47d3766e0` 133 C/fatal-UBSan/private-link results and `cfdd9a9c9f`
47/4/13 Rust/ABI results remain historical unchanged-source evidence.
Source browser replay compiles selected actual C cases; a complete native
C run was not repeated here.

Converted attribute setup, client-array restoration, other temporary
buffers, raw-upload utility state and general failed resource deletion
still need the full recovery audit. C/transport completion uncertainty,
native context loss/recreation, worker/crash and KMS failure propagation
remain open, along with CPU canonical coherence, forwarded BO sources,
image-zero/formats/layout and the remaining GLES/EGL1.5/GBM/KMS inventory.
Normal current-main integration, coherent SDK/kernel/program/package/
image builds, upstream CTS, cage/sway, full browser-memory and POSIX gates
remain deferred until implementation is ready. No artifact was restamped,
and no ordinary gap is reclassified as a hard boundary.

## Client-array completion, vertex transactions and buffer retirement (2026-10-24)

Private client-array restoration now retains both intent and a native
completion ticket. END requests restoration before ticket allocation, so
reservation failure can be retried on admission. Native repair completes
the ticket without retaining a guest-binding callback. Query/decoder and
muxer admission publish the saved ARRAY identity, release the capture pin
and clear the request before reading or replaying logical state. Muxer
reconciliation precedes its cached-owner shortcut. Failed decoded batches
request restoration for an active capture; another private END is not
required. Zero remains distinct from an absent capture. Retirement cancels
local completion without publishing into another or reused context.

Vertex pointer installation now stages the attribute map, converted-view
maps and candidate view field before native effects. Normal, converted
and zero-buffer pointer changes share retained native inverses and ARRAY
restoration. Core type/index/size/stride preflight uses the actual native
attribute limit; see the [GLES2 pointer reference](https://registry.khronos.org/OpenGL-Refpages/es2.0/xhtml/glVertexAttribPointer.xml).
This does not complete the full GLES argument/error/query audit.
An initially unbound attribute needs a private buffer to restore its
native pointer format. Its ownership is reserved before mutation; native
allocation occurs only if rollback uses that inverse. Accepted cleanup
then clears the private binding, with the pending interval fenced.

Promoted-index draws and buffer-deletion temporaries reserve ownership
before creation and retain failed selector restoration. Recovery does not
repeat an already accepted draw. Converted-cache and final buffer cleanup
retain per-object receipts and share pending child retirement instead of
deleting a native handle twice. Reusing a layout after cleanup completed
on a query creates a fresh native view; a dead cached handle is not reused.
All persistent plans/tickets/cleanup dependencies contain native identity,
scalars and error ownership, without full guest bindings or callbacks.

Fifteen new host cases cover interrupted capture, ticket reservation
failure, zero binding and owner retirement, same/different muxer owners,
normal/converted pointer rollback, initially unbound attributes, metadata
capacity, native limits/core formats, byte/short index restoration,
converted-cache recreation and final cleanup dependencies. The existing
capture-failure case now requires EIO and unchanged output while blocked,
then query-driven completion without another END. Existing deletion
rollback checks now require the dirty private buffer to remain owned
until repair, followed by exact old pointer/resource-count restoration.
These replace assumptions about immediate private cleanup, not ownership
or state assertions.

The native double now independently validates WebGL index/size/type,
buffer liveness and alignment. This keeps its acceptance behavior from
substituting for the renderer's GLES adaptation. Sixteen selected cases
(the 15 additions plus the revised capture case) fail unchanged
`06cbbdab24` production sources. Its 157 unselected cases are not passing
coverage. Baseline sources are a private git archive with only current
selected test files and unchanged support fixtures copied in.

The real GPU case rejects END restoration, verifies EIO and unchanged
output, and completes on a query with the original ARRAY binding and blue
pixels. It then draws once through a promoted index buffer, rejects the
ELEMENT restore, and checks that recovery preserves pixels without
redrawing. A valid converted pointer is partially installed before an
injected native error; pending inverse repair blocks queries. Accepted
repair restores the complete original native pointer vector and blue
pixels; a subsequent fixed-point color attribute renders green.

The first full run passed 173/174: the pointer fixture inspected only its
buffer field and generated inverse failure by invoking the pointer method
with an invalid type. The diagnostic confirmed the valid attempted pointer
was installed before the fault. The settled fixture confirms that native
precondition, observes the entire pointer vector, and generates rejection
with an unrelated invalid native bind while suppressing the inverse
pointer call. It compares every captured field after repair and keeps all
pixel/output assertions. The focused three-engine case passes. No product
workaround or outside-runtime defect claim was introduced.

Current focused evidence:

| Check | Result | Evidence |
|---|---|---|
| Host graphics source and Node/browser declarations | 529 cases in 23 files and declarations passed | `.context/graphics-client-vertex-settled-final-host.log` |
| Real source WebGL | 174 passed across Chromium/Firefox/WebKit, no skips | `.context/graphics-client-vertex-settled-final-browser.log` |
| Source protocol/memory-boundary negatives | 12 passed | `.context/graphics-client-vertex-settled-final-memory-boundary.log` |
| Unchanged pre-increment source baseline | All 16 selected regressions fail; three files load | `.context/graphics-client-vertex-settled-baseline-host.log` |

The final host run includes failure injection for the staged view field,
not only map capacity. The last full browser run includes that production
ordering change. C production, Rust, wire layouts, generated outputs and
exports remain unchanged: ABI 58 and operation table 15. The earlier
`e47d3766e0` 133 C/fatal-UBSan/private-link checks and `cfdd9a9c9f`
47/4/13 Rust/ABI checks remain historical unchanged-source evidence.
Selected C traces are rebuilt for source replay; no complete native C run
or normal guest artifact validation was repeated here.

Raw-upload utility state, other native resource factories/deletion and
complete staging/error validation remain open. C/transport completion
uncertainty, native context loss/recreation, worker/crash and KMS failure
propagation remain ordinary gaps. CPU canonical coherence, forwarded BO
sources, image-zero/layout/formats, remaining GLES semantics, advertised
EGL1.5 APIs and the complete GBM/KMS inventory remain unfinished. Normal
main integration, coherent artifact builds, upstream CTS, cage/sway, full
browser-memory and required POSIX conformance remain in the deferred
build/test phase. No artifacts were restamped or ordinary gaps declared
hard platform boundaries.

## Raw upload utility repair and candidate ownership (2026-10-24)

Raw CPU BO uploads and GPU carrier creation now reserve a native cleanup
receipt before `createTexture`. The receipt captures the handle inside the
creation call, including a returned object accompanied by a native error.
Namespace staging failure removes every partially inserted public/raw map
entry and leaves rejected native deletion owned for later admission. A GPU
import failure also retires its carrier independently of the image helper's
nested candidate. Successful view publication transfers carrier ownership;
the image helper's existing receipt owns obsolete carrier deletion without
repeating an accepted delete.

CPU utility work journals selection of unit zero before querying its actual
binding. A nested plan reserves the old texture and all unpack state before
upload mutations. Typed `pixelStorei` inverses restore row length, alignment,
skip rows and skip pixels independently; the outer finalizer restores the
original active unit. GPU carrier initialization likewise retains its old
active-unit texture binding before initialization. Pending restoration or
candidate cleanup blocks query output and further raw uploads. These physical
utility plans survive retirement of the submitting logical context because
unpack state is not completely reconstructed by muxer replay. Persistent
records retain native handles/scalars, without BO bytes or a guest binding.
Recovery restores utility state and retires resources; it never repeats the
accepted pixel upload.

The stateful CPU double now tracks actual active-unit bindings, native object
liveness and deletion. Eighteen new cases cover seven restoration points,
origin retirement, nested inverse reservation failure, CPU/GPU creation errors,
ownership reservation and three namespace-map failures, GPU carrier restore,
nested image metadata failure and successful GPU ownership transfer. Seventeen
selected regressions fail the unchanged `c76083e495` production source in a
private archive. The file loads; its twenty unselected cases are not baseline
passing coverage. The successful-transfer addition verifies the already-owned
image-helper path together with the new raw receipt.

Two additional browser cases run in each engine. They execute valid CPU
uploads or GPU carrier initialization, inject definite native errors instead
of applying restoration, and require EIO plus unchanged query sentinels. After
repair accepts, candidate deletion remains independently blocked. The tests
then allow deletion, require exactly one accepted candidate delete, compare
the complete saved physical state, and read unchanged blue/red native texture
pixels. The CPU upload count remains one; canonical GPU storage stays live.
The preceding native/forwarded C replay and image/storage tests remain enabled.

Current focused evidence:

| Check | Result | Evidence |
|---|---|---|
| Host graphics source and Node/browser JS/declarations | 547 cases in 23 files and builds passed | `.context/graphics-raw-upload-settled-host.log` |
| Real source WebGL | 180 passed across Chromium/Firefox/WebKit, no skips | `.context/graphics-raw-upload-final-browser.log` |
| Source protocol/memory-boundary negatives | 12 passed | `.context/graphics-raw-upload-final-memory-boundary.log` |
| Unchanged pre-increment source baseline | All 17 selected regressions fail; file loads | `.context/graphics-raw-upload-settled-baseline-host.log` |

Commands, from this worktree under `scripts/dev-shell.sh`:

```sh
cd host
npx vitest run --config vitest.graphics.config.ts
npm run build
cd ../apps/browser-demos
KANDELO_PLAYWRIGHT_PORT=5437 npx playwright test \
  webgl-state-contract.spec.ts --workers=3
node --import tsx/esm --test test/browser-memory-boundary.test.ts
```

The initial targeted host/browser runs passed before the final full runs.
The baseline archive contains unchanged production source from `c76083e495`,
the current raw-upload test file and unchanged supporting fixtures; only its
standalone test config/dependency symlink are supplied externally. No C, Rust,
wire/generated output or ABI change occurs in this increment: ABI 58 and GL
operation table 15 remain. Native C 133/fatal-UBSan/private-link evidence at
`e47d3766e0` and Rust 47/4/13/ABI evidence at `cfdd9a9c9f` are historical,
unchanged-source results. No complete C/Rust rerun is claimed here.

Other native factories/deletion, raw BO revocation rollback, complete staging/
error handling, unpublished C raw-candidate cleanup and general uncertain
transport completion still need work. CPU canonical image coherence, forwarded
BO sources, image-zero/layout/formats, native context loss/recreation, worker/
crash/KMS failure propagation and the remaining GLES/EGL1.5/GBM/KMS inventory
remain ordinary gaps. Current-main integration, coherent normal SDK/kernel/
program/package/image builds, upstream CTS, cage/sway, full browser-memory
and required POSIX conformance remain in the deferred build/test phase. This
increment neither restamps artifacts nor demonstrates a new hard boundary.

## Raw BO revocation retains shared native inverses (2026-10-24)

Raw BO revocation no longer discards failed callback-based rollback. It stages
the retired-name map, peer attachment metadata and affected logical units before
native detachment. Actual native unit bindings are captured in a separate
shared utility transaction with retained active-unit restoration. That phase
must finish before any attachment or sampling binding is detached. Allocation
failure when reserving the subsequent mutation plan therefore leaves all
shared references intact.

The mutation plan retains typed attachment inverses with exact native storage
identity, plus actual sampling views and separate draw/read/active finalizers.
Failed detach, partial native mutation or finalization preserves old logical
names, binding/container references and canonical BO storage. Queries and
subsequent raw imports remain blocked until native restoration accepts. The
existing BO-retirement owner then retries logical revocation and final native
cleanup. Shared repair survives retirement of the submitting context or every
member; retiring a native container removes its inverse target. Persistent
records contain native handles/scalars and error ownership, without callbacks,
logical bindings or guest memories.

Nine new host cases cover attachment/unit inverse failure, failed unit capture
and active restoration, draw/read/active finalization, plan reservation after
capture and before detach, submitting-container retirement, and final-member
retirement. They require unchanged query sentinels and logical references,
restored native identity and selectors, no dead-container replay, and eventual
BO cleanup. All nine fail unchanged `a894455bb1` production source in a private
archive using the current test file and unchanged supporting fixtures. The
file loads; its thirty-seven unselected cases are not passing coverage.

Two additional source-worker browser cases run in each engine. Valid native
detachment occurs before a definite native error, and inverse calls remain
rejected. Both owners' queries return EIO without changing output. Attachment
repair survives destruction of the submitting container, preserving its peer.
After repair, tests require exact native selectors/sampling views and green
shared image pixels. Retrying BO retirement then removes names/attachments,
releases canonical/native views, and teardown requires one delete per created
texture/framebuffer/renderbuffer with zero native liveness. The fixture uses
shared host source directly; it does not replace normal guest marshalling,
compositor, full browser-memory or CTS evidence.

Current focused evidence:

| Check | Result | Evidence |
|---|---|---|
| Host graphics source and Node/browser JS/declarations | 556 cases in 23 files and builds passed | `.context/graphics-revoke-final-host.log` |
| Real source WebGL | 186 passed across Chromium/Firefox/WebKit, no skips | `.context/graphics-revoke-final-browser.log` |
| Source protocol/memory-boundary negatives | 12 passed | `.context/graphics-revoke-final-memory-boundary.log` |
| Unchanged pre-increment source baseline | All 9 selected regressions fail; file loads | `.context/graphics-revoke-baseline-host.log` |

Commands remain the preceding source-gate commands: `vitest.graphics.config.ts`
and `npm run build` from `host`, the complete `webgl-state-contract.spec.ts`
Playwright file with three workers/port 5437, and the source
`browser-memory-boundary.test.ts`, all under `scripts/dev-shell.sh`. The six
new browser checks also pass in isolation. No C, Rust, ABI, wire or generated
output changes occur: ABI 58 / operation table 15 remain. Earlier native C
133/fatal-UBSan/private-link evidence at `e47d3766e0` and Rust 47/4/13/ABI
evidence at `cfdd9a9c9f` remain historical unchanged-source results.

Unpublished C raw-candidate cleanup, other native resource factories/deletion,
the full staging/error audit, uncertain C/transport completion, context
loss/recreation, worker/crash and KMS failure propagation remain ordinary
implementation gaps. CPU canonical coherence/layout/formats, forwarded BO
sources, image-zero behavior and the remaining GLES/EGL1.5/GBM/KMS inventory
remain unfinished. Current-main integration, coherent normal artifacts,
upstream CTS, cage/sway, full browser-memory and required POSIX conformance
remain deferred until the build/test phase. No artifacts were restamped and
no new hard platform boundary is claimed.

## Unpublished C raw texture candidates retain cleanup ownership (2026-10-24)

A production-source reproduction demonstrated that C could forget a confirmed
raw candidate when reservation collision was followed by rejected deletion.
The native object remained a realized 2D texture, so an ordinary cube first bind
of the reserved C number still failed after the driver recovered. The native
device double previously omitted raw target realization; it now tracks group
raw liveness and rejects incompatible binds. Its existing simulated BO-owner
revocation also clears that native liveness. The initial unchanged production
run fails at the subsequent cube bind (`graphics-candidate-repro-native.log`).

The retained C object group now reserves one pending unpublished GLuint slot
at group construction, before raw allocation. Group dispatch permits at most
one such candidate. Candidate deletion stores its name before allocating query
input and clears the slot only on checked acceptance. Native rejection,
allocation failure and unknown reply therefore preserve cleanup ownership.
The next standard name transaction or object-existence query reconciles the
slot under the same dispatch guard; failure stops admission without ordinary
name mutation or another raw allocation. The EGL helper reports BAD_ACCESS
for unresolved cleanup, or BAD_ALLOC for failed C object-record allocation.
Cancellation remains deferred through unlock, and metadata locks stay outside
device I/O. The private guard structure's binary layout is unchanged.

Repeated deletion is safe for this known unpublished name because group
dispatch prevents reuse until reconciliation accepts. The tests cover a reply
lost before deletion and a malformed reply after accepted deletion, then bind
and rebind a fresh cube without another cleanup. This is not a protocol for
general unknown mutations or raw allocation whose returned name was lost.
The pending slot follows the shared group after source-context destruction;
final acknowledged native group teardown already owns candidate cleanup.

Ten C cases cover recovery, persistent bind/delete/raw admission rejection,
blocked existence queries, peer and final-member retirement, query input and C
record allocation, both unknown-completion orders, and rendered cube commands.
Nine fail unchanged `82817f89e9` C production sources; the final-group teardown
case also passes the old implementation. Baseline failures reach mutation,
query admission or missing reconciliation assertions before the new EGL error
assertion. Full focused native C validation passes 143 cases with fatal UBSan,
and private wasm32 EGL/GLES objects pass paired linking, all 150 public encoder
authority guards and 142 core definitions/resolvers.

The source-browser driver now consumes the actual C raw-allocation event by
creating private GPU canonical storage and calling the ordinary host raw import.
It rejects retired-map capacity before logical candidate deletion, checks the
C encoder's later cleanup acceptance, and executes a fresh cube's six face
allocations, attachment and red/green clears. Each engine requires both pixel
results and final native cleanup. This scenario uses native dispatch only;
forwarded BO-source registration remains an ordinary gap. All preceding
native/forwarded source cases remain enabled.

Current focused evidence:

| Check | Result | Evidence |
|---|---|---|
| Native EGL/GLES C | 143 cases passed, fatal UBSan | `.context/graphics-candidate-final-native.log` |
| Private wasm32 link / entrypoint audit | Paired link; 150 authority guards / 142 core definitions and resolvers | same log |
| Host source and Node/browser JS/declarations | 556 cases in 23 files and builds passed | `.context/graphics-candidate-final-host.log` |
| Real source WebGL | 189 passed across Chromium/Firefox/WebKit, no skips | `.context/graphics-candidate-final-browser.log` |
| Source protocol/memory-boundary negatives | 12 passed | `.context/graphics-candidate-final-memory-boundary.log` |
| Unchanged C baseline | 9 selected failures, 1 existing teardown pass | `.context/graphics-candidate-baseline-native.log` |

Native commands run `tests/graphics/run-libc-unit.sh`, the private
`.context/graphics-core-compile.sh` and AST audit under `scripts/dev-shell.sh`;
the baseline runner uses revision argument `82817f89e9` with the ten new cases.
Host/browser/memory commands are the preceding source gates. The native
raw-candidate browser scenario also passes all three engines in isolation.
Initial probe corrections stopped attempting to decode stack query input
through the native heap-pointer shim and distinguished C record allocation
from simultaneous native GL error production. A separate compound-failure
diagnostic (`graphics-candidate-error-probe.log`) confirms that C and native
OUT_OF_MEMORY can be reported from both C and native flags. That
observation alone does not establish nonconformance: GLES2 section 2.5
explicitly permits distributed flag/code pairs and unspecified return order.
See the [primary specification, section
2.5](https://registry.khronos.org/OpenGL/specs/es/2.0/es_full_spec_2.0.pdf).
The initial classification as a required coalescing fix was unsupported and
is corrected here. Full G09 negative/error validation remains open; no new
platform boundary is inferred.

ABI 58, operation table 15, Rust/wire layouts and generated outputs remain
unchanged. Rust 47/4/13/ABI evidence at `cfdd9a9c9f` remains historical; no
Rust rerun, normal SDK/archive/kernel/program/package/image refresh or restamp
is claimed. General unknown transport completion, full error validation,
context loss/recreation, other resource/staging failures, worker/crash and KMS
errors remain open, alongside CPU coherence/layout/formats, forwarded BO
sources, image-zero and the remaining GLES/EGL1.5/GBM/KMS inventory. Current-main
integration, fresh coherent normal artifacts, upstream CTS, cage/sway, full
browser-memory and required POSIX conformance remain in the deferred build/test
phase. No ordinary gap has been declared a hard platform boundary.


## Immutable EGL surface limits before context creation (2026-10-24)

EGL configuration queries previously returned zero pbuffer limits. As a
prerequisite for implementing pbuffer creation, operation table 16 adds
`QOP_SURFACE_CAPABILITIES` (`0x002D`). Its input is empty and its exact
16-byte reply contains width, height, pixels and the completion marker.
The kernel requires an initialized, mapped object session in a live
display generation, preprobes the complete output and does not require
or grant a current context. Other queries retain their existing
current-thread authority. Root, unmapped and revoked sessions fail
before entering the host. A query from another thread preserves the
original thread's current ownership.

Native and main-forwarded paths obtain actual WebGL2 texture and
renderbuffer limits without publishing a logical context, replaying
context state, resizing a canvas or claiming KMS scanout. Both report
the smaller native dimension; maximum pixels is the dimension squared,
bounded by EGLint's representable maximum. Pending outgoing GLES flags
are captured into their existing owner. A failed error capture stops
the query; internal EGL probe errors do not enter a later GLES context.
A malformed request is rejected before native renderer acquisition.
Unavailable/lost renderers, invalid native limits or native errors leave
output unpublished. No new mailbox, shared-memory ceiling or retained
guest memory is introduced.

C validates the completion marker and all three values, then caches
only an accepted complete reply in the display generation. Failed
allocation or transport/malformed replies preserve the caller's output
and leave the cache retryable. Reinitialization gets a fresh cache while
an older generation's current context remains usable. Window config
selection and the ES2 renderable mask remain unchanged. The primary
[EGL 1.5 specification, sections 3.4 and
3.5.2](https://registry.khronos.org/EGL/specs/eglspec.1.5.pdf) describes
these limits and permits the maximum pixel count to be less than the
product of the maximum dimensions. Resource-pressure allocation may
still fail. This change does not implement pbuffer creation or advertise
PBUFFER_BIT; E03 remains open.

Source evidence is based on `3c04b350dd` plus this increment. Every
command below runs through `scripts/dev-shell.sh`:

| Check | Exact evidence |
|---|---|
| Native C and private wasm32 paired link | 148 fatal-UBSan cases and paired link pass, `graphics-surface-limits-settled-native.log` |
| Core entrypoint audit | 150 public authority guards; 142 core definitions/resolvers, `graphics-surface-limits-checked-rust-abi-memory.log` |
| Host source and Node/browser build/declarations | 564 tests in 23 files, no failures/skips, `graphics-surface-limits-final-host.log` |
| Real Chromium/Firefox/WebKit source rendering | 195 passed, no skips, `graphics-surface-limits-final-browser.log` |
| Kernel GLIO | 50 passed, `graphics-surface-limits-checked-rust-abi-memory.log` |
| Shared GL layouts and ioctl contracts | 4 GL layout tests and 13 ioctl contracts passed; `graphics-surface-limits-checked-rust-abi-memory.log` and `graphics-surface-limits-checked-ioctl-contract.log` |
| Additional shared DRI layouts | 10 passed, `graphics-surface-limits-checked-dri-layouts.log` |
| ABI/kernel export inspection | Kernel-only build, all native layout checks and ABI 58 snapshot check passed, `graphics-surface-limits-checked-rust-abi-memory.log` |
| Source memory-boundary negatives | 12 passed, same Rust/ABI/memory log; not the full memory gate |
| Before-fix C regression | All five new cases fail unchanged `3c04b350dd`, `graphics-surface-limits-baseline-native.log` |

Logs are under `.context/`. Native validation runs the standard
`tests/graphics/run-libc-unit.sh`, private paired-link script and core
AST audit. The baseline selects only the five `surface-limits-*` cases
and supplies the prior revision to the same runner. The test double's
independent query-tag constant permits old production sources to
compile; no production baseline is patched. Failures observe missing
limits/output preservation rather than a load or link error. The Rust
gate selects `glio_`, shared `gl_tests`, `ioctl_contract` and `dri_tests`.
The host gate uses `vitest.graphics.config.ts` followed by `npm run
build`. The browser gate runs `webgl-state-contract.spec.ts` in all
three configured engines with three workers. Its new native/forwarded
C replay queries actual renderer limits before creating a context,
renders red, replaces the display generation, queries again without
losing the old current binding, then renders green. It checks physical
selectors, retirement, native errors and the source memory probe.

ABI_VERSION remains 58: this is an additive operation-table query with
no changes to existing wire layouts, tags, syscalls or imports. The
snapshot update and subsequent check regenerated no committed output
changes. The ABI check rebuilds only the target kernel for inspection;
normal SDK, kernel distribution, program, package and image artifacts
were not refreshed or restamped. Those artifacts and upstream CTS,
cage/sway/other consumers, full browser-memory and required POSIX
conformance remain deferred to the combined build/test phase.
Pbuffers/platform constructors, sync/core images and the remaining
GLES, storage/error/lifecycle, GBM and KMS inventory remain ordinary
implementation gaps. No new hard platform boundary is claimed.


## Pbuffer surfaces and retained native allocation (2026-10-24)

The EGL source facade now creates pbuffer surfaces through the normal
acknowledged GLIO surface path; the existing config adds PBUFFER_BIT.
Creation validates display/config/attributes before allocating, preserves
the pending native window BO target and publishes one independent
surface record only after exact accepted dimensions and a fresh backend
identity. QuerySurface returns stored dimensions and pbuffer attributes.
Current-reference destruction uses the existing deferred context/surface
model. Swaps validate the calling thread's current draw surface and
use the normal host failure channel for no-post flushes. Backend failure
returns an EGL error while preserving the current binding. Native and main-forwarded raw presentation also
use the stored surface kind, so an explicit GLIO_PRESENT cannot blit a
pbuffer into the visible canvas. Creating a context after its pbuffer
reuses that offscreen renderer, preserving KMS canvas dimensions and
avoiding a scanout claim. Context-before-surface KMS ordering and native
pump coexistence still need the full lifecycle audit.

Logical zero dimensions use a minimal private native attachment while
retaining zero dimensions in the surface and initial viewport/scissor.
The zero-sized browser test checks the viewport and unchanged visible
pixels; it does not assert values from reads outside a zero-sized buffer.
The configuration retains its false texture-binding attributes. A
texture-bound request fails BAD_MATCH; optional render-to-texture is not
advertised. The primary [EGL 1.5 specification, sections 3.5.2, 3.5.6,
3.6.3 and 3.10](https://registry.khronos.org/EGL/specs/eglspec.1.5.pdf)
defines creation, query, optional texture binding and posting semantics.

Largest-pbuffer creation bounds dimensions and area by the actual cached
limits. An integer rectangle search chooses the maximum area under a
pixel budget. After definite ENOMEM, budget bisection probes smaller
rectangles and retires accepted probes before the next attempt, avoiding
resource pressure from retaining a second candidate. Final creation
rechecks the best successful dimensions. Unknown transport completion
stops without an automatic allocation retry. Resource changes can still
cause final allocation failure. The native grid test checks all 1,296
small dimension/capacity combinations against independently enumerated
maximum areas. This validates the pixel-budget model; general driver
allocation constraints and full upstream resource-pressure coverage still
need the deferred conformance phase. No platform boundary is inferred.

Native surface allocation previously used unchecked creation/storage,
finally restoration and deletion. It now reserves a three-object native
retirement receipt, replacement metadata and typed selector inverses
before creating objects. Each native step must accept before dependent
steps. Failed setup/finalization preserves old logical storage and keeps
native inverses/candidate cleanup owned across creator retirement. A
query cannot publish output until exact restoration and deletion accept.
Accepted replacement storage remains committed while old deletion is
pending. Surface retirement and late/abandoned forwarded requests use
the same receipts; borrowed BO FBOs remain owned by their BO lifetime.
Internal EGL allocation errors are isolated from later GLES error flags.
Native present selects the current logical owner before flushing/blitting
and returns failure for failed resize/repair instead of posting it. The
initial KMS context-creation allocation fallback remains a separate
ordinary failure-semantics audit item.

Source evidence is based on `6fab3f17af` plus this increment. Commands
run through `scripts/dev-shell.sh`; logs are under `.context/`:

| Check | Exact evidence |
|---|---|
| Native C, fatal UBSan | 156 cases passed, including eight new pbuffer cases; `graphics-pbuffer-settled-native.log` |
| Private wasm32 paired link and core audit | Paired link, 150 authority guards and 142 core definitions/resolvers passed, same settled-native log |
| Host source / Node and browser declarations | 573 cases in 23 files, no failures/skips; build/declarations passed, `graphics-pbuffer-settled-host.log` |
| Settled recovery fixture | All 10 cases passed after adding the native constants required by the baseline; `graphics-pbuffer-final-recovery-host.log` |
| Actual source WebGL, all three engines | 207 passed with no skips, `graphics-pbuffer-final-browser.log` |
| Final pbuffer swap/raw-present pixel probe | All 12 affected replays pass after final swap/KMS refinements, `graphics-pbuffer-final-settled-browser.log` |
| Source memory-boundary negatives | 12 passed, `graphics-pbuffer-final-native-memory.log`; not full browser-memory |
| Before-fix C | All eight new cases fail unchanged `6fab3f17af`; `graphics-pbuffer-settled-baseline-native.log` |
| Before-fix native ownership | Three selected regressions fail unchanged `6fab3f17af` production; `graphics-pbuffer-checked-baseline-recovery-host.log` |

The native command runs `tests/graphics/run-libc-unit.sh`, the private
paired-link script, AST audit and source memory-boundary test. Eight new
C cases cover ordinary and zero-size creation, invalid attributes, an
unknown attribute at a protected-page boundary, native limits, definite
pressure, unknown failure and the allocation grid. Config selection now
uses PIXMAP_BIT for its unsupported-surface negative: PBUFFER_BIT is
supported, while the original ES1 default selection remains unchanged.
The C baseline passes revision `6fab3f17af` to the same runner and
selects only the eight new cases; no old production source is patched.

The host baseline is a private source projection of `6fab3f17af` with
current tests and the existing source-only config. It selects only the
three native ownership regressions. Both failed restore paths incorrectly
publish success in the old factory; old target deletion also lacks a
retained cleanup fence. Seven unselected cases are explicitly skipped;
they are not passing baseline coverage. The first projection lacked the
old factory's FRAMEBUFFER_COMPLETE constant in its new test double;
that comparison was discarded. The corrected projection loads and fails
at the intended acceptance/fence assertions. Current recovery tests also
verify output sentinels, exact foreign selectors after repair, no repeated
allocation/storage and one accepted native deletion per created object.

The full rendered suite retains every preceding case and adds twelve
actual-C pbuffer replays: normal and zero-sized, native and forwarded,
across Chromium, Firefox and WebKit. Normal surfaces must render red and
green; both sizes must leave an independently blue visible canvas intact,
preserve their initial viewport and retire tracked native resources. A
subsequent test-only probe calls raw presentation after each pbuffer
submit. The final C refinement routes swaps through the host failure
channel rather than skipping it; all twelve affected pbuffer cases pass
again after that change and the pbuffer-first KMS refinement. The other
195 cases cover unchanged paths.
These are shared-renderer/source tests with synthetic kernel scratch
plumbing, not normal rebuilt guest execution or upstream CTS. Node uses
the same renderer logic with source test doubles; hardware-unavailable
hosts still return allocation/renderer failure.

ABI 58 and operation table 16 remain unchanged: pbuffer kind already
exists in the acknowledged wire, and no layout, tag, syscall or import
changes. Rust 50 GLIO / 4 GL layouts / 13 ioctl contracts, the additional
10 DRI layouts and ABI inspection from `6fab3f17af` remain unchanged-source
historical evidence. No Rust rerun, normal SDK/archive/kernel-distribution/
program/package/image rebuild or restamp is claimed. EGL surface setters,
texture bind/release entrypoints, platform constructors, sync/core images,
full GLES semantics/errors/limits, other factories and recovery,
context-loss/unknown transport, CPU coherence and the remaining GBM/KMS
inventory stay open. Current-main integration and coherent normal
artifacts, upstream CTS, cage/sway and other consumers, full browser-memory
and required POSIX conformance remain deferred. Ordinary gaps remain gaps.


## GBM platform windows and EGL surface operations (2026-10-24)

Core and EXT platform-window constructors now use a snapshot of a live
GBM surface, including dimensions, format and usage. The lookup walks the
actual GBM live registry under its existing mutex; it never interprets an
unknown pointer as a GBM structure. Missing/foreign native windows fail
BAD_NATIVE_WINDOW. A window without rendering usage or with a mismatched
format fails BAD_MATCH before backend allocation. EGL_NATIVE_VISUAL_ID
now reports GBM_FORMAT_ABGR8888, matching the single RGBA8 configuration.
The legacy window constructor retains its existing dimensions/backend
behavior. Additional config formats and the full legacy audit stay open.
The [GBM platform extension](https://registry.khronos.org/EGL/extensions/KHR/EGL_KHR_platform_gbm.txt)
defines these matching rules and forbids platform pixmaps with
BAD_PARAMETER.

Platform attribute parsing handles the core EGLAttrib width separately
from the EXT EGLint width. Keys and values are checked before narrowing;
an unknown key is rejected before reading its paired value. Only the
four standard window attributes are accepted. Requested render-buffer
and GL colorspace values are stored for QuerySurface. SINGLE_BUFFER may
fall back to actual BACK_BUFFER, which QueryContext reports. The public
client API remains ES2 without sRGB rendering support: the sRGB surface
request is retained but uses linear rendering, as allowed by EGL 1.5
section 3.5.1, footnote 11. Pbuffers now follow the same colorspace rule.
No new client API or extension is advertised.

SurfaceAttrib implements the supported defaults and the specified
no-effect mipmap setter for NO_TEXTURE surfaces. Unsupported box resolve
or preserved swap behavior fails BAD_MATCH; invalid attributes/values fail
BAD_ATTRIBUTE. BindTexImage and ReleaseTexImage validate the surface and
buffer, then fail BAD_MATCH for the config's NO_TEXTURE pbuffers. Optional
texture-binding config attributes remain false. CopyBuffers validates
calling-thread draw ownership and reports BAD_NATIVE_PIXMAP because this
platform has no native pixmaps. Legacy pixmap creation fails BAD_MATCH
for the config without PIXMAP_BIT. Client-buffer creation recognizes the
OpenVG image type but reports BAD_ACCESS because no OpenVG context can
be current; other types fail BAD_PARAMETER. These failures do not submit
queued GL work or change current ownership. Implemented EGL entry points
now resolve through GetProcAddress. The
[EGL 1.5 specification](https://registry.khronos.org/EGL/specs/eglspec.1.5.pdf),
sections 3.5, 3.6 and 3.10, supplies these contracts. Optional config/API
absence is distinct from the remaining ordinary implementation gaps.

Evidence uses unchanged `8152b269f6` plus this increment, with commands
run through `scripts/dev-shell.sh` and logs under `.context/`:

| Check | Exact evidence |
|---|---|
| Native C, fatal UBSan | All 167 cases pass, including 11 new surface/platform cases; `graphics-platform-settled-native.log` |
| Actual GBM source, fatal UBSan | Live/foreign/guarded/retired pointers, independent formats/flags, unchanged rejected outputs and failed-constructor cleanup pass; same log and `graphics-platform-gbm-native.log` |
| Private wasm32 paired link/core audit | EGL/GLES link, all 150 authority guards and 142 core definitions/resolvers pass; same settled-native log |
| Private wasm32 GBM integration | Actual GBM object compiles and links with current EGL/GLES objects; `graphics-platform-wasm-gbm.log` |
| Actual-C browser replays | All 24 affected cases pass, native and forwarded, Chromium/Firefox/WebKit, no skips; `graphics-platform-browser.log` |
| Before-fix C inventory/behavior | All 11 new cases fail unchanged `8152b269f6`; `graphics-platform-baseline-native.log` |

The before-fix runner compiles unchanged production with the new fixture.
Calls to newly implemented APIs use runtime resolution, so missing API
assertions execute rather than failing the fixture link. Ten cases fail
on absent function pointers; the existing pbuffer API separately fails
its valid sRGB creation assertion. These are missing-API/behavior evidence,
not eleven independent storage regressions.

The new GBM executable compiles actual library source with a DRM allocation
double and provisioned public DRM headers. It does not prove kernel BO
allocation or ring ownership. The browser selection includes six new
platform-window replays, twelve pbuffer and six independent-surface
replays. Platform windows render red, green and quarter-intensity linear
gray around successful/no-effect and rejected surface operations. The C
fixture requires queued commands and current binding to remain untouched;
replays verify native storage cleanup and no GL errors. They use actual C
streams with synthetic kernel identity plumbing, not rebuilt guest CTS.
Other host/browser results remain historical unchanged-source evidence.

ABI 58 and operation table 16 remain unchanged; this increment adds C APIs
and private GBM metadata without changing wire layouts, tags or imports.
No normal artifacts were refreshed or restamped. Sync/core images, waits,
swap interval, full EGL lifecycle/negative coverage, GLES semantics and
storage/error recovery, GBM coherence/ownership and KMS remain open.
Current-main integration, coherent normal SDK/kernel/program/package/image
artifacts, upstream CTS, cage/sway/other consumers, full browser-memory and
required POSIX conformance remain deferred to the combined rebuild/test
phase. No ordinary gap has been reclassified as a platform boundary.


## Ordered client completion and swap ownership (2026-10-24)

WaitClient and WaitGL previously returned after command submission without
waiting for native completion. They now use a shared checked completion
primitive: flush pending C commands, then await the existing zero-input,
zero-output QOP_FINISH ioctl. No reply allocation or guest output pointer
is needed. A current reference retains the encoder/session during another
thread's deferred destruction request. Completion does not hold the EGL
metadata mutex across the renderer wait. An unbound client wait succeeds
without device access. Failed submit/completion returns an EGL error and
preserves current ownership. The GLES glFinish wrapper now records a
client error when the completion transport fails instead of ignoring it.

The host validates the exact empty query shape before native access,
forwarding or owner selection. Native finish uses checked GL acceptance,
preserves pre-existing errors and rejects context loss or native failure.
The forwarded mailbox returns success only after that same renderer path
accepts. SwapInterval now requires an initialized display, current context
and draw surface; requests clamp to the config's zero minimum/maximum.
This replaces the prior unconditional success intended for SDL consumers.
It does not establish broader presentation timing or native wait support.
The [EGL 1.5 specification](https://registry.khronos.org/EGL/specs/eglspec.1.5.pdf),
sections 3.8 and 3.10.4, defines the wait and current-ownership contracts.

Evidence uses `f377d77983` plus this increment, through
`scripts/dev-shell.sh`, with exact logs under `.context/`:

| Check | Exact evidence |
|---|---|
| C, fatal UBSan / private wasm32 / core audit | All 174 C cases pass in `graphics-completion-final-native.log`; paired link, 150 authority guards and 142 definitions/resolvers pass in `graphics-completion-native.log` |
| Source host and Node/browser declarations | All 582 tests in 23 files pass, no skips; build/declarations pass; `graphics-completion-full-host.log` |
| Actual-C rendered replays | All 30 affected cases pass in Chromium/Firefox/WebKit, native/forwarded, no skips; `graphics-completion-browser.log` |
| Before-fix C | All seven completion/swap cases fail unchanged `f377d77983`; `graphics-completion-baseline-native.log` |

C cases cover ordered and empty-queue waits, deferred destruction,
submit/query failure, failed glFinish and swap-interval authority. Host
cases cover native error ownership, loss before/during finish, exceptions,
malformed spans without output mutation, forwarded acceptance and both
kernel pointer widths. Six new browser replays read red/green pixels only
after successful completion and require exactly two actual native finish
calls; 24 preceding surface/platform cases remain passing. These source
replays supply synthetic kernel identity plumbing, not rebuilt guest
execution. Source host test doubles do not prove Node pixel rendering.

ABI 58 and operation table 16 remain unchanged: the existing finish query
still has no input or output, with no layout/tag/import changes. This is a
completion prerequisite, not an EGL fence implementation. Sync/core image
APIs remain absent; fence lifetime, multiple waiters, asynchronous status,
server dependencies and retirement remain ordinary implementation work.
No hard boundary is inferred from WebGL's event-loop signaling rules.
Normal artifacts, current-main integration, upstream CTS, compositor
consumers, full browser-memory and required POSIX suites remain deferred.


## Current-main integration and compositor dependency audit (2026-10-24)

Main `77b31c696279f8512b0cdbc93d125a9dd84cd1d6` contains four commits
beyond the prior integrated base `f3cb7041f6`. They add truthful xattr
marshalling/results, the getgroups size correction and Kandelo exchange,
including its browser UI and image-owned runtime. The compatibility branch
merges this history without rewriting contributors or replacing newer main
behavior. Conflict resolution retains both sysfs/DRI cleanup and exchange
open-description cleanup. Main's ABI 53 and graphics development through
ABI 58 now combine under fresh ABI 59, with operation table 16 unchanged.
The ABI history distinguishes main's released contract from graphics
branch development checkpoints.

The complete snapshot, generated C/TS interfaces and standalone resolver
are regenerated from the combined source. ABI inspection builds only the
kernel used for export-signature inspection. It does not rebuild or
restamp normal SDK, program, package, image or distribution artifacts.
The main exchange program and its image dependencies remain present.

Focused combined-source evidence, all via `scripts/dev-shell.sh`:

| Check | Exact evidence |
|---|---|
| ABI regeneration | `graphics-main59-abi-update.log` |
| Snapshot/version and standalone resolver | Passed; `graphics-main59-abi-check.log` |
| Rust GLIO / exchange / xattr / getgroups selections | 50 / 50 / 12 / 1 passed respectively; `graphics-main59-focused-rust.log`; filtered tests are not passing coverage |
| Native C | All 174 fatal-UBSan cases pass; `graphics-main59-focused-source.log` |
| Host source / Node and browser builds/declarations | All 582 cases in 23 files pass, no skips; same source log |
| Actual-C browser source replays | All 30 affected cases pass on Chromium/Firefox/WebKit through native and forwarded dispatch, no skips; `graphics-main59-focused-browser.log` |

This is focused integration evidence, not full workspace Rust, rebuilt
guest, upstream CTS, compositor, browser-memory or POSIX conformance.
Those gates remain unrun on ABI 59.

The proposed compositor-first delivery uses the existing port and
consumer tests as a distinct acceptance scope while the complete baseline
remains open. Upstream wlroots 0.20.2 was read from the exact release
archive pinned by its manifest: SHA-256
`80c567d2ed4efb2cfa6b077f22c7a710d9c78ba4e185a75e8694001114af0733`.
`compositor-source-audit.log` records acquisition and digest verification;
selected source copies are under `.context/wlroots-source-audit/`.

The upstream [EGL implementation](https://gitlab.freedesktop.org/wlroots/wlroots/-/blob/0.20.2/render/egl.c)
requires EXT_platform_base, GBM, configless/surfaceless ES2 and KHR dma-buf
images. Its native-fence functions load only when the corresponding
optional extensions are advertised. The GLES2 renderer additionally
requires BGRA8888 and unpack-subimage support; C advertises these existing
client features. Timeline rendering requires both native-fence procedures
and DRM syncobj-timeline capability; its normal implicit-sync submission
uses glFlush. The texture readback path uses glFinish. Thus full core EGL
sync/image APIs are not prerequisites for this pinned consumer path;
their baseline gaps remain open. No advertisement is lowered or upstream
assertion weakened to obtain this scope.

The [render build](https://gitlab.freedesktop.org/wlroots/wlroots/-/blob/0.20.2/render/meson.build)
always includes pixman independently of the GLES2 renderer option. The
existing Node pixman test setup therefore agrees with the recipe; browser
consumer tests still require GLES2. This source audit does not prove that
either compositor currently builds or runs on the combined tree.

A first landing still needs current-main/ABI-coherent normal builds,
required input/protocol/wlroots dependencies, storage/DRM correctness
fixes, rendered cage/sway sessions on all three engines, Node consumer
semantics, exit/restart/master handoff, repeated memory teardown and the
required Rust/ABI/POSIX checks. An extraction must preserve mho22's port
authorship and the complete compatibility branch. No smaller landing PR
or normal compositor build is created by this audit; expensive gates
remain deferred while the user's sequencing choice is pending.


### Compositor build-plan evidence on the ABI 59 integration

Read-only plans run through `scripts/dev-shell.sh` after integration
commit `b2478efe3f`, using the shared SourceOnly cache and 16 jobs:

| Selection | Graph/cache status | Planner estimate | Evidence |
|---|---|---|---|
| cage, sway, swaybg and kernel | 32 nodes, none currently cached | 16m 42s | `.context/compositor-packages-build-plan.log` |
| browser-main-shell | 150 nodes, none currently cached; eight source checks | 58m 29s | `.context/compositor-build-plan.log` |

The package plan has four nodes without recorded durations: wlroots,
cage, swaybg and sway. Each receives a 41-second fallback, so this is
not a measured compositor build duration or a landing estimate. The
shell plan has six such nodes. Both omit SDK bootstrap, consumer and
conformance validation, and any defect repair. Fresh SDK inputs can
also change cache identities. No normal artifact build was started by
these plans.

The recommended next milestone is coherent normal compositor builds
and consumer validation while retaining the shared ownership models and
complete baseline goal. Missing core EGL sync APIs do not gate the
pinned wlroots path identified above; ordinary baseline gaps remain
open. Full-baseline completion still has no validated duration estimate.


### Core image entry points and dma-buf attribute validation

This increment retains ABI 59 and operation table 16. There is no new
kernel or host wire contract. The core `eglCreateImage` and
`eglDestroyImage` definitions now resolve through GetProcAddress, use the
existing retained image registry and support its dma-buf target. Core and
KHR destruction are interchangeable for these handles. The core parser
reads EGLAttrib elements; the KHR parser retains EGLint elements.
GL texture/cube/renderbuffer image sources remain ordinary gaps.

The shared parser checks attribute keys before reading values and checks
representability before narrowing. Mandatory plane offset presence is
separate from its zero value. Valid YUV hints are ignored for supported
RGB formats; invalid hint/preservation values fail before import. Modifier
words accept signed EGLint bit patterns and wide positive u32 values;
malformed pairs and unsupported combinations remain rejected. The relevant
requirements are [EGL 1.5 section 3.9](https://registry.khronos.org/EGL/specs/eglspec.1.5.pdf),
[EXT dma-buf import](https://registry.khronos.org/EGL/extensions/EXT/EGL_EXT_image_dma_buf_import.txt)
and its [modifiers extension](https://registry.khronos.org/EGL/extensions/EXT/EGL_EXT_image_dma_buf_import_modifiers.txt).

All commands below use `scripts/dev-shell.sh`:

| Check | Exact evidence |
|---|---|
| Native C | All 185 fatal-UBSan cases pass; `graphics-core-image-final-native.log` |
| Strengthened final lifetime assertions | Both core image lifetime/generation cases pass again with exact context-destruction outcomes; `graphics-core-image-strict-lifetime.log` |
| Private wasm32 | Paired EGL/GLES and actual-GBM links pass; both new symbols are defined; same log |
| Existing GLES authority/core inventory | 150 authority guards and 142/142 core definitions/resolvers pass; same log |
| EGL core definition inventory | 39/44 definitions and all corresponding resolvers; only five sync definitions absent; `graphics-core-image-api-inventory.log`; symbols are not semantic conformance |
| Prior-library comparison | All eleven new cases fail unchanged `2dcf3db679`; `graphics-core-image-final-baseline.log` |
| New actual-C GPU import replay | Chromium/Firefox/WebKit native dispatch pass; `graphics-core-image-first-browser.log` |
| Complete enabled actual-C source replay selection | All 105 pass across Chromium/Firefox/WebKit, no runtime skips, 10.2m; `graphics-core-image-final-browser.log`; native-only BO import exclusions are described below |

Eight new baseline failures are missing-core-API resolution, not eight
independent behavioral reproductions. Three directly reproduce omitted
mandatory offset acceptance, valid hint rejection and invalid preservation
acceptance. Current cases additionally cover wide values/keys, guarded
terminators and invalid keys, allocation/import rejection, mixed API
spelling, sibling retirement and display-generation replacement.

The new real-WebGL replay imports canonical GPU storage through recorded
C source registration and source-query bytes, destroys the public image,
respecifies one texture to blue, checks that its sibling remains red, then
renders green through that sibling. Unbound framebuffer storage retains
the final C reference after texture deletion. The replay supplies kernel
identity plumbing and canonical GPU BO creation; it does not execute guest
ioctl marshalling. Forwarded BO-source registration remains unimplemented,
so this import scenario has native coverage only. Existing applicable
replays continue to exercise both dispatch routes.

The sync audit confirms a separate model is needed: display-owned sync
handles must survive creator-context destruction and support no-current
client waits, plus multiple waiters and deferred deletion. Current GLIO
query authority is context-oriented. Native WebGL fence observation also
requires allowing the host event loop to advance. The existing finish
query does not implement these fence lifetime/timeout requirements; no
sync implementation or hard platform boundary is claimed here.

Normal SDK/kernel/program/package/image rebuilds, guest CTS, compositor
consumers, full browser-memory and POSIX gates remain deferred/unrun for
this increment. The complete compatibility goal remains active.


### Consolidated ABI 54 above current main

Main `5cd771bff889bb0d5c4b672a54c0edcffa691066` uses ABI 53. Its orphan
reparent/reaping and Vitest evidence-registry commits are integrated with
the graphics work. The user requested one ABI above main instead of the
higher provisional number, so the combined source now uses ABI 54.
Earlier ABI 52-59 checkpoints remain historical evidence and do not imply
that their artifact sets are interchangeable with this source.

The complete snapshot and generated C/TypeScript interfaces are regenerated
from the combined source and a fresh kernel export-inspection build. The
standalone resolver is regenerated and tested. Main's process-exit export
promotion at ABI 54 remains active; reducing the graphics number must not
disable a newer main contract. No graphics API, sharing/lifecycle behavior,
operation-table version or contributor history was removed to renumber it.
The cage, sway, wlroots, libwayland and graphics-cts-egl package ABI floors
are corrected from provisional 55 to consolidated 54.

| Check | Exact evidence |
|---|---|
| Full ABI regeneration | `graphics-abi54-update.log` |
| Snapshot, version and generated-output consistency | Passed; `graphics-abi54-check.log` |
| Standalone resolver regeneration/test | Passed; `graphics-abi54-resolver.log` |
| Complete merged Vitest evidence inventory | All 595 files agree with the registry; `graphics-main54-evidence-registry-final.log` |
| Current-main orphan/lifecycle Rust selection | All 19 selected tests pass; `graphics-main54-orphan.log` |
| Combined GLIO Rust selection | All 50 selected tests pass; `graphics-main54-glio.log` |

The initial merged test registry contained two rows for files already
removed on the graphics branch. Those rows are removed; package-dependent
protocol scanner tests retain their prepared-product class. The kernel-only
ABI inspection does not establish normal graphics product compatibility.
The subsequent full xtask suite also refreshed the wasm32 musl core through
an existing normal resolver integration test. That narrow prerequisite is
distinct from the deferred graphics SDK archives, programs, packages and
images. No complete SDK/product rebuild or broad conformance result is
claimed. The full graphics goal remains active.

### Cache collection above a consolidated ABI

`cache-gc --above-abi N` selects named library/program generations with
ABI strictly greater than `N` in both compiled cache layouts. Unnamed
legacy generations and ABI-independent sources never match this bound.
It supplements SourceOnly age/size rules and combines with `--below-abi`
as a union. Live checkout roots, the one-day recent-use floor, build
locks, staged trash removal and default dry-run behavior remain intact.
Automatic GC does not acquire an ABI bound.

The public CLI accepts both `--above-abi 54` and `--above-abi=54`. It scans
the ordinary cache alongside SourceOnly unless source isolation is
explicit; `--binary-cache-root` can select it alongside an isolated root.
Reports show higher-ABI generations retained by roots/recent use and
their allocated bytes. No destructive shared-cache collection was run.

All verification below ran through `scripts/dev-shell.sh` on the combined
ABI 54 source, including main `5cd771bff8`, now merged as `f218d63987`.
Job `graphics-cache-above-1024-173553-ef95` completed successfully in
17m47s. ABI consistency/resolver evidence is recorded immediately above.

| Check | Exact evidence |
|---|---|
| Complete xtask suite | All 792 unit and 8 CLI integration tests passed; `graphics-cache-above-xtask.log` |
| New upper-bound coverage | Eight unit and two CLI integration cases cover strict thresholds, sidecars, roots, recent use, build locks, unknown/source entries, union/overlap, age independence, integer limits, invalid values, isolation and dry-run/apply behavior; same log |
| Destructive test scope | Apply checks used temporary test caches; the public shared-cache command was a dry run only |
| Full merged registry | All 595 files agree; `graphics-main54-evidence-registry-final.log` |
| Focused Rust integration | Orphan selection 19/19 and GLIO selection 50/50 pass; `graphics-main54-orphan.log`, `graphics-main54-glio.log` |
| Shared-cache preview | `xtask cache-gc --above-abi 54` inspected 3,137 SourceOnly and 792 ordinary generations; `graphics-cache-above-preview.log` |

The real-cache preview found no named ABI 55+ generations, including no
higher-ABI entries retained by roots/recent use. Its 15.9 GiB reported
removal candidates are existing crash debris (14.2 GiB SourceOnly and
1.7 GiB ordinary) plus 100 zero-allocated-byte orphan sidecars, rather
than evidence of higher-ABI product builds. SourceOnly retained 1,573
root-protected generations. The earlier provisional ABI numbers did not
produce normal rebuilt graphics product sets during the deferred phase.
These observations do not cover private evidence files or Cargo target
outputs, which are outside this collector's scope.

The resolver integration test refreshed the wasm32 musl core as described
above. Complete normal graphics SDK/kernel/program/package/image
validation, CTS, cage/sway, browser-memory and POSIX gates remain deferred;
this cache tool does not establish graphics compatibility.

### Query destination validation before renderer effects

The common `GLIO_QUERY` path now validates nonempty output capacity before
calling the renderer, including queries whose reply is empty. The earlier
surface-capability-only probe did not protect ordinary state queries or
acknowledged object mutations. A null or out-of-range destination now
fails with `EFAULT` before the host callback can consume an error or change
renderer state. Zero-length buffers do not inspect their pointer values.

The kernel also rejects nonzero reserved fields with `EINVAL`, rejects
nonempty null input itself, and treats a negative/oversized host byte
count as `EIO` without copying output. Actual process-memory imports allow
byte zero; a new test explicitly models that host behavior so the mock
cannot supply the kernel's null check accidentally. Valid overlapping
input/output is copied before dispatch, and short replies leave the
remaining destination bytes intact. All C query constructors were checked
for zero-initialized reserved fields. ABI 54 and operation table 16 remain
unchanged; the query structure and generated layout are unchanged.

| Check | Exact evidence |
|---|---|
| Unchanged production comparison | With the query arm from `08419e1830`, five of eight new cases fail and three controls pass; `graphics-query-preflight-abi54-all-baseline.log` |
| Focused current Rust query/session/lifecycle tests | All 58 GLIO cases pass, including all eight new cases; `graphics-query-preflight-fixed-rust.log` |
| Shared GL/query wire checks | All five selected cases pass; `graphics-query-preflight-fixed-layouts.log` |
| Source host adapter/forwarding controls | All 135 cases in three files pass without skips; `graphics-query-preflight-host.log` |
| Complete ABI consistency | Passed using a fresh kernel export-inspection build; `graphics-query-preflight-fixed-abi.log` |

The baseline failures cover an empty reply hiding an invalid destination,
renderer dispatch before a non-null destination fault, a nonempty null
input when address zero is accessible, oversized replies and reserved
fields. Existing controls cover inaccessible input ranges, overlap/short
reply tails and ignored zero-length pointers. The focused host selection
runs `kernel-public-scratch`, `webgl-context-creation` and
`webgl-main-forward`; all are registry-classified source-only. Its private
config omits global product provisioning and retains every assertion in
those files. It checks existing native/forwarded import behavior, including
both kernel pointer widths and address-zero process copies; it does not
run the changed Rust syscall through a normal guest kernel.

This closes the identified common query-validation defects, not H01/H02
as complete inventory items. Rebuilt guest integration, full CTS, real
browser rendering, complete browser-memory, cage/sway and POSIX gates
remain required in the deferred combined-artifact phase. Renderer sync
objects, GL-source EGLImages and other inventory gaps remain open.

### Retained native fences before EGL sync entry points

The host now separates a prepared native fence, its published token and
independent waiter leases. Publication does not require another native
allocation. Cancelling an unaccepted candidate retires it; cancellation
cannot retract an already published token. Deleting a public token rejects
new lookups immediately while existing leases retain polling authority.
Native deletion waits for the final lease, is idempotent, and preserves
failed cleanup in the preallocated native-retirement owner. A failed
candidate deletion blocks further native admission until repair succeeds.

Each session's owner survives logical context destruction and uses
non-reused tokens across context recreation. Records keep only native
handles, scalars and private error flags; neither guest bindings nor guest
memory cross into their persistent cleanup lifetime. Session close revokes
publication without invalidating retained waiters. Kernel fd/process
cleanup and forwarded unbind/disposal capture every retained native
context's selected error owner before internal deletion, including when
the creator's `gl` field has already been cleared.

This implements the native ownership prerequisite, not the five public
EGL 1.5 sync functions. No new query opcode, operation-table version,
C entry point or advertised extension was added. ABI 54 and operation
table 16 remain unchanged. Display-owned C handles, no-current query
authority, bounded timeout/flush behavior, multiple guest waiters and
per-context server-wait ordering are still required implementation work.
The registry's retained host leases are not yet a guest sync protocol.

The requirements follow [EGL 1.5 section 3.8.1](https://registry.khronos.org/EGL/specs/eglspec.1.5.pdf):
creation uses the current client context, but sync identity belongs to a
display; multiple waiters and deferred deletion require distinct lifetime.
The [WebGL2 sync contract](https://registry.khronos.org/webgl/specs/latest/2.0/)
requires an event-loop turn before a newly created fence can report
signaling. That is a scheduling requirement to implement, not evidence
that EGL waits are impossible or permission to replace them with finish.
Cross-native-context server ordering remains ordinary work; no hard
platform boundary is claimed.

| Check | Exact evidence |
|---|---|
| Full graphics source suite | All 605 cases in 24 files pass without skips, including 23 new fence cases; `graphics-fences-host-final-complete.log` |
| Native candidate/cleanup cases | Publication/cancellation, two waiter leases, final release, close, token reuse/exhaustion, metadata/native allocation failure, creation/deletion rejection, malformed status, context loss and retained creatorless contexts; same log |
| Shared error ownership on cleanup | Kernel fd-close, process-exit and actual main-forward handler cases preserve the selected peer's pending flag while deleting a creatorless fence; same log |
| Real native fence and pixels | Chromium, Firefox and WebKit all pass the new rendered source case, no skips; `graphics-fences-browser.log` |
| Host Node/browser builds and declarations | Canonical build and declaration commands pass; `graphics-fences-build-current.log`, `graphics-fences-declarations-current.log` |
| Merged Vitest evidence registry | All 596 files agree; `graphics-fences-registry-current.log` |
| Extra raw TypeScript diagnostic comparison | `tsc -p tsconfig.json --noEmit` reports the same 44 diagnostic heads on `69adc58b82` and current source; no added location/code/message; `graphics-fences-types-baseline.log`, `graphics-fences-types-final.log` |

The real renderer test clears red, creates an actual WebGL fence, confirms
it is initially unsignaled, flushes, destroys the logical creator and
invalidates the public token while retaining two waiters. After yielding
to the browser event loop both observe completion and red pixels. Releasing
one does not delete; releasing the last deletes exactly once. Session
unbind does not repeat deletion, native isSync becomes false, and no GL
error or browser memory-boundary failure occurs. This is host source
execution without guest EGL/GLIO marshalling, not CTS or compositor proof.

The diagnostic comparison used a private tracked-source projection of the
prior commit with the same declared dependencies. The standalone raw tsc
command still fails; the passing canonical build/declaration checks do not
turn that result into a pass. No normal graphics SDK/program/package/image
rebuild, full browser-memory, guest CTS, cage/sway or POSIX result is
claimed. Those complete gates remain deferred to the combined-artifact
phase. The original full graphics objective remains active.

### Retained fence wire queries and no-current authority

Operation table 17 adds `QOP_CREATE_FENCE`, `QOP_FENCE_STATUS` and
`QOP_RELEASE_FENCE`, plus a separate empty-payload `QOP_FLUSH` reply.
ABI 54 remains fixed. All three fence operations take exactly four input
bytes, a nonzero little-endian u32 token, and a 16-byte response: status,
echoed token, signaled bit and `0x47514c33` reply magic. Status 0 is an
accepted operation, 1 a rejected creation, and 2 a missing public token.
Flush acknowledges native dispatch without claiming GPU completion.

The client allocates tokens monotonically per object session before
creation. An acknowledged duplicate returns the existing identity instead
of inserting another fence. Release is idempotent and advances the token
high-water mark even when it arrives before creation, preventing a late
request from reviving an abandoned token. Unknown creation replies can
therefore be reconciled with a token already known by C. A rejected native
candidate remains privately owned for cleanup; no failed candidate is
published as a usable sync object.

The kernel validates fence shape, token and complete guest ranges before
dispatch. Creation requires its current caller TID and a live display.
Status/release allow another live thread to use the retained initialized
object session even after creator destruction and display-root revocation.
Authority still requires matching process/session ownership, object role,
native liveness and a live command mapping. Display roots and foreign,
unmapped, mismatched or revoked resource owners cannot use this exception.
Ordinary GL queries retain their current-thread requirement.

Both native imports and the main-forward receiver prepare creation before
publishing it. Direct output acceptance or the forwarded mailbox's atomic
completion transfers publication; a retired/failed reply cancels the private
candidate. Malformed fence requests are rejected before native repair or
muxer switching. Cleanup captures the actual selected owner's error flags
before native repair, including admission through a surviving peer.

Two new cases exposed a source-model gap: candidate/public destruction
removed the native-context receipt from the session even when deletion was
rejected. Destroyed records now remain discoverable until their checked
retirement completes. Public lookup stays invalid while teardown can find
and retry the old native context after its logical creator disappears.
Completed receipts are pruned without reviving or reusing a token.

| Check | Exact evidence |
|---|---|
| Original query authority/shape baseline | All three first new cases fail the unchanged query path from `e0ba170cc1`; `graphics-fence-wire-baseline.log` |
| Retired native-context reachability baseline | Both new cases fail the preceding owner implementation; 23 other cases explicitly unselected in this diagnostic; `graphics-fence-retirement-baseline.log` |
| Focused Rust GLIO | All 63 pass, including five new fence authority/shape cases; `graphics-fence-wire-rust.log` |
| Shared wire/opcode checks | All five pass; `graphics-fence-wire-layouts.log` |
| Complete graphics host source | All 622 in 25 files pass without skips, including 15 new wire cases and the two strengthened retirement cases; `graphics-fence-wire-host.log` |
| Native C regression controls | All 185 fatal-UBSan cases pass with table 17 headers; `graphics-fence-wire-native.log`; public C sync functions are still absent |
| Host Node/browser builds and declarations | Passed; `graphics-fence-wire-build.log`, `graphics-fence-wire-declarations.log` |
| Extra raw tsc audit on `8295a159a3` | Still fails with 44 diagnostics; no added file/code/message relative to the prior owner source (line offsets excluded); `graphics-fence-wire-tsc.log`, `graphics-fence-wire-tsc-comparison.txt` |
| Complete evidence registry | All 597 files agree; `graphics-fence-wire-registry.log` |
| ABI metadata and standalone resolver | Regeneration/check and resolver regeneration/test pass; `graphics-fence-wire-abi-update.log`, `graphics-fence-wire-abi-check.log`, `graphics-fence-wire-resolver.log`; the generated metadata remains unchanged because no structural ABI entry changed |

The nine selected browser cases cover retained owner leases and actual
native/forwarded query adapters in Chromium, Firefox and WebKit. The new
worker submits clear commands through host imports, creates the same token
twice, flushes, destroys the logical creator, yields before observing the
retained fence, and releases it twice. The result requires one native
allocation/deletion, correct red pixels, invalid public lookup after
release and no browser memory-boundary failure. The test supplies synthetic
Rust scratch/identity plumbing and executes real host imports/renderers;
it does not execute a normal guest EGL/GLIO syscall. All nine pass after
that final cleanup guard change, without skips; exact evidence is
`graphics-fence-wire-browser.log`.

The first wire-rendering fixture incorrectly emitted a nonexistent flush
command tag; that fixture failure was corrected. The new flush query is a
server-dispatch prerequisite for the sync API. C glFlush still submits its
encoder only and must be connected to this acknowledgement in the next C
increment; it is not claimed complete here.

Five public EGL sync definitions, display-generation C handles, retained
creator-session references, client timeout/flush loops and per-context
server-wait ordering remain ordinary implementation work. No new extension
is advertised, no full sync/CTS claim is made, and no hard platform boundary
is inferred from the browser's event-loop scheduling requirement. Complete
SDK/kernel/program/package/image rebuilds and required consumer, CTS,
browser-memory and POSIX gates remain deferred until the rebuild/test phase.


### Public C fence client waits and acknowledged flush

Core `eglCreateSync`, `eglDestroySync`, `eglGetSyncAttrib` and
`eglClientWaitSync` are now defined and resolved. The shared kernel ABI
remains 54 and GL operation table remains 17. Creation submits preceding
encoder work before inserting the fence; public `glFlush` additionally
requests the empty native-flush acknowledgement, without a finish.

Display-generation records give syncs never-reused handles and retain
their initialized creator session independently of context records.
Native client tokens remain monotonic across context/session reuse.
All C record, mutex and request/reply storage is reserved before native
creation. An unknown create or release reply retains its known token for
idempotent cleanup and gates new allocation on that session while cleanup
is unresolved. Retired generations retry cleanup at initialization.

Waiters acquire a reference before releasing the EGL metadata lock. A
per-record mutex serializes only wire IO and checked reply copies. Zero,
finite and FOREVER waits use monotonic elapsed time and yield between
polls. The flush flag selects the waiting thread's current context and is
ignored without one; an already-signaled fence needs no flush. Public
destruction and display termination invalidate future lookups while
existing waiters retain the object session and mapping. Wait cancellation
releases the reference; retirement disables cancellation until the
metadata lock is released. Query failures preserve caller output.

The rules follow the Khronos reference pages for
[creation](https://registry.khronos.org/EGL/sdk/docs/man/html/eglCreateSync.xhtml),
[client waits](https://registry.khronos.org/EGL/sdk/docs/man/html/eglClientWaitSync.xhtml),
[attributes](https://registry.khronos.org/EGL/sdk/docs/man/html/eglGetSyncAttrib.xhtml)
and [destruction](https://registry.khronos.org/EGL/sdk/docs/man/html/eglDestroySync.xhtml).
No `eglWaitSync` server-ordering implementation or KHR spellings are
claimed. Sync extension strings remain unadvertised, including the GLES2
client support declaration; this is a partial source increment, not full
EGL sync capability/conformance. These remaining items are ordinary work.

| Check | Exact evidence |
|---|---|
| Before-source reproduction | All three initial cases fail unchanged `81e9638207`: two missing API resolution assertions and native-flush assertion; `graphics-c-sync-baseline.log` |
| New C cases | All 21 pass: allocation rollback, rejected/unknown/malformed create, submit rejection, guarded/wide attributes, status failures/output preservation, current/peer/no-current flushing, finite timeout, uncertain release, session reuse, stale generation creation, two retained waiters, display reinitialization and cancellation; `graphics-c-sync-native.log` |
| Complete native regression selection | All 206 cases pass under fatal UndefinedBehaviorSanitizer; same log |
| Private wasm32 EGL/GLES compile/link and GLES audit | Passed; all 150 public GL guards and 142 core definitions/resolvers remain; `graphics-c-sync-wasm.log` |
| EGL definition/resolver inventory | 43/44 core definitions and corresponding resolvers; only eglWaitSync absent; `graphics-c-sync-api-inventory.log`; definitions are not semantic conformance |
| Actual-C native/forwarded browser selection | 21 pass across Chromium/Firefox/WebKit, including six new fence cases plus image, platform-window and completion controls; `graphics-c-sync-browser.log` |
| Final fence source rerun | Six native/forwarded cases pass across all three engines; `graphics-c-sync-browser-final.log` |
| Test evidence registry | All 597 files agree; `graphics-c-sync-registry.log` |

The new browser cases replay actual C command/query traces, render red,
insert and flush a real native fence, yield until it signals, retire the
creator and continue polling through its retained session. They require
one checked cleanup path, no live native resources and no GL errors.
Native mocks do not supply browser completion or pixel results. The
adapter still supplies synthetic kernel identity/scratch plumbing; it
does not execute rebuilt guest EGL/GLIO marshalling. Persistent-realm
memory boundary probes remain enabled.

The private extra actual-GBM compile stopped at missing `xf86drm.h` after
the EGL/GLES paired link and audits passed; `graphics-c-sync-wasm.log`.
No actual-GBM link rerun is claimed for this increment. Its source is
unchanged, and normal package/header provisioning remains part of the
required deferred build phase, not a platform boundary. Normal graphics
SDK/kernel/program/package/image rebuilds, upstream CTS, compositor
consumers, complete browser-memory and POSIX gates remain deferred/unrun.
The full compatibility goal stays active.


### KHR fence interfaces and client support declaration

The four `EGL_KHR_fence_sync` entry points now resolve to width-correct
wrappers over the core registry. Core and KHR handles interoperate for
query, waiting and destruction. KHR creation reads an EGLint attribute
key without accessing a value for an unknown key, and distinguishes its
BAD_ATTRIBUTE error for an unsupported type from core BAD_PARAMETER.
KHR attribute queries copy only four bytes after success, preserving
neighboring storage and failed outputs. Timeout values remain 64-bit.

EGL now declares EGL_KHR_fence_sync. The C client extension layer adds
GL_OES_EGL_sync to identify the GLES2 API's ability to place fence commands;
it does not request an unrelated WebGL extension or add GLES functions.
Both strings are defined by
[the KHR fence specification](https://registry.khronos.org/EGL/extensions/KHR/EGL_KHR_fence_sync.txt).
That extension contains the four client interfaces, not server-side
`eglWaitSync`. EGL_KHR_wait_sync remains unadvertised and eglWaitSyncKHR
unresolved. The missing core server wait remains ordinary baseline work;
no full EGL 1.5 or upstream sync-conformance result is claimed.

| Check | Exact evidence |
|---|---|
| Before-source comparison | Five new cases fail unchanged `7efae46e42` at missing KHR resolution; `graphics-khr-sync-baseline.log` |
| Native C source selection | All 211 fatal-UBSan cases pass, including five KHR cases for resolution, core/KHR identities, distinct errors, protected attribute-list endings, four-byte outputs and a retained wait whose finite timeout exceeds u32; `graphics-khr-sync-native.log` |
| Private wasm32 source | EGL/GLES paired link, all 150 GL current guards, 142 GLES2 core symbols and all four KHR fence definitions pass; `graphics-khr-sync-wasm.log`, `graphics-khr-sync-symbols.txt` |
| Actual-C browser replays | All 12 KHR/core native/forwarded cases pass across Chromium/Firefox/WebKit with real fences, red pixels, accepted completion, creator retirement and native cleanup; `graphics-khr-sync-browser.log` |
| Evidence inventory | All 597 registered files agree; `graphics-khr-sync-registry.log` |

Browser control traces now distinguish a completion assertion from an
unsignaled zero-timeout observation. A real fence may finish sooner than
the native device double's schedule. A required completion still waits
for the real native status after yielding; no mock status becomes a
browser completion result. These remain source replays with synthetic
kernel identity/scratch plumbing, not normal guest EGL/GLIO execution.
ABI 54 and GL operation table 17 remain fixed. Normal graphics artifact
builds, CTS, cage/sway, full browser-memory and POSIX gates remain deferred.

At `86b06464fe`, the server-wait audit confirms that SubmitQueue still
borrows guest memory and dispatches through mutable current bindings.
Nonblocking server ordering must reserve owned work and execution lifetime
before acknowledging a wait, preserve query/presentation order and release
retained dependencies on teardown. A blocking client wait inside glFlush,
a finish substitution or a no-op does not implement that contract.


### Owned submit snapshots before deferred server execution

The server-wait audit found a concrete preflight/execution race. Native
submit and main-forward decode used the caller's writable command storage.
A renderer callback could rewrite a later, valid record after validation;
the earlier implementation executed the changed record. All three new
host-import regressions fail unchanged `86b06464fe`, including native
imports at widths 4/8 and the main-forward adapter. This is a command-byte
ownership defect, not a browser engine defect or platform boundary.

SubmitFrame now captures only the requested source span into independent
bytes before validation. Validation and decode see that same snapshot in
both adapters. Snapshot construction reads captured typed-array slots
rather than overridable source properties. Frame admission is one-shot;
execution consumes its storage before dispatch, and purge clears even
caller-retained frame tokens. Accepted prefixes cannot replay after a
later renderer failure. The existing compositor priority and client FIFO
rotation remain covered by executable ordering checks.

The decoder receives a temporary owned view on its binding. Finally
restores the previous guest cache only when no rebind or teardown has
replaced it. Forwarded bindings do not retain a last-message view after
execution. Capture/admission failure reports failure before accepting the
submission. The bound wire shape, ABI 54 and operation table 17 do not
change. No performance result is claimed for the added bounded copy.

| Check | Exact evidence |
|---|---|
| Semantic baseline | Three native/forwarded source-import regressions fail unchanged `86b06464fe` by executing green instead of the validated blue record; `graphics-submit-snapshot-baseline.log` |
| Full graphics host source gate | 638 cases in 27 files pass without skips, including 14 new snapshot/span/discard/view-restoration cases and the existing two-pid multiplex checks; `graphics-submit-snapshot-host.log` |
| Node/browser host build | Canonical build and declaration commands pass; `graphics-submit-snapshot-build.log`, `graphics-submit-snapshot-declarations.log` |
| Extra raw tsc audit | Still fails with the same 44 diagnostics as the prior wire audit; complete diagnostic text agrees after removing line/column offsets; `graphics-submit-snapshot-tsc.log`, `graphics-submit-snapshot-tsc-comparison.txt` |
| Real native/forwarded snapshot rendering | Six cases pass across Chromium/Firefox/WebKit: a renderer callback rewrites later input to green, but captured work renders the accepted blue pixels with no GL error; `graphics-submit-snapshot-browser.log` |
| Affected fence rendering controls | All 12 core/KHR cases also pass in that 18-case browser selection; same log |
| Evidence inventory | All 598 files agree; `graphics-submit-snapshot-registry.log` |

Adding the existing multiplex fixture to the source gate exposed its stale
renderer double without getError. The double now supplies that required
native method, and both ordering cases additionally require successful
drain completion. Their original dispatch/color assertions remain intact.
The initial expanded run failed those two cases; the final run passes all
638. No production assertion was weakened.

Drain remains synchronous and registry context destruction still clears
execution-local state. Correct eglWaitSync server ordering therefore still
needs retained execution/drawable owners, dependency references, query and
presentation barriers, and retirement across destroy/recreate. This
increment does not enqueue waits or substitute client polling/finish for
server semantics. All other baseline gaps and deferred normal builds,
upstream CTS, cage/sway, complete browser-memory and POSIX gates remain
required for the active full goal. Browser fixtures use independent device
buffers and source adapters, not normal rebuilt guest ioctl marshalling.


### Retained owned drawable allocations

A queued command needs its selected allocation, not only a reference to
an EGL surface whose target may resize. Two new source regressions fail
unchanged `2c7075a919` when resize/destruction deletes the still-needed
native framebuffer. The before-source fixture permits the absent hold
helper so both failures occur at the native-lifetime assertion, rather
than module loading.

Owned surface targets now provide native-only allocation leases. A lease
copies framebuffer identity, dimensions and surface ID and retains the
existing native deletion receipt. It does not retain the mutable surface,
its selecting bindings, a guest view or a callback. Resize and logical
surface destruction can proceed while an old allocation remains usable.
A retained lease may clone its reference after retirement; fresh receipt
lookups cannot revive a retiring allocation. Released leases refuse use.

Retirement holds and dependent receipts differ from failed restoration:
intentional holds do not block admission while work still needs to run.
Final release captures selected-owner errors before private cleanup.
Failed capture keeps the active reference. Failed deletion ends use but
retains a cleanup retry token, including after partial acceptance; accepted
native deletions never replay. Retirement waits behind unresolved native
inverses and removes their old handles only after actual deletion accepts.

| Check | Exact evidence |
|---|---|
| Before-source lifetime evidence | Two regressions fail unchanged `2c7075a919` at premature native FBO deletion; `graphics-storage-lease-baseline.log` |
| Complete graphics source gate | 649 cases in 28 files pass without skips, including 11 new allocation/clone/release/partial-cleanup/error-capture/dependency/inverse cases; `graphics-storage-lease-host.log` |
| Node/browser canonical host build and declarations | Passed; `graphics-storage-lease-build.log`, `graphics-storage-lease-declarations.log` |
| Real owned-allocation rendering | Six cases across Chromium/Firefox/WebKit preserve red old storage and blue replacement storage, retire the surface and context, render green through the retained allocation, and delete each native member once after final release; partial cleanup retry is included; `graphics-storage-lease-browser.log` |
| Affected source rendering controls | All prior 18 core/KHR fence and owned-submit cases also pass in that 24-case selection; same log |
| Evidence registry | All 599 files agree; `graphics-storage-lease-registry.log` |

The browser fixture initially probed a second module instance through a
non-normalized /@fs// URL. Its separate retirement map reported no pending
cleanup although the real receipt retained the rejected texture. A raw
.js URL then failed to load. Normalizing the source URLs makes the probe
share the production module instance; all original cleanup and pixel
assertions pass. These were fixture defects, not browser/runtime defects.

These are source allocation leases, not a queued server-wait implementation.
Borrowed BO allocation retention and independent context execution lifetime
remain necessary before deferred submits can be enabled. Registry context
destruction still clears execution-local state immediately. The server
wait, all other ordinary inventory gaps and the deferred normal artifact,
CTS, cage/sway, full browser-memory and POSIX phases remain required.
ABI 54 and GL operation table 17 are unchanged. No full guest-marshalling,
whole-machine reclamation or performance result is claimed.


### Retained native context execution across public revocation

Three new source regressions fail unchanged `67e5275ea7` at premature
native texture deletion after public context destruction/session removal.
The before-source fixture permits the absent lease API so the assertions
observe native lifetime, rather than failing at missing-method lookup.

A context execution lease now reserves replacement public state before
work can be accepted. Public destruction revokes context lookup and clears
the old borrowed command view and forwarding transport. Existing leases
retain old native identity and local state while a replacement context
uses fresh names/state in the same session. Multiple retired generations
remain independent. Explicit surfaces and session-owned fence records
retain their separate ownership; live share-group peers retain objects.
No normal submit is deferred or given a new lease by this increment.

Final execution release captures selected-peer errors before private
retirement. Failed capture preserves native objects; rejected cleanup
retains a renderer-scoped record and checked receipts. Native and
forwarded admission retry failed unreferenced records before new native
work. Intentional references do not block admission. Image/buffer cleanup
preserves rejected ownership and removes accepted entries individually;
local/native deletion receipts likewise never replay accepted members.
A hidden installed executable is unbound before native deletion, including
when an earlier unbind failed after logical state retirement.

A further regression fails the initial implementation when registry retry
has already completed cleanup but releasing the original token still
captures errors from and invalidates a newly selected peer. Completed cleanup tokens now
release without native work or peer error reads. The raw TypeScript audit
also exposed two existing missing textureViews fields in the muxer owner
type; the shared owner type now names this optional map explicitly.

| Check | Exact evidence |
|---|---|
| Before-source native lifetime | Three cases fail unchanged `67e5275ea7` at premature deletion; `graphics-execution-lease-baseline.log` |
| Completed-token regression | One selected case fails the initial uncommitted model; 14 other cases intentionally filtered, not counted as passing; `graphics-execution-lease-retry-baseline.log` |
| Complete graphics source gate | 664 cases in 29 files pass without skips, including 15 context-execution cases; `graphics-execution-lease-host.log` |
| Node/browser canonical host build and declarations | Passed; `graphics-execution-lease-build.log`, `graphics-execution-lease-declarations.log` |
| Extra raw tsc | Still fails: 42 diagnostics versus the previous 44. The two missing textureViews diagnostics are resolved; the existing GlBinding mismatch now names the owner alias; other first-line messages agree ignoring offsets; `graphics-execution-lease-tsc.log`, `graphics-execution-lease-tsc-comparison.txt` |
| Retained/replacement rendering and controls | All 30 selected cases pass across Chromium/Firefox/WebKit without skips, including six new execution cases and all prior 24 controls; `graphics-execution-lease-browser.log` |
| Evidence inventory | All 600 files agree; `graphics-execution-lease-registry.log` |

The six new browser cases render red into old storage, blue through a
replacement public context, and green through the retained old execution.
They preserve replacement pixels/errors and require exact old-resource
deletion with and without a rejected local-container cleanup. All prior
24 owned-allocation, snapshot and actual-C core/KHR fence controls remain
selected. Fixtures use independent device storage and source identities,
not normal rebuilt guest EGL/GLIO or whole-machine reclamation evidence.

The full baseline remains incomplete. Borrowed BO allocation retention,
per-work immutable draw/read selection, ordered dependency ownership,
queries, presentation, cancellation and fence placement remain necessary
for nonblocking eglWaitSync. Normal SDK/kernel/program/package/image
builds, upstream CTS, cage/sway, complete browser-memory and required POSIX
remain deferred/unrun. ABI 54 and GL operation table 17 stay fixed.


### Checked GPU allocation and borrowed surface storage leases

Three new regressions fail unchanged `3e28c24078`: native storage errors
still publish a public GPU BO, retry after a later deletion failure repeats
accepted framebuffer/renderbuffer deletion, and a copied borrowed-surface
lease cannot keep native allocation alive after public BO retirement.
The baseline intentionally selects only these three cases; ten existing
GPU cases are filtered, not passing coverage.

GPU allocation now prevalidates identifiers/dimensions and rejects a
conflicting renderer or size for an existing BO. A private native receipt
owns every candidate before creation. Checked allocation, storage setup,
completeness and restoration of selected texture/renderbuffer/read/draw
state precede publication. Failed selector restoration keeps candidates
and native inverses reachable and blocks dependent allocation until repair.
The kernel import captures selected-owner flags before private utility
work and refuses creation if that capture fails. IDs do not wrap.

Canonical allocation retirement uses ordered native receipts: failed
container deletion preserves the texture backing, and accepted prefix
members become null rather than replaying on retry. Failed unheld
retirement stays hidden from BO lookup and target selection while its
private record supports retry. This preserves the existing backing-lifetime
assertions, rather than weakening them to allow independent later deletes.

GPU-backed surfaces now carry a native-only allocation description. The
same surface storage lease covers owned targets and borrowed GPU BOs.
Public BO destruction can finish while an explicit reference keeps old
storage usable; a new BO with the same numeric ID has independent storage,
texture identity and retirement. Existing references may clone after
retirement, while new public acquisition is refused. Raw-view retirement
also discovers groups retained only by old execution leases after public
context replacement. Kernel BO authority and KMS scanout authority remain
separate from these native allocation holds.

| Check | Exact evidence |
|---|---|
| Before-source regressions | Three fail unchanged `3e28c24078` at native error/publication, replayed deletion and premature borrowed allocation deletion; `graphics-gpu-allocation-baseline.log` |
| Full source host selection | All 681 cases in 29 files pass without skips, including 17 new GPU allocation/lifetime/import/group cases; `graphics-gpu-allocation-host.log` |
| Node/browser canonical build and declarations | Passed; `graphics-gpu-allocation-build.log`, `graphics-gpu-allocation-declarations.log` |
| Extra raw TypeScript audit | Still fails with the same 42 first-line diagnostics, ignoring line/column offsets; none added or removed; `graphics-gpu-allocation-tsc.log`, `graphics-gpu-allocation-tsc-comparison.txt` |
| Borrowed allocation rendering and controls | All 36 selected cases pass across Chromium/Firefox/WebKit without skips: six new GPU cases and all prior 30 controls; `graphics-gpu-allocation-browser.log` |
| Test inventory | All 600 files agree; `graphics-gpu-allocation-registry.log` |

The six new browser cases preserve old red and replacement blue pixels,
retire public surfaces/context and the replacement BO, render green into
the retained old allocation, then require exactly one deletion per old
native member. Cases include a rejected texture deletion and correct
selected-peer error ownership. All prior 30 source rendering controls stay
selected. They use real WebGL pixels and independent device buffers, with
source registry identities rather than normal guest ioctl marshalling.
Forwarded BO-source registration, CPU/GPU coherence, complete guest BO
lifecycle, browser-memory and compositor evidence remain open.

The initial expanded source gate reported five failures. Two renderer
doubles lacked required getError/active-texture results; those doubles now
supply the native contract. Restoration retains the existing draw/read
order. Ordered cleanup preserves the original canonical-backing assertion
after rejected framebuffer deletion. No original assertion was removed or
weakened. Later final results apply to the corrected combined source.

These allocation holds do not enable queued server waits. Immutable
per-work draw/read selection, dependencies, query/presentation ordering,
cancellation and ordered fence placement remain implementation work.
Other baseline inventory gaps and normal graphics artifact builds,
upstream CTS, cage/sway, complete browser-memory and required POSIX gates
remain open/deferred. ABI 54 and GL operation table 17 stay unchanged.


### Rebuild/test phase authorized on 2026-10-24

The user explicitly lifted the expensive rebuild/test deferral and asked
for normal builds and actual cage/sway sessions now. Earlier deferred
statements above are historical; normal provisioning, compositor tests
and broader required validation are now authorized. The full graphics
baseline remains the objective, including its still-open implementation
inventory. Per-work drawable selection/server waits were not enabled
before this phase change.

A fresh fetch confirms origin/main remains
`5cd771bff889bb0d5c4b672a54c0edcffa691066`, ABI 53. Build source starts at
`6aacd4111b4105ac08c204b376ba933af1bc4db5`, ABI 54, GL table 17. Main is
already integrated. The branch name and both contributor histories stay
unchanged. No new ABI number is allocated for the phase.

Initial normal provisioning uses the declared dev shell and xtask
bootstrap/local-build paths, the ordinary shared SourceOnly cache and
12 graph workers. It selects kernel, cage, sway, swaybg, dash, bash,
wayland-demo, foot and rootfs, then host and developer/test programs.
Automatic shared-cache collection is disabled for these runs. Missing
artifacts remain provisioning work. Full browser images and conformance
follow the selected compositor closure; no artifact is manually restamped.

Jobs started from this source:

- `graphics-compositor-normal-build-1024-204258-2e37`:
  `.context/graphics-compositor-build.sh`; normal provisioning/build.
- `graphics-combined-rust-1024-204339-bab4`:
  workspace Rust tests excluding xtask, on the declared host target;
  `.context/graphics-combined-rust.log`.

No successful normal build, guest CTS, compositor session or full memory/
POSIX result is claimed by recording these starts. Results and repairs
must be recorded after the exact jobs finish and their scope is inspected.

Workspace Rust validation has now completed: all 3,135 tests pass across
44 result groups, excluding xtask, with no failures, ignored or filtered
cases. The command and log are named above. This is combined Rust evidence,
not compositor or guest graphics evidence. Normal provisioning is still
running; package recipes have reached compositor linking/instrumentation.

The selected SourceOnly graph completed successfully: all 59 package
nodes were published, including kernel, rootfs, wlroots, cage, sway,
swaybg, foot and the declared dependency closure. Exact machine result:
`.context/graphics-compositor-build-result.json`. Host build/declarations
then completed; the same job is still building normal developer/test
programs and their additional dependencies. The graph result does not
claim that the subsequent fixture phase has finished.

An early prepared-product run exercises only the already-published
wlterm/foot/cage closure through the real Node kernel. It omits unrelated
Vitest global fixture compilation because the normal program builder is
still running; this is not the complete default-config consumer gate.
Both wlterm cases passed: typed input/shell output and signal-death status.
Foot's file initially failed to load at the removed hasSession helper:
`.context/graphics-compositor-early-node-before.log`. Its test now uses the
existing mandatory requireSession/resolveBinary contract, retains all
session/input/exit assertions, and fails on missing artifacts. All three
cases in both files now pass without skips:
`.context/graphics-compositor-early-node.log`, exact job
`graphics-compositor-early-node-fixed-1024-205729-fdc4`.

Normal browser-main-shell image and graphics-cts-egl package provisioning
has started as `graphics-compositor-browser-normal-build-1024-205824-05a0`,
with eight graph workers, reusing the completed compositor closure. The
new graphics-cts-egl.spec.ts runner collects on Chromium/Firefox/WebKit:
`.context/graphics-cts-browser-inventory.log`. Collection is not execution.
The runner boots the normal packaged guest through BrowserKernel and the
real kernel/WebGL path, requires every advertised GLES2 config to pass,
and keeps the pinned upstream assertion method unchanged. No guest CTS
or browser compositor pass is claimed yet.

The normal graphics-cts-egl package was published and the real rebuilt
upstream surfaceless-context subset now passes in all three engines:
Chromium 153.0.8010.12, Firefox 155.0 and WebKit 26.6. Each run creates an
ES2 context for the one advertised EGL configuration and reports
`CTS-SUBSET PASS surfaceless_context configs=1`. This is the pinned subset,
not complete EGL/GLES CTS. Exact job:
`graphics-cts-rebuilt-browser-evidence-1024-210433-fac3`;
`.context/graphics-cts-browser.log` and per-engine
`.context/graphics-cts-guest-{chromium,firefox,webkit}.json` contain output,
engine versions and SHA256 identities. Program SHA256:
`8d46e20871465b4175c834fa05fd2910369a3f1e681c286101c52ffd528d18fd`;
kernel SHA256:
`4f133a2ef431683cfe5ab1f9a6ff26beae40d382404e47dda125d6530287e9a5`.

ABI snapshot/C/TypeScript agreement, binary-bundle resolver tests and the
600-file Vitest evidence registry also pass:
`graphics-rebuilt-abi-1024-210633-324f`, with separate ABI/resolver/registry
logs under `.context/graphics-rebuilt-*.log`. There is one normal wasm32
kernel serving both guest widths. An attempted `bootstrap kernel64`
selection was a runner mistake: no such package is declared. It does not
identify a platform boundary or substitute for wasm64 guest validation.

The standalone rebuilt consumer gate now proves two Chromium cage GLES2
cycles: normally packaged wlterm/bash render actual terminal pixels,
receive typed input, update their output, exit zero, release KMS ownership
and restart in the same kernel. It checks the upstream GLES2 renderer log,
program-owned GL scanout, visible pixel changes and browser memory-message
boundaries. Evidence: `.context/cage-chromium-guest.json` and two
`.context/cage-chromium-*.png` screenshots. Sway initializes the same GLES2
renderer and modesets successfully, but its configured terminal has not
appeared; that failure is under investigation. The initial standalone
fixture also used the wrong wlterm resolver path; correcting it to the
package-owned wayland-demo path exposed the actual consumer results.
Neither this minimal test image nor the passing cage case replaces the
full normal gallery-image, other-engine, memory and POSIX gates. Both
larger build jobs remain live while these earlier checks run.

### Rebuilt compositor endpoint repair and three-engine evidence

The failing sway child did fork and exec successfully, then exited one
with `kwl_window_create failed`. Kernel process events and the final
process table are in `.context/sway-chromium-final-state.json`. Sway uses
its normal `WAYLAND_DISPLAY=wayland-1`, while libkwl unconditionally tried
`/tmp/wayland-0`. This is an in-tree toolkit endpoint-selection defect,
not a fork failure or demonstrated platform boundary.

Libkwl now delegates endpoint selection to libwayland when any of
WAYLAND_DISPLAY, WAYLAND_SOCKET or XDG_RUNTIME_DIR is present. Explicit
endpoint failure does not fall back to another compositor. The original
environment-free desktop connection and startup retry remain. No sway
socket name is embedded in the implementation. The normal wayland-demo
package includes this declared source input and was rebuilt through SDK,
private sysroot, fork instrumentation and SourceOnly publication.

The first rebuild's finalization rejected a package/identity key mismatch.
A header documentation edit briefly changed a declared input during that
run; it was undone. Holding inputs stable, the normal retry succeeded:
`graphics-libkwl-stable-rebuild-1024-212538-2368`. No cache entry was
hand-deleted or artifact restamped to bypass the rejection. The full shell
image started before this source change must be refreshed afterward.

All six standalone consumer tests now pass, each with two sessions in one
kernel, for twelve real GLES2 sessions across Chromium 153.0.8010.12,
Firefox 155.0 and WebKit 26.6. Exact job:
`graphics-libkwl-three-engine-consumers-1024-212720-b9e0`;
`.context/graphics-rebuilt-consumers-browser.log`. Each session requires
native GLES2/program-owned scanout, actual rendered input updates, exit
zero and KMS master release. The first cycle also rejects a deliberately
missing explicit Wayland endpoint while the valid compositor is live.
There are no page errors or memory-message boundary violations. The image
stages normal swaybg and coreutils/uname dependencies for sway startup.

Per-compositor/engine JSON evidence is in
`.context/{cage,sway}-{chromium,firefox,webkit}-guest.json`; matching PNGs
are retained for both cycles. Cage renders 130 distinct pixel colors;
sway renders 269. Rebuilt wlterm SHA256:
`b425d3013b03d3a71870882fb41e8ea195151a06bcd0ead027523fdf9ff3cd1d`.
The kernel SHA256 remains the rebuilt ABI 54 identity recorded above.
The prepared-product Node check now also covers sway's configured libkwl
terminal: all four cases in two files pass with no skips,
`graphics-libkwl-early-node-1024-212842-8109`,
`.context/graphics-libkwl-early-node.log`. This still omits unrelated global
fixture compilation; the full default-config consumer run remains next.

These passing normal-package tests are substantial compositor evidence,
but do not establish full gallery foot/bar/tiling behavior, complete
browser-memory, POSIX conformance or the complete graphics inventory.

The first full libc run found `functional/spawn` returning ENOEXEC from
posix_spawnp of its echo helper. Inspection proves the helper and its
owned runner copy were ABI 56, while the rebuilt kernel is ABI 54:
`.context/graphics-libc-echo-old-abi56.json`, exact inspection job
`graphics-libc-echo-inspect-1024-212819-691b`. The runner skipped helper
compilation solely because its wasm mtime exceeded echo.c's mtime. This
is stale test provisioning, not a demonstrated kernel spawn defect.

The libc runner now compiles that helper through the SDK on each run and
stamps only the successfully linked output with the current ABI contract.
The focused upstream spawn case passes after this repair:
`graphics-libc-spawn-recheck-1024-212920-5b50`,
`.context/graphics-libc-spawn-recheck.log`. Helper and copied fixture now
both report ABI 54 without artifact-policy failures; their SHA256 is
`d5f1215b386ab3a78d8f10cee94bf9eed3a49d75c5c2d0ddaf22d73d048cf9ec`.
This does not relabel the earlier full run as passing. That run continues
through its remaining cases; complete corrected libc evidence remains due.

Full libc, Open POSIX and all Sortix suites are tracked sequentially in
`graphics-rebuilt-posix-1024-212000-0516`; separate logs and exit statuses
are under `.context/graphics-rebuilt-{libc,posix,sortix}.log` and
`.context/graphics-rebuilt-posix-status.txt`. Sortix uses a pristine clone
of pinned commit `7e8f0082ab0b58ad3383a8abbf47dc4b40dcf25d` on the existing
case-sensitive volume at `/Volumes/KandeloCaseBuild/moscow-graphics-os-test`.
The worktree's pre-existing Sortix submodule state remains untouched.

### GPU retirement and completed pre-integration validation

The kernel's last-reference BO destroy callback now retires native GPU
storage directly. GPU allocations have no CPU BO registry entry, so the
previous CPU-registry event listener never received their destruction.
The focused callback regression fails before this repair and passes
afterward, including duplicate-destroy protection:
`graphics-gpu-destroy-before-fix-1024-215251-3d26` and
`graphics-gpu-destroy-fix-checks-1024-215342-00de`.

Canonical BO retirement also waits for pending native-view cleanup when
storage redefinition has already removed the last public view name.
The three-engine before comparison fails at the canonical-backing
retention assertion, independently of the callback regression. With both
repairs, all 39 rendered source-contract cases pass across Chromium,
Firefox and WebKit, including the complete logical-image worker and its
final destruction through the real host callback:
`graphics-gpu-destroy-browser-after-1024-215948-35d3`;
`.context/graphics-gpu-destroy-browser-after.log`. These are native WebGL
source-harness tests, not complete guest CTS or gallery-image evidence.
The corresponding source run passes 683 tests in 29 files, declaration
checks and the 600-file evidence registry:
`graphics-gpu-destroy-final-source-1024-220109-89b3`.

The corrected normal Node consumer run passes all 30 cases in 16 files,
with no load failures or skips:
`graphics-gpu-final-canonical-node-1024-220659-8de0`;
`.context/graphics-compositor-node.log`. Earlier failures exposed invalid
fixture requests: connector IDs must come from GETRESOURCES, a modeset
requires its connector list, an import producer must release DRM master,
and a native-window test must request the advertised ES2 configuration.
The fixtures now make those valid requests and retain negative cases.
Stateful GL doubles preserve native allocation/ownership assertions;
the dma-buf guest now compiles and links shaders before looking up its
uniform. Normal package resolution remains unchanged. Developer fixtures
use the default resolver policy; explicit SourceOnly policy excludes
those unowned fixtures and was an incorrect runner selection.

Corrected full conformance results, before integration of PR #1581:

| Suite | Pass | Expected failure | Skip | Other expected result | Unexpected failure/build/timeout |
|---|---:|---:|---:|---|---:|
| libc-test | 306 | 17 | 0 | 1 known FLAKE-PASS | 0 |
| Open POSIX | 174 | 3 | 2 | none | 0 |
| Sortix, all declared suites | 5065 | 23 | 50 | none | 0 |

Exact jobs are `graphics-libc-full-stable-1024-213955-009a` and
`graphics-rebuilt-posix-1024-212000-0516`; logs are
`.context/graphics-libc-full-stable.log`,
`.context/graphics-rebuilt-posix.log` and
`.context/graphics-rebuilt-sortix.log`. The earlier libc attempt remains
invalid: its stale ABI helper failed, and editing its running shell
script caused a later syntax error. The separate stable full run supplies
the corrected libc result; the outer job still records its earlier
nonzero libc status. These selected suites do not prove all POSIX.

Sway's Node semantics pass, but a focused public syscall/lifecycle trace
still reproduces an intermittent swaybar worker forced drain. Its last
observed operation is a status-pipe read. This remains an ordinary
lifecycle investigation, not a demonstrated runtime boundary:
`graphics-swaybar-syscall-teardown-trace-1024-220659-e38e` and
`.context/sway-node-teardown-e0e65e179945.json`. The full browser-memory
gate now includes a rendered sway/foot cycle; only its nine-case
collection has been checked so far.

The user requested a quiet performance window, so the remaining normal
browser-main-shell build was stopped in place. PR #1581 subsequently
merged as `7dfe4b501e93448aa6da8151d3ee1948cf1e1e2b` on October 25.
Before integrating that main revision, the old paused build was cancelled
with SIGTERM (recorded exit 143), preserving managed cache entries.
All results above describe the pre-integration implementation. The
combined main/graphics implementation still needs regenerated ABI
outputs, normal artifacts, guest compositor/CTS reruns and the full
gallery/memory gates. The complete baseline inventory remains open.

### Main integration after PR #1581

The merged source now combines main `7dfe4b501e93448aa6da8151d3ee1948cf1e1e2b`
with graphics under ABI 55 and fork-state version 21. Both thread-exit
cleanup paths remain: Rust wait retirement and GL current-context release.
Main's executable admission, signal/child wait semantics, lazy image
ownership and newer resolver paths are retained. The deleted browser
lazy-file table stays deleted; cage/sway remain in the image recipe.

The initial host declaration build exposed an obsolete graphics-branch
cleanup of the removed host `waitingForChild` list. The cleanup is now
owned by main's actual Rust process-exit transitions. The three old host
list regressions were migrated to a Rust matrix covering wait4/waitid,
normal exit, SIGTERM and SIGKILL, with an unrelated live waiter preserved.

ABI snapshot/C/TypeScript regeneration and standalone resolver tests pass:
`.context/graphics-main-abi-update.log`,
`.context/graphics-main-resolver-test.log`. The corrected canonical host
build and 680 source graphics tests in 29 files pass:
`graphics-main-host-checks-1025-195152-2a1e`. The current evidence registry
agrees with all 612 inventoried files. The separate host lifecycle source
selection passes 41 cases: `.context/graphics-main-lifecycle-source.log`.
The combined native Rust workspace selection, excluding xtask, passes
3,226 cases, including the migrated retirement matrix:
`graphics-main-rust-1025-195316-2b6d`, `.context/graphics-main-rust.log`.
These results do not validate normal ABI 55 guest artifacts or rendered
compositor/memory behavior. Those rebuilds and gates remain next.

The five graphics package ABI floors (cage, sway, wlroots, libwayland
and graphics-cts-egl) now require the combined ABI 55 contract. Their
normal resolver rebuild is starting from this integrated source.


### Combined ABI 55 guest and conformance checkpoint, 2026-10-25

The following results use integrated source `b2c914c74f08`, main
`7dfe4b501e93`, ABI 55, operation table 17 and fork record version 21.
They supplement the source checks above. Historical ABI 54 results remain
separate evidence.

- The normal selected SourceOnly graph finished **59/59 nodes** before
  the subsequent developer-program phase failed. Exact job:
  `graphics-main-compositor-build-1025-195724-ca52`; machine result:
  `.context/graphics-main-compositor-build-result.json`. SDKs and canonical
  host outputs were built through the normal bootstrap path. This does
  not establish that every developer/test program has been rebuilt.
- Rebuilt guest validation passed **9/9 tests** across Chromium
  153.0.8010.12, Firefox 155 and WebKit 26.6. Exact job:
  `graphics-main-guest-browser-1025-202313-203f`; log:
  `.context/graphics-main-guest-browser.log`. Three runs execute the
  pinned upstream surfaceless EGL subset, covering every advertised ES2
  configuration (one per engine). Six compositor tests execute two
  cycles each: **12 actual GLES2 cage/sway sessions**, rendered pixels,
  input, exit status zero, KMS master release and restart. Deliberately
  missing explicit Wayland endpoints are refused. This is standalone
  guest integration evidence, not full gallery or broad CTS coverage.
- Exact ABI 55 per-engine JSON records and successful cycle screenshots
  are under `.context/graphics-abi55-evidence/`, named
  `{cage,sway}-{chromium,firefox,webkit}-guest.json`, corresponding
  `-0.png`/`-1.png`, and `graphics-cts-guest-{engine}.json`. Original
  per-engine filenames outside that archive retain the historical ABI 54
  evidence cited above. The archived `sway-startup-test-failed-1.png`
  remains a failed-attempt artifact, not a successful-cycle screenshot.
- The combined source-browser gate passed **39/39** contracts across
  the same engines: native/forwarded fences, actual C traces, retained
  images, command snapshots, replacement contexts/surfaces, BO reuse and
  cleanup retries. Exact job:
  `graphics-main-source-browser-1025-202619-3880`; log:
  `.context/graphics-main-source-browser.log`. This harness supplies
  synthetic kernel authority; it is distinct from the real guest runs.

Guest SHA256 identities:

| Artifact | SHA256 |
|---|---|
| Kernel | `128b1df4581cf2a14c840aba237ae74238997db9d7af513ce71fe55b85c72da2` |
| graphics-cts-egl | `e3fa183764b8a77ed5c82ac93da933c775cd7a40c42c5a1d7d014e5a340286bd` |
| cage | `23abcb8fee3b9e55264c0ae14198adfc2221c78946e384721abb4b19972d0d87` |
| sway | `7b35bc94e886bf20e66b391cc8e3e19975478c108ac138bb11f33e240fc7dfc3` |
| wlterm client | `6b61f5601dc4a25f3e682358e11962f79cbec212d2d505aa4363a02c96b50053` |

The stable combined conformance job is
`graphics-main-posix-1025-202921-b805`. OpenPOSIX completed with **174
passes, three expected failures and two skips**, no unexpected failure,
build failure or timeout; log `.context/graphics-main-posix.log`.
Libc-test completed with **305 passes, 17 expected failures, one known
FLAKE-PASS and one unexpected timeout**, `regression/raise-race` at the
unchanged 30-second limit; log `.context/graphics-main-libc.log`. The full
libc result is a failure. A separate normal focused invocation,
`scripts/dev-shell.sh bash scripts/run-libc-tests.sh regression raise-race`
with the same SourceOnly root, passed one test; log
`.context/graphics-main-raise-race-focused.log`. This does not explain the
original timeout or turn the full suite green. Load sensitivity remains
a hypothesis. The Sortix portion was later stopped with exit 143 after
a mixed-input incident described below; no combined Sortix pass is
claimed.

The normal developer-program build stopped while instrumenting
`gtk3_smoke.raw.wasm`: **activation has no ordinary call landings**.
The failure remains recorded in the normal-build job above. A separate
linker warning identifies inconsistent GTK `_gtk_get_slowdown` function
prototypes. An isolated normal GTK package rebuild with upstream
[022c36a1379d82b4212a298ed6eaec02bc0ed7f1](https://github.com/GNOME/gtk/commit/022c36a1379d82b4212a298ed6eaec02bc0ed7f1)
passes and removes that warning from a fresh smoke-program link. Its
instrumentation is still running. This proves the source prototype
correction, not that the warning caused Kandelo's planner failure.
Diagnostic-only comparison of all 29,474 functions found no direct-call
disagreements between the scanner and function IR. The isolated jobs are
`graphics-gtk3-prototype-sdk-1025-214322-213d`,
`graphics-gtk3-prototype-smoke-1025-214916-b1fe`, and
`graphics-gtk-scan-compare-1025-215300-7177`.

The full normal browser image is still building as
`graphics-main-browser-image-build-1025-202123-8896`. Default-config Node
consumers, gallery behavior and required browser-memory execution remain
pending. Per-work drawable selection, server-wait ordering and the other
open baseline inventory items remain ordinary implementation work.


### Tail-only activation reproduction and interrupted Sortix attempt

A small WAT module reproduces **activation has no ordinary call landings**
with the unchanged normal instrumenter:
`.context/gtk-mixed-tail-pruning.wat`, binary and failure log with the
same stem. Its root ordinarily calls a helper whose fork branch is
provably dead, then tail-calls a live fork function. Sink refinement
removes the ordinary callee but keeps the root's old ordinary-activation
membership. The continuation planner has no ordinary landing to emit.
Tail transport still needs the root's control membership and tail site.
This is a demonstrated Kandelo implementation defect. Its relationship
to the large GTK failure remains unconfirmed pending the original
function-specific diagnostic.

The isolated GTK checkout now filters ordinary-activation membership
against retained direct-call targets after control refinement, while
preserving conservative indirect/reference landings and live tail
transport. A new production-API regression fails before the change with
the exact error and passes afterward for direct, indirect and reference
tail calls. It validates emitted Wasm as well as selected control,
activation and tail-site sets. Logs:
`.context/gtk3-prototype-check/.context/gtk-mixed-tail-before.log` and
`gtk-mixed-tail-after.log`. The complete instrumenter suite is running
as `graphics-tail-refinement-rust-1025-222312-0d61`. This correction has
not yet been integrated into the primary branch or used for a normal
program/package pass.

An initial after-change check was accidentally launched from the primary
checkout. It selected zero tests and ran package-wide rustfmt, briefly
changing five pre-existing instrumenter files. Those exact own changes
were restored to HEAD; the formatting-only diff is preserved in
`.context/unintended-primary-rustfmt.diff`. The zero-test run is not
validation of the isolated correction. The real focused check was then
run in the isolated checkout and passed one test with three tail forms.

Live Sortix wrapper preparation observed the temporary input-hash drift
and invoked instrumenter rebuilds. That attempt cannot establish a final
coherent-tool result. Its exact tracked script and captured descendants
were stopped; `.context/graphics-main-sortix-mixed-input-stop.json`
records the process identities. The outer conformance job terminated
with exit 1 after 1h54m, retaining `libc=1`, `posix=0`, `sortix=143` in
`.context/graphics-main-posix-status.txt`. Earlier libc and OpenPOSIX
completed before the incident and retain their stated results. Sortix
must be rerun with stable final inputs; no claim is inferred from its
partially built wrappers. The browser-image build and original GTK
instrumentation processes use already-loaded native tools; audit their
final tool identities before using their outputs as combined evidence.

Separately, all **38 cache-GC unit tests passed** on integrated source,
including the above-ABI filtering, live-root/recent-use/build-lock
protection, overflow and invalid-argument cases. Exact job:
`graphics-main-cache-gc-focused-1025-220632-a590`; log:
`.context/graphics-main-cache-gc-focused.log`. These tests use temporary
caches. No collection was applied to the shared cache.


### Full gallery results and default Node provisioning failure

The pre-instrumenter-repair browser-image job
`graphics-main-browser-image-build-1025-202123-8896` completed with exit
zero after 2h17m, including normal graphics CTS, browser-main-shell,
rootfs and freshness checks. The subsequent full gallery job
`graphics-main-gallery-1025-224044-35c7` passed **9/9 tests** across
Chromium, Firefox and WebKit. Log `.context/graphics-main-gallery.log`
records cage terminal input/rendering and sway foot terminals, status-bar
updates, workspace changes, tiling, clean exit and restart, plus the EGL
surfaceless subset. These supplement the earlier standalone guest runs.
They use the pre-repair instrumenter artifacts; final repaired-source
artifacts still need their own normal build and combined validation.

The default-config Node gate, with normal global fixture setup, failed:
**23 cases passed in 11 files; five of 16 files did not load; no cases
were skipped**. Exact job `graphics-main-default-node-1025-224348-9386`;
log `.context/graphics-main-compositor-node.log`. Artifact policy refused
four old developer binaries: `wlclient-test`, `kwldemo`,
`kms-pageflip-smoke` and `libdrm-kms-smoke`. The normal instrumenter's
read-only identity report confirms **ABI 54** for all four:
`.context/graphics-main-stale-node-artifacts.jsonl`. Their rebuild occurs
after GTK in the interrupted normal program builder. This is unfinished
provisioning caused by the build failure, not a compositor boundary and
not a passing default Node gate. The passing cases include cage/sway
wlterm input, signal-death reporting and foot on cage.

The original large GTK diagnostic finished with exit one after 45m24s
and identifies function 29105, `__res_msend_rc`, type 14, as the first
selected activation without ordinary landings. Source inspection is in
`.context/gtk-failing-function-29105.log`; this function has no source
tail calls. The small tail-path reproduction demonstrates stale
activation classification, but does not alone explain why this DNS
helper remained selected. The GTK-prototype correction with the old
instrumenter also failed after 44m23s with the same planner error. Thus
the upstream getter prototype correction alone does not fix Kandelo's
instrumenter failure.

The isolated ordinary-activation correction, commit `a46e133b679d`,
passed all **447 fork-instrument tests**, no ignored tests, and its
release build. This includes the existing Node replay tests. Exact job
`graphics-tail-refinement-rust-1025-222312-0d61`; log
`.context/gtk3-prototype-check/.context/tail-refinement-full-rust.log`.
The corrected normal instrumentation of the freshly linked GTK guest is
still running as `graphics-gtk3-tail-fixed-smoke-1025-222658-ebe0`; no
large GTK pass is claimed yet. The upstream package patch retains
Emmanuele Bassi's authorship in isolated commit `486b740dce24`.

The required browser-memory front door has started as
`graphics-main-browser-memory-1025-224956-c632`:
`scripts/dev-shell.sh env KANDELO_CACHE_GC_AUTO=0 KANDELO_PLAYWRIGHT_PORT=5490 ./run.sh test browser-memory`.
It prepares the complete normal browser products and owns its test
server. Execution, not collection, is required before claiming repeated
machine/device reclamation. No browser-memory pass is claimed yet.


### Repaired-source build and memory-audit checkpoint

The normal GTK instrumentation job
`graphics-gtk3-tail-fixed-smoke-1025-222658-ebe0` completed successfully
in 24m16s, using the default post-optimization path and producing
`.context/gtk3-smoke-tail-fixed.wasm` (22 MiB). The upstream GTK patch and
ordinary-activation correction are now integrated as `3b8a717492` and
`5b168b28ea`, preserving Emmanuele Bassi's authorship. Attribution and
patch equivalence were checked with range-diff:
`.context/graphics-gtk-fix-attribution-range-diff.txt`. ABI stays 55.
This isolated producer success repairs the observed instrumentation
failure; the primary normal developer-program rebuild remains required.

The first required browser-memory gate terminated with exit one after
16m28s, before browser switching. All normal browser products and the
host built; the host selection had **158 passes and two failures out of
160**, with no skipped or unloaded cases. Exact job:
`graphics-main-browser-memory-1025-224956-c632`. Its log records 46
unreviewed authority sites and an obsolete graphics-registry test double.
No browser-cycle, cross-engine teardown or reclamation pass is inferred.

The audit coverage and assertions remain unchanged. Each of the 43
native replay-fixture construction sites, two standalone artifact-check
sites and the new GL surface-reply destination has an explicit reviewed
key and owner. The surface import receives Rust's mutable fixed-size
wire Vec, authenticates its generated capacity before renderer effects,
and consumes the bounded reply token synchronously. One catalogue
fixture now names its imported Wasm instance before selecting the root
export, so the audit can track a stable instance owner.

The teardown regression now uses the real GL registry with two sessions
for the exiting process. It retains the existing device-release and
canvas-handoff assertions and checks both canvas and command-buffer
aliases are cleared. Its first repaired run passed teardown but still
rejected the catalogue's anonymous authority origin; the subsequent
attempt repeated that failure because a patch precondition failed and
made no source change. Both attempts remain in their logs:
`graphics-memory-source-repaired-1025-231933-ced5` and
`graphics-memory-source-repaired-final-1025-232304-5981`. Neither was
reported as successful validation.

After the actual fixture binding change, all **11 targeted source
checks pass**, with no skips or load failures:
`graphics-memory-source-audited-1025-232506-f762`, log
`.context/graphics-memory-source-audited.log`. Both actual native
catalogue replay tests also pass:
`graphics-native-catalog-bound-1025-232506-6f86`, log
`.context/graphics-native-catalog-bound.log`. These are bounded repair
checks. The complete required memory gate, normal Node gate and stable
Sortix conformance still need rerunning against the repaired inputs.

### Repaired-source normal program build and fresh libc result

The stable normal build at `d3a69caa8617` completed with exit zero after
55m37s: `graphics-final-ports-build-1025-232951-f945`. The selected package
graph succeeded on all 59 nodes. Normal fork-instrument, wasm32 SDK,
wasm64 sysroot, host, developer programs and side modules completed, and
`verify-fresh` passed. The program log is
`.context/graphics-final-programs-build.log`; the selected graph report is
`.context/graphics-final-ports-build-result.json`. This establishes that
the integrated instrumenter repair works in the ordinary GTK and full
program build, beyond the earlier isolated GTK instrumentation pass.
The earlier stopped builder and stale-ABI Node failure remain evidence of
those attempts. A new default Node consumer run and complete memory gate
are still required.

Fresh conformance from a clean, private checkout of `d3a69caa8617` has
completed libc-test: **306 passed, 17 expected failures, one known
FLAKE-PASS, zero failures, build failures or timeouts; 324 total**.
`regression/raise-race` passed in this full run. The prior timeout remains
recorded: its cause has not been established. The exact outer job is
`graphics-final-conformance-1025-233522-ba0a`; its libc log is
`.context/gtk3-prototype-check/.context/final-libc.log`. Open POSIX and
Sortix have not yet completed in this attempt.

K03 implementation continues in a separate owned scratch checkout while
these artifact and conformance inputs remain frozen. Actual Rust ioctl
regressions reproduce an inherited GEM handle remaining accessible after
child removal, and PRIME reimport creating a duplicate handle. A shared
namespace/allocator and final-namespace-close repair passes 2,589 kernel
unit tests plus six compile-fail documentation tests in that checkout.
These changes are not yet integrated into this branch or validated with
normal guest artifacts; they are not part of the build result above.

### Fresh default Node consumer gate

`graphics-final-default-node-1026-002616-001a` completed with exit zero in
9m26s on `0eaadecf5c36` (runtime/package source `d3a69caa8617`): **31 tests
passed across all 17 selected files, zero skips, zero unloaded files**.
The normal resolver policy and global fixture setup ran. This includes
cage, sway tiling/status bar/config-error UI, wlterm on both compositors,
foot, libkwl, desktop liveness, KMS modes/page flips/libdrm, GBM/EGL/image
ownership and imported-storage lifetime. GTK also reached its actual
Wayland draw and successful session exit after the normal build repair.
Log: `.context/graphics-final-compositor-node.log`. The printed
`unreachable` is the explicit `trap-owner` lifetime probe, not an
unexpected compositor crash. No forced worker-drain warning occurred.

The GTK fixture in that attempt still caught a rejected host-destroy
promise. Its draw and session exit are evidence; that catch cannot prove
successful teardown. The fixture now awaits destroy without swallowing
errors and requires an empty host-diagnostic list; a new run is required
for that stronger assertion.

Fresh Open POSIX in `graphics-final-conformance-1025-233522-ba0a` has also
completed: **174 passed, three expected failures, two skips, zero
unexpected failures/timeouts/build errors; 179 total**. Its log is
`.context/gtk3-prototype-check/.context/final-posix.log`. Sortix remains
running against the same clean private `d3a69caa8617` source.

### Shared DRM-file GEM namespace and PRIME names

The branch now shares GEM names **and their allocator** across dup,
fork, vfork and spawn aliases. Each namespace entry owns one BO reference,
released by GEM_CLOSE or final namespace close. Independent opens retain
independent namespaces. Fork deserialization temporarily owns a snapshot's
references; prevalidated relinking retires those duplicates before sharing
the parent's live namespace. Spawn no longer adds GEM references for the
shared table. Copied PRIME and cursor sidecars still acquire their own
references. The serialized GEM field sequence remains unchanged.

PRIME reimport on the same DRM file reuses a live handle and does not add
another BO hold. Closing an absent GEM handle returns EINVAL; a missing
MAP_DUMB handle returns ENOENT without changing the reply. These contracts
follow Linux's [GEM handle implementation](https://github.com/torvalds/linux/blob/v6.12/drivers/gpu/drm/drm_gem.c)
and [PRIME file-private import lookup](https://github.com/torvalds/linux/blob/v6.12/drivers/gpu/drm/drm_prime.c).
Snapshot parsing validates the complete namespace and BO reference
capacity before acquiring any of its references; duplicate/zero names,
truncation, missing storage and overflow fail without partial acquisition.

Actual Rust ioctl regressions failed before repair: parent MAP_DUMB
succeeded after child GEM_CLOSE, and PRIME reimport returned handle two
instead of the existing handle one. Jobs are
`graphics-gem-namespace-before-1025-235937-31ac` and
`graphics-gem-prime-before-1026-001733-886b`. Two initial package-name
mistakes did not compile tests and are not behavioral evidence.

Both C probes also failed through the normal SDK, fork instrumenter and
Node host with the unrepaired normal ABI 55 kernel. The source-only
control deliberately selected the primary checkout's normal projection:
`graphics-gem-guest-before-prepared-1026-002419-339a`, log
`.context/gtk-instrument-diagnostic/.context/gem-guest-before-prepared.log`.
Two selected cases failed at the corresponding ioctl/handle assertions;
four existing cursor cases were intentionally excluded by the name filter.
The first provisioning attempt stopped for an uninitialized private musl
checkout and did not run guests. Its retry uses the exact pinned musl
commit, without modifying the user's primary submodules.

The repaired scratch source passed **3,231 Rust workspace tests, zero
ignored**, excluding xtask, in 87 result groups:
`graphics-gem-workspace-final-1026-003310-a953`, log
`.context/gtk-instrument-diagnostic/.context/gem-workspace-final.log`.
This includes actual fork/vfork/spawn/dup ioctl paths, independent opens,
allocator visibility, final close, PRIME removal/reimport, inherited cursor
rollback, framebuffer holds and rejected snapshot acquisition.
The normal repaired-kernel/SDK/rootfs/host run completed successfully:
`graphics-gem-guest-after-1026-003309-f04e`, 9m53s. Its 21-node normal
kernel/rootfs/dash/bash graph, SDKs, host build and freshness check passed,
followed by six C guest cases (the two GEM probes and four existing cursor
lifetime cases), with no skipped or unloaded cases. The two new probes use
strict acknowledged host destruction and require no host diagnostics.

`graphics-gem-browser-1026-004431-47e3` then passed six actual C guest
cases: both GEM probes on Chromium, Firefox and WebKit, in 1m53s. It uses
normal SDK compilation, kernel artifacts, strict teardown and the browser
memory-boundary probe. These are guest ownership checks, not rendered
pixel evidence. Logs are `.context/gtk-instrument-diagnostic/.context/`
`gem-guest-after.log` and `gem-browser.log`. The validated scratch commit
is `496c2c3bb6949fa15fce25de11b1af3fbc985b4c`; nine integrated source
files match byte-for-byte, recorded in
`.context/gem-integrated-source-identities.json`.

The implementation is copied byte-for-byte from the validated owned
scratch source; no ABI bump is added within this unpublished ABI 55
iteration. Existing combined Node/browser/conformance results above
predate this kernel change and remain scoped to their recorded source.
New normal artifact, Node/browser and conformance evidence is required.
K03 remains open for that validation and full DRM-file lifecycle coverage.
KMS master identity is still keyed by process/local slot, and cursor,
client caps, pending flips and events are still copied; those ordinary
K04 gaps are not repaired by sharing GEM names.


## Combined GEM conformance and memory-gate checkpoint, 2026-10-26

The stable combined source `0fe23d85199b` passed the required conformance
runs in an owned checkout with normal SDK/kernel/rootfs/host artifacts:
`graphics-combined-gem-conformance-1026-012902-6adc`, exit zero in 1h22m.
This source includes the integrated PR #1581 behavior, repaired
instrumenter, strict GTK fixture and shared GEM namespace changes.

| Suite | Pass | Expected failure | Skip/known flake | Unexpected failure/build/timeout |
|---|---:|---:|---|---:|
| libc-test | 306 | 17 | One known FLAKE-PASS (`pthread_cond-smasher`) | 0 |
| Open POSIX selection | 174 | 3 | Two declared skips | 0 |
| All Sortix suites | 5,065 | 23 | 50 declared skips | 0 |

Logs, exit statuses and normal product results are under
`.context/gtk3-prototype-check/.context/combined-gem-*`. The libc-test
source is pinned to `790f94c7b6feb8ade25868c10fba46233f783a0b`;
Sortix is pinned to `7e8f0082ab0b58ad3383a8abbf47dc4b40dcf25d` in the
owned case-sensitive source tree. The user's dirty Sortix checkout was
not used or changed. The earlier `raise-race` timeout and stopped mixed-
input attempt remain historical failures; passing reruns do not identify
the timeout's cause.

The required full memory front door
`graphics-final-browser-memory-1026-003944-6a42` finished with exit one
in 2h20m on stable `0fe23d85199b`. Normal browser products and the host
built successfully. The 160 host memory source tests, three Node
lifecycle cases and seven Bun lifecycle cases passed without skipped or
unloaded tests. Six browser exit-trap/probe cases passed across all three
engines. Each switching case stopped at the first cage backend-label
predicate: `innerText` observes CSS-uppercase `WEBGL2-GL`, while the
predicate requires the backend token `webgl2-gl`. The UI's raw text
contains that token. This run did not reach sway, tmux, WordPress or the
remaining cycles and is not a memory-gate pass.

The harness now reads the label's untransformed `textContent`, retaining
the exact backend predicate, four cycles, persistent page/audio realm,
constrained memory profile, pixel/input checks and strict teardown. The
original input command is unchanged. Failing screenshots, traces and
error contexts are preserved under
`.context/browser-memory-label-before-1026/`. A fresh complete gate is
required after this harness correction.

These results do not complete the GLES/EGL/GBM/KMS inventory. In
particular, the isolated KMS file/master/cursor repair is not integrated
into this checkpoint, and ordinary command ordering, server-side sync,
DRM descriptor transfer, pending flip/event admission and broader CTS
coverage remain open.


### Final-source consumer checkpoint and remaining teardown failure

`graphics-combined-consumers-memory-1026-030409-f8f8` ran stable
`8268e0fded82` through the normal default Node resolver. All **33 tests in
17 files passed**, with zero skips/unloaded files, including the strict
GTK destruction assertion. However, swaybar again left a live process
through the cooperative drain deadline, producing the host's explicit
forced-termination warning. Passing assertions do not establish graceful
swaybar teardown. The selected traced control
`graphics-sway-retirement-diagnostic-1026-030835-7899` reproduced the
warning with unchanged runtime source: swaybar PID 104 remained after its
compositor exited, and the 1.5-second drain expired. The follow-up trace
`graphics-sway-retirement-through-destroy-1026-031430-0086` observed a
pthread exit without a process-exit event. This is an ordinary lifecycle
failure under investigation, not a demonstrated engine boundary.

The same combined job then ran nine gallery/CTS cases. Five passed:
cage in all three engines and sway in Chromium and Firefox. The three
CTS cases failed before guest execution because normal browser
preparation omitted that test-support package from the selected source
projection. Normal CTS materialization is required. WebKit sway rendered
its terminals, accepted input, switched workspaces and tiled a new foot
window, but did not display the expected exit-confirmation swaynag band.
That failure remains unresolved; its screenshot is preserved under
`.context/graphics-combined-gallery-before-1026/`. The sequential job
stopped there and did not rerun the memory gate.

The memory switching runtime-error classifier now also rejects the
actual forced-drain and forced-termination messages, alongside its
existing acknowledgement/retirement failures. This closes a harness gap;
it does not repair swaybar or count as a successful repeated memory run.


## Shared DRM master files and cursor grants, 2026-10-26

This increment shares the whole KMS file across fork, vfork and spawn:
client capabilities, cursor storage, framebuffer table, pending flips and
event ring. Master authority uses the containing stable open-description
identity, with a monotonically allocated 64-bit grant for each acquisition.
An inherited alias may use SET_MASTER idempotently without replacing the
grant or presenter. Only the final file alias releases the cursor,
framebuffers and master grant. Independent opens remain independent.

The host receives exact file/grant receipts for master acquisition and
release and the root display's file identity for GL binding. PID is
presenter metadata; retiring its Worker does not revoke a surviving DRM
file. Stale release receipts cannot drop a renewed grant. Cursor protocol
2 carries the grant in a 40-byte record, rejects stale records before BO
lookup and scopes clears to the current grant. It replaces protocol 1
within this unpublished ABI 55 effort; ABI remains one above integrated
main's 54. Regenerated kernel import signatures are recorded in the ABI
snapshot. There is no PID-based authority fallback.

Before-source Rust ioctl tests rejected inherited SET_MASTER with EBUSY
and copied client capabilities instead of sharing them:
`graphics-kms-file-before-1026-005007-1ae5`. The host regression
`graphics-kms-host-owner-before-1026-011506-8942` observed cursor pixels
cleared when the opener Worker retired before Rust released the file.

| Validation of this isolated increment | Result |
|---|---|
| Rust workspace excluding xtask | 3,236 passed, zero ignored, 87 result groups |
| Host graphics source | 682 passed in 29 files |
| Host memory source | 161 passed in 14 files |
| Canonical host ESM/CJS and declarations | Passed |
| Normal SDK32/64, 21-node kernel/rootfs graph, host, freshness | Passed |
| Regenerated ABI and standalone resolver checks | Passed; ABI 55 |
| Actual Node C guests | Eight passed; no skips/unloaded cases |
| Actual browser C guests | 21 passed across Chromium, Firefox and WebKit |

The normal build/workspace job is
`graphics-kms-combined-guest-1026-025228-a5f2`; its first Node run passed
six cases and stalled in the two new probes because their driver addressed
input to an orphan's PID after reparenting. The corrected driver addresses
the registered host input stream, which outlives its opener while the
child retains its read end. It awaits natural opener exit and exact Worker
retirement before releasing that stream. The child then retains master,
reads inherited storage, moves the existing green cursor and exits
naturally. Both Node and browser require acknowledged destruction and no
host diagnostics. The old input-route failure remains in
`.context/gtk-instrument-diagnostic/.context/kms-guest-first-node.log`.

The existing cursor-import C fixture also omitted the producer's explicit
DROP_MASTER before its independent consumer acquired master. The invalid
precondition stopped the first four Chromium cases and one Firefox case;
that repeated run was deliberately stopped (exit 143), not counted as a
pass. The producer now releases only master and retains its storage.
The successful full rerun is
`graphics-kms-guests-master-precondition-1026-031234-fd5b`, 1m24s,
with logs `kms-guest-node.log` and `kms-guest-browser.log` under the owned
scratch `.context/`. Its browser inventory is six GEM ownership cases,
12 actual cursor write-visibility cases and three actual inherited-master
cursor presentations. The new inherited-master cases inspect green
browser pixels after acknowledged opener retirement, not injected host
registry state. The six GEM cases are ownership checks without rendering.

K04 remains partial. This does not prove inherited GLES contexts or every
lost-master presentation path. DRM card/render transfer through
SCM_RIGHTS still returns EOPNOTSUPP. Pending flip admission, bounded event
space and vblank latch timing remain ordinary gaps. The final combined
Node/browser, compositor, memory and POSIX checks must run after this
increment is integrated; earlier results are not combined validation.


## Swaybar text-status EOF repair and current memory failure

The normal CTS package was materialized and the real upstream surfaceless
subset passed all three engines on `078979ddb1a4`:
`.context/graphics-combined-cts.log`. Its artifact hashes and exact engine
versions are under `.context/graphics-abi55-gem-cts-evidence/`. The
subsequent full required memory run
`graphics-cts-memory-refresh-1026-031829-e62f` exited one in 11m33s.
The source/Node/Bun selections and six browser probe/exit cases passed;
all three switching cases reached the end-of-cycle runtime-error check
and failed on actual forced-drain warnings. The labels now work. This is
not a successful repeated-memory result; remaining cycles were not run.

A scalar channel diagnostic narrowed the swaybar control failure:
`graphics-sway-retirement-channels-fixed-1026-032546-b4a8`. Its main
thread's channel was Idle after read(6); only the pthread was parked in
a futex. Waking that pthread cannot finish a main thread spinning in
user code. The temporary diagnostic logging was removed and the normal
host rebuilt. A first diagnostic attempt failed its TypeScript callback
return type; it did not execute the new diagnostic and is not runtime
evidence.

The [upstream sway 1.12 text-status reader](https://github.com/swaywm/sway/blob/1.12/swaybar/status_line.c)
loops on getline until errno is nonzero. POSIX EOF returns -1 with no
required errno; a closed status command therefore causes an unbounded
loop, including a negative buffer index. An empty command can also enter
with zero read length. The unchanged upstream functions reproduce the
failure on the native host, without Kandelo, using the package's new
`tests/check-status-line-eof.sh` scaffolding. The native before run emits
`FAIL: status reader did not return at EOF` and exits one after its alarm;
the patched run passes a live EAGAIN stream plus text and empty-command
EOF. Logs and source SHA are under
`.context/gtk3-prototype-check/.context/sway-status-line-*`. An initial
missing scaffold field caused a compile error and is kept separately;
it is not the before-behavior result.

Package patch 0002 guards the buffer index and handles genuine stdio EOF
without changing nonblocking EAGAIN. The normal recipe runs this native
regression against its verified, patched upstream source in its private
work directory. Its tests are declared build inputs and the output
revision advances from one to two. This is a demonstrated upstream
package defect, not a runtime workaround or a hidden Kandelo POSIX gap.
No upstream report was filed.

The Node sway fixture now requires the final cooperative drain to finish,
instead of accepting successful destroy after its deadline. The old
normal swaybar binary fails that new assertion:
`graphics-sway-eof-before-assert-1026-033806-44f0`, zero of one woken
processes drained. Two other cases were deliberately excluded for this
focused control. The full repaired normal build, three-case Node suite,
three-engine gallery, memory and combined conformance remain required.
The separate WebKit exit-confirmation failure remains unresolved.


## Main program-surface integration and normal regression checkpoint, 2026-10-27

The latest main integration is `cb0a8226c965`. Preserve its Rust SDK driver,
guest-build package path, cleanup-handler instrumentation, completion-drain
behavior, reproducible libc archive paths and program-only ABI digest.
Program ABI 56 and kernel-host version 3 combine that source with graphics;
this is the requested single epoch above current main, not an increment
for each graphics change. Main's batch provisioning job
`main-provision-v2-1027-122133-c324` completed successfully in 2h43m before
starting this checkout's next builds. That job validates main provisioning,
not this graphics branch.

The preceding graphics run
`graphics-kms-ports-validation-1026-034333-3cbd` exited one after 52m19s
on source `14f36676b3`. The normal 60-node selected package graph, full
program build, host build and freshness check completed. The default Node
selection loaded 17 files and ran 36 cases: 34 passed, two failed, none
skipped. The failures were the GPU-tier modifier allocation assertion in
`egl-dmabuf-smoke.test.ts` and the GL error assertion in
`egl-image-ownership.test.ts`. Logs remain in
`.context/graphics-kms-ports-{programs-build,node}.log` and the graph result
in `.context/graphics-kms-ports-build-result.json`. The sequential run
stopped before browser and browser-memory validation. The stricter Sway
cooperative-drain cases passed in this run; that is not a full memory-gate
result.

An additional real inherited-file rendering probe passed its eight Node
ownership cases and three browser cursor cases, but failed EGL context
creation with ENODEV in Chromium, Firefox and WebKit:
`graphics-kms-inherited-render-1026-034915-1aff`. Raw before evidence is
under `.context/gtk-instrument-diagnostic/.context/kms-inherited-render-before/`.
The EGL facade ignores the supplied native GBM device and initializes a
separate render-node identity. That cannot satisfy the exact DRM-file
master authority now enforced by the kernel/host. Correct native-display
association remains an ordinary implementation gap; restoring PID-based
authority or weakening the rendered probe would not fix it. Multiple EGL
displays and retained native-file ownership are under repair. Combined
ABI 56 artifacts, rendered consumers, memory and POSIX validation remain
pending.


The merged ABI generation/check job `graphics-main56-abi-1027-150650-f765`
completed in 56s. It built the current kernel for actual import/export
signatures, regenerated the complete snapshot and C/TypeScript declarations,
rebuilt and checked the standalone resolver, and passed the ABI source and
base comparison checks. Focused snapshot-generation and program-digest unit
checks also passed. This establishes source/ABI coherence, not rebuilt user
programs or rendered consumer compatibility.


Four fresh-worker fixture sources also follow program ABI 56: the two
catch/reference WAT modules, the GC reference-state WAT module and its
checked-in deterministic bytes. The first two compiled and their exported
version functions disassembled to 56; the GC bytes exactly match the
reviewed WAT parsed by the repository's pinned Rust `wat` crate.
`.context/abi56-fixture-check.log` records the successful source check.
The first WABT decoding attempt and first standalone Rust linker setup
attempt are retained separately; neither executed a guest. Fresh-worker
Node/browser replay still requires combined artifact execution.


## Native EGL display ownership repair, 2026-10-27

The EGL facade now resolves legacy and platform GBM native displays through
the actual GBM live-device registry. Distinct native device objects receive
stable, separate EGL display handles and active generations. Repeating a
lookup for the same live device returns its display; a recycled GBM pointer
cannot revive an old display. The implementation-selected default display
is retained, as required by
[EGL_KHR_platform_gbm](https://registry.khronos.org/EGL/extensions/KHR/EGL_KHR_platform_gbm.txt).

Each initialized generation retains a CLOEXEC duplicate of its native DRM
file until final resource retirement, including a context still current
after eglTerminate. Root/object GL sessions continue to own separate
render-node files; multiple roots may select the same native file without
colliding. The DISPLAY role of GLIO_INIT accepts a held native DRM fd,
with -1 preserving the direct render-file identity path. The kernel checks
it before publishing state and inherits that stable identity into object
sessions. OBJECTS still joins its root. No PID-based master fallback or
additional ABI increment was introduced within program ABI 56/kernel-host
version 3. Per-display validation, termination, current-display queries
and image helpers route the associated generation.

Source validation job `graphics-native-display-source-v2-1027-151632-39c0`
passed 65 Rust GL-ioctl tests, all 211 native EGL/GLES cases under UBSan,
and the actual GBM metadata executable. The native tests cover foreign and
protected pointers, caller-owned fds and fresh device identities. The first
attempt passed Rust but stopped at a missing metadata symbol in the native
fixture scaffold; its log remains separate. It did not run native behavior.

`graphics-native-display-guests-1027-151907-c4d9` rebuilt both normal SDK
widths, fork instrumentation, selected ABI 56 kernel/rootfs dependency
artifacts and host, and passed freshness/ABI checks. Its 11 Node cases in
four files passed without skips or unloaded files. This includes both
previously failing EGL dma-buf/image-ownership cases and the new ordinary
SDK/kernel multiple-display probe. The latter verifies exact current
display, cross-display rejection, descriptor closure, retained master
through terminated-current context retirement, default/native isolation
and final native-file release. The Node renderer is a call recorder and
is not pixel evidence. The existing deliberate worker-crash ownership case
emits its expected trap while its lifecycle assertion passes.

The same job exited one after 12m59s: three real browser cursor cases
passed, while all three inherited-render cases now pass EGL context
creation and red GL pixel readback but fail `drmModeAddFB2` with EINVAL.
The EGL native visual is ABGR8888; KMS currently advertises and accepts
only XRGB8888, ARGB8888 and RGB565. This ordinary scanout-format mismatch
is the next repair. The rendered probe and failure assertions were not
weakened. Preserve `.context/native-display-guest-{node,browser}.log` under
the owned diagnostic checkout, plus its failed screenshots, as this
checkpoint's evidence. Integrated production/test source hashes are in
`.context/native-display-integrated-source-identities.json`.

E01/E02 and K04 remain partial. The complete combined compositor gallery,
browser-memory switching, POSIX conformance and expanded CTS are still
required after the remaining ordinary repairs.


## Scanout format consistency and actual pixel evidence, 2026-10-27

KMS now advertises and accepts XRGB8888, ARGB8888, RGB565, ABGR8888 and
XBGR8888 from one Rust format list. This includes the native ABGR8888
visual returned by EGL. The 2D presenter converts the selected byte order
to opaque RGBA. The WebGL scanout presenter selects red/blue ordering or
RGB565 upload and handles packed row alignment. Both respect pitch and
validate complete visible rows. Previously 2D copied BGR bytes directly
as RGBA, and WebGL always swapped red/blue, regardless of the format.

The WebGL presenter now receives an owned, tightly packed pixel snapshot
captured under the kernel entry. It no longer re-reads guest memory in
the detached observer phase. Its unflipped-write check compares exact
owned bytes against the last upload, rather than a sparse checksum which
could miss a single pixel or collide. No memory ceiling was raised.

`graphics-kms-format-validation-1027-154521-0101` passed in 13m10s:

| Scope | Result |
| --- | --- |
| Full Rust workspace | 4,175 passed across 102 groups; zero failures or ignored cases |
| Browser memory-boundary probe | 12 passed |
| Focused KMS host cases | 45 passed in three files, no skips/unloaded files |
| Normal build | Both SDK widths, fork tool, selected kernel/rootfs dependency graph, host and freshness/ABI checks passed |
| Selected normal Node guests | 14 passed in six files, no skips/unloaded files; includes fresh-worker catch/reference/GC replay and the 11 prior EGL/inherited-file cases |
| Actual browser rendering | 36 passed across Chromium, Firefox and WebKit |

The browser inventory contains six inherited-file cases and 30 CPU-buffer
scanout cases (five formats times both presenters times all three engines).
The inherited rendered cases now pass context creation, red GLES readback,
three frames/two event flips, a red visible scene and the inherited green
cursor after acknowledged opener retirement. The CPU cases verify red,
green, blue and white, RGB565 row padding, and a single-pixel write without
another SETCRTC/PAGE_FLIP. Natural exits and exact worker retirement are
awaited. These are real public SDK/libdrm/GBM/EGL/GLES guests and actual
browser pixels, not host registry injections or a mock renderer.

The subsequent evidence job
`graphics-kms-format-evidence-1027-160019-2cb0` passed in 2m28s. It reran
the same 36 rendered cases while saving successful canvas screenshots,
compiled guest Wasm, exact engine versions and kernel/guest/image SHA-256
identities to `.context/graphics-abi56-format-evidence/`. The complete
14-file host memory-ownership source gate also passed. Source hashes
matching the isolated implementation to the integrated files are in
`.context/kms-format-integrated-source-identities.json`. Detailed logs
remain under the owned diagnostic checkout's `.context/`, with prefix
`kms-format-`. Earlier ENODEV and ABGR framebuffer failures stay recorded.

Program ABI remains 56, kernel-host version 3, operation table 17 and fork
record 21. These results do not close K04 or establish the full compositor
or browser-memory switching gate. Render-node-first context/resource
creation, lost-master scanout, flip admission/timing, complete storage
views, expanded CTS, final combined POSIX and normal manual browser checks
remain required. Performance was not measured by these correctness cases.


## Submission lane retirement after master changes, 2026-10-27

An empty submission entry now drops its actual compositor/client lane
membership without consulting current DRM master classification. The old
release passed a numeric PID to the binding classifier, despite admission
using the binding's exact file identity. A changed grant could also select
the wrong lane even with the correct argument. A dispatch failure can stop
the drain immediately, leaving the consumed binding and its cached guest
command view retained until some later drain. Cleanup now removes the owned
entry directly from both possible lanes and preserves pending peer frames.

Two new source regressions first failed on the integrated ABI 56 source,
one for each admission lane. Both require cleanup after classification
changes and assert that no lane retains the consumed binding. The repaired
queue, drain and immutable-snapshot selection passed 38 tests in three
files, without skips or unloaded files, through the ordinary graphics
source configuration. The owned conformance checkout keeps
`.context/submit-queue-authority-{before,after,final}.log`. No guest pixel,
full memory-switching or conformance result is inferred from this source
selection. H01/H03 remain partial; program ABI 56 and kernel-host version 3
are unchanged. Performance was not measured.


## Independent render resources and selected GPU scanout, 2026-10-27

GPU resource creation now belongs to the virtual device, independently of
DRM master or which process creates a context first. The first available
native display renderer, or an offscreen renderer when needed, backs the
canonical GPU allocations. Exact primary-file/grant authority still owns
KMS control. A render-node context receives no canvas claim or display
control merely by creating resources. Node without a configured WebGL
backend retains its ENOSYS/CPU allocation fallback.

This is required by the verified wlroots source archive
`80c567d2ed4efb2cfa6b077f22c7a710d9c78ba4e185a75e8694001114af0733`:
`render/egl.c` opens an independent render node and constructs its GBM
device from that descriptor. The checked source excerpts are retained in
`.context/wlroots-upstream-review/`. No compositor-specific primary-file
selection patch was added. The original real render-node-first control
failed context creation with ENODEV on all three engines; preserve
`.context/render-node-before-evidence/` in the diagnostic checkout.

The vblank path now selects canonical GPU storage from the KMS framebuffer
actually latched by authorized operations. On its native display context
it blits that storage; on a different renderer or an explicitly 2D display
it takes an independent RGBA readback. GPU access remains synchronous under
kernel entry authority while the selected framebuffer holds its BO. Only
owned pixels survive into detached presentation. Blit/readback selectors,
scissor and packing state have retryable native-only inverse records. A
failed restoration fences later native work until repair accepts.

CPU WebGL presentation resets its complete upload/draw dependencies while
GLES contexts remain live. Device operations capture the outgoing context's
errors and invalidate the muxer so later guest commands restore their own
logical state. An immutable package-private graphics capability exposes
only native graphics operations, separately from kernel Memory/Instance/
gate authority. The reviewed raw-memory authority record was not broadened.
A lost native context stands scanout down rather than terminating the
machine; complete lost-storage reconstruction remains open.

The final combined job
`graphics-render-node-validation-v8-1027-170352-5e47` passed in 4m15s:

| Scope | Result |
| --- | --- |
| Canonical host build and evidence registry | Passed |
| Complete graphics source gate | 690 passed in 30 files; no skips/unloaded files |
| Complete memory ownership source gate | 161 passed in 14 files; no allowance expansion |
| Normal Node EGL/import/lifecycle guests | 11 passed in four files; no skips/unloaded files |
| Actual browser pixels and teardown | 42 passed across Chromium, Firefox and WebKit |

The browser inventory includes the previous 30 five-format CPU scanout
cases and 12 inherited-file cases. The new GPU cases use ordinary SDK
GBM modifier-aware allocation, dma-buf EGLImage import and an image-backed
renderbuffer/FBO, matching wlroots' resource path. They retain primary-file
KMS authority after acknowledged opener-worker retirement. Red resource
pixels remain invisible before KMS selection; a blue CPU framebuffer then
replaces them; the live GLES context subsequently renders red again. Both
direct GPU and 2D readback paths display a single white marker at (17,19),
which detects inversion, and the inherited cursor remains green. Natural
child exit, exact worker retirement, empty diagnostics and the browser
memory-message boundary probe are asserted. This is not a mock-pixel test.

Successful screenshots, actual compiled guests and per-engine JSON records
with engine versions and kernel/guest/screenshot SHA-256 identities are
retained in unique `run-*` directories under
`.context/graphics-abi56-format-evidence/`. Earlier runs are preserved.
The new source tests cover native selector/pack restoration, owned readback,
bad geometry, rejected inverse repair and native-context loss. Detailed
logs use the `render-node-` prefix in the owned diagnostic checkout.

The earlier v7 and full-source/browser attempts each passed 41/42 rendered
cases and timed out on Firefox's GPU-to-2D pixel inspection. Two isolated
controls passed. Failure diagnostics show the guest ready, no reported
errors, a last blue sample and a red failure screenshot. That fixture had
stacked scene/cursor canvases, so inspecting either scrolled the other out
of view. The final fixture overlays the two planes in one visible display,
as the product does, and retains failure-state records before teardown.
The full 42-case rerun passes without changing pixel assertions or timeouts.
These records do not demonstrate an outside browser defect.

A separate ordinary B03 failure remains visible. The first extended probe
used a GBM native-window ring: swapping an unselected window already showed
its red pixels. The current ring only chooses unused BOs and is not wired
to faithful rendered front/back storage. The exact fixture, three failed
browser results and screenshots are retained under diagnostic
`.context/render-node-gbm-ring-failure-v5/`. Testing the actual wlroots
image-backed path does not close that native-window gap.

Program ABI remains 56, kernel-host version 3, operation table 17 and fork
record 21. K05, B03 and the overall baseline remain partial. Normal combined
program/image closure, default-resolver cage/sway consumers, the full
three-engine gallery and CTS, complete browser-memory switching, current
POSIX conformance and normal manual browser verification are still
required. CPU/GPU coherence, framebuffer layout/offset validation, lost
resources, ordered execution/server waits and the other inventory gaps
remain ordinary implementation work. Performance was not measured.


## Opaque primary GPU scanout, 2026-10-27

The direct GPU presenter now matches the existing opaque 2D/WebGL CPU
presenters for Kandelo's primary display plane. Its old raw blit preserved
a source BO's alpha in the browser canvas, allowing the page background to
show through the physical display. Device presentation now sets alpha to
one only in the displayed default framebuffer. The canonical source BO
retains its alpha for EGLImage siblings and subsequent rendering. Native
color masks and clear values join the retryable inverse journal, and the
guest's scissor, framebuffer selectors and error ownership remain intact.

A real WebGL source control first reproduced the zero displayed alpha on
Chromium, Firefox and WebKit while the source contained red/alpha-zero
pixels. The corrected fixture explicitly uses the production path's
non-multisampled context. Its first default-antialias setup attempt failed
earlier at the incompatible single-to-multisample blit and is retained as
setup failure, not alpha evidence. Neither pixel assertions nor state
restoration assertions were weakened.

`graphics-primary-alpha-check-1027-173138-6ffc` passed after 2m33s:
canonical host JS/declarations build, all 690 graphics source cases in
30 files and the three-engine native-rendering control. The control proves
source RGBA [255,0,0,0], displayed RGBA [255,0,0,255], untouched source
storage and restored masks/clear/scissor/read/draw state. This is actual
WebGL rendering of the host utility, not a normal SDK guest or complete
compositor session. The full combined guest, compositor and browser-memory
gates still need this final host source.

The isolated checkout preserves
`.context/primary-alpha-browser-{setup-antialias-failure,before,after}.log`,
`.context/primary-alpha-{host-build,graphics-source}.log`, failed screenshots
and successful engine-version/pixel records under
`.context/graphics-primary-alpha/`. Program ABI remains 56, kernel-host
version 3 and operation table 17. No memory ceiling, package recipe or
upstream runtime workaround changed. Performance was not measured.


## Reject out-of-backing framebuffer views before admission, 2026-10-27

ADDFB2 now computes the selected format's visible row bytes and complete
last-row extent with checked arithmetic, including the supplied offset.
It rejects a row wider than the pitch, any view outside its BO bytes and
a GPU view beyond its native texture dimensions. Rejection precedes BO
retention, framebuffer ID publication and host admission. Such a malformed
view must not arrive at GPU scanout as an internal renderer failure.
Compatible padded RGB565 views of wider CPU backing remain admitted.

The new Rust control first reproduced acceptance of an invalid 3x2 RGBA
view over 2x2 backing. After the repair it covers CPU/GPU storage, excessive
width/height, high offsets and GPU texture extents. Every rejection leaves
the complete ioctl output unchanged, publishes no FB and retains no BO.
The positive padded-view case preserves valid reinterpretation of CPU bytes.
The first failure remains in diagnostic
`.context/framebuffer-layout-before.log`.

`graphics-framebuffer-layout-rust-1027-174342-6b8e` passed after 4m40s:
3,357 tests across 96 result groups in the complete Rust workspace excluding
xtask, with zero failures or ignored cases, plus all six program-contract
identity tests. This count excludes xtask's broader automation suite and
is not presented as the earlier 4,175-test selection. No ABI structure,
import, declaration or epoch changed; program ABI remains 56/kernel-host 3.
Actual new-kernel build, freshness/ABI verification and normal guest
execution remain pending at this source checkpoint.

The ordinary SDK scanout fixture now includes four malformed ADDFB2 calls
per format before its valid color/pitch case: excessive row width, excess
height, offset at the end of backing and a high offset. Each requires
EINVAL and an unchanged caller output. Those prepared guest assertions
have not yet executed on the new kernel. The existing pixel assertions
and valid RGB565 padding remain intact.

This is bounded admission validation. Arbitrary valid offsets/custom
pitches, full format reinterpretation, modifier/flag handling and the rest
of the framebuffer/presentation model remain ordinary gaps; K04/K05 stay
partial. No hard boundary or complete layout support is claimed.


## Combined ABI 56 consumer checkpoint, 2026-10-28

The normal full program job
`graphics-main56-programs-1027-163119-f690` succeeded after 1h24m,
stamping all 239 programs. After updating the primary checkout to
`ec499f4cb412`, the consumer preparation job
`graphics-main56-consumer-preparation-1027-180033-926a` passed in 1m32s:
normal new-kernel product build, canonical host/rootfs refresh, freshness,
actual ABI import/export verification and evidence registry. Program ABI
56, kernel-host 3, GL operation table 17 and fork record 21 are unchanged.

The default-resolver Node job
`graphics-main56-node-consumers-1027-180457-4201` passed all 36 cases in
17 files after 7m38s, with no skipped or unloaded cases. This covers cage,
sway tiling/input/IPC, swaybar status EOF and swaynag exit, wlterm under
both compositors, foot, GTK, libkwl, desktop liveness, EGL imports, native
windows, GEM lifecycle and KMS modes/page flips. Node uses CPU rendering;
these results do not establish GLES pixel correctness.

The new-kernel browser job
`graphics-main56-browser-consumers-1027-180457-2820` passed 51 of 54
cases: 12 inherited-file cases, 30 CPU/WebGL format cases, three native
alpha controls, three upstream surfaceless CTS cases and three focused
cage sessions. The format cases execute all 120 new malformed ADDFB2
requests through ordinary SDK guests. Each rejects with EINVAL and keeps
the ioctl output unchanged; valid color/pitch and padded RGB565 rendering
assertions also pass. This supplies actual guest evidence for the
preceding framebuffer admission checkpoint.

All three new focused Sway cases rendered red pixels, routed input and
exited with status zero and empty diagnostics, but failed a new assertion
requiring their first feedback event to be `presented`. That assertion
was invalid for this client: `wlclient-test.c` commits again when Sway
configures its mapped surface. Pinned wlroots'
`types/wlr_presentation_time.c` finishes the old feedback when synchronized
surface state moves; the [Wayland presentation protocol](https://gitlab.freedesktop.org/wayland/wayland-protocols/-/blob/main/stable/presentation-time/presentation-time.xml)
allows discarded feedback for a superseded content update. This is a test
correction, not an outside runtime defect or a platform workaround. The
three initial failure records remain under
`.context/wlroots-rendered-sessions/*-sway-failure.json`.

The focused fixture `wlroots-rendered-session.spec.ts` now requires
resolved first feedback for Sway and still requires positive `presented`
feedback for cage. Both require actual GPU scanout, accepted KMS commits,
more than 10,000 exact red screenshot pixels, real keyboard/button delivery,
status-zero exit, acknowledged worker retirement, empty diagnostics and the
browser memory-message boundary probe. Sway's fixture includes its normal
packaged swaybg and uname dependencies. No application or upstream assertion
was changed to make this fixture pass.

`graphics-wlroots-browser-final-1028-145707-c2a7` passed all six focused
sessions in 2m33s across Chromium, Firefox and WebKit. JSON records retain
engine versions, kernel/compositor/client/image SHA-256 identities, KMS
statistics and visible pixel counts; PNG screenshots are beside them.
This closes the focused consumer rerun, not the normal gallery or full
browser-memory gate.

The combined conformance checkpoint
`graphics-main56-combined-conformance-1027-171057-fc84` also passed in
1h59m on `6cb0181761dd`, before the alpha and framebuffer admission fixes:

| Suite | Result |
| --- | --- |
| musl libc-test | 306 passed, 17 expected failures, one known FLAKE-PASS; 324 total |
| Open POSIX | 174 passed, three expected failures, two skips; 179 total |
| Sortix os-test | 5,065 passed, 23 expected failures, 50 skips; 5,138 total |

There were no unexpected failures, build failures or timeouts. Exact
external pins and source roots are unchanged from the preceding recorded
conformance runs. A fresh `ec499f4cb412` rerun is running as
`graphics-main56-final-conformance-1028-145731-953f`; it is not yet claimed
passed.

The normal gallery preparation attempt
`graphics-main56-browser-closure-1027-171009-2f07` failed after 1h57m:
kandelo-cc and termchat required the isolated checkout's missing pinned
`sdk/rust/libc-upstream` submodule. Independent packages drained, including
Clang and Qt. This was provisioning failure, not a demonstrated program
compatibility defect. The exact submodule
`71d5bfcc1bda05da1783666fc2cd7d9669c9c4c8` is now initialized, the checkout
is updated to `ec499f4cb412`, and normal preparation/gallery/CTS is running
as `graphics-main56-final-browser-closure-1028-145748-b194`.

The complete gallery, four-cycle browser-memory gate, normal manual browser
check and final conformance rerun remain outstanding. All ordinary baseline
gaps remain tracked above, including B03 native-window front/back storage.
These consumer passes do not establish complete GLES2/EGL/GBM/KMS
compatibility. Performance was not measured.


## GBM modifier admission and public format queries, 2026-10-28

The GBM library now defines the missing public
`gbm_device_get_format_modifier_plane_count` and `gbm_format_get_name`
functions. Supported fourcc/linear pairs report the actual one-plane
layout; unsupported pairs fail. Format names write into caller-owned
storage and normalize the two legacy XRGB/ARGB name aliases. This does not
extend the allocator's format inventory or claim complete legacy alias
handling in the other GBM entry points.

BO and surface modifier constructors now share pointer/count and
explicit-layout validation. A nonempty list needs a pointer; a nonnull
pointer needs a nonzero count; an explicit list cannot accompany
GBM_BO_USE_LINEAR. Surface construction previously ignored the list and
silently allocated linear storage even when only unsupported layouts were
requested. It now rejects that request before allocating or publishing
BOs. Lists containing an available linear choice and implicit no-list
linear requests remain supported. The contract was checked against
[Mesa's pinned public GBM implementation](https://gitlab.freedesktop.org/mesa/mesa/-/blob/f1f246cfda65eff82fba3be1caf2d23bdeda60cc/src/gbm/main/gbm.c)
and its DRI format/modifier query implementation at the same revision.

The native regression first reproduced malformed BO-request acceptance
(exit 134) and separately failed to link the two missing public symbols.
After repair, `tests/graphics/run-gbm-unit.sh` passes under UBSan and
checks all 38 header-declared functions against actual compiled external
definitions. Its device double checks no allocation on nine invalid
requests, successful mixed-list and implicit-linear allocations, actual
linear plane metadata, unsupported formats/modifiers, fourcc names and
unchanged adjacent caller storage. Logs are retained in the owned
GBM checkout as `.context/gbm-{modifier,query}-{before,after}.log` and
`.context/gbm-public-native-final.log`.

This checkpoint has native source/API evidence. New ordinary SDK Node and
three-engine browser fixtures are prepared, but have not yet executed.
SDK archives, linked consumers and normal images still require rebuilding
for this C source; the preceding consumer and live memory/conformance
runs retain their explicitly recorded earlier source identities. Program
ABI remains 56, kernel-host 3 and operation table 17. B01 remains partial;
B03 rendered front/back storage and B02 mapping/coherence remain ordinary
implementation gaps. No hard boundary or complete GBM support is claimed.


### GBM query/layout guest checkpoint

`graphics-gbm-sdk-guests-1028-151711-82b9` passed after 3m20s on
`41ce43155eca`: the normal SDK bootstrap rebuilt the musl/graphics
archives from current sources, native UBSan and all 38 public symbol
checks passed, the evidence registry passed, all three Node cases passed
with no skipped/unloaded cases, and the new ordinary SDK probe passed in
Chromium, Firefox and WebKit. The Node selection includes the prior
native-window metadata and ring bookkeeping tests; the latter still does
not establish rendered front/back correctness. Browser JSON records under
`.context/gbm-modifier-guests/` retain engine versions and exact
program/kernel/image hashes. No renderer double substitutes for the new
guest's public GBM calls. This supersedes the preceding checkpoint's
pending targeted guest checks, while broader linked package/image
validation and the remaining GBM gaps stay open.

The earlier normal browser closure
`graphics-main56-final-browser-closure-1028-145748-b194` completed its
normal 176-node/nine-product preparation successfully. Finalization took
523.5 seconds; an own-process stack sample showed source/receipt
revalidation, not a demonstrated runtime or compiler failure. Its nine
subsequent gallery/CTS attempts failed during setup: CTS was outside that
selected projection, and gallery module imports/server requests failed.
No program rendering or gallery behavior was validated by that attempt.
The raw log remains in the diagnostic checkout; the subsequent memory
run replaced the shared test-results directory before those setup
screenshots were copied, so those screenshots are no longer retained;
normal gallery setup still needs repair and a real consumer rerun.

A primary browser-memory attempt was stopped after 3m13s to avoid a
duplicate package rebuild under a different native-plugin/SDK cache
identity. Its 12 protocol checks passed but it is not a passed memory
gate. The complete ordinary gate is now running in the prepared diagnostic
checkout as `graphics-abi56-browser-memory-prepared-1028-150810-3904`,
on its earlier explicitly recorded `ec499f4cb412` C source. Final
conformance on that same source is also still running. Neither live job
is claimed passed.


### Normal gallery and complete memory gate results

`graphics-gallery-owned-server-1028-152329-e97a` passed all six normal
gallery cage/sway cases across Chromium, Firefox and WebKit, after its
explicit dependency wait (actual test time 2.1m). It required its own Vite
server with CI=1 and wrote results to a unique evidence directory.
This supersedes the preceding gallery setup failure; no program or
assertion changed between attempts. The Sway cases cover foot rendering,
status redraw, keyboard input, workspace changes, tiling, the exit
confirmation, status-zero shell return and subsequent CPU-renderer launch.
The former WebKit exit-confirmation failure is not reproduced in this
combined-source run. The source remains `ec499f4cb412`, before the latest
GBM query/layout C change.

The complete ordinary browser-memory command
`graphics-abi56-browser-memory-prepared-1028-150810-3904` failed overall
after 21m25s including its gallery dependency wait. Protocol checks passed
12/12, host ownership tests 161/161 in 14 files, Node teardown tests 3/3
and Bun teardown tests 7/7. The browser portion passed seven of nine cases
in 7.3m. Chromium completed all four cycles in the same persistent page.
Firefox and WebKit each stopped after the first eight-application cycle
because actual forced-drain warnings failed the unchanged assertion; the
remaining three cycles on those engines did not execute.

The preserved Playwright traces locate Firefox's warning at Quake-to-
Freeciv teardown and WebKit's two warnings at Doom-to-Quake and Quake-to-
Freeciv teardown, before cage/sway were launched. This identifies the
affected transitions; it does not establish an outside engine defect or
prove the failure pre-exists on main. Baseline comparison and platform
repair remain required. The warning timeout was not increased or hidden.
Copied error contexts, traces and screenshots are retained under primary
`.context/graphics-memory-checkpoint-evidence/` and the diagnostic
`.context/graphics-memory-checkpoint-results/`. The Firefox failure also
has a separate primary copy at
`.context/graphics-memory-firefox-first-failure/`.


## GBM CPU mapping regions and independent leases, 2026-10-28

CPU map requests now validate nonempty rectangles with subtraction-based
bounds, row/backing extents, transfer flags and required output pointers
before publication. The returned address includes the requested x/y
offset while retaining the actual full-row pitch. Simultaneous views of
one BO share its mapped bytes but own separate, serialized map leases.
Opaque tokens are monotonically allocated, not recycled record addresses;
a foreign, repeated or stale token cannot release a peer's live view.
Only the last accepted release unmaps backing. A failed last unmap keeps
its address and token available for retry.

`gbm_bo_write` uses its own full-BO mapping lease and releases it after
copying, preserving other public views instead of relying on an unowned
permanent cached mapping. A failed private write release stays in a
BO-owned pending record; the next mapping transfers that hold and retries
physical release when its last view ends. A native counter control first
reproduced a retained private-write hold, then passes after this repair.
No new shared buffer or guest-memory authority
is exposed to the host or browser main thread. Transfer flags zero remain
accepted for existing callers; unknown bits fail. GPU mapping, import
coherence, failed BO-destruction cleanup and the complete backing model
remain ordinary B01/B02 gaps. This is not complete GBM mapping support.

The native control first had an invalid fixture offset on macOS's larger
page size; that setup failure is preserved separately. After using the
actual native page size, the old source failed the intended assertion:
a subrectangle returned the BO base instead of base plus row/pixel offset.
The repaired actual C source passes UBSan and the 38-symbol audit, covering
overlapping views, distinct tokens, release ordering, foreign/stale tokens,
seven bad rectangles/flags with unchanged outputs, absent output pointers,
write/readback and retry after an injected EINTR release failure. Native
mapping uses an actual MAP_SHARED temporary file behind the DRM allocation
double; only the tested unmap failure is injected. It is not kernel/guest
coherence evidence. Logs stay in the owned GBM checkout as
`.context/gbm-cpu-map-{setup-page-size,before,after,retirement}.log`.

Ordinary SDK Node and three-engine browser mapping probes are prepared,
but have not executed at this source checkpoint. SDK/archive and linked
consumer validation remains required. Program ABI stays 56/kernel-host 3,
with operation table 17. No new ABI increment or hard boundary is claimed.


## Combined validation and remaining failures, 2026-10-28

The normal SDK/archive mapping checkpoint on `fbfb5f1faeb8`, job
`graphics-gbm-map-sdk-guests-1028-154740-0f41`, passed native UBSan and
all 38 public GBM symbol checks. Six normal SDK Node probes passed with
no skipped or unloaded cases. The two new GBM probes passed all six
three-engine browser cases. The broader inherited-display check passed
11/12: Firefox's render-node-to-2D case timed out while decoding a cursor
capture, before its pixel assertion returned. The combined browser result
is 17/18, not a passed broader graphics gate. Its failure JSON records the
blue CPU interlude and a captured cursor image whose decoding did not
finish; there were no page errors. Evidence was copied before the shared
output directory could be overwritten to
`.context/gbm-map-browser-first-results/`. This remains unresolved and is
not evidence of a confirmed engine defect or a mapping regression.

The normal main batch artifacts at `cb0a8226c965` reproduce the game
teardown failure. The baseline-only three-cycle Doom/Quake/Freeciv
reduction failed in all three engines in
`graphics-main-game-teardown-baseline-v2-1028-153703-08f7`, using main's
ABI 55/host 2 kernel, SHA256
`2f92989fe898d2e80f25e736dd8a99bbc507605d38566b5d10aa361b8e416e56`.
The probe preserves the production launch/audio/pixel checks and the
unchanged no-forced-drain assertion. Its first attempt failed only because
an owned-server port was already occupied; that setup log is separate.
The successful reproduction establishes that this failure predates these
GBM changes. It does not make the lifecycle defect a platform boundary.
Baseline identities, traces, screenshots and failure contexts remain in
`.context/main-game-baseline-identities.json` and
`.context/main-game-teardown-baseline-evidence/`.

The normal `./run.sh browser` server was also started. The available
computer-use connection has no enabled browsers, so manual GUI validation
could not execute; the owned server was explicitly stopped. The six
normal gallery passes remain automated evidence, not a manual check.

Temporary, uncommitted diagnostics in an isolated checkout show the
teardown wake can select an unhandled opaque-record clock request. Its
request flags are still 8. The worker then publishes Exit, but Exit
inherits that flag and the host's existing malformed-request check rejects
it before inner dispatch. An isolated before-control confirms the exit
import publishes flags 8 instead of a fresh raw request's 0. A repair and
both-host/browser validation are in progress; this checkpoint does not
claim the memory gate fixed. Temporary per-syscall diagnostics are saved
separately and removed from the candidate runtime.


## Fresh exit-request flags repair, 2026-10-28

The shared process-worker exit import now publishes request flags zero
before its atomic PENDING store. Machine teardown can complete a mailbox
before its previous request was selected; the previous opaque-record or
cancellation flags therefore still belong to that earlier request. Exit
must establish fresh raw-request metadata. The existing host validation
continues rejecting contradictory request flags. No kernel status,
assertion, timeout, signal authority or ABI version is changed.

The new regression in `exec-retirement-marker.test.ts` first failed with
actual published flags `[8]` instead of `[0]`. With the fix,
`graphics-fresh-exit-flags-host-1028-160835-9ba8` passed all 135 cases in
five files, no skipped/unloaded cases, including blocked-worker teardown
and retry/entry contracts. The isolated real-game reduction then passed
all three engines, three cycles each, in
`graphics-game-teardown-fresh-exit-flags-1028-160819-682a` (3m51s).
Its source is `ec499f4cb412` plus only this four-line shared import repair;
all temporary syscall diagnostics were removed before that run. Main's
unmodified producer had failed this same reduction in every engine.
These passing reductions support the repair; they do not replace the
complete memory gate, which is running on the isolated prepared source.
The latest GBM C checkpoints still require a subsequent coherent normal
package/image rebuild and complete memory validation together.


## GBM PRIME alias lifetime repair, 2026-10-28

An actual normal SDK guest reproduced another B01 defect: importing one
PRIME fd twice on its source GBM device correctly reused the DRM file's
cached GEM name, but destroying the first public GBM object closed that
name while its source and second import remained live. Exporting from the
surviving second object then failed with ENOENT. The failed control is
`graphics-gbm-import-before-1028-162041-74b8`; its actual stderr reports
`line 22: survivor >= 0 errno=2`. No kernel deduplication or assertion was
weakened to accommodate this.

The C shim now records public BO peers and closes a device/handle pair
only after its final peer retires. Import and peer removal are serialized
so registration cannot race the last close. Userspace allocation happens
before PRIME import, avoiding a failed allocation closing a cached name
owned by another BO. This repair is bounded to objects on one GBM device;
coordinating distinct GBM device wrappers over aliased DRM files remains
open, as do import layout/coherence and failed-destruction cleanup.

`graphics-gbm-import-after-1028-162401-45ee` passed in 3m18s after a normal
SDK/archive rebuild. All 38 public GBM symbols and native UBSan passed,
including a same-name close counter that retains both surviving peers.
Seven normal SDK Node cases passed in seven files with no skipped or
unloaded cases. The import, modifier and CPU-map SDK probes passed all
nine browser cases across Chromium, Firefox and WebKit. This is bounded
API/lifetime validation, not a rebuilt complete gallery or memory gate
with the latest C source. Program ABI56/kernel-host3 remains unchanged.

## Inherited-display capture investigation, 2026-10-28

A fixed three-repetition control passed 3/3 using the older prepared SDK,
while the latest SDK source passed 2/3. Host graphics and the guest probe
sources are identical across those checkouts; the only host change is
the fresh exit-request flags repair. The guest does not call the changed
GBM mapping APIs. These controls do not establish a mapping regression.
The two new GBM probes continue passing in all engines.

Decoding the actual screenshot PNG in the Node test runner retained the
same exact pixel assertions and produced a 17/18 broader result. Unlike
the earlier pending predicate, it captured a black primary frame where
red was required. Temporary detached diagnostics then compared only owned
pixel copies: in both failures of a fixed ten-repetition Firefox run,
the GPU readback and 2D canvas center were red, while a screenshot took
10-20 seconds or returned black. Another failure returned the correct red
pixel only after the unchanged 10-second polling deadline. The diagnostic
run passed 8/10; the preceding three diagnostic repetitions passed 3/3.
These are observations, not a runtime fix or confirmed engine defect.
All temporary production instrumentation was removed and its patch saved.

A standalone worker/WebGL-readback/2D/cursor capture reduction, without
Kandelo modules or guests, passed 60/60 captures over 20 iterations. Its
first launch failed on the existing macOS Firefox profile constraint;
using the same isolated-home launch environment as the normal suite
allowed it to run. Therefore an outside defect is still unconfirmed.
The normal test is now comparing clipped viewport capture with element
capture while preserving pixels and deadlines; that result is pending.


## Completed conformance and capture controls, 2026-10-28

`graphics-main56-final-conformance-1028-145731-953f` completed successfully
in 1h30m on source `ec499f4cb412`: libc 306 pass, 17 expected failures
and one known FLAKE-PASS (324 total); Open POSIX174 pass, three expected
failures and two skips (179 total); Sortix5,065 pass,23 expected failures
and50 skips (5,138 total). There were no unexpected failures, build
failures or timeouts. This source includes the combined ABI56/host3,
alpha and framebuffer-admission fixes. It predates the later GBM query,
map and import C changes and the shared exit-request flags repair.

The clipped-viewport capture experiment first passed all12 inherited
cases across three engines in
`graphics-inherited-viewport-capture-1028-162725-6199`. A fixed ten-case
Firefox repetition then passed7/10 and failed3/10 in
`graphics-inherited-viewport-repeat-1028-162852-e886`, again timing out
while screenshot capture took10-20 seconds. It is not a fix. Both this
experiment and Node PNG-decoder dependencies were removed from the branch;
the original exact pixel assertions and original fixture are retained.
Their patches, experimental fixture and lockfile are saved under primary
`.context/inherited-capture-experiments.patch`,
`.context/inherited-viewport-probe.spec.ts` and
`.context/inherited-png-package-lock.json`. All diagnostic result folders
remain separate. The Firefox inherited 2D capture remains unresolved;
a single all-engine pass does not close it.


## Complete prepared-checkpoint memory gate passes, 2026-10-28

`graphics-memory-fresh-exit-flags-1028-161245-8e8e` completed successfully
in 36m06s, including normal image preparation and the inherited-display
control dependency. The unmodified `./run.sh test browser-memory` command
passed protocol 12/12, ownership 161/161 across 14 files, Node teardown 3/3
and Bun teardown 7/7. Its browser portion passed all 9 required cases in
14.1 minutes, with zero skipped, flaky or unexpected cases under the
command's report validation. All three engines completed four complete
eight-application cycles in one persistent page: Chromium 4.2m,
Firefox 5.4m and WebKit 4.4m. Both exit/memory-boundary probes passed in each
engine. The original no-forced-drain assertions and 1500ms drain timeout
were retained. This closes the demonstrated game-teardown regression at
this prepared checkpoint; it does not close all graphics lifecycle work.

The exact source is `ec499f4cb412a934a7501d7a8ba09a78b6ad3366` plus only
the four-line shared process-worker Exit request-flags repair now present
in commit `d3507d7f24`. The normal resolved kernel SHA256 is
`e407bf187956024fa80bb710b9ec3206075de0da8192eb92a579bc52c10f29c5`.
Primary copies of the source hashes, exact diff, resolved kernel path and
log are `.context/graphics-memory-fresh-identities.json` and
`.context/graphics-memory-fresh-exit-flags.log`; terminal browser result
metadata is copied to `.context/graphics-memory-fresh-results/`.
Successful traces/screenshots were not retained by the normal failure-only
trace policy, so they are not claimed as evidence of this passing run.
The older failed run and main-only failure controls remain preserved.

This complete gate used the coherent normal prepared gallery/image graph
from before the later GBM public-query, CPU-map and PRIME-alias C repairs.
Those later changes separately pass their native and normal SDK Node/
three-engine API probes; they still require a complete coherent consumer
rebuild and memory gate together. The intermittent inherited 2D Firefox
capture, actual GBM native-window rendered front/back storage and the
remaining GLES/EGL/GBM/KMS inventory are still ordinary open work. No
baseline-wide completion or new hard boundary is claimed.

## GBM device file retention and dual-width SDK, 2026-10-28

A normal SDK guest reproduced a B01 owner-lifetime defect on `09a6401b2b`:
create a BO, destroy its public GBM device, close the caller's DRM fd,
then export the surviving BO. The old shim freed the device record and
borrowed the closed fd; export failed with EBADF. The actual before run
is `graphics-gbm-device-before-1028-172201-f125`, with stderr
`line 14: prime >= 0 errno=9`. The strengthened regression also reuses
the caller's fd for `/dev/null`, writes the surviving BO, retires its
surface, and checks that final cleanup closes only the private DRM alias.

Each device now owns a close-on-exec duplicate of its DRM file. The public
name, every BO and every GBM surface hold independent references. Public
device destruction withdraws metadata lookup; the file/record survives
until its final owned object retires. `gbm_device_get_fd` still returns
the caller's original descriptor. Failure paths release acquired holds.
This does not close the borrowed metadata-to-EGL acquisition race,
cross-wrapper cached GEM ownership, failed destructor cleanup, or the
EGL-retained GBM native-window/rendered front-back storage gaps.

The same native harness against historic `09a6401b2b` fails with allocator
poisoning (`MallocScribble=1`, status134, wrong-device-file assertion).
Without poisoning it initially passed because freed bytes remained
readable; that run is not a failing control. An AddressSanitizer diagnostic
hung during sanitizer initialization before test entry and was stopped;
it is neither a test pass nor evidence of an outside defect. Logs and its
sample remain in `.context/gbm-ring-repair/.context/gbm-device-native-*`.
The repaired harness passes both UBSan and the poisoning control, including
all 38 public symbol checks. The revision runner now accepts one historic
source reference and bounds the native process at 30 seconds.

The added normal wasm64 guest first failed to link: bootstrap and the
libdrm recipe provisioned graphics only for wasm32. This was ordinary
missing SDK support, not a platform boundary. The DRI/EGL/GLES builders
now select the requested target and sysroot, include that architecture
in their freshness identity, and resolve the matching libdrm package.
Libdrm declares both widths and uses the matching worktree SDK wrappers.
Normal musl bootstrap refreshes graphics on both widths; `--core-only`
continues to prevent recursive resolution. No ABI or publish revision
was used as a progress counter. No new Linux identity define or upstream
source patch was introduced; the existing libdrm compatibility header is
unchanged. The CTS package still declares only wasm32.

`graphics-gbm-device-combined-1028-173943-bc69` passed in 2m56s after normal
bootstrap of both SDKs. Ten Node cases passed in eight files with zero
skipped/unloaded cases: device retirement and EGL native-window handoff
both execute wasm32 and wasm64, alongside import, modifier, mapping,
existing ring-bookkeeping, dma-buf and image ownership checks. Fifteen
browser cases passed in 26.6s across Chromium, Firefox and WebKit,
including device retirement at both guest widths. Native UBSan, native
allocator poisoning, relocatable graphics pkg-config, musl build-state
and evidence classification checks passed. Logs are primary
`.context/graphics-gbm-device-*-final.log`; browser results are in
`.context/graphics-gbm-device-browser-final-results/`, and per-engine
kernel/program/image hashes in `.context/gbm-device-retirement-guests/`.
Source/archive identities are `.context/graphics-gbm-device-identities.json`.

This is source `09a6401b2b` plus the device-retention and SDK provision
changes in this checkpoint, with program ABI56/kernel-host3 unchanged.
It does not establish rendered GBM ring semantics or complete wasm64
EGL/GLES conformance. The existing ring smoke test still checks its old
bookkeeping model, not produced rendered fronts. Complete consumer/image
rebuild, memory and POSIX gates on these newest C changes remain required;
the prior full gates have their separately recorded source identities.


## Rendered GBM front/back ownership checkpoint, 2026-10-28

GBM native windows now lend EGL a retained GPU render target instead of
merely reporting dimensions for unrelated storage. The public window, EGL
lease, active back, produced front and locked front owners have distinct
states. A pre-swap/repeated lock fails without inventing a frame. The pool
has four slots, including a reserved render back; three outstanding locked
fronts therefore exhaust the next swap. Free-buffer queries return a
boolean. Released/foreign buffers are compared under the owner table, and
public window destruction waits for EGL and locked-front owners. New
internal allocations use the retained device even after public device
withdrawal. GPU render-target acquisition fails honestly when unavailable;
WRITE/LINEAR/CURSOR window rendering remains an ordinary unsupported path.

EGL flushes accepted commands, reserves an unlocked next back and uses the
existing transactional GLIO_UPDATE_SURFACE operation. Only its accepted
reply publishes the completed front and switches the back. A rejected
allocation/update leaves the prior front/back state in place. GBM swaps
no longer issue GLIO_PRESENT; KMS selection remains the posting authority.
The actual unselected-display and asymmetric orientation checks are still
pending, so this code-level change does not yet close the earlier B03
posting failure. EGL retires its lease only after native surface retirement,
and drains resulting user BO callbacks after releasing its metadata lock.

The normal SDK regression imports locked fronts as EGLImage renderbuffers
and reads every pixel after later red, green and blue frames. Exhaustion
must preserve their pixels and current context; releasing a front permits
the retained yellow back to swap. Public device/window destruction cannot
retire the storage early. A final BO callback reenters a locking EGL API
without deadlock. Chromium, Firefox and WebKit passed both wasm32 and
wasm64 guests, six cases, in 15.1s in
`graphics-gbm-ring-query64-build-v2-1028-180329-c80e`. The job also built the
normal kernel and both SDKs and checked every regenerated ABI output. The
old-archive control failed both widths at its count-valued free-buffer
query in `graphics-gbm-rendered-ring-before-1028-175029-1808`; it does not
by itself establish a before/after pixel regression. The earlier actual
three-engine unselected-red failure remains separately preserved above.

This exposed a real wasm64 platform gap: GLIO_QUERY was declared wasm32
only, so the kernel rejected synchronous GL queries with EOVERFLOW before
WebGL dispatch. The first rendered-ring run passed all three wasm32 cases
and failed all three wasm64 cases. A direct query diagnostic confirmed
EOVERFLOW with valid low addresses; all temporary private diagnostic calls
were removed from the guest. The unchanged wasm32 wire remains 24 bytes.
The new native wasm64 record is 40 bytes, with full u64 input/output
addresses. Registered process width selects it in the kernel. C now uses
uintptr_t query fields rather than narrowing pointers. The snapshot, C
headers and TypeScript table are regenerated under the combined unpublished
ABI56/kernel-host3; no per-increment version was added.

The 87 shared tests and ten focused GL query tests pass, including full-width
invalid input/output addresses that must not alias low addresses or dispatch
the renderer. The broader Rust run passed runtime-core 2,603 tests plus six
doctests, and xtask 809 unit tests plus its 2/4/2 integration tests. All 211
native EGL cases and all 38 GBM symbols/native UBSan/allocator poisoning
checks pass. Native transfer accounting now includes the GBM window's own
BO transfer; pointer assertions follow the native query width. These checks
are in `graphics-gbm-ring-broad-1028-180916-8d90`, which later failed its Node
selection: the new Node guest itself exited successfully but its test
wrongly counted driver-internal clearColor calls; an old normal smoke
binary had the previous ABI digest; and surface-before-context creation
exposed an attached-renderer bootstrap gap. Those repairs and the normal
program rebuild are being validated separately. The broad job did not
reach its browser step. No complete combined gate is claimed.

Standalone host TypeScript checking still reports 42 diagnostics, including
Vite module declarations and imports outside host/src. A read-only owned
checkout control at 09a6401b2b reports the same 42 file/code/message
signatures with no added or removed signatures. Logs and comparison are
`.context/graphics-gbm-ring-host-types{,-before}.log` and
`.context/graphics-gbm-ring-host-types-comparison.json`. This is a matched
baseline comparison, not a clean type-check result.

KMS visibility/orientation, CPU-facing native windows, forwarded storage,
the affected C rendering replays and complete current-source consumer,
memory, CTS and POSIX gates remain ordinary work. B03 remains partial.

### Completed render-ring checkpoint and next orientation repair

The normal `scripts/build-programs.sh` run completed all 239 program
stamps in `graphics-gbm-ring-repair-validation-1028-181812-8ec9`. Its Node
selection passed 223/224 cases in 11 files with zero skipped/unloaded
cases. All 12 normal SDK cases passed, including both widths of device
retirement, native-window metadata and rendered-ring ownership. The only
failure was the new source-only renderer test's incomplete WebGL double:
it omitted the standard getExtension method. Supplying that method made
all 35 context-creation cases pass in
`graphics-gbm-ring-checkpoint-final-1028-191453-7d97`. That job then passed
all 21 normal SDK browser cases in 34.7s across Chromium, Firefox and
WebKit. The 177 scratch-boundary cases had already passed unchanged.
The program build took roughly 51 minutes, including GTK/SDL dependencies
and normal fork instrumentation; it was not a quiet-machine interval.

An actual SDK/KMS consumer now confirms the unselected-swap repair. Its
locked front contains green at the window's lower-left and blue at its
upper-right, and the visible canvas stays black until KMS selection.
After selecting the front, however, those markers appear at the wrong
vertical positions. `graphics-gbm-native-kms-probe-v3-1028-183031-b8a4`
preserves that failing exact-pixel control, trace and screenshot under
`.context/graphics-gbm-native-kms-probe-v3-results/`. Its source is saved as
`.context/gbm-native-kms-before-normalization.c` and
`.context/gbm-native-kms-probe.spec.ts`. The first two probe attempts failed
before selection because of a missing DRM include flag and an invalid
assumption that a 4x3 mode was advertised. The final probe consumes the
actual connector mode. Those setup failures are not graphics boundaries.

A row-normalization repair is being prepared in the isolated checkout
`.context/gbm-front-normalize`, leaving the completed normal build's inputs
unchanged. It keeps a private render back and copies into an unpublished,
top-row-first front. The existing KMS row convention stays intact. Six
source/failure checks, a kernel lifetime check and both native C harnesses
support that candidate. A source WebGL check passed all three engines;
its normal kernel/SDK build passed six retained-front guest cases, and a
normal SDK/KMS replay passed all three engines with the original visible
corner expectations. These are the isolated candidate's evidence, not
validation of the primary implementation before integration. Exact jobs
are `graphics-gbm-front-copy-isolated-v2-1028-190209-abc3`,
`graphics-gbm-front-copy-source-1028-190450-9a66`,
`graphics-gbm-front-copy-normal-1028-190931-d4b2` and
`graphics-gbm-front-copy-kms-1028-191457-e87e`. Complete current-source
consumer/image, memory, upstream CTS and POSIX gates still remain.

### Integrated top-row-first GBM front publication, 2026-10-28

The row-normalization repair is now integrated on top of 4d37cbc82b.
The earlier rotate-back model above is historical: the render back now
stays private and selected. Swap reserves an unpublished unlocked BO,
copies the completed render back into top-row-first buffer storage, and
publishes that BO only after an accepted host receipt. A failed copy
cannot modify a locked front or replace the previously published front.
The four-slot limit still includes one private render back and therefore
permits three simultaneous locked fronts. KMS retains its existing row
convention and remains the only display-posting authority.

The copy-only variant of GLIO_UPDATE_SURFACE has a named 32-byte record.
Rust resolves its destination GEM name through the caller's exact file,
validates dimensions/reserved fields and rejects self-copy. A temporary
storage reference survives until either accepted or rejected host receipt;
the surface's source reference never changes. The host preserves independent
read/draw framebuffer bindings, the source's read-buffer selector, scissor
state and pre-existing public GL errors. Private failures retain native-only
repair records until restoration succeeds. Native out-of-memory maps to
ENOMEM/EGL_BAD_ALLOC instead of publishing an incomplete front. This stays
within the single unpublished ABI56/kernel-host3 epoch; structural snapshot
changes still require matching fresh program artifacts.

`graphics-gbm-front-copy-primary-1028-193136-acbc` passed in 9m38s after
normal kernel, wasm32 SDK and wasm64 SDK bootstrap and generated-output
checking. Its exact results are:

- Runtime-core: 2,604 tests and six doctests passed.
- Xtask: 809 unit tests and its 2/4/2 integration tests passed.
- Native EGL: all 211 cases passed. GBM: all 38 public symbols and the
  native UBSan/allocator-poisoning ownership checks passed.
- Source host selection: 67/67 in four files, including eight new copy,
  error-ownership, rejection and repair cases.
- Normal SDK Node selection: 11/11 in eight files, with zero skipped or
  unloaded cases. The mock renderer is ownership evidence, not pixel proof.
- Actual SDK browsers: 33/33 in 50.6s across Chromium, Firefox and WebKit.
  Twelve cases execute the asymmetric KMS guest at both pointer widths
  through both WebGL scanout and the 2D presenter. The unselected display
  stays black; selecting the locked front produces the original green
  lower-left/blue upper-right markers. The guest also checks the imported
  raw BO's top-row-first storage. Remaining cases exercise retained fronts,
  device withdrawal, imports, modifiers and CPU map leases. Process exit,
  retirement acknowledgements, diagnostics and memory-message boundaries
  are checked; no assertion or timeout was relaxed.

Logs are `.context/graphics-gbm-front-copy-*.log`; browser artifacts are in
`.context/graphics-gbm-front-copy-browser-results/`. Each KMS run saves its
actual guest Wasm plus kernel/program/image hashes, engine version and
observed pixels under `.context/gbm-native-kms-guests/`. Current source,
SDK archive and kernel hashes are
`.context/graphics-gbm-front-copy-primary-identities.json`. The earlier
v3 orientation failure remains preserved at its original path above.

Origin/main was fetched again and remains cb0a8226c965, already merged.
The complete 239-program build above predates this copy-record snapshot;
it is not current consumer validation. Complete current program/image,
cage/sway, browser-memory, upstream CTS and POSIX gates still remain.
CPU-facing EGL windows, forwarded native BO storage, affected source-C
rendering replays and the other documented ownership gaps remain ordinary
implementation work. B03 and the overall compatibility baseline stay partial.

### Atomic GBM-device to EGL-file acquisition, 2026-10-28

EGL initialization previously borrowed the private device fd under the GBM
registry lock, released that lock, then duplicated the descriptor. Public
device withdrawal could close/reuse that descriptor in between. The new
private acquisition hook validates the exact live device identity and
creates a caller-owned CLOEXEC alias under the withdrawal lock. Successful
acquisition therefore precedes withdrawal atomically; otherwise EGL reports
NOT_INITIALIZED. The identity-only display lookup never uses its borrowed
fd for I/O. This closes the documented metadata-to-EGL acquisition gap;
cross-wrapper GEM-name coordination and failed destructor cleanup remain
separate ordinary gaps.

The native actual-GBM harness checks wrong/retired identities, unreadable
foreign pointers, CLOEXEC and independent fd lifetime after withdrawal.
The normal SDK native-window guest also terminates its display, withdraws
the GBM device, reuses the caller fd for /dev/null, and requires failed
reinitialization without closing that replacement file.
`graphics-gbm-display-acquire-1028-194517-4c3c` passed in 3m48s: normal SDK32
and SDK64 bootstrap; native GBM/UBSan and allocator poisoning; all 211 native
EGL cases; six normal SDK Node cases in three files with no skipped/unloaded
cases; and all 24 browser cases in 38.2s. Browsers cover both guest widths,
all three engines, retained fronts, device withdrawal and both KMS presenters.
The initial native EGL link attempt lacked the new private hook in its
standalone device double; supplying the same absent-device failure used
by that double repaired the harness. It was not a passing runtime run.

Logs are `.context/graphics-gbm-acquire-*.log`, browser results are
`.context/graphics-gbm-acquire-browser-results/`, and exact source/archive
identities are `.context/graphics-gbm-acquire-identities.json`. ABI56 and
kernel-host3 remain unchanged; complete combined gates remain required.

The independent ABI check in
`graphics-gbm-copy-abi-replay-1028-194203-651e` passed and explicitly requires
program rebuilds for the changed copy-record digest. Its subsequent older
C-operation platform-window replay failed six cases: native replay omits
the required stable DRM-file identity and forwarded replay rejects native
BO targets. These are preserved in `.context/graphics-gbm-copy-c-replay.log`
and `.context/graphics-gbm-copy-c-replay-results/`. They are ordinary replay
adapter/forwarding work, not a demonstrated host platform boundary.


### Source replay follows retained GBM storage, 2026-10-28

The source-C replay now supplies its synthetic stable DRM-file identity
when binding distinct context sessions. The native C double records each
accepted window allocation, its per-file GEM name and its canonical BO
identity. Its three windows have distinct backing names. The browser adapter
provisions real native storage from those records and translates the names
before surface creation; it does not invent allocations from an unverified
surface request or preset any expected pixels. Public C commands still
produce every rendered color. These remain source-operation replay checks;
the separate SDK guests validate real Rust marshalling and device ownership.

`graphics-source-replay-identities-1028-195157-7a0f` initially passed 53/72:
eighteen native cases failed for absent backing storage after the identity
repair, and one Chromium forwarded cross-session case changed its read pixel
after a rejected current-surface request. After adding the storage records,
`graphics-source-replay-storage-1028-195729-1b39` passed all 211 native C cases
and 71/72 browser cases across Chromium, Firefox and WebKit. All eighteen
missing-storage cases now pass their original pixel/lifetime assertions.
The Chromium forwarding failure reproduced and remains open; the other
engines passed that case. Logs and traces remain in the matching
`.context/graphics-source-replay-{identities,storage}*` paths. Forwarded
native BO-source transport also remains unimplemented. This is not a fully
passing source-replay selection or evidence of an outside engine defect.

The separate logical-image-view source selection passes all three engines
in 11.9s (`.context/graphics-replay-image.log`), exercising the fourth updated
import adapter. The enclosing diagnostic job
`graphics-forward-routing-diagnostic-1028-200248-b477` is still a failure:
its five routing diagnostics never reached rendering because moving the
wrapper config changed Vite's working directory and the page returned HTTP
failure. Fixing that diagnostic server root is provisioning, not a graphics
repair or a passing routing result.


Forwarded cross-session diagnosis preserves the original failure. Ten plain
Chromium repetitions passed five and failed five in
`graphics-forward-routing-plain-1028-200441-8e61`. Adding native state queries
made five diagnostic repetitions pass; that instrumentation is not a repair.
A trace without extra GPU queries passed seven/ten, a storage-operation
trace passed three/ten, and a complete 832-call native API trace passed
six/ten. Failing traces retain green followed by blue at the same logical
read/draw framebuffer bindings; only getError/isContextLost calls intervene.
The complete failing call stream is `.context/routing-full-failing.json`.
No diagnostic instrumentation was added to production or the original test.

Three self-judging reductions contain no Kandelo runtime code: a minimal
asynchronous WebGL page, a worker/mailbox-driven page and a replay of the
captured native API calls and task groups. Each passed 100 cycles per engine
in Chromium 153.0.8010.12, Firefox 155.0 and WebKit 26.6. Their jobs are
`graphics-standalone-read-framebuffer-1028-200840-5688`,
`graphics-standalone-worker-read-http-1028-201201-ecdc` and
`graphics-standalone-api-read-1028-201545-c611`; HTML, runner, per-engine
results and logs remain in `.context/standalone-*-read-framebuffer*` and
`.context/graphics-standalone-*`. Initial worker reductions lacked the
required isolated HTTP document (one was stopped with status143); they
are setup failures, not standalone passes. The proper HTTP runs pass all
three engines. No outside defect is demonstrated, no workaround is shipped,
and the forwarded pixel failure remains ordinary unresolved work.

### Current normal compositor/CTS consumer checkpoint, 2026-10-28

The primary implementation now has a fresh normal program, package and
focused consumer checkpoint after the retained-front, wasm64-query and
native-device file-acquisition repairs. Program ABI56/kernel-host3 remain
the single unpublished epoch. Main was fetched again and remains
cb0a8226c965, already merged. No branch or contributor history was rewritten.

`graphics-gbm-current-consumers-1028-195118-e1ab` completed all 239 normal
program stamps (zero already-current) and built 59/60 selected package
nodes, including cage, sway, foot and rootfs. The sole failed node was
upstream graphics-cts-egl: the new GBM archive references
`drmCloseBufferHandle`, but that recipe did not declare/link libdrm. This
was a real normal-build failure; the later consumer tests in that job did
not run. The recipe now declares libdrm 2.4.134, overlays that resolved direct
dependency into its private sysroot and places -ldrm after its graphics
archives. Neither upstream assertions nor published capabilities changed.
An initial manifest edit used the old 2.4.124 version and was correctly
rejected before building; that failed retry is preserved separately.

`graphics-gbm-current-consumers-resumed-v-1028-205510-6d0c` then passed in
7m43s. All 60 graph nodes succeeded: 59 cached and CTS newly published.
Normal host/rootfs refresh and verify-fresh passed. The normal Node selection
passed 20/20 in nine files, zero skipped/unloaded cases, in 213.32s. It covers
cage/sway/foot sessions, GBM ring bookkeeping, both widths of native EGL
windows, BO teardown, KMS modes/page flips and libdrm requests. The renderer
double is lifecycle/input evidence, not pixel proof.

The rendered browser selection passed 54/54 in 3.6m across Chromium,
Firefox and WebKit. Six actual upstream cage/sway sessions render a normal
client through GLES2, route input and exit with checked status and retirement.
Other cases exercise inherited DRM authority, all five scanout formats,
primary GPU scanout and the pinned upstream EGL surfaceless subset on every
advertised GLES2 configuration. Exact pixel, diagnostic and memory-message
checks remain unchanged. This passing inherited-display run does not resolve
the separately preserved intermittent Firefox cursor-capture failure.

The six compositor runs share kernel SHA256
`d67643211332aa1ed71f879571fd89cb3b33305b806b25b2bb7cbd6de09f9a1c`.
Per-engine kernel/compositor/client/image identities, statuses, device stats
and actual PNGs are under `.context/wlroots-rendered-sessions/`; the current
batch spans `1793235600473-chromium-cage` through
`1793235769836-webkit-sway`. The source/archive/package identities and exact
six evidence paths are `.context/graphics-gbm-current-consumer-identities.json`.
Logs and results are `.context/graphics-gbm-current-*`, including preserved
initial failure logs and the resumed-v2 result paths. These are automated
focused package consumers, not manual browser or current full-gallery proof.

The full current-source gallery, browser-memory, broader upstream CTS and
POSIX gates still remain. The current CTS package covers only its pinned
surfaceless subset; 54 passing consumers do not establish full GLES2/EGL
conformance. Forwarded BO sources and its reproduced cross-session pixel
failure remain ordinary gaps. CPU-facing native windows are still rejected
on the primary branch. Their isolated candidate has passing native ownership,
format/pitch contracts and host-store tests, but its actual CPU guest exposes
the pre-existing rejected CPU EGLImage/renderbuffer source path. A separate
pending-map zero-fill race was reproduced and repaired in that candidate's
source store; neither change is integrated or current consumer validation.
The candidate and its work notes remain at `.context/gbm-cpu-fronts/`.

Twenty fresh-page Chromium repetitions of the captured native-API standalone
replay also pass (`graphics-standalone-fresh-api-read-1028-203042-f4ca`).
Together with the earlier 100-cycle controls, this still supplies no outside
fault reproduction for the original forwarded pixel failure.


### Current checkpoint gates and CPU image layout work, 2026-10-28

The validated compositor checkpoint is commit `9a9dec0bf4`. Its full
browser-memory gate is `graphics-retained-front-memory-1028-211051-11ed`;
current libc/POSIX/Sortix provisioning and suites run in the owned detached
checkout `.context/graphics-current-conformance` through
`graphics-retained-front-conformance-1028-211445-7ed5`. Both are pending;
neither is a passing result. The conformance checkout owns its SDK, host,
kernel and normal product projection, pinned libc-test revision
`790f94c7b6feb8ade25868c10fba46233f783a0b`, and a separate case-sensitive
Sortix checkout at revision `7e8f0082ab0b58ad3383a8abbf47dc4b40dcf25d`.
An unnecessary second provisioning attempt failed when its clone destination
already existed; the original registered job remained active.

CPU-image work remains isolated under `.context/gbm-cpu-fronts`. Its first
host mirror prototype does not resolve the normal guest failure: libc's
`_wpk_egl_image_texture` explicitly refuses mapped images and its renderbuffer
entry point rejects them before requesting any host source. The legacy CPU
texture entry point makes a one-time row upload, without retained shared
storage. Simply removing these guards would be wrong: the existing raw-BO
request omits the image's declared format, pitch, dimensions and byte offset.
The candidate now introduces an explicit layout-bearing private request,
CPU-storage native mirrors separate from GPU-tier scanout objects, and
ordered publication between image siblings. This code is not integrated,
not yet rendered-validated and does not establish full CPU-image support.
Its draft ABI remains the single ABI56/kernel-host3 epoch; matching candidate
artifacts must be regenerated rather than reusing primary artifacts.

The first source-only selection ran 98 tests: 97 passed and one failed
because the initial prototype changed the existing unknown-source errno.
The old raw request's failure is restored while the new layout request owns
CPU image imports. The first new wire validation caught an unsorted ioctl
contract-table entry (86 shared tests passed, one failed); its placement is
corrected before retry. These are ordinary implementation failures, not
platform boundaries. Normal guest pixel/import assertions remain intact.


The isolated layout candidate's normal run
`graphics-cpu-image-layout-v2-1028-212801-f47e` passed in 7m17s: shared wire
checks, normal kernel, SDKs at both widths, generated snapshot check, and
one real Chromium wasm32 WRITE-window/KMS case with the original imported
renderbuffer and selected/unselected pixel assertions. This follows the
preserved failing CPU case; it is not a full engine/width/layout result.
Source/kernel/program identities and the successful case evidence are under
that checkout's `.context/cpu-image-first-v3*` and
`.context/gbm-native-kms-guests/`.

The expanded candidate adds a normal guest check that destroys the public
EGLImage while its renderbuffer sibling survives, writes mapped bytes then
reads through GL, writes through GL then observes the live mapping, and
restores the original KMS test pixels. Its run is
`graphics-cpu-image-expanded-1028-213732-edcc`, still pending. Its preliminary
checks pass: the new Rust layout/no-write-on-rejection test, all 211 native
EGL cases, the native GBM harness, evidence-class registration, and 109/109
focused source host cases (zero skipped/unloaded). The source checks include
layout identity, four advertised channel layouts, disjoint/unchanged sibling
publication, rejected readback/publication, native deletion retries, and
XRGB implicit alpha. The latter failed before its repair and is preserved
in `cpu-image-source-v4.log`; all original assertions remain. The candidate
host type check reports 42 baseline diagnostics, with no additions or removals
by normalized file/code/message against the prior retained-front checkpoint;
it is not a clean type check. Evidence is
`.context/gbm-cpu-fronts/.context/cpu-image-*`.


### CPU fronts, retained images and multiple CPU aliases, 2026-10-28

The isolated candidate's expanded run
`graphics-cpu-image-expanded-1028-213732-edcc` passed in 8m37s: the Rust
layout/no-write-on-rejection test, 211 native EGL cases, native GBM checks,
109 focused host cases, normal kernel/generated verification, and 54 real
browser cases in 2.7m. The browser matrix covers both widths, GPU/WRITE/
LINEAR/CURSOR windows, WebGL/2D presenters and all three engines. CPU cases
retain a renderbuffer after public EGLImage destruction and test CPU→GL and
GL→live-mapping visibility before restoring the existing KMS pixel oracle.
The exact 48 native-window guest/image/kernel identities and source hashes
are preserved in the candidate's `.context/cpu-image-expanded-identities.json`;
the other six cases are retained-ring cases. These results predate the next
multiple-mapping repair and are not combined primary-checkpoint gates.

A further source regression showed a genuine same-process alias defect:
registering a second mapping made writes through the first disappear from
canonical storage. The source control failed (26 passed, one failed) in
`.context/gbm-cpu-fronts/.context/cpu-multiple-maps-before.log`. The host store
now retains each process/address alias, with its own zero-fill/prime barrier
and independent changed-byte snapshot. Kernel unbind notifications already
carry addresses; the host now uses that exact address instead of removing
all aliases. The worker primes the specific successful mmap address.
No guest memory or views are retained in the new device mirror/repair records.

After this repair, all 111 focused source cases pass. The normal Chromium
wasm32 WRITE-window case additionally passes real imports of all four
advertised dma-buf channel layouts with nonzero offsets, non-allocator pitch,
a live application mapping across multiple image mappings, CPU/GL writes,
preserved row padding/X bits and implicit alpha one for XRGB. The evidence is
`cpu-image-layout-maps-first.log` and its guest/result artifacts in the owned
candidate checkout. This remains a narrow post-repair rendered result;
both-width/all-engine repeats and broader Node/source validation are next.

CPU native mirrors remain distinct from GPU-tier BOs used for scanout. They
carry explicit imported layout identity and merge changed sibling bytes into
canonical CPU storage. Accepted writes whose native readback/publication
fails retain authority until retry, before a CPU upload can erase them.
The current implementation synchronizes eagerly at command boundaries;
performance has not been measured. Fork-inherited mapping registration,
forwarded BO/image sources, full negative/lifecycle validation and broader
CTS remain open. CPU changes do not close those inventory rows or establish
full GLES/EGL/GBM conformance. Current browser-memory and POSIX jobs still
validate the earlier `9a9dec0bf4` checkpoint, not this candidate ABI snapshot.


### Mapping ownership, fork inheritance and retry visibility, 2026-10-28

A mapping-only BO owner was missing from the kernel model: closing the last
DRM description destroyed storage even while its mmap remained live. The
new Rust regression failed at that exact assertion in
`graphics-fork-map-lifetime-before-1028-220340-e29b`. Accepted DRI and PRIME
mappings now retain independent BO references, with reserved metadata before
host publication and rollback on rejection. Unmap, exec, exit and forced
removal collect ordered alias-unbind/final-destruction effects.

Fork/vfork inheritance now acquires mapping references from the live parent,
including mappings with no open descriptor. A fallible preparation guard
releases only its own references on failure. The child adopts those exact
mapping identities; serialized guest bytes cannot mint them. The kernel
announces pending host aliases, and the common Node/browser launch step
preflights every destination before priming the completed clone. Pending
clone bytes cannot publish stale pixels. Fork record 21 is unchanged.

The first normal guest still failed at both widths: initial inherited bytes
were correct, but the child observed stale data after a successful poll.
Traces showed that frozen blocking retries bypass the original dispatch's
post-syscall readiness hook. The final retry path now synchronizes BOs using
its captured operation identity, before publishing success. Successful
kernel-decided waits also synchronize before waking their exact generation;
DRI mappings exclude a transfer from direct publication that omits host
coherence. Temporary source instrumentation was removed. The first failed
normal run and the incomplete intermediate repair remain preserved; no
outside runtime defect or timing-based workaround is claimed.

`graphics-fork-map-contracts-1028-221110-8f75` passed the full runtime-core
suite: 2,608 tests plus six compile-fail documentation cases. The DRI source
selection passed 29 cases, including an invalid inherited destination that
must leave every child alias unpublished. A separate wider selection ran
107 passing cases but one unrelated spawn fixture file did not load because
its normal exec-child artifact was absent; that is not a full selection pass.

`graphics-fork-map-normal-final-1028-223912-53ac` passed in 2m06s: 302 source
host cases in nine files, normal kernel/host builds, generated ABI and fresh
artifact checks, both-width normal Node guests (2/2), and real browser guests
at both widths in Chromium, Firefox and WebKit (6/6, 43.6s). The guest closes
its final device descriptor before fork, checks later parent-to-child writes
at readiness, retires the child mapping before the parent consumes its final
write, and keeps the parent's storage until final unmap. Original guest
assertions and teardown/message checks remain intact. Evidence and exact
engine/program/image/kernel/source identities are
`.context/gbm-fork-aliases/.context/fork-map-final-*`, including
`fork-map-final-identities.json` and `dri-mapping-fork-guests/`.

This is focused validation of the combined CPU-storage/fork source, not full
compositor or conformance validation. The source remains ABI56/kernel-host3
with operation table17/fork record21 and matching normal artifacts. Earlier
memory/conformance jobs still target `9a9dec0bf4`; the normal full program
build and expanded CPU consumer selection target `01f7b80a0f`. Its initial
Node selection passed 22 cases but failed overall on a missing GBM smoke
artifact and skipped the absent dumb-roundtrip program. The normal program
builder is provisioning those inputs before rerun, without weakening skips
or substituting bytes. Full combined cage/sway, memory, POSIX and broader CTS
remain pending. Partial munmap fragments, MAP_FIXED/mremap device mapping
transitions and distinct GBM wrappers over aliased DRM files remain ordinary
mapping/ownership gaps; these focused passes do not close inventory B02.


### Completed retained-front conformance and combined consumer provisioning

The original `graphics-retained-front-conformance-1028-211445-7ed5` job
completed successfully after 1h59m against `9a9dec0bf4`, with its own normal
SDKs, kernel, host and rootfs. The exact suite counts are:

| Suite | Pass | Unexpected fail | Expected fail | Other | Total |
| --- | ---: | ---: | ---: | --- | ---: |
| libc-test | 306 | 0 | 17 | 1 known-flaky test passed | 324 |
| Open POSIX | 174 | 0 | 3 | 2 skips | 179 |
| Sortix | 5,065 | 0 | 23 | 50 skips | 5,138 |

All three exit statuses are zero. There are no build failures, timeouts or
unexpected passes. `ALLOW_RAISE_RACE=1` was selected explicitly for the
existing libc race classification. The pinned libc-test source is the
checkout's recorded submodule, and Sortix is
`7e8f0082ab0b58ad3383a8abbf47dc4b40dcf25d` in the dedicated case-sensitive
source tree. Logs and the exact runner are under
`.context/graphics-current-conformance/.context/retained-front-current-*`.
These are earlier-checkpoint results and do not validate the CPU/fork or
subsequent file-owner changes.

The normal combined consumer graph for `08d0713f33` built cage, sway and its
selected dependency closure. Its first Node gate passed 15 loaded cases but
four files could not load: `wlclient-test`, `kms-pageflip-smoke` and
`libdrm-kms-smoke` were missing standalone programs. That run is not a full
Node pass. A subsequent 114-case browser selection passed 108 cases; all six
cage/sway cases failed before startup on the same absent `wlclient-test`
artifact. Trace evidence confirms this is provisioning, not a rendered
assertion failure. No assertion or enabled case was weakened. Logs are
`.context/gbm-fork-aliases/.context/fork-map-consumers-{node,browser}.log`.

The 108 passing browser cases include the normal CPU layout/front matrix,
retained rings, inherited mappings, scanout formats, DRM inheritance and the
pinned EGL CTS subset across all three engines. Their full-source checkpoint
includes the multiple-map and fork repairs. This is still not complete
compositor validation. `graphics-fork-consumers-complete-1028-231632-846c`
is running the normal full program builder before repeating the original
Node and browser selections. The earlier CPU checkpoint's own full program
and broader consumer gate remains separately active. Browser-memory still
targets `9a9dec0bf4` and remains running; it must not be reported as current
file-owner evidence.


### GBM file identities and queued DRM ownership, 2026-10-28

Two GBM device wrappers built from aliases of the same DRM file shared one
kernel GEM name but retired it independently. The native source regression
failed when the first BO's destructor closed the surviving peer's handle
(`file-alias-gbm-before.log`). Devices now retain an explicit shared file
owner through BO retirement, including after public device withdrawal. Each
wrapper keeps its own private CLOEXEC descriptor. Peer retirement compares
the file identity and GEM handle, without merging independent opens of the
same device. An initial prototype shared the private descriptor too; an
existing ring-retirement assertion caught that change, and independent
private aliases were restored before final validation.

The kernel implements `F_DUPFD_QUERY` (1027), comparing stable machine-wide
`OfdId` values rather than descriptor numbers, table slots or inode identity.
The corrected pre-change Rust control returned EINVAL instead of 1.
Self/dup/transferred-slot identity, independent opens, invalid descriptors,
reused descriptor numbers and unchanged flags now have focused Rust evidence.
The command and behavior follow Linux v6.16's
[UAPI definition](https://github.com/torvalds/linux/blob/v6.16/include/uapi/linux/fcntl.h)
and [fcntl implementation](https://github.com/torvalds/linux/blob/v6.16/fs/fcntl.c).
The earlier control command initially used an incorrect Cargo package name;
that setup failure is not the reproduced API failure. The actual failed
assertion is `file-alias-query-before-corrected.log`.

Extending the normal SDK guest from dup to SCM_RIGHTS exposed a separate
EOPNOTSUPP restriction on sending DRM descriptions. Queued descriptors now
carry validated weak reconstruction metadata, upgraded to owned shared GEM,
KMS and native-cleanup records only during the send ownership transaction.
Metadata is bound to the exact open-file identity and DRM kind. Receivers
adopt these live resources with no sender GL command mapping/current-context
authority. Peek acquires an independent queue hold; receive transfers its
hold; discarded entries defer cleanup until global table borrows end.

The forced-removal control then reproduced a real leak after a datagram's
last queued DRM owner disappeared (`file-alias-forced-cleanup-before.log`).
The common deferred-release primitive now returns graphics retirement effects
for both DRM and PRIME holds. Normal syscall cleanup applies them; forced
process removal collects them for its host adapter. Both paths release the
same kernel references and destroy backing exactly once. The regression
covers a DRM-file sidecar and a queued PRIME descriptor. Additional Rust
checks cover sender close, peek, discard, live card capabilities, mismatched
identity rejection and absence of transferred GL execution authority.

`graphics-file-alias-complete-1028-233805-07b0` passed in 4m10s:

- Full workspace Rust selection, excluding the separately tested xtask:
  runtime-core 2,612 plus six compile-fail documentation cases; shared 87;
  remaining workspace suites passed as recorded in the complete log.
- Normal kernel and host builds, ABI/generated-output verification, and
  matching SDKs at both widths. The earlier SDK-provisioned xtask run passed
  809 unit and eight integration cases; that result predates the SCM cleanup
  additions and is not a new full xtask result for those additions.
- Four Node guests with no skipped or unloaded cases: file aliases and
  inherited mappings at both widths.
- Twelve real browser guests in Chromium, Firefox and WebKit (56.7s): the
  same two fixtures at both widths. File-alias cases exercise dup and
  SCM_RIGHTS, both BO destruction orders, a publicly retired wrapper,
  descriptor closure/reuse, live mapping and PRIME export, and independent
  file opens whose numeric GEM handles happen to match. Teardown/message
  boundary assertions remain enabled.

The native GBM harness also passes and all 38 public symbols remain defined.
Its macOS descriptor double models actual duplicate operations, not inode
comparison; the normal SDK guests exercise the real kernel query/transfer.
Browser dependencies were provisioned normally after a missing executable,
and an occupied test port was replaced with a free port. These were setup
failures, not outside runtime defects. All preceding failed runs remain in
`.context/gbm-file-aliases/.context/`.

Exact source/engine/program/image identities and the 12 JSON results are in
that checkout's `file-alias-complete-identities.json`, with `file-alias-*`
logs and the original failed controls. The final kernel SHA-256 is
`e038ca1b98be06ed49ac31b061528a3da57dc32b9443756969cf437c40e0cf6f`.
Generated outputs retain ABI56/kernel-host3, GL table17 and fork record21;
the new fcntl constant changes the program digest, so old artifacts cannot
be restamped or treated as validation of this checkpoint. Main was fetched
again and remains `cb0a8226c965` (ABI55/kernel-host2).

This closes the focused same-file GBM wrapper and queued-DRM ownership gaps,
not inventory B01/B02/K03 as a whole. Partial VMA changes, broader failure
recovery, forwarding, full CTS and combined consumer/memory/conformance
validation remain open. The ongoing compositor build targets `08d0713f33`,
and the full memory gate targets `9a9dec0bf4`.

The older CPU checkpoint's normal program builder completed 239 stamps.
Its subsequent 10-file Node gate loaded every case but timed out in the
five-second outer test budgets of the standalone surface and fork-roundtrip
cases (22 passed, two failed). Both pass unchanged in isolation with one
worker (2.6s and 2.9s), but the complete one-worker repeat still times out in
those same cases. This is an unresolved full-selection failure, not proof of
an outside runtime defect, a repaired fork bug, or an obsolete smoke oracle.
No timeout or pixel assertion was changed. The independent expanded browser
selection is running separately; its result cannot turn the failed Node gate
into a complete pass. Logs are the CPU checkout's
`cpu-image-broad-node-{v2,serial}.log` and `cpu-smoke-timeout-control.log`.


### Completed memory gate, rendered file-owner gate and Node tool control

The earlier-checkpoint full memory job
`graphics-retained-front-memory-1028-211051-11ed` is terminal, exit 1 after
2h41m including normal full preparation. Its pre-browser selections passed
162/162, 3/3 and 7/7. The real browser selection passed eight cases and failed
one in 18.6m. WebKit's constrained switching scenario reached LÖVE after
DOOM, Quake and Freeciv, then failed to find the LÖVE primary canvas within
180 seconds. This is before cage/sway in that cycle, so this run does not
prove that sequence on WebKit. Chromium/Firefox cases and all exit-trap
cases passed. No outside-engine defect is confirmed by this failure.

The exact failed trace, screenshot, page context, full job log and checkpoint
identity were copied to `.context/retained-front-memory-webkit-failure/`
before changing the primary checkout. Its kernel hash is
`d67643211332aa1ed71f879571fd89cb3b33305b806b25b2bb7cbd6de09f9a1c`, source
`9a9dec0bf4`. The primary branch was then fast-forwarded to `730a0132c0`,
retaining its name and pre-existing local submodule/untracked changes.
Primary artifacts from the old checkpoint require normal rebuilding; only
the file-owner checkout's own normal artifacts prove its latest guest gates.

The latest file-owner source's rendered gate
`graphics-file-alias-rendered-1028-234713-4119` ran all 66 selected cases,
with 65 passes and one failure (4.8m). All 48 GBM native-window cases and six
retained-ring cases passed across widths, usages, presenters and engines.
Eleven inherited-display cases passed. Firefox's `render-node-2d` case
failed the white corner pixel assertion after the opener Worker exited;
the cursor and red-center assertions had passed. This is a preserved
presentation failure, not the earlier cursor-capture assertion and not a
full inherited-display pass. The original ten-second pixel predicate remains.
Logs, traces and screenshots are in the file-owner checkout's
`.context/file-alias-rendered*` and
`.context/graphics-abi56-format-evidence/`. Focused repeated controls are
running against the same unmodified source and assertions.

The older CPU checkpoint's separate 66-case browser selection finished at
65 pass/one fail (3.2m). Its failure is a different Firefox case: wasm64 GPU
window through the 2D presenter stayed black at the selected-frame sample.
Guest stdout reached READY_SELECTED with no diagnostics. The failed trace
is in `.context/gbm-cpu-fronts/.context/cpu-image-browser-independent-results/`.
It remains unexplained; no platform boundary is claimed.

The full older CPU Node selection is now verified with its original test
files and original five-second outer budgets. The failing broad commands
selected the debug xtask; the isolated passing control selected release.
A diagnostic with 30-second outer budgets passed 24/24 but was not retained.
Both test files were restored byte-for-byte to `01f7b80a0f`, and the complete
10-file/24-case selection then passed with the normal release xtask in
88.82s, zero skips or unloaded files. The successful job is
`graphics-cpu-image-node-release-1028-235209-4231`, log
`.context/gbm-cpu-fronts/.context/cpu-image-broad-node-release.log`.
The debug-tool failures and temporary diagnostic patch remain preserved.
This resolves that bounded Node gate without changing an assertion, timeout,
or fixture. It does not make either failed browser or memory gate pass.


### Partial DRI unmap fragments and completed compositor gate, 2026-10-29

The previous implementation revoked every DRI alias touched by `munmap`.
The new Rust regression reproduced that loss: unmapping the middle of a
three-page BO after final fd close left zero bindings instead of two.
A normal SDK guest against source `730a0132c0` also failed: after partial
unmap and fork, the child did not see its parent's writes to surviving
fragments. Its log/result are the file-owner checkout's
`.context/vma-guest-before.{log,json}`. That control predates the additional
anonymous-hole replacement assertions, which are covered by the final gate.

The kernel now preallocates fragment metadata and checked BO references
before destructive cleanup, preserving reference-overflow failure without
host unbinds. Prefix/suffix trims and middle splits retain their canonical
byte offsets. The host flushes the retiring interval and keeps independent
snapshots for the surviving ranges. Fork binds those canonical offsets
before priming child memory. A second host regression reproduced a lost
reader notification created by a retiring alias's final flush; retirement
now preserves that notification. Removed holes do not publish or consume
BO bytes after replacement with anonymous memory.

Validation in `.context/graphics-vma-fragments`:

- Workspace Rust suite passed, including 2,614 runtime-core tests, 87 shared
  tests and six compile-fail runtime-core documentation cases. The five
  focused `munmap_dri` cases and 31 DRI registry source cases passed.
- Normal own wasm32/wasm64 SDK, kernel, side modules and host were built.
  Snapshot generation changed only the kernel-host bind import signature
  to include the BO offset. Program ABI 56, kernel-host 3, GL table 17 and
  fork record 21 remain the single unpublished combined epoch.
- Final job `graphics-vma-fragments-final-1029-002325-7530` passed after
  2m18s: normal kernel/host rebuild and ABI check; all 35 selected Node
  cases (zero skips/unloaded files); all 12 browser guest cases (46.6s).
  Both pointer widths passed Chromium, Firefox and WebKit, including the
  earlier complete-map fork case, new middle/prefix/suffix unmaps, hole
  reuse, opposite unmap orders and shared GBM file aliases.
- Final kernel SHA-256:
  `9c473d8981740989b660785357d1982521a296a115b2c58b5f2662936699628e`.
  Logs are `.context/vma-{workspace,final-*,guests-*}`; browser records in
  `.context/{dri-mapping-fork,gbm-file-aliases}-guests/` retain the exact
  guest/kernel/image hashes, engine versions, statuses and diagnostics.
  Vite's optional gallery dependency scan reported the absent rootfs in
  this focused checkout; the fixtures constructed their own normal images
  and all required guest cases ran. This is not a gallery validation claim.

The earlier source `08d0713f3361` compositor job
`graphics-fork-consumers-complete-1028-231632-846c` completed after 1h01m.
Its normal program build stamped all 239 outputs; the nine-file Node gate
passed 21/21 (no skips/unloaded files), and the complete three-engine browser
selection passed 114/114 in 6.9m, including actual cage/sway sessions. Logs
are the fork checkout's `.context/fork-map-consumer*`. That is bounded
checkpoint evidence, not validation of subsequent file-owner/unmap changes.

The unchanged file-owner inherited-2D repeat is also terminal: 27/30 passed,
three Firefox failures. A temporary diagnostic repeat passed 7/10 and
failed 3/10. It recorded the correct red center/white marker at GPU readback
and 2D presentation before 10–20-second capture stalls. The instrumentation
was removed and saved as `.context/file-alias-readback-diagnostic.patch` in
that checkout. A new standalone browser-only capture reduction reproduced
a stability/capture timeout without Kandelo code or Wasm on Playwright
Firefox 155.0; further controls must distinguish tooling from engine
behavior. No product runtime workaround or hard platform boundary is
claimed. The older broad WebKit memory failure remains open too.

Device `MAP_FIXED`/`mremap`, complete combined compositor/gallery/memory and
POSIX reruns, broader CTS/API negative/lifecycle work and the unexplained
rendering failures remain required. This increment closes only the focused
partial-unmap ownership/coherence gap; B02 stays partial.


### Fixed anonymous/private-file replacement of DRI mappings, 2026-10-29

A new kernel regression on source `5eedcb9aa7` reproduced a distinct gap:
fixed anonymous replacement of the middle page updated the allocator but
left one complete DRI binding instead of two surviving fragments. The
failed-allocation control passed. The actual before result is preserved
as the file-owner checkout's `.context/fixed-anonymous-before.log`.

A prepared device-unmap transaction now reserves fragment metadata and BO
split references before allocation. Only a successful anonymous/regular-file
fixed allocation commits the old device interval's retirement. The old
process bytes remain readable for final device publication until host
post-syscall population begins. Aborted allocation returns every temporary
BO hold, including a split hold acquired before an allocator rejection;
it leaves the old device binding and host views intact. `munmap` uses the
same retirement plan. Fixed unaligned addresses in this path fail with
EINVAL. Replacement by another device mapping is a separate remaining gap.

The ordinary dual-width SDK guest now replaces the middle of a live BO
directly with anonymous memory and with a private memfd mapping, without
an intermediate unmap. It checks file population, fd retirement, private
replacement bytes across fork, shared left/right BO writes and opposite
retirement orders. Earlier full-map, partial-unmap and hole-reuse checks
remain enabled with their original assertions.

`graphics-fixed-mapping-final-1029-003756-2848` passed in the file-owner
checkout after 19m15s. It ran the complete workspace Rust selection,
including 2,616 runtime-core tests, 87 shared tests and six compile-fail
runtime-core documentation cases, then normal matching kernel/side-module/
host builds and the ABI check. All 35 selected Node/source cases passed
with zero skips/unloaded files (295.42s including preparation). All 12
browser guest cases passed (2.8m), both pointer widths in Chromium,
Firefox and WebKit. No ABI/snapshot/generated definitions changed in this
increment: ABI 56 / host 3 / GL table 17 / fork record 21 stay fixed.

The kernel SHA-256 is
`bbacec8e939d8e0beb75c55f06cc5384cb8d741c90b6fbb7850a6358e019bd38`.
Logs and traces are the file-owner checkout's `.context/fixed-mapping-*`;
normal browser guest JSON records retain image, program and kernel hashes,
engine versions, exit statuses and diagnostics. The optional Vite gallery
scan again reports the absent rootfs in this focused checkout. All selected
guests build their own normal images and ran; no gallery claim is made.

The primary checkout remains frozen at `5eedcb9aa7` while its normal
products/complete consumer/browser-memory job runs. Its separate pinned
libc/POSIX/Sortix job is also still running. Those jobs predate this fixed
replacement increment; results cannot be counted as complete combined
validation of the newer source. Device-target replacement, device mremap,
full combined gates and broader API/CTS work remain open. No performance
claim or hard platform boundary is inferred from these focused passes.


### Corrected source/prepared evidence ordering, 2026-10-29

The explicit evidence-class audit found a sorting mistake introduced by
`730a0132c0`: the GBM file-alias test row was placed among DRI rows. Direct
focused Vitest invocations still executed their cases, but the CI-shaped
registry check correctly rejected that inventory. The row now lives in its
byte-sorted GBM position; its prepared-product classification is unchanged.
`scripts/dev-shell.sh bash scripts/check-vitest-evidence-classes.sh` passes:
628 files, registry and actual Vitest inventory agree. No tests, assertions,
timeouts or product runtime behavior changed in this correction. The
primary checkout's running jobs still use their earlier frozen source;
this corrected audit is not evidence that their complete gates passed.


### Independent Firefox capture control, 2026-10-29

The manual diagnostic now lives at
`tests/browser-tooling/firefox-offscreen-capture/`. It imports only the
declared Playwright dependency and uses ordinary browser APIs, without
Kandelo modules, Wasm, shared memories, SDK programs or VFS images. The
final model explicitly retains both transferred planes and waits for their
visible pixels before repeated captures. Early scratch color mismatches
without those ownership/readiness guards are not evidence for this failure.

On macOS 27.0.1 arm64, Playwright 1.63.0 / Firefox 155.0, the fixed three-run
continuous GPU-readback selection timed out in all three runs after visible
readiness, during steady capture rounds 7, 1 and 9. A clipped-page capture
control also timed out. The corrected 2D-only control passed three runs
(180 steady exact-pixel captures), and the once-painted GPU control passed
three runs (another 180). The final files have run from their registered
repository path. A prior registered scratch run passed, while a later
three-run scratch selection contained startup mismatches; those remain
preserved and cannot be substituted for the corrected controls.

Exact traces and per-request stages/pixels are in the file-owner checkout's
`.context/offscreen-capture-retained-{gpu,viewport,2d,once}-results/`, with
matching `.log` and status files. The independent failure is specifically
capture timing, not a Kandelo API/guest failure. Responsibility between
tooling and the engine remains unresolved. It does not prove that every
Kandelo rendering failure shares that cause or close the product gates.

Temporary PNG-decoder and browser-preference controls did not resolve the
failure. Those changes remain private diagnostics; normal product tests,
assertions, deadlines, browser preferences and runtime behavior are intact.
No upstream report was filed. No product workaround or hard platform
boundary is claimed, and the tooling-only diagnostic does not get a runtime
workaround registry entry under that registry's explicit exclusion.


### Device remap ownership and fixed-size GEM semantics, 2026-10-29

Two new regressions reproduced incorrect device `mremap` behavior on
`5e938e0efa`: shrinking left a three-page DRI binding after the allocator
kept one page, and growth silently extended it with anonymous pages. The
before log is the file-owner checkout's `.context/device-remap-before.log`.

Shrink now uses the prepared device-unmap plan, flushing/retiring only its
tail before the old bytes can be reused. Equal-sized remap preserves the
binding. Checked rounding and source-range validation reject unaligned,
overflowing or untracked requests. Generic moved mappings retain their
original protection and shared-publication flags. No kernel-host wire
signature, generated snapshot or ABI epoch changed in this increment.

Device growth is a rejected operation, not a missing allocation fallback:
[Linux v6.16 GEM mapping](https://github.com/torvalds/linux/blob/v6.16/drivers/gpu/drm/drm_gem.c#L1054-L1081)
requires a non-expandable VMA, and its
[shmem mapper](https://github.com/torvalds/linux/blob/v6.16/drivers/gpu/drm/drm_gem_shmem_helper.c#L596-L606)
sets `VM_DONTEXPAND`/`VM_PFNMAP`.
[Linux remap validation](https://github.com/torvalds/linux/blob/v6.16/mm/mremap.c#L1227-L1241)
returns `EFAULT` when expanding that mapping. Kandelo follows that behavior
for fixed-size BO mappings, including MAYMOVE and a shrunken view whose BO
still has unused backing. Its framebuffer/GL command mappings also reject
expansion rather than inventing unrelated device bytes. This is ordinary
API failure semantics, not a hard platform boundary closing other gaps.

The unchanged earlier guest cases remain enabled. New normal SDK cases
close the final descriptor, verify equal-size remap and rejected growth,
shrink the BO, reject malformed/untracked remaps, reuse the tail privately,
and fork. They verify shared surviving BO writes, private replacement
bytes and writer/storage retirement in both address widths.

`graphics-device-remap-final-1029-011342-bb5b` passed the workspace Rust
selection (2,618 runtime-core tests, six compile-fail documentation cases,
87 shared cases), normal matching kernel/side-module/host builds, the ABI
check, 35 Node/source cases and 12 three-engine browser guests. A final
source-only metadata regression was then added to ensure moving the sole
shared mapping does not disable shared publication or change protection.
All eight focused remap tests passed. Normal kernel/host and ABI checks
were repeated by `graphics-device-remap-metadata-final-1029-012657-bc86`.

The resulting kernel metadata changed, so the guest evidence was repeated
against that fresh artifact, rather than carrying forward the prior hash.
`graphics-device-remap-final-guests-1029-013601-e44e` passed after 4m26s:
35/35 Node/source cases (77.46s), zero skips or unloaded files; 12/12 real
browser guest cases (2.0m), wasm32/wasm64 in Chromium, Firefox and WebKit.
The final kernel SHA-256 is
`3118c427ac0e108aa8c958b8e548aa6f89d708aba595d55115cff3c05710bd60`.
Logs, traces and identity-bearing guest records are in the file-owner
checkout's `.context/device-remap-*`, `dri-mapping-fork-guests/` and
`gbm-file-aliases-guests/`. The optional Vite gallery rootfs scan warning
remains outside these image-owning focused guests; no gallery pass is
claimed. The additional source regression has focused evidence, not a
claim that the entire workspace ran again with 2,619 runtime-core cases.

Broader product/conformance jobs still run on `5eedcb9aa7` and cannot stand
in for final combined validation of these later changes. Replacement by
another device mapping, broader remap flags/partial-file behavior, full
cleanup/negative coverage and the remaining GLES/EGL/CTS/rendering work
stay open. ABI 56 / kernel-host 3 / GL table 17 / fork record 21 remain
unchanged, above main `cb0a8226c965` (rechecked remotely this checkpoint).


### Fixed device replacement admission and rollback, 2026-10-29

On `4962e6acf5`, two new Rust cases failed: replacing the middle of a
three-page DRI mapping retained the old full-width binding, and rejected
host admission left a hole in the previous allocator metadata. Three new
host cases also failed: replacement corrupted another BO's canonical
bytes, remapping the same BO lost old dirty bytes after zero-fill, and a
throwing admission observer left the new metadata installed. Before logs:
file-owner checkout `.context/fixed-device-before.log` and
`.context/fixed-device-host-before.log` (31 pass, three fail).

The kernel now prepares address-space rollback and device retirement
before admission, reserves fragment/new-view metadata, and retains a
provisional BO reference. Rejected bind restores the old allocator and
returns provisional/split references. Accepted bind publishes clipped
host aliases after flushing old bytes, then commits kernel references
without unbinding the replacement. Canonical offsets and pending readers
survive; final fragment retirement releases the old BO independently.
Framebuffer and GL-command constructors use the same prepared retirement,
installing their new owner afterward. A focused Rust command-buffer case
checks that retiring an old CPU BO does not revoke the new command owner.
This is not full rendered coverage of every framebuffer replacement.

The unchanged earlier guest checks remain enabled. Two additional normal
SDK cases replace an old mapping through a different DRI BO and through a
PRIME descriptor for the same BO. They close source descriptors, retain a
second alias, fork, synchronize disjoint writes, preserve unrelated old
bytes, and retire child/parent mappings in both address widths. Browser
cases exercise actual guest semantics; these checks do not establish
rendered pixel correctness by themselves.

`graphics-fixed-device-final-1029-024507-30a5` passed in 3m58s after final
formatting: workspace Rust including 2,622 runtime-core cases, six
compile-fail documentation cases and 87 shared cases; normal matching
kernel/side-module/host builds; ABI consistency; 38/38 Node/source cases
with zero skips or unloaded files; 12/12 browser guests (57.2s) in
Chromium, Firefox and WebKit across wasm32/wasm64. A prior complete run
also passed before formatting. The final kernel SHA-256 is
`6a947799436bccea9209a4bf53eb6ba71457cd3d0a47d8c76c7f0ec32587958f`.
Logs and identity-bearing records are the file-owner checkout's
`.context/fixed-device-*`, `dri-mapping-fork-guests/` and
`gbm-file-aliases-guests/`. The optional missing-gallery-rootfs scan warning
is outside these focused image-owning guests. ABI 56 / kernel-host 3 /
GL table 17 / fork record 21 stay unchanged; no wire signature or snapshot
changes in this increment. Performance was not measured.

B02 remains partial. Broader remap flags/partial-file behavior, complete
cleanup and negative coverage, and combined validation of the latest
source remain open. The additional graphics source/rendered regression
run is in progress; earlier failures are not cleared by these focused
passes.

### Combined checkpoint results and preserved failures, 2026-10-29

The two longer jobs on `5eedcb9aa7` finished. These results predate the
fixed-replacement/remap/device-admission increments above.

| Check | Result | Evidence |
|---|---|---|
| Normal setup and programs | Passed; all 239 program stamps rebuilt | Primary `.context/combined-vma-{setup,programs,abi}.log` |
| Node consumer selection | 21/21 passed, zero skips/unloaded files | Primary `.context/combined-vma-consumers-node.log` |
| Three-engine consumer/rendering selection | 110/114 passed; four failed | Primary `.context/combined-vma-consumers-browser.log` and corresponding results directory |
| Browser-memory pre-browser gates | 162/162 source, 3/3 Node teardown and 7/7 Bun checks passed | Primary `.context/combined-vma-browser-memory.log` |
| Browser-memory guests | Six passed; three switching cases failed | Same log; immutable copy `.context/combined-vma-failures-2026-10-29/` |
| libc-test | 306 pass, 17 expected fail, one known-flaky pass; zero unexpected | VMA checkout `.context/vma-conformance-libc.log` |
| Open POSIX | 174 pass, three expected fail, two skips; zero unexpected | VMA checkout `.context/vma-conformance-posix.log` |
| Sortix | 5,065 pass, 23 expected fail, 50 skips; zero unexpected | VMA checkout `.context/vma-conformance-sortix.log` |

The combined job `graphics-combined-vma-consumers-memory-1029-002908-d3db`
failed after 4h27m. Three consumer failures are provisioning: the default
setup did not project the optional `graphics-cts-egl` package, so every
engine rejected its missing complete artifact closure before running CTS.
The remaining consumer failure is the retained Firefox inherited
render-node-2D white-marker capture check. Cage/sway session cases passed
in that selection; a complete 114-case pass is not claimed.

All three browser-memory switching cases stopped at the first Freeciv
launch after DOOM and Quake, before cage/sway. The canvas stayed hidden;
the captured terminal reports failure to create the GBM/EGL window and
failure to restore CRTC. This is an unresolved product failure, not
proof of a memory leak or an outside runtime defect. Existing screenshot,
trace and log evidence is copied under the immutable failure directory
above before further runs can overwrite default Playwright outputs.
Assertions and original deadlines remain unchanged.

`graphics-vma-current-conformance-1029-002925-196f` succeeded in 2h23m
with its own normal products, pinned libc-test
`790f94c7b6feb8ade25868c10fba46233f783a0b` and Sortix
`7e8f0082ab0b58ad3383a8abbf47dc4b40dcf25d`. Final conformance for the
newer source remains necessary. Optional CTS provisioning, Freeciv's
window failure, Firefox capture attribution, full current combined
validation and the remaining GLES/EGL/CTS inventory stay open.

### Native visual configuration selection and front byte order, 2026-10-29

The preserved three-engine memory-switch failure stopped at Freeciv's
GBM/EGL window construction. The upstream
[SDL 2.32.10 KMS backend](https://github.com/libsdl-org/SDL/blob/release-2.32.10/src/video/kmsdrm/SDL_kmsdrmvideo.c#L1088-L1133)
requests an ARGB8888 window. Kandelo exposed only an ABGR8888 EGL config
and rejected other GBM window formats. The
[KHR GBM platform contract](https://registry.khronos.org/EGL/extensions/KHR/EGL_KHR_platform_gbm.txt)
requires the window format to match its config's native visual. This is
an ordinary missing platform capability, not an SDL patch or boundary.

Two public ES2 configurations now describe ABGR8888 and ARGB8888 windows.
They share the same RGBA8/depth24/stencil8 backend storage; the public
config ID and native format remain distinct. Enumeration/selection,
context/surface query IDs, legacy/core/EXT window construction and
format-mismatch rejection use that shared configuration model. Native
GPU fronts retain logical RGBA colors. CPU front publication packs the
requested channel order after restoring native readback state, preserving
alpha, row orientation and padding bounds. Kernel and host admission
accept both alpha-bearing formats with checked allocation geometry and
pitch. Opaque native-window configs remain outside this increment.

The new native config case failed before implementation, and the expanded
Rust front-copy case rejected ARGB with EINVAL before admission was
completed. Before logs are the file-owner checkout's
`.context/native-visual-before.log` and
`.context/native-visual-front-before.log`. All 212 native C graphics cases
passed after the config implementation. The unchanged workspace selection
passed with 2,622 runtime-core cases, six compile-fail documentation cases
and 87 shared cases; the complete graphics source gate passed 717/717,
including new independent color/alpha/padding conversion checks.

`graphics-native-visual-full-sdk-guests-1029-090200-b6da` rebuilt both
SDK graphics sets through normal `build-musl.sh --ensure`, matching
kernel/side-module/host and ABI checks. Node passed 8/8, with zero skips
or unloaded files. The expanded browser selection passed 89/90 in 5.1m:
all Chromium/WebKit cases, both-width Firefox CPU fronts, and the earlier
mapping/file-owner/ring guests passed. One Firefox wasm32 ARGB GPU-to-2D
case recorded black selected samples and hit the original 10-second pixel
deadline; no guest diagnostics or page errors were recorded. This failure
is retained and is not attributed to an outside runtime by inference.
The fixed three-repetition comparison of original/ARGB GPU-to-2D guests
passed 11/12 with unchanged assertions/deadlines: all six ARGB cases
passed; one original ABGR wasm64 case captured black selected samples.
Both failures remain recorded. The comparison demonstrates that the
failure is not exclusive to the new native visual; it does not establish
its runtime/tooling cause. Logs/traces are
`.context/native-visual-firefox-control*`.

The matching kernel SHA-256 is
`3b255f7f652d520fae5a24a3f8ff377a79ccb151b352204c9b052ecfc5f7de91`.
Logs and exact program/image identities are the file-owner checkout's
`.context/native-visual-*` and `gbm-native-kms-guests/`. The failing case's
record is `1793279287351-firefox-wasm32-2d-argb-gpu.json`; screenshot and
trace are preserved in `native-visual-browser-results/`. Early SDK runs
caught incomplete local graphics provisioning and a missing new fixture
extension declaration; those were corrected through the ordinary full
SDK build and public headers. Final native C validation again passed all
212 cases, including pbuffer config-ID queries for both configurations.

Freeciv's complete normal package/image rebuild and repeated memory-switch
validation remain necessary. These focused native-window results do not
claim that the Freeciv application or complete memory gate passed.
The recurring Firefox inherited-display capture remains open, as do the
broader GLES/EGL/CTS inventory and complete final combined validation.
Program ABI 56 / kernel-host 3 / GL table 17 / fork record 21 are unchanged.
Performance was not measured.

### Completed focused regressions on the mapping checkpoint, 2026-10-29

On `d081e6d453`, the complete graphics source gate passed 714/714 in 32
files, and the evidence registry agreed with all 628 collected files.
The 66-case rendered selection passed 65/66: all native-window and ring
cases passed, with the same Firefox inherited render-node-2D white-marker
capture failure. Evidence is the file-owner checkout's
`.context/fixed-device-{graphics-source,rendered,evidence-classes}.log`
and rendered-results directory. This failure remains recorded.

Explicit normal provisioning of the optional CTS package then completed.
`graphics-current-cts-compositor-1029-084119-763e` passed all nine actual
browser cases in Chromium, Firefox and WebKit, including cage/sway
sessions and the pinned upstream surfaceless method over the one config
advertised at that checkpoint. Kernel SHA-256 is
`6a947799436bccea9209a4bf53eb6ba71457cd3d0a47d8c76c7f0ec32587958f`;
CTS program SHA-256 is
`c5d10d0661d2e7ca082451e315e08e558676ca6280630e00c5e0aee318d26d1e`.
Primary `.context/current-graphics-*` logs and
`graphics-cts-guest-{chromium,firefox,webkit}.json` identify the artifacts.
This closes the named missing-package run, not broad upstream CTS or
validation of the later two-config implementation.

### Cage/sway landing and completed mapping conformance, 2026-10-29

`graphics-fixed-device-current-conformanc-1029-084119-0165` completed on
`d081e6d453` with zero unexpected failures, unexpected passes, build
failures or timeouts. The normal SourceOnly kernel/rootfs/dash/bash build,
host bootstrap and `verify-fresh` completed before the suites. The kernel
SHA-256 is
`6a947799436bccea9209a4bf53eb6ba71457cd3d0a47d8c76c7f0ec32587958f`.

| Suite | Pass | Expected fail | Known-flaky pass | Skip | Total |
|---|---:|---:|---:|---:|---:|
| libc-test | 306 | 17 | 1 | 0 | 324 |
| Open POSIX | 174 | 3 | 0 | 2 | 179 |
| Sortix | 5,065 | 23 | 0 | 50 | 5,138 |

The ordinary runners were `scripts/run-libc-tests.sh`,
`scripts/run-posix-tests.sh` and `scripts/run-sortix-tests.sh --all
--parallel=4`, under `scripts/dev-shell.sh` with SourceOnly resolution and
the documented `ALLOW_RAISE_RACE=1` setting. libc-test was pinned to
`790f94c7b6feb8ade25868c10fba46233f783a0b`; Sortix was pinned to
`7e8f0082ab0b58ad3383a8abbf47dc4b40dcf25d` on a case-sensitive volume.
Exact commands, output and zero exit statuses are retained in the
mapping checkout's `.context/fixed-device-current-conformance.sh` and
`.context/fixed-device-conformance-{products,host,fresh,libc,posix,sortix}.log`
and `fixed-device-conformance-status.txt`.

This validates the mapping checkpoint, not every later runtime change.
The landing cut adds `21f3d451bb`'s positive ARGB native-window config and
front-format support over that checkpoint. Its 212 native C cases, 717
graphics source checks, workspace Rust, matching normal dual-width SDK/
kernel/host and ABI checks, and 8/8 Node cases are recorded above. The
89/90 browser selection and 11/12 comparison retain their Firefox capture
failures. Those focused results identify the delta; they are not a
final-source combined conformance or memory pass.

The normal complete product rebuild and Freeciv/combined-consumer/memory
job `graphics-native-visual-combined-products-1029-091514-85bc` is still
pending on runtime source `21f3d451bb`. Current full gallery and manual
browser checks also remain pending. The inherited Firefox GPU-to-2D
capture failure remains open with its unchanged assertions, original
deadlines and preserved evidence. No boundary, waiver, performance claim
or full-baseline completion is inferred from this landing split.

### Landing build provisioning and follow-up ownership, 2026-10-29

[PR #1594](https://github.com/Automattic/kandelo/pull/1594) now owns the
remaining graphics baseline, stacked on the bounded cage/sway landing in
#1574. Landing build source `e58d19f98a` retains runtime `21f3d451bb` and
adds corrected Sway native-tool metadata. Python 3.11+ and native Clang
21+ are declared for the upstream status-reader regression helper;
target flags and runtime behavior are unchanged.

`cage-sway-declared-tools-1029-114926-36f1` completed the normal Sway
package rebuild in 12m05s with status zero. This proves package build
acceptance, not a compositor session or final image/memory result.

| Job | Source | Result | Scope |
|---|---|---|---|
| `graphics-native-visual-combined-products-1029-091514-85bc` | `21f3d451bb` | Deliberately stopped, 143 | Stopped before application acceptance during debug-built artifact validation |
| `cage-sway-final-candidate-1029-120243-4ad8` | `e58d19f98a` | Deliberately stopped, 143, after 5m10s | Same investigation; no application acceptance result |
| `cage-sway-final-release-bootstrap-1029-120817-225e` | `e58d19f98a` | Failed, 1, after 1m04s | Missing `sdk/rust/libc-upstream` submodule; provisioning only |
| `cage-sway-final-provisioned-1029-121133-541f` | `e58d19f98a` | Running | Complete normal pipeline after submodule initialization |

The missing submodule was initialized through the normal repository
path at pinned revision `71d5bfcc1bda05da1783666fc2cd7d9669c9c4c8`.
The final pipeline uses the release-built xtask and the normal bootstrap
graph/cache, then explicitly builds CTS and programs and checks ABI,
freshness, artifact closures, evidence classes and native/source tests.
Application acceptance includes actual Freeciv, the combined Node and
three-engine browser selection, six cage/sway gallery cases and the
unmodified full browser-memory gate. Its script and logs are retained in
the fork-owner checkout under `.context/cage-sway-final-*`. No application
acceptance result is available from this run yet; manual browser checks
also remain pending. The earlier interrupted run above remains historical
evidence, not a continuing job or a passing acceptance gate.

Actual port, existing-consumer and memory failures remain landing
blockers. The broader inherited GPU-to-2D capture failure and candidate
presentation-worker isolation mitigation are assigned to #1594. Their
exact failed evidence remains retained, and the broader combined test
continues to execute; a failing result is not reported as a passing suite.
There is no blanket waiver or demonstrated hard platform boundary.

The independent diagnostic on tooling source `15852902cd` provides
bounded new evidence: same-owner continuous GPU readback with bitmap
capture passed 0/3 runs; separating continuous real readback
and visible 2D ownership into two workers passed 3/3 with unchanged
displayed-pixel assertions and at most one owned frame in flight.
The separate-owner private variant SHA-256 is
`fee2994b963341059672d573a5d021a2c6348145deb33be8bbd3b5bc8ef52d1e`.
The default source was restored after that discriminator.

One local startup profile records simultaneous content-main
`DrawSnapshot`/paint/condition waits and worker `readPixels`/event waits
for about 20 seconds; short completed native readback IPC markers are
separate. The specific internal permission/snapshot cycle remains an
inference from pinned Firefox source, because private native frames
could not be symbolicated. No profile was uploaded. Official source
links and the local analysis are retained in primary
`.context/firefox-capture-source-mechanism.md`; the file-owner checkout's
`.context/firefox-landing-profile*` and
`.context/firefox-landing-separated*` retain the actual evidence. This
does not establish a product repair or causation for every Kandelo
capture failure, and does not close any baseline inventory row.

### Sway gallery restart observation, 2026-10-29

The `e58d19f98a` combined gallery run failed Chromium's Sway restart
check: its immediate status-chip read still reported 44 flips and
`webgl2-gl`, after two screenshots differed. The same failure's page
snapshot already reported 56 flips and `webgl2`, the CPU scanout
presenter. The trace records the restart command at 70.848–71.124 s,
screenshots at 72.318–72.427 s and 73.983–74.060 s, and the stale
one-shot chip read at 74.064–74.067 s. Changing pixels alone did not
prove that startup had completed or that the dock's 250 ms statistics
drain had observed the replacement renderer.

The gallery gate now checks the old DRM master's release, a different
positive master for the replacement session, and the positive `webgl2`
scanout presenter before checking foot and the moving clock. The
420-second test deadline and existing assertion deadlines are unchanged.
This changes browser test synchronization only: host/kernel lifecycle,
Node behavior, ABI, package artifacts and presentation are unchanged.
Playwright collection passes for all three engines; executing the
strengthened gate is still pending. The original failure remains
retained under `.context/cage-sway-final-gallery-results/` in the
fork-owner checkout and is not reported as a passing run.

### Main integration and program-ABI extraction, 2026-10-29

The landing integrates main `35164686062cad97a660452e3d445373e4cfc519`
into candidate `9088f31021`, preserving all nine newer main commits and
their contributor attribution. Main's dependency-free program-ABI crate
owns the single unpublished `ABI_VERSION = 56`; shared re-exports that
declaration, while kernel-host version 3, GL operation table 17 and
runtime-core fork record version 21 remain unchanged. The moved program
declarations match main exactly apart from the graphics epoch's version
and history comment. The browser support documentation retains both the
graphics texture-respecification boundary and main's new thread-worker
retirement and nested-worker findings.

Normal `check-abi-version.sh update` and check both pass after compiling
the integrated kernel and xtask. Regenerated ABI snapshot, TypeScript and
C outputs, host import allowance and standalone resolver bundle match
the prior landing byte for byte; the resolver bundle regression passes.
The snapshot SHA-256 is
`df64f6c6a2ca1ea26a89b9720a5a14aec5354850f729445ff3ec488dd1c7cc12`.
Program-ABI/shared crate test targets pass (87 shared cases; the new
program-ABI crate has no unit cases). Focused xtask extraction and ABI
source-gate checks pass (9 + 5 + 1 cases), including the actual fork
package key's independence from kernel-host source edits.

Focused host source checks pass all 357 cases in six files: scratch
contract/transfer boundaries, large transfers, readiness wakeups, runtime
memory profiles and the memory-write audit. The initial combined run
passed 356 cases and failed the static audit solely for 44 stale
allowances for offline fork fixtures and the artifact verifier. Main now
classifies those exact paths as test harnesses, so their old per-site
allowances were removed; production ownership coverage and graphics
allowances remain. The subsequent complete six-file run passes with zero
skips. These source-only checks use the normal host Vitest configuration
with global fixture compilation disabled, as the repository's source
gates do. An earlier direct Vitest invocation was stopped during global
fixture provisioning before any test result, and is not counted as a
passing run.

These are source and ABI checks. Main also changes live host behavior
(terminal-input wakeups and WebKit thread-worker lifetime), package build
input closures and default Node program demand. The older candidate's
product, browser-memory, compositor and conformance evidence does not
validate this combined source. Normal products and acceptance must be
rebuilt and rerun before the landing is declared ready.

### Reviewed landing acceptance and retained failures (2026-10-29)

The clean `9088f31021` run
`cage-sway-reviewed-landing-1029-143356-baef` completed with exit 1 after
1h17m. Normal bootstrap, optional landing CTS build, ABI, freshness and
artifact-closure checks passed. Freeciv's SDL main menu passed 1/1.
Node passed 23/25 across 11 files; the Sway bar and configuration-error
cases hit whole-test timeouts. Browser acceptance passed 13/15: all
three Cage cases, six rendered compositor sessions and three pinned EGL
CTS cases passed, as did WebKit Sway. Chromium and Firefox Sway failed
an unreliable historical shell-prompt count after display release.
Their trace text shows the prompt split by late child stderr. No broad
Firefox capture failure is waived by this diagnosis.

The complete browser-memory gate passed, including 9/9 browser cases
and all four persistent-page game/compositor/tmux/WordPress switching
cycles per engine. Chromium, Firefox and WebKit switching cases took
7.2, 5.6 and 4.5 minutes respectively; browser cases totaled 17.4 minutes.
This is the full unchanged constrained-budget gate, not isolated fresh
pages. Exact logs/results are `.context/cage-sway-reviewed-*` in the
fork-alias checkout.

The private `.context/cage-sway-reviewed-artifacts.json` records all 98
projected owners and 237 members at source `9088f31021`, with kernel
SHA-256 `3b255f7f652d520fae5a24a3f8ff377a79ccb151b352204c9b052ecfc5f7de91`.
The fresh standalone fixture input/byte bridge passed both before and
after acceptance with zero differences, using the complete SDK,
compiler/toolchain, generated protocols and relevant source inputs.
The collector did not compile, copy or stamp fixtures. Normal-policy
resolution was separately captured at the test-only diagnostic head in
`.context/gbm-fork-aliases/.context/cage-sway-default-identities.json`:
kernel, compositor programs, helpers and dash match the recorded product
bytes; all three standalone fixture hashes match the bridge record.

The Node timeout cause remains open. Fresh-artifact diagnostic
`sway-node-fresh-diagnostic-1029-155733-42b2` on source `5a0f83afb7`
passed all three Sway cases in 14.371, 14.951 and 14.869 seconds, with
unchanged assertions/deadlines and persisted phase/cleanup checkpoints.
That pass is narrower evidence, not a repair or deletion of the failed
combined result. The separate CPU-checkout diagnostic failed because
its client had a stale ABI digest; it is a provisioning failure, not
an explanation of the verified candidate's timeouts.

The browser exit fixture now requires actual display-owner release,
automatic terminal handoff and the resumed parent shell's real
`sway-exit=0` output, preserving all other idle/input/clock/restart
checks. Execution of that repair and combined-main products, consumer,
memory and conformance gates remain pending. Prior-candidate acceptance
is not transferred to the new main integration.


### Narrow native renderbuffer replay contract (2026-10-29)

The first resumed combined canonical host build (`97e0aaf98a`) fails
TypeScript declaration generation because renderbuffer replay's helper
requires a complete `GlBinding`, while the muxer intentionally owns only
state. The helper now reads an optional read-only renderbuffer-view map;
it neither needs nor retains command-buffer or guest-memory authority.
A direct renderbuffer remains unchanged when no alias map exists, and a
mapped object resolves its retained native renderbuffer.

The new regression fails before the repair with a missing-map exception;
afterward all 24 muxer cases pass, including direct and aliased owners.
The canonical `scripts/build-host.sh` completes JavaScript and declaration
generation in the declared shell on landing `85c56d342d` plus this repair.
Logs in the VMA checkout are `.context/muxer-narrow-owner-before.log`,
`.context/muxer-narrow-owner-after.log` and
`.context/muxer-narrow-owner-host.log`. This closes the demonstrated helper
contract/build failure at that source, not combined application acceptance.
The combined follow-up build and source/ownership/runtime gates still need
rerunning after integration. No ABI or capability changes are included.


### Combined graphics gate and publication catch audit (2026-10-29)

Combined follow-up `01bae5c346` passes all 794 graphics source cases in
34 files with zero skips; the corrected evidence registry agrees with all
634 collected files. Together with the canonical host build, 227 native
C cases and GBM checks at `d24b94f7de`, this validates the named source
increments, not normal guest or real-rendered behavior.

The three-file ownership audit passes 117/120. One real audit failure
identifies the DRI inherited-mapping publication catch, which did not
check the branded fatal kernel-export signal before ordinary host
rollback. The worker and audit sources are byte-identical between this
combined source and landing `6fd1ab90c8`; this repair belongs in the
landing. The catch now rethrows a branded failure first, preserving
whole-generation containment before rollback writes. Ordinary host
publication failures retain their existing rollback. No audit allowance
is added or broadened.

The other two failures are five-second deadlines in synthetic AST audit
fixtures, not failed assertions. Their observed durations are 5.8s and
9.4s in the preserved run with three audit workers. Rerunning the same
assertions and unchanged deadlines with one worker is pending; the failed
run remains `.context/graphics-resumed-model-audit.log` in the file-owner
checkout. No external runtime defect or timeout waiver is claimed.


The single-worker repeat at landing `6fd1ab90c8` plus the publication guard
passes 169/170 across five files: entry gate 44/44, shared-mapping
inheritance 6/6, export-failure audit 9/9 and entry-context audit 25/25.
The memory audit passes 85/86: the two originally timed-out fixtures pass,
but its separate synthetic capacity-dispatcher fixture hits the unchanged
five-second deadline at 7.6s. No assertion fails and no deadline or
allowance is changed. The failed repeat is retained as
`.context/graphics-landing-fatal-audit-after.log` in the file-owner checkout;
a full passing audit remains pending under reduced build load. Reported
machine load is 155 at start and 106.9 at end on 18 CPUs; these observations
do not establish a product performance or external runtime claim.

Security maintenance unmounted the existing case-sensitive fixture image.
It is reattached without opening Finder. The selected Sortix checkout
`/Volumes/KandeloCaseBuild/moscow-vma-fragments-os-test` is pristine at
`7e8f0082ab0b58ad3383a8abbf47dc4b40dcf25d`; current-worktree SDK, kernel
and overrides remain required for the later normal conformance run.

### Labwc port and normal desktop consumer in progress (2026-10-30)

Labwc 0.20.2 is being added as a separate native Wayland stacking desktop,
using the same wlroots 0.20.2 as cage/sway. Its pinned source archive is
`fae023b6fe022f7057556707a17cdb2d98e0138c5dffaedaa1dade975699f9e8`.
The normal recipe builds labwc and labnag with PNG/SVG support and actual
fork instrumentation. Optional Xwayland, window-icon lookup through libsfdo,
systemd integration and translations are disabled explicitly. No target
identity override, source patch or runtime stub is introduced.

The normal shell composition declares the package dependency and lazy
executables/configuration; its gallery profile starts `labwc -s foot` using
the existing shared fonts, XKB and libinput data. The existing cage/sway
landing is unchanged. Program ABI 56 / host 3 / GL 17 / fork 21 remain fixed.

Source-only gallery/lazy-address validation passes 25/25 cases, no skips;
the evidence registry agrees on 632 files. The curated gallery assertion
also retains the already-present Redis entry, which its prior expected list
omitted. Playwright lists the new rendered case in all three engines.
Node and browser tests cover floating-window input, menus, focus, clean
exit and display reuse. Labwc is also added to all four existing memory
switching cycles with actual rendered terminal-command output, without
changing the budgets, timeouts, realm or failure assertions.

Normal package installation is still running at this source checkpoint;
no successful package publication, desktop session, memory result or
performance claim is made yet. Final artifacts and real Node/three-engine
browser validation remain required. Source logs are the positive checkout's
`.context/labwc-source-check.log`, `.context/labwc-evidence-registry.log`,
`.context/labwc-browser-inventory.log` and `.context/labwc-resolve.log`.

### Sway density policy and readable defaults (2026-10-30)

Sway's generic automatic scale policy now rounds measured native connector
DPI/96 instead of requiring both DPI axes strictly above 192 and a
1200-pixel output height. Unknown, invalid and aspect-only physical sizes
still select scale 1. No mode, synthetic physical dimension, evdev range,
SDL behavior, renderer or browser-specific DPI environment is changed.
Sway's production UI font is 12pt; its separate terminal config selects
14pt with `dpi-aware=no`, through both terminal bindings and startup. The
shared 12pt terminal config remains unchanged. The actual desktop archive
assembly places `sway/foot.ini` at the shell archive mount's declared
`/usr/share/kandelo/sway/foot.ini` path.

Focused source evidence uses the manifest-verified Sway 1.12 archive and
compiles its actual output-scale functions in the declared shell. The
unpatched source fails the native density controls; the patched source
passes the full focused matrix, including small 2x outputs, millimetre
rounding, pending modes, rotation and unknown/aspect-only fallback. The
actual recipe's archive phase separately verifies UI12/foot14 membership
and preserved shared foot12. Browser TypeScript transpilation checks syntax
only. Logs: `.context/sway-hidpi-before.log`, `sway-hidpi-after.log`, and
`sway-hidpi-final.log` in the file-alias checkout.

Normal Sway/wayland-demo/shell artifacts, browser 1x/2x rendering/input/IPC,
full browser-memory and conformance are not run by this focused batch.
The existing browser spec replaces its fixed 16-pixel bar crop with the
actual painted bar boundary and adds explicit 1x/2x small-pane cases.
Normal artifact and combined runtime validation remain integration gates.
Program 56 / host 3 / GL 17 / fork 21 remain fixed.

### Desktop validation checkpoint (2026-10-30)

The normal labwc shell/image and host build at `03ecd82c2e` completed:
`labwc-products-1030-001314-959b` passed all 162 build nodes; the canonical
rootfs build `labwc-canonical-rootfs-1030-003056-c4f5` also passed. The first
actual headless Chromium desktop case, `labwc-rendered-chromium-1030-003540-ecc7`,
failed its initial white-pixel threshold. Its retained screenshot shows a
real decorated foot window and short shell prompt. That is evidence of
initial paint, not completed menu, input, focus or teardown validation.
The test now requires executed ANSI-coloured terminal output, and sends
physical Shift transitions through the shared input helper. The same
physical typing repair applies to raw evdev commands in the repeated
memory switch case; its existing memory budgets and cycle counts remain.
These revised desktop and memory cases still require execution.

A separate headless normal Sway session at `0b0b69b196` reproduced the
reported ScummVM graphics-mode failure. Actual captured guest stderr
contains `Could not load any graphics mode`; ScummVM nevertheless exits
zero, so exit status alone cannot establish a repaired launch. Evidence:
`.context/gbm-fork-aliases/.context/scummvm-sway-reproduction.txt` and
`.png`. The shared EGL native display/window lifetime repair is being
validated separately; no ScummVM-specific bypass is used.
