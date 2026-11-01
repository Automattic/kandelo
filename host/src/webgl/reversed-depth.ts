/**
 * Reversed depth ranges (ES 2.0 section 2.12.1) on WebGL 2.
 *
 * ES 2.0 clamps glDepthRangef's n and f to [0,1] with no ordering rule, so
 * n > f is legal and maps NDC z to window z by
 *   z_w = ((f - n) / 2) * z_d + (n + f) / 2.
 * WebGL (1.0 section 6.12, inherited by WebGL 2) rejects zNear > zFar with
 * INVALID_OPERATION, so the native range cannot hold the logical pair.
 *
 * Exact emulation: the native range is (min, max) = (f, n), and draws run a
 * private "twin" of the current executable whose vertex shader negates clip
 * z after the guest's main. With z_d' = -z_d the native mapping becomes
 *   ((n - f) / 2) * (-z_d) + (n + f) / 2  =  the logical z_w above,
 * bit for bit (IEEE negation is exact). Clipping is symmetric in z
 * (-w <= z <= w), facing depends only on x/y, and polygon offset, the depth
 * test, depth writes and gl_FragCoord.z all consume the identical window z.
 * The built-in gl_DepthRange uniform would report the native (f, n) pair, so
 * the twin's shaders read a private copy holding the logical near/far/diff.
 *
 * A hidden uniform gate in every guest program is NOT exact: it consumes a
 * MAX_VERTEX_UNIFORM_VECTORS slot (a program at the limit would fail to link)
 * and appears in ACTIVE_UNIFORMS / glGetActiveUniform. The twin is purely
 * private: reflection, info logs, validation and uniform queries keep using
 * the guest's executable, whose uniform values are copied into the twin
 * before a reversed draw whenever the guest changed them.
 */
import type { GlBinding } from "./registry.js";
import { checkedGlCall, recordGlError, type CheckedGlOwner } from "./program-objects.js";
import { depthSamplersForDraw, depthSamplingShaderSource } from "./depth-sampling.js";
import { engineLosesVertexDepthRange, NATIVE_DEPTH_RANGE_UNIFORM, nativeDepthRangeValues, vertexDepthRangeShaderSource,
  vertexDepthRangeWorkaround } from "./vertex-depth-range.js";
import { BLEND_SOURCE_FACTOR_UNIFORM, blendFoldNeeded, blendFoldShaderSource, drawColorBufferKind } from "./blend-constant.js";
import { rethrowNativeGlFault } from "./native-recovery.js";

const VERTEX_SHADER = 0x8b31, FRAGMENT_SHADER = 0x8b30;
const MAIN = "kandelo_reversed_depth_main";
const RANGE = "kandelo_reversed_depth_range";
const RANGE_TYPE = "kandelo_reversed_depth_range_parameters";

/** The native WebGL range for a logical ES range: always zNear <= zFar. */
export function nativeDepthRange(range: readonly [number, number]): [number, number] {
  return range[0] > range[1] ? [range[1], range[0]] : [range[0], range[1]];
}

export function depthRangeReversed(range: readonly [number, number]): boolean {
  return range[0] > range[1];
}

/** Rename identifiers outside comments; GLSL ES has no string literals.
 * Renaming every `main` token (including inside #define bodies) keeps a
 * macro-produced entry point consistent and preserves every line number. */
export function renameIdentifiers(source: string, names: ReadonlyMap<string, string>): { text: string; found: Set<string> } {
  let out = "", from = 0, i = 0;
  const found = new Set<string>();
  const n = source.length;
  const identStart = (c: string) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_";
  const identPart = (c: string) => identStart(c) || (c >= "0" && c <= "9");
  while (i < n) {
    const c = source[i];
    if (c === "/" && source[i + 1] === "/") {
      while (i < n && source[i] !== "\n") i++;
    } else if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
    } else if (c >= "0" && c <= "9") {
      // A numeric literal (including suffix/exponent letters) is one token.
      while (i < n && (identPart(source[i]) || source[i] === ".")) i++;
    } else if (identStart(c)) {
      const start = i;
      while (i < n && identPart(source[i])) i++;
      const replacement = names.get(source.slice(start, i));
      if (replacement !== undefined) {
        found.add(source.slice(start, i));
        out += source.slice(from, start) + replacement;
        from = i;
      }
    } else i++;
  }
  return { text: out + source.slice(from), found };
}

