# WordPress/Caddy WebKit memory checkpoint

This is a development-artifact diagnostic, not final canonical acceptance
or a PHP-FPM performance comparison. It passes the maintained browser-host
test with real Caddy, FrankenPHP classic PHP execution, and WordPress entirely
inside Kandelo. PHP's upstream optimizer remains unchanged.

The normal revision-45 partial image is `9cbbb185ced4` (83,506,932 bytes),
the ABI-55 kernel is `6f5afada9ae3`, and Caddy is `cfdba6545bd4`.
The consumer is `2cabd2984735`, with identical selected kernel/Go artifacts
verified before execution. The full canonical image is still building.

## Method and result

Playwright WebKit revision 2359 reports version 26.6 on macOS 27.2
(26B123). The test selects two PHP threads and exercises HTTP login/editor
requests, parallel editor bursts, request churn, a 120-second traffic phase,
four real SIGKILL/restart cycles, and graceful shutdown while a PHP request
is held until the listener closes. Both 96- and 768-condition optimizer
probes pass twice at PHP's default optimization level. This is HTTP-level
validation; the separate rendered UI/persistence gate remains intermittent.

Job `wordpress-current-native-attribution-1107-230923-1640` passes in
5m50s (the browser selection takes 4.7 minutes). The traffic phase pauses
for synchronized guest and native observations, so its request count is
not a throughput result. A separate canonical Clang build runs concurrently.
No forced host collection or additional engine flags are used.

The native observer binds the WebContent PID through this test browser's
launchd domain, rather than selecting processes by a global name. It keeps
OS footprint, inspector categories, guest pages, Go metrics, PHP allocator
counters, module-cache statistics and direct-worker events separate.
Two two-second native stack samples are retained above 5 GiB. The producer
pauses during those samples; they are not allocation-site profiles.

## Measurements

OS values below are rounded strings reported by `vmmap`. These are
different, overlapping accounting views and must not be added together.

| Phase | WebContent physical footprint | Go Sys | Caddy linear memory |
| --- | ---: | ---: | ---: |
| Before artifact loading | 15.9 MiB | — | — |
| Kernel initialized | 1.2 GiB | — | — |
| Service ready | 3.2 GiB | — | 80.7 MiB |
| First WordPress response | 4.6 GiB | 40.2 MiB | 650.2 MiB |
| Traffic sample at 128 requests | 10.5 GiB | 41.9 MiB | 685.9 MiB |
| Fourth crash recovery | 2.6 GiB | 40.7 MiB | 644 MiB |
| Machine destroyed | 2.4 GiB | — | — |
| Same page, 60 seconds after destruction | 647.1 MiB | — | — |

The OS-reported peak reaches 10.6 GiB. Kernel linear memory stays at
187.5 MiB during requests. During the large traffic growth, the module
cache compilation count stays at six and Caddy linear memory stays at
685.9 MiB. This does not measure per-instance engine costs or exclude lazy
engine compilation. The direct kernel worker terminates; its inspector
count goes from one to zero. That count excludes nested process/pthread
workers and cannot establish their total independently.

Inspector category maxima are approximately 10.4 GiB for `page`,
583 MiB for `javascript`, and 74.7 MiB for `jit`. They occur at different
times, are broad engine categories, and are not a disjoint physical-memory
breakdown. In particular, `page` does not identify an allocation owner.

## Interpretation and remaining work

Go's reported tens of MiB do not describe the browser's multi-GiB footprint;
`GOMEMLIMIT` cannot serve as a whole-service budget. PHP allocations,
guest linear memories and engine allocations need their own accounting.
The post-destroy fall demonstrates partial physical reclamation in this
run. The remaining 647 MiB and the earlier peaks do not establish either a
leak or acceptable steady-state budgets.

Next isolate compilation, instantiation and worker costs using controlled
module experiments, and sample allocation activity while traffic grows.
Preserve Go's collector and ordinary application algorithms. Complete the
broader memory-switch/lifecycle gate, all final UI/persistence cases and
quiet paired PHP-FPM/visitor comparisons on the final normal artifacts.

Raw evidence is retained in the comparison checkout under
`.context/agent-jobs/wordpress-current-native-attribution-1107-230923-1640/scratch/native-memory/`:
`artifacts.json`, `phase-summary.json`, `native-memory.jsonl`, `native-stacks/`
and `reports/`. The original phase records are under browser run
`f2925dd0-66ed-4549-8f63-0d9fda229181`. Prior failures and later final-cohort
checks remain separate results.

