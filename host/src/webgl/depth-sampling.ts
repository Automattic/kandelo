/**
 * Depth textures sample as luminance (OES_depth_texture issue 2).
 *
 * OES_depth_texture resolves that GLSL texture* lookups of a DEPTH_COMPONENT
 * texture return (d, d, d, 1.0) in vertex and fragment shaders, and
 * OES_packed_depth_stencil samples DEPTH_STENCIL textures the same way.
 * WebGL 2 follows ES 3.0, which returns (d, 0, 0, 1), and has no texture
 * swizzle state, so the result has to be fixed in the shader.
 *
 * At draw time the host finds which sampler uniforms of the installed
 * executable reference a unit whose bound texture's level 0 is a depth
 * image (every level of a complete texture shares that format, and an
 * incomplete one samples (0, 0, 0, 1) either way). If any do, the draw runs
 * a private variant (reversed-depth.ts holds the variant machinery) whose
 * shaders wrap each lookup through a depth sampler as
 * kandelo_depth_texel(flag, lookup) = flag ? vec4(t.rrr, 1.0) : t. The flag is
 * a constant for a uniform sampler, a per-index function for a sampler
 * array, and an added bool parameter for a sampler passed into a user
 * function, so every call site resolves to the sampler it actually reads.
 * Draws that sample no depth texture use the guest executable unchanged, and
 * a draw while no unit (nor texture zero) holds a depth texture, or a
 * texture switching at lambda 0.5 (lod-switchover.ts), pays one comparison:
 * each context keeps per-unit traits and their counts (`samplingUnits`),
 * updated when a binding changes and recounted only after some texture's
 * level 0 started or stopped being depth or its filters changed that trait
 * (texture-levels.ts).
 * Sources the rewrite cannot resolve exactly (a lookup inside a macro, or a
 * sampler inside a struct) yield no variant, and the draw is refused.
 */
import type { GlBinding } from "./registry.js";
import { checkedGlCall, programLinkGeneration } from "./program-objects.js";
import { glslTokens, type GlslToken } from "./attribute-aliasing.js";
import { headerEnd } from "./reversed-depth.js";
import { depthLevelRevision, levelSamplesDepth, textureLevel } from "./texture-levels.js";
import type { GlShadowState } from "./shadow.js";
import { noteSourcedUnit, type GlTextureView } from "./image-storage.js";
import { programGuestName } from "./essl3-translation.js";
import { textureSwitchesAtHalf } from "./lod-switchover.js";

const LOOKUPS = new Set(["texture2D", "texture2DProj", "texture2DLod", "texture2DProjLod", "textureCube", "textureCubeLod"]);
// samplerExternalOES compiles under a private macro name (external-texture.ts);
// an external texture is never a depth texture.
const SAMPLER_TYPES = new Set(["sampler2D", "samplerCube", "kandelo_samplerExternalOES"]);
const TEXEL = "kandelo_depth_texel", ARG = "kandelo_depth_arg", ARRAY = "kandelo_depth_";

type FunctionDeclaration = { name: number; open: number; close: number; body: [number, number] | null;
  params: number; samplers: { index: number; name?: string }[] };

function matching(list: GlslToken[], open: number): number {
  const pair = list[open].text === "(" ? ")" : list[open].text === "[" ? "]" : "}";
  for (let depth = 0, i = open; i < list.length; i++) {
    if (list[i].text === list[open].text) depth++;
    else if (list[i].text === pair && --depth === 0) return i;
  }
  return -1;
}

/** Top-level comma-separated ranges [start, end) between `open` and `close`. */
function splitArguments(list: GlslToken[], open: number, close: number): [number, number][] {
  const out: [number, number][] = [];
  let start = open + 1, depth = 0;
  for (let i = open + 1; i < close; i++) {
    const t = list[i].text;
    if (t === "(" || t === "[") depth++;
    else if (t === ")" || t === "]") depth--;
    else if (t === "," && depth === 0) { out.push([start, i]); start = i + 1; }
  }
  if (close > open + 1) out.push([start, close]);
  return out;
}

