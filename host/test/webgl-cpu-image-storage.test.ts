import {expect, it} from "vitest";
import {GbmBoRegistry} from "../src/dri/registry";
import {CpuImageStorage, type CpuImageLayout} from "../src/webgl/cpu-image-storage";
import {GlContextRegistry} from "../src/webgl/registry";
import {registerImageSource} from "../src/webgl/image-storage";
import {foreignTextureGl} from "./support/foreign-texture-gl";
import {halfBits} from "../src/webgl/cpu-image-codec";
import {noteStorageWrite, setImageWriteAudit} from "../src/webgl/image-writes";
import {NativeGlFault} from "../src/webgl/native-recovery";

// Tests model accepted native rendering into a mirror by writing its pixels
// and counting the write, as every renderer write path does (image-writes.ts).
function renderer() {
  const f = foreignTextureGl(), gl = f.gl;
  const get = gl.getParameter.bind(gl), bind = gl.bindTexture.bind(gl);
  const textures = new Map<WebGLTexture, Uint8Array>();
  const fields = new Map<number, unknown>([[0x88ef,null],[0x88ed,null],[0xc02,0x8ce0],
    [0xcf5,8],[0xcf2,11],[0xcf3,2],[0xcf4,3],[0x9240,true],[0x9241,true],[0x9243,0x9244],
    [0xd05,8],[0xd02,7],[0xd04,3],[0xd03,2]]);
  let texture: WebGLTexture | null = null, readFailure = false;
  Object.assign(gl, {
    isContextLost: () => false,
    getParameter: (p: number) => fields.has(p) ? fields.get(p) : get(p),
    bindTexture: (target: number, value: WebGLTexture | null) => {bind(target,value);texture=value;},
    bindBuffer: (target: number, value: object | null) => fields.set(target === 0x88ec ? 0x88ef : 0x88ed,value),
    pixelStorei: (field: number, value: number) => fields.set(field,field === 0x9240 || field === 0x9241 ? !!value : value),
    readBuffer: (value: number) => fields.set(0xc02,value),
    texImage2D: (_target: number,_level: number,_internal: number,w: number,h: number) => {
      textures.set(texture!,new Uint8Array(w*h*4));
    },
    texSubImage2D: (_target: number,_level: number,_x: number,_y: number,_w: number,_h: number,
      _format: number,_type: number,bytes: Uint8Array) => {
      expect(fields.get(0x88ef)).toBeNull();
      expect([0xcf5,0xcf2,0xcf3,0xcf4,0x9240,0x9241,0x9243].map(p=>fields.get(p)))
        .toEqual([1,0,0,0,false,false,0]);
      textures.get(texture!)!.set(bytes);
    },
    readPixels: (_x: number,_y: number,_w: number,_h: number,_format: number,_type: number,bytes: Uint8Array) => {
      if (readFailure) throw new Error("readback rejected");
      const fbo = get(0x8caa) as object;
      bytes.set(textures.get(f.frames.get(fbo)!.get(0x8ce0) as WebGLTexture)!);
    },
  });
  return {...f,textures,fields,rejectRead: (value: boolean) => {readFailure=value;}};
}

function fixture() {
  const f = renderer(), registry = new GlContextRegistry(), images = new CpuImageStorage();
  registry.bind({pid:7,sessionId:11,cmdbufAddr:0,cmdbufLen:0});
  const b=registry.get(7,11)!;b.gl=f.gl;b.contextId=21;
  const memory = new WebAssembly.Memory({initial:1,maximum:1});
  let resolve = true;
  const store=new GbmBoRegistry({getProcessMemory:()=>resolve?memory:undefined});
  store.create({pid:7,bo_id:41,size:24,w:2,h:2,stride:12});
  store.pixelView(41)!.set(Uint8Array.from({length:24},(_,i)=>i));
  const layout: CpuImageLayout={width:1,height:2,format:0x34324241,pitch:12,offset:4};
  return {...f,b,store,images,layout,memory,
    prepare:()=>images.prepare(b,store,()=>{}),publish:()=>images.publish(b,store,()=>{}),
    resolve: (value:boolean)=>{resolve=value;}};
}

