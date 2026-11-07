These source corrections are a separate delta from the sealed fourteen-file
Node26.13.0 datagram foundation. The target and unchanged public/internal
JavaScript and native references retain their original hashes.

Receive Buffer materialization uses captured typed-array intrinsic accessors.
Native dispatch resolves onmessage/oncomplete before entering its actual
callback scope, skips noncallables, and roots that resolved value across hooks.
The private receive converter takes the resolved callback as an argument,
so a before-hook cannot redirect lookup. A property getter exception precedes
before/after hooks; a user callback exception remains visible to the existing
native callback/checkpoint policy. Empty datagrams and negative receive errno
packets preserve their distinct paths.

Queued error/cancellation completions report the original message size,
including zero-byte messages. The directly owned queued copy and its native
record are charged to their actual rooted request until completion/checkpoint,
init failure, cancellation or context shutdown destroys the record. This
credit covers vector capacity, not merely length. It does not claim registry
or deque allocator accounting, cross-thread packet accounting or observed
SpiderMonkey GC pressure.

Scoped IPv6 link-local text uses the actual interface name returned for the
stored scope ID; unscoped/global/loopback names do not acquire a suffix.
Unknown scope resolution fails rather than forging an interface identifier.
The native error text is truthful, but exact Node UVException branding and
onerror delivery for formatting/allocation failures remain unvalidated.

The queued-send source still copies bytes before native:init. Actual pinned
Node captures original view spans and retains their storage instead. Live
view leases, including shared/growable and resizable backing-store ownership,
remain incomplete; the existing stricter native-work Pin is not a compatible
replacement for the accepted UDP BufferSource surface. No source fallback
silently rejects those previously accepted inputs. A stricter-Pin/sendmsg
prototype is retained separately in review evidence and excluded from the
source delta. No native-work or engine ownership source is changed here.

Default-trigger override ownership is another independent foundation. A
temporary override must not live in a captured async-context frame. The
rejected frame-property prototype is not a complete default-trigger fix;
AsyncResource, TickObject and native allocators require one separately owned
native accessor with nested restoration before UDP integration is complete.

Controls cover the actual JS converter, the exact portable endpoint and
scope formatter, and the actual queued storage class with instrumented JSAPI
root/accounting calls. Exact Node controls establish named callback order,
queued completion size and init mutation baselines. These do not compile the
SpiderMonkey fragment, prove GC/realm/shutdown conformance or validate guest
Node/Chromium/Firefox/WebKit. N-014, current N-021, IPv6 memberships and raw
external UDP remain open. The separate kernel budget proposal still requires
an explicit program ABI transition and its normal artifacts/validation.
