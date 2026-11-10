# ES 2.0 cube maps sampled per face: validation and cost

Date: 2026-11-02. Maintainer decision D-39: emulate OpenGL ES 2.0's
per-face cube-map sampling on WebGL 2. Tree: `c0bf2a465d` (GLES: Sample
ES 2.0 cube maps per face) on `6570a65e20` for the full selection below,
and `eaea028053` (a refactor of the per-draw lookup) for the recheck of
the cube groups; host-only (no kernel, SDK, program or image rebuild;
program and image artifacts from the r7 build). Playwright Chromium 151.0.7922.34 (ANGLE on SwiftShader),
Firefox 153.0 and WebKit 26.5 (both report an Apple GPU), headless on
macOS on Apple silicon. The design is in `docs/architecture.md` (cube
maps, after the ESSL 3.00 translation).

## Why

ES 2.0 sections 3.7.5 and 3.7.7 select a face by the major axis and then
wrap and filter within that face. WebGL 2 follows ES 3.0, where cube-map
sampling is always seamless. A standalone page with no Kandelo code
(`.context/cts-fix-limits-texture-runs/cube-seam-repro` in the graphics
workspace) samples a 4x4 cube map with solid faces just inside +X near
+Y with LINEAR filtering: ES 2.0 gives pure +X red; all three engines
return red mixed with +Y blue (132/0/123), in fragment and vertex
shaders alike. dEQP-GLES2 builds per-face references for an ES 2.0
context (`es2fTextureMipmapTests.cpp`, `es2fVertexTextureTests.cpp`,
`es2fShaderTextureFunctionTests.cpp`), so its cube cases failed at face
edges on every engine.

## Real-compiler evidence

`node tests/graphics/shader-rewrite-check/run.mjs` compiles, links and
draws the translation with each engine's WebGL 2 compiler (section 7 of
`checks.ts`). All cube checks pass on all three engines:

| Check | Result (Chromium, Firefox, WebKit) | Control |
|---|---|---|
| fragment `textureCube`, vertex `textureCube` and `textureCubeLod`, LINEAR at a face edge | pure +X red | native cube map: 0.52/0/0.48 (seamless) |
| orientation: the four quadrants of all six faces (NEAREST) | all 24 equal the native cube map | — |
| level of detail over a 32x32 quad crossing four face edges (64x64 faces, NEAREST_MIPMAP_NEAREST, 7 levels), bias 0 and 1.5 | every pixel at the ES 2.0 level (floor or ceil of the analytical lambda) | `texture()` on the array with implicit derivatives: 48 (Chromium) and 64 (Firefox, WebKit) pixels at level 4 or smaller |
| guest declarations: `lowp`/`mediump`/`highp` samplers, precision statement, function parameter, array element, struct member, builtin overload | sample +Y; the fragment shader compiles as ESSL 3.00 | — |

## dEQP

Selections: `functional.texture`, `functional.fbo`,
`functional.state_query`, `functional.negative_api` and
`accuracy.texture` (2493 cases); chunk `functional.shaders#102`, which
holds all of `functional.shaders.texture_functions` (52 cases); and
dEQP-EGL `functional.image` and `functional.sharing` (1498 cases).
Baselines: the 2026-11-01 full runs (`graphics-validation-r2`) and, for
`functional.shaders`, the ESSL 3.00 translation runs (`glsl300-r1`).
Results and logs are under `.context/cube-es2-runs/` in the graphics
workspace.

| Engine | GLES2 selection | Newly passing | Newly failing | texture_functions | EGL image + sharing |
|---|---|---|---|---|---|
| Chromium | Pass 2260, Fail 6, NotSupported 226, QualityWarning 1 | 16 | 0 | Pass 52 (texturecubelod newly) | Pass 1371, NotSupported 127 |
| Firefox | Pass 2245, Fail 21, NotSupported 226, QualityWarning 1 | 15 (+2 `state_query` cases from the earlier Firefox workarounds) | 0 | Pass 52 (texturecubelod newly) | Pass 1371, NotSupported 127 |
| WebKit | Pass 2260, Fail 6, NotSupported 226, QualityWarning 1 | 16 | 0 | Pass 52 (texturecubelod newly) | Pass 1371, NotSupported 127 |

