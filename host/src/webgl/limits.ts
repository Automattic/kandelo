/** Immutable limits belong to the native context, independently of whichever
 * guest currently owns its mutable state. Weak keys do not retain a retired
 * browser context. Do not cache null results from a lost context. */
const textureLimits = new WeakMap<WebGL2RenderingContext, number>();
const viewportLimits = new WeakMap<WebGL2RenderingContext, readonly [number, number]>();

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
