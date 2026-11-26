# Shared-memory scanner and landing receipt — 2026-11-25

## Scope and implementation

This first iteration supports Chromium and Firefox for opt-in Cage, Sway and
Sway/SFWBar desktops with mutually trusting, compatible programs. WebKit is
experimental. Fixed-size in-memory shared objects support descriptor writes
and mapping offsets. Growth/truncation, persistent writable sharing and mixed
graphical clients remain follow-ups.

Each group retains one shared `WebAssembly.Memory`. A read-only Rust/Wasm
scanner instance imports that backing inside the disposable kernel Worker.
It replaces individual host calls when traversing sparse page tables. The
actual Rust kernel still owns locking, validation, allocation, mappings and
retirement. The helper has no separate memory, Worker, allocator or lifecycle.
The generated helper is checked for read-only instructions. Host adapter 40
is required; program ABI 56 and the frozen program contract are unchanged.

The scanner was developed at `f419eb8a688ebb9eb5570588d4cb3e9d37a4914b`
above retirement checkpoint `8b47c44cdda74c228ab53fea7578519770bd633f`.
Those retirement changes were already included in PR #1756. Only the scanner
was imported. The initial landing source incorporates develop
`8cd1a440f7ae173990383c1483eec77b030822eb`; conflict resolution preserves
both SDK visibility and response-file handling, both Worker import sets,
the upstream Node package selection and the shared-desktop shell selection.
No full package or canonical-gallery rebuild is claimed.

## Bounded Chromium Sway comparison

[Raw latency samples and summary](2026-11-25-shared-memory-scanner-samples.json).

The unprofiled ABBA run compared the qualified scalar implementation with the
scanner prototype using two Vite development servers and the same partial shell
and graphical programs. Each arm performed 12 terminal opens/closes and 60
focus transitions at a 1600×1000 viewport and 1600×892 scanout. Timing includes
frame/screenshot observation; it is not hardware input-to-photon latency.
The machine was not isolated. The normal producer rebuilt kernel and image
modules; the image-module bytes also differed. These numbers describe the
prototype comparison, not a new benchmark of the rebased landing source.

| Measurement | Scalar | Scanner |
| --- | ---: | ---: |
| Terminal open median | 1618 ms | 1188.5 ms |
| Terminal close median | 327.5 ms | 254 ms |
| Border-focus median | 66.68 ms | 48.75 ms |
| Border-focus p95 | 197.94 ms | 116.08 ms |

A separate instrumented run reduced typical munmap scalar reads from about
186,652 to a median 6,428. That run overlapped correctness checks and supports
call-count evidence only. Isolated Node and three-engine scan checks passed;
JavaScript batching was faster than the Wasm helper in Firefox's microbenchmark.
No universal Wasm performance advantage is claimed.

The earlier [ordinary-versus-grouped comparison](2026-11-25-shared-memory-first-iteration.md)
reported extra CPU and footprint costs. This scanner comparison does not
replace that measurement or establish a platform-wide memory/CPU saving.
The complete Node/browser benchmark comparison against develop remains unrun.

## Prototype validation and retained failures

The scanner prototype passed 111 native memory-group tests, nine resource
checks, complete app typechecking, ABI/helper/resolver checks, four real SDK
Node cases and twelve SDK browser cases across Chromium, Firefox and WebKit.
Those SDK cases cover ordinary/grouped mapping, descriptor writes/offsets and
pthread/fork execution. Frozen executable checks passed without restamping.
The ownership suite initially passed 1,424 of 1,425 checks: its source audit
rejected the undeclared helper instance. An exact reviewed allowance and
read-only generator checks corrected that failure; the 38 affected ownership,
frozen-executable and actual-kernel checks then passed. Seven browser-memory
boundary source checks passed.

Chromium and Firefox each passed twelve same-page Cage/Sway/SFWBar desktop
replacements with visible input, terminal creation/close, guest exit and
memory-boundary assertions. WebKit completed eleven replacements, then failed
the final live Sway→Sway/SFWBar transition: graceful kernel-worker detach timed
out after 30 seconds, and persistent storage quiescence was unconfirmed. The
computer remained locked instead of reusing storage without retirement proof.

