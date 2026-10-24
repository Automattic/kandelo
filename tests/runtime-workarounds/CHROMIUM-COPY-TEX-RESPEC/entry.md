# CHROMIUM-COPY-TEX-RESPEC

Status: confirmed on Playwright Chromium 153.0.8010.12, macOS, using the
`chromium` channel (new headless). Not filed upstream.

## Defect

A texture initialized with green pixels by `copyTexSubImage2D` can remain
green after `texImage2D` respecifies that image as a smaller blue image.
The new image is framebuffer-complete and `getError()` returns NO_ERROR,
but `readPixels` reads the old copied green pixels. TexImage2D specifies
new image storage and contents; the preceding copy must not override it.
See [OpenGL ES 3.0, section 3.8.3](https://registry.khronos.org/OpenGL/specs/es/3.0/es_spec_3.0.pdf)
and the corresponding WebGL2 TexImage2D contract.

## Why Kandelo is affected

Imported EGLImage textures use native sampling views copied from canonical
BO storage. Orphaning an imported image into an owned candidate previously
copied its old base image before applying a base-level respecification.
Chromium then displayed the old image instead of the caller's new pixels.

## Workaround and its cost

The tagged path in `host/src/webgl/image-storage.ts` omits old base-image
initialization and copying when the command replaces that same base image.
It still preserves texture parameters and commits the candidate only after
acceptance. Non-base respecification and GenerateMipmap still preserve the
existing base pixels. No extra copy or allocation is introduced; no
performance improvement is claimed or measured.

## Evidence

- The three-engine rendered regression initially read old green pixels on
  Chromium; Firefox and WebKit read the new blue pixels. Native FBO identity
  matched the candidate, and the upload contained the correct blue bytes.
- A simple standalone reproduction and a full native-call replay initially
  did not reproduce with Playwright's default `chromium-headless-shell`.
  They reproduced after selecting the same `chromium` channel used by the
  product browser gate. Both main-thread and worker call replays reproduced.
- The standalone page in `repro/` compares the copied case against a
  no-copy control. Both use real WebGL2, framebuffer completeness checks
  and zero-error checks. It reproduced with registry driver Chromium
  153.0.8010.12 on macOS on 2026-10-24. The no-copy control reads blue.
- Using unsized RGBA for the initial allocation did not fix the defect;
  that attempted format-only change was removed.
- The updated product regression passes Chromium, Firefox and WebKit with
  the unchanged blue-pixel assertion, including independent sibling state,
  canonical writes, mipmap/reimport, native failure and final cleanup.

## Why this is not a Kandelo defect

`repro/repro.html` imports no Kandelo code. It allocates two ordinary WebGL
textures and framebuffers, clears the source green, copies into the target,
respecifies the target blue, and reads it. No kernel, protocol, WebAssembly,
shared memory or application code participates. The control differs only
by omitting the preceding copy. The page judges its own pixels and errors.

## Draft upstream report

Title: WebGL2 CopyTexSubImage2D pixels survive subsequent TexImage2D
respecification in Chromium new headless on macOS.

Product/component: Chromium WebGL/ANGLE; backend attribution remains to be
investigated. Reproduces on Playwright Chromium 153.0.8010.12, macOS, new
headless channel. Open `repro/repro.html` with that browser configuration.
Expected: copied case and control both read blue `[0,0,255,255]`, with
NO_ERROR. Actual: copied case reads green `[0,255,0,255]`, while the control
reads blue and both report NO_ERROR. The default headless shell does not
reproduce. No stable-browser version is claimed tested. A person should
verify on current stable Chrome and attach the standalone page before
filing. Reports are human-only.

## Removal criteria

Verify the standalone page on supported released Chrome versions with the
actual graphics backend, then remove the tagged special handling and
rerun the three-engine image-view regression. A passing Playwright build
alone does not establish a released fix. Keep parameter preservation,
transactional candidate replacement and ordinary image orphaning semantics.
