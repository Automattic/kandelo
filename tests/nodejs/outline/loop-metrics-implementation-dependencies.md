# Actual guest event-loop measurements

Source124 implements the next partial O-019/O-020/O-021 dependency. Exact
Node26.13.0 target/source/native pins and the frozen audit are unchanged.
All19 families remain partial. No individual API/family/four-host closure
is established by this checkpoint.

## Real owner and unchanged calculation

`performance-clock.h::EventLoopClock` lives inline in each real ShellContext.
The owner records CLOCK_MONOTONIC loop entry and actual elapsed provider-wait
intervals,including live waits. It retains clock/state failures as errors;
no fixed statistics or host-browser performance object participates.
Only the owning loop thread accesses the state. It owns no heap allocation,
worker reference,timer keeper,shared buffer or additional memory ceiling.

Patch0104 marks entry when RunShellJobs actually starts,after its quit guard.
It brackets the existing usleep provider wait; synchronous JS/native work,
including blocking calls outside that wait,is active time rather than idle.
The worker path marks its own loop before executing worker bootstrap/source,
so workers do not inherit the main thread's pre-loop state. This follows the
reference's worker LOAD_SCRIPT callback versus main synchronous entry order;
it does not complete parent-side Worker.performance or all worker lifecycle.

The native snapshot returns actual absolute monotonic start,relative start
and accumulated idle milliseconds. Relative milestone conversion preserves
the target's floating-point operation order. The existing process hrtime
and native process origin share CLOCK_MONOTONIC. New private snapshot values
are copied ordinary numbers,with normal JSAPI allocation failure.

The complete unchanged `lib/internal/perf/event_loop_utilization.js` now
owns cumulative/one-/two-snapshot arithmetic,pre-loop zero state,coercion,
getter order and alias identity. Explicit process injection makes the factory
use the actual guest clock. nodeTiming.loopStart and idleTime consume the same
native measurements. Other milestones,counters and histograms still throw
until their real producers exist; no fake timestamps were filled in.

## Evidence

Exact report/source identities are in `loop-metrics-finding-progress.json`.

| Check | Result | Limit |
| --- | --- | --- |
| New candidate JS/native-dependency comparisons |6 pass|Function identity/descriptors,snapshot math/getter errors,live samples,blocking work and independent native Worker context;not guest hooks |
| Existing timeline controls |7 pass|Same native dependency boundary |
| Portable C++ owner |6 pass|Real monotonic clock,sleeps/busy work,stable entry,live/completed waits,independent owners and sticky errors;not guest clock/syscalls |
| Package/input controls |12 pass;615 inputs guarded|Source closure,not API support |
| Complete unchanged upstream ELU file |Native1pass,candidate1fail|Candidate fails nodeTiming JSON on missing nodeStart milestone before later checks;failure retained |
| Selected engine patch composition |85 touching patches compose|Two shell files extracted from hash-verified Mozilla archive;historical patches use exact recipe default fuzz,new0104zero-fuzz and exact reverse/forward restoration;not whole-engine compile/style |

The original source-check attempt demanded zero fuzz for all historical
patches and stopped at0026's short-context include hunk. Its log/reject/source
are retained. Corrected checking follows the production recipe's historical
patch policy while keeping the new patch zero-fuzz. No production patch or
upstream test/assertion was changed to obtain a passing result.

One portable helper compilation ran. No guest engine/package/kernel build,
overall suite or product rebuild ran. Guest117–124source remains uncompiled;
accepted116is stale. Engine integration,thread/realm/exit ordering and all four
hosts remain required. Measurement overhead and application performance were
not measured;this is no performance improvement claim.

## Remaining work and parallel ownership

Complete the remaining milestone/counter/histogram/GC/network producers and
NodeTiming JSON contract. The preserved upstream file cannot pass while these
are missing. Then use unchanged upstream files and actual identified guest
artifacts for main/worker/VM loop entry,idle/error/shutdown and alias behavior
on Node,Chromium,Firefox and WebKit. Pre-loop zeros are only legitimate before
actual loop entry,not a fallback for missing measurements.

Three agents now independently implement JWK,AsyncHook semantics and native
filesystem copying in detached private worktrees. These are pending work,
not source124support or conformance. Root serializes their integration,shared
generation,ledger updates,commits and heavy builds. The full product rebuild
deferral and existing cipher/SQLite/Error/compression/environment nonpasses
remain in force.
