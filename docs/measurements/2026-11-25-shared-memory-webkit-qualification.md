# Shared-memory desktop WebKit qualification — 2026-11-25

**Qualification superseded later on 2026-11-25:** repeated desktop replacement
reproduced a Worker-retirement timeout on both this unchanged runtime and the
scanner candidate. WebKit is experimental for the first iteration. See the
[scanner receipt](2026-11-25-shared-memory-scanner.md). The results below remain
historical evidence, not a current reliability or support claim.

WebKit joins Chromium and Firefox as a supported target for the opt-in shared-memory desktop preview. This qualification covers Playwright WebKit 26.6 (build 2359) on macOS, using the normal partial shell image. Native Safari and iOS were not tested. The compatible-participant and fixed-size in-memory-object boundaries are unchanged.

## Candidate and build scope

The tested runtime is the cached first-iteration source `f26103c65331e31eb565bbd3cdcdd40945fab60e` plus the retirement and error-transport corrections described below. The normal package resolver rebuilt the kernel, SHA-256 `e0f443018858cde49858f88480163dafb1a127a07dad1d5cab2d55aaec4a3cd3`. Program ABI 56 and host adapter version 38 are unchanged; frozen executable bytes were not regenerated.

The normal partial `browser-main-shell` uses the same Cage, Foot, Sway, Swaybg, SFWBar, Freeciv browser bundle, static ScummVM, curl, unzip, sysklogd, desktop-data and Bibata lazy references as the [first-iteration receipt](2026-11-25-shared-memory-first-iteration.md). Image SHA-256 is `744deac9153eea6368fc7a50848fdbb07f3de84e96ec24d2e4cb225867a0a8bc`; manifest SHA-256 is `27ae8f20cb35f743d26fcbebd1951c9190d2edd1fc4bb04c366d2c2d91df191c`.

The corrections apply to the existing batch against develop `2e2972cdcc61a8851fdf196efdb87817bd7d9161`. At the maintainer's request, newer develop inputs and canonical products were not rebuilt. These results qualify the pinned runtime and corrections, not the later combined develop tree; its runtime retest remains with the maintainer.

## Corrections

- **Reaped leader retirement:** a stopped process-group leader retained in `Limbo` carries group identity, not live execution. The Rust retirement owner now permits its exact image custody to retire while a child keeps that identity alive. The native regression exercises exit, Worker fences, init reaping and physical retirement; it failed with `EBUSY` before the correction.
- **Stop during a paused checkpoint:** Rust changes the SDK checkpoint's wait predicate before notifying it. Previously, a task could pass its final alive check, miss the stop notification, then wait indefinitely on the unchanged pause epoch. The regression covers a late waiter and a contended wait-queue lock. No SDK rewriting, shortened wait or weaker retirement fence was introduced.
- **Cancellation diagnostics:** the host preserves the Rust fork transaction's terminal errno and the original native cause. Only an exact terminal `ESRCH` cancellation is reported as cancellation; injected `EIO` and unexpected failures remain errors. Image-retirement errors identify their PID.

The kernel remains the lifecycle authority. These changes introduce no TypeScript allocation or retirement owner.

## Validation

All final selections below completed without failures, retries, skipped tests or flaky results. Browser tests use the shared quiet fixture and real guest software.

