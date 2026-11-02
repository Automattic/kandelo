import { checkedGlCall, recordGlError, type CheckedGlOwner } from "./program-objects.js";
import { engineLosesVertexDepthRange } from "./vertex-depth-range.js";
import { glslTokens } from "./attribute-aliasing.js";

/** Immutable limits belong to the native context, independently of whichever
 * guest currently owns its mutable state. Weak keys do not retain a retired
 * browser context. Do not cache null results from a lost context. */
const textureLimits = new WeakMap<WebGL2RenderingContext, number>();
const viewportLimits = new WeakMap<WebGL2RenderingContext, readonly [number, number]>();
const textureImageLevels = new WeakMap<WebGL2RenderingContext, Map<number, number>>();

/** Texture level bounds are native-context capabilities, not texture storage
 * dimensions. Undefined destination storage cannot override their GLES errors. */
export function maxTextureImageLevel(owner: CheckedGlOwner, cube: boolean): number | null {
  const gl = owner.gl;
  if (!gl) return null;
  const pname = cube ? 0x851c : 0x0d33;
  let level = textureImageLevels.get(gl)?.get(pname);
  let size: unknown;
  if (!checkedGlCall(owner, () => { if (level === undefined) size=gl.getParameter(pname); })) return null;
  if (level !== undefined) return level;
  if (typeof size !== "number" || !Number.isInteger(size) || size <= 0 || size > 0x7fff_ffff) {
    recordGlError(owner,0x502); return null;
  }
  level=Math.floor(Math.log2(size));
  let limits=textureImageLevels.get(gl);
  if (!limits) { limits=new Map(); textureImageLevels.set(gl,limits); }
  limits.set(pname,level);
  return level;
}

/** Remains available after a retiring owner has discarded its shadow. A
 * successful high-unit selection necessarily populated this native limit. */
export function knownTextureUnitLimit(gl: WebGL2RenderingContext): number {
  return textureLimits.get(gl) ?? 0;
}

export function combinedTextureUnits(gl: WebGL2RenderingContext): number {
  const cached = textureLimits.get(gl);
  if (cached !== undefined) return cached;
  const count: unknown = gl.getParameter(0x8b4d); // MAX_COMBINED_TEXTURE_IMAGE_UNITS
  if (typeof count !== "number" || !Number.isInteger(count) || count <= 0) return 0;
  textureLimits.set(gl, count);
  return count;
}

export function maxViewport(gl: WebGL2RenderingContext): readonly [number, number] | null {
  const cached = viewportLimits.get(gl);
  if (cached) return cached;
  const size: unknown = gl.getParameter(0x0d3a); // MAX_VIEWPORT_DIMS
  if (!(size instanceof Int32Array) || size.length !== 2 || size[0] <= 0 || size[1] <= 0) return null;
  const result = [size[0], size[1]] as const;
  viewportLimits.set(gl, result);
  return result;
}

const vertexLimits = new WeakMap<WebGL2RenderingContext,number>();
/** Only accepted native queries may admit a limit used to bound replay. */
export function knownVertexAttributeLimit(gl: WebGL2RenderingContext): number {
  return vertexLimits.get(gl) ?? 0;
}

/** null means native refusal; zero means an unavailable/invalid limit. Keep
 * the existing caller's checked entry/post checks even for a cached value. */
export function maxVertexAttributes(owner: CheckedGlOwner): number | null {
  const gl = owner.gl;
  if (!gl) return null;
  let count: unknown = vertexLimits.get(gl);
  if (!checkedGlCall(owner, () => { count ??= gl.getParameter(0x8869); })) return null;
  if (typeof count !== "number" || !Number.isInteger(count) || count <= 0) return 0;
  vertexLimits.set(gl,count);
  return count;
}

