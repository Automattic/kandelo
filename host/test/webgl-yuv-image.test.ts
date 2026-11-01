import { describe, expect, it } from "vitest";
import { GbmBoRegistry } from "../src/dri/registry";
import { foreignTextureGl } from "./support/foreign-texture-gl";
import { imageWriteAudit, storageWrites, setImageWriteAudit } from "../src/webgl/image-writes";
import { GlContextRegistry } from "../src/webgl/registry";
import { createWasmPosixKernelTestHarness, type WasmPosixKernel } from "../src/kernel";
import { createKernelScratchTestInstance } from "./support/kernel-scratch-instance";
import { pixelGl } from "./support/kms-color-gl";

/**
 * YUV dma-buf images (EGL_EXT_image_dma_buf_import with
 * OES_EGL_image_external): YCbCr-to-RGB conversion against reference values,
 * and the converted image's lifetime, which is refreshed only when the
 * planes' bytes are written.
 */

const NV12 = 0x3231564e, NV21 = 0x3132564e, YUV420 = 0x32315559, YVU420 = 0x32315659;
const YUYV = 0x56595559, UYVY = 0x59565955, P010 = 0x30313050;
type Conversion = { colorSpace: 0 | 1 | 2; fullRange: boolean; sitingH: 0 | 0.5; sitingV: 0 | 0.5 };
const BT601_NARROW: Conversion = { colorSpace: 0, fullRange: false, sitingH: 0, sitingV: 0 };

const load = async () => (await import("../src/webgl/yuv-convert.js")).convertYuv;

/** Planes of a `width` x `height` image whose every pixel is (y, cb, cr),
 * tightly packed, in each format's own layout. 10-bit values for P010. */
function constantPlanes(format: number, width: number, height: number, y: number, cb: number, cr: number) {
  const cw = Math.ceil(width / 2), ch = Math.ceil(height / 2);
  const plane = (bytes: number[], pitch: number) => ({ bytes: Uint8Array.from(bytes), offset: 0, pitch });
  const fill = (count: number, values: number[]) => Array.from({ length: count }, (_, i) => values[i % values.length]);
  switch (format) {
    case NV12: case NV21: {
      const pair = format === NV12 ? [cb, cr] : [cr, cb];
      return [plane(fill(width * height, [y]), width), plane(fill(cw * ch * 2, pair), cw * 2)];
    }
    case YUV420: case YVU420: {
      const [first, second] = format === YUV420 ? [cb, cr] : [cr, cb];
      return [plane(fill(width * height, [y]), width), plane(fill(cw * ch, [first]), cw), plane(fill(cw * ch, [second]), cw)];
    }
    case YUYV: return [plane(fill(cw * 4 * height, [y, cb, y, cr]), cw * 4)];
    case UYVY: return [plane(fill(cw * 4 * height, [cb, y, cr, y]), cw * 4)];
    case P010: {
      const le = (value: number) => [(value << 6) & 255, (value << 6) >> 8];
      return [plane(fill(width * height * 2, le(y)), width * 2), plane(fill(cw * ch * 4, [...le(cb), ...le(cr)]), cw * 4)];
    }
  }
  throw new Error("format");
}

/** Published 8-bit YCbCr-to-RGB matrices (ITU-R BT.601, BT.709 and BT.2020
 * narrow range, and BT.601 full range as JFIF), independent of the Kr/Kb
 * derivation the converter uses. */
const MATRICES: Record<string, { y: number; offsets: [number, number]; r: number; gb: number; gr: number; b: number }> = {
  "601n": { y: 1.164383, offsets: [16, 128], r: 1.596027, gb: 0.391762, gr: 0.812968, b: 2.017232 },
  "709n": { y: 1.164384, offsets: [16, 128], r: 1.792741, gb: 0.213249, gr: 0.532909, b: 2.112402 },
  "2020n": { y: 1.164384, offsets: [16, 128], r: 1.678674, gb: 0.187326, gr: 0.650424, b: 2.141772 },
  "601f": { y: 1, offsets: [0, 128], r: 1.402, gb: 0.344136, gr: 0.714136, b: 1.772 },
};
function reference(matrix: string, y: number, cb: number, cr: number): number[] {
  const m = MATRICES[matrix], l = m.y * (y - m.offsets[0]), u = cb - m.offsets[1], v = cr - m.offsets[1];
  const clamp = (x: number) => Math.min(255, Math.max(0, Math.round(x)));
  return [clamp(l + m.r * v), clamp(l - m.gb * u - m.gr * v), clamp(l + m.b * u), 255];
}