The unchanged pre-scanner baseline reproduced that same final retirement
failure. An earlier baseline control instead failed input proof after a fork
replay cancellation with errno 5. Neither failure is erased by earlier passing
sequences. The underlying cause remains unresolved; no browser-engine defect
is asserted. This supersedes the support claim in the historical
[WebKit qualification](2026-11-25-shared-memory-webkit-qualification.md).
Its existing 512 MiB group preallocation workaround remains a resource cost.
Native Safari and iOS remain untested.

## Landing validation

The landing kernel was built through the normal product producer from the
rebased source; SHA-256:
`d129e56d8813ed1a3545f875a9d05424f1be4ee50c73b8af0ea0ded44beb3b8f`.
The current host includes integration correction `0db41b6ccf`: ordinary thread
batch shutdown settles a pending initialization promise without claiming a
Worker or memory-retirement fence. Eight cancellation controls time out
against the uncorrected entries; 80 focused checks pass with the correction.
Three duplicate ownership-audit declarations were removed, and the actual-entry
harness now observes launch and real readiness events.

Validation reuses the partial image and compatible programs below. The normal
kernel build refreshed the copied SDK cores and generated modules. It did not
rebuild all packages or the canonical shell. New kernel publication removed
stale package authority from its projection, so the first desktop attempt
received a missing Bash body and correctly failed image size/SHA validation.
For the bounded runtime check, a private Vite configuration proxies lazy-body
requests to the existing frozen SourceOnly server, while the new server's normal
resolver supplies the current kernel/image modules. Served Bash bytes were
verified identical. No artifact digest, image manifest, cache key or production
resolver was overridden. This validates current runtime with preserved package
inputs, not a newly built current-develop package closure.

| Check | Result |
| --- | --- |
| Native runtime-core, compiler driver and shared-memory instrumenter | 4,248 pass, including 4,095 runtime-core tests |
| ABI, frozen contract metadata, generated scanner and resolver | Pass; adapter 39, program ABI 56 unchanged |
| Complete browser app typecheck | Pass, 148 browser roots and 47 Node test roots |
| Actual-kernel, frozen executable and public Node host selection | 64 pass; the 45 frozen/public-host cases also pass after the thread-readiness integration correction; frozen executable bytes unchanged |
| Additional real SDK Node selection | 12 pass; mapping, shared file, pthread/fork/churn, exec with threads, forced/native-wait exit and growth; includes forty-cohort retirement cases |
| Real SDK browser selection | 12 pass across Chromium, Firefox and WebKit: ordinary/grouped mapping, shared-file and pthread/fork |
| Host ownership and lifecycle source suite | 1,439 pass across sixty files after integration corrections |
| Browser-memory protocol/probe source checks | Seven pass |
| Normal partial-app desktops, Chromium and Firefox | Ten cases pass: twelve same-page replacements per engine, Foot, Freeciv quit/relaunch, file persistence and shell-to-Sway activation |
| ScummVM, Chromium and Firefox | Two cases pass with the current kernel identity: gameplay, physical movement, native quit/status and process cleanup |

The initial desktop run passed ten cases and failed the two ScummVM kernel-identity guards before gameplay: the test process expected the old prototype kernel while the browser correctly served the new one. Selecting the current projection for the test process corrected the expected identity; both ScummVM cases then passed unchanged. The other ten cases and their runtime/artifacts were unchanged.

Initial setup failures, the source-audit/harness failures, interrupted invalid
artifact runs and the red cancellation controls remain retained. One server
startup hit disk exhaustion and lost its supervisor result; after completed
Rust runs, unused native incremental data was removed from this work's scratch
build cache. Package caches and existing demos were preserved. A missing
generated image catalog and an incorrect Playwright working directory were
also corrected before the successful checks.

## Final integration with kernel-owned epoll

Develop advanced to `0248e5c48176b222b036cd6589e872a6abf55968` during
landing. The final integration preserves its Rust-owned epoll waits and removes
the obsolete host epoll loop. Epoll output-range checks now request write
access through the group's translated-memory contract. Program ABI remains
56; host adapter 40 combines the scanner and epoll contracts.

The runtime source is `6a058e06d97f`; later commits only correct test fixtures
and documentation before consolidating the landing commit. The normal producer
built kernel SHA-256
`4b9ef5d08e0c341fc780eaa038c3dbdf6306f4e59d4d04d75b09803769808e95`.
The partial image, lazy-package routing and build-scope limitations above still
apply. No package closure or performance comparison was rebuilt for this
integration.

