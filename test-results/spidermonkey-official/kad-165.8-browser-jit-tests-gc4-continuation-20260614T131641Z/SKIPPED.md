# kad-165.8 browser jit-tests scope correction

Stopped: 2026-06-14, after overseer scope correction.

Official classification: SKIPPED / out of scope for the current SpiderMonkey
epic. Kandelo's wasm32 SpiderMonkey package is built without JIT support:

- `packages/registry/spidermonkey/build-spidermonkey.sh` writes
  `ac_add_options --disable-jit`.
- `packages/registry/spidermonkey/README.md` lists "JIT disabled" in current
  scope and says JS-facing nested WebAssembly compilation is out of scope
  because it requires a SpiderMonkey wasm JIT backend.

Partial exploratory run preserved here:

- Command: `scripts/run-spidermonkey-official-all.sh --host browser --suite jit-tests --jobs 1 --no-slow --jitflags all --restart-bridge-per-chunk --start-at gc#part-0004`
- Result dir: `test-results/spidermonkey-official/kad-165.8-browser-jit-tests-gc4-continuation-20260614T131641Z`
- `SPIDERMONKEY_OFFICIAL_JIT_CHUNK_SIZE=50`
- Started: `2026-06-14T13:16:41Z`
- Interrupted intentionally by SIGINT after scope correction.
- `summary.tsv` has only the header because the run was stopped mid-chunk.
- `browser-jit-tests-gc#part-0004.log` contains the partial harness result:
  `Passed: 108`, `Failed: 180`.

Exploratory bridge evidence:

- The bridge relaunch patch is preserved in commit `a82c2760`.
- The patched browser bridge survived the previous closed-Chromium
  `browser.newContext: Target page, context or browser has been closed` loop.
- During this partial run the bridge advanced through timeout-heavy GC cases
  from `gc#part-0004` through completed variants of `gc/bug-1620195.js`.
- These observed jit-test failures are not product regressions for the current
  package scope because the engine is intentionally built with JIT disabled.
