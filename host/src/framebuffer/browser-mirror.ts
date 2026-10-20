import type { FbBindingInput } from "./registry";

/** Bounded scanout storage. No guest Memory escapes the kernel Worker. */
export class BrowserFramebufferMirrors {
  private readonly bindings = new Map<number, {
    generation: number;
    binding: FbBindingInput;
    pixels: Uint8Array<SharedArrayBuffer>;
  }>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly memoryFor: (
    pid: number, generation: number,
  ) => WebAssembly.Memory | undefined) {}

  bind(binding: FbBindingInput, generation: number): SharedArrayBuffer | undefined {
    this.unbind(binding.pid);
    if (binding.addr === 0 && binding.len === 0) return undefined;
    const memory = this.memoryFor(binding.pid, generation);
    if (!memory || !Number.isSafeInteger(binding.addr) || binding.addr < 0
      || !Number.isSafeInteger(binding.len) || binding.len <= 0
      || !Number.isSafeInteger(binding.addr + binding.len)) {
      throw new RangeError("framebuffer mapping is outside its process memory");
    }
    const pixels = new Uint8Array(new SharedArrayBuffer(binding.len));
    this.bindings.set(binding.pid, { generation, binding, pixels });
    this.copy();
    this.timer ??= setInterval(() => this.copy(), 16);
    return pixels.buffer;
  }

  unbind(pid: number, generation?: number): void {
    const current = this.bindings.get(pid);
    if (generation !== undefined && current?.generation !== generation) return;
    this.bindings.delete(pid);
    if (this.bindings.size === 0 && this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  clear(): void {
    this.bindings.clear();
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  private copy(): void {
    for (const [pid, { generation, binding, pixels }] of this.bindings) {
      const memory = this.memoryFor(pid, generation);
      if (!memory) {
        this.unbind(pid, generation);
        continue;
      }
      // mmap publishes its binding before the guest glue grows Memory. Match
      // the direct renderer's retry behavior until that backing is available.
      if (binding.addr > memory.buffer.byteLength - binding.len) continue;
      // Read the current buffer after memory.grow; the display view never moves.
      pixels.set(new Uint8Array(memory.buffer, binding.addr, binding.len));
    }
  }
}