it("imports declared rows independently of BO geometry and restores native upload state",()=>{
  const f=fixture(), before=[...f.fields];
  const image=f.images.acquire(f.b,41,f.store,f.layout)!;
  expect(image).not.toBeNull();expect(f.prepare()).toBe(true);
  expect([...f.textures.get(image.tex)!]).toEqual([4,5,6,7,16,17,18,19]);
  expect([...f.fields]).toEqual(before);
  expect(f.images.acquire(f.b,41,f.store,f.layout)).toBe(image);
  expect(f.b.textures.size).toBe(0);
});

it.each([0x34325241,0x34325258,0x34324241,0x34324258])("decodes and writes back format %s without modifying padding or X bits",format=>{
  const f=fixture(), layout={...f.layout,format}, original=new Uint8Array(f.store.pixelView(41)!);
  const image=f.images.acquire(f.b,41,f.store,layout)!;
  expect(f.prepare()).toBe(true);
  const bgra=format===0x34325241||format===0x34325258,opaque=format===0x34325258||format===0x34324258;
  expect([...f.textures.get(image.tex)!].slice(0,4)).toEqual([bgra?6:4,5,bgra?4:6,opaque?255:7]);
  f.images.begin(f.b);f.textures.get(image.tex)!.set([100,101,102,103]);noteStorageWrite(image.tex);
  expect(f.publish()).toBe(true);
  const expected=new Uint8Array(original);expected.set([bgra?102:100,101,bgra?100:102,opaque?7:103],4);
  expect(f.store.pixelView(41)).toEqual(expected);
});

it("merges changed sibling pixels without an unchanged view erasing the writer",()=>{
  const f=fixture(), first=f.images.acquire(f.b,41,f.store,f.layout)!;
  const second=f.images.acquire(f.b,41,f.store,{...f.layout,format:0x34325241})!;
  expect(first.tex).not.toBe(second.tex);expect(f.prepare()).toBe(true);
  f.images.begin(f.b);f.textures.get(first.tex)!.set([100,101,102,103]);noteStorageWrite(first.tex);
  expect(f.publish()).toBe(true);expect([...f.store.pixelView(41)!].slice(4,8)).toEqual([100,101,102,103]);
  expect(f.prepare()).toBe(true);expect([...f.textures.get(second.tex)!].slice(0,4)).toEqual([102,101,100,103]);
});

it("keeps accepted native writes through failed readback before any CPU refresh",()=>{
  const f=fixture(), image=f.images.acquire(f.b,41,f.store,f.layout)!;
  expect(f.prepare()).toBe(true);f.images.begin(f.b);f.textures.get(image.tex)!.set([100,101,102,103]);noteStorageWrite(image.tex);
  f.rejectRead(true);expect(f.publish()).toBe(false);
  expect([...f.store.pixelView(41)!].slice(4,8)).toEqual([4,5,6,7]);
  expect(f.prepare()).toBe(false);expect([...f.textures.get(image.tex)!].slice(0,4)).toEqual([100,101,102,103]);
  f.rejectRead(false);expect(f.prepare()).toBe(true);
  expect([...f.store.pixelView(41)!].slice(4,8)).toEqual([100,101,102,103]);
});

it("retries failed publication without rereading native pixels or losing unrelated CPU writes",()=>{
  const f=fixture(), image=f.images.acquire(f.b,41,f.store,f.layout)!;
  expect(f.prepare()).toBe(true);f.images.begin(f.b);f.textures.get(image.tex)!.set([100,101,102,103]);noteStorageWrite(image.tex);
  const publish=f.store.publishDevicePixels.bind(f.store);let accept=false;
  f.store.publishDevicePixels=(...args)=>accept&&publish(...args);
  expect(f.publish()).toBe(false);f.rejectRead(true);f.store.pixelView(41)![0]=200;
  expect(f.prepare()).toBe(false);accept=true;expect(f.prepare()).toBe(true);
  expect(f.store.pixelView(41)![0]).toBe(200);
  expect([...f.store.pixelView(41)!].slice(4,8)).toEqual([100,101,102,103]);
});

it("faults when the live renderer refuses retiring storage's native deletion",()=>{
  const f=fixture();f.images.acquire(f.b,41,f.store,f.layout)!;
  expect(f.prepare()).toBe(true);f.control.failDelete=true;
  let fault: unknown;try{f.images.retire(41);}catch(error){fault=error;}
  expect(fault).toBeInstanceOf(NativeGlFault);
  expect((fault as Error).message).toMatch(/live renderer refused deleteTexture/);
});

