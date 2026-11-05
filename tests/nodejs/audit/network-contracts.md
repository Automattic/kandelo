# Net, DNS and datagram public contracts

State: **source review complete with implementation gaps** for `node:net`,
`node:dns`, `node:dns/promises` and `node:dgram`. The earlier
[layer trace](network.md) remains part of this review. No runtime test,
probe, compilation or build ran. Source completion does not mean working
implementation or current-candidate conformance on any of the four hosts.

`network-requirements.json` preserves all 503 original discovery identities:
223 documentation sections and 280 native descriptor observations. Lazy
getters, inherited Resolver methods, returned/native-owned objects, events,
options and transfer/disposal symbols extend that incomplete inventory.
Documentation and capture counts are not counts of unique APIs. Every
remaining source or reference question is retained; skipped/unsupported
fixtures are not passing behavior.

## Scope and exact owners

The target remains Node 26.13.0, source commit
`18b32a3b1552e199a01f1a8d9fd64aa756d3b75b`. The source/native pins and
historical evidence identities are unchanged. All four hosts run the guest
compatibility layer, not their embedding host's net/dns/dgram modules.

Candidate bootstrap owns DNS lookup at 4123–4190, TCP dialing at
4193–4450, Socket at 4451–4676, Server at 4679–4800, factories/defaults at
4803–4827 and the BlockList stub at 4829–4838. Final dns.resolve still
returns a fabricated loopback result at 5809–5815. The later promises object
at 6014–6023 supplies lookup and default-order controls and is shared with
dns.promises. No later assignment supplies missing record/resolver/address/
datagram operations. dgram has no public builtin entry at all.

The target's owners are `lib/net.js`, `internal/net.js`,
`internal/blocklist.js`, `internal/socketaddress.js`, `lib/dns.js`,
`internal/dns/{utils,callback_resolver,promises}.js` and `lib/dgram.js`.
Native TCP/UDP handles, address/rule objects, getaddrinfo/getnameinfo jobs
and per-Resolver c-ares channels provide actual resource state. Importing
those wrappers without their native owners would not establish behavior.

## TCP: positive paths and remaining gaps

The candidate performs real nonblocking connect, local bind, listen,
accept, read, partial write, shutdown, getsockname/getpeername, close and
poll-driven waits in frozen `js.cpp`:793–934,1072–1515. Native operations
own their actual descriptors and rooted promise/buffer state. Pending
connect cancellation uses its promise token rather than a possibly reused
descriptor. Accept configures nonblocking/close-on-exec state and closes
the accepted descriptor on failed conversion or resolution. Per-descriptor
fd/writeQueueSize metadata is invalidated on ownership retirement; it does
not pretend to be the entire private Node TCPWrap interface.

Public Socket/Server callable constructors and subclass construction use
Reflect.construct and the actual Duplex/EventEmitter prototype chains.
The connect/createConnection aliases share a factory. The three isIP
helpers use the pinned IPv4/IPv6 grammar, including mapped IPv6 and scopes,
rather than treating every colon-containing string as valid. Actual bytes,
backpressure, writable callbacks, read EOF, SHUT_WR, half-open handling,
timeouts refreshed by I/O and native write-queue progress, refs and
pre-connect cancellation exist. These must not be reported as no-ops just
because adjacent controls are missing.

