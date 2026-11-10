import { describe, expect, it, vi } from "vitest";
import { reduce10, reduceFloat, reduceHalf, snapshotScanout, scanoutRgba } from "../src/dri/scanout-format";
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

  it("isDark: a CRTC that latched no framebuffer, or lost the one it scans, is dark", () => {
    const kms = new KmsRegistry(new GbmBoRegistry());
    expect(kms.isDark(1)).toBe(false); // never lit: nothing was shown
    kms.addFb(fb(10));
    kms.setFb(1, 10, { x: 0, y: 0, width: 64, height: 32 });
    expect(kms.isDark(1)).toBe(false);
    kms.setFb(1, 0, { x: 0, y: 0, width: 0, height: 0 }); // ACTIVE 0 / DPMS Off
    expect(kms.isDark(1)).toBe(true);
    kms.setFb(1, 10, { x: 0, y: 0, width: 64, height: 32 });
    expect(kms.isDark(1)).toBe(false);
    kms.rmFb(10); // RMFB disables the CRTC that scans it
    expect(kms.isDark(1)).toBe(true);
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

  it("scans out the viewport the kernel latched, from the plane offset", () => {
    const bos = new GbmBoRegistry();
    bos.create({ pid: 1, bo_id: 100, size: 4096, w: 32, h: 32, stride: 128 });
    const sab = bos.pixelView(100)!;
    for (let i = 0; i < sab.byteLength; i++) sab[i] = i & 0xff;
    const kms = new KmsRegistry(bos);
    // ADDFB2 offsets[0] = 256 (two 128-byte rows), XRGB8888 32x16.
    kms.addFb({ fb_id: 10, bo_id: 100, width: 32, height: 16, pixel_format: 0x34325258, pitch: 128, offset: 256 });
    kms.setFb(1, 10, { x: 0, y: 0, width: 32, height: 16 });
    expect(kms.currentFb(1)).toMatchObject({ width: 32, height: 16, x: 0, y: 0, offset: 256 });
    expect(kms.scanoutBytes(1)![0]).toBe(0);
    expect(kms.scanoutBytes(1)!.byteLength).toBe(4096 - 256);
    // SETCRTC panning: an 8x4 viewport at (2, 3) starts 3 rows and 2 pixels in.
    kms.setFb(1, 10, { x: 2, y: 3, width: 8, height: 4 });
    const view = kms.currentFb(1)!;
    expect(view).toMatchObject({ fb_id: 10, width: 8, height: 4, x: 2, y: 3, pitch: 128, offset: 256 + 3 * 128 + 8 });
    expect(kms.scanoutBytes(1)![0]).toBe((256 + 3 * 128 + 8) & 0xff);
    const packed = snapshotScanout(view, kms.scanoutBytes(1)!);
    expect(packed.byteLength).toBe(8 * 4 * 4);
    expect(packed[32]).toBe((256 + 4 * 128 + 8) & 0xff);
    // A viewport outside the fb presents nothing.
    kms.setFb(1, 10, { x: 30, y: 0, width: 8, height: 4 });
    expect(kms.currentFb(1)).toBeUndefined();
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
  // Device plane state survives the master; only the BO's retirement ends it.
  kms.dropMaster(1n, 1n);
  expect(kms.cursorSnapshot()).toBe(updated);
  expect(kms.retireCursorBo(1)).toBe(true);
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


it("keeps the device cursor plane across master changes and never reads retired storage", () => {
  const bos = new GbmBoRegistry();
  bos.create({ pid: 7, bo_id: 1, size: 16, w: 2, h: 2, stride: 8 });
  bos.pixelView(1)!.set([0, 0, 255, 255]);
  const kms = new KmsRegistry(bos);
  const record = (words: number[], reserved = 0n) => {
    const bytes = new Uint8Array(40), view = new DataView(bytes.buffer);
    view.setBigUint64(0, reserved, true);
    [...words, words[0] ? 25 : 0].forEach((word, i) => view.setUint32(8 + i * 4, word, true));
    return bytes;
  };
  kms.setMaster(7, 1n, 1n);
  kms.applyCursorRecord(record([1, 2, 2, 30, 40, -3, 1]));
  const pixels = kms.cursorSnapshot().pixels;
  expect(pixels).not.toBeNull();
  kms.applyCursorRecord(record([1, 2, 2, -5, 70, -3, 1]));
  expect(kms.cursorSnapshot()).toMatchObject({ x: -5, y: 70, hotX: -3 });
  expect(kms.cursorSnapshot().pixels).toBe(pixels);
  // Linux plane state: dropping master and a new master's grant leave the
  // cursor shown, and the new master's motion keeps the inherited image.
  kms.dropMaster(1n, 1n);
  expect(kms.cursorSnapshot().pixels).toBe(pixels);
  kms.setMaster(8, 2n, 2n);
  expect(kms.cursorSnapshot().pixels).toBe(pixels);
  kms.applyCursorRecord(record([1, 2, 2, 11, 12, -3, 1]));
  expect(kms.cursorSnapshot()).toMatchObject({ x: 11, y: 12, pixels });
  // A record with nonzero reserved bytes is a protocol violation.
  expect(() => kms.applyCursorRecord(record([1, 2, 2, 11, 12, -3, 1], 2n))).toThrow("Invalid KMS cursor record");
  // The kernel destroys the image only after replacing it; the host stops
  // presenting a retired BO instead of reading it.
  expect(kms.retireCursorBo(2)).toBe(false);
  bos.destroy(7, 1);
  expect(kms.retireCursorBo(1)).toBe(true);
  expect(kms.cursorSnapshot()).toMatchObject({ x: 11, y: 12, pixels: null });
  kms.applyCursorRecord(record([0, 0, 0, 1, 2, 0, 0]));
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

  it("shows R8 as red and GR88 as red and green, the channels they lack zero", () => {
    // 3-pixel rows with one padding byte (R8) or two (GR88).
    const r8 = snapshotScanout({ width: 3, height: 1, pitch: 4, pixel_format: 0x20203852 }, new Uint8Array([7, 0, 255, 99]));
    expect(Array.from(scanoutRgba(0x20203852, r8))).toEqual([7, 0, 0, 255, 0, 0, 0, 255, 255, 0, 0, 255]);
    const gr88 = snapshotScanout({ width: 2, height: 1, pitch: 6, pixel_format: 0x38385247 },
      new Uint8Array([7, 8, 255, 1, 99, 99]));
    expect(Array.from(scanoutRgba(0x38385247, gr88))).toEqual([7, 8, 0, 255, 255, 1, 0, 255]);
    expect(() => scanoutRgba(0x38385247, new Uint8Array(3))).toThrow(RangeError);
  });

  it("reduces 10-bit channels to 8 bits by rounding, in all four channel orders", () => {
    // Channels 1023, 512, 2 (and alpha bits 3): 255, round(130.6) = 128, round(0.5) = 0... exactly
    // round(v * 255 / 1023): 1023 -> 255, 512 -> 128, 2 -> 0, 3 -> 1.
    const word = (low: number, mid: number, high: number) => (3 << 30 | high << 20 | mid << 10 | low) >>> 0;
    const bytes = (w: number) => [w & 255, (w >>> 8) & 255, (w >>> 16) & 255, w >>> 24];
    const pixel = [...bytes(word(1023, 512, 2)), ...bytes(word(3, 0, 1022))];
    for (const [fourcc, bgr] of [[0x30334241, false], [0x30334258, false], [0x30335241, true], [0x30335258, true]] as const) {
      const rgba = Array.from(scanoutRgba(fourcc, Uint8Array.from(pixel)));
      expect(rgba).toEqual(bgr ? [0, 128, 255, 255, 255, 0, 1, 255] : [255, 128, 0, 255, 1, 0, 255, 255]);
    }
  });

  it("reduces half floats to 8 bits: [0, 1] rounded, NaN 0, out of range clamped", () => {
    const half = [0x3c00, 0x3800, 0x0000, 0x0000, /* 1, 0.5, 0 */ 0x7e00, 0xbc00, 0x7c00, 0x3c00, /* NaN, -1, inf */
      0x4000, 0x1c00, 0x2400, 0x0000 /* 2, 2^-8 (0.996 -> 1), 2^-6 (3.98 -> 4) */];
    const packed = new Uint8Array(new Uint16Array(half).buffer);
    for (const fourcc of [0x48344241, 0x48344258])
      expect(Array.from(scanoutRgba(fourcc, packed))).toEqual([255, 128, 0, 255, 0, 0, 255, 255, 255, 1, 4, 255]);
  });

  it("rounds exactly as the presenter shader's float32 arithmetic does, for every 10-bit and half value", () => {
    const f = Math.fround;
    for (let v = 0; v < 1024; v++) {
      expect(reduce10(v)).toBe(Math.round(v * 255 / 1023));
      // floor((v * 510 + 1023) / 2046) in float32 (kms-color-stage.ts).
      expect(Math.floor(f(f(f(v * 510) + 1023) / 2046))).toBe(reduce10(v));
      // v recovered from the normalized texel v / 1023.
      expect(Math.floor(f(f(f(v / 1023) * 1023) + 0.5))).toBe(v);
    }
    for (let bits = 0; bits < 0x10000; bits++) {
      const reduced = reduceHalf(bits);
      // floor(clamp(f, 0, 1) * 255 + 0.5) in float32.
      const sign = bits & 0x8000 ? -1 : 1, e = (bits >>> 10) & 31, m = bits & 1023;
      const half = e === 31 ? (m ? NaN : sign * Infinity) : sign * (e ? (1 + m / 1024) * 2 ** (e - 15) : m * 2 ** -24);
      const clamped = Number.isNaN(half) ? 0 : Math.min(Math.max(half, 0), 1);
      expect(Math.floor(f(f(f(clamped) * 255) + 0.5))).toBe(reduced);
      expect(reduceFloat(half)).toBe(reduced);
    }
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


it("distinguishes renewed framebuffer identity with identical BO and image geometry", () => {
  const bos = new GbmBoRegistry();
  bos.create({pid: 7, bo_id: 1, size: 16, w: 2, h: 2, stride: 8});
  bos.pixelView(1)!.set([0, 0, 255, 255]);
  const kms = new KmsRegistry(bos);
  const record = (fb: number) => {
    const bytes = new Uint8Array(40), view = new DataView(bytes.buffer);
    [1, 2, 2, 30, 40, 0, 0, fb].forEach((word, i) => view.setUint32(8 + i * 4, word, true));
    return bytes;
  };
  kms.applyCursorRecord(record(25));
  const first = kms.cursorSnapshot();
  kms.applyCursorRecord(record(26));
  const renewed = kms.cursorSnapshot();
  expect(renewed.pixels).toEqual(first.pixels);
  expect(renewed.pixels).not.toBe(first.pixels);
  expect(kms.retireCursorBo(2)).toBe(false);
  expect(kms.cursorSnapshot()).toBe(renewed);
  expect(kms.retireCursorBo(1)).toBe(true);
  expect(kms.cursorSnapshot().pixels).toBeNull();
});


it("applies the device cursor plane with no master, and needs framebuffer identity for an image", () => {
  const bos = new GbmBoRegistry(), kms = new KmsRegistry(bos);
  bos.create({pid: 7, bo_id: 1, size: 16, w: 2, h: 2, stride: 8});
  bos.pixelView(1)!.set([0, 0, 255, 255]);
  const snapshot = kms.cursorSnapshot();
  const read = vi.spyOn(bos, "syncToSab");
  const bytes = new Uint8Array(40), view = new DataView(bytes.buffer);
  [1, 2, 2, 0, 0, 0, 0, 0].forEach((word, i) => view.setUint32(8 + i * 4, word, true));
  expect(() => kms.applyCursorRecord(bytes)).toThrow("image identity");
  expect(kms.cursorSnapshot()).toBe(snapshot);
  expect(read).not.toHaveBeenCalled();
  // A plane installed before a master change keeps updating without one.
  view.setUint32(36, 25, true);
  expect(kms.applyCursorRecord(bytes)!.pixels!.slice(0, 4)).toEqual(new Uint8ClampedArray([255, 0, 0, 255]));
});

it("refuses protocol 4 image/FB inconsistencies before reading or replacing current storage", () => {
  const bos = new GbmBoRegistry(), kms = new KmsRegistry(bos);
  kms.setMaster(7, 1n, 1n);
  const snapshot = kms.cursorSnapshot();
  const read = vi.spyOn(bos, "syncToSab");
  for (const words of [[999,2,2,0,0,0,0,0], [0,0,0,0,0,0,0,25], [0,2,2,0,0,0,0,0],
    [0,0,0,0,0,1,0,0], [999,65,2,0,0,0,0,25]]) {
    const bytes = new Uint8Array(40), view = new DataView(bytes.buffer);
    words.forEach((word,i) => view.setUint32(8+i*4,word,true));
    expect(() => kms.applyCursorRecord(bytes)).toThrow(/Invalid KMS cursor image/);
    expect(kms.cursorSnapshot()).toBe(snapshot);
    expect(read).not.toHaveBeenCalled();
  }
});