/** The variant source for one stage, or null when it cannot be exact.
 * `depth` names the depth-bound sampler uniforms (array elements as
 * `name[i]`). */
export function depthSamplingShaderSource(source: string, depth: ReadonlySet<string>): string | null {
  const list = glslTokens(source, true);
  const word = (i: number) => /^[A-Za-z_]\w*$/.test(list[i]?.text ?? "");

  // Global sampler uniforms (name -> array length, or 0 for a single sampler).
  const samplers = new Map<string, number>();
  const functions: FunctionDeclaration[] = [];
  for (let i = 0, braces = 0; i < list.length; i++) {
    const t = list[i];
    if (t.directive) continue;
    if (t.text === "{") braces++;
    else if (t.text === "}") braces--;
    if (braces !== 0) continue;
    if (t.text === "uniform") {
      let j = i + 1;
      while (j < list.length && list[j].text !== ";" && !SAMPLER_TYPES.has(list[j].text)) j++;
      if (!SAMPLER_TYPES.has(list[j]?.text)) continue;
      for (j++; j < list.length && list[j].text !== ";"; j++) {
        if (!word(j)) continue;
        const sized = list[j + 1]?.text === "[" ? Number(list[j + 2]?.text) : 0;
        samplers.set(list[j].text, sized);
        if (sized) j += 3;
      }
      i = j;
    } else if (word(i) && list[i + 1]?.text === "(" && word(i - 1) && list[i - 1].text !== "return") {
      const close = matching(list, i + 1);
      const after = list[close + 1]?.text;
      if (close < 0 || (after !== "{" && after !== ";")) continue;
      const declaration: FunctionDeclaration = { name: i, open: i + 1, close, body: null, params: 0, samplers: [] };
      const params = splitArguments(list, i + 1, close).filter(([s, e]) => !(e - s === 1 && list[s].text === "void"));
      declaration.params = params.length;
      params.forEach(([s, e], index) => {
        if (!list.slice(s, e).some(p => SAMPLER_TYPES.has(p.text))) return;
        const last = list[e - 1];
        declaration.samplers.push({ index, name: SAMPLER_TYPES.has(last.text) ? undefined : last.text });
      });
      if (after === "{") declaration.body = [close + 1, matching(list, close + 1)];
      functions.push(declaration);
    }
  }
  const sampling = new Map<string, FunctionDeclaration[]>();
  for (const f of functions) if (f.samplers.length) {
    const name = list[f.name].text;
    sampling.set(name, [...(sampling.get(name) ?? []), f]);
  }
  const declarationNames = new Set(functions.map(f => f.name));

  const edits: { at: number; depth: number; text: string }[] = [];
  const arrays = new Set<string>();
  for (const f of functions) for (const s of f.samplers)
    edits.push({ at: list[f.close].start, depth: 0, text: `, bool ${ARG}${s.index}` });

  /** The depth flag of a sampler-valued argument, or null if unresolvable. */
  const flag = (start: number, end: number, scope: FunctionDeclaration | undefined): string | null => {
    while (list[start]?.text === "(" && matching(list, start) === end - 1) { start++; end--; }
    const name = list[start]?.text;
    if (end - start === 1) {
      const param = scope?.samplers.find(s => s.name === name);
      if (param) return `${ARG}${param.index}`;
      if (samplers.get(name) === 0) return depth.has(name) ? "true" : "false";
      return null;
    }
    if (samplers.get(name) && list[start + 1].text === "[" && matching(list, start + 1) === end - 1) {
      const length = samplers.get(name)!;
      if (!Array.from({ length }, (_, i) => depth.has(`${name}[${i}]`)).some(Boolean)) return "false";
      arrays.add(name);
      return `${ARRAY}${name}(${source.slice(list[start + 2].start, list[end - 1].start).trim()})`;
    }
    return null;
  };

  for (let i = 0, parens = 0; i < list.length; i++) {
    const t = list[i];
    if (t.text === "(") parens++;
    else if (t.text === ")") parens--;
    const lookup = LOOKUPS.has(t.text), call = sampling.has(t.text) && !declarationNames.has(i);
    if (!lookup && !call) continue;
    if (t.directive || list[i + 1]?.text !== "(") {
      if (lookup || t.directive) return null;
      continue;
    }
    const close = matching(list, i + 1);
    if (close < 0) return null;
    const scope = functions.find(f => f.body && i > f.body[0] && i < f.body[1]);
    const args = splitArguments(list, i + 1, close);
    if (lookup) {
      const f = args[0] && flag(args[0][0], args[0][1], scope);
      if (!f) return null;
      if (f === "false") continue;
      edits.push({ at: t.start, depth: parens, text: `${TEXEL}(${f}, ` }, { at: list[close].end, depth: parens + 1, text: ")" });
    } else {
      const overloads = sampling.get(t.text)!.filter(f => f.params === args.length);
      const signature = new Set(overloads.map(f => f.samplers.map(s => s.index).join(",")));
      if (signature.size !== 1) return null;
      for (const s of overloads[0].samplers) {
        const f = flag(args[s.index][0], args[s.index][1], scope);
        if (!f) return null;
        edits.push({ at: list[close].start, depth: parens, text: `, ${f}` });
      }
    }
  }

  let helpers = `highp vec4 ${TEXEL}(bool d, highp vec4 t) { return d ? vec4(t.rrr, 1.0) : t; }\n`;
  for (const name of arrays) {
    const indices = Array.from({ length: samplers.get(name)! }, (_, i) => i).filter(i => depth.has(`${name}[${i}]`));
    helpers += `bool ${ARRAY}${name}(int i) { return ${indices.map(i => `i == ${i}`).join(" || ")}; }\n`;
  }
  // Insertions only; at one offset the more deeply nested call's text comes first.
  edits.sort((a, b) => a.at - b.at || b.depth - a.depth);
  let out = "", from = 0;
  for (const e of edits) { out += source.slice(from, e.at) + e.text; from = e.at; }
  out += source.slice(from);
  const at = headerEnd(out);
  const lead = at > 0 && out[at - 1] !== "\n" ? "\n" : "";
  const line = out.slice(0, at).split("\n").length + (lead ? 1 : 0);
  return out.slice(0, at) + lead + helpers + `#line ${line}\n` + out.slice(at);
}

