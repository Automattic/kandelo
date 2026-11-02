# FIREFOX-VALIDATE-UNLINKED-PROGRAM

Status: confirmed (Playwright Firefox 155.0 on macOS; not yet checked on a
released Firefox or on Linux or Windows).

## Defect

`validateProgram` checks whether the program's executables can execute in
the current state and stores the answer as `VALIDATE_STATUS`: `true`
guarantees that the program executes, `false` that it does not (OpenGL ES
2.0 and 3.0 reference page `glValidateProgram`; WebGL 2 follows ES 3.0). A
program whose last link failed, or that was never linked, has no executable
and cannot execute (drawing with it is `INVALID_OPERATION`), so validation
must fail. In
Firefox's WebGL 2, `validateProgram` on such a program sets
`VALIDATE_STATUS` to `true`, with no error. Before any `validateProgram` the
status is `false`, as it should be.

## Why Kandelo is affected

Guest `glValidateProgram` and `glGetProgramiv(GL_VALIDATE_STATUS)` were
answered by the browser's WebGL 2 implementation. On Firefox only, a guest
that validated a program whose link failed was told that it could run.
`dEQP-GLES2.functional.state_query.shader.program_validate_status` failed on
Firefox only ("Expected 0; got 1").

## Workaround and its cost

`host/src/webgl/validate-status.ts`: after the engine accepts
`validateProgram`, Kandelo reads the program's `LINK_STATUS` (the value the
guest is answered with) and records whether it had a linked executable.
`GetProgramiv(VALIDATE_STATUS)` (`host/src/webgl/query.ts`) answers `false`
when the last validation found none. As before, a later link does not change
`VALIDATE_STATUS` until the next validation.

It runs on every engine; Chromium and WebKit already answer `false` in that
case, so their answers are unchanged. The cost is one `LINK_STATUS` query per
`glValidateProgram`, which applications call rarely (usually only in debug
builds).

## Evidence

Reproduction: `repro/repro.html`, run with `driver.mjs` (browser-demos
Playwright build) on 2026-11-02, macOS:

| Target | Version | Verdict | VALIDATE_STATUS: link failed / never linked |
|---|---|---|---|
| firefox | 155.0 | reproduced | true / true |
| chromium (control) | 153.0.8010.12 | not-reproduced | false / false |
| webkit (control) | 26.6 | not-reproduced | false / false |

The page's control (a program that links) validates `true` on all three.
dEQP on Kandelo before the workaround:
`functional.state_query.shader.program_validate_status` failed on Firefox and
passed on Chromium and WebKit.

## Why this is not a Kandelo defect

The reproduction is one HTML page using only WebGL 2 and GLSL ES 1.00
shaders, with no Kandelo code. Whether the result comes from Firefox's WebGL
layer or from the macOS OpenGL driver it calls is not known; either way it
is below Kandelo.

## Draft upstream report

Not filed.

- **Product:** Core, Graphics: CanvasWebGL.
- **Title:** WebGL 2: VALIDATE_STATUS is true after validateProgram on a
  program whose link failed.
- **Summary:** `validateProgram` on a program with no linked executable (link
  failed, or never linked) sets `VALIDATE_STATUS` to `true`.
- **Steps:** open `repro/repro.html` (attached).
- **Expected:** `false` for both (`glValidateProgram`: validation succeeds only
  if the program is guaranteed to execute).
- **Actual:** `true` for both.
- **Versions:** Firefox 155.0 (Playwright build), macOS. Chrome and
  Safari/WebKit are correct.

## Removal criteria

When a released Firefox no longer reproduces (record it as
`firefox-stable`, `released = true`), delete
`host/src/webgl/validate-status.ts`, its tagged call in
`host/src/webgl/bridge.ts` and its tagged branch in `host/src/webgl/query.ts`,
keep or drop the validation test in `host/test/webgl-bridge.test.ts`, then
set this entry to `retired`.
