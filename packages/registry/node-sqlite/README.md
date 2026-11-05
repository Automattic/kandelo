# Exact Node SQLite backend

This library recipe selects SQLite 3.54.0 from the immutable Node 26.13.0
source archive used by node-compat. Its recipe version identifies that
Node source release. The independent sqlite package remains unchanged.

sources.json binds the amalgamation, public headers, Node sqlite.gyp and
Node license by SHA-256. Build definitions and visibility flags follow
that exact gyp input. Both wasm32 and wasm64 builds use the repository SDK,
verify source/target coherence, build under disjoint resolver-owned roots,
and install only declared archives, headers, licenses and provenance.
The installed provenance records compiled=true only after compilation.

SpiderMonkey declares this dependency and checks its source pin before
linking the real archive. SQL execution and connection/statement lifetimes
are owned by third_party/node-core/sqlite-store.h. The shared frontend
and native engine bridge are separate layers.

Current evidence comprises source checks for both architectures and a
native-host fixture compiled against this exact SQLite source. No Wasm
package build, engine build, guest filesystem exercise or four-host
conformance has been performed for this candidate. Native success does
not establish the guest VFS/locking/permissions or engine binding.