// --- draw-time selection --------------------------------------------------------

const samplerWrites = new WeakMap<WebGLProgram, number>();
/** Sampler units change only through Uniform1i/Uniform1iv (ES 2.0 2.10.4). */
export function noteSamplerWrite(program: WebGLProgram | null): void {
  if (program) samplerWrites.set(program, (samplerWrites.get(program) ?? 0) + 1);
}
/** Changes when a sampler unit of `program` may have changed. */
export function samplerWriteGeneration(program: WebGLProgram): number {
  return samplerWrites.get(program) ?? 0;
}

/** Level 0 of the face a unit of that kind samples is a depth image. */
function samplesDepth(object: WebGLTexture | null | undefined, cube: boolean): boolean {
  return !!object && levelSamplesDepth(textureLevel(object, cube ? 0x8515 : 0x0de1, 0));
}

/** Sampling traits of a unit's texture: DEPTH (level 0 is a depth image)
 * and HALF (its filters switch at lambda 0.5, lod-switchover.ts). */
export const DEPTH_TRAIT = 1, HALF_TRAIT = 2;
function traits(object: WebGLTexture | null | undefined, cube: boolean): number {
  return object ? (samplesDepth(object, cube) ? DEPTH_TRAIT : 0) | (textureSwitchesAtHalf(object) ? HALF_TRAIT : 0) : 0;
}

function recountSamplingUnits(s: GlShadowState): GlShadowState["samplingUnits"] {
  const flat = s.textureUnits.map(object => traits(object, false)), cube = s.cubeTextureUnits.map(object => traits(object, true));
  let any = 0, depth = 0, half = 0;
  for (const t of [...flat, ...cube]) { if (t) any++; if (t & DEPTH_TRAIT) depth++; if (t & HALF_TRAIT) half++; }
  return s.samplingUnits = { revision: depthLevelRevision(), any, depth, half, flat, cube,
    defaults: traits(s.defaultTextures.get(0x0de1), false) | traits(s.defaultTextures.get(0x8513), true) };
}

