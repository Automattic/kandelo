/**
 * ES 2.0's magnification/minification switch-over point (section 3.7.9).
 *
 * ES 2.0 computes a lookup's level of detail lambda (section 3.7.7) and
 * magnifies when lambda <= c, minifies when lambda > c (section 3.7.8). c is
 * 0.5 when TEXTURE_MAG_FILTER is LINEAR and TEXTURE_MIN_FILTER is
 * NEAREST_MIPMAP_NEAREST or NEAREST_MIPMAP_LINEAR, and 0 otherwise. ES 3.0
 * dropped the 0.5 case, and every WebGL 2 engine applies c = 0 to every
 * texture (a standalone page without Kandelo code shows Chromium, Firefox
 * and WebKit minifying at lambda 0.19 with those filters). So for lambda in
 * (0, 0.5] WebGL 2 returns NEAREST from level 0 (NEAREST_MIPMAP_NEAREST
 * selects level 0 there) or a NEAREST blend of levels 0 and 1
 * (NEAREST_MIPMAP_LINEAR), where ES 2.0 returns the LINEAR magnification of
 * level 0. dEQP-GLES2 builds its references with c = 0.5, and applications
 * that keep ES 2.0's default filters (NEAREST_MIPMAP_LINEAR and LINEAR) on
 * mipmapped textures see the difference at every slightly minified texel.
 *
 * Emulation. Draws whose program samples a texture with that filter pair
 * run a private variant (reversed-depth.ts holds the variant machinery) in
 * which those samplers' lookups compute lambda themselves and call
 * textureLod at lambda when lambda > 0.5 and at 0.0 otherwise
 * (essl3-translation.ts, `lodSwitchHelpers`). That is exact for ES 2.0:
 * - lambda <= 0.5 (c = 0.5) magnifies: the MAG filter (LINEAR) on level 0.
 *   textureLod(x, p, 0.0) has lambda 0 <= c = 0 in WebGL 2, so it magnifies
 *   with the same MAG filter on the same level (ES 2.0 has no base level or
 *   LOD clamps; the native defaults, base 0 and [-1000, 1000], hold).
 * - lambda > 0.5 minifies under both rules; textureLod at that lambda makes
 *   the ES 2.0 minification (level choice and blend) at exactly that lambda.
 * - lambda: section 3.7.7, log2(rho) plus the shader's bias, rho the larger
 *   length of the derivatives of (u, v) = (s, t) times the level-0 size
 *   (equation 3.17), from dFdx/dFdy of the lookup's (projected)
 *   coordinate; for a cube map, the derivatives of the selected face's
 *   (s, t), as the per-face lookups compute them (cube-storage.ts). A
 *   vertex shader's level of detail is the `lod` argument of
 *   texture2DLod, texture2DProjLod or textureCubeLod; its implicit lookups
 *   have level of detail 0, which magnifies under either rule, so they are
 *   unchanged. Fragment shaders have no explicit-LOD lookups in ES 2.0.
 * The level of detail is then this shader's own derivative-based lambda,
 * as ES 2.0 permits (rho may be any approximation within its bounds), used
 * consistently for both the switch and the minification.
 *
 * The variant is ESSL 3.00 (textureSize and fragment textureLod exist only
 * there), so an ES 1.00 program's variant is its translation
 * (essl3-translation.ts). A variant that cannot compile (a construct ESSL
 * 3.00 rejects, such as a sampler array indexed by a loop index) leaves
 * those draws with c = 0, the gap as before, rather than refusing them.
 *
 * Reported gaps (maintainer decision D-55). Where the emulation cannot
 * apply, a draw keeps WebGL's c = 0: a variant that did not build (not
 * retried), or a lookup the rewrite cannot attribute to one sampler (a
 * sampler inside a struct parameter, an array parameter, same-arity
 * overloads with different sampler positions, an unresolvable index). That
 * is the remaining gap, never a refused draw, but it is not silent:
 * `reportLodSwitchGaps` sends a host diagnostic (diagnostics.ts) naming the
 * process, the guest program, the samplers and the reason, once per linked
 * executable, reason and sampler. It runs when a variant is built or found
 * unbuildable, never per draw.
 *
 * Cost. Each context keeps the sampling traits of its 2D and cube unit
 * bindings (depth-sampling.ts `samplingUnits`, shared with depth-texture
 * sampling): a bind looks up the filters of the texture it binds, and the
 * counts are recounted only after some texture's pair started or stopped
 * holding (TexParameter of a filter, a new texture zero). A draw while no
 * unit holds a depth texture or such a texture pays the one comparison it
 * paid before. Only when one does is the program's sampler list (cached
 * per link and sampler write) checked; the variant itself is built once per
 * program and sampler set and then cached like every other variant.
 */