## Server and PHP-thread controls

Job `wordpress-native-control-matrix-1108-000416-647f` passes both
additional selections serially on the same verified partial image, kernel
and consumer source. The classic selection takes 3.6 minutes and the
one-PHP-thread Caddy selection takes 5.0 minutes. Both use the same HTTP
login/editor workload, optimizer probes, request bursts, 120-second traffic
phase, held-request drain and 60-second post-destroy observation. Only the
Caddy selection includes the four crash recoveries. These instrumented
runs are not throughput comparisons or isolated module-cost measurements.

| Selection | Service ready | First HTTP response | Largest phase footprint | 60 seconds after destroy |
| --- | ---: | ---: | ---: | ---: |
| Classic, two configured PHP threads | 1.8 GiB | 2.4 GiB | 2.8 GiB | 976.8 MiB |
| Caddy, one PHP thread | 3.2 GiB | 4.4 GiB | 13.8 GiB | 668.3 MiB |
| Earlier Caddy, two PHP threads | 3.2 GiB | 4.6 GiB | 10.6 GiB | 647.1 MiB |

These are rounded physical-footprint samples, not simultaneous measurements
across selections. The separate OS historical-peak fields reach 2.9 GiB
for classic and 14.3 GiB for one-thread Caddy, above their largest sampled
current footprints. The classic traffic samples stay between 2.3 and 2.7 GiB
with 665.9 MiB of process linear memory. Caddy's one-thread traffic samples
reach 13.8 GiB, then fall naturally to 4.8 GiB before shutdown while its
linear memory remains 646 MiB. No forced collection is used. The Caddy
thread endpoint and metrics report one actual PHP thread throughout the
observations; Go Sys stays between 40.7 and 42.4 MiB. Classic has no Caddy
metrics endpoint, so no equivalent Go/PHP allocator measurement is claimed.

At Caddy's 13.8 GiB sample, `vmmap` classifies 4.8 GiB as resident and
7.5 GiB as `SWAPPED` in `WebKit Malloc`; `JS VM Reservations` has 551 MiB
resident and 1.3 GiB `SWAPPED`. The process footprint is consequently not
a claim that 13.8 GiB is currently resident RAM. These broad allocation
classes still do not identify retained objects or allocation sites.

Reducing PHP capacity to one thread therefore does not remove the large
native peak. This directs the next investigation toward the Caddy workload,
compiled module/instance costs and host reference lifetimes, rather than
assuming that PHP thread count alone explains it. The two server modules
have different sizes and code paths; their difference does not isolate a
particular dependency or prove an engine defect. Classic also retains more
physical footprint after destruction in this observation despite its smaller
peak. Neither selection establishes an acceptable service memory budget.

Raw results and derived `phase-summary.json` files are under the matrix
job's `scratch/native-classic-two/` and `scratch/native-caddy-one/` directories
in the comparison checkout. The original phase records are in browser runs
`2bd7017e-7048-46f1-b7d1-d126c05f71f9` and
`2e070d06-9db9-4c55-a069-1b12611fadba`. Each direct kernel-worker observation
ends with termination; it does not count nested guest workers.

## Compilation and module-sharing control

Job `wasm-module-cost-webkit-v2-1108-003348-aba9` passes two WebKit
diagnostics in 2m29s using the exact 184,971,404-byte Caddy module
`cfdba6545bd4`. It asynchronously compiles the real module, verifies its
import/export interface in one and then eight workers, terminates those
workers, drops the parent references and observes the same page for sixty
seconds. It never instantiates the module, executes Go/PHP, creates guest
memory or forces collection. Each selection gets its own content PID.

| Phase | Compiled module only | Compiled module plus retained source-byte copies |
| --- | ---: | ---: |
| Empty page | 15.5 MiB | 15.5 MiB |
| Source bytes loaded | 193.8 MiB | 191.8 MiB |
| Module compiled | 1.2 GiB | 1.3 GiB |
| Source detached in parent | 868.5 MiB | Kept for cloning |
| Retained by eight workers | 708.8 MiB | 2.6 GiB |
| Workers terminated and parent source detached | 701 MiB | 2.2 GiB |
| Same page sixty seconds later | 682.3 MiB | 2.1 GiB |

