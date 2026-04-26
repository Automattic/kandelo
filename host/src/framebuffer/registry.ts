/**
 * Tracks live `/dev/fb0` mappings reported by the kernel.
 *
 * Two mapping modes — both flow through the same registry:
 *
 *   - **mmap-based** — pixel buffer lives inside the process's wasm
 *     `Memory` (a SharedArrayBuffer). The kernel emits a real
 *     `bind(pid, addr, len, w, h, stride, fmt)` and renderers project
 *     `[addr, addr+len)` of the process Memory onto a canvas. The
 *     view is rebuilt after every `WebAssembly.Memory.grow()`.
 *
 *   - **write-based** — used by software (e.g. fbDOOM) that does
 *     `write(fd_fb, …)` rather than mmap. The kernel emits a
 *     *sentinel* `bind` with `addr === 0 && len === 0`. The host
 *     allocates its own pixel buffer (`hostBuffer`); pixels arrive
 *     through `fbWrite(pid, offset, bytes)`. Renderers read directly
 *     from `hostBuffer` — no process-Memory access.
 *
 * Pure metadata + lazy view caches; the registry doesn't know what a
 * canvas is.
 */
export type FbFormat = "BGRA32";

export type FbBindingInput = {
  pid: number;
  /** Offset within the process's wasm Memory. `0` together with
   *  `len === 0` is the sentinel for a write-based binding (see file
   *  header) — the host owns the buffer in that case. */
  addr: number;
  /** Length in bytes (smem_len). `0` together with `addr === 0` is
   *  the write-based sentinel. */
  len: number;
  w: number;
  h: number;
  /** Bytes per row. */
  stride: number;
  fmt: FbFormat;
};

export type FbBinding = FbBindingInput & {
  /**
   * Lazily-built typed-array view a renderer can pass to ImageData.
   * For mmap-based bindings the view points into the process Memory
   * SAB and is invalidated on `memory.grow`. For write-based
   * bindings it points into `hostBuffer` and never invalidates.
   */
  view: Uint8ClampedArray | null;
  /** Cached `ImageData` matching `view`; invalidated together. */
  imageData: ImageData | null;
  /**
   * Host-allocated pixel buffer for write-based bindings. `null` for
   * mmap-based bindings.
   */
  hostBuffer: Uint8ClampedArray | null;
};

export type FbChangeEvent = "bind" | "unbind";
export type FbChangeListener = (pid: number, ev: FbChangeEvent) => void;
export type FbWriteListener = (
  pid: number,
  offset: number,
  bytes: Uint8Array,
) => void;

export class FramebufferRegistry {
  private bindings = new Map<number, FbBinding>();
  private listeners = new Set<FbChangeListener>();
  private writeListeners = new Set<FbWriteListener>();

  bind(b: FbBindingInput): void {
    const isWriteBased = b.addr === 0 && b.len === 0;
    const hostBuffer = isWriteBased
      ? new Uint8ClampedArray(new ArrayBuffer(b.h * b.stride))
      : null;
    this.bindings.set(b.pid, {
      ...b,
      view: null,
      imageData: null,
      hostBuffer,
    });
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
   * No-op for write-based bindings (the host buffer doesn't move).
   */
  rebindMemory(pid: number): void {
    const b = this.bindings.get(pid);
    if (!b || b.hostBuffer) return;
    b.view = null;
    b.imageData = null;
  }

  /**
   * Push pixel bytes from the kernel into a write-based binding's
   * host buffer at the given byte offset. No-op (or out-of-range
   * clamp) if the binding is mmap-based or doesn't exist.
   *
   * Also fires `onWrite` listeners (used by browser hosts to forward
   * the bytes to a main-thread mirror registry).
   */
  fbWrite(pid: number, offset: number, bytes: Uint8Array): void {
    const b = this.bindings.get(pid);
    if (b?.hostBuffer) {
      const end = Math.min(offset + bytes.length, b.hostBuffer.length);
      if (end > offset) {
        b.hostBuffer.set(bytes.subarray(0, end - offset), offset);
      }
    }
    for (const l of this.writeListeners) l(pid, offset, bytes);
  }

  /**
   * Subscribe to write-based pixel pushes. Returns an unsubscribe
   * function. Used by the browser kernel-worker to forward writes to
   * the main-thread registry.
   */
  onWrite(fn: FbWriteListener): () => void {
    this.writeListeners.add(fn);
    return () => {
      this.writeListeners.delete(fn);
    };
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
