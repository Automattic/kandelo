# Group mutex-release store latency

Status: suspected application/runtime cause; a standalone reduction now judges
the isolated contended-store latency disparity. No upstream report is filed.

## Standalone observation and limits

The `repro/` directory imports no Kandelo code or artifacts. Serve it with COOP
`same-origin` and COEP `require-corp`, then open `repro.html`. An owner Worker
creates a 512 MiB shared memory and warms its release function 20,000 times.
Eight Wasm contenders repeatedly exchange one byte-zero mutex. Each of 32
rounds holds the mutex until all contenders have entered, then measures only
the owner's unlock call. A second fresh owner uses the equivalent Wasm atomic
store. `contender.wat` is the source of the inline module bytes in `owner.js`;
the page needs no compiler, SDK, kernel, image or package.

The page reports `reproduced` when JavaScript release exceeds 250 ms, native
release stays below 50 ms, and the disparity exceeds 100x. It reports
`inconclusive` on setup failure or a slow native control. This measures a
latency cliff, not a JavaScript specification deadline or internal engine
implementation cause. Native Safari, Node and Bun controls remain unmeasured.

The ordinary registry driver ran two attempts per browser on macOS. WebKit
2359 (26.6) reproduces twice; Chromium 153.0.8010.12 and Firefox 155.0 each
report not-reproduced twice. The retained final WebKit attempt measures a
maximum JavaScript store of 4,826.06 ms and a native store of 0.02 ms; the
controls remain below 0.02 ms. Two earlier private Firefox launches failed
before the probe because they lacked the normal CoreFoundation home setup;
they are not runtime observations. The canonical driver succeeds.

## Application evidence

Grouped desktop phase timing locates 1–34 second intervals around kernel
JavaScript queue-unlock stores; payload, validation and notify intervals are
prompt. Native stack sampling mostly captures subsequent progress and does
not explain later gaps. Real C helper probes and read-first queue/pool/root
spin-loop experiments do not establish a desktop fix. Those failed sources
and normally prepared SDK images remain retained.

A private kernel-only native queue-unlock bootstrap completes sixty real Foot
spawn/resize/workspace/input/PID-file/exit cycles and Stop. Normal kernel-only
candidate 61 passes sixty cycles on all three browsers and WebKit capacity
refusal. Its longer combined retry 64 fails Sway IPC after 34 completed
cycles. Private diagnostic 65 also substitutes native pool/root releases and
still fails after 113 cycles. Consequently the isolated store disparity does
not establish the cause of every application failure or sustained reliability.

## Candidate workaround and ownership

The owning Node/browser kernel Worker binds a tiny native store module before
group publication. Admitted process Workers bind the same helper before guest
initialization, including pthread replicas and fork/exec replacements. Each
realm selects its cached call before taking the queue mutex. Process Workers
also publish loader-lock notifications through this queue; preparing only the
kernel realm leaves those releases on the JavaScript fallback.

The earlier all-realm combination failed its resize check after twenty cycles
and remains retained. Subsequent investigation found that the fixture issued
its second resize before Foot had completed the first. With actual buffer
attach/commit/compositor-release completion observed through normal guest
Wayland logging, a new participant-helper candidate completed two fresh WebKit
sessions of 120 cycles each. This is functional evidence under a diagnostic
guest workload, not proof that every application stall has the same cause.
The current owning-kernel-only diagnostic baseline has also completed two
120-cycle sessions without reproducing the multi-second pause.
The combined candidate passes 39 Node SDK/public-launch cases, 84 browser
SDK cases, 169 ownership/relay checks, the original 18-case three-browser
desktop matrix, and the ABI/baseline check. Fresh full browser-memory,
conformance, sustained untraced and resource/performance gates remain required.
The call stores zero to the same generated metadata word with the same
sequentially consistent semantics. It adds no wait, timeout, notification,
linear-memory allocation, participant, retirement fence or page-reuse authority.
The backing stays in its disposable Worker; a weak-key cache cannot keep it
alive after external owners disappear.

Cost: one compiled tiny module per owning kernel/process realm, one instance per
backing/realm, one Wasm call per queue release, and bounded independent queue
inspection scratch. Full combined memory, Node/browser and application
resource/performance gates are required before promotion. This remains an
unaccepted candidate and is not a broad performance improvement.

Sites: `host/src/memory-group-notification.ts`, `host/src/group-memory-resources.ts`,
`host/src/grouped-worker-runtime.ts`.
