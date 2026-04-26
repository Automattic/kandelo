/**
 * Browser canvas renderer for `/dev/fb0` bindings.
 *
 * `attachCanvas(canvas, registry, pid, opts)` starts a `requestAnimationFrame`
 * loop that reads the bound region of the process's wasm Memory SAB and
 * blits it to a 2D canvas. The kernel emits BGRA32 pixels; canvas
 * `ImageData` expects RGBA, so each frame swizzles into a parallel RGBA
 * scratch buffer.
 *
 * The renderer is ignorant of fbDOOM (or anything else that draws): it
 * blits whatever bytes the registry says are bound. Returns a stop
 * function to cancel the RAF loop.
 *
 * Notes:
 *   - The view + scratch are rebuilt whenever `binding.view` becomes null
 *     (see `FramebufferRegistry.rebindMemory`, fired after `Memory.grow`).
 *   - Canvas size auto-syncs to `binding.{w,h}` so the consumer doesn't
 *     have to pre-size the element.
 *   - The renderer does NOT subscribe to `registry.onChange`; the RAF loop
 *     polls. That keeps state simple and avoids a per-bind/unbind handler
 *     stack. The polling cost is ~one Map lookup per frame.
 */
import type { FramebufferRegistry } from "./registry.js";

/** Per-canvas options the renderer needs from the embedding app. */
export interface CanvasAttachOpts {
  /**
   * Return the wasm `Memory` for the given pid. The renderer reads the
   * bound region directly from `memory.buffer` (a SharedArrayBuffer).
   * Throwing here is fatal for the current frame; the renderer will
   * retry on the next tick.
   */
  getProcessMemory(pid: number): WebAssembly.Memory | undefined;
}

export function attachCanvas(
  canvas: HTMLCanvasElement,
  registry: FramebufferRegistry,
  pid: number,
  opts: CanvasAttachOpts,
): () => void {
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("canvas 2d context unavailable");

  // Scratch buffer for the BGRA → RGBA swizzle. Backed by a *non-shared*
  // ArrayBuffer so it can be wrapped in an ImageData (the canvas API
  // refuses Uint8ClampedArray views over SharedArrayBuffer).
  let scratchRgba: Uint8ClampedArray<ArrayBuffer> | null = null;

  let raf = 0;
  const tick = () => {
    raf = requestAnimationFrame(tick);

    const binding = registry.get(pid);
    if (!binding) return;

    if (canvas.width !== binding.w) canvas.width = binding.w;
    if (canvas.height !== binding.h) canvas.height = binding.h;

    if (!binding.view) {
      const memory = opts.getProcessMemory(pid);
      if (!memory) return;
      try {
        binding.view = new Uint8ClampedArray(
          memory.buffer,
          binding.addr,
          binding.len,
        );
      } catch {
        // Buffer was detached between rebindMemory() and the next
        // tick; try again on the next frame.
        return;
      }
    }

    if (!scratchRgba || scratchRgba.length !== binding.len) {
      scratchRgba = new Uint8ClampedArray(new ArrayBuffer(binding.len));
    }

    swizzleBgraToRgba(binding.view, scratchRgba);
    ctx.putImageData(new ImageData(scratchRgba, binding.w, binding.h), 0, 0);
  };

  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
}

/**
 * BGRA → RGBA channel swap. ~1MB per frame at 640×400 BGRA32; trivial
 * cost on any modern device. If profiling ever shows it's a bottleneck
 * (it won't), upgrade to a WebGL texture upload that consumes BGRA
 * directly.
 */
function swizzleBgraToRgba(src: Uint8ClampedArray, dst: Uint8ClampedArray): void {
  for (let i = 0; i < src.length; i += 4) {
    dst[i]     = src[i + 2];
    dst[i + 1] = src[i + 1];
    dst[i + 2] = src[i];
    dst[i + 3] = src[i + 3];
  }
}
