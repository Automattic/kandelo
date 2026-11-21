# WEBKIT-WORKER-ENTRY-EXPORTS

Status: confirmed on Playwright WebKit 26.6/macOS. Native Safari has not been tested.

## Defect

Module Worker entry re-evaluation when a dynamically imported module imports an exported helper back from the Worker entry. A second handler could capture fresh module initialization state while the first handler reports ready. The standalone JavaScript module graph reproduces without a bundler or Kandelo.

## Why Kandelo is affected

The normal browser build already strips unused exports from terminal Worker entries and emits each Worker as one chunk. The new desktop consumer initially omitted that contract. Its generated external-helper chunk imported the kernel Worker entry, which exported a bundler helper. In Playwright WebKit on macOS, both minified and unminified builds reported ready and then failed because the next handler's kernelWorker was undefined. Chromium and Firefox did not fail. Restoring the existing terminal-worker contract passed desktop interaction and capacity recovery in all three engines.

## Workaround and its cost

`apps/browser-demos/vite/worker-entry-exports.ts` removes the generated terminal entry export and verifies that no emitted chunk imports it. Worker builds use inline dynamic imports. This adds a build transform and graph validation; runtime ownership and readiness semantics are unchanged. The plugin is shared by the normal app and desktop consumer. Source-map precision for stripped entry exports is unchanged from the existing plugin.

## Evidence

Local retained evidence: desktop-bundled-browser-2 and desktop-bundled-debug-browser-5 fail after ready; bundled-worker-envelope-1.json records the message sequence; desktop-bundled-browser-6 passes all functional desktop cases plus Chromium/WebKit recovery, and desktop-bundled-pressure-firefox-7 passes Firefox recovery. These integrated results alone were not confirmation. The standalone reproduction imports no Kandelo code: three attempts each reproduce on WebKit 26.6 and do not reproduce on Chromium 153.0.8010.12 or Firefox 155.0. See retained desktop-worker-entry-reduction-3.log. The earlier reduction-2 run returned an unusable verdict object; it is retained as inconclusive, not counted as a pass.

## Why this is not a Kandelo defect

The reduction contains only a module Worker, a dynamic import that imports the Worker entry helper, and a post-readiness probe. No Wasm, shared memory, Kandelo runtime, package, or bundler code is involved. The entry initializes before posting ready, yet the handler receiving the subsequent probe has fresh state only on WebKit. A terminal Worker without this graph is the control.

## Draft upstream report

Not filed; reporting is human-only. Proposed title: Module Worker entry re-evaluation replaces initialized onmessage handler. Product: WebKit, module Workers. Serve repro/ over HTTP, open repro.html, and observe the self-judging result. Expected: after ready, the probe sees initialized=true. Actual on Playwright WebKit 26.6/macOS: initialized=false. Chromium and Firefox controls preserve initialization. Native Safari/released-version confirmation remains for the maintainer.

## Removal criteria

Remove the export transform only when the emitted Worker entries are terminal without it and supported released runtimes preserve initialization on the reduced graph. Keep the build graph invariant even if the synthetic export disappears naturally.
