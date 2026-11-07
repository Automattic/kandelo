# Consumed HTTP request-header execution prerequisite

This is a bounded owning prerequisite discovered while tracing generic HTTP
Server/createServer/_connectionListener. It does not implement those public
exports. They remain unavailable until their actual parser/list/stream/lifecycle
prerequisites exist. An imported frontend atop the current packet parser would
not be correct HTTP server support.

Private source base:1b2ce3e119, with only the sealed generic net.Server receiver
runtime prerequisite composed locally (prerequisite-composition.json). The HTTP
patch contains9 leaves, excludes that prior prerequisite and requires no new HTTP
production input declarations or engine registration patch. No root source,
Domain/native async/callback/FS/stat owner, curated adapter, registry metadata,
ABI, target pin, kernel, host or upstream source was changed.

## Exact owning trace and bounded selection

Pinned lib/_http_server.js:648-690 expects actual net.Server.call receiver
initialization (source177 prerequisite), then owns connection and listening
listeners. Its connectionListenerInternal:810-885 allocates/initializes a real
HTTPParser, binds Incoming/Outgoing/socket state and calls parser.consume only
when the actual socket handle is a real StreamBase. An actual non-StreamBase
socket uses the existing JS data path; no isStreamBase predicate was fabricated
or changed in this slice.

Pinned node_http_parser.cc:268-300 and1188-1325 owns real ConnectionsList intrusive
parser lists. Initialize records a monotonic request-start time even before data;
message-begin updates it, headers completion marks header state, message completion
removes active state and resets the timestamp, and parser close/remove unregisters
ownership. expired removes each expired active parser once. JS server timeout
intervals consume those actual lists, not arrays pretending to be parser records.
All of this remains missing in the Kandelo owner, not an accepted boundary.

The current real llhttp owner previously parsed the whole native buffer, queued
header/body/completion packets, and only then invoked JS headers. It permanently
pauses after the first final message. Consequently a JS headers return could not
control native body/upgrade consumption, and mutating the original input from
that callback happened after parsing rather than inside it. Replaying packets or
looping over copied remainders cannot establish reusable native HTTPParser,
backpressure, pipelining, ConnectionsList or correct callback/async ownership.

This slice fixes the actual synchronous header decision and original allocation
seam, which is needed before those complete owners can be connected.

## Implemented actual behavior

The portable parser accepts an optional stack-scoped HeadersHandler. The real
llhttp on_headers_complete invokes it before body bytes are read; its actual
return code enters that same C parser frame. A supplied synchronous header is
not also replayed as a queued header event. Ordinary response packet consumers
keep their existing interface and policy.

ActiveStep owns the current step/handler pointers and clears them on every C++
unwind. Reentrant execution on the same active portable parser is refused before
altering its state. The native owner also guards actual execution and restores
that state through ScopeExit. Neither field is guest capability/liveness metadata.

The existing native httpParser binding gains a consumed operation,
feedRequestHeaders(owner, input, callback). It validates the real request owner
and callable argument, roots the callback/owner, and acquires the actual original
unshared storage via KandeloCryptoByteSource.Capture and its SpanRef capability.
The parser uses that capability's Data/Length through the synchronous frame,
including callback allocation/GC or view retirement. A scoped JS root alone or a
copied byte vector is not used as input authority. No raw borrowed pointer is
kept under AutoCheckCannotGC while invoking JS. Security admission remains the
existing checked/realm-aware byte owner.

Raw C parser reads cannot race shared JS writes. This new synchronous path fails
shared input explicitly until there is a real atomic consumption owner; it does
not hide a copied shared snapshot. This is an implementation gap, not a passing
platform boundary or complete BufferSource support. Detach/resize/transfer,
GC/CCW/denied-wrapper, OOM, interruption and teardown behavior still need actual
identified engine controls. The production JSAPI/lease path is uncompiled here.

KandeloHttpHeadersCall invokes the actual rooted callback inside llhttp. A failed
callback or number coercion leaves its original pending JS failure intact after
unwinding native frames; the binding returns failure rather than manufacturing a
parser-error packet/400 response. No new AsyncResource, provider ID or fake native
parser class was introduced. Full HTTPINCOMINGMESSAGE async ownership remains
missing and is not inferred from enclosing socket context.

Callback result conversion follows the exact pinned native path:
Value::IntegerValue -> NumberToInt64 saturation -> int narrowing. A direct
ToInt32 would be wrong for infinities and values at/above2^63. The portable
HeadersDecision helper implements that numerical stage; JS::ToNumber performs
real conversion/errors before it. The concrete source hashes for node parser,
V8 api.cc/conversions-inl.h and Node JS callbacks are in pinned-source-trace.json.

The existing generated _nodeHttpParser.request consumer now calls this native
operation and uses its unchanged pinned parserOnHeadersComplete algorithm inside
the real callback. It forwards the actual onHeaders decision, preserves default
upgrade handling and delivers body/completion packets through the existing
contract. Those latter callbacks are still deferred; they are not called parity.
The actual extracted production _nodeNative object and its actual async prologue
are executed in the final consumer controls, so the callback argument's forwarding
seam is not merely a factory-only injection.

## Exact focused evidence

Final identities are source-identities.json and the before/after images. All
commands ran through the declared devshell with explicit no-global-setup. Node
source/native remain26.13.0 /18b32a3b1552e199a01f1a8d9fd64aa756d3b75b; native
binary SHA256533bd644c5ae0e0ea3a80e433aad16b817447ccba1e1eea701875eac80cb75d4.
The six pinned llhttp input files are checked against the existing node-llhttp
recipe inventory before any focused compilation.