/**
 * Guest-visible uniform vector limits (ES 2.0 table 6.20).
 *
 * Some exact emulations draw with a private variant of the guest's program
 * (reversed-depth.ts holds the variant machinery). A variant that declares a
 * uniform the guest program lacks needs room the guest could otherwise use:
 * a program using every native uniform vector links, but its variant would
 * not, and the draw would be refused. So each advertised limit is the native
 * limit minus the rows any variant can add to that stage at once; a program
 * within the advertised limits can always link every variant. Each private
 * uniform is at most a vec4, so it needs at most one row under the GLSL ES
 * 1.00 Appendix A packing that WebGL enforces.
 *
 * Audit of every emulation that runs during a guest draw:
 * - blend-constant.ts adds one `vec3` uniform to the fragment stage, on every
 *   engine: one fragment row.
 * - [RUNTIME-WORKAROUND: FIREFOX-VERTEX-DEPTH-RANGE-UNIFORM]
 *   vertex-depth-range.ts adds one `vec3` uniform to the vertex stage, only
 *   where that workaround runs: one vertex row there.
 * - reversed-depth.ts negates clip z and copies gl_DepthRange into a global
 *   (only in a stage that already reads it); depth-sampling.ts adds helper
 *   functions and bool parameters; attribute-aliasing.ts replaces aliased
 *   attributes with one vec4 per location the guest already binds. None adds
 *   a uniform, varying, attribute or texture unit.
 * - Client arrays use the guest's own attribute indices with private buffers;
 *   opaque-alpha and luminance/alpha float expansion change storage formats
 *   and write masks only.
 * - The KMS color stage and resolve/copy utilities run their own programs or
 *   blits between guest draws, never alongside a guest program.
 * Varyings, vertex attributes and texture units therefore keep their native
 * limits. The reduction cannot reach the ES 2.0 minimums on WebGL 2 (which
 * guarantees 256 vertex and 224 fragment vectors); a renderer reporting less
 * cannot run both a conforming guest and its emulations, which is a renderer
 * fault, not a smaller limit.
 */
const PRIVATE_FRAGMENT_UNIFORM_ROWS = 1;
const MIN_VERTEX_UNIFORM_VECTORS = 128, MIN_FRAGMENT_UNIFORM_VECTORS = 16;

/** The guest-visible value of a queried limit; other names pass through. */
export function guestLimit(pname: number, native: unknown): unknown {
  if (pname !== 0x8dfb && pname !== 0x8dfd) return native;
  const vertex = pname === 0x8dfb;
  const reserved = vertex ? (engineLosesVertexDepthRange() ? 1 : 0) : PRIVATE_FRAGMENT_UNIFORM_ROWS;
  const minimum = vertex ? MIN_VERTEX_UNIFORM_VECTORS : MIN_FRAGMENT_UNIFORM_VECTORS;
  if (typeof native !== "number" || !Number.isInteger(native) || native - reserved < minimum)
    throw new Error(`Renderer reports ${String(native)} ${vertex ? "vertex" : "fragment"} uniform vectors; ` +
      `${reserved} are reserved for private emulation and ES 2.0 requires ${minimum}`);
  return native - reserved;
}

/**
 * GLSL ES 1.00 section 7.4 built-in constants and the ES 2.0 query each one
 * must equal (OpenGL ES 2.0 section 6.1, table 6.20). WebGL's compiler gives
 * them the native WebGL 2 values, which differ from what the guest queries
 * wherever `guestLimit` reports less than native, and for
 * gl_MaxDrawBuffers: ES 2.0 has no MAX_DRAW_BUFFERS query and one color
 * output, so without EXT_draw_buffers (which Kandelo does not advertise) the
 * constant is 1, while WebGL 2 compilers give ESSL 1.00 shaders the native
 * draw-buffer count. The pname 0 marks that fixed value.
 */
