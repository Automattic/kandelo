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

In the WebKit candidate run, 106 cursor updates each carried 16,384 bytes
and generated zero cursor bitmap captures. All six prompts rendered and
the screenshots showed the cursor moving between two positions within one
terminal. Browser wall-clock timing varied with host load and offer
spacing. This receipt measures the eliminated capture and transferred
payload. It does not establish an end-to-end latency improvement.

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
seven tests. A separate browser probe using the real producer and disposable
display Workers showed cursor placement, motion and clear after retirement
with a single primary capture on Firefox and WebKit. The first Chromium
probe exceeded its five-second screenshot deadline. A Firefox Sway run
stalled before the first prompt under heavy host load. The complete
multi-product browser memory gate has not completed.
