/**
 * Browser canvas renderer for `/dev/fb0` bindings.
 *
 * `attachCanvas(canvas, registry, pid)` starts a `requestAnimationFrame`
 * loop that reads independent host pixels and blits them to a 2D canvas.
 * An explicit memory accessor also supports renderers inside an owning realm. The kernel emits BGRA32 pixels; canvas
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
 *   - The RAF loop reads the registry. Independent-only attachment also
 *     validates storage ownership at attachment/bind events, without adding
 *     a memory-source decision to every ordinary frame.
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
  opts?: CanvasAttachOpts,
): () => void {
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("canvas 2d context unavailable");

  // Scratch buffer for the BGRA → RGBA swizzle. Backed by a *non-shared*
  // ArrayBuffer so it can be wrapped in an ImageData (the canvas API
  // refuses Uint8ClampedArray views over SharedArrayBuffer).
  let scratchRgba: Uint8ClampedArray<ArrayBuffer> | null = null;

  let raf = 0;
  let offOwnership: (() => void) | undefined;
  const requireIndependentPixels = () => {
    const binding = registry.get(pid);
    if (binding && binding.hostBuffer === null) {
      cancelAnimationFrame(raf);
      offOwnership?.();
      throw new Error(`Framebuffer ${pid} has no independent pixel storage; this renderer cannot access process memory`);
    }
  };
  if (opts === undefined) {
    // WHY: browser bindings publish bounded pixel mirrors with their metadata.
    // A missing mirror is a protocol fault, not permission to recover a whole
    // guest memory on the persistent page. Check new bindings once, and retire
    // this exact RAF/listener on fault instead of silently painting nothing.
    requireIndependentPixels();
    offOwnership = registry.onChange((changedPid, event) => {
      if (changedPid === pid && event === "bind") requireIndependentPixels();
    });
  }
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
        if (opts === undefined) { requireIndependentPixels(); return; }
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

    const byteLen = binding.view.length;
    if (!scratchRgba || scratchRgba.length !== byteLen) {
      scratchRgba = new Uint8ClampedArray(new ArrayBuffer(byteLen));
    }

    swizzleBgraToRgba(binding.view, scratchRgba);
    ctx.putImageData(new ImageData(scratchRgba, binding.w, binding.h), 0, 0);
  };

  raf = requestAnimationFrame(tick);
  return () => { cancelAnimationFrame(raf); offOwnership?.(); };
}

/**
 * BGRA → RGBA channel swap. ~1MB per frame at 640×400 BGRA32; trivial
 * cost on any modern device. If profiling ever shows it's a bottleneck
 * (it won't), upgrade to a WebGL texture upload that consumes BGRA
 * directly.
 */
function swizzleBgraToRgba(src: Uint8ClampedArray, dst: Uint8ClampedArray): void {
  // Force alpha=255 in the destination. fbdev pixel formats carry an
  // alpha channel as documented by FBIOGET_VSCREENINFO, but most
  // fbdev software (DOOM included) leaves it as 0; copying that
  // through would render the canvas transparent.
  for (let i = 0; i < src.length; i += 4) {
    dst[i]     = src[i + 2];
    dst[i + 1] = src[i + 1];
    dst[i + 2] = src[i];
    dst[i + 3] = 0xff;
  }
}
