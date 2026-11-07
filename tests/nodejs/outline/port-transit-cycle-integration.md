# Automatic native MessagePort transit-cycle retirement

Source197 composes actual native graph/bridge ownership over transfer194, keeping
signature jobs195 and TLS policy196. Audited pins and ABI55 remain unchanged.

The graph models real owning slots: native public port bindings and opaque packet
boxes; Worker startup/input/error/endpoint fields; queue-pop/creation/read scopes;
actual receiver inbox-to-packet, packet-to-data and clone-data-to-endpoint edges.
Weak peer links are send admission only. A retained sender must not permanently
root an unreachable peer inbox. No use_count or inferred JS liveness is used.

One process-shared barrier protects intrusive graph metadata/publication. Marking
fences unreachable nodes as Retiring before dropping the barrier. Native payloads
retire outside graph/channel locks, and late admission cannot resurrect them.
GC finalizers release actual slots and mark dirty; they do not collect or call JS.
Every real Node loop turn visits collection even if unrelated timers/I/O would
short-circuit the idle-reference check. Context shutdown releases actual local
slots and fences an already-active collector batch before its own snapshot.

The process-lifetime weak metadata sentinel outlives static BroadcastRegistry
owner slots; it is not a permanent payload root. Executions never yielding to
an actual collection safe point have no prompt collection guarantee. Blocking
Worker I/O is not made quiescent by a collector fence.

## Scoped evidence

Nine actual portable production-header groups pass, including unreachable six-node
cycles while sender handles remain rooted, external packet/worker/read authority,
no-allocation cleanup, native retirement outside locks, late resurrection,100
publication races and shutdown drain. The unchanged queue delivers1000ordered
packets. Two deliberate mutants (omitted retirement, ignored roots) abort under
the same assertions; those aborts are rejection observations, not compatibility
passes. Root reused the exact final artifacts and verified current header bytes.

Eleven earlier tiny compiles (10success/1assert-macro harness failure) are integrated,
not repeated. Historical changing-header attempts remain historical; no complete
uncaptured compiler-system dependency closure is claimed. Earlier source input
and metadata setup failures remain. Final complete staging/pinned syntax/unchanged
Mozilla checker and865-input accounting pass. Fourteen package checks and11port
wrappers pass. Their genuine native Node component does not exercise production
SpiderMonkey ownership/GC/realm/fatal/teardown. Root0new compiles; guest/fourhost0.

## Remaining

Production JSAPI compile and identified-artifact GC/realm/OOM/fatal/async/worker/
shutdown evidence across all four hosts remain required. Generic JS host/stream/
AbortSignal/FileHandle transfers and complete Worker lifecycle remain incomplete.
All transfer foundation failures and the native-only graph getter re-transfer
abort134 stay preserved; no runtime defect/exclusion follows from that observation.
No finding/family closes. Accepted173is stale; overall suites and full product
rebuild remain deferred. Nested guest Wasm execution remains in scope at the end.
