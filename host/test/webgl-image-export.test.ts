import { expect, it } from "vitest";
import { GlContextRegistry, type GlBinding } from "../src/webgl/registry.js";
import { runGlQuery } from "../src/webgl/query.js";
import { decodeAndDispatch } from "../src/webgl/bridge.js";
import { exportImageStorage, prepareImageDraw, type GlImageExport } from "../src/webgl/image-storage.js";
import * as O from "../src/webgl/ops.js";

/* EGL 1.5 section 3.9 / KHR_gl_texture_2D_image, _cubemap_image and
 * _renderbuffer_image. A small renderer model tracks one value per texture
 * image and renderbuffer, framebuffer attachments, and copies/blits, so the
 * tests observe aliasing and orphaning rather than call sequences. */
type Attachment = {tex: object; face: number; level: number} | {rbo: object};
class ValueGl {
  errors: number[] = [];
  images = new Map<object, Map<string, {v: number; w: number; h: number; f: number}>>();
  params = new Map<object, Map<number, number>>();
  rbos = new Map<object, {v: number; w: number; h: number; f: number}>();
  frames = new Map<object, Map<number, Attachment>>();
  units = new Map<number, Map<number, object | null>>();
  deleted = new Set<object>();
  active = 0; draw: object | null = null; read: object | null = null; rbo: object | null = null;
  scissor = false; blits = 0;
  getError() { return this.errors.shift() ?? 0; }
  getParameter(p: number): unknown {
    if (p === 0x84e0) return 0x84c0 + this.active;
    if (p === 0x8069) return this.binding(0x0de1);
    if (p === 0x8514) return this.binding(0x8513);
    if (p === 0x8ca6) return this.draw;
    if (p === 0x8caa) return this.read;
    if (p === 0x8ca7) return this.rbo;
    if (p === 0x0d33 || p === 0x851c || p === 0x84e8) return 4096;
    if (p === 0x8b4d || p === 0x8872) return 16;
    return null;
  }
  isEnabled(cap: number) { return cap === 0x0c11 && this.scissor; }
  enable(cap: number) { if (cap === 0x0c11) this.scissor = true; }
  disable(cap: number) { if (cap === 0x0c11) this.scissor = false; }
  binding(target: number) { return this.units.get(this.active)?.get(target) ?? null; }
  createTexture() { const t = {}; this.images.set(t, new Map()); this.params.set(t, new Map([[0x2801, 0x2702]])); return t; }
  createFramebuffer() { const f = {}; this.frames.set(f, new Map()); return f; }
  createRenderbuffer() { const r = {}; this.rbos.set(r, {v: 0, w: 0, h: 0, f: 0x80e1}); return r; }
  deleteTexture(t: object | null) { if (t) this.deleted.add(t); }
  deleteFramebuffer(f: object | null) { if (f) this.deleted.add(f); }
  deleteRenderbuffer(r: object | null) { if (r) this.deleted.add(r); }
  isTexture(t: object) { return this.images.has(t) && !this.deleted.has(t); }
  isRenderbuffer(r: object) { return this.rbos.has(r) && !this.deleted.has(r); }
  activeTexture(unit: number) { this.active = unit - 0x84c0; }
  bindTexture(target: number, t: object | null) {
    let unit = this.units.get(this.active); if (!unit) this.units.set(this.active, unit = new Map());
    unit.set(target, t);
  }
  bindRenderbuffer(_target: number, r: object | null) { this.rbo = r; }
  bindFramebuffer(target: number, f: object | null) {
    if (target !== 0x8ca8) this.draw = f;
    if (target !== 0x8ca9) this.read = f;
  }
  private texFor(target: number) { return this.binding(target >= 0x8515 && target <= 0x851a ? 0x8513 : 0x0de1)!; }
  texParameteri(target: number, pname: number, value: number) { this.params.get(this.binding(target)!)!.set(pname, value); }
  getTexParameter(target: number, pname: number) { return this.params.get(this.binding(target)!)?.get(pname) ?? 0; }
  texImage2D(target: number, level: number, internal: number, w: number, h: number, _border: number,
    _format: number, _type: number, data?: ArrayBufferView | null) {
    const v = data ? new Uint8Array(data.buffer, data.byteOffset, 1)[0] : 0;
    this.images.get(this.texFor(target))!.set(`${target}:${level}`, {v, w, h, f: internal});
  }
  texSubImage2D(target: number, level: number, _x: number, _y: number, _w: number, _h: number,
    _format: number, _type: number, data?: ArrayBufferView | null) {
    if (!data || !data.byteLength) return;
    this.images.get(this.texFor(target))!.get(`${target}:${level}`)!.v = new Uint8Array(data.buffer, data.byteOffset, 1)[0];
  }
  generateMipmap() {}
  renderbufferStorage(_target: number, f: number, w: number, h: number) { Object.assign(this.rbos.get(this.rbo!)!, {f, w, h, v: 0}); }
  getRenderbufferParameter(_target: number, p: number) {
    const r = this.rbos.get(this.rbo!)!;
    return p === 0x8d42 ? r.w : p === 0x8d43 ? r.h : p === 0x8d44 ? r.f : 0;
  }
  framebufferTexture2D(target: number, point: number, face: number, tex: object | null, level: number) {
    const frame = this.frames.get((target === 0x8ca8 ? this.read : this.draw)!)!;
    if (tex) frame.set(point, {tex, face, level}); else frame.delete(point);
  }
  framebufferRenderbuffer(target: number, point: number, _rt: number, rbo: object | null) {
    const frame = this.frames.get((target === 0x8ca8 ? this.read : this.draw)!)!;
    if (rbo) frame.set(point, {rbo}); else frame.delete(point);
  }
  checkFramebufferStatus(target: number) {
    const a = this.frames.get((target === 0x8ca8 ? this.read : this.draw)!)?.get(0x8ce0);
    // Luminance is not color-renderable.
    return a && this.attachmentImage(a) && this.attachmentImage(a)!.f !== 0x1909 ? 0x8cd5 : 0x8cd6;
  }
  attachmentImage(a: Attachment) {
    return "rbo" in a ? this.rbos.get(a.rbo) : this.images.get(a.tex)!.get(`${a.face}:${a.level}`);
  }
  copyTexSubImage2D(target: number, level: number) {
    const src = this.attachmentImage(this.frames.get(this.read!)!.get(0x8ce0)!)!;
    this.images.get(this.texFor(target))!.get(`${target}:${level}`)!.v = src.v;
  }
  blitFramebuffer() {
    if (this.scissor) throw new Error("blit with scissor enabled");
    this.blits++;
    const src = this.attachmentImage(this.frames.get(this.read!)!.get(0x8ce0)!)!;
    this.attachmentImage(this.frames.get(this.draw!)!.get(0x8ce0)!)!.v = src.v;
  }
  value(tex: object, face = 0x0de1, level = 0) { return this.images.get(tex)?.get(`${face}:${level}`)?.v; }
}

