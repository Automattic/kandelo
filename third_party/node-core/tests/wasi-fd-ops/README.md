# Focused WASI descriptor-owner controls

These are native POSIX/V8/N-API component controls, not guest or four-host
conformance. public.cjs runs the unchanged pinned public WASI constructor over
the actual portable Context via component-addon.cpp; native mode alone uses
native node:wasi as reference. Candidate WASI/filesystem behavior is not delegated to it.
New SpiderMonkey JSAPI, security/realm/GC and nested-Wasm execution remain open.

Use scripts/dev-shell.sh and exact audited Node26.13.0 reference. Set fresh
WASI_FD_CONTROL_DIR under the repository .context and explicitly set
WASI_FD_CORE to the actual normal-generated third_party/node-core/node-core.js,
WASI_FD_COMPONENT to the native addon and WASI_FD_RUN to a fresh short identifier.
Pass those environment assignments inside the dev-shell command (scripts/dev-shell.sh env VAR=value ...); exports outside it are not retained.
Node artifact, source/header/addon/serdes and complete commands/results must be
hashed before running. Do not substitute a system Node or old whole core.

A fresh native fixture builds unchanged upstream/wasi/deps/uvwasi/src/wasi_serdes.c
as C11, component-addon.cpp as C++20 N-API (exact Node include/node, core and
uvwasi/include dirs; Darwin uses -shared -fPIC -undefined dynamic_lookup), and
owner-control.cpp as C++20 linked to that actual serdes object. Each compiler
invocation counts, including failed/syntax attempts. The original sealed
wasi-fd-owner-agent evidence reused an exact existing serdes object, hence two
new helper attempts, both successful; this does not imply future fresh builds
need only two invocations. No engine/kernel/product build or setup is required.

Run public.cjs MODE CASE with MODE native/candidate and CASE
allocate/times/renumber/readdir. Four groups per case cover real growth/error/
rights/argument order, timestamp flags/omission/precision, row/destination-close/
reuse/preopen chronology, and actual entries/cookies/rewind/truncation/bounds/
rights/path errors. Both subjects must agree under identical assertions. Keep
failed runs and timeouts distinct, with command/input identity and actual
partial stdout/stderr; fresh output roots prevent overwriting an earlier run.

Run owner-control executable with a fresh actual directory argument. It retains
existing80constructor-allocation-fault and original-memory IOV assertions and
adds six actual fd-owner groups: allocation, timestamps, preopen row move and
real recycled-fd survival, failed-close rollback, same-raw-fd aliases and repeated
directory cleanup/padding/rights. Assert actual descriptor conservation and
claimed capacity restoration; neither counts RSS. That helper's temporary
files/preopens stay under its caller-supplied directory and its captured stdio
fds remain distinct from host process stdio.

New fd import source is not full WASI support. fd_advise/kernel307, ten path
imports, poll/signal and four socket imports remain real implementation gaps.
The historical direct-Wasm signed-i32/native-import provenance assertion remains
nonpassing and is not weakened by these direct-JS controls. Nested-Wasm backend
work is deliberately deferred; exports/memory presence do not establish it.