describe("YCbCr to RGB", () => {
  it("matches the published BT.601, BT.709 and BT.2020 matrices over the sample range", async () => {
    const convert = await load();
    const cases: [string, Conversion][] = [
      ["601n", BT601_NARROW], ["709n", { ...BT601_NARROW, colorSpace: 1 }],
      ["2020n", { ...BT601_NARROW, colorSpace: 2 }], ["601f", { ...BT601_NARROW, fullRange: true }],
    ];
    for (const [matrix, conversion] of cases) {
      let exact = 0, total = 0;
      for (let y = 0; y <= 255; y += 17) for (let cb = 0; cb <= 255; cb += 15) for (let cr = 0; cr <= 255; cr += 15) {
        const out = convert(NV12, 2, 2, constantPlanes(NV12, 2, 2, y, cb, cr), conversion) as Uint8Array;
        const expected = reference(matrix, y, cb, cr);
        // The published coefficients carry six decimals; only a value within
        // that rounding of a half may round the other way.
        [...out.slice(0, 4)].forEach((value, i) => expect(Math.abs(value - expected[i]), `${matrix} ${y},${cb},${cr}`).toBeLessThanOrEqual(1));
        if ([...out.slice(0, 4)].every((value, i) => value === expected[i])) exact++;
        total++;
      }
      expect(exact / total, matrix).toBeGreaterThan(0.99);
    }
  });

  it("maps the range endpoints exactly", async () => {
    const convert = await load();
    const pixel = (format: number, y: number, cb: number, cr: number, conversion = BT601_NARROW) =>
      [...(convert(format, 2, 2, constantPlanes(format, 2, 2, y, cb, cr), conversion) as Uint8Array).slice(0, 4)];
    for (const colorSpace of [0, 1, 2] as const) {
      expect(pixel(NV12, 16, 128, 128, { ...BT601_NARROW, colorSpace })).toEqual([0, 0, 0, 255]);
      expect(pixel(NV12, 235, 128, 128, { ...BT601_NARROW, colorSpace })).toEqual([255, 255, 255, 255]);
      expect(pixel(NV12, 0, 128, 128, { ...BT601_NARROW, colorSpace, fullRange: true })).toEqual([0, 0, 0, 255]);
      expect(pixel(NV12, 255, 128, 128, { ...BT601_NARROW, colorSpace, fullRange: true })).toEqual([255, 255, 255, 255]);
    }
    // Below black and above white clamp; narrow-range gray 126 is 50.2%.
    expect(pixel(NV12, 4, 128, 128)).toEqual([0, 0, 0, 255]);
    expect(pixel(NV12, 250, 128, 128)).toEqual([255, 255, 255, 255]);
    expect(pixel(NV12, 126, 128, 128)).toEqual([128, 128, 128, 255]);
    // BT.601 narrow red, Y'CbCr (81, 90, 240): R' 0.998, G' and B' below 0.
    expect(pixel(NV12, 81, 90, 240)).toEqual([254, 0, 0, 255]);
  });

  it("reads every format's planes in its own order", async () => {
    const convert = await load();
    const red = [254, 0, 0, 255];
    for (const format of [NV12, NV21, YUV420, YVU420, YUYV, UYVY]) {
      const out = convert(format, 5, 3, constantPlanes(format, 5, 3, 81, 90, 240), BT601_NARROW) as Uint8Array;
      expect(out.length, format.toString(16)).toBe(5 * 3 * 4);
      for (let i = 0; i < 15; i++) expect([...out.slice(i * 4, i * 4 + 4)], format.toString(16)).toEqual(red);
    }
  });

  it("converts 10-bit P010 to 10-bit RGB", async () => {
    const convert = await load();
    const word = (format: number, y: number, cb: number, cr: number, conversion = BT601_NARROW) => {
      const out = convert(format, 2, 2, constantPlanes(format, 2, 2, y, cb, cr), conversion) as Uint32Array;
      return [out[0] & 1023, (out[0] >>> 10) & 1023, (out[0] >>> 20) & 1023, out[0] >>> 30];
    };
    expect(word(P010, 64, 512, 512)).toEqual([0, 0, 0, 3]);
    expect(word(P010, 940, 512, 512)).toEqual([1023, 1023, 1023, 3]);
    // Gray 502 is (502 - 64) / 876 = 0.5 exactly: 511.5 rounds to 512.
    expect(word(P010, 502, 512, 512)).toEqual([512, 512, 512, 3]);
    // Red (324, 360, 960): R' = 260/876 + 1.402 * 448/896 = 0.997801.
    expect(word(P010, 324, 360, 960)[0]).toBe(Math.round((260 / 876 + 1.402 * 0.5) * 1023));
    // BT.2020 full-range white and black.
    const full = { ...BT601_NARROW, colorSpace: 2 as const, fullRange: true };
    expect(word(P010, 1023, 512, 512, full)).toEqual([1023, 1023, 1023, 3]);
    expect(word(P010, 0, 512, 512, full)).toEqual([0, 0, 0, 3]);
  });

  it("interpolates chroma between the samples the siting hints place", async () => {
    const convert = await load();
    // A 4x4 NV12 frame of luma 128, Cr 128 and Cb 128 then 160 across each
    // chroma row; BT.601 full range: B = 128 + 1.772 (Cb - 128).
    const planes = (vertical: boolean) => {
      const chroma = vertical ? [128, 128, 128, 128, 160, 128, 160, 128] : [128, 128, 160, 128, 128, 128, 160, 128];
      return [{ bytes: new Uint8Array(16).fill(128), offset: 0, pitch: 4 }, { bytes: Uint8Array.from(chroma), offset: 0, pitch: 4 }];
    };
    const blue = (cb: number) => Math.round(128 + 1.772 * (cb - 128));
    const full = { ...BT601_NARROW, fullRange: true };
    const row = (out: Uint8Array, y: number) => [0, 1, 2, 3].map(x => out[(y * 4 + x) * 4 + 2]);
    // Siting 0: chroma j sits on luma 2j; 0.5: halfway between 2j and 2j+1.
    let out = convert(NV12, 4, 4, planes(false), { ...full, sitingH: 0 }) as Uint8Array;
    expect(row(out, 0)).toEqual([blue(128), blue(144), blue(160), blue(160)]);
    out = convert(NV12, 4, 4, planes(false), { ...full, sitingH: 0.5 }) as Uint8Array;
    expect(row(out, 0)).toEqual([blue(128), blue(136), blue(152), blue(160)]);
    out = convert(NV12, 4, 4, planes(true), { ...full, sitingV: 0.5 }) as Uint8Array;
    expect([0, 1, 2, 3].map(y => row(out, y)[0])).toEqual([blue(128), blue(136), blue(152), blue(160)]);
    // A packed row is subsampled horizontally only: YUYV 0.5 siting.
    const yuyv = { bytes: Uint8Array.from([128, 128, 128, 128, 128, 160, 128, 128]), offset: 0, pitch: 8 };
    out = convert(YUYV, 4, 1, [yuyv], { ...full, sitingH: 0.5 }) as Uint8Array;
    expect(row(out, 0)).toEqual([blue(128), blue(136), blue(152), blue(160)]);
  });

  it("honors plane offsets and pitches and odd sizes", async () => {
    const convert = await load();
    // 3x3 YUV420 at offsets inside one buffer with padded rows.
    const bytes = new Uint8Array(64).fill(0);
    for (let y = 0; y < 3; y++) bytes.fill(81, 4 + y * 5, 4 + y * 5 + 3);
    bytes.set([90, 90, 0, 90, 90], 24); bytes.set([240, 240, 0, 240, 240], 40);
    const planes = [{ bytes, offset: 4, pitch: 5 }, { bytes, offset: 24, pitch: 3 }, { bytes, offset: 40, pitch: 3 }];
    const out = convert(YUV420, 3, 3, planes, BT601_NARROW) as Uint8Array;
    for (let i = 0; i < 9; i++) expect([...out.slice(i * 4, i * 4 + 4)]).toEqual([254, 0, 0, 255]);
    // An odd-width YUYV row: the third pixel uses the second pair's chroma.
    const yuyv = { bytes: Uint8Array.from([81, 90, 81, 240, 81, 90, 0, 240]), offset: 0, pitch: 8 };
    const odd = convert(YUYV, 3, 1, [yuyv], BT601_NARROW) as Uint8Array;
    expect([...odd.slice(8, 12)]).toEqual([254, 0, 0, 255]);
  });
});

