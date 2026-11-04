# Physical desktop cursor measurement method, 2026-11-04

The real desktop cursor pipeline now has a passing physical Chromium method
run. This establishes observable input-to-display bounds on an older frozen
partial-B1 desktop. It does not establish native feel or final acceptance.

## Run and identities

- Job: `graphics-native-desktop-r214-1104-184050-35db`, PASS41seconds.
- Command, through `scripts/dev-shell.sh` and `scripts/agent-job`:
  `bash "$graphics_workspace/.context/graphics-native-desktop-r214/run.sh"`,
  where `graphics_workspace=/Users/brandon/conductor/workspaces/kandelo/moscow`,
  from its integration worktree; it launches the desktop cursor Playwright spec, Chromium only,
  one worker, private output, headed browser and unique port6034.
- macOS27.2 build26B123; Chromium153.0.8010.12; observed display60Hz.
- Host: frozen `graphics-kperf-b1-r17` at52fd558998 with its recorded
  instrumentation patch. Normal producer: `graphics-b1-preview-r16`
  at07321b7bc4. The runner retains complete heads/patches, binary hashes,
  and all313 normal-product hashes, verified before and after the run.
- These are older compatible producer/host inputs. They are not the current
  integration source, the public preview's complete identity or a full B
  prototype. No source/product changes or competing builds/GPU tests were
  introduced during the visible timed run.
- Evidence root: `.context/graphics-native-desktop-r214/` in the main
  workspace; per-cohort `result.json`, calibration rasters, observer rows,
  input events, process inventories and kperf counters are retained.

The recorder verifies console unlock/capture authorization, the owned
browser process family, foreground window and display bounds. Viewport
markers fit CSS coordinates to window pixels. Each actual guest cursor
pose is learned from changed pixels and independently validated in fresh
frames; ScummVM requires its red software cursor. The OS cursor is excluded.
Samples pair the original browser pointer-event timestamp with real
WindowServer response frames. The preceding non-response frame, capture
coalescing and clock uncertainty remain in the reported interval. No
worker acknowledgement, screenshot completion or animation callback is
substituted for display time. No-op input controls must produce no new
response. The test rejects missing/unplanned inputs and memory-boundary
violations.

## Diagnostic observations

SFWBar is present throughout. “Foot” means no concurrent ScummVM, not a
bar-free desktop. ScummVM is its live launcher with the real application
cursor, not game-play FPS. There are only eight responses per cohort.

| Cohort | Responses | p50 bounds (ms) | p95 bounds (ms) | Matcher p95 (ms) |
| --- | --- | --- | --- | --- |
| Foot | 8 | 26.4–48.4 | 90.3–112.0 | 0.040 |
| Foot with ScummVM | 8 | 20.2–43.0 | 27.2–49.6 | 0.028 |
| ScummVM cursor | 8 | 26.8–48.4 | 41.6–63.7 | 0.045 |

All three no-op controls pass. The timed frames have zero ambiguous or
unmatched classifications. Matcher cost alone excludes capture, transfer,
clock sampling, kperf and observer process overhead; it is not a total
instrumentation-overhead measurement. Small diagnostic quantiles are not
stable latency-tail estimates. The final source/artifact tree must still
be measured on Chromium, Firefox and WebKit with and without SFWBar,
concurrent applications, all required interactions, distributions, missed
frames, idle CPU and total instrumentation overhead. No improvement over
main or an intermediate application build is claimed.

## Calibration fixes and preserved failures

R208 (`graphics-native-desktop-r208-1104-183736-52e7`) fails before samples:
its fitted horizontal scale1.000037 maps the63-CSS-pixel patch to65 raster
pixels after outward rounding, exceeding the previous64-pixel bound.
Both TypeScript learning and Swift matching now allow bounded128-pixel
rectangles while retaining the256-point and total-comparison budgets.

R213 (`graphics-native-desktop-r213-1104-183856-6218`) passes the scale
check but rejects all three calibration attempts for insufficient changed
pixels at the requested pose. Its native raster and a separate DevTools
screenshot show different cursor positions, with an intervening input
batch retained in kperf. Extra screenshot activity or physical pointer
interference was suspected; a browser defect was not established. Native
calibration now uses only its already retained WindowServer rasters.
R214 then passes; all failed records remain intact. The method does not
accept a background template or weaken matching tolerances to pass.

R215 (`graphics-pixel-controls-r215-1104-184223-2d0b`) runs
`bash benchmarks/desktop-latency/run-pixel-control.sh <private-output>`
through the dev shell:396 assertions pass across Chromium/Firefox/WebKit,
each with DOM and OffscreenCanvas output. Positive65/128-pixel regions
match in the actual shared Swift classifier, while129-pixel regions,
truncated rasters, invalid geometry, ambiguous identities, excessive
comparison budgets and no-change templates retain their failure controls.
These are headless classification controls, not physical timing.

No runtime/ABI, SDK, kernel, package or public preview change is part of
this measurement-method checkpoint. The final source differs from the
frozen native-run controller only in comments; its execution logic is
unchanged. The final matcher controls cover the committed bounds.