| Check | Result |
| --- | --- |
| Native workspace | Pass, including 4,092 runtime-core checks; both new regressions have retained red/green runs |
| ABI and frozen executables | ABI check passes; nine frozen executable cases are included in the Node inventory |
| Real SDK Node and compiled-kernel boundary | 196 checks across seven files pass |
| WebKit SDK/root launch | 56 checks pass, including fork/exec/pthread, cancellation, native waits and shared objects |
| Public browser launch/accounting | Eighteen checks pass across Chromium, Firefox and WebKit |
| Normal partial app | Twenty-four checks pass across the three engines: SFWBar controls, Sway boot and shell activity, persistence, twelve-terminal close/reopen, 3072×1728 workspace movement, Foot input, ScummVM gameplay/quit and Freeciv local-game quit/relaunch |
| Repeated desktop replacement | Five WebKit sequences of twelve desktops pass: sixty launches, fifty-five same-page replacements, including thirty replacements of live desktops, and thirty exact guest exits. One twelve-desktop sequence also passes on each of Chromium and Firefox |
| Sustained WebKit session | 120 terminal fork/exec, workspace resize, physical input and close cycles pass in one Sway group, followed by exact guest shutdown; 22m28s overall |
| Host/browser-memory source checks | The preceding 1,423-check run passes; no subsequent production TypeScript change invalidates it. Final complete app typecheck and runtime-workaround registry checks also pass |

The maintained `shared-desktop-lifecycle.check.ts` is included in `playwright.canonical-shared-desktop.config.ts`. Each replacement sequence retains one page/context and persistent audio realm. The sustained test retains one group for all 120 cycles. Neither uses a reload, forced garbage collection or runtime tracing. They require real input/output, preserved page identity, memory-boundary checks and exact ownership retirement. Twelve terminals and 120 cycles are workloads, not configured user limits.

After each sustained cycle, images returned to nine and tasks to eleven. Allocated pages ranged from 1,717 to 1,724 (initially 1,721); shared objects stayed at eight. Quarantined replicas and pending wait drains remained zero. Native observers ranged from zero to one while the group was active; final compositor exit required zero observers, zero shared objects and exactly two remaining login/syslogd images. Those remaining images are expected in the retained computer.

## Failed runs and limits

Earlier candidates failed a Chromium image retirement with `EBUSY`, retained a WebKit image/native observer after guest exit, and intermittently hung during whole-computer shutdown. An isolated diagnostic run of the earlier kernel reproduced a shutdown hang after its first twelve-desktop sequence passed: the next sequence retained one exact Worker fence, with no queued wait nodes or pending completions. The two kernel defects have independent native reproductions. The incomplete historical captures do not prove those defects were the sole cause of every earlier failure. The five clean final sequences and sustained test qualify the corrected candidate; they do not erase the failures.

Separate setup failures included an optimized React module import before guest boot and an SDK fixture compilation timeout. Isolated development-server dependency caches repaired the former; the latter was rerun after the native build finished. Fixture corrections preserve exact injected error causes and immutable point-in-time accounting snapshots instead of assuming two asynchronous snapshots are identical. Original failures and their commands remain retained.

WebKit still uses the existing [full-backing preallocation workaround](../../tests/runtime-workarounds/JSC-SHARED-MEMORY-GROW-INSTANCE-TEARDOWN/entry.md): an 8,192-page group has a 512 MiB backing from creation. Its extent stayed at 8,192 pages in these runs. Logical allocation and retirement counters are not OS footprint measurements. The [native mutex-store workaround](../../tests/runtime-workarounds/JSC-GROUP-MUTEX-STORE-STALL/entry.md) also remains. This qualification does not establish an upstream engine fix or isolate each workaround's resource cost.

The prior ordinary-versus-grouped CPU, footprint and input measurements remain in the first-iteration receipt, including the extra CPU and memory costs. No new performance improvement is claimed. A fresh full canonical-gallery browser-memory gate, full Node/browser develop benchmark comparison, combined-develop runtime retest and native Safari/iOS validation were not run. Relevant conformance results remain the earlier bounded results identified in the first-iteration receipt, not a new full POSIX claim.

Retained evidence is under `.context/shared-memory-kernel-migration-1365/evidence/webkit-support-1870/`: source and artifact identities, native red/green runs, failed candidates and final runs 1905–1913. Final desktop reports are 1908, 1910, 1912 and 1913. The original PR1–PR9 roadmap and deferred features remain unchanged. No merge or deployment is part of qualification.