Compilation and module retention therefore have a substantial fixed native
cost before guest execution. Sharing this one module with eight workers
does not multiply the observed footprint by eight. The second control also
intentionally retains an ordinary source-buffer clone in each worker until
termination; it measures a different ownership policy. Neither control is
an allocation census, a pure per-worker subtraction, an instantiation
measurement or proof of a leak. Natural collection occurs between phases.

The explicit worker-detachment control
`wasm-module-cost-detached-bytes-1108-003900-d1f9` also passes. Its browser
selection takes 69.7 seconds; the job's 9m29s includes waiting for the
rendered upload suite. Each worker acknowledges that its source buffer is
detached while retaining the compiled module. At eight workers the current
footprint is 889.5 MiB (the parent still holds the source), then 883.1 MiB
after termination and parent detachment, and 685.4 MiB sixty seconds later.
Its OS historical peak is 1.4 GiB. This is another single observation, not
a statistical equivalence claim about the two smaller retained footprints.

The current production pthread path already detaches its source-byte copy
after initialization when the host supports `ArrayBuffer.transfer`. Do not
treat the intentionally retained copies as a description of that steady
state, or remove bytes needed by reflection, ABI validation and fork
identity. These results validate that cleanup policy rather than introduce
a new production fix. Instantiation and live request costs remain separate
investigations. The live request sampling results below remain separate
from the earlier phase-bound samples that paused the producer.

The first private attempt `af44` fails at discovery because its `expect`
import resolves a second Playwright installation from the repository root.
The successful attempt imports through the browser app's shared fixture.
This is a test setup correction, not an engine defect. Raw evidence and
`phase-summary.json` are under the comparison checkout's successful job
`scratch/module-cost/`; the browser run is
`1fb5c2a1-3c8f-4aa9-85a1-1004e4d3ac99`. The private source is retained with
the job rather than inferred from a later edited probe.
The detachment control's independent source, reports and derived phase
summary are retained under its own job directory.

## Live request stack samples and browser identity

Job `wordpress-live-native-stack-attribution-1108-004045-8b6f` passes the
same two-PHP-thread HTTP/lifecycle selection. Its 12m28s total includes
waiting for the preceding browser controls; the browser selection takes
4.7 minutes. WordPress requests, unchanged optimizer probes, four crash
recoveries and held-request draining pass. The OS historical peak reaches
10.5 GiB, with 10.0 GiB at the largest selected traffic sample. Caddy's
linear memory stays 685.9 MiB through the traffic samples, Go Sys ranges
from 40.2 to 42.4 MiB and the endpoint consistently reports two PHP threads.
After destruction, the same page reaches 624.9 MiB at sixty seconds.

Two two-second native CPU samples start from inspector memory events,
rather than from an awaited phase callback. The request producer does not
await the observer's PID resolution or stack sampling. Their
sample headers report 6.2 and 8.4 GiB of physical footprint. Both include
active `JSCWarmUp` allocation stacks through `bmalloc`; some Wasm compiler
activity is also present. These stack names and CPU observations do not
identify the sizes or lifetimes of allocations responsible for the peak,
or establish an engine defect.

Full timestamp alignment matters: the first sample overlaps no recorded
guest/native measurement interval, while the second overlaps the
`soak requests: 14` phase. The observer's boolean says no phase is active
at that second sample's finish, which does not prove no phase occurred
during it. Preserve the start/finish records and compare complete intervals;
do not treat both samples as uninterrupted producer observations.

Raw phases, native observations, stack files and source identities are in
the comparison checkout's job `scratch/live-native-memory/`. The private
driver and observer are retained there with their hashes and modification
times after completion; they had not changed since execution.

Job `webkit-declared-bundle-identity-v2-1108-010211-7405` installs WebKit
into an isolated browser cache using the browser app's declared Playwright
1.63.0. JavaScriptCore, WebCore and WebKit framework bytes exactly match
the tested shared revision-2359 installation. This verifies the installed
artifact identities, not upstream source mapping or an engine diagnosis.
The first check `d43a` fails before downloading because package exports
exclude direct `playwright-core/browsers.json` imports; resolving its
filesystem path corrects that private metadata check. The original
failure and successful framework hash report remain separate evidence.

