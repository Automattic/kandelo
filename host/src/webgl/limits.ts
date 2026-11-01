import { checkedGlCall, type CheckedGlOwner } from "./program-objects.js";

/** Immutable limits belong to the native context, independently of whichever
 * guest currently owns its mutable state. Weak keys do not retain a retired
 * browser context. Do not cache null results from a lost context. */
const textureLimits = new WeakMap<WebGL2RenderingContext, number>();
const viewportLimits = new WeakMap<WebGL2RenderingContext, readonly [number, number]>();

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
