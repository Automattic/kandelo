import { applyNativeChanges, nativeInverse, repairNativeState, type NativeCall } from "./native-recovery.js";
import { checkedGlCall } from "./program-objects.js";
import type { GlSurfaceResources } from "./surface-resources.js";

const READ = 0x8ca8, DRAW = 0x8ca9, READ_BINDING = 0x8caa, DRAW_BINDING = 0x8ca6;
const READ_BUFFER = 0x0c02, COLOR0 = 0x8ce0, SCISSOR = 0x0c11;
type GpuFront = { gl: WebGL2RenderingContext; fbo: WebGLFramebuffer; w: number; h: number };

/** Pure preflights shared with the state-borrowing caller. Invalid requests
 * retain their original errno before any private error capture or repair. */
export function validGbmFrontCopy(surface: GlSurfaceResources, target: GpuFront): boolean {
  const gl = surface.gl, size = surface.surfaceSize, source = surface.renderTargetFbo;
  return !!gl && !!source && !!size && gl === target.gl && source !== target.fbo &&
    Number.isInteger(size.width) && Number.isInteger(size.height) &&
    size.width > 0 && size.height > 0 && size.width === target.w && size.height === target.h;
}

export function validGbmFrontRead(surface: GlSurfaceResources): boolean {
  const size = surface.surfaceSize;
  return !!surface.gl && !!surface.renderTargetFbo && !!size &&
    Number.isSafeInteger(size.width) && Number.isSafeInteger(size.height) &&
    size.width > 0 && size.height > 0 && Number.isSafeInteger(size.width * size.height * 4);
}

/** A window uses GL's bottom-left coordinates; exported linear buffers have
 * row zero at the top. Copy into an unpublished front without changing the
 * render back or posting to a display. Failed copies cannot mutate a locked
 * front. The caller retains both allocations through this synchronous call. */
export function copyGbmFront(surface: GlSurfaceResources, target: GpuFront,
  capturePriorErrors: () => void): number {
  if (!validGbmFrontCopy(surface, target)) return -22;
  const gl = surface.gl!, size = surface.surfaceSize!, source = surface.renderTargetFbo!;
  // Error ownership is captured before entering private driver operations.
  // Repair records retain only native handles/scalars and this private queue.
  const owner = { gl, errors: [] as number[], shadow: {} };
  try {
    capturePriorErrors();
    if (gl.isContextLost() || !repairNativeState(gl)) return -5;
    let oldRead: WebGLFramebuffer | null = null, oldDraw: WebGLFramebuffer | null = null;
    let scissor = false;
    if (!checkedGlCall(owner, () => {
      oldRead = gl.getParameter(READ_BINDING);
      oldDraw = gl.getParameter(DRAW_BINDING);
      scissor = !!gl.getParameter(SCISSOR);
    })) return -5;
    const readGroup: NativeCall[] = [["bindFramebuffer", READ, source]];
    const sourceReadRestore = nativeInverse(owner, readGroup);
    const accepted = applyNativeChanges(owner, [
      {
        apply: () => checkedGlCall(owner, () => gl.disable(SCISSOR)),
        restore: nativeInverse(owner, [[scissor ? "enable" : "disable", SCISSOR]])
      },
      {
        apply: () => {
          if (!checkedGlCall(owner, () => gl.bindFramebuffer(READ, source))) return false;
          let value: unknown;
          if (!checkedGlCall(owner, () => { value = gl.getParameter(READ_BUFFER); }) ||
            !Number.isInteger(value)) return false;
          // Reserve the selector inverse before changing it. A failed
          // allocation here still has the earlier binding's inverse.
          readGroup.push(["readBuffer", value as number]);
          return true;
        }, restore: nativeInverse(owner, [["bindFramebuffer", READ, oldRead]])
      },
      { apply: () => checkedGlCall(owner, () => gl.readBuffer(COLOR0)), restore: sourceReadRestore },
      {
        apply: () => checkedGlCall(owner, () => gl.bindFramebuffer(DRAW, target.fbo)),
        restore: nativeInverse(owner, [["bindFramebuffer", DRAW, oldDraw]])
      },
      {
        apply: () => checkedGlCall(owner, () => gl.blitFramebuffer(0, 0, size.width, size.height,
          0, size.height, size.width, 0, gl.COLOR_BUFFER_BIT, gl.NEAREST)),
        restore: nativeInverse(owner)
      },
    ], {
      shared: true, finalizer: nativeInverse(owner,
        readGroup,
        [["bindFramebuffer", READ, oldRead]], [["bindFramebuffer", DRAW, oldDraw]],
        [[scissor ? "enable" : "disable", SCISSOR]])
    });
    return accepted ? 0 : owner.errors.includes(0x505) ? -12 : -5;
  } catch { return -5; }
}