The next allocation investigation must locate live allocation owners and
separate instantiation, engine compilation and host reference lifetimes.
Any proposed outside-runtime defect still needs a standalone self-judging
reproduction without Kandelo before it can be treated as confirmed. No
browser flags, Go collector changes or PHP/Caddy adaptations are adopted.

## Fixed-count traffic controls

Job `wordpress-three-traffic-memory-controls-1108-011750-179b` passes all
three serial WebKit selections in 9m58s. Each fresh browser uses the same
verified image/kernel/Go artifacts above, two actual PHP threads and the
same initial WordPress login/editor, optimizer probes, bursts and churn.
Only the subsequent traffic target changes: WordPress, a tiny PHP response
or a static file. Each completes exactly 120 requests with a minimum
500 ms start-to-start cadence. Slow requests and observations extend that
cadence; the producer never catches up with bursts. Every selection then
passes one real Caddy crash recovery and held-request graceful shutdown,
with sixty seconds of post-destroy observation. No collection is forced.

| Traffic target | Before traffic | Selected traffic footprint | Whole-run OS peak | 60 seconds after destroy |
| --- | ---: | ---: | ---: | ---: |
| WordPress | 5.2 GiB | 5.1–7.3 GiB | 8.1 GiB | 851.6 MiB |
| Tiny PHP | 5.3 GiB | 5.2–5.3 GiB | 5.7 GiB | 911.1 MiB |
| Static | 5.1 GiB | 5.1 GiB | 5.7 GiB | 856.7 MiB |

The WordPress traffic sample reaches 7.3 GiB at request 119; its later
8.1 GiB historical peak includes the remaining lifecycle phases and cannot
be assigned entirely to traffic. All traffic samples retain 685.9 MiB of
Caddy linear memory, six module compilations and two actual PHP threads.
Go Sys stays within approximately 40–42 MiB. These single observations
suggest investigating WordPress execution beyond fixed module/thread counts;
they do not isolate an allocation owner or a particular engine defect.
Response sizes, elapsed times and collection timing differ, and a canonical
build runs concurrently. Do not subtract these values as pure PHP or
WordPress allocation costs or treat them as throughput comparisons.

The maintained HTTP/lifecycle fixture accepts
`KANDELO_FRANKENPHP_SOAK_REQUESTS=120`,
`KANDELO_FRANKENPHP_SOAK_PACE_MS=500`, and
`KANDELO_FRANKENPHP_SOAK_WORKLOAD=wordpress|php-scalar|static`.
Request counts and duration mode are mutually exclusive. It checks exact
bodies for the two small controls and retains the original WordPress
response check. Its `traffic-workload` attachment records the actual count,
cadence and instrumented duration. The existing duration mode separately
passes classic and combined Caddy on Chromium in job `8598`: two passes,
zero skips/retries, 53.3 seconds of browser time.

Raw phases, native observations, workload attachments, fixture snapshot and
source diff are retained in the review checkout under the `179b` job's
`scratch/traffic-controls/{wordpress,php-scalar,static}/` directories.
The duration-mode report is under job
`wordpress-timed-traffic-mode-1108-013351-8598/scratch/timed-mode/wordpress/reports/`.

## Direct kernel-worker CPU traces

Job `wordpress-kernel-cpu-profiles-1108-013219-afe1` passes the same
fixed-count WordPress/lifecycle selection with read-only ScriptProfiler
tracking on the owned direct kernel worker. Two roughly ten-second windows
retain 2,261 and 2,180 sampled stacks. The observer records inspector and
receipt start/stop timestamps. Profiling may affect timing and memory;
this run is separate from the unprofiled controls above. Nested Go/PHP
process and pthread VMs are outside this profile's scope.

The observed leaf is the first frame, checked against the actual chain from
`flush` through syscall handling, Wasm, the clock import and byte access.
The corrected `kernel-1-summary-v2.json` and `kernel-2-summary-v2.json`
supersede the opposite-order initial summaries, which remain retained as
failed analysis. Common observed leaves include atomic notification,
kernel export dispatch, message posting and memory-view operations. This
does not establish a dominant allocation owner or justify changing those
operations. CPU samples do not measure allocated bytes or retained objects.

