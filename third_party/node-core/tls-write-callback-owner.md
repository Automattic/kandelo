# TLS write callback retirement prerequisite

This source slice addresses part of audit `secure-network-contracts.md` S-009.
It does not implement TLS write shutdown or establish TLSSocket compatibility.

The SSL capability still owns its actual retained TCP parent and immutable
generation. Each submitted native write owns its copied bytes, actual Promise,
capability root and `tls::Owner::Request`. Settling that Promise is no longer
the end of the request: the actual `_write` or pre-connect write-queue consumer
acknowledges the same owner/Promise after its real stream callback returns.
The callback may throw or close the transport reentrantly; retirement remains
in a `finally`, and a secondary cleanup failure does not replace that throw.

A non-owning per-TLS intrusive write index is independent of dispatch-list
placement. It includes tickets temporarily unlinked for Promise publication
and tickets detached into an ordinary-close batch. Acknowledgment of such a
ticket marks it; its active native frame or close batch retires it. It never
deletes a raw ticket still owned by that frame. Settled writes remain genuine
requests and loop references until acknowledgment. Ordinary close preserves
queued callbacks; final environment teardown deletes tickets without creating
new callbacks or reactions. The actual capability continues to root its state
until the request and parent barriers retire.

If reaction admission fails, the consumer explicitly abandons the real write.
The owner destroys SSL before releasing bytes potentially retained for an
OpenSSL WANT retry. A synchronous native failure before returning its Promise
uses the same non-graceful retirement ordering. These are resource-failure
paths, not successful graceful shutdown.

## What remains before TLS write shutdown

The source pin remains Node 26.13.0, commit
`18b32a3b1552e199a01f1a8d9fd64aa756d3b75b`. Pinned `TLSWrap::DoShutdown` and
`EncOut` use memory BIO output, retained request state and underlying-stream
flush/callback ordering. The preceding callback slice used a direct socket BIO. The encrypted-output
prerequisite now binds a retained memory output BIO and actual captured-parent
transport receipts, keeping its input socket BIO exclusive to the same TCP
lease. This is not yet Node's complete memory-BIO/StreamBase listener owner.
Copying the pinned two-call `SSL_shutdown` sequence without the remaining
shutdown/request/callback owner would still be incorrect.

The matching OpenSSL 3.5.9 `ssl3_shutdown` sets SSL_SENT_SHUTDOWN before the
alert is flushed. WANT_WRITE must be retried against the actual retained
transport readiness. For the current memory output BIO, return 0 means the alert reached BIO
storage; real TCP acknowledgment is still required for wire completion. Another
call may wait for peer close via WANT_READ. A future write-half-close owner must
preserve this distinction, earlier-write callback barriers, exact parent and
generation, queued request/provider rooting, handshake/reentry deferral,
error-queue policy and cancellation before invoking the genuine parent
shutdown transaction. The existing one-attempt destruction-time shutdown,
retained-transport raw-shutdown refusal and absent public TLS `_final` remain
implementation gaps; this slice changes none of them.

The current TLS Promise bridge also delivers callback throws through a derived
Promise rejection rather than a genuine TLSWRAP/MakeCallback fatal path.
Original-span writes, full Socket/TLSWrap inheritance, request async-provider
parity, session/handshake shutdown barriers, Worker/realm/GC behavior and
four-host conformance remain unvalidated or incomplete.

## Evidence limits

The focused private control extracts the actual production helper and uses
genuine pinned native TLS writes, cancellation and close on loopback. Its
acknowledgment seam only records owner/Promise identity and callback ordering;
it does not execute the new C++ registry, PersistentRooted lifetimes, JSAPI or
guest libc/provider path. Five component groups pass. The normal bootstrap
generator and combined-source parser check are source evidence. No guest,
engine, dependency or product build was run for this slice.
