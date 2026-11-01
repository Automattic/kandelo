import { describe, expect, it, vi } from "vitest";
import { snapshotScanout, scanoutRgba } from "../src/dri/scanout-format";
import { KmsCursorPlane } from "../src/dri/cursor-plane.js";
import { GbmBoRegistry } from "../src/dri/registry.js";
import { KmsRegistry, buildVirtualConnectorMode } from "../src/dri/kms-registry.js";

function fb(id: number, bo_id = 100): {
  fb_id: number; bo_id: number; width: number; height: number;
  pixel_format: number; pitch: number;
} {
  return { fb_id: id, bo_id, width: 64, height: 32, pixel_format: 0x34325258, pitch: 256 };
}

describe("KmsRegistry", () => {
  it("addFb / rmFb / setFb / currentFb track bindings", () => {
    const kms = new KmsRegistry(new GbmBoRegistry());
    expect(kms.currentFb(1)).toBeUndefined();

    kms.addFb(fb(10));
    kms.setFb(1, 10);
    expect(kms.currentFb(1)?.fb_id).toBe(10);

    kms.rmFb(10);
    expect(kms.currentFb(1)).toBeUndefined();
  });

  it("flipCount counts every latch, including a rebind of the same fb", () => {
    const kms = new KmsRegistry(new GbmBoRegistry());
    expect(kms.flipCount()).toBe(0);

    kms.addFb(fb(10));
    kms.setFb(1, 10);
    expect(kms.flipCount()).toBe(1);

    kms.setFb(1, 10);
    expect(kms.flipCount()).toBe(2);

    kms.rmFb(10);
    expect(kms.flipCount()).toBe(2);
  });

  it("uses exact file and grant identity independently of presenter PID", () => {
    const kms = new KmsRegistry(new GbmBoRegistry());
    expect(kms.isMasterFile(1n)).toBe(false);
    expect(kms.setMaster(7, 1n, 1n)).toBe(true);
    expect(kms.isMasterFile(1n)).toBe(true);
    expect(kms.isMasterFile(2n)).toBe(false);
    expect(kms.dropMaster(2n, 1n)).toBe(false);
    expect(kms.dropMaster(1n, 2n)).toBe(false);
    expect(kms.isMasterFile(1n)).toBe(true);
    expect(kms.dropMaster(1n, 1n)).toBe(true);
    expect(kms.isMasterFile(1n)).toBe(false);
    expect(kms.setMaster(7, 1n, 1n)).toBe(false);
    expect(kms.setMaster(8, 1n, 2n)).toBe(true);
    expect(kms.dropMaster(1n, 1n)).toBe(false);
    expect(kms.getMasterPid()).toBe(8);
  });

  it("scanoutBytes returns the bo's pixel SAB for the bound CRTC", () => {
    const bos = new GbmBoRegistry();
    bos.create({ pid: 1, bo_id: 100, size: 4096, w: 32, h: 32, stride: 128 });
    const kms = new KmsRegistry(bos);

    expect(kms.scanoutBytes(1)).toBeUndefined();

    kms.addFb(fb(10, 100));
    kms.setFb(1, 10);
    const bytes = kms.scanoutBytes(1);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes!.byteLength).toBe(4096);
  });

  it("scanoutBytes returns undefined for an unknown bo", () => {
    const kms = new KmsRegistry(new GbmBoRegistry());
    kms.addFb(fb(10, 999));
    kms.setFb(1, 10);
    expect(kms.scanoutBytes(1)).toBeUndefined();
  });

  it("scanoutBytes syncs the writer's wasm Memory into the SAB on every call", () => {
    const mem = new WebAssembly.Memory({ initial: 1, maximum: 4, shared: true });
    const bos = new GbmBoRegistry({ getProcessMemory: (p) => p === 7 ? mem : undefined });
    bos.create({ pid: 7, bo_id: 100, size: 4096, w: 32, h: 32, stride: 128 });
    bos.bind(7, 100, 0, 4096);
    bos.primeBindFromSab(7, 100, mem, 0);

    const kms = new KmsRegistry(bos);
    kms.addFb(fb(10, 100));
    kms.setFb(1, 10);

    new Uint8Array(mem.buffer, 0, 4096).fill(0xab);
    const view1 = kms.scanoutBytes(1)!;
    expect(view1[0]).toBe(0xab);

    new Uint8Array(mem.buffer, 0, 4096).fill(0xcd);
    const view2 = kms.scanoutBytes(1)!;
    expect(view2[0]).toBe(0xcd);
  });
});

