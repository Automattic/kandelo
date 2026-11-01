/**
 * [RUNTIME-WORKAROUND: FIREFOX-VERTEX-DEPTH-RANGE-UNIFORM] Firefox (Gecko
 * WebGL 2) gives the vertex stage a wrong gl_DepthRange when both stages read
 * gl_DepthRange and the program has another active uniform: the vertex stage
 * reads that uniform's value as gl_DepthRange.near and zero for far and diff.
 * The registry entry holds the standalone, self-judging reproduction.
 *
 * Only that confirmed condition is changed, on Firefox only. The draw runs a
 * private variant (reversed-depth.ts) whose vertex stage reads the native
 * range from a private uniform instead of gl_DepthRange, so the program no
 * longer has both stages reading the built-in. The fragment stage, guest
 * reflection and guest uniforms are unchanged; the private uniform exists only
 * in the variant, which the guest never observes.
 */
import type { GlBinding } from "./registry.js";
import { checkedGlCall } from "./program-objects.js";
import { headerEnd, nativeDepthRange, renameIdentifiers } from "./reversed-depth.js";
import { glslTokens } from "./attribute-aliasing.js";

export const NATIVE_DEPTH_RANGE_UNIFORM = "kandelo_native_depth_range_values";
const RANGE = "kandelo_native_depth_range", RANGE_TYPE = "kandelo_native_depth_range_parameters";
const MAIN = "kandelo_native_depth_range_main";

/** Gecko's WebGL implementation, where the defect reproduces. Asked on
 * every draw, so the answer is kept for the last user agent seen. */
let lastAgent: string | undefined, lastLoses = false;
export function engineLosesVertexDepthRange(
  userAgent = (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent,
): boolean {
  if (userAgent !== lastAgent) { lastAgent = userAgent; lastLoses = userAgent !== undefined && /\bFirefox\//.test(userAgent); }
  return lastLoses;
}

function readsDepthRange(source: string): boolean {
  return glslTokens(source, true).some(token => token.text === "gl_DepthRange");
}

const conditions = new WeakMap<WebGLProgram, { sources: object; applies: boolean }>();
/** Both stages read gl_DepthRange and the program has another active uniform
 * (the reproduction's trigger). Cached per linked executable. Null means a
 * native query failed (recorded). */
export function vertexDepthRangeWorkaround(b: GlBinding, program: WebGLProgram,
    sources: { vertex: string; fragment: string }): boolean | null {
  if (!engineLosesVertexDepthRange()) return false;
  const cached = conditions.get(program);
  if (cached?.sources === sources) return cached.applies;
  let applies = readsDepthRange(sources.vertex) && readsDepthRange(sources.fragment);
  if (applies) {
    const gl = b.gl!;
    let other = false;
    if (!checkedGlCall(b, () => {
      const count = Number(gl.getProgramParameter(program, 0x8b86));
      for (let i = 0; i < count && !other; i++) other = !(gl.getActiveUniform(program, i)?.name.startsWith("gl_") ?? true);
    })) return null;
    applies = other;
  }
  conditions.set(program, { sources, applies });
  return applies;
}

/** The vertex stage reads gl_DepthRange from a private struct filled from
 * NATIVE_DEPTH_RANGE_UNIFORM before the stage's own main runs. Applied last,
 * so the reversed-depth prologue's reads are redirected as well. */
export function vertexDepthRangeShaderSource(source: string): string {
  const text = renameIdentifiers(source, new Map([
    ["main", MAIN], ["gl_DepthRange", RANGE], ["gl_DepthRangeParameters", RANGE_TYPE],
  ])).text;
  const at = headerEnd(text);
  const lead = at > 0 && text[at - 1] !== "\n" ? "\n" : "";
  const line = text.slice(0, at).split("\n").length + (lead ? 1 : 0);
  return text.slice(0, at) + lead +
    `struct ${RANGE_TYPE} { highp float near; highp float far; highp float diff; };\n` +
    `${RANGE_TYPE} ${RANGE};\nuniform highp vec3 ${NATIVE_DEPTH_RANGE_UNIFORM};\n#line ${line}\n` + text.slice(at) +
    `\nvoid main() { ${RANGE}.near = ${NATIVE_DEPTH_RANGE_UNIFORM}.x; ${RANGE}.far = ${NATIVE_DEPTH_RANGE_UNIFORM}.y; ` +
    `${RANGE}.diff = ${NATIVE_DEPTH_RANGE_UNIFORM}.z; ${MAIN}(); }\n`;
}

/** The values WebGL would give gl_DepthRange for the shadow's logical range:
 * the ordered native pair and its float32 difference. */
export function nativeDepthRangeValues(range: readonly [number, number]): [number, number, number] {
  const [near, far] = nativeDepthRange(range).map(Math.fround);
  return [near, far, Math.fround(far - near)];
}
