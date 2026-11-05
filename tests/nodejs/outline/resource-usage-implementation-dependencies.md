# Process usage algorithms, honest accounting gaps and engine GC budget

This partial process/engine/observability slice follows PROC resource/OS,
E-001 and diagnostic-report findings. The exact audited Node26.13.0 pin and
frozen audit remain unchanged. No public API/family is closed here.

## Source owners

Full unchanged cpuUsage/threadCpuUsage previous-value validation, repeated
getter reads, subtraction, typed-array storage, memoryUsage/rss and sixteen
resourceUsage field mappings are selected from pinned per_thread.js. Complete
reference/section hashes bind actual emitted source. The process object now
installs those algorithms after the real error/validator owner exists.

The guest numeric providers are missing. sys_getrusage currently fills zeros
at crates/runtime-core/src/syscalls.rs sys_getrusage; CPU clock mapping still
uses an elapsed-time approximation through host_clock_id/guest_clock_now.
Those values cannot provide truthful Node user/system CPU or RSS counters.
The frontend therefore explicitly raises ERR_METHOD_NOT_IMPLEMENTED after
its ordinary argument validation. memoryUsage.rss and resourceUsage are
visible missing implementations, not accepted exclusions or supported APIs.
No host-wide process metrics substitute for guest metrics. No kernel/libc/
clock semantics or wire ABI are changed by this slice.

process.report.getReport no longer invents a loaded musl pathname. Real
libc/glue/dlopen.c transactions do not yet provide complete process object/
report enumeration. The absent report provider now rejects explicitly.
v8.getHeapSpaceStatistics likewise rejects rather than claiming no spaces.
These are unresolved implementation gaps, not passing compatibility.

The existing partial getHeapStatistics object now reads its sole reported
heap_size_limit from actual JS_GetGCParameter(cx,JSGC_MAX_BYTES), through
native-vm.cpp, patch84 and the complete JS adapter. That is the current
nominal configured GC-things soft budget described in the pinned GCAPI.h;
it is not physical RSS, current heap use, reachable process allocation or a
complete V8 accounting equivalent. No limit/reservation changes. The other
required fields and exact cross-engine metric correspondence remain open.
The private actual measurement must not promote this partial object to a
claim of complete getHeapStatistics support.

## Evidence and boundaries

Five focused source controls use the actual factories and native Node26.13.0
CPU/thread/memory/RSS/resource providers as explicit dependency substitutions.
Three compare validation/errors/getter order, actual sampled-value subtraction
and exact field mapping. Two check explicit missing-provider/report/space
failures and actual adapter measurement forwarding. Gap assertions are not
feature conformance. Native accounting is not guest accounting.

.context/node26-resource-usage-controls-r1/output.log retains every outcome.
No kernel/guest numeric counter is validated by these controls. Source checks
and any targeted engine/guest outcome are recorded separately; no overall
suite or full product rebuild is run. All previous historical failures and
the frozen original audit remain intact.

## Remaining owner work

* Implement actual guest process/thread CPU user/system, lifetime and child
  accounting, maximum RSS/fault/I/O/signal/context-switch counters. Do not
  relabel elapsed time as CPU usage or zeros as measurements.
* Implement current guest residency and engine heap/external/ArrayBuffer/
  backing-store/shared-owner measurements and complete memoryUsage/rss.
* Complete engine heap statistics/space metadata and exact per-field meaning,
  including actual process/memory ceilings, worker/realm ownership, GC and
  allocator/error/permission behavior. Nominal GC budget alone is insufficient.
* Complete process reports, real loaded objects, heap/native/OS/handle/resource
  fields and serialization/file destinations; fabricated loader paths are gone.
* Complete feature/config/module-load metadata, worker contexts, CLI activation
  and individual original public obligations. No new host/engine exclusion.
* Later run unchanged CPU/memory/resource/report/heap upstream cases, native
  differentials and lifecycle/error/GC cases on four identified host artifacts.
  Preserve skips/unsupported/timeouts/errors and stamped product identity.

The breadth pass and full product rebuild deferral remain in force. Removing
wrong success is partial progress, not implementation of missing counters.

The normal targeted engine76 build succeeded in 240.0 seconds,
with all 626 selected frozen source inputs unchanged. Unchanged upstream
checks, optimization and fork instrumentation passed. Actual executable
artifacts/logs and reused pinned dependencies are in
.context/node26-engine-r76-accepted. This compiles the nominal GC-budget
read and usage source, not missing guest counters or complete APIs.

Targeted Node-host report .context/node26-resource-usage-guest-r1/report.json
records {"pass": 2, "fail": 0, "timeout": 0, "harness-error": 0}. The missing-provider case is an
explicit gap guard, and the budget case covers one nominal field only.
Default build-deps artifacts warn about missing ABI-contract stamps; ordinary
stamped SourceOnly consumer validation remains pending. These results are
not complete accounting, heap statistics, ABI or four-host conformance.
