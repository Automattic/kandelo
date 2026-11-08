# Private HTTP framing reset and retirement owner

This is a bounded storage/lifetime prerequisite over the existing real llhttp,
Body/Complete and ConnectionsList owners. It does not activate public
HTTPParser/HTTPServer or invent HTTP AsyncWrap provider/init/destroy events.
No new guest C++ or portable helper was compiled or run for this slice.

## Reusable storage and real terminal paths

The portable parser has an actual Reset operation: admit method storage and
connection clock before committing, detach old membership, clear headers,
URL/status/error/callback/byte counters and completion flags, reinitialize
llhttp, reapply the real leniency options, and attach the actual requested list.
Reset preserves the allocated settings object and restores parser.data to its
own real address. Release runs only after the active frame unwinds, resets
llhttp input/error pointers and clears private retained state. Original input
allocation capture and synchronous request callbacks are unchanged.

The native owner distinguishes active execution, reusable released storage and
terminal deletion. Free/close requested from a real callback mark removal and
detach the real list immediately, but defer reset/deletion until the outer
native parse fence unwinds. Close wins over free. One fence owns accounting
and retirement so no later accounting guard can dereference a deleted owner.
A pending original JS exception is not replaced with a manufactured parse
packet or swallowed by retirement. Callback roots remain stack-owned through
the actual active invocation. The class/self-edge/list query GC policy is
preserved; normal actual finalization remains an owner of unclosed storage.

The existing private response factory consumes real native reset/release via
the complete pinned FreeList algorithm, bounded at Node's current 1000-parser
cache size. Idle entries are actual native storage, not copied parser-shaped
objects. Each old JS API is permanently closed before its storage is pooled;
reentrant new requests cannot make that old API feed the new native epoch.
Request wrappers retain their actual ConnectionsList identity and are not
pooled; close still uses the deferred native lifetime fence. A failed factory
publication closes its admitted owner rather than leaving a listed/cache job.

Actual current client socket release, upgrade and request-close paths close
that private parser. Remainder bytes are observed before retirement, and old
socket listener/response cleanup still owns transport state. Closure/options,
message, socket and header links are cleared before caching. Cleanup failure
still reaches native retirement in finally; callback exceptions propagate.
Consume stops after reentrant close instead of invoking late Body/Complete
or dereferencing a cleared options owner.

## Target trace and limits

Pinned node_http_parser.cc distinguishes Initialize/Init, Remove, Free and
Close. Remove suppresses later callbacks/list membership; Free clears cached
callbacks and emits destroy for its actual AsyncWrap; Close deletes backing.
_http_common.js removes/cleans before caching and defers deletion until the
parse stack unwinds. This slice implements real private storage transitions;
it does not pretend to provide the still-missing AsyncReset/provider/native
StreamListener/consume resource behavior or full public type-switching API.

One pinned native process observed list movement and cached callback replacement
across reinitialize, error recovery after real reinitialize, callback removal
suppressing later Body/Complete, and idempotent completed close. Those are
reference observations, not new C++ execution, API passes, public Server proof
or guest evidence. The real internal-binding warning is preserved in stderr.

Remaining gaps include full public HTTPParser initialize/free/AsyncWrap timing,
request-wrapper pooling and type changes, automatic persistent multi-request
serving, StreamListener/consume, shared-input atomic policy, complete response
callback timing and copied remainder/error publication paths. GC/realm/reentry,
allocation failure, error/cancel cleanup and pool memory retention require
identified-artifact evidence. Exact current private fixtures that assume only
create/feed/finish need genuine initialize/free/close dependencies before
validation; no stale fixture is counted passing here. Full HTTPServer remains
held until its actual consumers and lower owners are coherent.
