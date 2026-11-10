# Upstream graphics coverage map, version 1

This map guides the complete implementation pass. It links actual upstream
case families to the baseline IDs in [the compatibility ledger](compatibility-v1.md).
Inventory membership is not execution, passing conformance or an applicability
decision. No new suite is executed to produce this map. Implementation coverage
and validation results remain separate in the ledger.

The source pin is `a119e62de3bb38dae67f05abee8acd011e0c729c` from
[Khronos VK-GL-CTS](https://github.com/KhronosGroup/VK-GL-CTS/tree/a119e62de3bb38dae67f05abee8acd011e0c729c).
The normal `graphics-cts` package builds original `deqp-egl`, `deqp-gles2`
and their data archive. The earlier `graphics-cts-egl` package is a separate
adapted subset preserving selected upstream assertions; it must not be confused
with the complete upstream executables.

An API family is not complete merely because a C symbol exists or a focused
failure-injection test passes. Review the relevant specification, all mapped
upstream subfamilies and the shared platform contracts, implement the combined
model, then run the broad acceptance phase. Performance, stress and extension
families remain visible here so they are not silently lost. Per-case API version,
configuration, advertised extension and upstream prerequisites determine which
assertions apply. No whole-family skip or NotSupported-to-Pass conversion is
authorized by this map.

## Inventory identities

| Suite | Unique case paths | Unique groups | SHA256 of recorded case list |
| --- | --- | --- | --- |
| GLES2 | 19,825 | 941 | `d39ae3e3c1ab3595f747edc071d227ae2797498d99fbf77a25576314a46f876a` |
| EGL | 4,117 | 308 | `6cfc775002e37be1670aaa6486434099eaea9ef9b3ea68140e807778f83d8fc8` |

Group counts exclude the suite root and count distinct non-case prefixes.

The GLES2 inventory was observed through the normal browser renderer in
`graphics-cts-renderer-caselist-r3-1031-215558-fa20`; the EGL inventory was
reconfirmed through the real Node guest retirement consumer. Their original
case lists are retained in the evidence locations recorded by the ledger.
Enumerating cases does not execute their assertions.

## Implementation dependencies across families

| Shared model | Baseline IDs | Required review before combined validation |
| --- | --- | --- |
| Object and execution lifetime | G01, G02, G04, E02, E05, E06 | Shared names, current/deleted executables, retained native objects and exact cleanup ownership |
| Ordered commands, queries and waits | G02, G09, E02, E08 | Prefix completion, immutable input/result capture, server barriers, cancellation, actual retirement and Forget ACKs |
| Storage and transfer | G03, G05, G06, G08, B01, B02 | Large transactions, packing/format conversion, immutable reflection and original mapping identities/ranges |
| Display and presentation | E01, E03, E04, B03, K01–K05 | Surface/config identity, resizing, buffer rings, master/cursor/framebuffer ownership and legacy KMS |
| Capability and failure behavior | G09, G10, E01–E08 | Complete symbol dispatch, core requirements, advertised extensions and truthful invalid-call behavior |

## GLES2 families

| Upstream case or family | Cases | Baseline areas |
| --- | --- | --- |
| `dEQP-GLES2.accuracy.interpolation.*` | 32 | G07 |
| `dEQP-GLES2.accuracy.texture.*` | 164 | G06 |
| `dEQP-GLES2.capability.extensions.*` | 78 | G10 |
| `dEQP-GLES2.capability.limits.*` | 10 | G02–G08 |
| `dEQP-GLES2.functional.attribute_location.*` | 57 | G04 |
| `dEQP-GLES2.functional.buffer.*` | 49 | G03 |
| `dEQP-GLES2.functional.clip_control.*` | 8 | G07 |
| `dEQP-GLES2.functional.clipping.*` | 602 | G07 |
| `dEQP-GLES2.functional.color_clear.*` | 19 | G07 |
| `dEQP-GLES2.functional.debug_marker.*` | 3 | G07 |
| `dEQP-GLES2.functional.default_vertex_attrib.*` | 40 | G02, G03 |
| `dEQP-GLES2.functional.depth_range.*` | 28 | G07 |
| `dEQP-GLES2.functional.depth_stencil_clear.*` | 11 | G07 |
| `dEQP-GLES2.functional.dither.*` | 20 | G07 |
| `dEQP-GLES2.functional.draw.*` | 101 | G03, G07 |
| `dEQP-GLES2.functional.fbo.*` | 711 | G08 |
| `dEQP-GLES2.functional.flush_finish.*` | 5 | G02, G09 |
| `dEQP-GLES2.functional.fragment_ops.*` | 1,923 | G07 |
| `dEQP-GLES2.functional.implementation_limits.*` | 16 | G02–G08 |
| `dEQP-GLES2.functional.lifetime.*` | 33 | G01, G04 |
| `dEQP-GLES2.functional.light_amount.*` | 19 | G07 |
| `dEQP-GLES2.functional.multisample.*` | 16 | G07 |
| `dEQP-GLES2.functional.multisampled_render_to_texture.*` | 1 | G07 |
| `dEQP-GLES2.functional.negative_api.*` | 246 | G01–G09 |
| `dEQP-GLES2.functional.polygon_offset.*` | 14 | G07 |
| `dEQP-GLES2.functional.prerequisite.*` | 3 | G07 |
| `dEQP-GLES2.functional.rasterization.*` | 52 | G07 |
| `dEQP-GLES2.functional.read_pixels.*` | 8 | G07 |
| `dEQP-GLES2.functional.shader_api.*` | 38 | G04 |
| `dEQP-GLES2.functional.shaders.*` | 10,252 | G04, G05, G07 |
| `dEQP-GLES2.functional.state_query.*` | 396 | G02, G09 |
| `dEQP-GLES2.functional.texture.*` | 976 | G06 |
| `dEQP-GLES2.functional.uniform_api.*` | 1,267 | G05 |
| `dEQP-GLES2.functional.vertex_arrays.*` | 571 | G03 |
| `dEQP-GLES2.info.extensions` | 1 | G10 |
| `dEQP-GLES2.info.render_target` | 1 | G10 |
| `dEQP-GLES2.info.renderer` | 1 | G10 |
| `dEQP-GLES2.info.shading_language_version` | 1 | G10 |
| `dEQP-GLES2.info.vendor` | 1 | G10 |
| `dEQP-GLES2.info.version` | 1 | G10 |
| `dEQP-GLES2.performance.api.*` | 346 | G01–G10 |
| `dEQP-GLES2.performance.blend.*` | 13 | G07 |
| `dEQP-GLES2.performance.compiler.*` | 368 | G04 |
| `dEQP-GLES2.performance.shader.*` | 856 | G04, G05, G07 |
| `dEQP-GLES2.performance.texture.*` | 200 | G06 |
| `dEQP-GLES2.stress.draw.*` | 22 | G03, G07 |
| `dEQP-GLES2.stress.long.*` | 28 | G07 |
| `dEQP-GLES2.stress.memory.*` | 80 | G01, G03, G06, G08 |
| `dEQP-GLES2.stress.special_float.*` | 21 | G07 |
| `dEQP-GLES2.stress.vertex_arrays.*` | 116 | G03 |

## EGL families

| Upstream case or family | Cases | Baseline areas |
| --- | --- | --- |
| `dEQP-EGL.functional.buffer_age.*` | 168 | E03 |
| `dEQP-EGL.functional.choose_config.*` | 67 | E01 |
| `dEQP-EGL.functional.client_extensions.*` | 3 | E01 |
| `dEQP-EGL.functional.color_clears.*` | 384 | E02, E03, G07 |
| `dEQP-EGL.functional.create_context.*` | 22 | E02 |
| `dEQP-EGL.functional.create_context_ext.*` | 400 | E02 |
| `dEQP-EGL.functional.create_surface.*` | 147 | E03 |
| `dEQP-EGL.functional.fence_sync.*` | 28 | E08 |
| `dEQP-EGL.functional.get_frame_timestamps.*` | 21 | E03 |
| `dEQP-EGL.functional.get_proc_address.*` | 209 | G10, E08 |
| `dEQP-EGL.functional.hdr_metadata.*` | 2 | E03 |
| `dEQP-EGL.functional.image.*` | 226 | E05–E07 |
| `dEQP-EGL.functional.multicontext.*` | 6 | E02 |
| `dEQP-EGL.functional.multithread.*` | 24 | E02, E08 |
| `dEQP-EGL.functional.mutable_render_buffer.*` | 3 | E03 |
| `dEQP-EGL.functional.native_color_mapping.*` | 126 | E01, E03 |
| `dEQP-EGL.functional.native_coord_mapping.*` | 126 | E03 |
| `dEQP-EGL.functional.negative_api.*` | 26 | E01–E08 |
| `dEQP-EGL.functional.negative_partial_update.*` | 7 | E03 |
| `dEQP-EGL.functional.partial_update.*` | 29 | E03 |
| `dEQP-EGL.functional.preserve_swap.*` | 30 | E03 |
| `dEQP-EGL.functional.query_config.*` | 32 | E01 |
| `dEQP-EGL.functional.query_context.*` | 65 | E02 |
| `dEQP-EGL.functional.query_surface.*` | 126 | E03 |
| `dEQP-EGL.functional.render.*` | 128 | E02, E03, G07 |
| `dEQP-EGL.functional.resize.*` | 12 | E03 |
| `dEQP-EGL.functional.reusable_sync.*` | 23 | E08 |
| `dEQP-EGL.functional.robustness.*` | 58 | E02, E08 |
| `dEQP-EGL.functional.sharing.*` | 1,272 | E02, E05, E06 |
| `dEQP-EGL.functional.surfaceless_context.*` | 21 | E04 |
| `dEQP-EGL.functional.swap_buffers.*` | 21 | E03 |
| `dEQP-EGL.functional.swap_buffers_with_damage.*` | 54 | E03 |
| `dEQP-EGL.functional.thread_cleanup.*` | 4 | E02, E08 |
| `dEQP-EGL.functional.wide_color.*` | 50 | E01, E03 |
| `dEQP-EGL.info.client_apis` | 1 | E01 |
| `dEQP-EGL.info.configs` | 1 | E01 |
| `dEQP-EGL.info.extensions` | 1 | E01 |
| `dEQP-EGL.info.vendor` | 1 | E01 |
| `dEQP-EGL.info.version` | 1 | E01 |
| `dEQP-EGL.performance.gles2_shared_render.*` | 80 | E02, E05, E06 |
| `dEQP-EGL.performance.make_current.*` | 102 | E02 |
| `dEQP-EGL.stress.memory.*` | 10 | E02, E03, E05 |

## GBM, DRM/KMS and platform lifecycle

Khronos CTS is the upstream acceptance source for EGL/GLES; it does not replace
GBM mapping/ownership and legacy DRM/KMS validation. The current platform tests
include actual C/UBSan GBM/EGL consumers, Rust device/marshalling tests, shared
host storage and lifecycle controls, and normal compositor consumers. These
are identified separately from unmodified upstream conformance tests.

[IGT GPU Tools](https://drm.pages.freedesktop.org/igt-gpu-tools/index.html)
provides upstream DRM/KMS tests. It is not currently integrated into Kandelo.
A relevant test needs a normal Kandelo build/adapter and an explicit check of
its Linux/driver assumptions; device-specific functionality outside the chosen
baseline is not silently added to or removed from the baseline by this list.
GBM/DRM coverage and any missing upstream adapter remain visible obligations.

The runtime also retains musl libc-test, Open POSIX Test Suite and Sortix os-test
runners for the underlying process/fd/memory/thread contracts, on Node and
browser. Upstream graphics assertions and platform failure-injection controls
cover different requirements; neither substitutes for the other.

## Execution phase

The user requested one complete combined implementation pass before broad
rebuilds and suite execution. Only quick compile checks and focused causal
controls run during that pass. The later phase builds fresh normal artifacts,
executes upstream assertions with original result accounting, and repairs
failures in the combined platform context. Historical selected-group successes
do not make the newer implementation or the remaining inventory validated.