it("distinguishes image-layout identities within one retained BO",()=>{
  const f=fixture(), texture={} as WebGLTexture;
  expect(registerImageSource(f.b,41,texture,1,2,"rgba:0")).toBe(1);
  expect(registerImageSource(f.b,41,texture,1,2,"rgba:0")).toBe(1);
  expect(registerImageSource(f.b,41,texture,1,2,"bgra:4")).toBe(2);
  expect(f.b.imageSources.size).toBe(2);
});

it("restores implicit alpha one after rendering to an XRGB view",()=>{
  const f=fixture(), image=f.images.acquire(f.b,41,f.store,{...f.layout,format:0x34325258})!;
  expect(f.prepare()).toBe(true);f.images.begin(f.b);f.textures.get(image.tex)!.set([100,101,102,10]);noteStorageWrite(image.tex);
  expect(f.publish()).toBe(true);expect(f.prepare()).toBe(true);
  expect([...f.textures.get(image.tex)!].slice(0,4)).toEqual([100,101,102,255]);
  expect(f.store.pixelView(41)![7]).toBe(7);
});

/** A renderer whose textures hold their internal format's texels and whose
 * readPixels converts them as GL does for the requested format/type. */
function typedRenderer() {
  const f = renderer(), gl = f.gl;
  const typed = new Map<WebGLTexture, {internal: number; data: Uint8Array | Uint16Array | Uint32Array}>();
  let texture: WebGLTexture | null = null;
  const bind = gl.bindTexture.bind(gl);
  const half = (bits: number) => {
    const sign = bits & 0x8000 ? -1 : 1, e = (bits >>> 10) & 31, m = bits & 1023;
    return e === 0 ? sign * m * 2 ** -24 : e === 31 ? (m ? NaN : sign * Infinity) : sign * (1 + m / 1024) * 2 ** (e - 15);
  };
  Object.assign(gl, {
    bindTexture: (target: number, value: WebGLTexture | null) => {bind(target,value);texture=value;},
    texImage2D: (_target: number,_level: number,internal: number,w: number,h: number) => {
      const n = w * h;
      typed.set(texture!, {internal, data: internal === 0x8229 ? new Uint8Array(n) : internal === 0x822b
        ? new Uint8Array(n * 2) : internal === 0x8d62 ? new Uint16Array(n) : internal === 0x8059
        ? new Uint32Array(n) : internal === 0x881a ? new Uint16Array(n * 4) : new Uint8Array(n * 4)});
    },
    texSubImage2D: (_t: number,_l: number,_x: number,_y: number,_w: number,_h: number,
      format: number,type: number,pixels: ArrayBufferView) => {
      const target = typed.get(texture!)!;
      const expected: Record<number, [number, number, string]> = {0x8229: [0x1903, 0x1401, "Uint8Array"],
        0x822b: [0x8227, 0x1401, "Uint8Array"], 0x8d62: [0x1907, 0x8363, "Uint16Array"],
        0x8059: [0x1908, 0x8368, "Uint32Array"], 0x881a: [0x1908, 0x140b, "Uint16Array"]};
      expect([format, type, pixels.constructor.name]).toEqual(expected[target.internal]);
      target.data.set(pixels as never);
    },
    readPixels: (_x: number,_y: number,_w: number,_h: number,format: number,type: number,out: ArrayBufferView) => {
      const fbo = gl.getParameter(0x8caa) as object;
      const source = typed.get(f.frames.get(fbo)!.get(0x8ce0) as WebGLTexture)!, d = source.data;
      expect(format).toBe(0x1908);
      if (source.internal === 0x8059) { expect(type).toBe(0x8368); (out as Uint32Array).set(d); return; }
      if (source.internal === 0x881a) {
        expect(type).toBe(0x1406);
        (out as Float32Array).set(Array.from(d, half)); return;
      }
      expect(type).toBe(0x1401);
      const bytes = out as Uint8Array;
      for (let i = 0; i < bytes.length / 4; i++) {
        const rgba = source.internal === 0x8229 ? [d[i], 0, 0, 255] : source.internal === 0x822b
          ? [d[i * 2], d[i * 2 + 1], 0, 255]
          : [Math.round((d[i] >>> 11) * 255 / 31), Math.round(((d[i] >>> 5) & 63) * 255 / 63),
            Math.round((d[i] & 31) * 255 / 31), 255];
        bytes.set(rgba, i * 4);
      }
    },
  });
  return {...f, typed};
}