import type { GlBinding } from "./registry.js";
import { checkedGlCall, currentProgramName, programLinkGeneration } from "./program-objects.js";
import { HALF_TRAIT, samplerWriteGeneration, samplingUnits } from "./depth-sampling.js";
import { guestUniformType } from "./external-texture.js";
import { programGuestName, type LodSwitchGap, type LodSwitchGapReason } from "./essl3-translation.js";
import { samplingTraitsChanged } from "./texture-levels.js";
import { reportGlDiagnostic } from "./diagnostics.js";

const TEX = 0x0de1, CUBE = 0x8513, MIN_FILTER = 0x2801, MAG_FILTER = 0x2800;
const NEAREST = 0x2600, LINEAR = 0x2601, NEAREST_MIPMAP_NEAREST = 0x2700, NEAREST_MIPMAP_LINEAR = 0x2702;
const MIN_FILTERS = new Set([NEAREST, LINEAR, NEAREST_MIPMAP_NEAREST, 0x2701, NEAREST_MIPMAP_LINEAR, 0x2703]);
const SAMPLER_2D = 0x8b5e, SAMPLER_CUBE = 0x8b60, SAMPLER_2D_ARRAY = 0x8dc1;

type Filters = { min: number; mag: number; half: boolean };
/** Filters of logical 2D and cube textures whose filters differ from ES
 * 2.0's initial NEAREST_MIPMAP_LINEAR and LINEAR. Absent: the initial pair,
 * which switches at 0.5. */
const filters = new WeakMap<WebGLTexture, Filters>();

const switchesAtHalf = (min: number, mag: number) =>
  mag === LINEAR && (min === NEAREST_MIPMAP_NEAREST || min === NEAREST_MIPMAP_LINEAR);

/** The texture's filters switch from magnification to minification at
 * lambda = 0.5. */
export function textureSwitchesAtHalf(object: WebGLTexture | null | undefined): boolean {
  return !!object && (filters.get(object)?.half ?? true);
}

/** Record filters a host path gave a logical texture at creation (an
 * imported foreign texture), as TexParameter would have. */
export function setTextureFilters(object: WebGLTexture, min: number, mag: number): void {
  const half = switchesAtHalf(min, mag), current = filters.get(object);
  // Units holding the texture change traits: recount at the next draw.
  if (half !== (current?.half ?? true)) samplingTraitsChanged();
  if (current) { current.min = min; current.mag = mag; current.half = half; }
  else filters.set(object, { min, mag, half });
}

/** TexParameteri/f of a 2D or cube texture: track its filters. Only values
 * WebGL accepts change native state (others are INVALID_ENUM and leave it),
 * so an invalid value is not recorded. A float names an enum after rounding
 * to the nearest integer (ES 2.0 section 2.3.1). Compositors set filters
 * before every textured quad, so an unchanged value returns after one
 * lookup. */
export function noteTextureFilter(object: WebGLTexture | null, pname: number, value: number): void {
  if (!object || (pname !== MIN_FILTER && pname !== MAG_FILTER)) return;
  const v = Math.round(value);
  if (pname === MIN_FILTER ? !MIN_FILTERS.has(v) : v !== NEAREST && v !== LINEAR) return;
  const current = filters.get(object);
  const min = pname === MIN_FILTER ? v : current?.min ?? NEAREST_MIPMAP_LINEAR;
  const mag = pname === MAG_FILTER ? v : current?.mag ?? LINEAR;
  if (current && current.min === min && current.mag === mag) return;
  setTextureFilters(object, min, mag);
}

type Sampler = { name: string; cube: boolean; unit: number };
type SamplerCache = { link: number; writes: number; samplers: Sampler[] };
const caches = new WeakMap<WebGLProgram, SamplerCache>();
const NONE: readonly string[] = Object.freeze([]);

/** The installed executable's 2D and cube sampler elements (guest names)
 * that read a texture switching at 0.5, sorted (the variant key). Null when
 * a native query failed (recorded). */
export function lodSwitchSamplersForDraw(b: GlBinding, units = samplingUnits(b.shadow)): readonly string[] | null {
  // No unit, bound or texture zero, holds such a texture: no further work.
  if (units.half === 0 && !(units.defaults & HALF_TRAIT)) return NONE;
  const program = b.currentProgram;
  return program ? programLodSwitchSamplers(b, program) : NONE;
}

