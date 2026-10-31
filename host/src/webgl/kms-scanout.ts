import { checkedGlCall, checkedGlSequence } from "./program-objects.js";
import { applyNativeChanges, nativeInverse } from "./native-recovery.js";

export type GpuScanoutStorage = { gl: WebGL2RenderingContext; fbo: WebGLFramebuffer; w: number; h: number };

/** The caller retains the selected framebuffer/storage through this synchronous
 * operation. All changed native selectors have retryable inverse records. */
export function drawGpuScanout(storage: GpuScanoutStorage, width: number, height: number): boolean {
  const gl = storage.gl, owner = { gl, errors: [] as number[] };
  let read: WebGLFramebuffer | null = null, draw: WebGLFramebuffer | null = null, scissor = false;
  let mask: boolean[] = [], clear: number[] = [];
  if (!checkedGlCall(owner, () => {
    read = gl.getParameter(0x8caa); draw = gl.getParameter(0x8ca6);
    scissor = !!gl.getParameter(0x0c11);
    mask = Array.from(gl.getParameter(0x0c23), Boolean);
    clear = Array.from(gl.getParameter(0x0c22), Number);
  }) || mask.length !== 4 || clear.length !== 4 || !clear.every(Number.isFinite)) return false;
  const restore = nativeInverse(owner,
    [["bindFramebuffer", 0x8ca9, draw]], [["bindFramebuffer", 0x8ca8, read]],
    [[scissor ? "enable" : "disable", 0x0c11]],
    [["colorMask", mask[0], mask[1], mask[2], mask[3]]],
    [["clearColor", clear[0], clear[1], clear[2], clear[3]]]);
  return applyNativeChanges({ ...owner, shadow: {} }, [{ restore, apply: () => checkedGlSequence(owner, [
    () => gl.disable(0x0c11),
    () => gl.bindFramebuffer(0x8ca8, storage.fbo),
    () => gl.bindFramebuffer(0x8ca9, null),
    () => gl.blitFramebuffer(0, 0, width, height, 0, height, width, 0, 0x4000, 0x2600),
    // The primary KMS plane is opaque. Preserve alpha in the BO for image
    // siblings, but do not expose the page background through scanout.
    () => gl.colorMask(false, false, false, true),
    () => gl.clearColor(0, 0, 0, 1),
    () => gl.clear(0x4000),
  ]),
  }], { shared: true, finalizer: restore });
}

/** A different display context (including an explicitly 2D display) needs an
 * owned readback, since WebGL textures cannot cross native contexts. KMS BO
 * row zero is the top row, matching the direct scanout blit's Y inversion. */
export function readGpuScanout(storage: GpuScanoutStorage, width: number, height: number): Uint8Array<ArrayBuffer> | null {
  const gl = storage.gl, owner = { gl, errors: [] as number[] };
  const length = width * height * 4;
  if (![width, height, length].every(Number.isSafeInteger) || width <= 0 || height <= 0
      || width > storage.w || height > storage.h) return null;
  const pixels = new Uint8Array(length);
  let read: WebGLFramebuffer | null = null, pack: WebGLBuffer | null = null;
  const fields = [0x0d05, 0x0d02, 0x0d04, 0x0d03]; // alignment, row length, skip pixels/rows
  let values: number[] = [];
  if (!checkedGlCall(owner, () => {
    read = gl.getParameter(0x8caa); pack = gl.getParameter(0x88ed);
    values = fields.map(field => Number(gl.getParameter(field)));
  }) || !values.every(Number.isInteger)) return null;
  const restore = nativeInverse(owner,
    [["bindFramebuffer", 0x8ca8, read]], [["bindBuffer", 0x88eb, pack]],
    fields.map((field, index) => ["pixelStorei", field, values[index]]));
  const accepted = applyNativeChanges({ ...owner, shadow: {} }, [{ restore, apply: () => checkedGlSequence(owner, [
    () => gl.bindFramebuffer(0x8ca8, storage.fbo),
    () => gl.bindBuffer(0x88eb, null),
    () => gl.pixelStorei(fields[0], 1),
    () => gl.pixelStorei(fields[1], 0),
    () => gl.pixelStorei(fields[2], 0),
    () => gl.pixelStorei(fields[3], 0),
    () => gl.readPixels(0, 0, width, height, 0x1908, 0x1401, pixels),
  ]) }], { shared: true, finalizer: restore });
  return accepted ? pixels : null;
}
