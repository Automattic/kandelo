# Firefox worker-canvas capture control

This browser/automation diagnostic imports Playwright only. It contains no
Kandelo code, SDK, Wasm, shared memories or product fixture. A worker paints
a fixed scene and a separate green cursor plane. Both transferred canvases
remain owned for the whole run. The controller first observes all expected
visible pixels, then checks 60 captures with exact RGBA assertions. Capture
deadlines remain ten seconds; there are no fixed readiness sleeps.

From the repository root, with the normal browser app dependencies installed:

```sh
scripts/dev-shell.sh env PROBE_SOURCE=gpu \
  node apps/browser-demos/node_modules/@playwright/test/cli.js test \
  --config tests/browser-tooling/firefox-offscreen-capture/playwright.config.ts \
  --repeat-each 3
```

`PROBE_SOURCE=gpu` continuously reads an owned WebGL framebuffer and paints
its pixels. `2d` continuously repaints precomputed pixels without WebGL.
`once` performs the GPU readback/paint once. `CAPTURE_METHOD=viewport`
captures the same canvas bounds through page screenshot; the default uses
element screenshot. Failed captures produce a nonzero exit status. Each
case writes `samples.json`; failures retain a trace and screenshot under
`results/`. The isolated-home launcher matches the repository's existing
macOS Firefox profile setup.

Observed on macOS 27.0.1 arm64, Playwright 1.63.0 / Firefox 155.0:

| Source | Capture | Fixed repetitions | Observed result |
| --- | --- | --- | --- |
| Continuous GPU readback | Element | 3 | All timed out during steady capture, after visible readiness |
| Continuous GPU readback | Clipped page | 1 | Capture timeout |
| Continuous 2D, no WebGL | Element | 3 | All passed, 180 steady pixel captures |
| Once-painted GPU readback | Element | 3 | All passed, 180 steady pixel captures |

Early scratch versions also had initial-paint races and did not explicitly
retain both canvas owners. Their color mismatches are excluded from these
final results. A registered scratch repeat passed once before later runs
failed; a single passing run cannot clear the intermittent failure.

This establishes an independent capture-path failure, without identifying
whether Playwright or the engine is responsible. It does not establish that
every Kandelo presentation failure has the same cause. No product runtime
workaround, browser preference change or graphics platform boundary is
introduced. This is a manual tooling diagnostic, separate from product and
browser-memory conformance. Test-tooling defects are excluded from the
runtime workaround registry by [its policy](../../runtime-workarounds/README.md).

## Canvas bitmap and context diagnostics

`CAPTURE_METHOD=bitmap` serializes the transferred HTML canvas with
`toDataURL("image/png")` under a ten-second deadline. It samples the same
three pixels and twenty steady rounds as the screenshot modes. This
observes the canvas bitmap, not page composition or visible output; it
must not replace product screenshot assertions. The existing `element`
and `viewport` modes retain their screenshot paths and deadlines.

```sh
scripts/dev-shell.sh env PROBE_SOURCE=gpu CAPTURE_METHOD=bitmap \
  node apps/browser-demos/node_modules/@playwright/test/cli.js test \
  --config tests/browser-tooling/firefox-offscreen-capture/playwright.config.ts \
  --repeat-each 3
```

Bitmap runs retain the latest 64 worker readback timing records in
`samples.json`. Each records the sequence, worker start time,
`readPixels` duration and total paint duration. This bounded observation
contains no pixels or shared buffers. Records include the worker source
SHA-256, requested context options and actual context attributes when
available; unsupported attribute queries are recorded as `null`.

The same macOS/Playwright/Firefox versions above produced these additional
fixed runs on 2026-10-29:

| Source | Capture | Repetitions | Observed result |
| --- | --- | ---: | --- |
| Continuous GPU readback | Canvas bitmap | 3 | All timed out; worker `readPixels` stalled 10,002–10,005 ms |
| Once-painted GPU readback | Canvas bitmap | 1 | Passed all 63 initial and steady pixel samples |
| Once-painted, white marker changed to red | Canvas bitmap | 1 | Failed at marker; received red, expected white |
| Once-painted, green cursor changed to blue | Canvas bitmap | 1 | Failed at cursor; received blue, expected green |

The marker control first passed the green cursor and red center probes.
The corrupted-color controls failed with exact color mismatches rather
than acquisition errors. Their worker variants were private diagnostic
copies; the checked-in worker restores the normal white marker and green
cursor. Evidence is under the diagnosing checkout's private
`.context/firefox-landing-bitmap-{positive,final-once,marker-control,cursor-control}*`.

Two continuous-GPU bitmap failures happened during initial acquisition;
one completed its initial probes and reached steady round 1. The once
control demonstrates that this method can acquire and check the transferred
bitmap. The continuous failures show the interaction also occurs outside
Playwright's screenshot operation. They do not distinguish the browser
canvas implementation, graphics driver and automation integration, or
establish that a Kandelo presentation failure has the same cause.

`CONTEXT_HINT=will-read-frequently` requests `{ willReadFrequently: true }`
on the scene and cursor's 2D contexts. `CONTEXT_HINT=desynchronized`
requests `{ desynchronized: true }`. The default `none` uses the original
context construction. Both options are public canvas API diagnostics;
neither changes the source WebGL context or enables browser preferences.
Hinted runs also retain the bounded readback timings. A request does not
prove that the implementation honored the hint; inspect the recorded
attributes where supported.

The two public-hint element-capture controls each failed all three fixed
repetitions. `willReadFrequently` runs recorded worker `readPixels` stalls
of 10,003–20,011 ms; `desynchronized` runs likewise stalled. Firefox did
not expose `getContextAttributes()` on either 2D context, so their actual
accepted backing attributes remain unknown. The source WebGL context's
reported attributes were unchanged (including `preserveDrawingBuffer:
false` and `antialias: true`). Neither hint provides a demonstrated fix;
no option is enabled in Kandelo's runtime or product tests.

These failures retain the original ten-second acquisition/predicate
limits. A measured native `readPixels` duration can exceed that limit:
the deadline fails the test but cannot synchronously cancel a blocked
browser-native call. It does not authorize a longer test deadline.
Hinted-run evidence is under private
`.context/firefox-landing-{will-read,desynchronized}*`.
The original element path also passed a final once-painted control with
all 63 initial and steady samples after adding these diagnostic modes.
