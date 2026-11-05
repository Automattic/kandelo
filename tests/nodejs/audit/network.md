# Network family source audit

State: **source review complete with implementation gaps**. This layer
trace and the [complete public contracts](network-contracts.md) reconcile
net/DNS/datagram source behavior; they do not certify runtime conformance.
No runtime tests, probes or builds were run. All current-candidate
conformance statuses remain pending.

## Public entry points and final owners

| Surface | Owning source | Source observation |
|---|---|---|
| net.Socket / net.Server | `packages/registry/node-compat/bootstrap.js`:4193–4827 | Custom classes inheriting pinned Duplex/EventEmitter; real native TCP operations |
| net.BlockList | Same file:4829–4838 | Mutators are no-ops; check always false; newer public APIs absent |
| net.SocketAddress / net.BoundSocket | No registry-object assignment or constructor in the final net namespace | Missing, including methods, adoption and transfer behavior |
| dns.lookup and result-order controls | Bootstrap:4123–4190 | Custom validation/order/delivery over native socketLookup |
| dns.resolve | Bootstrap:5809–5815 | Immediate fabricated loopback result, independent of query |
| dns/promises | Bootstrap:6014–6023 | lookup and result-order controls only |
| DNS Resolver, reverse, service and record methods | No final export assignments | Missing, including promise variants and cancellation |
| dgram | Absent from public builtin registry | Public module missing despite lower-layer datagram implementations |

The final registry and shared loader, not the presence of kernel code,
determine public reachability. The [exposure matrix](module-exposure.json)
records this separately from implementation quality.

## Actual layer trace

The build recipe at
`packages/registry/spidermonkey/build-spidermonkey.sh`:248–266 embeds the
shared bootstrap, SpiderMonkey adapter, generated core and Web-platform
sources in the guest executable. All four embedding hosts consume that
guest implementation; the host Node's builtin net/dns modules are not
automatically the guest's implementations.

### TCP bind/listen/accept

1. Public Server.listen validates/normalizes arguments, then calls native
   socketListen; Server._accept uses native socketAccept and adopts the
   returned descriptor into a Socket.
2. `packages/registry/spidermonkey/node-compat/adapter.js`:611–619 forwards
   those operations to the embedding bindings.
3. `0033-kandelo-node-tcp-listeners.patch` adds real socket, fcntl,
   setsockopt, bind, listen and accept calls plus poll-driven pending accept.
   The current frozen post-53 engine source contains these methods at
   `js/src/shell/js.cpp`:1298–1384.
4. The guest libc/syscall path reaches `crates/kernel/src/wasm_api.rs`
   and `crates/runtime-core/src/syscalls.rs`. Runtime-core owns actual
   bind/listen/accept state, shared listener queues and accepted fd/OFD
   allocation; see syscalls.rs:14537,14781,14937.
5. The host adapter routes optional external/session listeners through
   kernel callbacks and the configured NetworkIO backend. Kernel-local
   communication and externally reachable listeners must be reviewed
   separately; success of one does not prove the other.

Thus the old task's bind/listen/accept work is present as real source,
not an empty facade. Its completeness, all errors/lifetimes, and current
artifact behavior remain unverified. A comment still calling listening
servers incomplete is not evidence that these owning implementations
are absent.

The architecture document's older socket/syscalls location table points
at `crates/kernel/src`. Current owning implementations are in
`crates/runtime-core/src`; `crates/kernel` contains the Wasm-facing layer.
Use actual sources when following this trace.

### Hostname lookup

1. Public dns.lookup reaches `_nodeNative.socketLookup` through the
   adapter at 606.
2. Native `KandeloNativeSocketLookup` calls libc getaddrinfo on the calling
   JavaScript thread, then resolves a Promise. Returning a Promise does
   not move the blocking lookup off that thread. Current engine source:
   `js/src/shell/js.cpp`:887–934; originating network-attempts patch 0029.
3. `libc/musl-overlay/src/network/lookup_name.c` replaces musl's normal
   lookup implementation. It handles numeric literals and localhost,
   rejects external AF_INET6 hostname lookup, and obtains one four-byte
   IPv4 answer through the private getaddrinfo syscall. It does not perform
   the original musl hosts-file/DNS search here.