/** Offset just past the leading #version/#extension/#pragma directive lines.
 * Declarations must follow #version, and ESSL 3.00 also requires #extension
 * before the first non-preprocessor token. */
export function headerEnd(source: string): number {
  let i = 0, end = 0;
  const n = source.length;
  for (;;) {
    while (i < n) {
      if (source[i] === "/" && source[i + 1] === "/") { while (i < n && source[i] !== "\n") i++; }
      else if (source[i] === "/" && source[i + 1] === "*") { const e = source.indexOf("*/", i + 2); i = e < 0 ? n : e + 2; }
      else if (/\s/.test(source[i])) i++;
      else break;
    }
    if (source[i] !== "#") return end;
    const directive = /^#\s*([A-Za-z_]+)/.exec(source.slice(i, i + 64))?.[1];
    if (directive !== "version" && directive !== "extension" && directive !== "pragma") return end;
    while (i < n && source[i] !== "\n") i++;
    if (i < n) i++;
    end = i;
  }
}

/** The twin's source for one stage. The guest's main becomes an ordinary
 * function called by a new main, which then negates clip z (vertex stage).
 * gl_DepthRange is redirected to a private struct holding the logical values;
 * native near/far are the logical far/near while the range is reversed. */
export function reversedDepthShaderSource(source: string, vertex: boolean): string {
  const { text, found } = renameIdentifiers(source, new Map([
    ["main", MAIN], ["gl_DepthRange", RANGE], ["gl_DepthRangeParameters", RANGE_TYPE],
  ]));
  let result = text;
  let prologue = "";
  if (found.has("gl_DepthRange") || found.has("gl_DepthRangeParameters")) {
    const at = headerEnd(text);
    const lead = at > 0 && text[at - 1] !== "\n" ? "\n" : "";
    const line = text.slice(0, at).split("\n").length + (lead ? 1 : 0);
    // ES #line N numbers the following line N, restoring the guest's numbering
    // (observable only through __LINE__; the twin's info log is private).
    result = text.slice(0, at) + lead +
      `struct ${RANGE_TYPE} { highp float near; highp float far; highp float diff; };\n` +
      `${RANGE_TYPE} ${RANGE};\n#line ${line}\n` + text.slice(at);
    prologue = `${RANGE}.near = gl_DepthRange.far; ${RANGE}.far = gl_DepthRange.near; ${RANGE}.diff = -gl_DepthRange.diff; `;
  }
  return `${result}\nvoid main() { ${prologue}${MAIN}();${vertex ? " gl_Position.z = -gl_Position.z;" : ""} }\n`;
}

// --- executable source capture ------------------------------------------------
// GLES links the shaders' compiled state, not their current source strings.

const compiledSources = new WeakMap<WebGLShader, string>();
type LinkedSources = { vertex: string; fragment: string };
const linkedSources = new WeakMap<WebGLProgram, LinkedSources>();

export function recordCompiledShader(shader: WebGLShader, source: Uint8Array | string | undefined): void {
  if (source === undefined) { compiledSources.delete(shader); return; }
  if (typeof source === "string") { compiledSources.set(shader, source); return; }
  try { compiledSources.set(shader, new TextDecoder().decode(source)); }
  catch (caught) { rethrowNativeGlFault(caught); compiledSources.delete(shader); }
}

export function compiledShaderSource(shader: WebGLShader): string | undefined {
  return compiledSources.get(shader);
}

/** A private executable built from rewritten sources (attribute aliasing)
 * records the sources its native link actually used. */
export function recordLinkedSources(program: WebGLProgram, vertex: string, fragment: string): void {
  linkedSources.set(program, { vertex, fragment });
}

/** Called after every native link attempt of `program`. A stale twin built
 * from an earlier executable is retired immediately. */
export function recordLinkedProgram(b: GlBinding, program: WebGLProgram, linked: boolean, shaders: Iterable<WebGLShader>): void {
  releaseReversedDepthTwin(b, program);
  linkedSources.delete(program);
  if (!linked) return;
  let vertex: string | undefined, fragment: string | undefined;
  for (const shader of shaders) {
    let type = 0;
    if (!checkedGlCall(b, () => { type = Number(b.gl!.getShaderParameter(shader, 0x8b4f)); })) return;
    if (type === VERTEX_SHADER) vertex = compiledSources.get(shader);
    else if (type === FRAGMENT_SHADER) fragment = compiledSources.get(shader);
  }
  if (vertex !== undefined && fragment !== undefined) linkedSources.set(program, { vertex, fragment });
}

