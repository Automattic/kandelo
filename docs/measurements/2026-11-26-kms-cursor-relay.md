# Cursor input and display relay during a terminal burst

The source target is develop at `6b6904b3075437433a1cccec0273142850c8f93c`.
The trace starts with host revision `0ae2a062cd89a95ca945adeb393d0ba9fa7a07f0`,
which contains the separately reviewed browser input and Sway clock changes.
The runs use the same locally built Sway partial shell
(`8f7a25bc1b93fdb82e2ae78ac0448798d7dfdf22cb63822e6cc1c50bdb997e92`)
and kernel artifact
(`af47c623f87611b6d05d5ab42cec7dfa291648afbc64a36ff8992a9c8158bb87`).
The browser harness boots the ordinary shell profile, sends five trusted
Alt+Enter presses, checks six rendered prompts, and then sweeps across the
tiles. This is a headless 1600×1000 viewport with device scale 1 on macOS.

## Input and presentation

In the first three-engine sweep, all 114 offered positions were delivered to
the page adapter, posted to the kernel Worker and injected into evdev. Each
engine reached the expected position at the end of the fastest sweep. The
kernel published fewer intermediate cursor positions than it received inputs.

| Browser | Inputs to evdev in fastest sweep | Cursor positions published by KMS |
| --- | ---: | ---: |
| Chromium | 36 | 33 |
| Firefox | 36 | 12 |
| WebKit | 36 | 24 |

The 8 ms spacing was a minimum delay between automation calls. It varied
with browser and host scheduling. These counts describe one sweep and its
settle period. The result locates the observed coalescing downstream of
evdev. It provides no estimate of browser input delivery under other loads
or from other pointing devices. KMS publication also precedes final paint.

The second trace followed the relay. The old relay painted the cursor into a
full-size canvas in the kernel Worker. Each changed cursor overlay then
triggered `createImageBitmap` at 1600×892, alongside the primary bitmap when
it was dirty. Firefox captured 51 such cursor bitmaps in that run. WebKit
captured 80. A cursor bitmap at that extent covers 1,427,200 pixels, or
5.44 MiB at four bytes per pixel. This is the surface extent, independent of
how the browser implements that native operation.

The new relay sends the cursor's placement and at most 16 KiB of owned RGBA
pixels to the existing display Worker. That Worker clears the old cursor
rectangle and paints the new one with the same painter. The host removes
one screen-sized producer canvas and one native bitmap capture per updated
cursor plane. Primary snapshots, mode selection and gamma composition
still follow the same owned device path. The display acknowledges one
ordered bundle and retirement still waits for the exact native capture
and display fence.

The traced WebKit and Chromium candidate desktops each rendered six
prompts and showed the cursor moving between two positions within one
terminal. The WebKit run sent 106 cursor updates and Chromium sent 114.
Each carried 16,384 bytes and generated zero cursor bitmap captures.
Desktop wall-clock timing varied with host load and offer spacing.

## Cursor-only relay cost

A separate paired test mounted a 1600×892 display on the same browser
and drove the real old and new producer and display Workers. Each arm
presented one primary bitmap, sent 96 changes to a 64×64 cursor one at a
time, and obtained the exact retirement receipt. The clock spans sending
each cursor update through its acknowledgement, including paint and
capture where applicable. It excludes input delivery, guest rendering
and scanout scheduling. Each arm ran twice in before/after/after/before
order. Discarding the first six updates per run leaves 180 samples per arm.

| Browser | Before median | After median | Before p95 | After p95 |
| --- | ---: | ---: | ---: | ---: |
| Chromium | 0.05 ms | 0.06 ms | 0.14 ms | 0.12 ms |
| Firefox | 4.45 ms | 0.58 ms | 32.92 ms | 18.38 ms |
| WebKit | 11.90 ms | 3.88 ms | 29.22 ms | 22.82 ms |

Each before run made 97 native bitmap captures. Each after run made one.
The two Firefox baseline medians varied from 1.55 to 9.49 ms before warmup
exclusion. These are local Worker acknowledgements under substantial host
load. They establish a reduction of relay work with no estimate of the
end-to-end input-to-paint improvement.