function setup() {
  const registry = new GlContextRegistry();
  registry.bind({pid: 1, sessionId: 2, cmdbufAddr: 0, cmdbufLen: 4096});
  const b = registry.get(1, 2)!, gl = new ValueGl();
  b.gl = gl as unknown as WebGL2RenderingContext; b.contextId = 3; b.cmdbufView = new Uint8Array(4096);
  return {registry, b, gl};
}
function query(b: GlBinding, op: number, words: number[], size = 12): number[] {
  const out = new Uint8Array(size);
  expect(runGlQuery(b, op, new Uint8Array(new Uint32Array(words).buffer), out)).toBe(size);
  return [...new Uint32Array(out.buffer)];
}
function submit(b: GlBinding, op: number, words: number[], data?: number[]) {
  const payload = new Uint8Array(words.length * 4 + (data?.length ?? 0));
  new DataView(payload.buffer).setUint32(0, 0);
  words.forEach((word, i) => new DataView(payload.buffer).setUint32(i * 4, word >>> 0, true));
  if (data) payload.set(data, words.length * 4);
  const view = new DataView(b.cmdbufView!.buffer);
  view.setUint16(0, op, true); view.setUint16(2, payload.length, true);
  b.cmdbufView!.set(payload, 4);
  expect(decodeAndDispatch(b, 0, payload.length + 4)).toBe(0);
}
const bind = (b: GlBinding, kind: number, target: number, name: number) =>
  expect(query(b, O.QOP_BIND_IMAGE_OBJECT, [kind, target, name])).toEqual([0, 1, 0x47514c33]);
/** 1x1 RGBA/UNSIGNED_BYTE image whose first byte is `value`. */
const image = (b: GlBinding, target: number, level: number, value: number, size = 1) =>
  submit(b, O.OP_TEX_IMAGE_2D, [target, level, 0x1908, size, size, 0, 0x1908, 0x1401, size * size * 4],
    Array.from({length: size * size * 4}, () => value));
