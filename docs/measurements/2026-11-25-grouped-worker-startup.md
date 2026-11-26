# Grouped Worker startup consolidation, 2026-11-25

The baseline is `72e4005fed1ed815d0778b8dfcd2979752aa4793`, the `develop`
merge of #1756. The candidate runtime is `d459b95e8da628d0fb35ffb622a961689290f8bf`.
Both use program ABI 56, host adapter 40 and the read-only group scanner.
The [scanner receipt](2026-11-25-shared-memory-scanner.md) reports a different
comparison between earlier scalar and scanner implementations.

## Ownership reduction

Root, fork, exec and pthread launch now share one implementation of native
construction, readiness observation and memory delivery. The deferred handle
holds the actual Worker. One pending preparation binds its envelope to the
readiness observation and releases both on delivery or reference disposal.
This removes four adapter-local Worker references, duplicate startup and
cleanup branches, and one host validation and copy of the launch expectation
per Worker. The kernel effects, Worker messages and native observations remain
separate across the same lifetime boundaries. Delivery consumes the envelope
once and requires the started backing Worker.

The [preview contract](../shared-memory-groups.md#authority-and-admission)
maps the state owners. Fork must still copy private frames and commit the
saved continuation. A pthread shares the image and owns a distinct control
slot. Exec retains the old and future images around one PID. These facts
require different transactions even when all four use the same Worker
adapter. A later retirement change could investigate the session's duplicate
tracking of pthread retirement and the predecessor Worker list during exec.
It would need to preserve concurrent shutdown, pending effects and failed
retirement custody.

## Validation

- The declared development shell ran 111 native memory-group tests, the ABI
  snapshot and resolver checks, 1,432 host ownership checks across 60 files,
  seven browser memory message-boundary checks, the Rust-first host boundary
  audit, the host build and browser app typecheck.
- The normal kernel-only build published kernel SHA-256
  `ebd54419f573b2ea077964437d5ace3ee6bf0fcbe98106f8bf9a865dc15b79e8`
  and image module SHA-256
  `9eec9d694b6328d424751f122b65c9d7221b1b0d501a1026297f76acf7a012d3`.
  Against that projection, 30 Node root-launch and actual-kernel cases passed.
  Four more Node cases covered shared-file offsets and descriptor coherence,
  threaded exec, native-wait exit and forty cohorts retiring into one backing.
  Thirty-six public Node cases covered byte and VFS launch, executable
  identity, graphics mappings, admission and shutdown. Nine frozen executable
  cases passed against the manifest hashes.
- Forty-eight real SDK browser checks passed across Chromium, Firefox and
  WebKit. Each engine exercised eleven root rollback/shutdown cases,
  pthread fork, descriptor writes with shared-file offsets, threaded exec and
  native-wait exit including forty cohorts. WebKit desktop support remains
  experimental.
- Ten normal app cases passed on the partial shell, five each on Chromium
  and Firefox. They covered Sway input and file persistence, grouped Sway
  activation from an ordinary shell, Cage/Foot input and retirement, Freeciv
  quit and relaunch, and static ScummVM gameplay and native quit.

## Matched Node ownership comparison

Both revisions used the same published kernel and image module. Each passed
24 public grouped root launches with child wait status and reaping assertions.
Each also passed the ordinary pthread comparison and recorded 256 grouped
pthread retirements with exact stop and retirement assertions. The final 128
samples had zero quarantined replicas and pending wait drains in both arms.

| Last 128 grouped pthread samples | Develop | Candidate |
| --- | ---: | ---: |
| Images | 1 | 1 |
| Replicas | 1–2 | 1 |
| Allocated pages | 162–168 | 158–162 |
| Physical extent pages | 170 | 164 |

These are copied kernel counters in one run per revision. They establish a
stable extent during this workload. Scheduling and concurrent retirements can
change the sampled page counts. The sample is a bounded ownership check, with
causal attribution and overall footprint outside its scope.

## Matched Chromium desktop response

Both worktrees used the same normal partial shell, kernel and lazy package
projection. The image SHA-256 was
`121a4c744a3dae121d0b992505adbf98106cbe2858a1aa5160a9ad031f07c872`.
The build selected Cage, Foot, Sway, Swaybg, SFWBar, Freeciv browser bundle,
static ScummVM, curl, unzip, sysklogd, desktop-data and Bibata. Its activities
were Shell, Freeciv, Cage, Sway and Sway/SFWBar. Static ScummVM launches from
the desktop shell.

Chromium 153 ran two Sway sessions per revision in
develop–candidate–candidate–develop order, using the normal Vite app at
1600×1000. Each run opened and closed six Foot terminals and moved focus 30
times. Terminal timings end at an observed rendered prompt. Focus timings
use the trusted pointer event and an observed canvas frame. Machine
load varied across runs and the canonical product build ran concurrently.
[Raw timings and counters](2026-11-25-grouped-worker-startup-samples.json).

| Measurement | Develop | Candidate |
| --- | ---: | ---: |
| Terminal open median | 1,171 ms | 1,235 ms |
| Terminal close median | 241 ms | 249 ms |
| Terminal focus median | 79.69 ms | 82.24 ms |
| Terminal focus p95 | 119.31 ms | 119.38 ms |

The candidate's median open took 64 ms longer in this sample. Its median close
and focus also took longer, with nearly equal focus p95. This small comparison
under competing load leaves the cause of the timing differences unresolved.
Each run returned to 11 tasks and nine images after terminal churn, with zero
quarantined replicas and pending wait drains. Live page count returned to
within five pages of its starting count in every run. Physical extent grew
in both revisions while the pool retained reusable capacity.

## Retained failures

The first partial build refused a changed package registry snapshot. A retry
passed publication of the index. The first Node and browser SDK runs started
before the source-only projection was finalized and hit missing authority.
The broad Node attempt also hit its fixture-build timeout under competing load.
The later targeted runs used the separate normally published kernel projection.
A first scratch desktop benchmark started Vite in the scratch directory and
failed navigation in every arm. Setting the app working directory let all
four arms complete.
A native test attempt used the default Wasm target. The native-target retry
required missing frozen fixtures, which were provisioned and compared with the
pinned digests. Wasmtime smoke stopped at the existing three-argument native
`host_proc_validate_range` binding. The pinned kernel requires four arguments,
and the corresponding kernel and native host sources are identical on both
revisions.