describe("YUV images", () => {
  function fixture() {
    const f = foreignTextureGl(), gl = f.gl;
    const uploads: { tex: unknown; format: number; type: number; pixels: ArrayBufferView }[] = [];
    let bound: unknown = null;
    const bind = gl.bindTexture.bind(gl);
    Object.assign(gl, {
      isContextLost: () => false,
      bindBuffer: () => {},
      bindTexture: (target: number, texture: WebGLTexture | null) => { bind(target, texture); bound = texture; },
      texSubImage2D: (_t: number, _l: number, _x: number, _y: number, _w: number, _h: number, format: number, type: number, pixels: ArrayBufferView) => {
        uploads.push({ tex: bound, format, type, pixels: pixels.slice?.(0) ?? pixels });
      },
    });
    const registry = new GlContextRegistry();
    registry.bind({ pid: 7, sessionId: 11, cmdbufAddr: 0, cmdbufLen: 0 });
    const b = registry.get(7, 11)!; b.gl = gl; b.contextId = 21;
    const store = new GbmBoRegistry({ getProcessMemory: () => undefined });
    store.create({ pid: 7, bo_id: 41, size: 64, w: 8, h: 8, stride: 8 });
    store.create({ pid: 7, bo_id: 42, size: 16, w: 8, h: 2, stride: 8 });
    const write = (bo: number, at: number, bytes: number[]) => {
      const next = new Uint8Array(store.pixelView(bo)!); next.set(bytes, at);
      expect(store.publishDevicePixels(bo, next)).toBe(true);
    };
    // A 4x2 NV12 image: luma rows at 0 and 8, chroma pairs in bo 42.
    write(41, 0, [81, 81, 81, 81, 0, 0, 0, 0, 81, 81, 81, 81]);
    write(42, 0, [90, 240, 90, 240]);
    const layout = { width: 4, height: 2, format: NV12, colorSpace: 0 as const, fullRange: false, siting: 0,
      planes: [{ bo: 41, pitch: 8, offset: 0 }, { bo: 42, pitch: 8, offset: 0 }] };
    return { f, b, store, write, layout, uploads };
  }
  const load = async () => (await import("../src/webgl/cpu-image-storage.js")).CpuImageStorage;

  it("converts when a plane's bytes are written, never otherwise", async () => {
    const CpuImageStorage = await load();
    const { b, store, write, layout, uploads } = fixture(), images = new CpuImageStorage();
    const image = images.acquirePlanar(b, store, layout)!;
    expect(image).not.toBeNull();
    expect(images.prepare(b, store, () => {})).toBe(true);
    expect(uploads).toHaveLength(1);
    expect(uploads[0].tex).toBe(image.tex);
    expect([...(uploads[0].pixels as Uint8Array).slice(0, 4)]).toEqual([254, 0, 0, 255]);
    const written = storageWrites(image.tex).count;
    // Submissions that write nothing do not convert again.
    for (let i = 0; i < 3; i++) expect(images.prepare(b, store, () => {})).toBe(true);
    expect(uploads).toHaveLength(1);
    // A write to either plane does, and siblings see a new storage count.
    write(42, 0, [128, 128]);
    expect(images.prepare(b, store, () => {})).toBe(true);
    expect(uploads).toHaveLength(2);
    // Neutral chroma: gray round((81 - 16) * 255 / 219) = 76.
    expect([...(uploads[1].pixels as Uint8Array).slice(0, 4)]).toEqual([76, 76, 76, 255]);
    expect(storageWrites(image.tex).count).toBeGreaterThan(written);
    // The same layout is the same image; another conversion is another.
    expect(images.acquirePlanar(b, store, layout)).toBe(image);
    expect(images.acquirePlanar(b, store, { ...layout, colorSpace: 1 })).not.toBe(image);
  });

  it("stores P010 as 10-bit RGB", async () => {
    const CpuImageStorage = await load();
    const { b, store, write, uploads } = fixture(), images = new CpuImageStorage();
    // 2x2 P010: two 16-bit luma rows, one Cb,Cr pair.
    write(41, 0, [0, 0x81, 0, 0x81, 0, 0, 0, 0, 0, 0x81, 0, 0x81]);
    write(42, 0, [0, 0x5a, 0, 0xf0]);
    const layout = { width: 2, height: 2, format: P010, colorSpace: 0 as const, fullRange: false, siting: 0,
      planes: [{ bo: 41, pitch: 8, offset: 0 }, { bo: 42, pitch: 4, offset: 0 }] };
    const image = images.acquirePlanar(b, store, layout)!;
    expect(image.storage.internalFormat).toBe(0x8059);
    expect(images.prepare(b, store, () => {})).toBe(true);
    expect(uploads[0].type).toBe(0x8368);
    expect((uploads[0].pixels as Uint32Array)[0] >>> 30).toBe(3);
  });

  it("refuses planes their objects cannot hold and retires with any plane's object", async () => {
    const CpuImageStorage = await load();
    const { b, store, layout } = fixture(), images = new CpuImageStorage();
    // Chroma is one row of two Cb,Cr pairs (4 bytes): offset 13 ends at 17 > 16.
    expect(images.acquirePlanar(b, store, { ...layout, planes: [layout.planes[0], { bo: 42, pitch: 8, offset: 13 }] })).toBeNull();
    expect(images.acquirePlanar(b, store, { ...layout, planes: [layout.planes[0], { bo: 42, pitch: 3, offset: 0 }] })).toBeNull();
    expect(images.acquirePlanar(b, store, { ...layout, planes: [layout.planes[0], { bo: 99, pitch: 8, offset: 0 }] })).toBeNull();
    expect(images.acquirePlanar(b, store, { ...layout, format: 0x34324241 })).toBeNull();
    const image = images.acquirePlanar(b, store, layout)!;
    expect(images.retire(42)).toBe(true);
    // The chroma plane is gone: the converted image is no more.
    expect(images.acquirePlanar(b, store, layout)).not.toBe(image);
  });

  it("reads the kernel's planar import record", async () => {
    const { planarImageRecord, PLANAR_IMAGE_RECORD_BYTES } = await import("../src/webgl/cpu-image-storage.js");
    // shared::dri::WpkDrmImportPlanarImage, handles replaced by bo ids.
    const words = [9, 6, 4, YUV420, 41, 41, 42, 8, 4, 4, 0, 32, 0, 1, 1, 2, 0, 0];
    expect(words.length * 4).toBe(PLANAR_IMAGE_RECORD_BYTES);
    const record = new DataView(new Uint32Array(words).buffer);
    expect(planarImageRecord(record)).toEqual({ width: 6, height: 4, format: YUV420, colorSpace: 1, fullRange: true,
      siting: 2, planes: [{ bo: 41, pitch: 8, offset: 0 }, { bo: 41, pitch: 4, offset: 32 }, { bo: 42, pitch: 4, offset: 0 }] });
    // NV12 has two planes; a non-YUV format or undefined hints is no record.
    words[3] = NV12;
    expect(planarImageRecord(new DataView(new Uint32Array(words).buffer))!.planes).toHaveLength(2);
    for (const [index, value] of [[3, 0x34324241], [13, 3], [14, 2], [15, 4]]) {
      const bad = [...words]; bad[index] = value;
      expect(planarImageRecord(new DataView(new Uint32Array(bad).buffer))).toBeNull();
    }
  });

  it("fails loudly when a plane changed without a counted write", async () => {
    const CpuImageStorage = await load();
    const { b, store, layout } = fixture(), images = new CpuImageStorage(), audit = imageWriteAudit();
    setImageWriteAudit(true);
    try {
      images.acquirePlanar(b, store, layout);
      expect(images.prepare(b, store, () => {})).toBe(true);
      store.pixelView(42)![0] = 7; // no flush, no device publication
      expect(() => images.prepare(b, store, () => {})).toThrow(/without a counted write/);
    } finally { setImageWriteAudit(audit); }
  });
});

