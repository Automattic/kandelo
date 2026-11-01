# FIREFOX-VERTEX-DEPTH-RANGE-UNIFORM

Status: confirmed (Playwright Firefox 155.0 on macOS; not yet checked on a
released Firefox or on Linux).

## Defect

GLSL ES 1.00 section 7.5 and OpenGL ES 2.0 section 2.12.1 make the built-in
uniform `gl_DepthRange` hold the current depth range (near, far, far - near)
in every shader stage. In Firefox's WebGL 2, when **both** the vertex and the
fragment shader read `gl_DepthRange` **and** the program has at least one
other active uniform (in either stage), the vertex stage reads wrong values:
`gl_DepthRange.near` is the value of one of the other uniforms, and `far` and
`diff` are 0. The fragment stage's `gl_DepthRange` is correct. A program
without another uniform, or where only one stage reads `gl_DepthRange`, is
correct.

## Why Kandelo is affected

Guest OpenGL ES 2.0 programs are compiled by the browser's WebGL 2
implementation. Any guest program whose shaders both read `gl_DepthRange`
and that has another uniform renders with a wrong vertex-stage depth range
on Firefox, and only there, so the same guest behaves differently on
Firefox and on the other engines.

## Workaround and its cost

`host/src/webgl/vertex-depth-range.ts` (and the tagged lines in
`host/src/webgl/reversed-depth.ts`): on Firefox (`Firefox/` in the user
agent), for a linked program whose vertex and fragment sources both read
`gl_DepthRange` and which has another active uniform, draws run a private
variant of the program. Its vertex stage reads the depth range from a
private `vec3` uniform (`kandelo_native_depth_range_values`) holding the
values WebGL would supply (the ordered native range and its float32
difference), set before each draw when the range changed. The fragment
stage is unchanged, and the guest's reflection, uniform values and info logs
still come from its own program. The variant composes with the reversed
depth-range and depth-texture variants (the redirection is applied last).

Cost: one extra program link per affected program (and per combination with
the other variants), one `uniform3f` when the depth range changes, and one
uniform row of the vertex stage's budget. On Firefox the host therefore
reports `MAX_VERTEX_UNIFORM_VECTORS` one below the native limit
(`guestLimit` in `host/src/webgl/limits.ts`), so a guest program within the
reported limit always leaves room for the variant's uniform; a variant that
still cannot link refuses the draw with INVALID_OPERATION, as the other
variants do. Programs that do
not meet the trigger, and every program on other engines, are unchanged.

## Evidence

Reproduction: `repro/repro.html`, run with `driver.mjs` (browser-demos
Playwright build) on 2026-11-01, macOS:

| Target | Version | Verdict | Vertex-stage (near, far, diff) |
|---|---|---|---|
| firefox | 155.0 | reproduced | test (0.502, 0, 0); control (0.251, 0.749, 0.502) |
| chromium (control) | 153.0.8010.12 | not-reproduced | (0.251, 0.749, 0.502) in both |
| webkit (control) | 26.6 | not-reproduced | (0.251, 0.749, 0.502) in both |

The test program sets the other uniform to 0.5; Firefox's vertex stage reads
0.5 as `near`. Playwright Firefox 153.0 (host Playwright 1.62.1) gives the
same result in a manual probe, which also showed:

- only the fragment stage reading `gl_DepthRange`, or no other uniform:
  correct;
- the other uniform in the vertex stage instead (value 0.875): the vertex
  stage reads 0.875 as `near`;
- two other uniforms: `near` reads one of them.

`tests/graphics/shader-rewrite-check` records the same failure as an
"engine-defect" control on unrewritten shaders and checks that the workaround
variant gives the right values in Chromium, Firefox and WebKit.

## Why this is not a Kandelo defect

The reproduction is one HTML page using only WebGL 2 and GLSL ES 1.00
shaders, with no Kandelo code. Its control program (no other uniform) gives
the correct depth range on the same engine, so the test's failure comes from
the presence of another uniform, which must not affect `gl_DepthRange`.

## Draft upstream report

Not filed.

- **Product:** Core, Graphics: CanvasWebGL.
- **Title:** WebGL 2: vertex-shader gl_DepthRange reads another uniform's
  value when the fragment shader also reads gl_DepthRange.
- **Summary:** With GLSL ES 1.00 shaders where both stages read
  `gl_DepthRange` and the program has another active uniform, the vertex
  stage's `gl_DepthRange.near` equals that uniform's value and `far`/`diff`
  are 0.
- **Steps:** open `repro/repro.html` (attached). It calls
  `depthRange(0.25, 0.75)`, draws one point whose vertex shader writes
  `gl_DepthRange` into a varying, and reads the pixel.
- **Expected:** (0.25, 0.75, 0.5) in the control and test programs.
- **Actual:** control (0.25, 0.75, 0.5); test (0.5, 0, 0).
- **Versions:** Firefox 155.0 and 153.0 (Playwright builds), macOS. Chrome
  and Safari/WebKit are correct.

## Removal criteria

When a released Firefox no longer reproduces (record it as
`firefox-stable`, `released = true`), delete
`host/src/webgl/vertex-depth-range.ts`, the tagged lines in
`host/src/webgl/reversed-depth.ts`, `host/test/webgl-vertex-depth-range.test.ts`
and the `vertex-depth-range` / `with-workaround` checks in
`tests/graphics/shader-rewrite-check/checks.ts`, then set this entry to
`retired`.
