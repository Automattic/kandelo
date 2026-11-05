# Address/rule ownership and remaining dependencies

N-006/007/011/018 have new source owners, without individual API, family or
four-host closure. The exact Node 26.13.0 pin and frozen audit are unchanged.

Full unchanged blocklist.js/socketaddress.js provide the public algorithms.
The getter-only class exports are selected unchanged from net.js and remain
getters after reads; Stream aliases the actual Socket constructor.
address-rules.h owns real address bytes, ports, interface scopes, flow labels,
mapped-address matching, ranges, prefix tries, rules and read/write locks.
It uses the pinned native hash header and unchanged libuv parser bodies.
Native libc accepted a leading-zero spelling that the target parser rejects;
the corrected owner uses libuv grammar. No external runtime bug is claimed.

native-address-rules.cpp stages owned native handles with shared-pointer
retirement and checked realm unwrapping. Patch 73/recipe 60 declare and copy
the owner, parser and hash inputs. The JSAPI bridge remains uncompiled.
Socket checks consume live rules before outbound transport; Server checks
the actual accepted peer and closes blocked fds before publication.
Constructor validation, later rule mutation and distinct single/multiple
attempt event/error behavior are retained. No kernel ABI is changed.

Six final controls pass: five portable native owner scenarios and one public
frontend/native-handle scenario. They include raw rule output, mapped IPs,
ranges/removals, prefix pruning/restoration and 128 additions/checks across
four native threads. The native oracle supplies single-thread final-set
semantics; this is not guest threading or worker transport evidence.

Three unchanged upstream files pass per candidate/native mode: test-blocklist,
test-net-blocklist and test-net-server-blocklist. That harness uses native
Node handles/engine/TCP/streams and replaces the public address/rule classes.
Its Socket/Server classes are native. Separate affected source controls
exercise the candidate consumers: 30 passed with one descriptor-fixture
failure; the corrected control then passed alone, with 17 unselected tests
skipped. An earlier pre-descriptor run passed all 31. Repetitions and skips
are not additional passing APIs or combined guest conformance.

Retained failures include the initial libc grammar mismatch; seven initial
network fixture failures (unstarted operation and overly broad timer-source
selector); three upstream preload errors from assigning getter-only exports;
and an ESM-versus-CommonJS descriptor-reference error. The namespace was
corrected using the exact pinned getters. Assertions and upstream files were
not weakened. Raw reports, logs and selected inputs are retained in .context.

Native handles explicitly reject cloning until the serializer retains and
reconstitutes their real shared state. Public clone hooks alone do not
provide that owner; cloning/messaging remain implementation gaps. Remaining
work includes guest compilation, GC/realm/association/allocation accounting,
actual interface scopes, native prototype/error edges, socket/fd/ref/cancel
lifecycle, BoundSocket/reservation/transfer and datagram/QUIC consumers.
Pinned flow-label fatal checks are staged but guest fatal behavior is unrun.
Full DNS/Resolver, Socket/Server controls, HTTP/TLS and other findings remain.
These are not accepted engine/platform exclusions.

The initial failing native executable is retained. Intermediate passing
executables were overwritten by a later helper rebuild; their hashes/logs
and selected sources remain historical evidence with that limitation. The
final executable and selected inputs are retained; no complete compiler or
guest artifact closure is claimed. Overall suites/full rebuild stay deferred.
