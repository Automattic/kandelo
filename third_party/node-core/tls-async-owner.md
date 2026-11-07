# Native TLS async lifetime prerequisite

This is a source prerequisite for audited secure-network S-009, S-004 and S-008.
Those findings remain open. It does not establish full TLSWrap or TLSSocket
compatibility and does not activate graceful write shutdown.

The actual opaque TLS capability now owns one native TLSWRAP async identity,
the current default trigger, a captured async-context frame in a traced native
slot, and a retained native environment. Native resource inspection returns
that actual capability, ID and frame. The identity comes from the same owning
JSContext allocator and lifecycle provider used by other actual native owners;
neither a TCP ID nor a public socket alias is substituted.

Pinned Node's TLSWrap derives from AsyncWrap: its init publication precedes
SSL creation and underlying-stream listener attachment. Kandelo now publishes
the rooted native capability/state before allocating SSL and before committing
the real retained-parent attachment. All fallible getters, allocation and init
reentry precede the attachment recheck. Failure or reentrant close retires the
real state without leaving a usable partial SSL capability or replacing the
original pending exception. Context and parent roots remain genuine owners.

`tls::Owner::InitializeSsl` admits only a preparing owner with an actual context,
no existing SSL and no attached parent. It uses real `SSL_new` and cannot replace
an existing SSL or resurrect a closed owner. The existing read/write/connect
and close consumers use this same owner and capability; they do not get a
second synthetic lifetime.

Node's DestroySSL releases SSL but does not destroy AsyncWrap. Kandelo likewise
keeps the ID/frame for a retained closed capability. Only actual foreground
wrapper finalization queues the native destroy event and releases the retained
environment. Operation capability roots continue to prevent finalization while
actual native tickets exist. Environment shutdown closes producers/tickets
before context retirement; its detached native environment suppresses new JS
destroy delivery during final teardown.

## Evidence and remaining ownership

A tiny native addon compiled the actual portable owner header and passed nine
real OpenSSL allocation/admission assertions. Separate pinned Node controls
confirmed caller-trigger/ALS ownership at TLSWRAP init, stable identity after
close while the wrapper is retained, and destroy after release/collection.
These reference observations do not execute Kandelo's new JSAPI, native init,
frame slot, environment teardown, cross-realm or Worker/GC integration.

The current read/write delivery still uses its existing Promise bridge.
No before/after scope is added around Promise settlement to pretend that a
later stream callback has already executed. Genuine TLSWrap read/handshake
callback entry and WRITEWRAP/request frame/callback retirement remain work.
The opaque capability also lacks the full pinned TLSWrap/StreamBase prototype,
public wrapping behavior and Socket inheritance. Native init-close behavior,
errors and constructor-shape parity require actual guest validation.

Graceful write finalization remains blocked on a real SHUTDOWNWRAP transaction
rooting this TLS capability, using its actual trigger/frame, waiting for prior
write callback tickets, and driving direct-BIO close_notify through real
readiness/error/handshake states before genuine parent write shutdown. The raw
retained-transport EBUSY refusal, old destruction-time SSL_shutdown policy and
absent public TLS `_final` remain unchanged. Matching OpenSSL 3.5.9 sets SENT
before alert flush; return 0 completes local notification without requiring a
peer close. Neither flag-only completion nor a blind two-call substitution is
implemented. Full four-host compatibility is unvalidated.