const BUILTIN_LIMITS: ReadonlyMap<string, number> = new Map([
  ["gl_MaxVertexAttribs", 0x8869],
  ["gl_MaxVertexUniformVectors", 0x8dfb],
  ["gl_MaxVaryingVectors", 0x8dfc],
  ["gl_MaxVertexTextureImageUnits", 0x8b4c],
  ["gl_MaxCombinedTextureImageUnits", 0x8b4d],
  ["gl_MaxTextureImageUnits", 0x8872],
  ["gl_MaxFragmentUniformVectors", 0x8dfd],
  ["gl_MaxDrawBuffers", 0],
]);

const builtinLimitValues = new WeakMap<WebGL2RenderingContext, ReadonlyMap<string, number>>();

/** The guest-visible value of every GLSL ES 1.00 built-in limit constant for
 * one native context, from the same `guestLimit` the queries report, or null
 * when the context cannot report its limits (lost; not cached). A renderer
 * that cannot leave room for private emulation throws as the query does.
 * Immutable per context, so read once. */
export function guestBuiltinLimits(owner: CheckedGlOwner): ReadonlyMap<string, number> | null {
  const gl = owner.gl;
  if (!gl) return null;
  const cached = builtinLimitValues.get(gl);
  if (cached) return cached;
  const native = new Map<number, unknown>();
  if (!checkedGlCall(owner, () => {
    for (const pname of BUILTIN_LIMITS.values()) if (pname) native.set(pname, gl.getParameter(pname));
  })) return null;
  // A lost context answers null: compilation will fail anyway; retry later.
  if ([...native.values()].some(value => value === null)) return null;
  const values = new Map<string, number>();
  for (const [name, pname] of BUILTIN_LIMITS) {
    // Outside the checked call: an impossible limit is a renderer fault.
    const value = pname ? guestLimit(pname, native.get(pname)) : 1;
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0)
      throw new Error(`Renderer reports ${String(value)} for the limit behind ${name}`);
    values.set(name, value);
  }
  builtinLimitValues.set(gl, values);
  return values;
}

/**
 * The guest's GLSL ES 1.00 source with each built-in limit constant replaced
 * by `int(N)`, N its guest-visible value, so the shader sees what the guest
 * queries. Made once per ShaderSource (shader-source.ts); no draw pays for
 * it. GLSL ES 1.00 section 3.4 reserves `gl_` names and engines reject
 * redefining them, so a `#define` of the built-in cannot do this; the uses
 * are rewritten instead, as for the external-image macro
 * (external-texture.ts). `int(N)` keeps every property of the built-in a
 * shader can observe: it is a constant expression (array sizes, constant
 * initializers), not an l-value, and, like the built-in, not a macro, so a
 * preprocessor `#if` still rejects it. Uses inside a `#define` body are
 * rewritten (they expand into code); the built-in's name in every other
 * directive (`#if`, `#ifdef`, `#undef`, a reserved `#define` name) stays as
 * written for the engine to judge. ESSL 3.00 sources compile unchanged: an
 * ES 2.0 context has no ESSL 3.00 limits to agree with.
 */
export function builtinLimitShaderSource(source: string, limits: ReadonlyMap<string, number>): string {
  if (!source.includes("gl_Max") || /^\s*#\s*version\s+[1-9][0-9][0-9]\s+es/m.test(source)) return source;
  const list = glslTokens(source, true);
  let text = "", from = 0, keyword = "", directiveAt = -1;
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    if (t.directive && t.text === "#" && (i === 0 || !list[i - 1].directive || source.lastIndexOf("\n", t.start) > list[i - 1].start)) {
      keyword = list[i + 1]?.directive ? list[i + 1].text : ""; directiveAt = i;
      continue;
    }
    const value = limits.get(t.text);
    if (value === undefined) continue;
    // In a directive only a #define body (after the macro name) is code.
    if (t.directive && !(keyword === "define" && i > directiveAt + 2)) continue;
    text += source.slice(from, t.start) + `int(${value})`;
    from = t.end;
  }
  return from === 0 ? source : text + source.slice(from);
}