describe("the kernel's planar image import", () => {
  it("converts the planes the kernel names into the context's image source", () => {
    const PID = 101, record = 0x3000;
    const r = pixelGl(4, 2);
    Object.assign(r.gl, { renderbufferStorage: () => {}, framebufferRenderbuffer: () => {} });
    const memory = new WebAssembly.Memory({ initial: 2, maximum: 2 });
    const canvas = { width: 4, height: 2, getContext: () => r.gl };
    const kernel = createWasmPosixKernelTestHarness({
      io: {} as any,
      callbacks: { getKmsCanvas: () => canvas, getKmsCrtcIds: () => [1], markKmsCanvasGlOwned: () => {},
        getKmsDisplaySize: () => ({ width: 4, height: 2 }) } as any,
      memory, pointerWidth: 4,
      instance: createKernelScratchTestInstance(4, memory, () => ({}), () => 4096),
    }) as WasmPosixKernel & Record<string, any>;
    const imports = kernel.testAuthority.buildImportObject(memory) as { env: Record<string, (...args: any[]) => any> };
    kernel.gl.bind({ displayFileId: 1n, pid: PID, cmdbufAddr: 128, cmdbufLen: 0 });
    kernel.gl.get(PID)!.cmdbufView = new Uint8Array(memory.buffer, 128, 0);
    imports.env.host_kms_set_master(PID, 1n, 1n);
    imports.env.host_kms_addfb(PID, 9, 99, 4, 2, 0x34325258, 16, 0);
    imports.env.host_kms_set_fb(PID, 1, 9, 0, 0, 4, 2);
    expect(imports.env.host_gl_create_context(PID, 1, 0, 0)).toBe(0);
    // A 4x2 NV12 frame of BT.601 narrow red: luma in bo 41, chroma in 42.
    kernel.bos.create({ pid: PID, bo_id: 41, size: 8, w: 4, h: 2, stride: 4 });
    kernel.bos.create({ pid: PID, bo_id: 42, size: 4, w: 4, h: 1, stride: 4 });
    expect(kernel.bos.publishDevicePixels(41, new Uint8Array(8).fill(81))).toBe(true);
    expect(kernel.bos.publishDevicePixels(42, Uint8Array.from([90, 240, 90, 240]))).toBe(true);
    // shared::dri::WpkDrmImportPlanarImage with bo ids, as the kernel passes it.
    new Uint32Array(memory.buffer, record, 18).set([1, 4, 2, NV12, 41, 42, 0, 4, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const before = r.uploads.length;
    const token = imports.env.host_gl_import_planar_image(PID, 1, record, 72);
    expect(token).toBeGreaterThan(0);
    const converted = r.uploads.slice(before).at(-1)!;
    expect([...converted.slice(0, 8)]).toEqual([254, 0, 0, 255, 254, 0, 0, 255]);
    const source = kernel.gl.get(PID)!.imageSources.get(token)!;
    expect([source.width, source.height, source.bo, source.bos]).toEqual([4, 2, 41, [41, 42]]);
    // The same import again is the same source, with nothing converted.
    expect(imports.env.host_gl_import_planar_image(PID, 1, record, 72)).toBe(token);
    expect(r.uploads.length).toBe(before + 1);
    // A malformed record or length is refused before any GL work.
    expect(imports.env.host_gl_import_planar_image(PID, 1, record, 64)).toBeLessThan(0);
    new Uint32Array(memory.buffer, record + 12, 1)[0] = 0x34324241;
    expect(imports.env.host_gl_import_planar_image(PID, 1, record, 72)).toBe(-22);
  });
});
