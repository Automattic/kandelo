# Integrated HTTP outgoing ownership

Source checkpoint138 integrates the unchanged complete pinned OutgoingMessage
and its real shared header symbols beneath the existing custom ClientRequest.
The actual socket/output/drain/finish paths replace the old raw-body Writable
bridge. http.OutgoingMessage and _http_outgoing share the same real owner.
This addresses H-005 and part of H-009 without closing either finding/family.
The detailed owner/source/remaining crosswalk is in
[the dependency report](http-outgoing-implementation-dependencies.md).

The ClientRequest socket is supplied only after parser/listener ownership is
installed. Its real _httpMessage claim, drain callback and connection-time
flush drive the pinned output queues. Actual write acknowledgments and response
consumption retain the socket until writableFinished and response end. Upgrades
remove request listeners before transferring the actual socket. Ordinary parser
errors and custom client/pool policy still require their remaining audit work.

## Root evidence

The frozen proposal's ten new files and seven shared hunks were reconciled with
source137. Shared VM flags/hooks, truthful Kandelo target, native memory/worker/
locks/default-trigger owners survive unchanged. The current generated bundle
was rebuilt from source, not copied from the old private worktree. Six complete
reference paths (five distinct Node files) match the audited source archive.
Source input closure covers679 files. Current bootstrap generation/syntax,
module routes and exact optional redirect/Bun suffix preservation pass.

All20 focused runner groups pass: four source/version checks, two component/
request control groups and fourteen affected parser/lifecycle groups. Component
controls contain13 wire cases,eight validation cases and two descriptor groups;
request controls contain14 cases. The early-response pending-write case occurs
in request and affected controls; these counts are not unique API coverage.
The separate source-only Vitest invocation passes six existing header cases and
fourteen package checks with zero failures/skips. Global product setup is
explicitly disabled and the pinned native Node is selected.

New framing controls use real native TCP peers, reads, EOF and completed writes.
Candidate outgoing/client/header/Buffer/parser adapter source executes against
explicit native stream/low-level Buffer allocation/async/tasks/clock/URL/parser
boundaries. These are not production SpiderMonkey/guest/TLS or browser results.
No engine/package/kernel compilation, overall suite or full product rebuild
ran in this root slice. Accepted engine116 remains stale for source117–138.

The old fake early-response fixture assumed header and body were separate writes.
The pinned outgoing owner may coalesce them. Its original exit1 replay and
failure evidence remain preserved. The replacement uses a real paused TCP peer
and an8MiB pending write for both candidate and native reference. It asserts
unfinished request state, socket retention/no idle pool, actual finish/close and
response abort-signal detachment. This changes a local dependency fixture, not
an upstream assertion. Other existing affected assertions remain retained.

The sealed private setup interruption remains separate: historical SDK/musl/
instrumenter/seven fixture builds,zero HTTP tests,terminal130. It is not a root
HTTP pass or full product rebuild. Initial debug-owner/runner/launcher failures
remain in the immutable handoff; no retry result erases their original scopes.

## Remaining obligations

The custom client is not unchanged upstream ClientRequest. Complete options,
URL/auth/header-array/protocol/Agent and returned-class/alias/descriptor behavior
remain open. setTimeout/setNoDelay/setSocketKeepAlive no-ops and abort/error/EOF/
close/reentry phases need real owning behavior. The private pool is not Node
Agent, and TLS identity/configuration-sensitive pooling must use actual secure
owners. Servers, secure agents, HTTP2 and broader Fetch integration are missing.
No current four-host conformance or accepted platform exclusion is established.

The frozen audit and target/source/native pin, program/kernel/host ABI and
memory ceilings are unchanged by this slice. All19 families remain partial.
Full product rebuilds and overall suites remain deferred; next source work
includes corrected ELD, retained backing stores, TLS trust and real watchers.
Exact source/evidence identities and preserved nonpasses are in
[the finding ledger](http-outgoing-finding-progress.json).
