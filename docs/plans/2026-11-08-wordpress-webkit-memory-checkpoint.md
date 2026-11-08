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
