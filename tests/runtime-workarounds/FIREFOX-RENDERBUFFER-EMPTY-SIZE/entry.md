# FIREFOX-RENDERBUFFER-EMPTY-SIZE

Status: confirmed (Playwright Firefox 155.0 on macOS; not yet checked on a
released Firefox or on Linux or Windows).

## Defect

OpenGL ES (2.0 and 3.0, which WebGL 2 follows) makes `RENDERBUFFER_WIDTH`
and `RENDERBUFFER_HEIGHT` the width and height of the renderbuffer's image,
the one last specified by `renderbufferStorage` (reference pages
`glGetRenderbufferParameteriv` and `glRenderbufferStorage`). A zero width
or height is valid; only a negative size or one above
`MAX_RENDERBUFFER_SIZE` is an error. In Firefox's
WebGL 2, after `renderbufferStorage` with one zero dimension, both queries
return 0: storage of 0x29 reads back as 0x0, and so does 29x0. No error is
raised. Storage with two non-zero dimensions reads back correctly.

## Why Kandelo is affected

Guest OpenGL ES 2.0 queries of a renderbuffer's size were answered by the
browser's WebGL 2 implementation. On Firefox only, a guest that specified a
zero-width (or zero-height) image read the other dimension as 0, so the same
guest saw different state on Firefox than on the other engines.
`dEQP-GLES2.functional.state_query.rbo.renderbuffer_size` failed on Firefox
only ("Expected 29; got 0" after `glRenderbufferStorage(GL_RENDERBUFFER,
GL_RGBA4, 0, 29)`).

## Workaround and its cost

`host/src/webgl/object-query.ts` answers `RENDERBUFFER_WIDTH` and
`RENDERBUFFER_HEIGHT` from the size Kandelo records for every accepted
`glRenderbufferStorage` call (`renderbufferRecordedSize` in
`host/src/webgl/image-sizes.ts`). The record already existed: ES 2.0
framebuffer completeness (FRAMEBUFFER_INCOMPLETE_DIMENSIONS) is decided from
it. A rejected call does not change it. Renderbuffers that are views of an
EGLImage were already answered from the image. A renderbuffer with no
storage yet still asks the engine (0x0 on every engine).

The record is used on every engine; Chromium and WebKit report the same
values natively. The cost is a map lookup in place of a native query.

## Evidence

Reproduction: `repro/repro.html`, run with `driver.mjs` (browser-demos
Playwright build) on 2026-11-02, macOS:

| Target | Version | Verdict | 0x29 / 29x0 / 0x0 read back as |
|---|---|---|---|
| firefox | 155.0 | reproduced | 0x0 / 0x0 / 0x0 |
| chromium (control) | 153.0.8010.12 | not-reproduced | 0x29 / 29x0 / 0x0 |
| webkit (control) | 26.6 | not-reproduced | 0x29 / 29x0 / 0x0 |

The page's control (84x66) reads back correctly on all three. dEQP on
Kandelo before the workaround: `functional.state_query.rbo.renderbuffer_size`
failed on Firefox and passed on Chromium and WebKit.

## Why this is not a Kandelo defect

The reproduction is one HTML page using only WebGL 2, with no Kandelo code.
Whether the value is lost in Firefox's own WebGL bookkeeping or in the
macOS OpenGL driver it runs on is not known; either way it is below Kandelo.

## Draft upstream report

Not filed.

- **Product:** Core, Graphics: CanvasWebGL.
- **Title:** WebGL 2: getRenderbufferParameter returns 0 for both dimensions
  after renderbufferStorage with one zero dimension.
- **Summary:** `renderbufferStorage(RENDERBUFFER, RGBA4, 0, 29)` succeeds,
  but `RENDERBUFFER_HEIGHT` then reads 0 instead of 29 (and 29x0 reads
  `RENDERBUFFER_WIDTH` 0).
- **Steps:** open `repro/repro.html` (attached).
- **Expected:** 0x29, 29x0 and 0x0 read back as specified.
- **Actual:** all three read back as 0x0.
- **Versions:** Firefox 155.0 (Playwright build), macOS. Chrome and
  Safari/WebKit are correct.

## Removal criteria

When a released Firefox no longer reproduces (record it as
`firefox-stable`, `released = true`), the query may ask the engine again:
delete the tagged lines in `host/src/webgl/object-query.ts` and
`renderbufferRecordedSize` in `host/src/webgl/image-sizes.ts`, keep or drop
the size test in `host/test/webgl-bridge.test.ts`, then set this entry to
`retired`.
