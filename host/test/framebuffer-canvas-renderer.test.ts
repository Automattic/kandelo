import { afterEach, describe, expect, it, vi } from "vitest";
import { attachCanvas } from "../src/framebuffer/canvas-renderer";
import { FramebufferRegistry } from "../src/framebuffer/registry";

afterEach(() => vi.unstubAllGlobals());
function rendererHarness() {
  const pending = new Map<number, FrameRequestCallback>();
  let serial = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { pending.set(++serial, callback); return serial; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => pending.delete(id));
  vi.stubGlobal("ImageData", class { constructor(readonly data: Uint8ClampedArray, readonly width: number, readonly height: number) {} });
  const paint = vi.fn();
  const canvas = { width: 0, height: 0, getContext: () => ({ putImageData: paint }) } as unknown as HTMLCanvasElement;
  const tick = () => {
    const [id, callback] = pending.entries().next().value!;
    pending.delete(id); callback(0);
  };
  return { pending, paint, canvas, tick };
}
const mapping = (addr = 0, len = 0) => ({ pid: 7, addr, len, w: 1, h: 1, stride: 4, fmt: "BGRA32" as const });

describe("independent canvas framebuffer storage", () => {
  it("renders host pixels without a guest memory accessor and releases its owned listener/RAF", () => {
    const { pending, canvas, paint, tick } = rendererHarness();
    const registry = new FramebufferRegistry();
    registry.bind(mapping()); registry.fbWrite(7, 0, new Uint8Array([1, 2, 3, 0]));
    const stop = attachCanvas(canvas, registry, 7);
    tick(); expect(paint.mock.calls[0][0].data).toEqual(new Uint8ClampedArray([3, 2, 1, 255]));
    stop(); expect(pending.size).toBe(0);
    expect(() => registry.bind(mapping(16, 4))).not.toThrow();
  });
  it("refuses a raw guest mapping before starting an independent renderer", () => {
    const { pending, canvas } = rendererHarness();
    const registry = new FramebufferRegistry(); registry.bind(mapping(16, 4));
    expect(() => attachCanvas(canvas, registry, 7)).toThrow(/no independent pixel storage/);
    expect(pending.size).toBe(0);
  });
  it("a later missing mirror stops only this renderer and removes its listener", () => {
    const { pending, canvas } = rendererHarness();
    const registry = new FramebufferRegistry(); const stop = attachCanvas(canvas, registry, 7);
    expect(pending.size).toBe(1);
    expect(() => registry.bind(mapping(16, 4))).toThrow(/no independent pixel storage/);
    expect(pending.size).toBe(0);
    expect(() => registry.bind(mapping(16, 4))).not.toThrow();
    stop(); expect(pending.size).toBe(0);
  });
  it("an explicit owning-realm accessor retains the existing direct-mapping path", () => {
    const { canvas, paint, tick } = rendererHarness();
    const registry = new FramebufferRegistry(); registry.bind(mapping(16, 4));
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 1 });
    new Uint8Array(memory.buffer, 16, 4).set([4, 5, 6, 0]);
    const getProcessMemory = vi.fn(() => memory);
    const stop = attachCanvas(canvas, registry, 7, { getProcessMemory });
    tick(); expect(paint.mock.calls[0][0].data).toEqual(new Uint8ClampedArray([6, 5, 4, 255]));
    expect(getProcessMemory).toHaveBeenCalledWith(7); stop();
  });
});
