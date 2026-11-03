# FIREFOX-SAMPLER-ARRAY-DISPATCH-LINK-CRASH

## Behavior and scope

On macOS, Firefox 153.0 closes while linking a WebGL 2 program whose GLSL
ES 3.00 fragment shader selects an element of a sampler-array function
parameter with a switch and passes the selected sampler to another function.
The standalone HTML reproduction imports no Kandelo code. Compile failures
are inconclusive; a page/browser crash during link is a reproducing result.
A completed successful link is not reproduced.

## Workaround

The translated sampler-array lookup dispatcher in
`host/src/webgl/sampler-arrays.ts` passes each sampler as a scalar parameter.
It still selects exactly one constant-index lookup, with the original
coordinates evaluated once. No browser test or per-draw host branch is added.
Shaders without an indexed sampler lookup get no dispatcher.

## Evidence

Standalone checks on 2026-11-03, macOS, using the host Playwright installation:

| Engine | Version | Array parameter | Scalar parameters |
|---|---|---|---|
| Firefox | 153.0 | browser closes during link | links |
| Chromium | 151.0.7922.34 | links | links |
| WebKit | 26.5 | links | links |

The complete shader harness also closes on the array-parameter form at its
first new cube-array loop case. The registry driver also reproduces the crash on Firefox 155.0. The scalar
form completes the expanded Firefox 153.0 harness (263 passing checks, one
inconclusive result and two existing engine controls). Chromium and WebKit
pass 266 checks each. Distinct bound textures verify index selection; the
checks also cover guest function forwarding, inout arguments, struct returns
and c = 0.5 variants.

## Retirement check

Run the standalone reproduction on a released Firefox version. Once it
links without a crash, rerun the complete real-compiler harness with sampler
array parameters before removing the scalar-parameter form.

## Draft upstream report

Not filed. Product: Core, Graphics: CanvasWebGL. Title: WebGL 2 browser crash
while linking a switch that forwards sampler-array elements to another
function. Open `repro/repro.html`; expected: link succeeds or is rejected
with a diagnostic, without closing the browser. Observed: Firefox closes.