4. `crates/kernel/src/wasm_api.rs`:14626–14647 lends exactly four output
   bytes; `crates/runtime-core/src/syscalls.rs`:15668 forwards to HostIO.
   `host/src/kernel.ts`:5208–5240 validates/copies backend bytes and
   preserves EAGAIN for the kernel-worker retry path.
5. `host/src/types.ts`:344 defines NetworkIO.getaddrinfo as a four-byte
   IPv4 result. Node's optional TcpNetworkBackend uses host dns.lookup
   with family 4 and an EAGAIN cache; browser fetch/TLS backends map names
   to synthetic addresses for their HTTP transport; session networks
   resolve session names before falling back.

These are different configured name services. A synthetic transport
address can be legitimate internal routing state but is not an answer to
a public dns.resolve record query. The current resolver interface cannot
carry multiple IPv4/IPv6 records, TTLs or other DNS record structures.
That is an implementation/interface gap, not an intrinsic browser-engine
limit and not permission to fabricate answers.

## Concrete findings

| ID | Public requirement | Source finding | Owner / dependency |
|---|---|---|---|
| N-002 | dns.lookup asynchronous work and callback order | Lookup blocks the guest JS caller in native getaddrinfo; literal delivery uses queueMicrotask whereas pinned `lib/dns.js` uses process.nextTick. Promise-result delivery alone does not supply Node's request resource/ordering | Native lookup scheduling; nextTick; DNS request resource metadata |
| N-003 | lookup family/all/hints and OS name sources | Lower interface returns one IPv4 result; external family 6 rejected; override bypasses normal musl name-source processing | libc override, private syscall schema, NetworkIO/backend resolver |
| N-004 | dns Resolver/record/service/reverse APIs and promises | Resolver, resolve4/6/Any/Caa/Cname/Mx/Naptr/Ns/Ptr/Soa/Srv/Tlsa/Txt, reverse, lookupService, getServers/setServers absent. Top-level resolve still fabricates a loopback result | Real resolver backend, record/error/cancellation model and instance ownership |
| N-005 | dns default result order and promisification | Setter/getter and local sorting exist. Initial order is hard-coded verbatim; CLI/worker inheritance and util.promisify multi-result metadata are not wired by this implementation | CLI, workers and shared promisify metadata; exact descriptor/error review pending |
| N-006 | BlockList rule storage, matching and public serialization | Existing addAddress/addRange/addSubnet discard input and check returns false. addAddresses/addCIDR/addCIDRs/clear/fromJSON/isBlockList/PRIVATE_RANGES/removers/rules/size/toJSON absent | Real IP/subnet rules, validation, constructor/instance/static descriptors |
| N-007 | SocketAddress and BoundSocket | Both classes absent. BoundSocket requires synchronous reservation, single ownership adoption, correct post-adoption errors, cleanup, transfer and disposal | Native descriptor ownership, IPC/worker transfer, address parsing |
| N-008 | Socket.setNoDelay/setKeepAlive and construction options | Methods return this with no native call. Native public adapter has no corresponding socket control functions; option-level behavior is incomplete | JS → native → actual socket state/backend control |
| N-009 | Actual TCP option effects | Kernel setsockopt stores TCP_NODELAY and keepalive parameters in SocketInfo; inspected host NetworkIO has no corresponding control members. Stored/read-back values do not establish transport effects | runtime-core socket options plus host transport; investigate actual local/egress effects before claims |
| N-010 | Socket statistics, controls and instance state | bytesRead/bytesWritten, bufferSize/readyState/pending, destroySoon/resetAndDestroy and TOS getters/setters are not implemented by SocketCore. Inherited Duplex methods do not supply socket-specific accounting | Actual native byte/error/connection state, reset/control and descriptors |
| N-011 | Server listen overloads and options | path/fd/blockList explicitly reject. BoundSocket/handle adoption, cluster sharing and many constructor options are not implemented. server[Symbol.asyncDispose] absent | Unix endpoints already exist below JS; descriptor/worker ownership; stream/event lifecycle |
| N-012 | Backlog and host registration failure handling | Runtime-core sys_listen_impl takes `_backlog` without using the supplied limit and discards host_net_listen return values. This requires a queue-limit/host error audit, not a claim of a validated failure | Shared backlog table and host callback registration/rollback |
| N-013 | Async hooks and connection-resource ownership | Native socket watches retain promises/fds but do not create the Node TCP/DNS request/handle resource model. Generic Promise hooks do not prove the expected provider identities and callback lifecycle | Native async-resource owners, context, destroy queues and exit/ref/fork behavior |
| N-014 | dgram | No public module entry even though runtime-core and virtual/session networking implement UDP state, bind and datagram queues | JS/native UDP API plus existing kernel/host backend paths |