describe("buildVirtualConnectorMode", () => {
  const modeDims = (blob: Uint8Array) => {
    const view = new DataView(blob.buffer, blob.byteOffset);
    return { w: view.getUint16(4, true), h: view.getUint16(14, true) };
  };
  const modeName = (blob: Uint8Array) => {
    const end = blob.indexOf(0, 36);
    return new TextDecoder().decode(blob.subarray(36, end < 0 ? 68 : end));
  };

  it("defaults to 1920x1080 without a display size", () => {
    const blob = buildVirtualConnectorMode(1);
    expect(modeDims(blob)).toEqual({ w: 1920, h: 1080 });
    expect(modeName(blob)).toBe("1920x1080");
    // PREFERRED | DRIVER type flags — mode-picking clients key on these.
    expect(new DataView(blob.buffer).getUint32(32, true)).toBe((1 << 3) | (1 << 6));
  });

  it("is the reported device-pixel size, not its aspect", () => {
    // 2412×1080 display (the wide Modeset pane) → 2412x1080 mode.
    expect(modeDims(buildVirtualConnectorMode(1, { width: 2412, height: 1080 })))
      .toEqual({ w: 2412, h: 1080 });
    // The same ASPECT at half the size is half the mode. An aspect-derived
    // mode makes these two identical, which renders a HiDPI pane at half its
    // real resolution.
    expect(modeDims(buildVirtualConnectorMode(1, { width: 1206, height: 540 })))
      .toEqual({ w: 1206, h: 540 });
    expect(modeName(buildVirtualConnectorMode(1, { width: 1206, height: 540 })))
      .toBe("1206x540");
  });

  it("tracks a devicePixelRatio 2 pane at full device resolution", () => {
    // 1088×613 CSS at dpr 2 — the omarchy pane on a Retina display.
    expect(modeDims(buildVirtualConnectorMode(1, { width: 2176, height: 1226 })))
      .toEqual({ w: 2176, h: 1226 });
  });

  it("even-aligns and clamps to [640, 3840] x [480, 2160]", () => {
    expect(modeDims(buildVirtualConnectorMode(1, { width: 1471, height: 1081 })))
      .toEqual({ w: 1470, h: 1080 });
    expect(modeDims(buildVirtualConnectorMode(1, { width: 320, height: 200 })))
      .toEqual({ w: 640, h: 480 });
    expect(modeDims(buildVirtualConnectorMode(1, { width: 10000, height: 5000 })))
      .toEqual({ w: 3840, h: 2160 });
  });

  it("ignores degenerate display sizes", () => {
    expect(modeDims(buildVirtualConnectorMode(1, { width: 0, height: 0 })))
      .toEqual({ w: 1920, h: 1080 });
  });
});


it("snapshots premultiplied cursor pixels and moves independently of scanout", () => {
  const bos = new GbmBoRegistry();
  bos.create({ pid: 7, bo_id: 1, size: 16, w: 2, h: 2, stride: 8 });
  bos.pixelView(1)!.set([0, 32, 64, 128, 0, 0, 255, 255]);
  const kms = new KmsRegistry(bos);
  kms.setMaster(7, 1n, 1n);
  kms.setCursor(7, 3, 1, 2, 2, 30, 40, 1, 1);
  const shown = kms.cursorSnapshot();
  expect(Array.from(shown.pixels!.slice(0, 8))).toEqual([128, 64, 0, 128, 255, 0, 0, 255]);
  expect(shown).toMatchObject({ x: 30, y: 40, hotX: 1, hotY: 1 });
  kms.setCursor(7, 2, 0, 0, 0, -5, 70, 0, 0);
  expect(kms.cursorSnapshot().pixels).toBe(shown.pixels);
  expect(kms.cursorSnapshot()).toMatchObject({ x: -5, y: 70, hotX: 1, hotY: 1 });
  bos.pixelView(1)!.fill(0);
  const updated = kms.cursorSnapshot();
  expect(updated.pixels).not.toBe(shown.pixels);
  expect(updated.pixels!.every(value => value === 0)).toBe(true);
  expect(shown.pixels![0]).toBe(128); // Detached snapshots stay immutable.
  expect(kms.cursorSnapshot()).toBe(updated);
  expect(kms.flipCount()).toBe(0);
  kms.dropMaster(1n, 1n);
  expect(kms.cursorSnapshot().pixels).toBeNull();
  expect(kms.cursorSnapshot().version).toBeGreaterThan(shown.version);
});