it.each([
  // name, fourcc, bytes per pixel, the plane's pixels (bytes, one per row),
  // the texels they upload, rendered texels, the bytes those publish
  ["R8", 0x20203852, 1, [9, 200], [9, 200], [17, 255], [17, 255]],
  ["GR88", 0x38385247, 2, [1, 2, 3, 4], [1, 2, 3, 4], [5, 6, 7, 8], [5, 6, 7, 8]],
  ["RGB565", 0x36314752, 2, [0x21, 0x84, 0xff, 0xff], [0x8421, 0xffff], [0x07e0, 0x001f], [0xe0, 0x07, 0x1f, 0x00]],
  ["ABGR2101010", 0x30334241, 4, [1, 2, 3, 0x44, 5, 6, 7, 0x88], [0x44030201, 0x88070605],
    [0xc00ffc01, 0x3ff00000], [0x01, 0xfc, 0x0f, 0xc0, 0x00, 0x00, 0xf0, 0x3f]],
  // ARGB: blue in the low bits, so the 10-bit red and blue fields swap.
  ["ARGB2101010", 0x30335241, 4, [0xff, 0x03, 0x00, 0x40], [0x7ff00000], [0x000003ff], [0x00, 0x00, 0xf0, 0x3f]],
  // XBGR: the padding bits (0x40 here) are kept; alpha uploads as 1.0 (3).
  ["XBGR2101010", 0x30334258, 4, [1, 2, 3, 0x40], [0xc0030201], [0xc0000005], [5, 0, 0, 0x40]],
  ["ABGR16161616F", 0x48344241, 8, [0x00, 0x3c, 0x00, 0xc0, 0x01, 0x00, 0xff, 0x7b], [0x3c00, 0xc000, 0x0001, 0x7bff],
    [0x3800, 0x8000, 0x03ff, 0x7c00], [0x00, 0x38, 0x00, 0x80, 0xff, 0x03, 0x00, 0x7c]],
  // XBGR16F: the padding half (0x1234) is kept; alpha uploads as 1.0.
  ["XBGR16161616F", 0x48344258, 8, [0x00, 0x3c, 0x00, 0x00, 0x00, 0x00, 0x34, 0x12], [0x3c00, 0, 0, 0x3c00],
    [0x4000, 0x3c00, 0x3800, 0x3c00], [0x00, 0x40, 0x00, 0x3c, 0x00, 0x38, 0x34, 0x12]],
])("mirrors %s planes in their own texture format, exactly both ways", (_name, format, cpp, plane, texels, rendered, published) => {
  const f = typedRenderer(), registry = new GlContextRegistry(), images = new CpuImageStorage();
  registry.bind({pid:7,sessionId:11,cmdbufAddr:0,cmdbufLen:0});
  const b=registry.get(7,11)!;b.gl=f.gl;b.contextId=21;
  const memory = new WebAssembly.Memory({initial:1,maximum:1});
  const store=new GbmBoRegistry({getProcessMemory:()=>memory});
  store.create({pid:7,bo_id:41,size:64,w:2,h:2,stride:32});
  store.pixelView(41)!.set(Uint8Array.from({length:64},(_,i)=>i + 100));
  // One pixel per row at byte 8 of a 32-byte row, so the bytes around the
  // plane and the row padding must survive publication.
  const rows = plane.length / cpp, at = (row: number) => 8 + row * 32;
  for (let row = 0; row < rows; row++) store.pixelView(41)!.set(plane.slice(row * cpp, (row + 1) * cpp), at(row));
  const before = new Uint8Array(store.pixelView(41)!);
  const image = images.acquire(b,41,store,{width:1,height:rows,format,pitch:32,offset:8})!;
  expect(image).not.toBeNull();
  expect(images.prepare(b,store,()=>{})).toBe(true);
  expect([...f.typed.get(image.tex)!.data]).toEqual(texels);
  images.begin(b);
  f.typed.get(image.tex)!.data.set(rendered); noteStorageWrite(image.tex);
  expect(images.publish(b,store,()=>{})).toBe(true);
  const expected = new Uint8Array(before);
  for (let row = 0; row < rows; row++) expected.set(published.slice(row * cpp, (row + 1) * cpp), at(row));
  expect([...store.pixelView(41)!]).toEqual([...expected]);
  // The published bytes are what the texture holds: a re-upload keeps it.
  expect(images.prepare(b,store,()=>{})).toBe(true);
  expect([...f.typed.get(image.tex)!.data]).toEqual(rendered);
});