// --- uniform write generations ------------------------------------------------

const uniformWrites = new WeakMap<WebGLProgram, number>();
/** Uniform commands always address the installed executable (ES 2.0 2.10.4). */
export function noteUniformWrite(program: WebGLProgram | null): void {
  if (program) uniformWrites.set(program, (uniformWrites.get(program) ?? 0) + 1);
}

// --- twins ----------------------------------------------------------------------

/** One private draw executable of a guest executable. A draw may need a
 * reversed depth range, luminance sampling of depth textures
 * (depth-sampling.ts) and/or a folded blend source factor
 * (blend-constant.ts); each combination is one variant, keyed by all. */
export type VariantOptions = { reversedDepth: boolean; depthSamplers: readonly string[];
  /** [RUNTIME-WORKAROUND: FIREFOX-VERTEX-DEPTH-RANGE-UNIFORM] The vertex stage reads gl_DepthRange from a private uniform. */
  vertexDepthRange?: boolean;
  /** The fragment color is multiplied by the RGB source blend factor, with
   * fixed-point or floating-point color buffer clamping. */
  blendFold?: "fixed" | "float" };
type Twin = { program: WebGLProgram; sources: LinkedSources; uniforms: number; vertexDepthRange: boolean; rangeValues: string | null;
  blendFold: boolean; blendFactor: readonly number[] | null };
const twins = new WeakMap<WebGLProgram, Map<string, Twin>>();

function variantKey(options: VariantOptions): string {
  return `${options.reversedDepth ? 1 : 0}|${options.vertexDepthRange ? 1 : 0}|${options.blendFold ?? ""}|${options.depthSamplers.join(",")}`;
}

function deleteTwin(owner: CheckedGlOwner, twin: Twin): void {
  checkedGlCall(owner, () => {
    if (owner.gl!.getParameter(0x8b8d) === twin.program) owner.gl!.useProgram(null);
    owner.gl!.deleteProgram(twin.program);
  });
}

/** Every path that deletes a guest executable releases all its variants. */
export function releaseReversedDepthTwin(owner: CheckedGlOwner, program: WebGLProgram): void {
  const variants = twins.get(program);
  if (!variants || !owner.gl) return;
  twins.delete(program);
  for (const twin of variants.values()) deleteTwin(owner, twin);
}

/** One stage of a variant: depth-sampler lookups first, then the reversed
 * depth wrapper around the (already renamed-free) result. */
export function variantStageSource(source: string, vertex: boolean, options: VariantOptions): string | null {
  let result: string | null = source;
  if (options.depthSamplers.length) result = depthSamplingShaderSource(source, new Set(options.depthSamplers));
  if (result !== null && options.reversedDepth) result = reversedDepthShaderSource(result, vertex);
  // Wraps the whole fragment stage, so it multiplies the final color.
  if (result !== null && !vertex && options.blendFold) result = blendFoldShaderSource(result, options.blendFold === "fixed");
  // [RUNTIME-WORKAROUND: FIREFOX-VERTEX-DEPTH-RANGE-UNIFORM] Outermost, so the
  // reversed-depth prologue's gl_DepthRange reads are redirected too.
  if (result !== null && vertex && options.vertexDepthRange) result = vertexDepthRangeShaderSource(result);
  return result;
}

function buildTwin(b: GlBinding, primary: WebGLProgram, sources: LinkedSources, options: VariantOptions): Twin | null {
  const vertexSource = variantStageSource(sources.vertex, true, options);
  const fragmentSource = variantStageSource(sources.fragment, false, options);
  if (vertexSource === null || fragmentSource === null) return null;
  const gl = b.gl!;
  let vs: WebGLShader | null = null, fs: WebGLShader | null = null, program: WebGLProgram | null = null;
  let linked = false;
  try {
    if (!checkedGlCall(b, () => {
      vs = gl.createShader(VERTEX_SHADER); fs = gl.createShader(FRAGMENT_SHADER); program = gl.createProgram();
    }) || !vs || !fs || !program) return null;
    const v = vs as WebGLShader, f = fs as WebGLShader, p = program as WebGLProgram;
    if (!checkedGlCall(b, () => {
      gl.shaderSource(v, vertexSource);
      gl.shaderSource(f, fragmentSource);
      gl.compileShader(v); gl.compileShader(f);
      gl.attachShader(p, v); gl.attachShader(p, f);
      // Pin every active attribute to the guest executable's location, so
      // the guest's vertex array state feeds the twin unchanged.
      const count = Number(gl.getProgramParameter(primary, 0x8b89));
      for (let i = 0; i < count; i++) {
        const info = gl.getActiveAttrib(primary, i);
        if (!info || info.name.startsWith("gl_")) continue;
        const location = gl.getAttribLocation(primary, info.name);
        if (location >= 0) gl.bindAttribLocation(p, location, info.name);
      }
      gl.linkProgram(p);
      linked = !!gl.getProgramParameter(p, 0x8b82);
    })) return null;
    if (!linked) return null;
    return { program: p, sources, uniforms: -1, vertexDepthRange: !!options.vertexDepthRange, rangeValues: null,
      blendFold: !!options.blendFold, blendFactor: null };
  } finally {
    // Shaders stay alive while attached; the twin program owns them now.
    checkedGlCall(b, () => {
      if (vs) gl.deleteShader(vs);
      if (fs) gl.deleteShader(fs);
      if (program && !linked) gl.deleteProgram(program);
    });
  }
}

