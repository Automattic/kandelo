import { describe, expect, it } from "vitest";
import { FramebufferRegistry } from "../src/framebuffer/registry.js";

describe("FramebufferRegistry", () => {
  it("binds and retrieves with lazy view", () => {
    const reg = new FramebufferRegistry();
    reg.bind({
      pid: 5,
      addr: 0x1000,
      len: 1024 * 1024,
      w: 640,
      h: 400,
      stride: 2560,
      fmt: "BGRA32",
    });
    const b = reg.get(5);
    expect(b).toBeDefined();
    expect(b!.w).toBe(640);
    expect(b!.h).toBe(400);
    expect(b!.stride).toBe(2560);
    expect(b!.view).toBeNull();
    expect(b!.imageData).toBeNull();
  });

  it("unbinds idempotently", () => {
    const reg = new FramebufferRegistry();
    reg.bind({
      pid: 5,
      addr: 0,
      len: 4,
      w: 1,
      h: 1,
      stride: 4,
      fmt: "BGRA32",
    });
    reg.unbind(5);
    reg.unbind(5); // second call is a no-op
    expect(reg.get(5)).toBeUndefined();
  });

  it("rebindMemory invalidates cached view + imageData", () => {
    const reg = new FramebufferRegistry();
    reg.bind({
      pid: 5,
      addr: 0,
      len: 4,
      w: 1,
      h: 1,
      stride: 4,
      fmt: "BGRA32",
    });
    const b = reg.get(5)!;
    // Simulate a renderer having cached views.
    b.view = new Uint8ClampedArray(4);
    b.imageData = null; // ImageData is DOM-only; sufficient to test view path.

    reg.rebindMemory(5);
    expect(reg.get(5)?.view).toBeNull();
    expect(reg.get(5)?.imageData).toBeNull();
  });

  it("onChange fires for bind and unbind, returns unsubscribe", () => {
    const reg = new FramebufferRegistry();
    const events: Array<[number, string]> = [];
    const off = reg.onChange((pid, ev) => events.push([pid, ev]));

    reg.bind({
      pid: 7,
      addr: 0,
      len: 4,
      w: 1,
      h: 1,
      stride: 4,
      fmt: "BGRA32",
    });
    reg.unbind(7);
    expect(events).toEqual([
      [7, "bind"],
      [7, "unbind"],
    ]);

    // Unsubscribe; further events should not fire.
    off();
    reg.bind({
      pid: 7,
      addr: 0,
      len: 4,
      w: 1,
      h: 1,
      stride: 4,
      fmt: "BGRA32",
    });
    expect(events.length).toBe(2);
  });

  it("list returns current bindings", () => {
    const reg = new FramebufferRegistry();
    expect(reg.list()).toEqual([]);
    reg.bind({
      pid: 1,
      addr: 0,
      len: 4,
      w: 1,
      h: 1,
      stride: 4,
      fmt: "BGRA32",
    });
    reg.bind({
      pid: 2,
      addr: 0,
      len: 4,
      w: 1,
      h: 1,
      stride: 4,
      fmt: "BGRA32",
    });
    expect(reg.list().map((b) => b.pid).sort()).toEqual([1, 2]);
  });
});
