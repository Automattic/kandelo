# Node byte primitives

Builds the complete nbytes 0.1.4 sources from the pinned Node 26.13.0 archive
through upstream CMake, the normal resolver and a private libcxx SDK sysroot.
No source patch or Linux identity macro is used. The installed static archive,
original header, relocatable pkg-config file and MIT license are declared outputs.
Consumers use a C++ compiler and `pkg-config --cflags --libs nbytes`.

The bundled source and its install rules provide no man pages. Upstream tests
are disabled for cross compilation; package presence does not establish byte
primitive conformance or a Node Buffer binding. Focused consumer evidence belongs
in the upstream Node runtime ledger. No product image or local-supported set
membership is added by this package.

The identified consumer passes seventeen selected nbytes/simdutf controls on
Node, Chromium, Firefox and WebKit. It links from relocated package copies to
check the installed metadata. See [the focused evidence](../../../tests/nodejs/upstream/native-codec-engine-check.json).