const FLOAT_VECTORS = new Map([[0x1406, 1], [0x8b50, 2], [0x8b51, 3], [0x8b52, 4]]);
const INT_VECTORS = new Map([[0x1404, 1], [0x8b53, 2], [0x8b54, 3], [0x8b55, 4],
  [0x8b56, 1], [0x8b57, 2], [0x8b58, 3], [0x8b59, 4]]);
const UINT_VECTORS = new Map([[0x1405, 1], [0x8dc6, 2], [0x8dc7, 3], [0x8dc8, 4]]);
const MATRICES = new Map<number, keyof WebGL2RenderingContext>([
  [0x8b5a, "uniformMatrix2fv"], [0x8b5b, "uniformMatrix3fv"], [0x8b5c, "uniformMatrix4fv"],
  [0x8b65, "uniformMatrix2x3fv"], [0x8b66, "uniformMatrix2x4fv"], [0x8b67, "uniformMatrix3x2fv"],
  [0x8b68, "uniformMatrix3x4fv"], [0x8b69, "uniformMatrix4x2fv"], [0x8b6a, "uniformMatrix4x3fv"],
]);

function numbers(value: unknown): number[] {
  if (typeof value === "number") return [value];
  if (typeof value === "boolean") return [value ? 1 : 0];
  if (Array.isArray(value)) return value.map(x => typeof x === "boolean" ? (x ? 1 : 0) : Number(x));
  if (ArrayBuffer.isView(value)) return Array.from(value as unknown as ArrayLike<number>);
  return [];
}

type VectorSetter<T> = (location: WebGLUniformLocation, values: T) => void;
function setUniform(gl: WebGL2RenderingContext, type: number, to: WebGLUniformLocation, values: number[]): void {
  const matrix = MATRICES.get(type);
  if (matrix) {
    (gl[matrix] as (l: WebGLUniformLocation, t: boolean, v: Float32Array) => void).call(gl, to, false, new Float32Array(values));
    return;
  }
  const floats = FLOAT_VECTORS.get(type);
  if (floats) { (gl[`uniform${floats}fv` as "uniform1fv"] as VectorSetter<Float32Array>).call(gl, to, new Float32Array(values)); return; }
  const unsigned = UINT_VECTORS.get(type);
  if (unsigned) { (gl[`uniform${unsigned}uiv` as "uniform1uiv"] as VectorSetter<Uint32Array>).call(gl, to, new Uint32Array(values)); return; }
  // Integers, booleans (set through the integer entry points) and samplers.
  (gl[`uniform${INT_VECTORS.get(type) ?? 1}iv` as "uniform1iv"] as VectorSetter<Int32Array>).call(gl, to, new Int32Array(values));
}

/** Copy every active guest uniform (including samplers) into the installed
 * twin. Uniform setters address the installed program, so the twin must be
 * current. Every value is read back from the guest executable itself. */
function copyUniforms(b: GlBinding, primary: WebGLProgram, twin: WebGLProgram): boolean {
  const gl = b.gl!;
  return checkedGlCall(b, () => {
    const count = Number(gl.getProgramParameter(primary, 0x8b86));
    for (let i = 0; i < count; i++) {
      const info = gl.getActiveUniform(primary, i);
      if (!info || info.name.startsWith("gl_")) continue;
      const array = info.name.endsWith("[0]"), base = array ? info.name.slice(0, -3) : info.name;
      for (let element = 0; element < info.size; element++) {
        const name = array ? `${base}[${element}]` : base;
        const from = gl.getUniformLocation(primary, name), to = gl.getUniformLocation(twin, name);
        if (!from || !to) continue;
        setUniform(gl, info.type, to, numbers(gl.getUniform(primary, from)));
      }
    }
  });
}

