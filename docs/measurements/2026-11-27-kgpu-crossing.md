# kgpu executor backend crossing: per call or batched

## Decision

The kgpu GPU executor keeps one `kgpu_backend` import call per backend
call. An experimental batched variant, which queued void calls in executor
memory and ran them through one `run_batch(ptr, len)` import, did not win
by more than run-to-run spread on two engines. It was deleted, as the
slice 1 plan requires
(`docs/plans/2026-11-27-rust-gpu-slice1-plan.md`, Task 9).

- **Firefox and Chromium:** batching never won. It was 0 to 4 ns per call
  slower in every run.
- **WebKit:** batching won by 5 to 11 ns per call (3 to 6%). Run-to-run
  spread was 9 to 10 ns, so the gain was not clearly larger than noise.
- **Why:** in all three engines, the Wasm-to-JavaScript import crossing is
  a small part of each call's cost. Most of the time goes to the JavaScript
  backend and the WebGL 2 calls it makes, which batching cannot remove.
  Decoding a batch in JavaScript costs about as much as the crossings it
  saves.

The design records this under Backends
(`docs/plans/2026-11-27-rust-gpu-driver-design.md`). This result covers
slice 1's command set. Revisit it with the same bench when commands that
carry more work per call exist, or when a backend other than WebGL 2 is
added.

## Environment

- Source: branch `t3/finish-gles3-webgpu-compat` at `cc3e251e7a`, plus
  the uncommitted, since-deleted batched variant described below.
- Apple M5 Max, 48 GiB RAM, 18 cores, macOS 27.2.1 (26B131).
- Playwright 1.63.0 engine builds: Firefox 155.0 (firefox-1543), WebKit
  26.6 (webkit-2359), Chromium 153.0.8010.12 (chromium-1243, headless).
  These are Playwright's builds, not the shipped Safari, Firefox or Chrome.
- Every page was cross-origin isolated (`crossOriginIsolated === true`),
  so `performance.now()` had its fine-grained resolution.
- Per-call executor: the committed `local-binaries/kandelo_gpu_executor32.wasm`
  (SHA-256 `3e72e980…6857b`), built by `crates/gpu-executor/build-wasm.sh`.
- Batched executor: the same crate built with the same `RUSTFLAGS` and
  `wasm-opt -Oz` as `build-wasm.sh`, plus a temporary `bench-batch`
  feature (SHA-256 `83b0bbba…80065`).

## Method

`apps/browser-demos/test/kgpu-crossing-bench.spec.ts` (tagged `@slow`)
runs the real executor module against the real WebGL 2 backend
(`host/src/kgpu/webgl2-backend.ts`). The backend draws on an
`OffscreenCanvas` on the page's thread. Run it with:

```bash
cd apps/browser-demos
npx playwright test test/kgpu-crossing-bench.spec.ts --project=<engine>
```

- **Workload:** one context is created. Each repetition hands `ge_handle`
  one submit whose stream holds a clear color followed by 10,000
  viewport-and-clear pairs: 20,001 backend calls. The executor decodes and
  validates the whole stream before running it, exactly as in the GPU
  worker.
- **Timing:** only the `ge_handle` call is timed. The record and stream are
  already in executor memory, so ring transport and the stream copy are
  outside the window. They are the same for both variants.
- **Proof of work:** after each repetition, outside the timed window, the
  spec reads the 4x4 surface back. This drains queued GPU work and checks
  that every pixel is 51 102 153 255.
- **Samples:** 3 warm-up repetitions, then 20 timed ones. The figure is the
  median repetition divided by 20,001 calls. During the comparison, the two
  variants ran in one page, each with its own executor instance and WebGL
  context, interleaved repetition by repetition so drift affected both
  alike.
- **Runs:** each engine was run three times, one Playwright run at a time,
  in the order Firefox, WebKit, Chromium. Run-to-run spread is the range of
  the three per-run medians.

A per-call cost averages two kinds of call. A viewport only updates the
backend's per-context record. A clear binds the context's framebuffer and
makes five WebGL state and clear calls.

### The batched variant

With the `bench-batch` feature, the executor's import backend
(`crates/gpu-executor/src/wasm.rs`) appended each `viewport`,
`clear_color` and `clear` call to a word list (`op, context, args…`, with
floats as bit patterns). Before any call whose answer the executor needs
(`create_surface`, `read_pixels`, `is_lost`, `destroy_surface`), and at
the end of every `ge_handle`, it passed that list to one
`kgpu_backend.run_batch(ptr, len)` import. The spec's `run_batch` decoded
the list and made the same backend calls. In each submit, the 20,001 void
imports became one `run_batch` call. The module's other imports did not
change: the built variant imported `create_surface`, `destroy_surface`,
`read_pixels`, `is_lost` and `run_batch`, and no longer imported
`viewport`, `clear_color` or `clear`. Its results came from the same
validation, the same backend and the same pixels.

## Results

Median nanoseconds per backend call. Each cell is one Playwright run; the
range in parentheses is the fastest and slowest of its 20 repetitions.

| Engine | Run | Per call | Batched | Batched − per call |
|---|---|---|---|---|
| Firefox 155.0 | 1 | 73 (64–93) | 77 (67–94) | +4 |
| Firefox 155.0 | 2 | 69 (64–155) | 71 (65–198) | +2 |
| Firefox 155.0 | 3 | 68 (64–77) | 69 (65–84) | +1 |
| WebKit 26.6 | 1 | 189 (185–256) | 183 (179–192) | −6 |
| WebKit 26.6 | 2 | 195 (190–237) | 184 (180–199) | −11 |
| WebKit 26.6 | 3 | 198 (187–256) | 193 (182–218) | −5 |
| Chromium 153 | 1 | 69 (64–72) | 69 (65–72) | 0 |
| Chromium 153 | 2 | 69 (66–72) | 70 (68–77) | +1 |
| Chromium 153 | 3 | 69 (64–75) | 70 (68–76) | +1 |

Summary across the three runs:

| Engine | Per call: median of medians (spread) | Batched: median of medians (spread) | Batched wins by more than spread? |
|---|---|---|---|
| Firefox | 69 ns (5 ns) | 71 ns (8 ns) | No: slower in every run |
| WebKit | 195 ns (9 ns) | 184 ns (10 ns) | No: wins of 5–11 ns against 9–10 ns spread |
| Chromium | 69 ns (0 ns) | 70 ns (1 ns) | No: equal or slower in every run |

After the batched variant was deleted, the committed spec measures only
the per-call executor. It was run once more on each engine: Firefox 81 ns
(69–86), WebKit 194 ns (182–242), Chromium 69 ns (67–95). Firefox's
median came out higher than in the comparison runs. That is consistent
with the run-to-run variation above and does not change the decision.

## What this does not show

- No native Safari, iOS or Android browser was measured.
- The figures are per backend call on one machine. They are not frame
  times or application throughput. No kgpu application exists yet.
- Only slice 1's commands ran (viewport, clear color, clear, read pixels),
  so this does not show how a call that carries more work, such as a
  buffer upload or a draw, compares with its crossing cost.
- The bench ran on a page's thread, not in a GPU worker. The worker would
  add ring transport and the stream copy to both variants equally.
