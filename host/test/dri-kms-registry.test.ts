import { describe, expect, it } from "vitest";
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

  it("setMasterPid / dropMaster / isMasterPid", () => {
    const kms = new KmsRegistry(new GbmBoRegistry());
    expect(kms.isMasterPid(7)).toBe(false);
    kms.setMasterPid(7);
    expect(kms.isMasterPid(7)).toBe(true);
    expect(kms.isMasterPid(8)).toBe(false);
    kms.dropMaster();
    expect(kms.isMasterPid(7)).toBe(false);
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