const subImage = (b: GlBinding, target: number, level: number, value: number) =>
  submit(b, O.OP_TEX_SUB_IMAGE_2D, [target, level, 0, 0, 1, 1, 0x1908, 0x1401, 4], [value, value, value, value]);
const linear = (b: GlBinding, target = 0x0de1) => submit(b, O.OP_TEX_PARAMETERI, [target, 0x2801, 0x2601]);
function exported(b: GlBinding, registry: GlContextRegistry, bo: number, target: number, name: number, level = 0): GlImageExport {
  const result = exportImageStorage(b, bo, target, name, level);
  expect(typeof result).toBe("object");
  registry.publishExportedImage((result as GlImageExport).record);
  return result as GlImageExport;
}

it("exports a 2D level as aliased storage and keeps the source a sibling", () => {
  const {registry, b, gl} = setup();
  bind(b, 1, 0x0de1, 5); image(b, 0x0de1, 0, 10); linear(b);
  const source = b.textures.get(5)!;
  const result = exported(b, registry, 41, 0x0de1, 5);
  // The sized format of RGBA/UNSIGNED_BYTE (EGL derives the DRM format).
  expect([result.record.width, result.record.height, result.internalFormat]).toEqual([1, 1, 0x8058]);
  expect(result.revision).toBe(1);
  // The source reports its image token, so C keeps it as a sibling.
  expect(query(b, O.QOP_BOUND_IMAGE_STATE, [1, 0x0de1], 16)).toEqual([0, result.token, 1, 0x47514c33]);
  // A second image from the same object is EGL_BAD_ACCESS.
  expect(exportImageStorage(b, 42, 0x0de1, 5, 0)).toBe(-16);
  // A target sibling sees the source's later writes, and writes back.
  bind(b, 1, 0x0de1, 6);
  expect(query(b, O.QOP_BOUND_IMAGE_TARGET, [1, 0x0de1, result.token], 16)[0]).toBe(0);
  const sibling = b.textureViews.get(b.textures.get(6)!)!;
  bind(b, 1, 0x0de1, 5); subImage(b, 0x0de1, 0, 20);
  expect(gl.value(source)).toBe(20);
  bind(b, 1, 0x0de1, 6); expect(prepareImageDraw(b)).toBe(true);
  expect(gl.value(sibling.native)).toBe(20);
  subImage(b, 0x0de1, 0, 30);
  expect(gl.value(source)).toBe(30);
  expect(b.errors).toEqual([]);
});

it("orphans the image when the source is respecified, retaining its other levels", () => {
  const {registry, b, gl} = setup();
  bind(b, 1, 0x0de1, 5); image(b, 0x0de1, 0, 10, 2); image(b, 0x0de1, 1, 11);
  const canonical = b.textures.get(5)!;
  const result = exported(b, registry, 41, 0x0de1, 5);
  image(b, 0x0de1, 0, 50, 2);
  // The image keeps the old storage and contents.
  expect(gl.value(canonical)).toBe(10);
  expect(gl.deleted.has(canonical)).toBe(false);
  const fresh = b.textureViews.get(canonical)!.native;
  expect(fresh).not.toBe(canonical);
  expect([gl.value(fresh), gl.value(fresh, 0x0de1, 1)]).toEqual([50, 11]);
  // The source is no longer a sibling; its revision moved past the export.
  expect(query(b, O.QOP_BOUND_IMAGE_STATE, [1, 0x0de1], 16)).toEqual([0, 0, 2, 0x47514c33]);
  // Later source writes no longer reach the image.
  subImage(b, 0x0de1, 0, 60);
  expect(gl.value(canonical)).toBe(10);
  expect(registry.exportedImage(41)).toBe(result.record);
  expect(b.errors).toEqual([]);
});

it("keeps image storage past source deletion and frees it when the bo retires", () => {
  const {registry, b, gl} = setup();
  bind(b, 1, 0x0de1, 5); image(b, 0x0de1, 0, 10); linear(b);
  const canonical = b.textures.get(5)!;
  exported(b, registry, 41, 0x0de1, 5);
  bind(b, 1, 0x0de1, 0);
  submit(b, O.OP_DELETE_TEXTURES, [1, 5]);
  expect(b.textures.has(5)).toBe(false);
  expect(gl.deleted.has(canonical)).toBe(false);
  registry.retireForeignBo(41);
  expect(gl.deleted.has(canonical)).toBe(true);
  expect(registry.exportedImage(41)).toBeUndefined();
});