it("presents DRM image origins without applying hotspot hints and erases old positions", () => {
  vi.stubGlobal("ImageData", class {
    constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
  });
  try {
    const context = { putImageData: vi.fn(), clearRect: vi.fn() };
    const canvas = Object.assign(new EventTarget(), {
      width: 100, height: 100, getContext: () => context,
    });
    const plane = new KmsCursorPlane(canvas as unknown as OffscreenCanvas);
    const cursor = { version: 1, x: 20, y: 30, hotX: -3, hotY: 4,
      width: 2, height: 2, pixels: new Uint8ClampedArray(16) };
    plane.present(cursor, 100, 100);
    expect(context.putImageData.mock.calls[0].slice(1)).toEqual([20, 30]);
    canvas.dispatchEvent(new Event("contextrestored"));
    plane.present(cursor, 100, 100);
    expect(context.putImageData).toHaveBeenCalledTimes(2);
    plane.present({ ...cursor, version: 2, x: 40 }, 100, 100);
    expect(context.clearRect).toHaveBeenLastCalledWith(20, 30, 2, 2);
    expect(context.putImageData.mock.calls[2].slice(1)).toEqual([40, 30]);
    plane.present({ ...cursor, version: 3, pixels: null }, 100, 100);
    expect(context.clearRect).toHaveBeenLastCalledWith(40, 30, 2, 2);
    expect(context.putImageData).toHaveBeenCalledTimes(3);
  } finally { vi.unstubAllGlobals(); }
});


it("accepts a kernel-authorized imported cursor BO without an importer mmap", () => {
  const bos = new GbmBoRegistry();
  bos.create({ pid: 7, bo_id: 1, size: 4, w: 1, h: 1, stride: 4 });
  bos.pixelView(1)!.set([0, 0, 255, 255]);
  expect(bos.get(8, 1)).toBeUndefined();
  const kms = new KmsRegistry(bos);
  kms.setCursor(8, 1, 1, 1, 1, 0, 0, 0, 0);
  expect(Array.from(kms.cursorSnapshot().pixels!)).toEqual([255, 0, 0, 255]);
});


it("reads packed cursor rows independently of the original BO pitch", () => {
  const bos = new GbmBoRegistry();
  bos.create({ pid: 7, bo_id: 1, size: 16, w: 4, h: 1, stride: 16 });
  bos.pixelView(1)!.set([0, 0, 255, 255, 0, 255, 0, 255,
    255, 0, 0, 255, 255, 255, 255, 255]);
  const kms = new KmsRegistry(bos);
  kms.setCursor(7, 3, 1, 2, 2, 10, 20, -3, 1);
  expect(Array.from(kms.cursorSnapshot().pixels!)).toEqual([
    255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
  ]);
  expect(kms.cursorSnapshot()).toMatchObject({ x: 10, y: 20, hotX: -3 });
});


it("refreshes the live cursor producer without flushing beyond the packed image", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const bos = new GbmBoRegistry({ getProcessMemory: pid => pid === 7 ? memory : undefined });
  bos.create({ pid: 7, bo_id: 1, size: 4096, w: 32, h: 32, stride: 128 });
  bos.bind(7, 1, 0, 4096);
  bos.primeBindFromSab(7, 1, memory, 0);
  const mapped = new Uint8Array(memory.buffer);
  mapped.set([0, 0, 255, 255]);
  mapped[16] = 42;
  const kms = new KmsRegistry(bos);
  kms.setCursor(7, 1, 1, 2, 2, 0, 0, 0, 0);
  const first = kms.cursorSnapshot();
  expect(first.pixels!.slice(0, 4)).toEqual(new Uint8ClampedArray([255, 0, 0, 255]));
  expect(bos.pixelView(1)![16]).toBe(0);
  mapped.set([255, 0, 0, 255]);
  expect(kms.cursorSnapshot().pixels!.slice(0, 4)).toEqual(new Uint8ClampedArray([0, 0, 255, 255]));
  expect(first.pixels![0]).toBe(255);
  kms.setCursor(7, 1, 0, 0, 0, 0, 0, 0, 0);
  mapped.fill(1);
  expect(kms.cursorSnapshot().pixels).toBeNull();
});


