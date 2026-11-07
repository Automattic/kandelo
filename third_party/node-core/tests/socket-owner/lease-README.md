# Accepted socket leases and keepalive reentry

The owned accept path resolves an opaque native lease token, not a numeric fd.
Both immediate and watched acceptance transfer the actual descriptor into it
before Promise resolution. The token has a null prototype, actual context/GC
retirement and native allocation accounting. Server drop/blocklist/getter/
constructor paths release it in finally. Adoption transfers that same Lease
into the native TCP Owner only after fallible initialization. If the later
_adoptFd property lookup or call throws, the native adoption-abort operation
closes the actual new Owner; it must not return an orphan numeric fd. Empty-token
cleanup cannot close an unrelated descriptor that reused the old number.
Existing numeric accept/adopt consumers retain their separate path.

Keepalive conversions precede the actual Owner::SetKeepAlive operation. That
operation reads the owner's current descriptor rather than carrying a numeric
fd across user coercion. Its ordinary OS option ordering/error policy remains
the existing backend policy. Direct coercible private-handle input hardening is
not a claim that Node publicly supports that private overload; pinned native
TCPWrap requires its delay to be Uint32.

`lease-owner-addon.cc` supplies a focused native component boundary around the
actual portable Lease/Owner header, real loopback acceptance, actual same-fd
reuse, native coercion and VM GC. `lease-controls.cjs` executes actual extracted
Server accept/adopt methods over that boundary and explicitly limited Socket
construction/publication/scheduling dependencies. It accepts an output directory
containing lease-owner.node and an optional source root (default out/candidate).
The addon is a test dependency, not an alternate product implementation.

`lease-adapter.cjs` checks verbatim adapter forwarding over a recording boundary.
The two native-reference scripts establish native accepted-handle ownership
before the constructor's getter and public keepalive delay-coercion ordering.

These focused controls do not compile or execute SpiderMonkey token classes,
native accept Promise/watch integration, moving GC, realms, context retirement,
actual guest OOM or four-host behavior. Actual JSAPI compilation and identified
artifact controls are still required. Listener/accept callback identity, legacy
watch concurrency, error/rejection behavior, complete socket prototypes and
other networking/HTTP gaps remain separate. No skipped/unsupported/unrun cases
become passing compatibility from these controls.
