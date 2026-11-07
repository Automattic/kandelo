# Synchronous request-header owner controls

Explicit no-global-setup: run through scripts/dev-shell.sh with the exact pinned
native Node26.13.0 binary, complete Node source cache and a fresh absolute output:

```
NODE26_REFERENCE=/absolute/reference/bin/node
NODE26_SOURCE=/absolute/node-v26.13.0
HTTP_HEADERS_DIR=/absolute/fresh/evidence
```

Pass these as env arguments after scripts/dev-shell.sh, then invoke
bash third_party/node-core/tests/http-request-headers/run-controls.sh.
The runner hashes the pinned llhttp inputs and reference, compiles only three
unchanged native C parser objects and two tiny C++ controls, generates/checks the
current JS source bundle, and runs focused controls. It never resolves/builds an
engine, kernel, sysroot, product or overall suite.

The portable C++ owner is compared to actual Node HTTPParser on ordinary requests,
original-allocation mutation from inside headers, skip-body/upgrade decisions,
malformed headers, empty requests and numeric callback conversion. The existing
first-message framing contract is explicit: native reference input is supplied
incrementally to stop at that boundary; body chunk grouping is not compared.
A separate generated request-factory control uses actual native HTTPParser and
IncomingMessage dependencies, preserving full body bytes and original callback/
coercion errors. No JS AsyncResource shadows or fake parser predicates are added.

These controls do not execute the production SpiderMonkey callback/GC/realm,
backing-store lease or async/fatal path. The native wrapper's synchronous unshared
input capture is a real original-allocation capability, not a copied buffer or
JS root alone, but needs identified guest/runtime evidence. Shared input atomic
consumption remains an implementation gap and fails explicitly in this new path.

Full Server/createServer/_connectionListener remains unavailable. Reusable
HTTPParser initialize/free/pause/execute lifecycle, real ConnectionsList/timeouts,
body/completion callback timing, pipelining, native StreamBase consume and actual
HTTPINCOMINGMESSAGE async ownership remain work. This source primitive must not
be presented as complete HTTP server support.