| Final integration check | Result |
| --- | --- |
| Native runtime-core | 4,097 unit tests, one policy-inspection test and six compile-fail checks pass |
| ABI, frozen contract metadata, scanner generator and resolver | Pass; program 56, adapter 40 |
| Complete app typecheck | Pass after the browser fixture correction |
| Actual-kernel, frozen executable, public Node and park teardown selection | 88 pass |
| Real SDK Node | Five pass: grouped epoll, ordinary/grouped mapping, shared-file and pthread/fork |
| Real SDK browsers | Fifteen pass across Chromium, Firefox and WebKit, including translated epoll copyout across a page boundary, read-only rejection and timed wakeup |
| Host ownership/lifecycle selection | 1,436 initially pass; two obsolete host epoll scratch-copy expectations corrected; all 229 affected boundary tests and 24 park teardown tests then pass |
| Normal partial-app desktops, Chromium and Firefox | Eight pass: Foot input/retirement, Freeciv quit/relaunch, ScummVM gameplay/native cleanup and shell-to-Sway activation in each engine |

The first integration build caught a missing write-access argument; the next
build hit disk exhaustion while native large-file tests ran. After those tests
released their temporary files, the unchanged build completed alone. The first
browser epoll attempt was rejected by the fixture's probe allowlist before
starting guest code; registering the new probe corrected it. The host failures
were obsolete transport expectations after epoll moved into Rust. These failed
runs are retained. No production algorithm changed after the runtime source
identified above.

The final desktop checks are smoke coverage of the combined runtime. The
longer same-page replacement sequences and performance numbers above remain
explicitly tied to their earlier sources, not silently attributed to this
integration.

## Artifact and evidence identities

The reused normal partial shell includes Cage, Foot, Sway, Swaybg, SFWBar,
Freeciv browser bundle, static ScummVM, curl, unzip, sysklogd, desktop-data and
Bibata, with lazy package references. Its SHA-256 is
`744deac9153eea6368fc7a50848fdbb07f3de84e96ec24d2e4cb225867a0a8bc`.
The measured scanner prototype kernel is
`87145a22794224ea681c4997b144ed9dfe1bf8c7e4069b725ee50d21628fdc2c`;
the unchanged scalar control is
`e0f443018858cde49858f88480163dafb1a127a07dad1d5cab2d55aaec4a3cd3`.

Raw reports, failed runs, commands and source identities are retained under
`.context/shared-memory-kernel-migration-1365/evidence/group-scan-1929/`.
Landing checks are recorded separately so prototype evidence cannot be mistaken
for validation of the rebased source. Full canonical-gallery browser-memory
and broad conformance suites are not claimed by the partial-image checks.


## Post-landing-diff audit

The 533-file comparison at `31cd7b7ed7db` against develop `0248e5c48176`
contained 58,706 added lines: 24,084 tests/fixtures, 20,148 Rust implementation
and contracts, 8,825 host TypeScript, and 5,649 documentation/generated/build/app
integration. This is substantive feature scope, not predominantly generated code.

The cleanup removes unused TypeScript mapping codecs, lifecycle adapters,
nonblocking notification and queue-observation paths, stale imports and obsolete
source-audit allowances. The fake native-wait pin hook now lives only in test
fixtures; production grouped observations obtain pins through the kernel.
The SDK README now describes the current shell-image path and limits.

A regression also found completed pthread-retirement promises accumulating in
the session map after their threads were removed. Settlement now removes the
matching promise, retaining failed thread objects for containment. Both new
bookkeeping cases failed before the fix and pass afterward. This does not
attribute or resolve the previously measured overall browser footprint overhead.

The final host ownership selection passes 1,429 cases across 60 files; nineteen
actual-kernel boundary cases, two ordinary/grouped Node SDK pthread-churn cases,
and three grouped SDK browser cases (Chromium, Firefox, WebKit) pass. A preceding
public Node session/SDK run passes 38 cases. App/browser and Node-test typechecks
pass. Removed unit cases exercised only deleted helpers; actual kernel and SDK
mapping/lifecycle coverage remains. No Rust, ABI or program bytes changed.
Existing partial-build artifacts were reused; full canonical-gallery, native,
conformance, desktop endurance and performance suites were not rerun for this
cleanup. The documented WebKit desktop reliability limit remains.
