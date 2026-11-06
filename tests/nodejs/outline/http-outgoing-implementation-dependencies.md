# OutgoingMessage and request framing ownership

This source slice addresses H-005 and the OutgoingMessage part of H-009 from
`audit/http-contracts.md`. The frozen audit and Node26.13.0 target remain
unchanged. It does not close the HTTP family, ClientRequest or Agent contracts.

## Owners

`third_party/node-core/upstream/http-outgoing/lib/_http_outgoing.js` is the
complete unchanged pinned module, not selected replacement framing logic.
`http-outgoing-sources.json` records the complete file identities, the actual
UTC-date cache from `lib/internal/http.js`, and the client method-dependent
body defaults and drain callback from `lib/_http_client.js`.
`generate-http-outgoing.py` verifies the target/commit, whole files and exact
selections before `build.py` embeds them. `http-outgoing-adapter.js` supplies
actual shared Buffer, LegacyStream, EventEmitter, async-trigger scope, stream
watermarks, errors/validators/debug and an unref'ed real timer. Unsupported
internal dependencies throw. No host HTTP client is substituted in production.

The pinned OutgoingMessage now owns public header storage and validation,
Content-Length/chunked decisions, exact chunk/trailer bytes, strict-length
checks, corking, pending output, socket write acknowledgments, backpressure,
finish/end callbacks and writable state. `http.OutgoingMessage` and
`_http_outgoing.OutgoingMessage` share this actual constructor/module. The
existing client inherits its LegacyStream prototype instead of Writable.
`http-headers-adapter.js` shares its real private header symbols and installs
only the client's pinned path accessor; production framing methods are
inherited unchanged. Its isolated header-selection controls remain dependency
controls, not another public constructor.

The existing custom ClientRequest supplies its actual socket through the
OutgoingMessage socket accessor, claims `socket._httpMessage`, attaches the
pinned drain callback, and flushes actual pending output after connection.
The old raw `_write`/`_final` path is removed. `_implicitHeader` invokes the
actual `_storeHeader`. Expect commits its header during construction, following
the selected pinned constructor branch. The real response consumption plus
`writableFinished` socket-release fence remains. Closing retires the request
once and discards unreachable queued output; upgrade/connect removes request
listeners before transferring the real socket. Parser/IncomingMessage and
net/TLS owners remain separate. There is no simulated transport or completion.

## Source correspondence

The unchanged vendored `_http_outgoing.js` constructor is at line127;
corking at331; `_storeHeader` at493; strict length and write at1053/1064;
trailers at1187; end at1278; flush/output at1405/1424. Existing pinned
`upstream/http/client.js` has method defaults at491–500, drain at731,
socket-close/error at739/785, response-end at1048 and request-finish at1096.
Those source branches establish real ownership; they do not establish full
custom-client event/error/Agent parity merely by being referenced.

## Focused verification

`tests/nodejs/run-http-outgoing-controls.py` accepts explicit pinned native
Node, source tree and output paths. Run it through `scripts/dev-shell.sh`.
It verifies unchanged source identities, generated bundle consistency and JS
syntax, then runs 13 component wire cases, eight validation cases, two
namespace/prototype descriptor groups, 14 request framing cases and 14
existing affected parser/lifecycle groups. New framing cases use real native
TCP sockets, real peer reads/EOF and actual write/finish/close callbacks.
The early-response case pauses a real peer while an 8MiB write is pending,
asserts the request remains alive through response end, then resumes the peer
and observes actual finish/close. No fake socket callback schedule is used
for that control. Date-header comparison checks the real clock within two
seconds before comparing the remaining wire bytes exactly.

These are dependency controls: native Node supplies stream machinery,
low-level Buffer allocation/brands, task queues, URL, async scope, clock and
the parser test binding. Candidate public/client/header/Buffer/parser adapter
source runs in the identified bundle. Existing affected groups retain their
original explicit boundaries, including some actual in-memory Duplex tests;
they are not all loopback or native differential cases. The six affected
header Vitest cases pass using source-only configuration with global setup
disabled and `--expose-internals` in fork execArgv.

An initial header-test invocation accidentally selected normal global setup.
It completed a private historical SDK driver, wasm32 musl core, fork
instrumenter and seven pinned ABI-55 Wasm fixtures before private index
preparation failed/interrupted. It ran zero HTTP tests and is not HTTP pass
evidence. Its exact command/log/termination and output identities are sealed
separately under `.context/http-framing-agent/setup-attempt`. No engine or
package compile was invoked, and there was no full product rebuild or overall
suite. Later source-only tests do not invoke that preparation.

## Remaining obligations

* Full pinned ClientRequest option/auth/header-array/URL/Agent/startup behavior,
  HTTP/HTTPS returned-class identity and namespace/legacy aliases beyond the
  actual OutgoingMessage export remain partial.
* The private pool is not Node Agent. Request Connection:close, timing,
  idle/unsolicited data and all reuse/error phase ownership need the actual
  Agent/client owners. Existing release/no-replay controls do not close them.
* Abort/timeout/setNoDelay/setSocketKeepAlive, response abort/error/close phase
  order, callback reentry and parser EOF/error metadata require full client
  lifecycle integration. Existing custom client branches are not claimed as
  unchanged upstream ClientRequest.
* No production SpiderMonkey/JSAPI execution, guest net/stream/TLS integration,
  pressure/GC/context-retirement check, unchanged upstream HTTP suite or
  Node/Chromium/Firefox/WebKit conformance ran for this source slice. The
  production unref timer and native async/socket ownership require those
  later checks over identified ordinary artifacts.
* Servers, secure Agent/transport, HTTP2 and capability-dependent routes remain
  open. The optional redirect body and Claude/npm/Bun loader remainder are
  preserved. No original observation is converted to a pass by this document.
