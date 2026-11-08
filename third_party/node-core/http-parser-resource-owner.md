# Real private HTTP parser resource epochs

Parser storage creation has no provider/init event, matching pinned Parser's
PROVIDER_NONE birth. The actual adapter initializes it with a genuine plain
HTTPClientAsyncResource tied to the outgoing ClientRequest or
HTTPServerAsyncResource tied to the accepted socket. Those two small classes
retain their exact pinned algorithms; provider selection is the native parser's
actual response/request role, HTTPCLIENTREQUEST or HTTPINCOMINGMESSAGE.

Initialize captures the real current frame/default trigger and allocates its
ID through JSContext's existing allocator. It destroys an old epoch once,
commits retained native public-resource/frame slots and emits native:init
before resetting parser/list state. Reusable response Free queues real destroy
without deleting its storage; Close and GC queue only any still-live epoch.
No GC finalizer calls JS. The existing per-context native async state is retained
through real backing lifetime and handles destroy delivery/teardown.

An initialization execution fence defers free/close reset/deletion across actual
init-hook JS. A callback-retired private initialization returns false and the
private factory refuses publication; this is truthful lifetime admission, not
a newly claimed target init-close error or full public Parser API. Generic
StreamListener/consume and public type switching remain missing.

HeadersComplete/MessageComplete now enter real parser-owned callback scopes
with exact pinned skip-task-queues policy; Body and actual trailing-header Flush
use ordinary MakeCallback checkpoint policy. Flush and MessageComplete have
separate scopes rather than one combined completion scope.
The shared host's new flag defaults false for every old caller, so unrelated
callback owners retain their task queues. Actual synchronous request callbacks
remain inside llhttp over their original captured allocation. Response callbacks
remain deferred packet replay; a private native dispatch owner supplies genuine
ID/frame/ref lifetime around those existing callbacks without claiming native
synchronous response chronology. Header result conversion remains after the
callback scope as in the target.

Explicit Free/Close invalidates the old private alias cache via native:retire;
that event does not allocate IDs or emit user hooks. Ordinary native after
retirement reads its entering ID from the authoritative stack before any backing
lookup, so a callback can close/free a real parser without unwrapping dead
backing merely to emit after. New native:init still refreshes reuse aliases;
old entered numeric IDs retain their stack authority. Destroy stays with the
actual native queue, never that cache invalidation event.

Source-only changes. No new runtime controls, compilers, generation, package
or overall suites, or guest runs. Existing private framing fixtures that omit
actual initialize/resource/dispatch protocol are not passing provider evidence.
Actual init-hook close/free/reinitialize, hook throw/fatal/checkpoint/reentry,
OOM/GC/realm/Worker/destroy order and current four-host conformance remain open.
Public HTTPParser/HTTPServer, generic StreamBase/HTTP2 and complete response
synchronous parse/error/remainder ownership are not activated by this slice.
