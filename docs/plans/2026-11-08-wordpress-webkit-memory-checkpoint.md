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
