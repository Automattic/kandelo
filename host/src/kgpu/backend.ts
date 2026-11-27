/**
 * The platform renderer a GPU worker drives on the Rust executor's behalf.
 *
 * Ownership: the executor (crates/gpu-executor) decides what runs; a backend
 * only performs it on one platform (WebGL 2, or nothing). The GPU worker
 * adapts a backend to the executor's `kgpu_backend` imports, including the
 * copy of read-back pixels into the memory group's backing, so a backend
 * never sees a guest address, an extent or executor memory.
 *
 * Status-returning calls answer 0 or a negative errno, as the imports do.
 */
import { ERRNO } from "../generated/abi.ts";

export interface KgpuBackend {
  createSurface(context: number, width: number, height: number): number;
  destroySurface(context: number): void;
  viewport(context: number, x: number, y: number, w: number, h: number): void;
  clearColor(context: number, r: number, g: number, b: number, a: number): void;
  clear(context: number, mask: number): void;
  /** Read `w`x`h` RGBA8 pixels of the context's surface into `out`
   * (`w*h*4` bytes, rows bottom to top as GL reads them). */
  readPixels(context: number, x: number, y: number, w: number, h: number, out: Uint8Array): number;
  /** The renderer itself is gone (for WebGL, the context was lost). */
  isLost(): boolean;
}

// Errno values come from the generated ABI, as the executor's do.
export const { ENODEV, EIO, EEXIST, ENOENT, EINVAL, EFAULT, ENOMEM } = ERRNO;
