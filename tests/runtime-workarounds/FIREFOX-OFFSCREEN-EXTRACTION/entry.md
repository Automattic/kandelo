# FIREFOX-OFFSCREEN-EXTRACTION

Status: confirmed for pixel extraction on the development build below.

## Defect

An opaque-red worker-painted WebGL canvas can be copied into an independent
2D canvas as transparent black. The synchronous copy sometimes takes about
10 seconds. The source uses `preserveDrawingBuffer: true`, is never
cleared to transparent, and remains alive. A separate native WebGL source
performs periodic `readPixels` in the same worker.

The HTML Standard defines the placeholder canvas's paint source as its
bitmap, and `drawImage` copies that source into the destination. The
[canvas and drawing-images contracts](https://html.spec.whatwg.org/multipage/canvas.html#drawing-images)
do not specify replacing a stable opaque source with transparent pixels
because another canvas is being read. The reproduction asserts pixel
content; the recorded durations are diagnostic evidence, not a timeout
substitute for the pixel verdict.

## Why Kandelo is affected

Kandelo's graphics worker owns visible transferred scene/cursor canvases
and performs native GPU readback. A read-only probe of normal Cage source
`5aab344fe0e7d156fd409b86fd48cc895b19c7d5` observed `drawImage` into an
independent buffer return transparent pixels after approximately 10 seconds.
The production canvas's identity, size, layout, visibility and opacity
remained unchanged.

This entry covers the independent extraction failure only. Cage's whole
canvas sometimes appearing as page background in Firefox screenshots and
the separate Firefox cursor rendering failure remain open. No shared cause
or performance diagnosis is established by this reproduction.

## Workaround and its cost

None. This is an evidence-only record. No runtime preferences, browser
flags, product code, thresholds, retries or acceptance assertions change.
No compatibility baseline item is waived or reclassified as a boundary.

## Evidence

On macOS 27.2 (26B123) arm64, Playwright 1.63.0 / bundled Firefox 155.0
(`firefox-1543`), the initial standalone page painted the visible scene
through WebGL2, retained a second visible cursor plane, and performed
64-by-64 readback from a separate native context every 16 milliseconds.
Its own pixel-judging function detected two transparent results among
20 attempts (10,010 and 10,000 milliseconds). All 20 accompanying
screenshots still showed the correct red pixel; they took 16–73
milliseconds. This is not a standalone reproduction of the screenshot
failure.

An autonomous variant called the same pixel judge without taking any
screenshots. Readback disabled: 20/20 samples remained opaque red.
Readback enabled: 9/20 samples returned transparent black after
10,000–10,011 milliseconds. The other 11 remained opaque red. The page
computed its own failing verdict before any failure screenshot.

Private original evidence is retained under the immutable 5a checkout's
`.context/cage-{owned-readback-5a,direct-cursor-control-5a,detached-cursor-control-20,autonomous-owned-5a}-*`
paths. The checked-in reproduction adds an initial opaque-red sanity
phase, then enables native readback and reports immediately on an actual
transparent result. Missing WebGL, failed sanity, lost contexts, GL errors or unexpected pixels
produce `inconclusive` rather than an incorrect defect verdict.

The checked-in pixel-judging reproduction then reproduced on all three
registry-driver attempts on Firefox 155.0. Each attempt passed all five
opaque-red sanity checks before enabling native readback. The final
attempt's first enabled copy returned transparent black after 10,008
milliseconds. The driver reported `reproduced`, not a harness timeout.

Control driver runs on Chromium 153.0.8010.12 and WebKit 26.6 each
preserved all 20 enabled-readback samples (plus five sanity samples) and
reported `not-reproduced` on the same macOS host. These are controls, not
evidence that Firefox was fixed.

The required registry check reported 11 entries and 38 tag sites consistent.
The selected registry run reproduced and matched the Firefox observation,
with no changed, unrecorded, inconclusive, skipped or harness-failure result.
The final revision also reproduced on 3/3 attempts with the terminal
worker-health guard: the last failed copy took 10,010 milliseconds,
both native contexts remained live, both GL error queues were clear, and
the scene remained 1088 by 612 pixels.

A profiled actual-Cage repeat captured normally (46/41 milliseconds), so
its native profile cannot establish the cause of a stalled capture.
Historical source/profile hypotheses are not treated as proof for the
remaining screenshot or cursor failures.

## Why this is not a Kandelo defect

The reproduction uses only HTML, standard canvas APIs and a dedicated
worker. It imports no Kandelo code and uses no Wasm, kernel, shared memory,
package artifacts, guest software or screenshots. Both contexts remain
owned, the source stays opaque red, and five successful extractions of the
same pixel precede enabling readback. The verdict compares its own
independent bytes with the expected red and alpha values. A transparent
result counts only after the worker confirms both native contexts are
live, both GL error queues are clear, and the scene dimensions remain
unchanged.

The precise internal browser synchronization mechanism remains unknown.
This record does not identify a cause for every presentation failure in
Kandelo.

## Draft upstream report

Not filed; reports are human-only.

Title: Worker WebGL canvas extraction intermittently returns transparent
pixels during another context's readPixels.

Serve `repro/` with a normal HTTP server and open `repro.html`. The page
first checks five opaque-red copies, enables continuous readback in the
same worker, then checks up to 20 further copies. It prints its own
`reproduced`, `not-reproduced` or `inconclusive` verdict. The registry driver
also provides cross-origin isolation and repeats the page three times.
`repro.html?control=1` leaves native readback disabled for the control.
Expected: every copy of the opaque source remains opaque red. Actual on
the observed build: a copy can block about 10 seconds and return all-zero
RGBA instead. No upstream matching issue or report is claimed.

## Removal criteria

There is no product workaround to remove. Preserve this regression record
until a released affected browser no longer reproduces, with exact version
and OS evidence. A development-build non-reproduction alone is insufficient
for `fixed-upstream`. Resolve the actual Cage screenshot and cursor cases
through their own unchanged acceptance tests.
