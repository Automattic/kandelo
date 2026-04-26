/**
 * Tracks live `/dev/fb0` mappings reported by the kernel.
 *
 * The kernel calls `bind` when a process maps its framebuffer and `unbind`
 * when the mapping disappears (munmap, close-of-last-fd plus binding gone,
 * exec, or process exit). Renderers (canvas in browser, no-op in Node)
 * read from the registry on each frame and project the bound region of
 * the process's wasm Memory onto whatever surface they own.
 *
 * Pure metadata + lazy view caches; the registry doesn't know what a
 * canvas is.
 */
export type FbFormat = "BGRA32";

export type FbBindingInput = {
  pid: number;
  /** Offset within the process's wasm Memory. */
  addr: number;
  /** Length in bytes (smem_len). */
  len: number;
  w: number;
  h: number;
  /** Bytes per row. */
  stride: number;
  fmt: FbFormat;
};

export type FbBinding = FbBindingInput & {
  /**
   * Lazily-built typed-array view over the bound region. `null` means
   * "not yet built, or invalidated by a memory.grow". The renderer
   * rebuilds it from the current process Memory on next frame.
   */
  view: Uint8ClampedArray | null;
  /** Cached `ImageData` matching `view`; invalidated together. */
  imageData: ImageData | null;
};

export type FbChangeEvent = "bind" | "unbind";
export type FbChangeListener = (pid: number, ev: FbChangeEvent) => void;

export class FramebufferRegistry {
  private bindings = new Map<number, FbBinding>();
  private listeners = new Set<FbChangeListener>();

  bind(b: FbBindingInput): void {
    this.bindings.set(b.pid, { ...b, view: null, imageData: null });
    for (const l of this.listeners) l(b.pid, "bind");
  }

  unbind(pid: number): void {
    if (!this.bindings.has(pid)) return;
    this.bindings.delete(pid);
    for (const l of this.listeners) l(pid, "unbind");
  }

  get(pid: number): FbBinding | undefined {
    return this.bindings.get(pid);
  }

  /**
   * Drop cached view + ImageData for `pid`. Renderers must re-build them
   * from the (possibly new) process Memory SAB on the next frame. Call
   * after `WebAssembly.Memory.grow()` invalidates the prior buffer ref.
   */
  rebindMemory(pid: number): void {
    const b = this.bindings.get(pid);
    if (!b) return;
    b.view = null;
    b.imageData = null;
  }

  list(): FbBinding[] {
    return [...this.bindings.values()];
  }

  onChange(fn: FbChangeListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
}
