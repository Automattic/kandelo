# Sway pointer focus and status updates, 2026-11-26

Pinned develop was `c2a3365cfde83e7c5a4021dbcd0e25d1a1c259fe`. The browser
input change and guest status clock are independent of the shared-memory
Worker retirement PR. The kernel Worker still handles all guest input, and
the existing vblank and scanout paths still present the actual guest frame.

## Earlier mouse input

On the KMS canvas, a trusted unpressed mouse move can use the first
`pointerrawupdate` before the browser delivers its ordinary `pointermove`.
The ordinary stream supplies a later coalesced position and recovers
button state. Matching and older positions are suppressed after an early
delivery. Button edges, drag, pointer lock, touch, pen and browsers that
supply only ordinary moves use their existing paths.

The Chromium 153 diagnostic booted Sway with two Foot windows through
Vite and the normal partial shell. It alternated a trusted pointer across
the tile boundary, varied the stimulus phase and waited for the expected
title pixel in the canvas. The trace records input post, Worker receipt,
evdev entry, vblank, DRM submit/latch and canvas readback separately.
Each of four runs measured 45 moves after two warmups, in develop,
candidate, candidate, develop order. The input prototype was `a6ac84937d`.
Both revisions used the same frozen kernel
`ebd54419f573b2ea077964437d5ace3ee6bf0fcbe98106f8bf9a865dc15b79e8`
and partial image
`121a4c744a3dae121d0b992505adbf98106cbe2858a1aa5160a9ad031f07c872`.
Starting one-minute load ranged from 13.7 to 17.0 on the 18-CPU host.

| Chromium event-relative interval, ms | Develop median | Early hover median | Develop p95 | Early hover p95 |
| --- | ---: | ---: | ---: | ---: |
| Pointer timestamp to page post | 9.01 | 0.15 | 14.27 | 0.20 |
| Pointer timestamp to observed focus color | 75.10 | 62.33 | 123.93 | 113.68 |

Each run recorded exactly one evdev position batch per isolated stimulus
including warmups. The median change is consistent with avoiding the wait
for frame-aligned input and sometimes reaching the compositor one frame
earlier. These headless canvas observations cover focus over two tiling
terminals. Native display, device and drag latency remain unmeasured.
The status command was unchanged in these four runs.

## Status clock launches

A separate Chromium DevTools trace put five Worker turns of 76–91 ms
across input and vblank delays. The second profile correlated six
67.9–78.3 ms turns directly with grouped exec of `/bin/date` and
`/bin/sleep`. While those executables were prepared, posted input and
frame callbacks waited for the kernel Worker. The profile showed direct
GPU scanout throughout the workload.
A finer trace placed about 33 ms per launch between reading the
candidate image and completing Rust's retained source/image binding.
That work includes executable validation and content identity checks.
Removing the periodic clock launches avoids repeating those checks for
this workload. Launch-heavy guest applications can still incur them.

For a causal control, Sway IPC temporarily disabled only the bar status
command on pinned develop. Forty-five moves with the clock on and
forty-five with it off observed medians of 74.16 ms and 74.62 ms. Their
p95s were 110.69 ms and 80.16 ms. No Worker timer task longer than 20 ms
was recorded in the disabled run. These two profiled controls isolate
one source of the tail. They are separate from the early-hover comparison.

The packaged Sway bar keeps its clock through one long-lived guest
`sway-status-clock` process. The guest still formats local time, emits
one text line per second and retires with the bar. The ordinary binary
and its normally derived shared-memory variant come from the Sway
package. The shell installs the executable lazily with Sway.

The replacement was also measured in a temporary copy of the frozen
image containing the ordinary SDK executable and its SDK-translated
group variant. Both arms used the same candidate browser source
(`cfdabd6671`), kernel and image. Sway IPC chose the original command
or the real resident clock and reported the selected command back.
Each resident-clock run also observed exactly one clock process in the
guest process table. The four runs measured 45 moves each in legacy,
resident, resident, legacy order, with one-minute load between 11.2
and 14.0. Early forwarding was enabled in both arms.

| Chromium event-relative interval, ms | Legacy clock median | Resident clock median | Legacy clock p95 | Resident clock p95 |
| --- | ---: | ---: | ---: | ---: |
| Page post to kernel Worker receipt | 0.08 | 0.09 | 43.24 | 0.24 |
| Pointer timestamp to observed focus color | 62.85 | 62.51 | 113.89 | 70.96 |

Six of the 90 legacy-clock moves took at least 100 ms. All 90 moves
with the resident clock completed under 100 ms. This isolates the
replacement's effect on this clock workload. Other guest exec activity
can still delay the same Worker. The temporary image is diagnostic
evidence, and the normal package and shell path has its own checks.

## Normal package validation

The normal package and image commands built
`partial shell sway swaybg foot desktop-data bibata-cursor-theme`.
This repeat used the cached SDK closure from `72e4005fed` with the
final package changes applied in `90374352e9`. The image SHA-256
was `74a9b5d7f7b2e1a85b961f9513c84e36f4ecc6487a2724cacbdc97200fe287ea`.
It used the same frozen kernel as the earlier diagnostics. The
ordinary clock and the group variant were built and published by
the normal package resolver.

The same Chromium comparison repeated against this packaged image.
Both arms ran identical early-hover browser code. The final run
included a documentation-only commit. A Sway IPC command restored
the legacy clock in the outer two runs. The inner two used the
packaged default. Starting one-minute load was 10.5–12.2.
All four runs captured 45 moves. Median focus was 61.72 ms with
the legacy clock and 61.10 ms with the packaged clock. The
respective p95s were 113.36 ms and 72.24 ms. Seven of 90 legacy
moves reached 100 ms. All 90 packaged-clock moves finished below
that mark. The early-hover and clock comparisons hold different inputs
constant, so their latency deltas cannot be added.

Four Node partial-image tests passed, including ordinary shell
launch of the lazily installed executable and its pipe shutdown.
Chromium 153 and Firefox 155 both passed the normal Sway app test.
The test saw the same clock PID while its output advanced, moved
focus in both directions, exercised GLES2 and Pixman and confirmed
the clock retired with the desktop. Firefox reported a run-owned
temporary-directory cleanup permission error after the assertions
passed. Typecheck, the host build and 382 browser-app unit tests
also passed. The initial trusted Sway/Cage input checks passed on
Chromium and Firefox using the earlier partial image.

The package and partial-shell build also completed on the SDK at
pinned develop, using build checkout `5d8e58809c`. The image SHA-256
was `8f7a25bc1b93fdb82e2ae78ac0448798d7dfdf22cb63822e6cc1c50bdb997e92`.
Its kernel SHA-256 was
`7064525a2436379bc088ff2aa54ad0dfe1f6781a8be6b8d4de9f1eee05206b98`.
All four Node partial-image tests and the Sway lifecycle test on Chromium
and Firefox passed on that product. The canonical shell build was still
in progress when this report was recorded. The full performance suites
and native display timing remain outside this evidence.

## Retained failures

The first app typecheck rejected the raw listener's event signature.
Accepting `Event` and checking for `PointerEvent` fixed the type boundary.
A fresh checkout also needed its generated product catalog and image
module artifacts. The final typecheck and 382 browser-app unit tests
passed with those prerequisites.

The first temporary-image run supplied a symlink as the SourceOnly
root. The ordinary resolver refused it. The retry used the verified real
projection directory and compressed the diagnostic image. The first
normal Sway package build detected that its inherited fork-install
policy differed from the clock's declared policy. The recipe now
passes the declared policy only when installing the clock.