it("returns ownership to a live source when the bo retires first", () => {
  const {registry, b, gl} = setup();
  bind(b, 1, 0x0de1, 5); image(b, 0x0de1, 0, 10); linear(b);
  const canonical = b.textures.get(5)!;
  exported(b, registry, 41, 0x0de1, 5);
  registry.retireForeignBo(41);
  expect(gl.deleted.has(canonical)).toBe(false);
  // The object is an ordinary texture again: respecification is in place.
  image(b, 0x0de1, 0, 70);
  expect(b.textureViews.get(canonical)).toBeUndefined();
  expect(gl.value(canonical)).toBe(70);
  bind(b, 1, 0x0de1, 0);
  submit(b, O.OP_DELETE_TEXTURES, [1, 5]);
  expect(gl.deleted.has(canonical)).toBe(true);
});

it("reports the KHR_gl_texture_2D_image and cubemap creation errors", () => {
  const {b} = setup();
  expect(exportImageStorage(b, 41, 0x0de1, 9, 0)).toBe(-2);              // no object
  bind(b, 1, 0x0de1, 5);
  expect(exportImageStorage(b, 41, 0x0de1, 5, 0)).toBe(-22);             // level 0 unspecified
  image(b, 0x0de1, 0, 10, 2);
  // Default minification needs mipmaps, so this texture is incomplete.
  expect(exportImageStorage(b, 41, 0x0de1, 5, 1)).toBe(-22);
  linear(b);
  expect(exportImageStorage(b, 41, 0x0de1, 5, 1)).toBe(-34);             // not a mipmap level
  expect(exportImageStorage(b, 41, 0x0de1, 5, 32)).toBe(-34);
  expect(exportImageStorage(b, 41, 0x8515, 5, 0)).toBe(-22);             // 2D object, cube target
  bind(b, 1, 0x8513, 7);
  image(b, 0x8515, 0, 1);
  expect(exportImageStorage(b, 41, 0x0de1, 7, 0)).toBe(-22);             // cube object, 2D target
  // An incomplete cube map needs level 0 of every face.
  expect(exportImageStorage(b, 41, 0x8515, 7, 0)).toBe(-22);
  for (let face = 0x8516; face <= 0x851a; face++) image(b, face, 0, face & 0xff);
  expect(typeof exportImageStorage(b, 41, 0x8517, 7, 0)).toBe("object");
  bind(b, 2, 0x8d41, 8);
  expect(exportImageStorage(b, 42, 0x8d41, 8, 0)).toBe(-22);             // no storage
  // Not an image sibling yet: nothing was published by the failures.
  expect(b.imageSources.size).toBe(1);
});

it("writes a 2D sibling through to a cube-face image", () => {
  const {registry, b, gl} = setup();
  bind(b, 1, 0x8513, 7);
  for (let face = 0x8515; face <= 0x851a; face++) image(b, face, 0, 1);
  linear(b, 0x8513);
  const cube = b.textures.get(7)!;
  const result = exported(b, registry, 41, 0x8517, 7);
  bind(b, 1, 0x0de1, 6);
  expect(query(b, O.QOP_BOUND_IMAGE_TARGET, [1, 0x0de1, result.token], 16)[0]).toBe(0);
  gl.scissor = true;
  subImage(b, 0x0de1, 0, 44);
  expect(gl.value(cube, 0x8517)).toBe(44);
  expect([gl.value(cube, 0x8515), gl.scissor, gl.blits]).toEqual([1, true, 1]);
  // Respecifying another face still orphans: the image keeps its face.
  bind(b, 1, 0x8513, 7);
  image(b, 0x8515, 0, 9);
  const fresh = b.textureViews.get(cube)!.native;
  expect([gl.value(fresh, 0x8515), gl.value(fresh, 0x8517), gl.value(cube, 0x8517)]).toEqual([9, 44, 44]);
  expect(query(b, O.QOP_BOUND_IMAGE_STATE, [1, 0x8513], 16)[1]).toBe(0);
  expect(b.errors).toEqual([]);
});