| Finding | Public requirement and source conclusion |
|---|---|
| N-007 | SocketAddress and BoundSocket are absent. Address parsing/serialization/flowlabel, real pre-bound reservation, adoption, errors, worker/child transfer and disposal cannot be supplied by a matching record. |
| N-008/N-009 | Socket.setNoDelay/setKeepAlive return this without applying controls. Kernel options are stored, but the inspected NetworkIO interface lacks corresponding transport controls; read-back alone cannot prove Nagle or keepalive effects. All keepalive overloads, probe delays/interval/count and constructor options require actual effects. |
| N-010 | Socket byte counters, bufferSize/readyState/pending, destroySoon/resetAndDestroy, TOS and numerous socket-specific metadata members are missing. Inherited Duplex state does not implement native connection accounting or reset. Instance address fields also differ from target phase-aware accessors. |
| N-011 | Unix path/fd/blockList listener options explicitly reject; BoundSocket/handle adoption, cluster sharing, transferred handle and server async-disposal support are missing. Existing kernel AF_UNIX support makes Unix stream IPC a missing bridge, not a browser impossibility. |
| N-012 | Native listen forwards the actual backlog, but runtime-core sys_listen_impl ignores `_backlog`, and host_net_listen errors are discarded after state becomes Listening. The shared accept queue is real and fork-inherited, but requested queue bounds/host registration failure and rollback do not follow from that fact. |
| N-013 | TCP/DNS request/handle async-resource providers, trigger IDs, callback/fatal-error scopes, performance/diagnostic producers and context destruction are not implemented by generic Promise hooks. Worker/child descriptor transfer requires actual native ownership, not serialization of fields. |
| N-015 | Socket reuse/fd/terminal lifecycle differs. fd construction only fstats the descriptor instead of target TCP/pipe handle-type validation. connect resets `_socketDestroyed` without target initSocketHandle/_undestroy and stream state restoration; pending read callbacks lack a new connection generation check. `_final` always calls shutdown(-1) for a never-connected socket; target lib/net.js:812–835 succeeds when no handle exists. These are source gaps; no new reconnect or EOF outcome was observed. |
| N-018 | Server constructor ignores blockList, highWaterMark, noDelay and keepalive configuration; accepted sockets only inherit allowHalfOpen. A constructor BlockList is therefore not enforced, even though a BlockList passed to listen rejects. pauseOnConnect only suppresses one explicit read start without initializing the accepted socket paused. Default bind chooses :: without target IPv4 fallback on unsupported IPv6. Limits, drop/cluster behavior, reentrant error/close/listen ownership and exact callbacks remain affected. |
| N-019 | Family-attempt policy has genuine alternating-family selection/deduplication, attempt events/timers, final-address behavior and AggregateError collection, but no target CLI/worker initialization. Custom resolver result validation, abort/error reentrancy, timer/ref interactions and callback phases require exact later controls; copying the algorithm is not conformance. |
| N-020 | Native read/write/close waits often reject with strings from KandeloResolvePromiseWithErrno; callers forward these directly to write callbacks/destroy rather than the complete Node errno/error schema. Address errors are generic. Listener/connect events emitted inside Promise handlers also need the actual Node fatal-error/context semantics, not merely the same event name. |

Target constructor fd checks distinguish real TCP/pipe handles
(`net.js`:195–210,702); target reinitialization restores stream state
(`net.js`:333–353,1580–1650). Candidate adoption, rollback, old pending I/O
and fd reuse therefore need the real native owner and stream lifecycle.
Returned private handles and underscore helpers in the saved capture are
retained as source-exposed metadata/internal contracts; they are not a
promise that every V8/libuv private handle method is a portable public API.
The underscore prefix alone does not erase an original discovery row.

Server has real generation checks, accepted connection counts, drop
records, abort cleanup, listener closure and deferred close after its
accepted sockets close. Those are positive source paths, with the gaps
above. Target also requires correct maxConnections/dropMaxConnection and
cluster semantics, connection versus listening/error/close ordering,
ref/unref before and after listen, pathname cleanup, errors and inherited
EventEmitter/disposal behavior. A Node-like event emitted from a different
native/Promise phase is not sufficient evidence.

The default auto-select flag is true and attempt timeout **500 ms in the
exact Node 26.13.0 pin** (`src/node_options.h`:185,245), matching the
candidate's initial values. Do not substitute an older Node release's
default. Target setters validate/clamp timeout to at least 10 ms; candidate
has that logic. CLI overrides and inheritance are separate missing inputs.
IP classifiers are source-backed, but callable/prototype descriptors,
poisoned intrinsics and exact input coercions remain validation obligations.
The legacy net.Stream === net.Socket alias is missing; lazy BlockList and
SocketAddress getters and internal helper/deserialization exports also
lack target namespace/descriptor behavior.

