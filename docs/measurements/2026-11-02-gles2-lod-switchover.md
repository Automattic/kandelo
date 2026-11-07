# ES 2.0's switch-over point c = 0.5 and GLSL ES 1.00 only: validation and cost

Date: 2026-11-02. Maintainer decisions D-46 (emulate ES 2.0 section
3.7.9's minification/magnification switch-over point c = 0.5) and D-47
(reject `#version 300 es`, and any version other than 100, in the ES 2.0
context). Tree: `ed4854ae72` (per-face cube maps) plus the two `GLES:`
commits; host-only (no kernel, SDK, program or image rebuild; program and
image artifacts from the r7 build). Playwright Chromium 151.0.7922.34
(ANGLE on SwiftShader), Firefox 153.0 and WebKit 26.5 (both report an
Apple GPU), headless on macOS on Apple silicon. The design is in
`docs/architecture.md` (after the per-face cube maps, and before the
ESSL 3.00 translation for D-47). Results and logs are under
`.context/tex-switchover-runs/` in the graphics workspace.

## Why

ES 2.0 section 3.7.9 makes c = 0.5 when `TEXTURE_MAG_FILTER` is `LINEAR`
and `TEXTURE_MIN_FILTER` is `NEAREST_MIPMAP_NEAREST` or
`NEAREST_MIPMAP_LINEAR` (ES 2.0's initial pair), so a level of detail in
(0, 0.5] magnifies (`LINEAR` on level 0). WebGL 2 applies c = 0 to every
texture (`.context/cube-es2-runs/probes/lod-switchover`: `textureLod` at
0.19 returns the `NEAREST` texel in all three engines), and
`dEQP-GLES2.functional.texture.vertex.cube.filtering.nearest_mipmap_{nearest,linear}_linear_*`
(a constant level of detail of 0.19) failed on every engine.

OpenGL ES 2.0 has one shading language. The host compiled a guest's
`#version 300 es` shader as written, so the ES 2.0 context ran ES 3.0
shaders, which could even link with the host's ESSL 3.00 translation of an
ES 1.00 partner.

## Real-compiler evidence

`node tests/graphics/shader-rewrite-check/run.mjs` (all three engines):
233 pass, 0 fail on Chromium and WebKit; 230 pass, 0 fail on Firefox (its
3 non-passing results are the recorded `FIREFOX-VERTEX-DEPTH-RANGE-UNIFORM`
engine-defect controls, unchanged).

- Section 9, switch-over: for `NEAREST_MIPMAP_NEAREST` and
  `NEAREST_MIPMAP_LINEAR` with `LINEAR` magnification, every pixel of a 16x16
  draw (one point for vertex lookups) equals an ES 2.0 reference (c = 0.5)
  within 4/255: 2D and cube, fragment `texture2D`/`textureCube` at lambda
  0.1, 0.45 and 0.6, with a bias (lambda 0.45 = 0.75 - 0.3), through a
  sampler function parameter and a constant-indexed array element (0.3),
  `texture2DProj` (0.3), and vertex `texture2DLod`/`textureCubeLod` at 0.1,
  0.45 and 0.6: 38 checks per engine. The controls (the same shaders through
  the host path without the switch-over) differ from the ES 2.0 reference
  inside (0, 0.5] in every one of the 30 in-band cases, on every engine.
- Section 8, versions: `#version 300 es`, `#version 310 es` after comments
  and `#version 110` fail with `COMPILE_STATUS` false and an info log such as
  `ERROR: 0:1: '' : unsupported shading language version 300 es; this
  OpenGL ES 2.0 context supports GLSL ES 1.00 (#version 100) only` at the
  directive's line; the control shows WebGL 2 compiling `#version 300 es`;
  `#version 100` (also after a comment) and no directive still compile and
  draw.

`node tests/graphics/essl3-translation-check/run.mjs <out> --deqp
<gles2/shaders>` (dEQP-GLES2's declarative shader cases, including the
preprocessor version cases): 0 newly wrong cases against the native ES 1.00
compile on all three engines (Chromium 2784 of 2793 programs as expected,
Firefox 2781, WebKit 2785; run on the D-47 commit, before the switch-over, whose translation without a sampler set is unchanged).

## dEQP

Selections: `functional.texture`, `functional.fbo` and `accuracy.texture`
(1851 cases), and the full `functional.shaders` family (10252 cases), on
each engine. Baselines: the D-39 final runs (`cube-es2-runs/gles2-<engine>`)
and the ESSL 3.00 translation runs (`glsl300-cts/shaders-<engine>`, with
chunk 102 from `cube-es2-runs/texfn-<engine>`). The runs used the tree at
`74663855cd`, whose runtime and test code the final commits keep unchanged
(only this document, the ledger and `lod-bench.mjs` differ).

| Engine | `texture`, `fbo`, `accuracy.texture` | Newly passing | Newly failing |
|---|---|---|---|
| Chromium | Pass 1633, NotSupported 217, QualityWarning 1 | 6 | 0 |
| Firefox | Pass 1618, Fail 15, NotSupported 217, QualityWarning 1 | 6 | 0 |
| WebKit | Pass 1633, NotSupported 217, QualityWarning 1 | 6 | 0 |

Newly passing on every engine: the six
`texture.vertex.cube.filtering.nearest_mipmap_{nearest,linear}_linear_{clamp,mirror,repeat}`
cases. Still not passing: `fbo.completeness.renderable.texture.color0.rgb_half_float_oes`
(QualityWarning, every engine) and, on Firefox only, the 12
`texture.mipmap.2d.projected.*` and 3 `texture.mipmap.cube.projected.*`
failures of the Firefox triangle-edge level-of-detail defect
(`2026-11-02-firefox-gles2-shader-scope-and-edge-lod.md`), as before.

| Engine | `functional.shaders` | Newly failing | Run time |
|---|---|---|---|
| Chromium | Pass 10246, Fail 4, NotSupported 2 | 0 | 29 min |
| Firefox | Pass 10242, Fail 8, NotSupported 2 | 0 | 71 min |
| WebKit | Pass 10246, Fail 4, NotSupported 2 | 0 | 13 min |

The failures are the known ones: `preprocessor.conditional_inclusion.basic_2`
and `scoping.valid.local_variable_hides_function_parameter` (ANGLE, every
engine) and, on Firefox, `scoping.valid.local_*_hides_struct_type`. All 22
`preprocessor` cases about `#version` and `__VERSION__` pass on every engine.

## Cost

Only draws whose program samples a 2D or cube texture with the filter pair
pay anything at draw time. Each context keeps per-unit sampling traits
(depth image, switch-over filters) of its bound textures in one summary
shared with depth-texture sampling, so a bind looks up only the texture it
binds, and a draw while no unit (nor texture zero) holds such a texture
makes the one comparison it made before.

Host cost (tsx microbenchmarks, `.context/tex-switchover-runs/bench`,
alternating with the base tree `ed4854ae72`; `hot.ts`: medians of 9 runs
of 4e6 calls, five pairs at machine loads of 9 to 12 from other jobs;
`draw-cost.ts`: medians of 7 runs of 2e6 calls through the bridge, two
pairs at load 10 to 20, so those figures are noisier):

| Path | This tree | Base |
|---|---|---|
| `drawVariantExecutable` for a program whose textures are `LINEAR` (every compositor draw) | 12.6-15.2 ns | 14.4-16.8 ns |
| `bindImageObject(TEXTURE_2D)`, two textures in turn | 43.4-51.3 ns | 45.1-53.5 ns |
| `glTexParameteri(MIN_FILTER, LINEAR)` through the bridge, unchanged value | 642-675 ns | 616-661 ns |
| whole `glDrawArrays` through the bridge, no-op renderer, plain program | 1.08-1.11 us | 1.07-1.11 us |
| `drawVariantExecutable`, cached switch-over variant | 198-205 ns (124-131 at load 9) | - |
| whole `glDrawArrays`, switch-over variant (no-op renderer) | 2.05-2.08 us (1.27-1.39 at load 9) | - |

A first version that counted the switch-over units separately from depth
units cost 0.8-1.1 ns more per draw and 13-15 ns more per bind (two more
WeakMap lookups); sharing one summary, remembering each unit's previous
traits, and returning early from an unchanged `TexParameter` brought both
back within run-to-run noise. A switch-over draw also pays the variant's
two native `useProgram` calls, as every variant does.

Shader cost (`node tests/graphics/shader-rewrite-check/lod-bench.mjs`): a
1024x1024 quad with 1, 4 or 16 lookups per fragment of a 256x256
`NEAREST_MIPMAP_LINEAR`/`LINEAR` texture, median of 5 batches of about one
second. The Apple figures are a few microseconds per draw against a 1 ms
timer and bound the ratio only.

| Engine | 2D, 1 / 4 / 16 lookups (without, with) | Cube, 1 / 4 / 16 lookups (per-face, with) |
|---|---|---|
| Chromium (SwiftShader, CPU) | 1.37 / 1.55 ms (1.13x), 4.61 / 5.17 ms (1.12x), 18.2 / 21.4 ms (1.17x) | 4.68 / 2.02 ms (0.43x), 19.2 / 6.77 ms (0.35x), 73.2 / 28.1 ms (0.38x) |
| Firefox (Apple GPU) | 0.004 / 0.006 ms (1.45x), 0.010 / 0.016 ms (1.61x), 0.052 / 0.087 ms (1.66x) | 1.02x, 0.98x, 1.00x (0.018 to 0.202 ms) |
| WebKit (Apple GPU) | 0.004 / 0.007 ms (1.55x), 0.010 / 0.021 ms (2.21x), 0.044 / 0.084 ms (1.93x) | 1.08x, 1.01x, 1.04x (0.015 to 0.183 ms) |

A 2D lookup through a switching sampler costs about 1.1x (SwiftShader) to
2x (Apple GPUs) a native one: two derivatives, `textureSize`, a `log2` and
`textureLod`. A cube lookup costs the same as the per-face lookup on the
Apple GPUs, and less on SwiftShader, whose `textureGrad` is slower than its
`textureLod`. These figures are from runs after the dEQP matrix; runs made
while dEQP was using the GPU were noisier (Apple 2D 1.4x to 6x).

Building a variant (translation, two ESSL 3.00 compiles and a link, once
per program and sampler set): Chromium 1.32 ms against 0.37 ms for the ES
1.00 program, Firefox 2.3 against 1.55 ms, WebKit 1.1 against 0.75 ms; the
translation itself 0.05-0.10 ms.

## Not run

`./run.sh test browser-memory`, the browser demos and the compositor specs
(their textures are `LINEAR`, so their draw path takes the unchanged early
exit, measured above), native Safari, and the Node host's dEQP.
dEQP-EGL was not rerun (no EGL path changed).