-16 request groups pass in final production-forwarded-request-controls:
  11 real portable/native HTTPParser differentials, one active-parser reentry
  admission control, two generated request-consumer decision/body controls, and
  original callback and valueOf failure identities. Decisions cover ordinary
  parsing, original allocation mutation, skip-body, real upgrade head, malformed
  headers, empty requests, NaN/infinities and large integer conversion.
- Existing unchanged response fixture passes25/25 framing cases on the newly
  compiled portable owner. Its source/assertions were not changed.
- The native reference is the actual HTTPParser. To observe the existing
  first-message boundary it receives bytes incrementally; body chunk grouping,
  whole-buffer pipelining and full reusable native execute are not established.
- The request JS consumer executes candidate source over actual native
  HTTPParser/IncomingMessage and an explicit packet-operation bridge, through the
  actual production forwarding object. This is component evidence, not production
  JSAPI/GC/backing/resource/async/fatal or guest/four-host conformance.
-32 source checks pass, including exact pin/source identities, composed bootstrap
  syntax, protected ownership surfaces, current source/artifact identities,
  normal native source staging with the actual unchanged pinned include checker,
  and a zero-fuzz patch/postimage round-trip. This is source staging, not engine
  compilation.
- Private input closure examines797 production files and honestly exits1 for the
  prior net.Server prerequisite's server-constructor-adapter.js declaration.
  Source177 already owns that integration. This HTTP slice adds0 production files
  requiring declaration. The private closure is not called passing.

Native compilation accounting:10 tiny successful compile steps total (two rounds
of3 unchanged llhttp C objects +2 C++ controls). The second round was needed after
fixing the newly discovered IntegerValue conversion semantics. No production
SpiderMonkey, kernel image, product build, overall suite or guest test ran.
controls-r3/provenance.json identifies the final binaries and source. No failed
compilation is invented; all10 native compile steps succeeded.

## Preserved failures and fixture limitations

The first request control run exited1: its consumer assumed a single Readable.read
would concatenate all one-byte native fragments and observed Z instead of Zbc.
The exact original control-r1.cjs/logs remain. The corrected fixture drains until
null and retains the strict full-byte Zbc assertion. No runtime implementation or
upstream assertion was changed to satisfy that fixture.

The first source verifier incorrectly expected the existing variadic httpParser
forwarder to have arrow syntax; its exact script/log remain. The real source uses
a variadic method and was already correct. The stronger actual forwarding-object
control initially failed because the fixture omitted its real runWithAsyncContext
prologue; source/logs remain. The final control executes that exact production
prologue too. These are fixture errors, not production fixes. One editor command
also used the wrong cwd and failed before any edit; its intended change was then
applied explicitly. Final checks use the exact sealed postimages.

## Required continuation; public Server still absent

1. Reusable native HTTPParser initialize/reset/execute/finish/pause/resume/remove/
   free/close over original input and real callback/exception ownership. Stop-after-
   first-message and copied remainder are not a server pipelining implementation.
2. Synchronous body/completion/message-begin/header-flush callbacks, actual stream
   backpressure, exact upgrade/incomplete-body/EOF/keepalive and reentrancy policy.
3. Real parser HTTPINCOMINGMESSAGE native async initialization, resource/trigger
   identity and callback/fatal/Domain/Promise boundaries; no shadow resource.
4. Native ConnectionsList lifecycle and actual monotonic initial/header/request
   times, expired/active/idle queries, release and timeout-checker ownership.
5. Actual StreamBase consume/unconsume if that real handle capability is exposed;
   otherwise retain the genuine upstream JS-data path without fake predicates.
6. Reuse the complete pinned _http_common/_http_server/http algorithms over those
   owners, with one actual symbol/module identity and existing real IncomingMessage,
   ServerResponse and OutgoingMessage. Only then connect public Server/createServer/
   _connectionListener, preserving constructor/inheritance/descriptor/error order.
7. Compile/execute identified current guest artifacts on all four hosts, including
   actual backing lease mutation/detach/resize/transfer/denial and resource cleanup.
   Preserve the user's full-product-rebuild and overall-suite deferrals.

Parent must rebase the narrow HTTP files against current source178+ and regenerate
the combined bundle, preserving Domain/native callback/FS/stat/registration and
source177 net receiver changes. Do not overwrite shared/generated whole files or
copy this private base's missing later implementation back into root. The source
primitive is genuinely consumed; it is not full HTTP Server support or goal closure.


## Current parent integration

Source181 applies only the actual HTTP owner/consumer delta to current180,
regenerates the combined bundle and preserves Net177/Domain178/WASI179/ESM180.
The narrow portable header and request factory match the sealed final compiler
producer byte-for-byte. Fresh root controls reuse its exact identified native
request/response executables;0new compiler commands run. All10earlier successful
compiler steps are now included in integrated accounting.

Current16request groups/11native differentials and25unchanged response cases
pass. Actual current production forwarder and request consumer execute. The
native HTTPParser reference is deliberately observed at the existing first-message
boundary; this does not establish whole-buffer pipelining/reuse/backpressure.
Normal817input closure, bootstrap/unity staging, unchanged Mozilla checker and
14package checks pass. Private declaration failure remains historical; root177
already added that actual Net adapter input. No new HTTP production input exists.

Production native Span/JSAPI/GC/realm/detach/resize/transfer/worker semantics are
uncompiled/unexecuted. Shared atomic consumption remains a missing owner; the
new sync path fails it honestly. Full parser/ConnectionsList/callback/stream/
async/fatal/Server behavior and allfourhosts remain open. Accepted173predates
current181. No engine/kernel/library/product build, overall suite or full
rebuild ran. No finding/family closes. GuestWasm backend remains in scope,
scheduled for finalphase by explicit user instruction.
