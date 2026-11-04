# Native display observer controls

This macOS diagnostic checks the visible-frame measurement path before it is
used to judge Kandelo's desktop. It captures only a window belonging to the
browser process family it launches. It never captures the complete desktop.
The Node host's graphics contract is unchanged.

Run from the repository's declared development shell, with an unlocked Mac,
an installed Apple SDK and existing Screen Recording authorization:

```bash
scripts/dev-shell.sh npx --no-install tsx benchmarks/desktop-latency/clock-bounds-control.ts
scripts/dev-shell.sh npx --no-install tsx --unhandled-rejections=strict benchmarks/desktop-latency/observer-promises-control.ts
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
The startup screenshot and first visible transition occur before the
guarded measurement window. A frame failure that occurs while input
dispatch is in flight remains owned and is rethrown when awaited.

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


## Pixel matching controls without desktop access

```bash
scripts/dev-shell.sh benchmarks/desktop-latency/run-pixel-control.sh .context/native-pixel-controls
```

This command never opens a visible browser or starts ScreenCaptureKit. It
compiles the optimized native recorder and the same matcher in an offline
executable. Headless Chromium, Firefox and WebKit render DOM and worker-owned
WebGL cursor-shaped content. Captured PNGs are decoded into window rasters;
the matcher learns the actual foreground changes at one pose and verifies
five further poses. Controls reject background-only learning, a wrong color,
a stale/no-op pose, an ambiguous pair of cursors, malformed rasters, duplicate
identities, out-of-window candidates and excessive work. Row-padding handling
is checked separately. Calibration waits for compositor animation frames;
a worker's submission acknowledgement is not a pixel response. Screenshots,
source and binary hashes, versions and verdicts remain in the private output.
These are classification controls, not native desktop latency measurements.

The live recorder accepts these additional stdin commands:

- `pixels <id>` returns the next complete owned-window raster as packed BGRA,
  with its frame identity and display timestamp. This is calibration only:
  at most sixteen unique snapshots per process and four pending requests.
- `matcher <json>` installs a `PixelMatcherConfiguration` from
  `pixel-matcher.swift`. Each candidate has a unique identity and a window-raster
  position, and can override the shared sparse RGB template. The comparison
  budget includes the sum of all selected templates. `learnPixelTemplate` in
  `pixel-template.ts` derives those samples from foreground/background captures.
- `matcher-clear` removes the matcher.

Matching frames emit `pixelMatch.state` (`matched`, `unmatched` or `ambiguous`),
all matching identities and scores, actual comparison counts and `matcherMs`.
No raster bytes are emitted during ordinary matching. Configuration size,
coordinates, search radius and comparisons per frame are bounded. Invalid
geometry or inaccessible pixel buffers emits an error that invalidates the
observer run. The optional third recorder argument selects capture width
(128–2048 pixels; default 512). Higher resolution and matching both require
instrumentation-overhead measurements; `matcherMs` alone does not supply them.

A desktop caller still needs verified CSS-to-capture coordinate calibration,
independent captured-frame validation of each cursor pose, and input-to-pixel correlation.
Use original event timestamps. Preserve every ambiguous/unmatched observation
and report coalesced inputs; do not silently remove latency tails. None of
these controls completes the required desktop workload/engine matrix.

Native visibility results now use the preceding captured non-response frame
for the lower bound and the matching response frame for the upper bound,
including asymmetric clock uncertainty. Capture may coalesce earlier displayed
frames, so clock bounds around the matching frame alone are too narrow. The
controlled response must remain visible until the next stimulus; repeated or
reused poses require an independently verified transition. A missing preceding
non-response gives a zero lower bound. Historical clock-only lower quantiles
must not be used as exact first-display latency or evidence of a ship-bar miss.


## Moving-pixel controller and viewport coordinates

```bash
scripts/dev-shell.sh benchmarks/desktop-latency/run-cursor-control.sh .context/cursor-replay headless
scripts/dev-shell.sh npx --no-install tsx --unhandled-rejections=strict benchmarks/desktop-latency/observation-rows-control.ts
```

The replay runs the same controller against headless DOM and worker-WebGL
content on three engines. Its capture adapter adds a synthetic border and
0.75 scale. Four temporary colored markers recover the scale and offsets;
missing, ambiguous, distorted or inconsistent geometry fails calibration.
Markers are removed before cursor learning. The controller learns directly
a separate template for each pose from foreground/background capture rasters,
then proves each pose in fresh frames through the shared matcher. Fractional
capture scaling can change edge coverage between positions; validation does
not reuse the learning frames. Image-qualified calibration retains up to three
attempts per pose and never treats a source acknowledgement as a redraw. Calibration screenshots and
worker acknowledgements never supply the timed display endpoint.

Sixty ordinary inputs vary their phase by 0/3/7/11 ms, followed by a deliberate
50 ms handler/worker stall. A no-op input must retain the preceding pose.
Original event timestamps, all frame matches, ambiguity, missing observations,
clock bounds, calibration data and failures remain in the private output.
The headless adapter pumps screenshots while a response is outstanding,
retaining intermediate unmatched frames without waiting for source completion.
Its timestamps and geometry are synthetic; the result deliberately omits
native latency quantiles. Each screenshot has a 15-second acquisition limit
inside a 30-second functional response budget. All acquisition intervals,
failures and counts over 50 ms/1 second are retained separately. Those are
collector durations, not guest latency. Native observation keeps its independent
ten-second response deadline and actual WindowServer timestamps.

The native mode uses actual WindowServer observations and never drains or
waits for a worker acknowledgement on the timed path. Coordinate calibration
uses sRGB capture output explicitly: the default follows the display's gamut
and its bytes cannot be compared directly with sRGB marker colors. Template
learning also stays within native captured pixels; resampled browser PNG edges
are not interchangeable with native-composited edges. No color or matching
tolerance is widened to hide a failed calibration.

After coordinating a short unlocked, visible session, a diagnostic operator
can run the native control with the same driver:

```bash
scripts/dev-shell.sh env KPERF_NATIVE_ENGINES=chromium KPERF_CURSOR_SAMPLES=8 benchmarks/desktop-latency/run-cursor-control.sh .context/cursor-native native
```

Omit those two environment settings for all three engines and sixty ordinary
inputs each. Native capture width uses `points`, the owned window's logical
width, to avoid unnecessary thumbnail resampling. The recorder still enforces
its 128–2048-pixel bound. It selects only the launched browser process family,
requires an unlocked authorized console and checks at startup that the
owned window fits fully on one display. Foreground and blank/suspended-frame
guards remain active during timed observation. Keep the window fixed and
visible throughout the run. The client also refuses reordered/duplicate frames and retains failure custody while
input dispatch is in flight. Cleanup stops only its recorder and browsers.

The headless replay is passing. Native attempts found and corrected capture
color-space assumptions, then exposed browser/native edge differences. The
revised native-pixel learning path still needs a successful physical replay.
The opt-in `desktop-cursor.spec.ts` now uses this same controller with real
Foot and ScummVM cursor pixels, passive original pointer-event timestamps,
normal guest input and a normally built desktop image. It requires an explicit
`KPERF_DESKTOP_PIXEL_METHOD=1` diagnostic host exposing `__kperf`, private output
(`KPERF_DESKTOP_PIXEL_OUT`) and a compiled `KPERF_PIXEL_MATCHER_BIN`; missing
prerequisites fail. The fixture runs Foot alone, Foot under concurrent ScummVM
load and ScummVM. ScummVM calibration requires its red software cursor, and
verification requires the browser OS cursor to be hidden. It does not paint
a replacement cursor. A native run additionally requires
`KPERF_DESKTOP_PIXEL_NATIVE=1`, `KPERF_NATIVE_CAPTURE_BIN`, an owned visible
window and a newly coordinated unlocked session. This native desktop mode
has not yet passed physical validation.

Headless desktop correlation has passed on all three engines. Failed capture
and geometry attempts remain evidence, including a Firefox screenshot taking
10.03 seconds and a later WebKit geometry failure that is not explained by
replaying the saved raster. A subsequent WebKit run passes; that does not
establish the cause or erase the failure. Continuous motion/drag/resize/scroll,
native display correlation under load, missed-frame accounting and total
capture/matcher overhead remain required for desktop acceptance. This standalone control is
not a Stage B application preview or a native-feel result.
