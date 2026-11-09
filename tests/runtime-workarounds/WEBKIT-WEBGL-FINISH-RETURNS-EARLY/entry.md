# WEBKIT-WEBGL-FINISH-RETURNS-EARLY

Status: confirmed (Playwright WebKit 26.6, build `webkit-2359`, on macOS;
not yet checked on a released Safari, on iOS, or on Linux).

## Defect

WebGL's `finish()` is specified by reference to OpenGL ES 2.0 section 5.1
(WebGL 1.0 and 2.0, "Writing to the drawing buffer"), with no WebGL
relaxation: "Finish does not return until all effects from previously
issued commands on GL client and server state and the framebuffer are fully
realized." WebKit's `finish()` returns at once while the GPU is still
executing earlier draws. `WebGLRenderingContextBase::finish()` calls the
context's `finish()`, and with the GPU process the `Finish` message of
`RemoteGraphicsContextGL.messages.in` is asynchronous (it is not marked
`Synchronous`, unlike readback messages), so the web process does not wait
for it.

The difference is observable from WebGL: WebGL 2.0 makes `readPixels` block
until all previous rendering into its source framebuffer has finished, and a
1x1 `readPixels` right after `finish()` still takes the whole duration of the
earlier draws.

## Why Kandelo is affected

Guest OpenGL ES 2.0 commands are executed by the host on one WebGL 2 context
in the kernel worker. `glFinish`, `eglWaitClient` and `eglWaitGL` reach the
host as `QOP_FINISH`, which called `finish()`. On WebKit the guest's
`finish()` returned before its rendering had completed. In Kandelo's own
path this was hidden by accident: the host checks `getError` after
`finish()`, and WebKit answers `getError` with a synchronous GPU-process
round trip queued behind the asynchronous Finish, so
`dEQP-GLES2.functional.flush_finish.finish` already saw `glFinish` wait
(9.0 us per draw call, 0.40 us left for the read after it; 13.6 and 0.11
with the workaround). The workaround makes completion explicit instead of
depending on how WebKit happens to answer an error query.

## Workaround and its cost

The same completion as
[`CHROMIUM-WEBGL-FINISH-RETURNS-EARLY`](../CHROMIUM-WEBGL-FINISH-RETURNS-EARLY/entry.md),
in `host/src/webgl/finish.ts` (tagged): after `finish()`, the host copies 4
bytes between two private buffers and reads them back with the blocking
`getBufferSubData`, which returns only after the copy, and so every earlier
command of the context, has completed. WebKit's user agent contains
`AppleWebKit/`, which selects it. With no work outstanding, Kandelo's host
completion measured 0.35 ms per `glFinish` against 0.02 ms for `finish()`
alone (page and worker, 200 calls each).

On WebKit, a synchronous call after `finish()` (for example a 1x1
`readPixels` of an untouched private framebuffer, about 0.01 ms) already
waits, because the GPU process executes the queued `Finish` before
answering. Chromium has no such queued finish, so the buffer copy is used
on both engines.

## Evidence

Reproduction `repro/repro.html` (with `finish.js` and `worker.js`; the same
files as the Chromium entry), run with `driver.mjs` from the
`apps/browser-demos` Playwright 1.63.0 install on 2026-11-02, macOS, Apple
M5 Max:

| Target | Version | Verdict | finish() (ms) | readPixels after finish() (ms), page / worker |
|---|---|---|---|---|
| webkit | 26.6 | reproduced | 0-0.06 | 272-306 of 272 / 248-282 of 247 |
| chromium | 153.0.8010.12 | reproduced (CHROMIUM-WEBGL-FINISH-RETURNS-EARLY) | 0-0.03 | 154-174 of 154 / 274-335 of 279 |
| firefox (control) | 155.0 | not-reproduced | 243-312 | 0.14-0.8 |

The investigation probe described in the Chromium entry gave the same
results on WebKit for `flush()`, `finish()`, a clear then `readPixels` of a
private framebuffer, and the buffer copy (under 0.5 ms left after 282-352 ms
of draws). A fence never signaled within one task.

## Why this is not a Kandelo defect

The reproduction is a static page and a worker script using only WebGL 2,
with no Kandelo code.

## Draft upstream report

Not filed.

- **Product:** WebKit, component WebGL.
- **Title:** WebGL finish() returns before earlier draws complete (ES 2.0
  section 5.1).
- **Summary:** With the GPU process, `finish()` sends an asynchronous
  `Finish` message and returns while the GPU is still executing earlier
  commands. WebGL specifies `finish()` by OpenGL ES 2.0 section 5.1 without
  relaxation.
- **Steps:** serve `repro/` and open `repro.html` (attached).
- **Expected:** `finish()` takes about as long as the earlier draws, and the
  1x1 `readPixels` after it returns at once (Firefox).
- **Actual:** `finish()` returns in under 0.1 ms, and the `readPixels` after
  it takes the whole duration of the draws.
- **Versions:** WebKit 26.6 (Playwright build `webkit-2359`), macOS.

## Removal criteria

Released Safari (macOS and iOS) versions whose `finish()` passes the
reproduction. Then drop WebKit from `webglFinishReturnsEarly` in
`host/src/webgl/finish.ts` (remove the whole completion when no affected
engine remains) and its tests in `host/test/webgl-finish.test.ts`.