Many trace timestamps are zero and cannot be assigned to precise request
phases. Profile start/stop receipts establish bounded windows without
inventing alignment for those samples. Source locations refer to the
Vite-transformed JavaScript, not the same line in the original TypeScript.
Raw events, traces and corrected summaries are retained under this job's
`scratch/kernel-cpu/wordpress/cpu-profiles/` directory in the review checkout.

## Module function-index ownership pilot

Separate host candidate `0f7e14b77` reuses the module-lifetime function
identity index across fork transactions instead of rebuilding a second
index each time. It changes shared host bookkeeping, without compiler,
Go/PHP/plugin patches or ABI changes. The candidate remains on a separate
branch and is not adopted into PR #1492.

Job `b633` passes one serial baseline/candidate WebKit pair in 10m53s,
using the same hash-verified revision-45 partial artifacts, two actual PHP
threads, 120 validated WordPress requests with a minimum 500 ms cadence,
crash recovery, held-request drain and 60-second post-destroy observation.
The baseline and candidate retain the same 685.9 MiB Caddy linear memory,
six module compilations and roughly 40.7 MiB Go Sys during traffic.

| Observation | Baseline | Index-reuse candidate |
|---|---:|---:|
| OS whole-run peak footprint | 9.9 GiB | 11.0 GiB |
| Selected footprint before traffic | 4.8 GiB | 4.8 GiB |
| Footprint 60 seconds after destroy | 888.9 MiB | 709.3 MiB |

This single instrumented pair, overlapping normal build work, establishes
no peak-memory improvement, throughput result, leak fix or allocation
owner. Lower post-destroy footprint does not establish a general benefit.
RSS remains much higher than footprint after destruction, reinforcing
that those counters cannot be substituted for one another. The candidate
also passes 32 focused source checks and both real Node Go/PHP consumer
checks; those do not substitute for full conformance or benchmarks.
Raw artifacts, source identities and the phase summary are under the
candidate checkout's
`.context/agent-jobs/wordpress-function-catalog-native-pilot-1108-032711-b633/scratch/catalog-native-pilot/`,
including `paired-observations.json`. No engine defect is claimed.

## Bulk-table snapshot control: unadopted

Isolated host candidate `1946258ab` snapshots the immutable function
catalog through a small standard-Wasm table-copy helper, deferring the
JavaScript reverse index until an encode actually needs it. A follow-up
adds imported-host-callback tests without changing the measured runtime.
It stays outside PR #1492; the independently demonstrated failed-registration
atomicity bug is fixed separately in `853fed804`.

Job `wordpress-table-snapshot-native-pair-1108-051429-049a` passes both
serial cases in 7m50s, using the same retained normal full WordPress45
image `1993e1bc29ef`, ABI55 kernel `6f5afada9ae3`, Caddy `cfdba6545bd4`
and two PHP threads. Each side validates 120 requests at a minimum 500 ms
cadence, crash recovery, held-request drain and destruction. A normal full
build runs concurrently; this is one instrumented diagnostic pair, not an
alternating throughput benchmark or a repeatable improvement.

| Observation | Baseline `8902ccfe9` | Table-snapshot candidate |
|---|---:|---:|
| OS whole-run peak footprint | 14.3 GiB | 11.7 GiB |
| Footprint at traffic request 10 | 10.6 GiB | 10.6 GiB |
| Footprint 60 seconds after destroy | 778.0 MiB | 675.2 MiB |
| WebKit Malloc dirty at service-ready | 2.7 GiB | 2.7 GiB |
| WebKit Malloc dirty at traffic request 10 | 10.6 GiB | 9.9 GiB |
| Active inspector JavaScript category at service-ready | 562.7 MiB | 562.7 MiB |
| Active inspector JavaScript category at traffic request 10 | 7.6 MiB | 8.0 MiB |
| Active inspector page category at traffic request 10 | 10890.9 MiB | 10416.7 MiB |

`WebKit Malloc` is an OS allocation-region label, not an allocation owner.
It includes backing/engine allocations; these observations do not prove
which buffers, worker or engine subsystem holds the growth. Neither the
small JavaScript category nor six normal module-cache compilations
establishes total engine or instance cost. The candidate's helper modules,
temporary instances and private tables are outside that cache counter.
Inspector measurements must use the latest navigation session; the
superseded initial about:blank target reports unrelated small values.
These counters overlap and must not be added together.

