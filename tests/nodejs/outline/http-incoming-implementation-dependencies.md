# IncomingMessage and HTTP response ownership

This implementation-phase slice follows H-009 and the consumption/write
ownership portion of H-013. H-002 header/trailer semantics also receive source
work. The frozen audit, target/source/native-reference pins and original
observations remain unchanged. No finding or family is marked complete.

## Actual implementation

The complete unchanged pinned lib/_http_incoming.js is retained under
third_party/node-core/upstream/http-incoming. Its complete-file SHA is checked
by sources.json/build.py before embedding it. The adapter requires the actual
shared stream, AbortController and process owners. There is no host HTTP
substitution in the production path. http.IncomingMessage and _http_incoming
share the same constructor/module; HTTPS response parsing uses that owner,
without adding an HTTPS IncomingMessage export.

The real Readable constructor/prototype and high-water mark, socket/client/
connection state, lazy headers/trailers, distinct null-prototype dictionaries,
raw counts and header first-wins/comma/cookie/set-cookie policies now belong
to the pinned module. Its timeout/read/destroy/aborted/signal/dump algorithms
are embedded unchanged. Their presence alone does not validate every method
or lower stream, socket and event integration contract.

The existing shared HTTP response parser constructs this actual class and
supplies raw headers before publication. Parsed chunk trailers are supplied
after complete=true and before readable EOF. joinDuplicateHeaders selects
actual target merging policy and receives public boolean validation. Malformed
framing and complete parser validation remain separate implementation gaps.

The client retains its socket through both actual response consumption (end)
and writableFinished. Parser completion alone no longer releases a connection.
The response owns its req link; end detaches its abort-signal socket listener.
After request/response completion, release is deferred to nextTick so user end
handlers run first, and the response's socket is detached before pooling.
Unobserved responses use the real _dump algorithm; request destruction also
destroys its owned response. This is a partial lifecycle implementation over
the existing custom client/pool, not a replacement for full Node Agent or
ClientRequest/OutgoingMessage ownership.

Recipe77 declares the new adapter/source inputs and changes generated JS
bundle/bootstrap bytes. No new native C++/engine patch, syscall, host import,
wire protocol, memory ceiling or ABI change is introduced. The last accepted
engine76 predates this slice: recipe77 is not compiled or guest validated.
There is no full product rebuild or overall-suite run.

## Focused evidence and limits

.context/node26-http-incoming-final/report.json records exact source, archive,
reference and command/log identities. Six focused controls and six affected
outgoing-header controls pass. New controls compare constructor/descriptors,
header/trailer merging, read/timeout/abort behavior, fragmented real loopback
response bytes, unread-response retention and an early response with a still
pending request-write completion. Repeated execution of the same controls
is not additional API coverage.

The test dependency boundaries are explicit: native Node26 supplies stream
machinery, AbortController, task queues, URL, low-level Buffer allocation/
brands and real loopback TCP. Candidate Buffer/header/IncomingMessage/parser/
client owners run unchanged from the current source bundle/bootstrap.
Those controls do not exercise guest SpiderMonkey/kernel or browser adapters.

Three unchanged upstream standalone files run in candidate and native modes:
test-http-incoming-matchKnownFields.js,
test-http-incoming-message-connection-setter.js and
test-set-incoming-message-header.js. Candidate preload replaces only native
http.IncomingMessage with the actual candidate class. It does not supply a
candidate server/parser/Agent to these standalone checks. Source bytes are
compared to the pinned source archive; no assertions/platform/skip policy is
changed. These are three files executed twice, not six distinct API cases.

The initial direct-control launch failed before assertions because it lacked
--expose-internals for the existing native Buffer boundary. A later default
Vitest launch ran its global index/fixture-stamp preparation, passed the six
new subprocess controls, but failed all six existing header controls because
the fork workers dropped that flag. Their raw logs and intermediate reports
are retained. The final run uses the existing source-only node-core config,
which disables product global setup and supplies the flag to fork workers.
No full product rebuild or broad suite ran. A later alias-only source update
has its own final identified evidence; earlier passing source remains historical.

## Remaining owning work

* Complete parser strict/relaxed validation, limits, malformed/duplicate framing,
  HEAD/information/CONNECT/upgrade, trailers and error metadata. This remains
  the custom parser, not llhttp conformance.
* Complete public OutgoingMessage/ClientRequest/ServerResponse inheritance,
  framing/backpressure/abort/timeout/request metadata and HTTP/HTTPS namespace
  and legacy alias fidelity. IncomingMessage's socket timeout event forwarding
  and all before/after-header/error phases need their complete client owners.
* Replace unsafe stale pooled-socket replay (H-010), pending/unsolicited idle
  response bytes (H-011) and custom pool identity/options with real Agent/socket
  ownership. This slice does not close those findings, HTTP/1.0/default-close,
  request Connection:close or full H-013 behavior.
* Complete servers/HTTP2/secure Agent/transport and capability-dependent host
  routes. Existing redirect extensions and the separate Claude/npm/Bun remainder
  are preserved; they are not Node compatibility requirements.
* Validate actual guest stream/AbortController/process/native byte owners,
  high-water mark/backpressure, error/fatal/close/cancel/ref/GC/realm races,
  incomplete response destruction and pooled socket reuse over identified
  ordinary stamped artifacts on Node/Chromium/Firefox/WebKit later.
* Reconcile all original observation/requirement scopes and API boundaries.
  No implementation gap or unrun/unsupported test becomes a passing API.

Continue independent worker/VM/testing/native integration owners before a
larger HTTP-only campaign. Full product rebuilds and overall suites retain
the user's existing deferral.

The subsequent normal targeted engine78 build includes this recipe77 HTTP
source. It is therefore compiled now; no actual guest HTTP behavior is
validated by the two separate VM controls. Full HTTP/four-host/ordinary stamped
consumer conformance remains pending.
