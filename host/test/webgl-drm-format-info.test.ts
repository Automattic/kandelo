import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { DRM_FORMATS, drmFormatInfo, planeHeight, planeWidth, rowBytes } from "../src/webgl/drm-format-info.js";

const root = resolve(import.meta.dirname, "../..");
type Row = { format: number; numPlanes: number; cpp: number[]; hsub: number; vsub: number; isYuv: boolean;
  gpuStorage: number; opaque: boolean; planeFormats: number[] };
const host: Row[] = DRM_FORMATS.map(info => ({ ...info, cpp: [...info.cpp], planeFormats: [...info.planeFormats] }));

it("keeps one DRM format table in Rust, C and TypeScript", () => {
  const rust = readFileSync(resolve(root, "crates/shared/src/lib.rs"), "utf8");
  const constants = new Map([...rust.matchAll(/pub const (DRM_FORMAT_[A-Z0-9]+): u32 = (0x[0-9a-fA-F]+);/g)]
    .map(match => [match[1], Number(match[2])]));
  const table = rust.match(/pub const DRM_FORMATS: \[DrmFormatInfo; \d+\] = \[([\s\S]*?)\n {4}\];/)![1];
  const storage = new Map([...rust.matchAll(/const (\w+_STORAGE): u32 = (0x[0-9a-f]+);/g)].map(match => [match[1], Number(match[2])]));
  const rustRows: Row[] = [...table.matchAll(/(rgb|yuv)\((DRM_FORMAT_[A-Z0-9]+), ([^)]*)\)/g)].map(([, kind, name, rest]) => {
    const format = constants.get(name)!;
    expect(format, name).toBeTypeOf("number");
    if (kind === "rgb") {
      const [cpp, gpuStorage, opaque] = rest.split(", ");
      return { format, numPlanes: 1, cpp: [Number(cpp), 0, 0], hsub: 1, vsub: 1, isYuv: false,
        gpuStorage: storage.get(gpuStorage)!, opaque: opaque === "true", planeFormats: [format, 0, 0] };
    }
    const [, planes, c0, c1, c2, h, v, formats] =
      rest.match(/^(\d+), \[(\d+), (\d+), (\d+)\], (\d+), (\d+), \[([^\]]*)\]$/)!;
    const planeFormats = formats.split(", ").map(name => name === "0" ? 0 : constants.get(name)!);
    return { format, numPlanes: Number(planes), cpp: [c0, c1, c2].map(Number), hsub: Number(h), vsub: Number(v),
      isYuv: true, gpuStorage: 0, opaque: false, planeFormats };
  });
  const c = readFileSync(resolve(root, "libc/glue/drm_format_info.h"), "utf8");
  const cRows: Row[] = [...c.matchAll(/^\s*WPK_FMT_(RGB|YUV)\((0x[0-9a-f]+)u, ([^)]*)\),/gm)].map(([, kind, fourcc, rest]) => {
    const format = Number(fourcc), values = rest.split(",").map(value => Number(value.trim().replace(/u$/, "")));
    if (kind === "RGB") return { format, numPlanes: 1, cpp: [values[0], 0, 0], hsub: 1, vsub: 1, isYuv: false,
      gpuStorage: values[1], opaque: values[2] === 1, planeFormats: [format, 0, 0] };
    return { format, numPlanes: values[0], cpp: values.slice(1, 4), hsub: values[4], vsub: values[5], isYuv: true,
      gpuStorage: 0, opaque: false, planeFormats: values.slice(6, 9) };
  });
  expect(host.length).toBe(20);
  expect(rustRows).toEqual(host);
  expect(cRows).toEqual(host);
});

it("sizes planes as drm_format_info does", () => {
  const nv12 = drmFormatInfo(0x3231564e)!, yuyv = drmFormatInfo(0x56595559)!, yuv420 = drmFormatInfo(0x32315559)!;
  // A 5x3 frame: 5x3 luma, 3x2 subsampled chroma (rounded up).
  expect([planeWidth(nv12, 5, 1), planeHeight(nv12, 3, 1)]).toEqual([3, 2]);
  expect([rowBytes(nv12, 5, 0), rowBytes(nv12, 5, 1)]).toEqual([5, 6]);
  expect([rowBytes(yuv420, 5, 1), rowBytes(yuv420, 5, 2)]).toEqual([3, 3]);
  // An odd-width packed row still ends with a whole Y0,Cb,Y1,Cr group.
  expect([rowBytes(yuyv, 4, 0), rowBytes(yuyv, 5, 0)]).toEqual([8, 12]);
  expect(drmFormatInfo(0x34324752 /* RGB888 */)).toBeNull();
});