// OpenGL ES 3.0 table 3.2 / EXT_texture_storage: an exported image reports
// its sized internal format, which EGL maps to the DRM format a
// gbm_bo_import(GBM_BO_IMPORT_EGL_IMAGE) bo reports.
it.each([
  [0x1907, 0x1401, 3, 0x8051],   // RGB/UNSIGNED_BYTE: RGB8
  [0x1907, 0x8363, 2, 0x8d62],   // RGB/UNSIGNED_SHORT_5_6_5: RGB565
  [0x1908, 0x8033, 2, 0x8056],   // RGBA/UNSIGNED_SHORT_4_4_4_4: RGBA4
  [0x1908, 0x8034, 2, 0x8057],   // RGBA/UNSIGNED_SHORT_5_5_5_1: RGB5_A1
  [0x190a, 0x1401, 2, 0x8045],   // LUMINANCE_ALPHA: LUMINANCE8_ALPHA8
  [0x1909, 0x1401, 1, 0x8040],   // LUMINANCE: LUMINANCE8
  [0x1906, 0x1401, 1, 0x803c],   // ALPHA: ALPHA8
])("exports a %s/%s texture image with its sized internal format", (format, type, bytes, sized) => {
  const {registry, b} = setup();
  bind(b, 1, 0x0de1, 5);
  submit(b, O.OP_TEX_IMAGE_2D, [0x0de1, 0, format, 1, 1, 0, format, type, bytes], Array(bytes).fill(1));
  linear(b);
  expect(exported(b, registry, 41, 0x0de1, 5).internalFormat).toBe(sized);
  expect(b.errors).toEqual([]);
});
it("exports a renderbuffer with the format the guest specified", () => {
  const {registry, b} = setup();
  bind(b, 2, 0x8d41, 8);
  submit(b, O.OP_RENDERBUFFER_STORAGE, [0x8d41, 0x8d62, 4, 2]);   // RGB565
  expect(exported(b, registry, 41, 0x8d41, 8).internalFormat).toBe(0x8d62);
  expect(b.errors).toEqual([]);
});
it("exports renderbuffers of any format and orphans them on new storage", () => {
  const {registry, b, gl} = setup();
  bind(b, 2, 0x8d41, 8);
  submit(b, O.OP_RENDERBUFFER_STORAGE, [0x8d41, 0x8d48, 4, 2]);   // STENCIL_INDEX8
  const canonical = b.rbos.get(8)!;
  const result = exported(b, registry, 41, 0x8d41, 8);
  expect([result.record.width, result.record.height, result.internalFormat]).toEqual([4, 2, 0x8d48]);
  // A renderbuffer sibling attaches the exported renderbuffer itself.
  bind(b, 2, 0x8d41, 9);
  expect(query(b, O.QOP_BOUND_IMAGE_TARGET, [2, 0x8d41, result.token], 16)[0]).toBe(0);
  expect(b.renderbufferViews.get(b.rbos.get(9)!)!.source!.renderbuffer).toBe(canonical);
  expect(query(b, O.QOP_GET_RENDERBUFFER_PARAMETER, [0x8d41, 0x8d44], 12)[1]).toBe(0x8d48);
  bind(b, 2, 0x8d41, 8);
  submit(b, O.OP_RENDERBUFFER_STORAGE, [0x8d41, 0x8056, 4, 2]);
  const fresh = b.renderbufferViews.get(canonical)!.native;
  expect(fresh).not.toBe(canonical);
  expect([gl.rbos.get(canonical)!.f, gl.rbos.get(fresh)!.f, gl.deleted.has(canonical)]).toEqual([0x8d48, 0x8056, false]);
  expect(b.errors).toEqual([]);
});

it("refuses to orphan a source whose retained image cannot be copied", () => {
  const {registry, b, gl} = setup();
  bind(b, 1, 0x0de1, 5);
  submit(b, O.OP_TEX_IMAGE_2D, [0x0de1, 0, 0x1909, 1, 1, 0, 0x1909, 0x1401, 1], [12]);
  image(b, 0x0de1, 1, 13);
  const canonical = b.textures.get(5)!;
  // Creation succeeds: the image is the luminance storage itself.
  exported(b, registry, 41, 0x0de1, 5);
  // Respecifying level 1 must retain level 0, which is not color-renderable.
  image(b, 0x0de1, 1, 14);
  expect(b.errors).toEqual([0x505]);
  expect(gl.value(canonical, 0x0de1, 1)).toBe(13);
  expect(b.textureViews.get(canonical)).toBeUndefined();
});
