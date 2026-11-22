# Standalone tracing foundation

This package selects the complete tracing controller, config, object, buffer and
JSON-writer translation units bundled in the audited Node.js 26.13.0 archive. Its
14.6.202.34 version comes from that archive's complete V8 version header. It also
compiles the complete original fatal-logging and abort-mode units. This is a
standalone tracing library, not a V8 JavaScript engine or its JIT.

The target-header patch recognizes Kandelo and wasm32 explicitly, before ambient
OS macros. No Linux identity is supplied. A private platform adapter connects
monotonic/thread-CPU clocks, process/thread IDs, stderr and termination to guest
libc/kernel operations. The mutex adapter delegates to the complete original Node
`node_mutex.h` over the resolved guest libuv rather than adding Abseil. Category
matching, state flags, trace ownership, buffering and JSON serialization remain
the original algorithms. The other V8 base/platform interfaces are not exported
as supported APIs.

Consumers use `v8-tracing::v8-tracing` from its installed CMake package or
`pkg-config --cflags --libs --static v8-tracing`. Both propagate the explicit
target selector; CMake also propagates libuv's public ABI-layout selector. The
installed header set declares the tracing/platform interfaces needed by that
API, plus `kandelo/v8-native-fatal.h`. Its narrow C entry uses the complete
original logger's `GRACEFUL_FATAL` path and the existing guest libc abort
adapter. It needs no Node Environment or JavaScript callback. It does not
provide ordinary V8 engine entrypoints. Licenses from both
the complete Node and V8 source distributions are installed. Upstream provides
no man pages for these standalone tracing classes.

The SpiderMonkey recipe declares and links this foundation. The new fatal entry
is source implementation awaiting the coordinated native build and actual guest
signal qualification; a numeric exit status alone does not establish SIGABRT.
Neither this library nor its component evidence establishes Node startup or
complete public tracing support. Component and engine evidence remain separate
in the upstream runtime ledger.


Nine focused controls pass on Node, Chromium, Firefox and WebKit with identical
program/kernel bytes. Two additional compile-only controls check the true target
and precedence over the existing embedding Linux macro. The runtime controls observe actual category bytes and observers, copied
names and signed argument data, native convertable lifetime, duration clocks,
two guest recording threads, stop/restart, original JSON serialization through
a real guest file, and overwritten ring-buffer handle retirement. Relocated
CMake and pkg-config consumers also pass on Node. The pkg-config check exposed
libuv's absolute cache prefix, fixed in its revision 4 metadata with a byte-identical
runtime archive. These controls do not prove complete clock/locking/lifecycle
conformance or malformed API, OOM, security, fork or worker teardown behavior.
The original category arrays are process-global: controller ownership must respect
that lifetime, including future external JS byte views. Full Node tracing agent
and streaming-file errors remain unvalidated. Exact inputs, artifacts, attempts,
source identities and host cleanup warnings are in
the package-owned test sources.
