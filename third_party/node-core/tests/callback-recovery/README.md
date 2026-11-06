# Callback recovery component controls

`owner-control.cc` compiles the actual portable execution stack, retained-memory
ledger and callback-scope policy. Its payload and host deliberately stand in for
SpiderMonkey roots and runtime dispatch. It checks rollback, retained ownership,
nested scopes, clear epochs, recovery without duplicate after/checkpoint, and
synchronous failure propagation. It does not validate JavaScript API integration.

`bridge.cc` projects that same portable owner through actual Node-API reference
roots for `platform-control.cjs`. The latter executes the generated async
platform, unchanged pinned global exception handler, and actual production
adapter forwarding. Event, timer, metadata and destroy dependencies are explicit
component dependencies. They are not guest runtime implementations or evidence
for the SpiderMonkey callback bridge, garbage collection, or any of the four
Kandelo hosts.

The focused source runner must use the exact audited Node executable and a
configuration without product setup. The ordinary host Vitest configuration
prepares product artifacts even for a single source-only file.

Later production validation must cover native FS, CpDirJob, codec, DNS, watcher
and zero-ID callbacks; timer/tick/microtask failures; absent and recovered
handlers; capture callbacks; handler and hook exceptions; nested synchronous
callbacks with catch/finally; clear epochs; resource resets and public aliases;
realm access, garbage collection, cancellation and teardown. Preserve the known
`_fatalException` getter-throw discrepancy: the native control exits zero while
the current SpiderMonkey proposal preserves/reports its real getter error.

The public C++ `node::AsyncResource::MakeCallback` legacy path can swallow an
inner failure without calling the process handler. It is a different reference
path from actual Node FS/AsyncWrap completions; do not substitute it for those
completion controls.