/** Read the private render back into independent bottom-row-first RGBA bytes.
 * The CPU publication caller packs/normalizes those owned bytes only after
 * native restoration has succeeded. No guest view enters a repair record. */
export function readGbmFront(surface: GlSurfaceResources,
  capturePriorErrors: () => void): {rc: number; pixels?: Uint8Array<ArrayBuffer>} {
  if (!validGbmFrontRead(surface)) return {rc: -22};
  const gl = surface.gl!, size = surface.surfaceSize!, source = surface.renderTargetFbo!;
  let pixels: Uint8Array<ArrayBuffer>;
  try { pixels = new Uint8Array(size.width * size.height * 4); }
  catch { return {rc: -12}; }
  const owner = {gl, errors: [] as number[], shadow: {}};
  const failed = () => ({rc: owner.errors.includes(0x505) ? -12 : -5});
  try {
    capturePriorErrors();
    if (gl.isContextLost() || !repairNativeState(gl)) return {rc: -5};
    let oldRead: WebGLFramebuffer | null = null, oldPack: WebGLBuffer | null = null;
    const fields = [0x0d05, 0x0d02, 0x0d04, 0x0d03];
    let values: number[] = [];
    if (!checkedGlCall(owner, () => {
      oldRead = gl.getParameter(READ_BINDING); oldPack = gl.getParameter(0x88ed);
      values = fields.map(field => gl.getParameter(field));
    }) || !values.every(Number.isInteger)) return failed();
    const readGroup: NativeCall[] = [["bindFramebuffer", READ, source]];
    const readRestore = nativeInverse(owner, readGroup);
    const accepted = applyNativeChanges(owner, [
      {
        apply: () => {
          if (!checkedGlCall(owner, () => gl.bindFramebuffer(READ, source))) return false;
          let mode: unknown;
          if (!checkedGlCall(owner, () => { mode = gl.getParameter(READ_BUFFER); }) ||
              !Number.isInteger(mode)) return false;
          readGroup.push(["readBuffer", mode as number]);
          return true;
        }, restore: nativeInverse(owner, [["bindFramebuffer", READ, oldRead]])
      },
      {apply: () => checkedGlCall(owner, () => gl.readBuffer(COLOR0)), restore: readRestore},
      {apply: () => checkedGlCall(owner, () => gl.bindBuffer(0x88eb, null)),
        restore: nativeInverse(owner, [["bindBuffer", 0x88eb, oldPack]])},
      ...fields.map((field, index) => ({
        apply: () => checkedGlCall(owner, () => gl.pixelStorei(field, index === 0 ? 1 : 0)),
        restore: nativeInverse(owner, [["pixelStorei", field, values[index]]])
      })),
      {apply: () => checkedGlCall(owner, () => gl.readPixels(0, 0, size.width, size.height,
        0x1908, 0x1401, pixels)), restore: nativeInverse(owner)},
    ], {shared: true, finalizer: nativeInverse(owner, readGroup,
      [["bindFramebuffer", READ, oldRead]], [["bindBuffer", 0x88eb, oldPack]],
      fields.map((field, index) => ["pixelStorei", field, values[index]]))});
    return accepted ? {rc: 0, pixels} : failed();
  } catch { return {rc: -5}; }
}

/** Pack independent bottom-row-first RGBA readback into a top-row-first
 * linear GBM front. GPU fronts keep logical RGBA channels; only CPU byte
 * storage applies the native visual's channel order. */
export function packGbmFront(pixels: Uint8Array, destination: Uint8Array,
  width: number, height: number, pitch: number, format: number): void {
  const rowBytes = width * 4;
  if (![width,height,pitch,rowBytes,width*height*4,pitch*height].every(Number.isSafeInteger) ||
      width <= 0 || height <= 0 || pitch < rowBytes || pitch % 4 ||
      pixels.byteLength !== rowBytes * height || destination.byteLength !== pitch * height ||
      (format !== 0x34324241 && format !== 0x34325241))
    throw new RangeError("Invalid GBM front layout");
  for (let y = 0; y < height; ++y) {
    const start = (height - 1 - y) * rowBytes, target = y * pitch;
    if (format === 0x34324241) {
      destination.set(pixels.subarray(start,start+rowBytes),target);
    } else {
      for (let x = 0; x < rowBytes; x += 4) {
        destination[target+x] = pixels[start+x+2];
        destination[target+x+1] = pixels[start+x+1];
        destination[target+x+2] = pixels[start+x];
        destination[target+x+3] = pixels[start+x+3];
      }
    }
  }
}