/** Resolve the private executable for a reversed-range draw of the installed
 * guest executable. Undefined means no program is installed (the ordinary
 * draw path reports that). Null means an error was recorded: the twin could
 * not be built, so the draw is refused rather than rendered with the wrong
 * depth mapping. */
export function drawVariantExecutable(b: GlBinding): WebGLProgram | null | undefined {
  const primary = b.currentProgram;
  if (!primary) return undefined;
  const reversedDepth = depthRangeReversed(b.shadow.depthRange);
  const depthSamplers = depthSamplersForDraw(b);
  if (depthSamplers === null) return null;
  // [RUNTIME-WORKAROUND: FIREFOX-VERTEX-DEPTH-RANGE-UNIFORM] Only programs
  // meeting the reproduced trigger, and only on the affected engine.
  const affected = engineLosesVertexDepthRange();
  // One shadow field test for draws without a constant color/alpha pair.
  const folding = blendFoldNeeded(b.shadow);
  if (!reversedDepth && !depthSamplers.length && !affected && !folding) return undefined;
  const sources = linkedSources.get(primary);
  const vertexDepthRange = affected && sources ? vertexDepthRangeWorkaround(b, primary, sources) : false;
  if (vertexDepthRange === null) return null;
  const blendFold = folding ? drawColorBufferKind(b) : undefined;
  if (blendFold === null) return null;
  // Draws needing none of these run the guest executable itself.
  if (!reversedDepth && !depthSamplers.length && !vertexDepthRange && !blendFold) return undefined;
  const options = { reversedDepth, depthSamplers, vertexDepthRange, blendFold }, key = variantKey(options);
  let variants = twins.get(primary);
  if (variants && [...variants.values()].some(twin => twin.sources !== sources)) {
    releaseReversedDepthTwin(b, primary); variants = undefined;
  }
  let twin = variants?.get(key);
  if (!twin) {
    const built = sources ? buildTwin(b, primary, sources, options) : null;
    // INVALID_OPERATION is the WebGL boundary error the draw would otherwise
    // raise; recording it keeps an unemulated draw visible.
    if (!built) { recordGlError(b, 0x502); return null; }
    if (!variants) twins.set(primary, variants = new Map());
    variants.set(key, twin = built);
  }
  return twin.program;
}

/** Install-time half of a reversed draw: the twin is current; refresh its
 * uniform values if the guest changed any since the last copy. */
export function synchronizeReversedDepthTwin(b: GlBinding, twinProgram: WebGLProgram): boolean {
  const primary = b.currentProgram;
  const twin = primary ? [...twins.get(primary)?.values() ?? []].find(variant => variant.program === twinProgram) : undefined;
  if (!primary || !twin) { recordGlError(b, 0x502); return false; }
  const generation = uniformWrites.get(primary) ?? 0;
  if (twin.uniforms !== generation) {
    if (!copyUniforms(b, primary, twin.program)) return false;
    twin.uniforms = generation;
  }
  if (twin.vertexDepthRange) {
    // [RUNTIME-WORKAROUND: FIREFOX-VERTEX-DEPTH-RANGE-UNIFORM] The private
    // uniform carries what WebGL would give gl_DepthRange for this draw.
    const values = nativeDepthRangeValues(b.shadow.depthRange), key = values.join(",");
    if (twin.rangeValues !== key) {
      const gl = b.gl!;
      if (!checkedGlCall(b, () => gl.uniform3f(gl.getUniformLocation(twin.program, NATIVE_DEPTH_RANGE_UNIFORM), ...values))) return false;
      twin.rangeValues = key;
    }
  }
  // The folded factor changes only with BlendFunc/BlendColor, which replace
  // the shadow's array; an unchanged array needs no upload.
  const factor = b.shadow.blendSourceFactor;
  if (twin.blendFold && factor && twin.blendFactor !== factor) {
    const gl = b.gl!;
    if (!checkedGlCall(b, () => gl.uniform3f(gl.getUniformLocation(twin.program, BLEND_SOURCE_FACTOR_UNIFORM), ...factor))) return false;
    twin.blendFactor = factor;
  }
  return true;
}
