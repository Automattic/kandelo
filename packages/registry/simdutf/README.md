# Unicode and base64 primitives

Builds the complete simdutf 7.7.0 amalgamation under
`deps/v8/third_party/simdutf` in the pinned Node 26.13.0 archive. It uses the
normal resolver, Kandelo compiler and private libcxx SDK sysroot. Platform
selection comes from the true target; no Linux identity macro is added.
The original source/header and MIT license remain unchanged.

Consumers use a C++ compiler and `pkg-config --cflags --libs simdutf`. The
pkg-config file is relocatable. This bundled distribution has a Chromium GN
source set and no CMake install tree or upstream man pages. Its standalone
CLI and test suite are not included. A successful build does not establish
codec, Node StringBytes or public encoding conformance. Focused consumer
evidence belongs in the upstream Node runtime ledger. No product image or
local-supported set membership is added here.

The identified consumer passes seventeen selected nbytes/simdutf controls on
Node, Chromium, Firefox and WebKit. It links from relocated package copies to
check the installed metadata. See [the focused evidence](../../../tests/nodejs/upstream/native-codec-engine-check.json).
