This is a real native allocation-owner primitive, not an installed BufferSource
binding. BackingStore prepares an actual pointer/capacity/deallocator without
consuming it, then commits ownership only after required metadata is ready.
Its callback frees/releases that actual allocation exactly once after the last
owning reference. Prepared-abort and allocation failures leave the caller's
original ownership intact.

BackingSpan retains that allocation and one immutable initial offset/length.
Later prefix writes and in-place zeroing affect its real bytes; changing or
replacing a JS view does not redirect the span. It never rereads JS entries,
constructs an earlier send snapshot, pins visible length or owns foreign JS
values. Existing native callers must not pass an unretained pointer as a lease.

JsBackingOwner represents an actual engine JS-buffer ownership reference. The
primitive uses the existing native-retained-memory Allocation/Record/Claim
service. Its own controller/owner/span objects are tracked; payload capacity
is native-ledger material only when committed and no JS-buffer owner remains.
Aliases keep one physical allocation record; actual owner and span claims use
the existing native environment account. Contextless retention remains native
pending ownership. There is no separate ledger/anchor or foreign-thread JSAPI.
The engine bridge must coordinate JS-cell accounting with these transitions;
the primitive alone does not establish that hook or real engine GC pressure.

Tracked sizes are requested payload capacity plus these native object bodies,
not RSS, allocator overhead, shared_ptr control blocks or the existing ledger's
own metadata. Release callbacks must be threadsafe, nonthrowing and unable to
enter JS or use a retired context. Allocation callback metadata is native data,
not a root/slot serialized as JavaScript metadata.

The standalone control compiles the actual primitive with the exact current
retained-memory header. It exercises actual malloc storage/free callbacks,
prepare/commit, six native allocation-failure rollback points, fixed span range,
real suffix-zeroing/prefix writes, alias and simulated owner-role handoff,
zero-account retention/re-adoption, eight live native threads through account
retirement and final release, and an empty allocation. Owner-role handoff in
this C++ control is not an engine structured-clone/transfer execution.

PENDING: acquisition from every accepted engine backing kind, inline promotion,
real nonshared/shared/Wasm/user-owned allocation lifetimes, detach/resize/
transfer/packet abort/free hooks, realm/account handoff, native-work/FS/codec/UDP
integration, actual JSAPI compilation, GC/reentry/teardown and four guest hosts.
See the separate verified owning-layer operation matrix and bridge proposal.
No existing BufferSource path is routed through this primitive yet, and no
accepted input kind is silently narrowed or labeled a completed safe subset.
