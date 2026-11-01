# Upstream EGL and GLES2 CTS

This package builds the complete `deqp-egl` and `deqp-gles2` executables from
VK-GL-CTS revision `a119e62de3bb38dae67f05abee8acd011e0c729c`, the same pin
recorded by the older `graphics-cts-egl` extracted-method fixture. It retains
the real upstream framework, main, package registration, filters, logging,
comparisons, reference renderer, and every EGL/GLES2 test source. The older
fixture remains separate and is not evidence of full harness execution.

`upstream.json` binds the complete archive and original module/registration
files. `prepare-source.py` verifies them and copies upstream's module/data
macros verbatim. The package-owned root CMake composes the original framework
and both original module CMake graphs. It does not configure unrelated Vulkan,
OpenGL, GLES3 or GLES31 suites or fetch their compiler dependencies. JsonCpp,
PNG and zlib are declared normal resolver dependencies rather than downloads
performed by upstream's all-API `fetch_sources.py`. Tests are not translated,
renamed, removed, filtered at build time or given replacement expectations.
Assertions remain enabled (`RelWithAsserts`, `DE_DEBUG=1`).

The portability patch adds distinct WebAssembly32/64 CPU identities and extends
the existing CPU/pointer-width check to them. It preserves mismatched-width
rejection and all test assertions; it does not identify Kandelo as x86 or Linux.
No executable test body or test registration is patched.

A separate reference-oracle patch recognizes absent `FE_*` modes as unavailable
and checks directed rounding before calculating either interval bound. It
throws the upstream `InternalError` result rather than computing a nearest-only
bound, skipping a test, or reporting a capability exemption. Saved rounding is
restored on capability failure and bound exceptions; a failed restoration
terminates rather than allowing subsequent reference calculations in an unknown
mode. Supported native rounding modes keep their original implementation.
Kandelo currently exposes nearest-only Wasm rounding, so dependent cases will
fail with a reference-oracle error. Exact software directed reference arithmetic
is an ordinary completeness/validation gap; this does not establish a GLES
platform boundary or a validated oracle.

The native port uses the ordinary SDK's EGL/GLES2/GBM and a real
`/dev/dri/renderD128` description. It registers a GBM display and render-window
factory with the upstream EGL platform, which also supplies upstream's GLES2
context factory. Config-specific windows use the actual `EGL_NATIVE_VISUAL_ID`.
The library loader uses the unchanged upstream EGL1.4 static symbol table and
actual `eglGetProcAddress` for later core/extension symbols. A missing symbol
remains missing; no fake entry point or success result is supplied. This avoids
hard-linking absent EGL1.5 functions before the full harness can run, while
preserving all affected tests and their failures. There is no direct host
WebGL, alternate renderer, dummy native handle, or
reported screen presentation. The port advertises native creation and queried
dimensions only. Native pixmaps, KMS screen readback/visibility and native
window resizing are not implemented; tests remain in the upstream inventory
and the framework must report those missing platform capabilities honestly.
An unsupported outcome is not a pass for a required advertised platform API.

Normal outputs are `deqp-egl.wasm`, `deqp-gles2.wasm`, and `deqp-data.zip`.
The ZIP contains the original GLES2 data/shader tree rooted at `gles2/`.
Consumers must unpack/mount it through the normal VFS and pass its root as
`--deqp-archive-dir`, not serve it through a special graphics implementation.
Both executables use normal SDK linking, ABI stamping and fork instrumentation.

After normal package provisioning, inventory the real registered tests with
each executable's unchanged `--deqp-runmode=stdout-caselist` mode. Execution
uses upstream `--deqp-case=...`, log/result output and exit semantics. Preserve
the complete inventory and raw QPA log; do not turn missing EGL/GLES2 functions,
incorrect rendering or unsupported required native operations into skips or
successful fixture output. GLES1/VG/Vulkan are not supplied by this package.

Build through this checkout's normal SDK/resolver, using the package selector
`graphics-cts` in `packages/sets/local-supported.toml`. Its test-support role
does not add it to every browser image. A normal package build is not a CTS
runtime pass, and listing test cases does not establish rendering conformance.
Node and browser must consume the same admitted artifacts and full logs in
subsequent validation; no broad baseline or conformance acceptance is claimed.

The intermediate port is under review. Normal SourceOnly build R7 completed
successfully (3m43s): both complete executables compiled, linked, received normal
fork instrumentation, and published with the data archive. Five resolver
dependencies were cache hits. This is build evidence, not rendering acceptance.
The subsequent recipe-only positive-job validation change has separate helper
controls; the R7 artifact/source identity remains the pre-housekeeping cohort.

Actual dedicated-worker Node enumeration of the R7 artifact listed 4,117 unique
EGL cases and 308 groups, exited0, and completed worker destruction without host
diagnostics. GLES2 default enumeration failed initialization because its normal
windowed visibility requests the unimplemented visible native factory. A
separate unfiltered run using upstream `--deqp-visibility=hidden` reached real
`eglCreatePlatformWindowSurface` and failed with `EGL_BAD_ALLOC`, before any
GLES2 cases were enumerated. Both failures and the exact arguments are retained;
neither zero-case run is an inventory or conformance pass. No fake renderer or
alternative surface replaced the missing operation. Native renderer-backed
GLES2 inventory and full actual EGL/GLES2 execution remain open. wasm64 is not
claimed by this wasm32 package.