## Address, reservation and rule ownership

Target SocketAddress has validated IPv4/IPv6 address, port, family and
flowlabel state, getters, toJSON, inspect, static parse/isSocketAddress and
native cloning. URL-based parse canonicalization is distinct from isIP's
strict grammar. Predicates must match the actual target's handle-symbol
checks; do not invent stronger guarantees based only on a “brand” label.

BoundSocket synchronously reserves TCP or pipe endpoints, checks bind
conflicts, applies family/reuse flags, caches the real address and owns the
fd until adoption. Mixing path with TCP options fails. Address/fd/close
after adoption or closure throw ERR_SOCKET_HANDLE_ADOPTED; Symbol.dispose
is deliberately idempotent. Public Socket/Server adoption and TCP-only
worker/child movement transfer native ownership exactly once. Pipe
reservation paths and cleanup, numeric connect's synchronous local address
and deferred failure, in-use transfer refusal and rollback are required.
Its private deserializer re-derives state from the native handle instead
of trusting serialized fields. Candidate provides none of these routes.

**N-006:** BlockList's existing addAddress/addRange/addSubnet discard inputs
and check always returns false. Required behavior includes actual IPv4/IPv6/
mapped-address rules, CIDR parsing and bounds, batch validation, additions/
removals, clear, rules/size, textual rules JSON import/export, native clone,
inspection and the frozen eight-entry PRIVATE_RANGES array. Mutations must
affect the actual consumer's live rule set; a stored array unused by
connect/accept/UDP is not enforcement. fromJSON **adds parsed rules** in
the target source, not an invented atomic replace operation. A missing
rule removal is a valid target no-op, distinct from all mutators being inert.

Target BlockList native clone passes a shared_ptr to the same native
SocketAddressBlockList (`node_sockaddr.h`:450–457;
`node_sockaddr.cc`:1173–1178), rather than assuming a deep JSON copy.
Address/rule native lifetime, cross-thread synchronization and messaging
are shared prerequisites. None counts as supported merely because the
candidate BlockList constructor permits instanceof checks.

## DNS: lookup is not record resolution

The existing [lookup trace](network.md) follows guest getaddrinfo through
the musl override, private four-byte syscall and configured host resolver.
Native getaddrinfo blocks the calling guest JS thread before resolving a
Promise. The host's optional Node DNS callback uses an EAGAIN/cache retry
route, but does not move this guest work into a Node-style request pool.

The libc override recognizes numeric literals and localhost; otherwise it
can return one IPv4 address only. It rejects hostname AF_INET6, including
localhost with requested family 6, and bypasses ordinary guest hosts/search/
resolver name-source behavior. Numeric IPv6 and real kernel IPv6 loopback
are different paths, so “all IPv6 is unsupported” would be false. The host
resolver schema cannot carry multiple records, IPv6, TTL or other DNS data.

| Finding | Required contract and candidate disposition |
|---|---|
| N-001/N-004 | dns.resolve immediately invokes a callback with ['127.0.0.1'] for every name/type. This is fabricated DNS data. All real resolve*/reverse/lookupService/getServers/setServers and Resolver native-channel operations are missing, including promise counterparts. |
| N-002/N-003 | Lookup must honor genuine sources, family/all/hints/order, native errors and request scheduling. Candidate lookup has real validation/sorting/literal and libc paths, but literal callbacks use queueMicrotask instead of target nextTick, native work blocks JS and backend results are limited. |
| N-005 | Default-order getter/setter exist and callback/promises share them, but CLI/worker configuration and lookup/lookupService customPromisifyArgs metadata are missing. Public lookup target returns named address/family results under promisify. |
| N-016 | Candidate promise lookup wraps the callback API inside a Promise executor, changing validation and settlement. Target internal/dns/promises.js:196–250 performs many validations synchronously before creating its Promise; it accepts numeric family values while callback lookup additionally handles IPv4/IPv6 aliases. Candidate inherits callback aliases and turns synchronous validation throws into rejections. Literal promise settlement also takes an extra callback microtask. |
| N-017 | Error-code exports and most resolver controls are absent. Candidate's three lookup flags correctly use guest musl values 32/16/8; target flags derive from platform headers, so Darwin numeric capture values must not be copied blindly into a musl guest. dns.promises is a writable data property instead of the target lazy getter; its same object identity with dns/promises is a positive source fact. |

