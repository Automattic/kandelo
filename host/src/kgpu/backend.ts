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
  /** Accept a context, which holds no surface yet. */
  createContext(context: number): number;
  /** Release a context and every surface it still holds. */
  destroyContext(context: number): void;
  /** Allocate a `width`x`height` RGBA8 surface named `surface` (nonzero,
   * unique within its context) in the context. */
  createSurface(context: number, surface: number, width: number, height: number): number;
  /** Release one surface; if it was bound, none is bound. */
  destroySurface(context: number, surface: number): void;
  /** Make `surface` the target of later clears and reads; 0 = none. */
  bindSurface(context: number, surface: number): void;
  viewport(context: number, x: number, y: number, w: number, h: number): void;
  clearColor(context: number, r: number, g: number, b: number, a: number): void;
  clear(context: number, mask: number): void;
  /** Read `w`x`h` RGBA8 pixels of the context's bound surface into `out`
   * (`w*h*4` bytes, rows bottom to top as GL reads them). */
  readPixels(context: number, x: number, y: number, w: number, h: number, out: Uint8Array): number;
  /** The renderer itself is gone (for WebGL, the context was lost). */
  isLost(): boolean;
}

// Errno values come from the generated ABI, as the executor's do.
export const { ENODEV, EIO, EEXIST, ENOENT, EINVAL, EFAULT, ENOMEM } = ERRNO;