it("consumes complete grant-scoped cursor records without resurrecting retired storage", () => {
  const bos = new GbmBoRegistry();
  bos.create({ pid: 7, bo_id: 1, size: 16, w: 2, h: 2, stride: 8 });
  bos.pixelView(1)!.set([0, 0, 255, 255]);
  const kms = new KmsRegistry(bos);
  const record = (lease: bigint, words: number[]) => {
    const bytes = new Uint8Array(40), view = new DataView(bytes.buffer);
    view.setBigUint64(0, lease, true);
    words.forEach((word, i) => view.setUint32(8 + i * 4, word, true));
    return bytes;
  };
  kms.setMaster(7, 1n, 1n);
  kms.applyCursorRecord(record(1n, [1, 2, 2, 30, 40, -3, 1]));
  const pixels = kms.cursorSnapshot().pixels;
  expect(pixels).not.toBeNull();
  kms.applyCursorRecord(record(1n, [1, 2, 2, -5, 70, -3, 1]));
  expect(kms.cursorSnapshot()).toMatchObject({ x: -5, y: 70, hotX: -3 });
  expect(kms.cursorSnapshot().pixels).toBe(pixels);
  kms.dropMaster(1n, 1n);
  bos.destroy(7, 1);
  // Rejected before reading the dead BO's pixels.
  kms.applyCursorRecord(record(1n, [1, 2, 2, 30, 40, 0, 0]));
  expect(kms.cursorSnapshot().pixels).toBeNull();
  kms.setMaster(8, 1n, 2n);
  kms.applyCursorRecord(record(2n, [0, 0, 0, 1, 2, 0, 0]));
  expect(kms.cursorSnapshot()).toMatchObject({ x: 1, y: 2, pixels: null });
  kms.applyCursorRecord(record(0n, [0, 0, 0, 0, 0, 0, 0]));
  kms.applyCursorRecord(record(1n, [1, 2, 2, 30, 40, 0, 0]));
  expect(kms.cursorSnapshot()).toMatchObject({ x: 1, y: 2, pixels: null });
  expect(kms.dropMaster(1n, 1n)).toBe(false);
  expect(kms.setMaster(7, 1n, 1n)).toBe(false);
  expect(kms.getMasterPid()).toBe(8);
});


describe("DRM scanout pixel layouts", () => {
  it.each([
    ["XRGB8888", 0x34325258, [3, 2, 1, 0, 6, 5, 4, 0]],
    ["ARGB8888", 0x34325241, [3, 2, 1, 64, 6, 5, 4, 128]],
    ["XBGR8888", 0x34324258, [1, 2, 3, 0, 4, 5, 6, 0]],
    ["ABGR8888", 0x34324241, [1, 2, 3, 64, 4, 5, 6, 128]],
  ] as const)("decodes %s without confusing channel order or row padding", (_name, pixel_format, bytes) => {
    const source = new Uint8Array(new SharedArrayBuffer(12));
    source.set([...bytes.slice(0, 4), 99, 99, ...bytes.slice(4), 99, 99]);
    const packed = snapshotScanout({ width: 1, height: 2, pitch: 6, pixel_format }, source);
    expect(packed.buffer).toBeInstanceOf(ArrayBuffer);
    expect(Array.from(scanoutRgba(pixel_format, packed))).toEqual([1, 2, 3, 255, 4, 5, 6, 255]);
    source.fill(0);
    expect(Array.from(packed)).toEqual(bytes);
  });

  it("expands little-endian RGB565 endpoints and ignores padding", () => {
    const source = new Uint8Array([0, 248, 224, 7, 31, 0, 99, 99, 255, 255, 0, 0, 16, 132]);
    const packed = snapshotScanout({ width: 3, height: 2, pitch: 8, pixel_format: 0x36314752 }, source);
    expect(Array.from(scanoutRgba(0x36314752, packed))).toEqual([
      255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255,
      255, 255, 255, 255, 0, 0, 0, 255, 132, 130, 132, 255,
    ]);
  });

  it("rejects unknown formats and incomplete geometry before copying", () => {
    const fb = { width: 2, height: 2, pitch: 8, pixel_format: 0x34324241 };
    for (const geometry of [
      { ...fb, pixel_format: 0 }, { ...fb, width: 0 }, { ...fb, height: -1 },
      { ...fb, pitch: 7 }, { ...fb, width: 1.5 }, { ...fb, height: Number.MAX_SAFE_INTEGER },
    ]) expect(() => snapshotScanout(geometry, new Uint8Array(16))).toThrow(RangeError);
    expect(() => snapshotScanout(fb, new Uint8Array(15))).toThrow(RangeError);
    expect(() => scanoutRgba(0x36314752, new Uint8Array(3))).toThrow(RangeError);
  });
});
