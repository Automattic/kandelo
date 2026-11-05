# Exact Node-vendored c-ares backend

This recipe selects c-ares 1.34.9 from the immutable Node 26.13.0 archive.
All selected component files are hashed in sources.json. The recipe keeps
the Node target/source pin coherent and supports wasm32/wasm64 source
plans. Neither target package has been compiled or validated yet.

The normal resolver stages source under its private work directory.
Compilation/configuration writes only to a separate work subdirectory;
installation stays under WASM_POSIX_DEP_OUT_DIR. CMake receives truthful
Kandelo/wasm identity and the repository SDK. Feature checks link real
executables instead of accepting unresolved names in static archives;
no cross-compiled probe is executed and no Linux identity is defined.
Threads, sockets, poll, time, entropy and resolver configuration consume
their actual libc/kernel interfaces. Configure success would not prove
that every detected symbol is semantically complete.

The standalone native control compiles this pinned c-ares component for
the native host, then exercises dns-resolver.h against a loopback DNS
fixture and compares its A/TTL output with pinned native Node. That is
not a wasm package build, guest transport validation or public Resolver
conformance. The package is not linked into the engine until the real
record request/realm/loop/async/lifecycle bridge is supplied. No version
or record capability is advertised by process.versions on this basis.
