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
