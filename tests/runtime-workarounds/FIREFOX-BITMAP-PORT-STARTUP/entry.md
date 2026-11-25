# FIREFOX-BITMAP-PORT-STARTUP

Status: suspected.

## Defect

Firefox 155.0 (Playwright firefox-1543 on macOS) raises `messageerror` when Kandelo sends the first ImageBitmap bundle before the disposable display Worker has initialized. The same captured image can be cloned inside its producer. A separate freshly painted 16×16 canary fails on the same port too. This remains an unreduced observation; a browser defect is not confirmed.

## Why Kandelo is affected

The normal opt-in desktop starts presentation while its display module is loading. Its initial cursor-only frame can arrive before a primary frame exists. Deserialization fails before the receiver can validate the bundle or acknowledge it, leaving the display frozen.

## Workaround and its cost

The display sends one `ready` receipt after obtaining its bitmap contexts and installing its message handlers. The producer retains dirty versions and starts capture only after this receipt. Missing readiness reports an error within the existing three-second device retirement budget; shutdown before readiness still fences the exact display. This adds one small startup message and the next scheduled vblank, without a new memory pool, image copy, retry, or muted error. Ordinary Node execution has no browser bitmap display and is unchanged.

## Evidence

Default-root startup failed in 10/10 Firefox runs before the handshake; a first handshake diagnostic passed 3/3. Captured diagnostics identify sequence 1, cursor plane only, 1498×892, same-origin cross-origin-isolated producer/receiver Workers. With the bounded handshake, the maintained full Sway interaction and renderer-restart check passed on Chromium, Firefox and WebKit (campaign run 519b, 2026-11-20). The 26 relay unit tests include missing/duplicate readiness and shutdown before initialization. Sustained lifecycle and browser-memory acceptance remain separate gates.

Standalone controls contain no Kandelo or Wasm code: two module Workers, transferred OffscreenCanvases, MessageChannel, ImageBitmap transfer, native bitmaprenderer and exact acknowledgements. Transparent initial frames, resize/reset/clear, mutation during capture, persistent profiles, delayed script loading, a SharedArrayBuffer in the producer initialization, and stock Vite serving have not reproduced the error on Firefox 155.0 or Chromium 153.0.8010.12. A top-level-await delay lost its initialization event on both engines and was inconclusive; it is not evidence of this defect. Raw attempts and frozen input patches are retained under `.context/shared-desktop-startup-503/` in the campaign workspace.

## Why this is not a Kandelo defect

That has not been established. The standalone controls are negative, and differences in port transfer, worker startup or realm ownership remain possible Kandelo causes. Do not call this a confirmed Firefox bug. A faithful standalone failure is required before attribution or an upstream report.

## Draft upstream report

Not filed. Not ready to file: no standalone reproducer demonstrates the failure. Reports remain human-only.

## Removal criteria

Identify the missing ownership or startup condition. If Kandelo is responsible, fix that cause and remove this entry. If a standalone reproducer confirms an engine defect, record the exact runtime and verify affected released versions before removing the handshake solely as a workaround. Preserve initialization, failure and early-shutdown checks.