Newly passing on every engine: `texture.mipmap.cube.{basic,bias}.linear_{linear,nearest}`,
`texture.mipmap.cube.projected.linear_nearest`,
`texture.mipmap.cube.projected.linear_linear` (Chromium, WebKit),
`texture.vertex.cube.wrap.{clamp,mirror}_{clamp,mirror,repeat}` (6),
`texture.vertex.cube.filtering.linear_mipmap_linear_{linear,nearest}_{clamp,mirror}` (4)
and `shaders.texture_functions.vertex.texturecubelod`. Of the 56 EGL
cases that name cube maps, 32 pass and 24 are NotSupported, as before;
the EGL newly-passing cases against `graphics-validation-r2` come from
the EGL runner fixes merged since, not from this change (there is no
WebKit EGL baseline in that round; WebKit's counts equal the other
engines').

Recheck on the final tree (`eaea028053`): `functional.texture` (976
cases), `functional.shaders#102` and dEQP-EGL `functional.image` on all
three engines gave the same per-case results as above (Chromium and
WebKit: Pass 898, Fail 6, NotSupported 72; Firefox: Pass 883, Fail 21,
NotSupported 72; Pass 52; EGL image Pass 99, NotSupported 127).

Still failing:

- `texture.vertex.cube.filtering.nearest_mipmap_{nearest,linear}_linear_{clamp,mirror,repeat}`
  (6, every engine). ES 2.0 section 3.7.9 makes the
  minification/magnification switch-over point c = 0.5 when the
  magnification filter is LINEAR and the minification filter is
  NEAREST_MIPMAP_NEAREST or NEAREST_MIPMAP_LINEAR, and dEQP's reference
  applies it for an ES 2.0 context (`tcuTexture.cpp`,
  `sampleLevelArray2DOffset`, `es2`). These cases sample at a constant
  level of detail of log2(32/28) = 0.19, which ES 2.0 magnifies (LINEAR on
  level 0). A standalone page (no Kandelo code; kept with the run logs as
  `probes/lod-switchover`) shows every engine minifying there
  (`textureLod` at 0.19 with those filters returns the NEAREST texel on a
  2D and a 2D array texture alike; at 0.0 it returns the LINEAR mix):
  WebGL 2 applies c = 0 to every texture. This is a separate ES 2.0 gap,
  not a cube-map one (`docs/architecture.md`), unchanged by this work.
- Firefox only: `texture.mipmap.cube.projected.{linear_linear,nearest_linear,nearest_nearest}`.
  `linear_linear` now fails at exactly the six pixels `nearest_linear`
  fails at (no longer at face edges): the Firefox defect that takes a lone
  fragment's level of detail from the neighbouring triangle
  (`2026-11-02-firefox-gles2-shader-scope-and-edge-lod.md`), which the
  per-face lookups' derivatives inherit. The 12
  `texture.mipmap.2d.projected.*` failures are that defect too.
- `fbo.completeness.renderable.texture.color0.rgb_half_float_oes`
  (QualityWarning, every engine) as before.

## Cost

Only programs that sample a cube map pay; every other program's draws
take the same single lookup they made before (`externalDrawUnits`), and
textures that are not cube maps keep their native storage.

Shader cost (`node tests/graphics/shader-rewrite-check/cube-bench.mjs`,
two runs; the per-face figures of both are given). Compile: CompileShader
of a fragment shader with four `textureCube` lookups, mean of 40. Draw: a
1024x1024 quad, each fragment making 1, 4 or 16 trilinear lookups at
varying directions into 256x256 faces, median of five batches of 300
additively blended draws (blending keeps a tile-based GPU from shading
only the last of a batch of opaque draws), each batch ended by a 1-pixel
`readPixels`; native is WebGL's `samplerCube` on a cube map.

| Engine | Compile, native ES 1.00 | Compile, host path (translation alone) | 1 lookup | 4 lookups | 16 lookups |
|---|---|---|---|---|---|
| Chromium (SwiftShader, CPU) | 0.13 ms | 0.33-0.34 ms (0.025 ms) | 1.5-1.9 ms native, 4.9-5.3 ms per face (2.8-3.2x) | 5.3-6.0 / 18.0-20.4 ms (3.4x) | 18.6-22.1 / 66-88 ms (3.6-4.0x) |
| Firefox (Apple GPU) | 0.38-0.45 ms | 1.55-2.25 ms (0.025-0.050 ms) | 0.003-0.007 / 0.013 ms | 0.010 / 0.037-0.043 ms (3.7-4.3x) | 0.040-0.043 / 0.163-0.193 ms (3.8-4.8x) |
| WebKit (Apple GPU) | 0.35-0.38 ms | 1.30-1.38 ms (0.025-0.050 ms) | 0.007 / 0.013 ms | 0.010 / 0.037-0.040 ms (3.7-4.0x) | 0.043 / 0.153-0.193 ms (3.5-4.5x) |

A lookup costs about 3.5 to 5 times WebGL's own cube lookup on all three
engines (face selection, the frame vectors and two quotient-rule
gradients per lookup, then `textureGrad`); the 1-lookup Apple figures
are near the timer's resolution (2 to 4 ms per batch) and only bound the
ratio. A variant that computes ES 2.0's rho and calls `textureLod`
instead measured the same (within 12% either way), so the gradient form
stays: it leaves the level computation to the sampler, as for every
other lookup. A shader that samples a cube map compiles 2.5 to 5 times
as long, once per CompileShader (the ES 1.00 validity compile, the
translation and the ESSL 3.00 compile), and a 1.00 partner is compiled
again as 3.00 at link.

Host cost per draw (tsx microbenchmarks, medians of 7 runs of 2e6 calls,
alternating with the base tree `6570a65e20`):

| Path | This tree | Base |
|---|---|---|
| draw of a program without external or cube samplers (`externalDrawUnits`) | 3.6-3.8 ns | 3.6-4.0 ns |
| `glBindTexture(TEXTURE_2D)` (compositors bind per quad) | 28.6-32.2 ns | 28.4-33.5 ns |
| draw of a cube program, cube complete in its own array (no native call) | about 70 ns | - |
| draw of a cube program, cube incomplete (one unit listed for a rebind) | 75-95 ns, plus the rebind's native calls | - |

The first row first measured 4.8-6.5 ns, about 1 ns over the base, from
the cube loop inflating the per-draw function (same lookup); moving that
loop into its own function (`eaea028053`) restored the base figure.
Storage: a cube uses the memory of a native cube map (six layers per
level); a face respecified apart from its siblings adds a second array
until they agree again, and only a cube completed while spread out is
copied (one framebuffer copy per moved image).

The graphics source gate (`cd host && npx vitest run -c
vitest.graphics.config.ts`) passes 1882 tests, including the cube storage
and translation tests.

## Not run

`./run.sh test browser-memory`, the browser demos and the compositor
specs (no cube maps; their per-draw path is unchanged), native Safari,
and the Node host's dEQP. The full `functional.shaders` family was not
rerun beyond chunk 102.
