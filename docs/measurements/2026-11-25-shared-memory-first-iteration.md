# Shared-memory first iteration — 2026-11-25

This receipt records the original pinned first iteration. The subsequent [WebKit qualification](2026-11-25-shared-memory-webkit-qualification.md) adds two kernel retirement corrections and records successful runs. Later testing reproduced a retirement failure on that runtime; the [scanner receipt](2026-11-25-shared-memory-scanner.md) records the current experimental WebKit status. All original measurements, failures and build-scope limits remain historical evidence.

This is an opt-in preview for mutually trusting, compatible programs sharing one physical WebAssembly memory. The actual Rust kernel owns group policy, allocations, execution transactions and reclamation. Cage, Sway and Sway/SFWBar use normal SDK settings, package resolution and shell profiles. Fixed-size in-memory descriptor writes and mapping offsets are included; growth/truncation, persistent writable sharing and mixed graphical clients remain follow-ups.

## Candidate and build scope

The runtime tested here is `f26103c65331e31eb565bbd3cdcdd40945fab60e`, based on develop `1583a6afc1318d351b77fdbbcd1af4b8cc889e1f`. The kernel was built through the normal package resolver: SHA-256 `24dd8bb6937a55bf61a3b97bee6cdc04977b72f58b967c27dfa2027b8f94bcf1`. Program ABI is 56 and host adapter version is 38. The frozen program bytes were not regenerated to satisfy the tests.

At the maintainer's request, validation used a normal partial shell with lazy package references, rather than rebuilding all canonical products. Its packages are Cage, Foot, Sway, Swaybg, SFWBar, Freeciv browser bundle, static ScummVM, curl, unzip, sysklogd, desktop data and the Bibata cursor theme. Image SHA-256: `744deac9153eea6368fc7a50848fdbb07f3de84e96ec24d2e4cb225867a0a8bc`. The kernel and rootfs were refreshed in an isolated projection; the user preview and its package cache were preserved.

The batch subsequently incorporates develop `2e2972cdcc61a8851fdf196efdb87817bd7d9161` at the source level. Its sole textual conflict was the generated binary-resolver bundle, regenerated normally with its bundle regression check passing. **The combined develop tree has not been rebuilt or runtime-tested:** the maintainer requested preserving the cached candidate and will retest the combined changes. The results below apply to the pinned candidate, not that later integration.

## Validation

| Check | Result and scope |
| --- | --- |
| Native workspace | Pass, including 4,090 runtime-core unit tests and workspace integration/doc tests |
| `xtask` | Most recent run: 916 unit and eleven integration checks pass; unchanged by the final runtime correction |
| ABI snapshot and frozen executables | Current kernel ABI check passes; nine pinned executable cases pass in the Node run |
| Host/browser-memory source selection | 1,423 checks across sixty files pass |
| Actual compiled-kernel boundary | Nineteen checks across two files pass, including contended completion publication and exact retirement |
| Real SDK Node and public launch paths | 196 checks across seven files pass, including frozen executables and forty-cohort pthread, fork, forced-exit, native-wait and shared-object workloads |
| Normal partial app, Chromium and Firefox | Sixteen checks pass: SFWBar controls, Sway boot and shell activity, file persistence, twelve terminals with close/reopen, 3072×1728 workspace movement, Foot input, ScummVM gameplay/native quit and Freeciv local-game quit/relaunch |
| Current shared-object browser lifecycle | Four checks pass, including forty cohorts sharing one backing on each of Chromium and Firefox |
| WebKit | Three current normal-app boot/input/teardown smoke checks pass; experimental support only |
| Relevant conformance | Earlier pinned integration run: eight libc pthread/semaphore/TLS cases per Node/Chromium host pass; five POSIX unmapping passes and two documented expected failures per host, with no unexpected failures, skips or timeouts. Not rerun after the final optional-collection correction |

The final correction makes orphan collection defer when its native notification queue is contended. A deterministic Rust regression reproduced `EAGAIN` escaping from an otherwise valid mapping; it now verifies retained object custody, successful mapping and later exact reclamation. Other collection errors still fail. This fixes a concrete race consistent with the earlier captured Firefox initial-mapping trap; the original browser capture did not expose its errno, so it does not prove that race was the capture's sole cause.

