/**
 * Browser canvas renderer for `/dev/fb0` bindings.
 *
 * `attachCanvas(canvas, registry, pid, opts)` starts a `requestAnimationFrame`
 * loop that snapshots the bound region of the process's wasm Memory SAB and
 * blits it to a 2D canvas. The kernel emits BGRA32 pixels; canvas
 * `ImageData` expects RGBA, so each frame copies into a local BGRA scratch
 * buffer and then swizzles into a parallel RGBA scratch buffer.
 *
 * The renderer is ignorant of the program that draws: it blits whatever
 * bytes the registry says are bound. Returns a stop function to cancel
 * the RAF loop.
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

  // Scratch buffers for framebuffer presentation. `scratchBgra` is a
  // non-shared snapshot of the guest framebuffer; swizzling from that stable
  // snapshot avoids building one browser frame from multiple concurrent guest
  // draw states. `scratchRgba` backs ImageData; the canvas API refuses
  // Uint8ClampedArray views over SharedArrayBuffer.
  let scratchBgra: Uint8ClampedArray<ArrayBuffer> | null = null;
  let scratchRgba: Uint8ClampedArray<ArrayBuffer> | null = null;
  let imageData: ImageData | null = null;

  let raf = 0;
  const tick = () => {
    raf = requestAnimationFrame(tick);

    const binding = registry.get(pid);
    if (!binding) return;

    if (canvas.width !== binding.w) canvas.width = binding.w;
    if (canvas.height !== binding.h) canvas.height = binding.h;

    if (!binding.view) {
      if (binding.hostBuffer) {
        // Write-based binding: the host owns the pixel buffer.
        binding.view = binding.hostBuffer;
      } else {
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
    }

    const visibleByteLen = binding.w * binding.h * 4;
    const requiredSourceLen = binding.h === 0
      ? 0
      : (binding.h - 1) * binding.stride + binding.w * 4;
    if (binding.view.length < requiredSourceLen) return;

    if (!scratchBgra || scratchBgra.length !== requiredSourceLen) {
      scratchBgra = new Uint8ClampedArray(new ArrayBuffer(requiredSourceLen));
    }
    if (!scratchRgba || scratchRgba.length !== visibleByteLen) {
      scratchRgba = new Uint8ClampedArray(new ArrayBuffer(visibleByteLen));
      imageData = new ImageData(scratchRgba, binding.w, binding.h);
    } else if (!imageData || imageData.width !== binding.w || imageData.height !== binding.h) {
      imageData = new ImageData(scratchRgba, binding.w, binding.h);
    }

    scratchBgra.set(binding.view.subarray(0, requiredSourceLen));
    swizzleBgraToRgba(scratchBgra, scratchRgba, binding.w, binding.h, binding.stride);
    ctx.putImageData(imageData, 0, 0);
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
function swizzleBgraToRgba(
  src: Uint8ClampedArray,
  dst: Uint8ClampedArray,
  width: number,
  height: number,
  stride: number,
): void {
  // Force alpha=255 in the destination. fbdev pixel formats carry an
  // alpha channel as documented by FBIOGET_VSCREENINFO, but many fbdev
  // clients leave it as 0; copying that through would render the canvas
  // transparent.
  for (let y = 0; y < height; y++) {
    const srcRow = y * stride;
    const dstRow = y * width * 4;
    for (let x = 0; x < width; x++) {
      const si = srcRow + x * 4;
      const di = dstRow + x * 4;
      dst[di] = src[si + 2];
      dst[di + 1] = src[si + 1];
      dst[di + 2] = src[si];
      dst[di + 3] = 0xff;
    }
  }
}
