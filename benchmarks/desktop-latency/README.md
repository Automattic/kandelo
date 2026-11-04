# Native display observer controls

This macOS diagnostic checks the visible-frame measurement path before it is
used to judge Kandelo's desktop. It captures only a window belonging to the
browser process family it launches. It never captures the complete desktop.
The Node host's graphics contract is unchanged.

Run from the repository's declared development shell, with an unlocked Mac,
an installed Apple SDK and existing Screen Recording authorization:

```bash
scripts/dev-shell.sh npx --no-install tsx benchmarks/desktop-latency/clock-bounds-control.ts
scripts/dev-shell.sh benchmarks/desktop-latency/run-control.sh .context/native-control-dom dom
scripts/dev-shell.sh benchmarks/desktop-latency/run-control.sh .context/native-control-worker offscreen
```

Each output directory must be new. Both commands run Chromium, Firefox and
WebKit serially using the app's installed browser driver. Set
`KPERF_NATIVE_ENGINES=chromium` to diagnose one engine. The sampler uses the
installed Apple compiler and ScreenCaptureKit separately from the Nix SDK
that builds Kandelo. It records compiler and OS versions, source and binary
hashes, browser versions, display modes, process ownership, raw observations
and failures. It preserves temporary browser profiles with the evidence.

The recorder checks authorization and console-lock state without requesting
permission or unlocking the machine. During a valid run, `caffeinate` keeps
the display awake for the lifetime of this command. Manual locking, display
suspension or losing the test browser's foreground status invalidates the
measurement. The command changes no persistent power setting.

The two controls render a uniform color through either DOM styles or a
worker-owned OffscreenCanvas WebGL2 context. The worker requests Kandelo's
existing framebuffer context attributes. Sixty ordinary inputs are followed
by one input whose handler deliberately blocks for 50 ms. A no-op input
must not produce the opposite color. Each stimulus has one outstanding
response; native frame ordering, input counts and pixel colors are checked.
The startup screenshot occurs before measurement.

`SCStreamFrameInfo.displayTime` is the Mach absolute time at which
WindowServer displayed the frame. This is window composition evidence,
not a photon or physical-input-device measurement. The sampler also records
callback receipt time separately. See Apple's [frame metadata contract](https://developer.apple.com/documentation/screencapturekit/scstreamframeinfo/displaytime).

The source endpoint is the browser event's `timeStamp`, retaining delay
before its handler runs. Browser-to-Node and native-to-Node clocks are
calibrated before and after each run with asymmetric round-trip bounds.
No equal one-way-delay assumption is made. Results retain lower and upper
quantile bounds with a 2 ms browser timer guard and 0.25 ms native guard.
The clock control rejects inconsistent clocks and non-finite quantiles.

These controls establish observer behavior. They do not measure Kandelo
pointer, typing, application FPS, dragging, resizing or scrolling; do not
prove the ship bar; and do not measure total instrumentation overhead.
The callback delay is only one part of that overhead. Desktop measurements
must correlate actual cursor or content pixels with the triggering input,
report coalesced and unmatched observations, and compare instrumentation on
and off under the required workloads.

Browser `page.screencast` remains useful for visual evidence, but its
[documented Firefox and WebKit 25 fps limit](https://github.com/microsoft/playwright/blob/main/docs/src/api/class-screencast.md)
is too coarse to decide the one-refresh median target. Never substitute its
delivery time, an arbitrary later KMS commit or a rAF callback for a matching
visible response.
