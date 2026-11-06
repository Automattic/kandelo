# Native event-loop delay ownership

Checkpoint source139 replaces the unavailable monitorEventLoopDelay route with
the unchanged pinned public wrapper over real native histogram producers.
Interval sampling uses monotonic cached loop time and native due batches;
iteration sampling records the pinned prepare/check formula from actual loop
phases. No JS timer, fixed sample, simulated clock or callback fabricates data.
The integrated source is not current guest or four-host conformance evidence.

The native environment owns loop/producer registrations and closes them before
retiring async state. Monitors are unreferenced; pending closes retain only
required cleanup. Native state, handles, producers, loops, contexts and vector
capacities use existing retained allocation/claim accounting. Shared histogram
material remains one record across aliases and clone packets. Infrastructure
shared_ptr/ledger/allocator overhead is explicitly outside that byte scope.

GC transfers the state into an intrusive LIFO closing list without allocating.
A later native close phase retires it exactly once. This container property does
not claim the entire async destroy pipeline allocates nothing: existing
NativeAsyncState::Finalized can grow its numeric record vector and has separate
allocation-failure handling. The focused lifetime fixture uses a primitive async
state dependency, not that production vector. Material retrieved through a
checked wrapper is wrapped into the caller compartment. Coded error packets use
own-property definition, preserving inherited-setter poisoning behavior.

## Source integration and evidence

The original sealed producer and corrected lifetime/realm/error overlays are
integrated additively over source138. Future default-trigger and current clone
reconciliations are already included, not applied twice. Root engine patch0111
composes on the actual VM136 shell599f518… rather than overwriting it with135.
ProviderRotation dispatch is byte-identical; existing lock waits, idle brackets,
primary memory owners, VM flags/hooks, truthful target and HTTP framing survive.
Exact Node references match all seven complete files from the audited archive.
Current source closure covers685 inputs; bootstrap, bundle, declared staging,
unity generation and exact shell patch roundtrip pass. These are source checks,
not a SpiderMonkey C++ or JSAPI build.

Five standalone native compile commands build actual portable HDR/ELD/state
owners and the native-host NAPI dependency adapter. Eight pinned formula
comparisons,11 public option comparisons,two live sampling modes,four unref-only
exit processes,1536 state lifetimes,40 construction/publication fault positions
(17 allocation failures/23 successful positions),and three coded-error classes
pass. Real host libuv provides phases/handles for the live adapter; material
aliasing is not proof of production clone callbacks. Native artifacts/inputs
and scopes are identified in the ledger.

The affected source-only run initially had38 passes/one failure: a local test
still demanded that monitorEventLoopDelay was unsupported after its real native
dependency had been connected. That failure is retained. The local check now
asserts actual enable/disable/reset/dispose behavior; unavailable ELU/nodeStart/
uvMetrics expectations remain. The corrected run passes39 groups:25 affected
performance/loop/VM groups and14 package checks,zero skips. This is dependency
routing evidence, not candidate native-loop/GC acceptance. No upstream assertion
was changed. The initial staging-patch context failure is also preserved; root
reconciles around existing VM header/input additions instead of dropping them.

## Remaining work

Compile the combined engine and exercise actual JSAPI signatures, GC/compartment/
security/OOM paths, destruction/reentry, native sampling versus libuv phase and
clock-bucket alignment, worker/realm shutdown, clone transport/abort and memory
pressure on all four hosts. Kandelo's callback topology is not proven identical
to libuv by a formula comparison. Existing sanitizer and broader histogram/
performance audit nonpasses remain open; no API/family closure or accepted
platform boundary is declared.

Real stat polling will share the authoritative loop clock and liveness/deadline
owners without turning ELD's histogram registry into a general timer facade.
The actual backing-store bridge is separately sealed; TLS trust and lazy native
property work remain independent. All19 families remain partial. No external
ABI/wire schema, target/source/native pin, memory ceiling or accepted engine
artifact changed. Combined source117–139 remains uncompiled. Overall suites and
full product rebuilds remain deferred. Exact scopes and preserved nonpasses:
[event-loop-delay-finding-progress.json](event-loop-delay-finding-progress.json).
