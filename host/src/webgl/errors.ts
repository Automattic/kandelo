export type GlErrorState = { errors: number[] };

export function recordGlError(owner: GlErrorState, error: number): void {
  if (error !== 0 && !owner.errors.includes(error)) owner.errors.push(error);
}

/** Native error flags belong to the selected logical context. Drain before
 * losing that identity; errors from unowned host operations have no guest
 * owner and must not be inherited by the next context. */
export function captureNativeGlErrors(gl: WebGL2RenderingContext, owner: GlErrorState | null): void {
  for (let i = 0; i < 32; i++) {
    const error = gl.getError();
    if (error === 0) return;
    if (!Number.isInteger(error) || error < 0 || error > 0xffff_ffff) {
      throw new Error("Invalid native GL error result");
    }
    if (owner) recordGlError(owner, error);
  }
  // A failed renderer cannot authorize a switch with errors still pending.
  throw new Error("Native GL error state did not clear");
}