The similar startup footprint and continuing traffic growth give no basis
for adopting the extra helper as the solution. Next attribution should
identify backing allocations and worker/instance costs before adding more
catalog machinery. No engine defect, leak fix, resource-budget pass or
physical reclamation guarantee is claimed. Raw reports and phase summaries
remain in the candidate checkout's job directory above and
`.context/table-snapshot-{native-summary,allocation-region-observation}.json`.


## Current normal49 artifacts and tooling limits

Job `wordpress49-current-host-memory-three-en-1108-074107-d6b0` passes six
maintained HTTP/traffic/memory cases with frozen source `95cd1dd17092` and
normal WordPress49 partial image `107912d3f8b8`, kernel `7e2593cdb90a`,
classic `380ff5931ad3` and Caddy `b0f2985aef0c`. Browser execution takes
17 minutes; the 36m30s job includes queueing. Both services pass on Chromium,
Firefox and WebKit without retries or skips, with 120 validated requests
per case, a minimum 500 ms cadence, editor churn/bursts/parallel requests,
four Caddy crash recoveries, held-PHP draining and cooperative teardown.
The unchanged 96/768-condition optimizer checks pass twice in every case.
The same page stays alive for sixty seconds after each machine is destroyed.

The new diagnostic also records `/proc/<pid>/maps` and host storage-admission
metadata. Canonical compilation runs concurrently; this is not an
uninstrumented throughput comparison or a repeatable memory improvement.
Native heap inspection adds further pauses to the classic selection.

| Current WebKit observation | Classic | Caddy |
| --- | ---: | ---: |
| Largest selected OS footprint | 6.0 GiB | 5.0 GiB |
| OS whole-run peak footprint | 7.4 GiB | 5.2 GiB |
| Footprint sixty seconds after destroy | 827.2 MiB | 584.3 MiB |
| Linear backing during traffic | 687,865,856 bytes | 719,257,600 bytes |
| Go Sys during captured Caddy phases | unavailable | 42,663,936–43,712,512 bytes |
| Host storage-admission metadata peak | 99,326 bytes | 99,326 bytes |

Each selection has its own verified WebContent PID (31417 and 50571).
OS values are rounded `vmmap` output. These counters overlap and must not
be added. Seven or eight cumulative module compilations occur during
traffic. The image also includes the new minute-based cron client as a
normal guest consumer. This counter is not a count of live instances or all engine
allocations. The kernel's mapped-byte sum and host-recorded linear backing
also describe different things.

The new maps capture exposes a guest accounting limit: procfs `VmSize` is
hard-coded to zero, while `kernel_enum_procs.vsize_bytes` is explicitly the
sum of mmap-region sizes. Neither is whole-process physical memory. This
report uses the separately labelled host `memoryBytes` for linear backing;
it does not fix guest procfs accounting or infer native residency from maps.

Three read-only `/usr/bin/heap` inventories exit zero but warn that they
cannot examine the WebKit Malloc zone because canonical-path resolution
for its JavaScriptCore image fails. That framework exists as a regular
42,552,576-byte file. The inventories cover only ordinary malloc zones,
not the allocations responsible for the multi-GiB WebKit region. All three
belong to classic PID31417; the observer's per-runner three-snapshot limit
was exhausted before Caddy. No Caddy heap-inventory coverage is claimed.
A missing framework, custom shared-cache image, or engine defect is not
established by the tool's warning.

A separate test-owned five-second Xcode Allocations control never reaches
recording. The initial dev-shell attempt cannot locate `xctrace`; the
explicit installed-Xcode successor waits in `XRAuthorizationCreateWithPrivileges`
and `AuthorizationCopyRights`, as shown by its retained native sample.
Only that exact owned profiler is terminated after its graceful stop does
not finish. No macOS authorization is granted or bypassed. The incomplete
trace and logs remain evidence of the diagnostic boundary, not allocations.
Other validation continues; allocation ownership and budgets remain open.

Raw current results, artifact identities, native observations and the
selected-field summary are in `wordpress-cron-normal` under the job's
`scratch/`: `artifacts.json`, `native-memory.jsonl`,
`current-memory-summary.json`, `heap-*.txt`, `heap-inventory-limitations.json`
and `reports/`. The original per-case observations are in browser run
`3652519d-d613-46a8-86a1-da02efd318f9`. Primary `.context/` retains the
`allocation-profiler-*20261108*` control source, logs, stack and partial trace.
