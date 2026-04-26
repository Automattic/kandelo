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

  it("write-based binding (addr=0,len=0) allocates a host buffer + fbWrite copies in", () => {
    const reg = new FramebufferRegistry();
    reg.bind({
      pid: 9,
      addr: 0,
      len: 0,
      w: 4,
      h: 2,
      stride: 16, // 4 px * 4 bpp
      fmt: "BGRA32",
    });
    const b = reg.get(9)!;
    expect(b.hostBuffer).not.toBeNull();
    expect(b.hostBuffer!.length).toBe(2 * 16);

    // Write a row at offset 16 (start of row 1).
    const row = new Uint8Array([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
    ]);
    reg.fbWrite(9, 16, row);
    expect(b.hostBuffer![16]).toBe(1);
    expect(b.hostBuffer![31]).toBe(16);
    // Row 0 untouched.
    for (let i = 0; i < 16; i++) expect(b.hostBuffer![i]).toBe(0);
  });

  it("fbWrite fires onWrite listeners with the original pid/offset/bytes", () => {
    const reg = new FramebufferRegistry();
    reg.bind({
      pid: 10,
      addr: 0,
      len: 0,
      w: 1,
      h: 1,
      stride: 4,
      fmt: "BGRA32",
    });
    const seen: Array<[number, number, number]> = [];
    reg.onWrite((pid, offset, bytes) => seen.push([pid, offset, bytes.length]));
    reg.fbWrite(10, 0, new Uint8Array([0xff, 0, 0, 0xff]));
    expect(seen).toEqual([[10, 0, 4]]);
  });

  it("rebindMemory is a no-op for write-based bindings", () => {
    const reg = new FramebufferRegistry();
    reg.bind({
      pid: 11,
      addr: 0,
      len: 0,
      w: 1,
      h: 1,
      stride: 4,
      fmt: "BGRA32",
    });
    const b = reg.get(11)!;
    b.view = b.hostBuffer; // pretend renderer cached the view
    reg.rebindMemory(11);
    // Still pointing at the host buffer — host-owned memory doesn't
    // change on memory.grow.
    expect(b.view).toBe(b.hostBuffer);
  });
});
