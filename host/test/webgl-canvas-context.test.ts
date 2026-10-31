import { describe, expect, it, vi } from "vitest";
import { getCanvasWebGl2Context } from "../src/webgl/canvas-context";

describe("canvas-owned WebGL2 contexts", () => {
  it("acquires once across consumers and resizing", () => {
    const context = {} as WebGL2RenderingContext;
    const acquire = vi.fn().mockReturnValueOnce(context).mockImplementation(() => {
      throw new DOMException("Cannot update created context to different thread", "InvalidStateError");
    });
    const canvas = { width: 640, height: 480, getContext: acquire } as unknown as OffscreenCanvas;
    expect(getCanvasWebGl2Context(canvas)).toBe(context);
    canvas.width = 800;
    canvas.height = 600;
    expect(getCanvasWebGl2Context(canvas)).toBe(context);
    expect(getCanvasWebGl2Context(canvas)).toBe(context);
    expect(acquire).toHaveBeenCalledExactlyOnceWith("webgl2", {
      antialias: false, premultipliedAlpha: false, depth: true,
      stencil: true, preserveDrawingBuffer: true,
    });
  });

  it("never shares a context with a different canvas or kernel generation", () => {
    const first = {} as WebGL2RenderingContext;
    const second = {} as WebGL2RenderingContext;
    const oldCanvas = { getContext: () => first } as unknown as OffscreenCanvas;
    const newCanvas = { getContext: () => second } as unknown as OffscreenCanvas;
    expect(getCanvasWebGl2Context(oldCanvas)).toBe(first);
    expect(getCanvasWebGl2Context(newCanvas)).toBe(second);
  });

  it("does not cache refusal or hide context-acquisition exceptions", () => {
    const context = {} as WebGL2RenderingContext;
    const acquire = vi.fn().mockReturnValueOnce(null).mockImplementationOnce(() => {
      throw new DOMException("Context unavailable", "InvalidStateError");
    }).mockReturnValue(context);
    const canvas = { getContext: acquire } as unknown as OffscreenCanvas;
    expect(getCanvasWebGl2Context(canvas)).toBeNull();
    expect(() => getCanvasWebGl2Context(canvas)).toThrow("Context unavailable");
    expect(getCanvasWebGl2Context(canvas)).toBe(context);
    expect(getCanvasWebGl2Context(canvas)).toBe(context);
    expect(acquire).toHaveBeenCalledTimes(3);
  });
});