Record requirements are preserved individually: A/AAAA optional TTL records,
ANY's tagged per-type records, CAA critical/issue data, CNAME/NS/PTR names,
MX priorities/exchanges, NAPTR order/preference/flags/service/regexp/
replacement, SOA fields, SRV priority/weight/port/name, TLSA certUsage/selector/
match/ArrayBuffer data, and TXT arrays of record chunks. Reverse is a real
PTR query. lookupService is native getnameinfo's hostname/service mapping.
Neither is a synthetic transport address or a dns.lookup alias.

Callback and promise Resolver classes inherit cancel/getServers/setServers/
setLocalAddress from ResolverBase; their default own-property capture misses
those public methods. Each resolver owns an independent native c-ares
channel with timeout/tries/maxTimeout, local source addresses, server port
parsing, rollback on setServers errors and actual cancellation ECANCELLED.
Module default resolver rebinding and callback/promise default sharing
differ from per-instance state. Native error codes, byte/record shapes,
callback this/request and performance observation, snapshot/config lifetime,
validation throws versus async errors/rejections and cancellation ownership
must be real. There is no backend in the current guest providing them.

The 24 exported DNS error strings remain exact public constants, separate
from EAI/errno translation and lookup flags. Transient resolver/configuration
failures, NXDOMAIN, NODATA, cancellation and invalid input must not collapse
to fabricated answers or a generic successful empty array.

## UDP: missing public route and lower-layer gaps

**N-014:** dgram.Socket/createSocket are absent despite existing guest UDP
socket state, bind/connect/send/recv queues, multicast routing and
virtual/session network support. Required public behavior includes:

- udp4/udp6 construction and EventEmitter inheritance; options, custom DNS,
  abort, send/receive live BlockLists, reuseAddr/reusePort/family-only state,
  buffer sizes, listener callbacks and actual permission/error handling.
- Async bind/association and new synchronous bindSync/connectSync numeric
  overloads, ephemeral/local/remote addresses, state rollback and nextTick
  listening/connect events; async DNS, exclusive/cluster ownership and
  distinction between default UDP peer association and reachability.
- Actual datagram send/sendto, offsets/view byte spans, strings/scatter
  lists, connected/unconnected overloads, auto-bind, buffer retention until
  callback, queue bytes/counts, message/rinfo data and truncation/error
  behavior. UDP delivery is not reliable ordered byte-stream delivery.
- Broadcast, TTL, multicast interface/loop/TTL and source-specific group
  membership/drop with exact family/interface/port validation and native
  effects; receive/send buffer controls, refs, close/disposal and cleanup.

Target lib/dgram.js:437–480,514–606 implements synchronous local operations
while keeping delivery asynchronous; bind errors roll state back and are
thrown inline. lib/dgram.js:621–635 retains legacy sendto validation. The
native owner is UDPWrap/libuv, not a Transform stream or TCP watch relabel.

**N-021:** a future JS bridge alone cannot implement buffer controls.
`runtime-core/syscalls.rs`:14403–14436 stores SO_RCVBUF/SO_SNDBUF values,
but getsockopt at 14058 returns DEFAULT_PIPE_CAPACITY independently, and
udp_queue_datagram at 12612–12625 uses a fixed packet-count limit with an
explicitly advisory SO_RCVBUF. Correctly reporting/clamping and enforcing
real byte budgets belongs to the kernel/socket queue owner. Similarly TCP
backlog and actual option effects require their owning state/transport.
This is an implementation finding, not a demonstrated engine memory limit.

