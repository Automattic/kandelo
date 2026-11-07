# Socket flush-before-destroy lifecycle

Socket.destroySoon now uses the complete unchanged pinned Node26.13.0
algorithm on the actual shared Socket prototype. It ends a writable socket,
destroys immediately only if writable finish already completed, otherwise
registers its actual destroy method for finish. It preserves dynamic public
method dispatch, return value, descriptor and repeated-call/idempotent close
behavior; it does not manufacture byte completion or close metadata.

The real no-native-owner _final branch now invokes the actual Writable final
callback without issuing shutdown(-1). This is the pinned no-handle completion
case. Owned, closed or connecting resources are not falsely declared shut down:
existing connected/deferred paths remain, including their remaining native
ShutdownWrap/descriptor-generation/async-error/fatal-scope requirements.

The shared Socket byte/state, original-allocation native writes and queued
owner close are existing real owners. New source is selected/hash-checked
from retained pinned net.js by the normal socket generator/installer. HTTP
client/server sources call destroySoon during teardown, but this slice does
not activate public server/HTTP2/TLS transports or claim all teardown parity.

Seven native differentials cover no-owner final callback/error identity,
public end, exact function descriptor, no-owner finish/close, real2MiB flushed
TCP writes before close, repeated close-once and already-finished destruction.
Explicit native TCP/WriteWrap/ShutdownWrap/VM/stream boundaries are supplied;
new guest JSAPI and four-host execution remain unrun. The original candidate
nonpasses remain preserved, and their missing-handle boundary assertion must
not be misreported as a guest errno. No new toolchain/engine/product build or
overall suite is run. This is a bounded N-010/N-015 source slice, not closure
of either full finding, Socket reuse, pending-connect, mixed writev or TLS.