function programLodSwitchSamplers(b: GlBinding, program: WebGLProgram): readonly string[] | null {
  const s = b.shadow, link = programLinkGeneration(b, program).value, writes = samplerWriteGeneration(program);
  let cache = caches.get(program);
  if (!cache || cache.link !== link || cache.writes !== writes) {
    const gl = b.gl!, samplers: Sampler[] = [];
    // Native reads happen only after a link or a Uniform1i(v) write.
    if (!checkedGlCall(b, () => {
      const count = Number(gl.getProgramParameter(program, 0x8b86));
      for (let i = 0; i < count; i++) {
        const info = gl.getActiveUniform(program, i);
        if (!info || (info.type !== SAMPLER_2D && info.type !== SAMPLER_CUBE && info.type !== SAMPLER_2D_ARRAY)) continue;
        // External samplers read the unit's external binding, never a
        // mipmapped texture (OES_EGL_image_external allows only NEAREST
        // and LINEAR); a translated samplerCube is a sampler2DArray.
        const type = guestUniformType(program, programGuestName(program, info.name), info.type);
        if (type !== SAMPLER_2D && type !== SAMPLER_CUBE) continue;
        const array = info.name.endsWith("[0]"), base = array ? info.name.slice(0, -3) : info.name;
        for (let element = 0; element < info.size; element++) {
          const name = array ? `${base}[${element}]` : base;
          const location = gl.getUniformLocation(program, name);
          if (location) samplers.push({ name: programGuestName(program, name), cube: type === SAMPLER_CUBE, unit: Number(gl.getUniform(program, location)) });
        }
      }
    })) return null;
    caches.set(program, cache = { link, writes, samplers });
  }
  let hits: string[] | undefined;
  for (const sampler of cache.samplers) {
    const object = (sampler.cube ? s.cubeTextureUnits : s.textureUnits)[sampler.unit] ?? s.defaultTextures.get(sampler.cube ? CUBE : TEX);
    if (textureSwitchesAtHalf(object)) (hits ??= []).push(sampler.name);
  }
  return hits ? hits.sort() : NONE;
}

// --- reported gaps (decision D-55) -------------------------------------------------

export const LOD_SWITCH_DIAGNOSTIC_SOURCE = "GLES texture switch-over point";

const GAP_REASONS: Record<LodSwitchGapReason, string> = {
  "variant-build": "the ESSL 3.00 draw variant that applies it did not compile or link, and is not retried",
  "struct-parameter": "a lookup samples a sampler inside a struct function parameter",
  "array-parameter": "a lookup samples a sampler array function parameter",
  "overloaded-function": "a lookup samples a sampler parameter of a function whose overloads of one arity take samplers at " +
    "different positions, or that overloads a built-in",
  "index-expression": "a lookup indexes a sampler array with an expression the rewrite cannot resolve",
  "expression": "a lookup's sampler argument is an expression the rewrite cannot resolve",
};

/** Samplers already reported, per linked executable and reason. */
const reported = new WeakMap<object, Map<LodSwitchGapReason, Set<string>>>();

/** Report that the installed program's lookups in `gaps` keep WebGL's c = 0.
 * `executable` identifies one link of the program (a relink is a new
 * executable whose gaps are reported afresh); each sampler is named once per
 * executable and reason. Called when a variant is built or found
 * unbuildable, so draws pay nothing. */
export function reportLodSwitchGaps(b: GlBinding, executable: object, gaps: readonly LodSwitchGap[]): void {
  if (!gaps.length) return;
  let byReason = reported.get(executable);
  if (!byReason) reported.set(executable, byReason = new Map());
  for (const gap of gaps) {
    let names = byReason.get(gap.reason);
    if (!names) byReason.set(gap.reason, names = new Set());
    const fresh = gap.samplers.filter(name => !names!.has(name));
    if (!fresh.length) continue;
    for (const name of fresh) names.add(name);
    const where = gap.argument === undefined ? "" : ` (\`${gap.argument}\`${gap.function ? ` in ${gap.function}` : ""})`;
    reportGlDiagnostic(b.pid, LOD_SWITCH_DIAGNOSTIC_SOURCE,
      `GLES program ${currentProgramName(b)}: lookups that may read sampler${fresh.length > 1 ? "s" : ""} ${fresh.join(", ")} ` +
      `keep WebGL's magnification switch-over point c = 0 instead of ES 2.0's c = 0.5 (section 3.7.9): ` +
      `${GAP_REASONS[gap.reason]}${where}. Drawing continues; at a level of detail in (0, 0.5] those lookups minify ` +
      `where ES 2.0 magnifies.`);
  }
}