Bootstrap references for N-005–N-011: DNS 4123–4190 and 6014–6023;
Socket 4450–4676; Server 4679–4800; public classes 4803–4838.
N-009 uses runtime-core syscalls.rs:14403–14507 and socket.rs:774–791.
N-012 uses syscalls.rs:14803–14901. N-013 uses the native socket-watch
structure and dispatch at engine js.cpp:793–825,1072–1193.

The earlier N-001 finding covers fabricated public resolve results.
Descriptions here distinguish confirmed source paths from behavior that
still needs runtime evidence. Reconnect after stream destruction,
pauseOnConnect/read start, listener cancellation, native EINTR handling,
async-hook exception paths and reentrant accept callbacks remain explicit
source-review obligations, not assumed correct.

## Four-host and transport boundaries

| Host/configuration | Traced source behavior | Audit classification |
|---|---|---|
| All four guest runtimes | Shared net/DNS bootstrap/native binding and guest libc/kernel paths | Shared implementation gaps; current runtime evidence pending |
| Node with enableTcpNetwork | `host/src/node-kernel-worker-entry.ts`:952–966 selects TcpNetworkBackend; host net.Socket TCP and host IPv4 dns.lookup | Configured host capability, not automatic guest Node API coverage |
| Chromium / Firefox / WebKit browser egress | `host/src/browser-kernel-worker-entry.ts`:871–882 creates TlsNetworkBackend; backend terminates guest TLS 1.2 and performs HTTP(S) via browser fetch/proxy | Current backend's transport restriction; no blanket exclusion of TCP/DNS APIs |
| Virtual/session networking | VirtualNetworkBackend / SessionNetwork maintain actual private-network connections/listeners/datagrams and session name resolution | Shared configured networking, distinct from external internet reachability |
| Default internet egress UDP | EgressLink.sendDatagram returns EHOSTUNREACH; local/session UDP has different paths | Concrete configured transport restriction; public dgram remains missing independently |

Browser transport restriction references:
`host/src/networking/tls-network-backend.ts`:1–14;
`host/src/networking/fetch-backend.ts`:248–255;
`host/src/networking/egress-link.ts`:1–51. Session/virtual sources:
`remote-segment-runtime.ts`:58–199, `virtual-network.ts`:623–651.

No browser-specific engine defect is established here. In particular,
the historical Firefox exit-fixture timeout must retain its original
artifact/launcher identity and unresolved status; these source findings
do not establish that timeout's root cause or a fix.

## Proposed later evidence, not authorized to execute

The existing selections `../selections/net-dns.json`,
`network-call-sites.json` and `socket-timeouts.json` identify candidate
unchanged tests, but filename membership does not establish full coverage.
Additional public Node 26 address/rules/adoption/transfer tests and
datagram coverage need applicability and fixture review.

Native comparisons should independently observe API descriptors/errors,
literal nextTick ordering, deterministic name/record replies, real option
effects, queue saturation, descriptor adoption, accepted peer addresses,
half-close/reset, ref/unref exit and transfer rollback. Use controlled
peers and matching network configuration rather than unstable public DNS
or arbitrary internet reachability as the expected outcome. Distinguish
kernel-local, session and egress paths on each host.

The completed public-contract review reconciles all 503 original discovery
obligations: 223 documentation sections and 280 saved descriptors, plus
inherited Resolver methods, lazy address/rule classes and returned/transfer/
metadata requirements. It adds N-015 socket reuse/fd/end ownership, N-016
promise DNS validation/settlement differences, N-017 namespace/descriptors/
platform flags, N-018 accepted-server options/pause/control gaps, N-019
actual family-attempt/default contracts, N-020 native I/O error and callback
scopes, N-021 real kernel buffer semantics and N-022 target questions.

`network-requirements.json` preserves exact source/capture identities.
The future catalog identifies 535 unchanged source files, including
helpers/fixtures, not executed cases or a completed fixture/variant closure.
The source audit remains separate from the unbuilt candidate's missing
four-host evidence. All proposed controls remain unrun and require later
authorization.