it("converts every binary16 value read back as float32 to the same half", () => {
  const view = new DataView(new ArrayBuffer(4));
  const half = (bits: number) => {
    const sign = bits & 0x8000 ? -1 : 1, e = (bits >>> 10) & 31, m = bits & 1023;
    return e === 0 ? sign * m * 2 ** -24 : e === 31 ? (m ? NaN : sign * Infinity) : sign * (1 + m / 1024) * 2 ** (e - 15);
  };
  for (let bits = 0; bits < 0x10000; bits++) {
    const value = half(bits);
    if (Number.isNaN(value)) { expect((halfBits(value) & 0x7c00) === 0x7c00 && (halfBits(value) & 0x3ff) !== 0).toBe(true); continue; }
    expect(halfBits(value)).toBe(bits);
  }
  // Rounding to nearest even beyond half precision; overflow; underflow.
  view.setUint32(0, 0x3f801000); expect(halfBits(view.getFloat32(0))).toBe(0x3c00);
  view.setUint32(0, 0x3f803000); expect(halfBits(view.getFloat32(0))).toBe(0x3c02);
  expect(halfBits(65520)).toBe(0x7c00);
  expect(halfBits(2 ** -26)).toBe(0);
});

it("reads back only mirrors whose native image was written during the submission",()=>{
  // Production behavior: the write-count audit, on for this gate, reads back anyway.
  setImageWriteAudit(false);
  try { readsBackOnlyWrittenMirrors(); } finally { setImageWriteAudit(true); }
});
function readsBackOnlyWrittenMirrors() {
  const f=fixture(), first=f.images.acquire(f.b,41,f.store,f.layout)!;
  const second=f.images.acquire(f.b,41,f.store,{...f.layout,format:0x34325241})!;
  expect(f.prepare()).toBe(true);
  let reads=0;const read=f.gl.readPixels.bind(f.gl);
  Object.assign(f.gl,{readPixels:(...args: Parameters<typeof read>)=>{reads++;return read(...args);}});
  // A submission that only samples the mirrors publishes nothing.
  f.images.begin(f.b);expect(f.publish()).toBe(true);expect(reads).toBe(0);
  expect(f.prepare()).toBe(true);
  // A written mirror is read back; its unwritten sibling is not.
  f.images.begin(f.b);f.textures.get(first.tex)!.set([100,101,102,103]);noteStorageWrite(first.tex);
  expect(f.publish()).toBe(true);expect(reads).toBe(1);
  expect([...f.store.pixelView(41)!].slice(4,8)).toEqual([100,101,102,103]);
  expect(f.prepare()).toBe(true);expect([...f.textures.get(second.tex)!].slice(0,4)).toEqual([102,101,100,103]);
}

it("fails loudly when a mirror changes behind an unchanged write count",()=>{
  const f=fixture(), image=f.images.acquire(f.b,41,f.store,f.layout)!;
  expect(f.prepare()).toBe(true);
  // An unchanged submission passes the audit and publishes nothing.
  f.images.begin(f.b);expect(f.publish()).toBe(true);
  expect([...f.store.pixelView(41)!].slice(4,8)).toEqual([4,5,6,7]);
  // A native write that did not count itself is a fatal fault, not lost pixels.
  f.images.begin(f.b);f.textures.get(image.tex)!.set([100,101,102,103]);
  expect(()=>f.publish()).toThrow(/changed without a counted write/);
  expect([...f.store.pixelView(41)!].slice(4,8)).toEqual([4,5,6,7]);
});
