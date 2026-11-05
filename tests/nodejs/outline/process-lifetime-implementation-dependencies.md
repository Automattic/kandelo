# Process finalization and Refable dispatch

Current integration checkpoint: the normal targeted engine96 build compiles
the source through95 with guest OpenSSL3.5.9; four focused Node-host
differential controls pass. Current source99 includes metadata97, sync whole-file98 and queued
promise write/append99 owners; these remain guest-uncompiled. Changed kernel/host
and complete four-host conformance remain outstanding. Recipe-stage
compilation statements below describe their historical checkpoints. See
[the current build and evidence record](engine96-integration.md).

PROC-010 now has source owners for the public finalization registry and
`process.ref`/`process.unref`. This is a partial process-family slice of the
breadth-first implementation. The exact audited Node 26.13.0 source/native
pin and the frozen audit are unchanged. No API or family is closed by this
record.

## Upstream code and actual owners

`process-lifetime-adapter.js` loads the full unchanged pinned
`lib/internal/process/finalization.js`. The generated bundle retains its
on-exit-leak-free MIT notice, selected unchanged from the pinned LICENSE.
The manifest binds the full module, complete origin files and exact selected
bootstrap/ref sections by SHA256.

The public lazy getter/setter, replaceability, descriptors and module cache
come from the exact `lib/internal/bootstrap/node.js` section. The exact
`per_thread.js` algorithms check the registered Refable symbol before the
legacy method, retain the receiver and propagate getter/callback exceptions.
Their return value is undefined; the resource method owns its actual
reference state. This does not repair remaining inert or absent resource
methods elsewhere in the platform.

The registry uses the shared captured primordials, real engine WeakRef and
FinalizationRegistry objects, and the actual guest process EventEmitter.
It retains weak references and callbacks, removes registrations through the
target cleanup algorithm, and invokes the callbacks on actual exit and
beforeExit events. It does not eagerly reject an invalid callback: the
unchanged target validates the object and fails when it later calls that
callback. GC timing is not replaced with predetermined cleanup.

The normal bootstrap installs the adapter after the shared validators and
errors exist. It applies to each guest process/worker bootstrap. The
SpiderMonkey shell drains actual FinalizationRegistry cleanup tasks in its
normal RunShellJobs loop. Engine88's real idle/revival hook supplies
`__kandeloNodeBeforeExit`; natural and explicit exit use the existing shared
`_runNaturalExit`/`__kandeloNodeFinalize` owners. No outer-host process events
or native reference measurements are used in the guest implementation.

## Focused evidence

`.context/node26-process-lifetime-native-r3/report.json` identifies the
generated bundle, source inputs, exact native Node binary and raw outputs.
Six paired public-program controls check descriptors/lazy replacement,
symbol/fallback/getter/receiver/error behavior, actual timer reference state,
validation/unregistration/listener retirement, natural idle revival,
explicit exit, and the deferred invalid-callback exception. The last program
actually fails with TypeError/exit1; its expected failure is retained rather
than treated as successful process execution. Explicit exit retains code9.

Two unchanged upstream files run separately over candidate JS/native owners
and native Node: `test-process-ref-unref.js` and
`test-process-finalization.mjs`. They contain respectively one and eight
tests, with no skips/cancellations/todos in these runs. The latter includes
actual forced-GC, child-process and independent worker-registry fixtures.
Out-of-band preload receipts bind the candidate bundle to the parent,
children and two native workers; fixture source and assertions are unchanged.
The earlier r1/r2 source inputs and reports remain retained separately.

The six public-program controls also run from the existing source-only
`host/test/node-process-state.test.ts` alongside its process-state controls.
That focused file passes nine tests: the six lifetime controls and three
existing state controls, with zero failures or skips. These overlap the
standalone controls; their counts must not be added together as new coverage.
These controls deliberately supply native Node process/events/GC/timers and
worker owners. They do not execute Kandelo's guest engine or kernel, and do
not establish behavior in Chromium, Firefox or WebKit.

## Remaining requirements

The current source recipe is revision89; the last accepted engine is88 and
does not contain this adapter. No engine/package compilation, overall suite
or full product rebuild is performed for this slice. Current guest lifetime
behavior, weak cleanup scheduling/teardown, worker separation and all four
host artifact identities still require validation through the normal path.

Complete rejection/fatal/monitor/capture policy, resource accounting,
permissions, signal/IPC handling, CLI/worker environment, and individual
resource ref/unref/close ownership remain separate implementation gaps.
The existing enabled SQLite module-load exception also remains unresolved;
none of these source/native controls reclassifies it or any historical
nonpass as passing compatibility.
