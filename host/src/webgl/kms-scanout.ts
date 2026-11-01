import { checkedGlCall, checkedGlSequence } from "./program-objects.js";
import { applyNativeChanges, nativeInverse, type NativeCall } from "./native-recovery.js";

export type GpuScanoutStorage = { gl: WebGL2RenderingContext; fbo: WebGLFramebuffer; w: number; h: number };

/** The caller retains the selected framebuffer/storage through this synchronous
 * operation. All changed native selectors have retryable inverse records. */
/** Present the `width` x `height` region at (`x`, `y`) of the KMS BO (the
 * CRTC's panned viewport). BO row zero is the top row, hence the Y inversion. */
export function drawGpuScanout(storage: GpuScanoutStorage, width: number, height: number, x = 0, y = 0): boolean {
  if (![x, y, width, height].every(Number.isSafeInteger) || x < 0 || y < 0
      || x + width > storage.w || y + height > storage.h) return false;
  const gl = storage.gl, owner = { gl, errors: [] as number[] };
  let read: WebGLFramebuffer | null = null, draw: WebGLFramebuffer | null = null, scissor = false;
  let mask: boolean[] = [], clear: number[] = [];
  if (!checkedGlCall(owner, () => {
    read = gl.getParameter(0x8caa); draw = gl.getParameter(0x8ca6);
    scissor = !!gl.getParameter(0x0c11);
    mask = Array.from(gl.getParameter(0x0c23), Boolean);
    clear = Array.from(gl.getParameter(0x0c22), Number);
  }) || mask.length !== 4 || clear.length !== 4 || !clear.every(Number.isFinite)) return false;
  const readChanged = read !== storage.fbo, drawChanged = draw !== null;
  const maskChanged = mask.some((value, index) => value !== (index === 3));
  const clearChanged = clear[3] !== 1;
  // Admission uses this operation's checked native snapshot, never a shadow or
  // cross-call cache. Reserve every attempted selector's inverse before effects.
  const restore = nativeInverse(owner,
    drawChanged ? [["bindFramebuffer", 0x8ca9, draw]] : [],
    readChanged ? [["bindFramebuffer", 0x8ca8, read]] : [],
    scissor ? [["enable", 0x0c11]] : [],
    maskChanged ? [["colorMask", mask[0], mask[1], mask[2], mask[3]]] : [],
    clearChanged ? [["clearColor", clear[0], clear[1], clear[2], clear[3]]] : []);
  const calls: (() => void)[] = [];
  if (scissor) calls.push(() => gl.disable(0x0c11));
  if (readChanged) calls.push(() => gl.bindFramebuffer(0x8ca8, storage.fbo));
  if (drawChanged) calls.push(() => gl.bindFramebuffer(0x8ca9, null));
  calls.push(() => gl.blitFramebuffer(x, y, x + width, y + height, 0, height, width, 0, 0x4000, 0x2600));
  // The primary KMS plane is opaque. Preserve alpha in the BO for image
  // siblings, but do not expose the page background through scanout. RGB is
  // masked off for this clear, so its captured clear values need no change.
  if (maskChanged) calls.push(() => gl.colorMask(false, false, false, true));
  if (clearChanged) calls.push(() => gl.clearColor(clear[0], clear[1], clear[2], 1));
  calls.push(() => gl.clear(0x4000));
  return applyNativeChanges({ ...owner, shadow: {} }, [{ restore,
    apply: () => checkedGlSequence(owner, calls),
  }], { shared: true, finalizer: restore });
}

/** A different display context (including an explicitly 2D display) needs an
 * owned readback, since WebGL textures cannot cross native contexts. KMS BO
 * row zero is the top row, matching the direct scanout blit's Y inversion. */
export function readGpuScanout(storage: GpuScanoutStorage, width: number, height: number, x = 0, y = 0): Uint8Array<ArrayBuffer> | null {
  const gl = storage.gl, owner = { gl, errors: [] as number[] };
  const length = width * height * 4;
  if (![x, y, width, height, length].every(Number.isSafeInteger) || width <= 0 || height <= 0
      || x < 0 || y < 0 || x + width > storage.w || y + height > storage.h) return null;
  const pixels = new Uint8Array(length);
  let read: WebGLFramebuffer | null = null, pack: WebGLBuffer | null = null;
  const fields = [0x0d05, 0x0d02, 0x0d04, 0x0d03]; // alignment, row length, skip pixels/rows
  let values: number[] = [];
  if (!checkedGlCall(owner, () => {
    read = gl.getParameter(0x8caa); pack = gl.getParameter(0x88ed);
    values = fields.map(field => Number(gl.getParameter(field)));
  }) || !values.every(Number.isInteger)) return null;
  // RGBA/UNSIGNED_BYTE rows are width*4 bytes. A captured alignment that
  // divides that row already produces tightly packed rows (including 8 at even
  // widths); retain it. Odd-width rows with alignment 8 need alignment 4.
  const rowBytes = width * 4;
  const alignment = [1, 2, 4, 8].includes(values[0]) && rowBytes % values[0] === 0 ? values[0] : 4;
  const desired = [alignment, 0, 0, 0];
  const readChanged = read !== storage.fbo, packChanged = pack !== null;
  const layoutRestore: NativeCall[] = [];
  const calls: (() => void)[] = [];
  if (readChanged) calls.push(() => gl.bindFramebuffer(0x8ca8, storage.fbo));
  if (packChanged) calls.push(() => gl.bindBuffer(0x88eb, null));
  for (let index = 0; index < fields.length; index++) if (values[index] !== desired[index]) {
    const field = fields[index], value = desired[index];
    layoutRestore.push(["pixelStorei", field, values[index]]);
    calls.push(() => gl.pixelStorei(field, value));
  }
  const restore = nativeInverse(owner,
    readChanged ? [["bindFramebuffer", 0x8ca8, read]] : [],
    packChanged ? [["bindBuffer", 0x88eb, pack]] : [], layoutRestore);
  calls.push(() => gl.readPixels(x, y, width, height, 0x1908, 0x1401, pixels));
  const accepted = applyNativeChanges({ ...owner, shadow: {} }, [{ restore,
    apply: () => checkedGlSequence(owner, calls),
  }], { shared: true, finalizer: restore });
  return accepted ? pixels : null;
}