## Hosts, platform branches and unresolved questions

All four hosts share the guest facade, libc and kernel state. The optional
Node TcpNetworkBackend adds raw external TCP and IPv4 DNS; it still routes
external UDP through EgressLink, which returns EHOSTUNREACH. Browser default
egress maps synthetic addresses into HTTP/fetch/TLS transport, not general
raw TCP or DNS record queries. Virtual/session networks have independent
actual connection/listener/datagram state. IPv4 host callback schemas and
missing external IPv6 routes are implementation/configuration restrictions,
not an excuse to omit guest IPv6 loopback, numeric parsing or module APIs.

POSIX Unix paths are a missing JS/native bridge over existing kernel
AF_UNIX behavior. Windows named-pipe wire/handle behavior is a genuine
different-platform contract, not a requirement to spoof process.platform.
Linux abstract namespace and OS pathname limits, reusePort, multicast
interfaces and native flag integers require explicit guest capability and
platform decisions. Native Darwin/Linux controls must not mistake their
own platform constants or routing configuration for a universal value.
No blanket browser/non-V8 networking exclusion has been accepted.

**N-022 reference questions:** Resolver.setLocalAddress documents both
addresses as optional, while ResolverBase validates a required ipv4 string
before reaching native defaults. Dgram send prose broadly says an unbound
socket throws ERR_SOCKET_BAD_PORT, but target source auto-binds valid sends
with a supplied destination. BlockList.check's family fast path differs
from mutator validation, and fromJSON tolerates unmatched textual entries.
Keep exact native controls for these corners, rather than imposing an
invented universal validation/atomicity rule. Family-attempt timers are
created by both candidate and target; socket unref alone does not prove
that neither implementation has another referenced timer. Compare actual
owners before classifying that interaction as a candidate-only defect.

Other explicit later questions include native allocation/GC/callback
failure cleanup, stale I/O after fd reuse/reconnect, accepted socket paused
state, reentrant callbacks, listener close/relisten timing, true option/
backlog/admission effects, transfer rollback and configuration lifetime.
These are source/control limitations, not newly observed runtime failures
or established upstream engine bugs.

## Evidence and proposed later work

Historical full-suite reports retain their exact artifacts and outcomes;
3,687 common-helper failures per host precede most networking test bodies.
The current source adds a real API used by that helper, but it is unbuilt
and has no current four-host evidence. The earlier Firefox exit-fixture
timeout remains tied to its original launcher/artifact and unresolved;
the source review establishes neither its root cause nor a fix. See
[existing-evidence.md](existing-evidence.md) and the durable archive/index.

Dependency order: actual socket/queue/admission/error/ref/async and stream
lifetime; descriptor/address/reservation/transfer and live rules; truthful
OS lookup plus real record resolver channels; full TCP/server/UDP bridge,
option/control/permission metadata and per-host configured transport.
TLS/DTLS/QUIC, HTTP/fetch, IPC/cluster/workers and other core families inherit
these owners. Do not adapt individual npm/Claude callers or fabricate
resolver answers to satisfy their tests. No implementation is authorized.

`network-validation-candidates.json` preserves unchanged future tests and
helper/native fixtures, source identities and Flags/Env. It is not an
executable case/variant/assertion denominator or complete fixture closure.
After authorization, use exact-native controls for descriptors/aliases,
overloads/errors/phase/order, literal/custom resolver timing and records,
per-Resolver configuration/cancel/TTL/DNS errors, real TCP/IPC/UDP peers,
connect-attempt/address/family/abort/timeout/ref/reconnect, adoption/transfer/
fd reuse/EOF/half-close/reset, listener/backlog/drop/blocklist and actual
Nagle/keepalive/TOS/buffer/multicast effects. Exercise shared/local/session/
egress configurations separately on every host, plus genuine worker/child/
cluster and permission fixtures. Preserve N-022 disagreements and all
failures/skips/unsupported/timeouts/harness outcomes. No new control,
fixture, test, probe or build ran during this audit.
