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

Enabled upstream tests: **none yet**. No upstream CTS pass is claimed.
Do not label translated or inspired regressions as unmodified CTS tests.
Track enabled cases and exact source hashes here as they are integrated.

See [the versioned compatibility inventory](../../docs/graphics/compatibility-v1.md)
for required coverage and separate expansions.