## Cursor updates while focusing terminals

The same instrumented WebKit desktop trace that sent 106 cursor updates
also requested a primary bitmap in **all 106 bundles**. In the isolated
relay test each timed update carried only a cursor. Among 106 of the 116
distinct pointer targets that could be matched to a published KMS position
by coordinates, median time from evdev injection to that position was
34 ms. Across the 106 bundles, median time from sending the bundle to its
acknowledgement was 15 ms. The acknowledgement does not timestamp when
the browser displays the cursor. The run included tracing and substantial host load. It cannot assign all
the delay to a specific compositor operation or browser API.

## Visible response on the combined demo

Two local demos served the same partial Sway image and grouped kernel.
The updated demo additionally included the cursor relay and the observed
executable-buffer reuse from [#1799](https://github.com/Automattic/kandelo/pull/1799).
The probe used each live demo in updated/earlier/earlier/updated order.
It verified the served kernel digest, focused the graphics pane, and
detected the initial Bash prompt in a screenshot. From the first of five
Alt+Enter automation commands it timed until a screenshot showed six
distinct rendered prompts. After the burst, it sent eight isolated
trusted pointer moves across tiles. For each move it sampled a 40×40
region of the cursor canvas at the destination on delivery and on
successive animation frames until cursor pixels appeared. Each target
was separated from the previous one by hundreds of pixels. Reading the
canvas can add work and samples at frame granularity. These observations
exclude physical input latency and the display panel.

| Browser and metric | Earlier run 1 | Earlier run 2 | Updated run 1 | Updated run 2 |
| --- | ---: | ---: | ---: | ---: |
| Firefox, median cursor sample (ms) | 93.5 | 102.0 | 83.5 | 84.5 |
| WebKit, median cursor sample (ms) | 65.0 | 48.5 | 63.0 | 56.5 |
| Firefox, five launches to prompts (s) | 8.57 | 6.77 | 5.56 | 5.44 |
| WebKit, five launches to prompts (s) | 4.01 | 3.96 | 18.49 | 4.88 |

Both demos completed both engines' runs. Firefox still took roughly five
60 Hz frames to show the sampled cursor position on the updated demo.
WebKit's cursor samples overlapped between builds. Host load varied and
there were only two runs per build. The table cannot isolate either
patch's contribution or identify the cause of the 18.49 s WebKit burst.
The burst measurement does not isolate time spent showing a background
before terminal text. WebKit here is Playwright's browser on macOS.
The installed Safari 27.2 driver timed out creating an automation session
before testing the demo.

## Deferred work

A trace also found repeated primary blits of the same BO, framebuffer, and
commit. The immediate `host_kms_set_fb` branch accounted for zero of those
blits during these sweeps. The conservative WebGL context epoch also sees
real intervening native writes, including texture updates and draws. The
trace did not establish that those writes leave the latched scanout storage
and the destination canvas untouched. A possible optimization needs
attachment-level ownership for both ends and coverage for shared native
images, extension draws, and context restoration.

An opaque scanout sample was insufficient evidence to skip the primary
alpha clear. Guest and native writes to the borrowed framebuffer can still
change alpha. The primary path and its conservative invalidation remain
in place. Cursor messages still share the primary frame's in-flight fence,
and this change does not alter the compositor's publication cadence.

## Validation

Four targeted graphics suites passed 261 tests with the kernel from
`6b6904b3075437433a1cccec0273142850c8f93c`. They cover cursor geometry and
pixels, the display's ordered acknowledgement, replacement, context
restoration, device errors and retirement. The host build including its
declarations passed. The source-only browser memory boundary suite passed
seven tests. Two prepared boundary suites passed 19 tests for real Rust
allocation and exact host retirement. A separate native Worker probe
showed cursor placement, motion and clear after retirement with one
primary capture on Chromium, Firefox and WebKit. The first Chromium
probe exceeded its five-second screenshot deadline. A separate Chromium
timing trial was interrupted by a dev server navigation and passed on
rerun. The Firefox full-desktop run timed out before its first prompt.
A baseline Firefox run also timed out there while Sway startup was still
making shared-memory operations. The complete multi-product browser
memory gate has not completed.