Obsolete TypeScript tests that reconstructed a deleted host policy owner were removed. Their meaningful cases remain covered by actual Rust completion/retirement tests, native-observation tests and real compiled-kernel boundary tests. No replacement TypeScript group owner was introduced.

## Resource evidence and limits

The [current samples](2026-11-25-shared-memory-first-iteration.json) use Chromium 153.0.8010.12, one fresh parent per arm per metric, ordinary then grouped, at 1280×840. Both normal partial controls have identical entries and lazy references; only Sway's backend setting differs. No profiler, forced collection or concurrent owned build/test ran; the user preview remained available. This is a descriptive screen, not a statistical estimate or a develop comparison.

| Measure | Ordinary | Grouped |
| --- | ---: | ---: |
| Browser-family CPU for fifteen physical shell commands plus Inspector reads | 13.849 s | 16.905 s |
| Trusted keydown to captured Foot glyph, median of fifteen samples | 32.025 ms | 32.320 ms |
| Browser-family physical footprint, one terminal | 2,498.377 MiB | 2,579.720 MiB |
| Two tiled terminals | 2,535.939 MiB | 2,739.267 MiB |
| Two separate workspaces | 2,593.799 MiB | 2,752.627 MiB |
| Two terminals retiled | 2,581.658 MiB | 2,750.627 MiB |
| After desktop exit, login machine retained | 2,095.641 MiB | 2,444.829 MiB |

CPU was 22.1% higher in this pair. Desktop footprint was 81–203 MiB higher; after exit it was 349 MiB higher with the login shell and syslogd still alive. Their two group images retained 325 allocated pages (20.313 MiB), zero shared objects and zero native observers; the backing retained 2,410 pages (150.625 MiB) of grown capacity. That is not whole-machine teardown or proof that the remaining browser footprint belongs solely to group payload. Exact whole-group retirement is checked separately in SDK lifecycle workloads.

Footprint is macOS shared-region-adjusted browser-family physical footprint, not unique guest bytes. CPU includes browser, renderer and GPU processes. Glyph timing includes capture/readback and is not physical input-to-photon; the fixture checks exact glyph pixels, no-input controls and a deliberate 50 ms delay. Within-parent samples are correlated. These results disclose material overhead rather than establish a speed or memory saving. Earlier reclamation optimizations and unsuccessful follow-on optimization experiments remain in the [historical cost receipt](2026-11-23-shared-group-reclamation.md); optional further optimization remains separate from correctness.


The original Chromium resource test observed backing capacity grow from 500 to 501 pages at cohort 27: 64 KiB of additional reusable capacity. Idle allocated pages returned to one and execution/image/native-observer owners retired. Exact historical artifacts and subsequent current runs did not reproduce it. The failure and negative experiments remain retained; its exact trigger is unresolved, and no leak fix or strict capacity plateau is claimed for that historical run.

WebKit remains experimental. Current smoke success does not clear historical intermittent stress failures. Its [existing full-backing preallocation workaround](../../tests/runtime-workarounds/JSC-SHARED-MEMORY-GROW-INSTANCE-TEARDOWN/entry.md) has reservation/commit costs; it is not proof of memory savings. Playwright coverage is not native Safari evidence.

A new full canonical-product/full-gallery browser-memory run and the complete Node/browser develop benchmark comparison were not run. No general performance improvement, net memory saving, full POSIX conformance or fully retested develop integration is claimed. These omissions must remain visible in the landing decision.

## Retained evidence and follow-ups

Commands, logs, source identities, measurements and failed experiments are retained in `.context/shared-memory-kernel-migration-1365/evidence/develop-integration-1786/`. Final runs are 1852–1868: the red native reproduction, corrected workspace run, resolver/kernel build, memory checks, normal desktop sessions, Node SDK/frozen cases, WebKit smoke and shared-object browser lifecycle. Initial fixture/setup failures and the Firefox test-profile cleanup ACL warning remain alongside successful results.

The original roadmap is preserved at `.context/original-shared-memory-plan/2026-11-18T19-17-38-0500/shared-memory-multi-pr-plan.md`. It remains follow-up work. PHP-FPM sources, defaults and runtime policy are unchanged (its image manifest records the shared image-builder input), other desktop demos and their unique dependencies remain disabled, and nothing is merged or deployed automatically.