/** The context's current unit summary (recounted when stale). */
export function samplingUnits(s: GlShadowState): GlShadowState["samplingUnits"] {
  return s.samplingUnits.revision === depthLevelRevision() ? s.samplingUnits : recountSamplingUnits(s);
}

/** Every write of a texture-unit binding goes through here, keeping the
 * draw-time unit summaries (depth textures and switch-over filters here,
 * EGLImage sibling views in image-storage.ts) current; a stale summary is
 * recounted at the next draw. */
export function setTextureUnit(owner: { shadow: GlShadowState; textureViews: ReadonlyMap<WebGLTexture, GlTextureView> },
    cube: boolean, unit: number, object: WebGLTexture | null): void {
  const s = owner.shadow, units = cube ? s.cubeTextureUnits : s.textureUnits, summary = s.samplingUnits;
  if (!cube) noteSourcedUnit(owner, unit, object);
  // The unit's previous traits are remembered; only `object` is read.
  if (summary.revision === depthLevelRevision()) {
    const flags = cube ? summary.cube : summary.flat, now = traits(object, cube), before = flags[unit] ?? 0;
    if (now !== before) {
      summary.any += (now ? 1 : 0) - (before ? 1 : 0);
      summary.depth += (now & DEPTH_TRAIT) - (before & DEPTH_TRAIT);
      summary.half += ((now & HALF_TRAIT) - (before & HALF_TRAIT)) >> 1;
      flags[unit] = now;
    }
  }
  units[unit] = object;
}

const NO_DEPTH_SAMPLERS: readonly string[] = Object.freeze([]);

type SamplerCache = { link: number; writes: number; samplers: { name: string; cube: boolean; unit: number }[] };
const caches = new WeakMap<WebGLProgram, SamplerCache>();

/** Sampler elements of the installed executable that read a depth texture,
 * sorted (the variant key). Null means a native query failed (recorded). */
export function depthSamplersForDraw(b: GlBinding, units = samplingUnits(b.shadow)): readonly string[] | null {
  const program = b.currentProgram, gl = b.gl!;
  if (!program) return NO_DEPTH_SAMPLERS;
  const s = b.shadow;
  // No unit, bound or texture zero, holds a depth texture: no native work.
  if (units.depth === 0 && !(units.defaults & DEPTH_TRAIT)) return NO_DEPTH_SAMPLERS;
  const depthAt = (cube: boolean, unit: number) =>
    samplesDepth((cube ? s.cubeTextureUnits : s.textureUnits)[unit] ?? s.defaultTextures.get(cube ? 0x8513 : 0x0de1), cube);
  const link = programLinkGeneration(b, program).value, writes = samplerWrites.get(program) ?? 0;
  let cache = caches.get(program);
  if (!cache || cache.link !== link || cache.writes !== writes) {
    const samplers: SamplerCache["samplers"] = [];
    // Native reads happen only after a link or a Uniform1i(v) write.
    if (!checkedGlCall(b, () => {
      const count = Number(gl.getProgramParameter(program, 0x8b86));
      for (let i = 0; i < count; i++) {
        const info = gl.getActiveUniform(program, i);
        if (!info || (info.type !== 0x8b5e && info.type !== 0x8b60)) continue;
        const array = info.name.endsWith("[0]"), base = array ? info.name.slice(0, -3) : info.name;
        for (let element = 0; element < info.size; element++) {
          const name = array ? `${base}[${element}]` : base;
          const location = gl.getUniformLocation(program, name);
          // Variants rewrite the ES 1.00 source, which has the guest's names.
          if (location) samplers.push({ name: programGuestName(program, name), cube: info.type === 0x8b60, unit: Number(gl.getUniform(program, location)) });
        }
      }
    })) return null;
    caches.set(program, cache = { link, writes, samplers });
  }
  return cache.samplers.filter(sampler => depthAt(sampler.cube, sampler.unit)).map(sampler => sampler.name).sort();
}
