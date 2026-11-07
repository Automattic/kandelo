# FIREFOX-OFFSCREEN-CONTEXT-REACQUISITION

Status: confirmed on installed Firefox 159.0, macOS, headless with an
isolated profile. Not filed upstream.

## Defect

A DOM canvas is transferred once to one dedicated worker. The worker
successfully acquires its WebGL2 context, then requests the same context
again on a subsequent message. Firefox 159 throws `InvalidStateError:
Cannot update created context to different thread`. Neither the canvas nor
its rendering context moves to another worker between those calls.
Repeated acquisition should return the existing context.

## Why Kandelo is affected

The scanout presenter, a guest EGL context and replacement graphical
activities all use the same display canvas in the kernel worker. Repeated
native context acquisition could therefore abort the kernel worker when
launching or replacing ScummVM. A subsequent Freeciv launch reports the
same already-failed kernel rather than an independent Freeciv failure.

## Workaround and its cost

`host/src/webgl/canvas-context.ts` caches successful WebGL2 acquisitions in
a weak map keyed by canvas. The scanout presenter, guest EGL bridge and
main-thread forwarding bridge share it. Guest context destruction still
releases guest GL objects and state; it does not destroy the canvas-owned
native context. Refused acquisitions and exceptions are not cached or
suppressed. Context loss/restoration retains the native context identity.

The cache stores no guest memory, adds no cross-realm message, and does
not keep its canvas keys alive. It retains no per-process history. It
does not pretend a fresh native context was created for each guest EGL
context. Drawing-buffer preservation remains enabled for shared-context
readbacks, as it was before this change.

## Evidence

The standalone page imports no Kandelo code, image, Wasm or package. It
reports its own verdict and has an initial context-acquisition sanity
check. Installed Firefox 159 reproduces the same exception in a separate
plain-JavaScript transferred-canvas probe and in the actual app. Bundled
Playwright Firefox 155 and Chromium 153 did not reproduce that probe.
The registered page also reproduces on installed Firefox 159 and reports
`not-reproduced` on bundled Firefox 155, Chromium 153 and WebKit 26.6.
The suite observation for Firefox 155 records the driver's control
baseline, not a released fix for Firefox 159. Sender collection was not
established on Firefox and is not claimed as the cause. Application
validation receipts should be retained alongside subsequent observations.

## Why this is not a Kandelo defect

The standalone probe uses only browser canvas, worker and messaging APIs.
All context access happens in one worker. No Kandelo lifecycle, memory,
filesystem or GL bridge participates. The separate issue of reporting
initial host context-acquisition failures as guest EGL failures rather
than aborting the kernel remains future platform work.

## Draft upstream report

Not filed. Suggested title: Repeated WebGL2 getContext on a transferred
canvas throws a cross-thread InvalidStateError in Firefox 159.
Serve `repro/repro.html`, open it, and read its printed verdict. Expected:
the second call returns the first context. Actual on Firefox 159/macOS:
the second call throws despite both calls running in the same worker.
Use `repro/` as the standalone attachment. No upstream reporting channel
has been authorized for agents.

## Removal criteria

Run the standalone page on released affected Firefox versions and the
bundled control. A newer bundled control alone does not prove Firefox 159
fixed. Remove the workaround designation only after released affected
versions no longer reproduce and same-canvas activity replacement passes.
