# CHROMIUM-WEBGL-FINISH-RETURNS-EARLY

Status: confirmed (Playwright Chromium 153.0.8010.12, build `chromium-1243`,
`chromium` channel, on macOS with ANGLE's Metal backend; not yet checked on
a released Chrome or on Linux or Windows).

## Defect

WebGL's `finish()` is specified by reference to OpenGL ES 2.0 section 5.1
(WebGL 1.0 and 2.0, "Writing to the drawing buffer"), with no WebGL
relaxation: "Finish does not return until all effects from previously
issued commands on GL client and server state and the framebuffer are fully
realized." Chromium's `finish()` is a flush: Blink's
`WebGLRenderingContextBase::finish()` calls `ContextGL()->Flush()` with the
comment "Intentionally a flush, not a finish." It returns at once while the
GPU is still executing earlier draws.

The difference is observable from WebGL: WebGL 2.0 makes `readPixels` block
until all previous rendering into its source framebuffer has finished, and a
1x1 `readPixels` right after `finish()` still takes the whole duration of the
earlier draws.

The choice is deliberate on Chromium's side (it avoids pipeline stalls in
pages that call `finish()` every frame), so an upstream fix is unlikely. It
is still a departure from the specification Kandelo implements for its
guests, and Kandelo does extra work because of it, so it is recorded here
rather than as a design boundary Kandelo is built around.

## Why Kandelo is affected

Guest OpenGL ES 2.0 commands are executed by the host on one WebGL 2 context
in the kernel worker. `glFinish`, `eglWaitClient` and `eglWaitGL` reach the
host as `QOP_FINISH`, which called `finish()`. On Chromium the guest's
`glFinish` therefore returned before its rendering had completed, and a
program timing GPU work with `glFinish` measured only command submission.
In `dEQP-GLES2.functional.flush_finish.finish` on Kandelo the time
`glFinish` took per draw call was 0.17 us and the read after it 18.9 us;
with the workaround they are 19.5 us and 0.30 us. (The 772
`performance.shader.operator.*` InternalErrors were first attributed to
this, but those cases time frames with `glReadPixels` and are unchanged by
the workaround; see `docs/graphics/compatibility-v1.md`.)

## Workaround and its cost

`host/src/webgl/finish.ts` (tagged): after `finish()`, on engines whose user
agent contains `AppleWebKit/` (Blink and WebKit), the host copies 4 bytes
between two private buffers with `copyBufferSubData` and reads them back
with `getBufferSubData`. WebGL 2.0 makes `getBufferSubData` block until all
previous writes into its source buffer have finished; the copy is issued
after every guest command, and Chromium's GPU process executes one context's
commands in order, so the read returns only after the guest's work has
completed. Only the two copy bindings change, and they are restored. No
pixel pack state, framebuffer, read buffer or presented image is involved.

Measured in plain WebGL on the probe below: after 270-317 ms of draws, a
1x1 `readPixels` following this completion took under 0.8 ms; following
`finish()` alone it took the full 270-352 ms. With no work outstanding the
copy and read cost about 0.2 ms; Kandelo's host completion, including its
checked save and restore of the copy bindings (each check is a synchronous
`getError`), measured 0.9-1.0 ms per `glFinish` against 0.1 ms for
`finish()` alone (page and worker, 200 calls each). A 1x1 `readPixels` from an untouched
private framebuffer does not wait (it waited once, then returned in under
0.2 ms with all the work still outstanding), so a readback of a private
framebuffer is not a substitute.

The in-order completion the workaround relies on is measured, not a WebGL
guarantee. Firefox shows it does not hold everywhere: there, a clear of an
unrelated framebuffer completed 70-170 ms before earlier draws. Firefox's
`finish()` waits, so Firefox does not use the workaround.

## Evidence

Reproduction `repro/repro.html` (with `finish.js` and `worker.js`), run with
`driver.mjs` from the `apps/browser-demos` Playwright 1.63.0 install on
2026-11-02, macOS, Apple M5 Max. Each context calibrates about 300 ms of
blended full-screen draws into a 512x512 framebuffer, then times `finish()`
and a 1x1 `readPixels` after it, three times. Every draw writes a per-round
tag, and every read checks it, so work that never ran is detected.

| Target | Version | Verdict | finish() (ms) | readPixels after finish() (ms), page / worker |
|---|---|---|---|---|
| chromium | 153.0.8010.12 | reproduced | 0-0.03 | 154-174 of 154 / 274-335 of 279 |
| webkit | 26.6 | reproduced (WEBKIT-WEBGL-FINISH-RETURNS-EARLY) | 0-0.06 | 272-306 of 272 / 248-282 of 247 |
| firefox (control) | 155.0 | not-reproduced | 243-312 | 0.14-0.8 |

An earlier investigation probe in plain WebGL (kept outside the tree with
the run logs) compared completion methods on all three engines, on the page
and in a worker. On Chromium: `flush()` and `finish()` left the work
outstanding; a `readPixels` of the rendered framebuffer, a clear then
`readPixels` of a private framebuffer, and `copyBufferSubData` then
`getBufferSubData` of private buffers all waited for it; `readPixels` of an
untouched private framebuffer did not. A `fenceSync` polled with
`getSyncParameter` and `clientWaitSync(0)` for twice the work duration never
signaled within the task on any engine, as WebGL 2.0 requires ("a sync
object must not become signaled until control has returned to the user
agent's main loop").

## Why this is not a Kandelo defect

The reproduction is a static page and a worker script using only WebGL 2,
with no Kandelo code. Blink's source states the behavior is intended.

## Draft upstream report

Not filed. Because Blink documents the flush as intentional, a report is a
request to reconsider or to document the deviation, not a regression report.

- **Component:** Blink>WebGL.
- **Title:** WebGL finish() returns before earlier draws complete (ES 2.0
  section 5.1).
- **Summary:** `finish()` is implemented as a flush, so it returns while the
  GPU is still executing earlier commands. WebGL specifies `finish()` by
  OpenGL ES 2.0 section 5.1 without relaxation.
- **Steps:** serve `repro/` and open `repro.html` (attached).
- **Expected:** `finish()` takes about as long as the earlier draws, and the
  1x1 `readPixels` after it returns at once (Firefox).
- **Actual:** `finish()` returns in under 0.1 ms, and the `readPixels` after
  it takes the whole duration of the draws.
- **Versions:** Chromium 153.0.8010.12 (Playwright build), macOS.

## Removal criteria

A released Chrome whose `finish()` passes the reproduction on every
supported platform. Then drop Chromium from `webglFinishReturnsEarly` in
`host/src/webgl/finish.ts` (remove the whole completion when no affected
engine remains) and its tests in `host/test/webgl-finish.test.ts`.
