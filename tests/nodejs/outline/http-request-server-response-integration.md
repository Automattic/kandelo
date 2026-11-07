# HTTP request framing and ServerResponse integration

Source176 implements two shared HTTP source owners and corrects the public
method catalog. Full HTTP Server support is still absent.

The existing single llhttp owner now supports actual request and response
modes. Its real URL callback accumulates owned Latin1 bytes within the header
budget; parsed method indices, framing, body/trailers, keepalive, errors/EOF,
upgrade/CONNECT and unconsumed remainder come from the linked parser. HEAD
request bodies are consumed; HEAD response suppression remains response-only.
Existing IncomingMessage callbacks receive those actual parsed fields.

The genuine pinned ServerResponse constructor/prototype algorithms reuse
existing whole source pins and separately verified unchanged sections, not a
second HTTP stack. They share actual OutgoingMessage/header symbols,
IncomingMessage helpers, socket assignment, trace/performance observation and
an emitting response-created diagnostics producer. No false predicates or
invented measurements substitute for those owners. HTTP performance entry
capability remains incomplete in the current observation policy.

The native public method catalog uses actual compiled HTTP_METHOD_MAP; the
larger parser index table uses HTTP_ALL_METHOD_MAP. A shared portable native
helper supplies both, and production http.METHODS follows the pinned
methods.toSorted() policy. Current data matches35public HTTP methods and47
parser methods, replacing the old nine-name list. HTTPS namespace aliases
and other public HTTP metadata obligations remain open.

## Current focused evidence

Fresh native C++ parser and catalog controls compile against the current
portable header and the three identified existing pinned llhttp objects.
Both production native catalogs and the actual public selector match the
pinned native reference. Twenty-seven request cases and twenty-five unchanged
response cases pass, including retired/poisoned inputs, framing/error/budget,
body/trailer, upgrade/CONNECT and retained remainder. Callback fragmentation
and full byte-alias semantics are not established by canonicalized output.

Twelve current ServerResponse comparison groups match native over real
Writable/socket/stream/async/error/trace/performance dependencies. Two whole
unchanged upstream direct-constructor files pass in native and candidate
processes, four executions. Only this fixture's introduced test-binding globals
are restored before the unchanged upstream leak assertion; no whitelist or
assertion changes. These counts overlap and are not distinct API pass totals.

Nine live primitive comparisons use real accepted native loopback sockets at
127.0.0.1. Eight pass. One fails: raw0xff URL parsing correctly rejects, but
native HTTP Server supplies automatic400 while the narrow primitive driver
reports the parser error. Both original and current failures are retained.
The driver is not a production Server and no400 response was manufactured.

Four earlier tiny native compiler commands plus two fresh root compiler
commands are accounted, all successful. No llhttp library rebuild, engine,
kernel or product build occurred. Fourteen package checks,795input closure,
current bootstrap/unity generation and unchanged Mozilla checker pass.

## Remaining owners and limits

Full Server/createServer/_connectionListener, actual accepted HTTP admission,
ConnectionsList/timeouts, keepalive/pipeline/inflight queues, request/error/
expect/Host/clientError policy and handoff/abort/close/ref ownership remain
implementation gaps. The required net.Server.call(this) receiver initializer
is separately assigned; real TCP listen/accept alone does not implement it.

The packet bridge gathers native events before JS callbacks, leaving actual
synchronous callback/consume/pause/reentry, alias/mutation/error/rawPacket and
transient allocation/GC/realm behavior unresolved. HTTPS/HTTP2/secure pooling,
remaining clients/Agents and full public export/alias behavior remain open.

Production176new JSAPI is uncompiled; accepted173predates174/175/176. No guest
or Node/Chromium/Firefox/WebKit conformance, overall suite or full product
rebuild is claimed. Initial syntax, leaked test globals, manifest context and
source-check ordering failures are preserved. See the
[scoped ledger](http-request-server-response-finding-progress.json).
