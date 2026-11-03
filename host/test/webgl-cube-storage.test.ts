import { describe, expect, it } from "vitest";
import { GlContextRegistry, type GlBinding } from "../src/webgl/registry.js";
import { runGlQuery } from "../src/webgl/query.js";
import { decodeAndDispatch } from "../src/webgl/bridge.js";
import { cubeExtraTextures, cubeImageTexture, cubeSamplingTexture } from "../src/webgl/cube-storage.js";
import { externalDrawUnits, guestUniformType, recordLinkedExternalSamplers } from "../src/webgl/external-texture.js";
import { recordShaderLanguage, shaderSamplesCube } from "../src/webgl/essl3-translation.js";
import { collectRetiredImages } from "../src/webgl/image-references.js";
import * as O from "../src/webgl/ops.js";

/* ES 2.0 cube maps stored as six-layer 2D array textures (cube-storage.ts).
 * A small renderer model keeps one value per array layer and level, the
 * texture parameters, unit bindings and framebuffer attachments, so the
 * tests observe where each face image lives and what a draw samples. */
const ARRAY = 0x8c1a, CUBE = 0x8513, PX = 0x8515, LUMINANCE = 0x1909;
type Level = { size: number; depth: number; format: number; layers: number[] };
type Attachment = { tex: object; level: number; layer?: number; target?: number };
class ArrayGl {
  errors: number[] = [];
  textures = new Map<object, { levels: Map<number, Level>; params: Map<number, number> }>();
  frames = new Map<object, Map<number, Attachment>>();
  units = new Map<number, Map<number, object | null>>();
  deleted = new Set<object>();
  calls: string[] = [];
  active = 0; draw: object | null = null; read: object | null = null;
  getError() { return this.errors.shift() ?? 0; }
  getParameter(p: number): unknown {
    if (p === 0x84e0) return 0x84c0 + this.active;
    if (p === 0x8069) return this.binding(0x0de1);
    if (p === 0x8c1d) return this.binding(ARRAY);
    if (p === 0x8ca6) return this.draw;
    if (p === 0x8caa) return this.read;
    if (p === 0x8ca7) return null;
    if (p === 0x0d33) return 64;   // MAX_TEXTURE_SIZE: the array layer limit
    if (p === 0x851c) return 128;  // MAX_CUBE_MAP_TEXTURE_SIZE (native)
    if (p === 0x8b4d || p === 0x8872) return 16;
    if (p === 0x86a3) return new Uint32Array(0);
    if (p === 0x88ef) return null;
    return null;
  }
  binding(target: number) { return this.units.get(this.active)?.get(target) ?? null; }
  createTexture() { const t = {}; this.textures.set(t, { levels: new Map(), params: new Map([[0x2801, 0x2702]]) }); return t; }
  createFramebuffer() { const f = {}; this.frames.set(f, new Map()); return f; }
  deleteTexture(t: object | null) { if (t) this.deleted.add(t); }
  deleteFramebuffer(f: object | null) { if (f) this.deleted.add(f); }
  activeTexture(unit: number) { this.active = unit - 0x84c0; }
  bindTexture(target: number, t: object | null) {
    let unit = this.units.get(this.active); if (!unit) this.units.set(this.active, unit = new Map());
    unit.set(target, t);
  }
  bindFramebuffer(target: number, f: object | null) {
    if (target !== 0x8ca8) this.draw = f;
    if (target !== 0x8ca9) this.read = f;
  }
  private array(target: number) { return this.textures.get(this.binding(target)!)!; }
  texImage3D(target: number, level: number, internal: number, w: number, _h: number, depth: number) {
    this.calls.push(`texImage3D ${level} ${w}`);
    const levels = this.array(target).levels;
    if (w === 0) levels.delete(level);
    else levels.set(level, { size: w, depth, format: internal, layers: new Array(depth).fill(0) });
  }
  texSubImage3D(target: number, level: number, _x: number, _y: number, z: number, _w: number, _h: number, _d: number,
    _format: number, _type: number, data?: ArrayBufferView | null) {
    const at = this.array(target).levels.get(level);
    if (!at) { this.errors.push(0x502); return; }
    if (data?.byteLength) at.layers[z] = new Uint8Array(data.buffer, data.byteOffset, 1)[0];
  }
  copyTexSubImage3D(target: number, level: number, _x: number, _y: number, z: number) {
    this.calls.push(`copyTexSubImage3D ${level} ${z}`);
    const source = this.attached(this.frames.get(this.read!)?.get(0x8ce0));
    const at = this.array(target).levels.get(level);
    if (!source || !at) { this.errors.push(0x502); return; }
    at.layers[z] = source.value;
  }
  generateMipmap(target: number) {
    const levels = this.array(target).levels, base = levels.get(0)!;
    for (let level = 1, size = base.size; size > 1; level++) {
      size >>= 1;
      levels.set(level, { size, depth: base.depth, format: base.format, layers: [...base.layers] });
    }
  }
  texParameteri(target: number, pname: number, value: number) { this.array(target).params.set(pname, value); }
  getTexParameter(target: number, pname: number) { return this.array(target).params.get(pname) ?? 0; }
  framebufferTextureLayer(target: number, point: number, tex: object | null, level: number, layer: number) {
    const frame = this.frames.get((target === 0x8ca8 ? this.read : this.draw)!)!;
    if (tex) frame.set(point, { tex, level, layer }); else frame.delete(point);
  }
  framebufferTexture2D(target: number, point: number, face: number, tex: object | null, level: number) {
    const frame = this.frames.get((target === 0x8ca8 ? this.read : this.draw)!)!;
    if (tex) frame.set(point, { tex, level, target: face }); else frame.delete(point);
  }
  framebufferRenderbuffer(target: number, point: number) { this.frames.get((target === 0x8ca8 ? this.read : this.draw)!)!.delete(point); }
  attached(a: Attachment | undefined) {
    if (!a || a.layer === undefined) return undefined;
    const level = this.textures.get(a.tex)?.levels.get(a.level);
    return level && a.layer < level.depth ? { value: level.layers[a.layer], format: level.format } : undefined;
  }
  checkFramebufferStatus(target: number) {
    // Luminance is not color-renderable.
    const a = this.attached(this.frames.get((target === 0x8ca8 ? this.read : this.draw)!)?.get(0x8ce0));
    return a && a.format !== LUMINANCE ? 0x8cd5 : 0x8cd6;
  }
  layer(tex: object, face: number, level = 0) { return this.textures.get(tex)?.levels.get(level)?.layers[face - PX]; }
}

function setup() {
  const registry = new GlContextRegistry();
  registry.bind({ pid: 1, sessionId: 2, cmdbufAddr: 0, cmdbufLen: 4096 });
  const b = registry.get(1, 2)!, gl = new ArrayGl();
  b.gl = gl as unknown as WebGL2RenderingContext; b.contextId = 3; b.cmdbufView = new Uint8Array(4096);
  return { b, gl };
}
function query(b: GlBinding, op: number, words: number[], size = 12): number[] {
  const out = new Uint8Array(size);
  expect(runGlQuery(b, op, new Uint8Array(new Uint32Array(words).buffer), out)).toBe(size);
  return [...new Uint32Array(out.buffer)];
}
function submit(b: GlBinding, op: number, words: number[], data?: number[]) {
  const payload = new Uint8Array(words.length * 4 + (data?.length ?? 0));
  words.forEach((word, i) => new DataView(payload.buffer).setUint32(i * 4, word >>> 0, true));
  if (data) payload.set(data, words.length * 4);
  const view = new DataView(b.cmdbufView!.buffer);
  view.setUint16(0, op, true); view.setUint16(2, payload.length, true);
  b.cmdbufView!.set(payload, 4);
  expect(decodeAndDispatch(b, 0, payload.length + 4)).toBe(0);
}
const bind = (b: GlBinding, target: number, name: number) =>
  expect(query(b, O.QOP_BIND_IMAGE_OBJECT, [1, target, name])).toEqual([0, 1, 0x47514c33]);
/** A size x size face image (RGBA/UNSIGNED_BYTE, or LUMINANCE) whose first byte is `value`. */
const image = (b: GlBinding, face: number, level: number, value: number, size = 1, format = 0x1908) => {
  // Rows padded to the default UNPACK_ALIGNMENT of 4, as WebGL reads them.
  const row = size * (format === LUMINANCE ? 1 : 4), bytes = size ? (size - 1) * Math.ceil(row / 4) * 4 + row : 0;
  submit(b, O.OP_TEX_IMAGE_2D, [face, level, format, size, size, 0, format, 0x1401, bytes], Array.from({ length: bytes }, () => value));
};
const faces = (b: GlBinding, level: number, value: (face: number) => number, size = 1, format = 0x1908) => {
  for (let face = PX; face <= PX + 5; face++) image(b, face, level, value(face), size, format);
};
const parameter = (b: GlBinding, pname: number, value: number) => submit(b, O.OP_TEX_PARAMETERI, [CUBE, pname, value]);
const status = (b: GlBinding) => query(b, O.QOP_CHECK_FB_STATUS, [0x8d40], 4)[0];
const integer = (b: GlBinding, pname: number) => query(b, O.QOP_GET_INTEGERV, [pname], 4)[0];

describe("cube maps as six-layer 2D arrays", () => {
  it("stores the faces as layers of the cube's own array and samples it only when complete", () => {
    const { b, gl } = setup();
    bind(b, CUBE, 7);
    const cube = b.textures.get(7)!;
    // The first cube bind made the object a native 2D array texture.
    expect(gl.units.get(0)?.get(ARRAY)).toBe(cube);
    parameter(b, 0x2801, 0x2601);
    for (let face = PX; face < PX + 5; face++) image(b, face, 0, face & 0xff, 4);
    // Five faces: the array has all six layers, but ES 2.0 calls the cube incomplete.
    expect(cubeSamplingTexture(cube)).toBeNull();
    image(b, PX + 5, 0, 0x1a, 4);
    expect(cubeSamplingTexture(cube)).toBe(cube);
    for (let face = PX; face <= PX + 5; face++) {
      expect(cubeImageTexture(cube, face, 0)).toBe(cube);
      expect(gl.layer(cube, face)).toBe(face & 0xff);
    }
    // Only the first face allocated the level.
    expect(gl.calls.filter(call => call.startsWith("texImage3D"))).toEqual(["texImage3D 0 4"]);
    // A mipmapped minification filter needs every level of every face.
    parameter(b, 0x2801, 0x2700);
    expect(cubeSamplingTexture(cube)).toBeNull();
    for (let level = 1, size = 2; size >= 1; level++, size >>= 1) faces(b, level, () => level, size);
    expect(cubeSamplingTexture(cube)).toBe(cube);
    expect(b.errors).toEqual([]);
  });

  it("refuses a non-square or oversized face image with INVALID_VALUE before any storage", () => {
    const { b, gl } = setup();
    bind(b, CUBE, 7);
    // Each call records INVALID_VALUE (one sticky flag per code, so clear between).
    for (const [level, width, height] of [[0, 2, 1], [0, 128, 128], [1, 64, 64]]) {
      submit(b, O.OP_TEX_IMAGE_2D, [PX, level, 0x1908, width, height, 0, 0x1908, 0x1401, 0]);
      expect(b.errors.splice(0)).toEqual([0x501]);
    }
    // The advertised cube limit is the array layer limit (64), not the native cube limit (128).
    expect(gl.calls).toEqual([]);
    expect(integer(b, 0x851c)).toBe(64);
  });

  it("keeps a face respecified to another size apart without losing its siblings, then gathers them", () => {
    const { b, gl } = setup();
    bind(b, CUBE, 7);
    const cube = b.textures.get(7)!;
    parameter(b, 0x2801, 0x2601);
    faces(b, 0, face => face & 0xff, 4);
    // Attach -Y, whose image moves later.
    submit(b, O.OP_BIND_FRAMEBUFFER, [0x8d40, 3]);
    submit(b, O.OP_FRAMEBUFFER_TEXTURE_2D, [0x8d40, 0x8ce0, PX + 3, 7, 0]);
    const framebuffer = b.fbos.get(3)!;
    expect(gl.frames.get(framebuffer)!.get(0x8ce0)).toEqual({ tex: cube, level: 0, layer: 3 });
    image(b, PX, 0, 90, 2);
    const second = cubeImageTexture(cube, PX, 0)!;
    expect(second).not.toBe(cube);
    expect(gl.layer(second, PX)).toBe(90);
    // The siblings keep their 4x4 images; the cube is incomplete (faces differ).
    for (let face = PX + 1; face <= PX + 5; face++) expect(gl.layer(cube, face)).toBe(face & 0xff);
    expect(cubeSamplingTexture(cube)).toBeNull();
    // Respecifying the rest at the new size gathers them with +X, with no copy.
    for (let face = PX + 1; face <= PX + 5; face++) image(b, face, 0, face - PX, 2);
    for (let face = PX; face <= PX + 5; face++) expect(cubeImageTexture(cube, face, 0)).toBe(second);
    expect(cubeSamplingTexture(cube)).toBe(second);
    expect(gl.calls.some(call => call.startsWith("copyTexSubImage3D"))).toBe(false);
    // The attachment followed -Y; the cube's own array released its level.
    expect(gl.frames.get(framebuffer)!.get(0x8ce0)).toEqual({ tex: second, level: 0, layer: 3 });
    expect(gl.textures.get(cube)!.levels.size).toBe(0);
    expect(cubeExtraTextures(cube)).toEqual([second]);
    expect(b.errors).toEqual([]);
  });

  it("copies spread images together when they become a complete cube, and refuses an unattachable format", () => {
    for (const format of [0x1908, LUMINANCE]) {
      const { b, gl } = setup();
      bind(b, CUBE, 7);
      const cube = b.textures.get(7)!;
      parameter(b, 0x2801, 0x2701);
      // Level 1 is 2x2, which fits a 4x4 base, but the base is 2x2 now.
      faces(b, 0, () => 1, 2, format);
      faces(b, 1, face => 40 + face - PX, 2, format);
      // A 4x4 base goes elsewhere (its level-0 siblings are 2x2), then makes level 1 consistent.
      faces(b, 0, () => 2, 4, format);
      const base = cubeImageTexture(cube, PX, 0)!;
      expect(base).not.toBe(cube);
      if (format === LUMINANCE) {
        // Copies need a framebuffer; luminance cannot be attached.
        expect(b.errors).toContain(0x505);
        expect(cubeSamplingTexture(cube)).toBeNull();
        continue;
      }
      expect(gl.calls.filter(call => call.startsWith("copyTexSubImage3D"))).toHaveLength(6);
      for (let face = PX; face <= PX + 5; face++) {
        expect(cubeImageTexture(cube, face, 1)).toBe(base);
        expect(gl.layer(base, face, 1)).toBe(40 + face - PX);
      }
      // Level 2 completes the chain.
      faces(b, 2, () => 3, 1);
      expect(cubeSamplingTexture(cube)).toBe(base);
      expect(b.errors).toEqual([]);
    }
  });

  it("GenerateMipmap derives every level in the base images' array and needs a cube-complete base", () => {
    const { b, gl } = setup();
    bind(b, CUBE, 7);
    const cube = b.textures.get(7)!;
    for (let face = PX; face < PX + 5; face++) image(b, face, 0, 5, 4);
    submit(b, O.OP_GENERATE_MIPMAP, [CUBE]);
    expect(b.errors).toEqual([0x502]);
    image(b, PX + 5, 0, 5, 4);
    submit(b, O.OP_GENERATE_MIPMAP, [CUBE]);
    expect(b.errors).toEqual([0x502]);
    expect([...gl.textures.get(cube)!.levels.keys()]).toEqual([0, 1, 2]);
    for (let face = PX; face <= PX + 5; face++) expect(cubeImageTexture(cube, face, 2)).toBe(cube);
    expect(cubeSamplingTexture(cube)).toBe(cube);
  });

  it("reports an attached face that was never specified as an incomplete attachment", () => {
    const { b } = setup();
    bind(b, CUBE, 7);
    image(b, PX, 0, 1, 2);
    submit(b, O.OP_BIND_FRAMEBUFFER, [0x8d40, 3]);
    submit(b, O.OP_FRAMEBUFFER_TEXTURE_2D, [0x8d40, 0x8ce0, PX + 2, 7, 0]);
    // The array allocated all six layers, so the native attachment is complete.
    expect(status(b)).toBe(0x8cd6);
    image(b, PX + 2, 0, 1, 2);
    expect(status(b)).toBe(0x8cd5);
  });

  it("updates only specified faces (ES 2.0 section 3.7.2)", () => {
    const { b, gl } = setup();
    bind(b, CUBE, 7);
    const cube = b.textures.get(7)!;
    image(b, PX, 0, 1, 2);
    submit(b, O.OP_TEX_SUB_IMAGE_2D, [PX + 1, 0, 0, 0, 1, 1, 0x1908, 0x1401, 4], [9, 9, 9, 9]);
    submit(b, O.OP_TEX_SUB_IMAGE_2D, [PX, 0, -1, 0, 1, 1, 0x1908, 0x1401, 4], [9, 9, 9, 9]);
    expect(b.errors).toEqual([0x502, 0x501]);
    submit(b, O.OP_TEX_SUB_IMAGE_2D, [PX, 0, 0, 0, 1, 1, 0x1908, 0x1401, 4], [9, 9, 9, 9]);
    expect(gl.layer(cube, PX)).toBe(9);
  });

  it("sets parameters on every array of a cube and answers queries for the cube", () => {
    const { b, gl } = setup();
    bind(b, CUBE, 7);
    const cube = b.textures.get(7)!;
    faces(b, 0, () => 1, 2);
    image(b, PX, 0, 2, 4);
    const second = cubeImageTexture(cube, PX, 0)!;
    parameter(b, 0x2802, 0x812f);
    expect(gl.textures.get(cube)!.params.get(0x2802)).toBe(0x812f);
    expect(gl.textures.get(second)!.params.get(0x2802)).toBe(0x812f);
    expect(query(b, O.QOP_GET_TEX_PARAMETER, [CUBE, 0x2802], 12)[1]).toBe(0x812f);
    expect(integer(b, 0x8514)).toBe(7);
    // Deleting the cube retires its arrays.
    submit(b, O.OP_DELETE_TEXTURES, [1, 7]);
    collectRetiredImages(b);
    expect(gl.deleted.has(cube) && gl.deleted.has(second)).toBe(true);
  });
});

describe("programs that sample cube maps", () => {
  const SAMPLER_2D_ARRAY = 0x8dc1, SAMPLER_CUBE = 0x8b60;
  function cubeProgram(b: GlBinding, gl: ArrayGl, unit: number) {
    const shader = {} as WebGLShader, program = {} as WebGLProgram;
    recordShaderLanguage(shader, "essl300", "precision mediump float;\nuniform samplerCube s;\nvoid main() { gl_FragColor = textureCube(s, vec3(1.0)); }\n", true);
    expect(shaderSamplesCube(shader)).toBe(true);
    recordLinkedExternalSamplers(program, true, [shader]);
    Object.assign(gl, {
      getProgramParameter: () => 1,
      getActiveUniform: () => ({ name: "s", type: SAMPLER_2D_ARRAY, size: 1 }),
      getUniformLocation: () => ({}),
      getUniform: () => unit,
    });
    b.programs.set(4, program); b.shadow.currentProgram = b.currentProgram = program; b.currentProgramId = 4;
    return program;
  }

  it("reflect the translation's sampler2DArray uniforms as SAMPLER_CUBE", () => {
    const { b, gl } = setup();
    const program = cubeProgram(b, gl, 0);
    expect(guestUniformType(program, "s", SAMPLER_2D_ARRAY)).toBe(SAMPLER_CUBE);
    // A program that samples no cube map is unchanged (and has no record).
    const other = {} as WebGLProgram;
    recordLinkedExternalSamplers(other, true, [{} as WebGLShader]);
    expect(guestUniformType(other, "s", SAMPLER_2D_ARRAY)).toBe(SAMPLER_2D_ARRAY);
  });

  it("bind a cube's sampled array for a draw only when it differs from the unit's guest binding", () => {
    const { b, gl } = setup();
    bind(b, CUBE, 7);
    const cube = b.textures.get(7)!;
    parameter(b, 0x2801, 0x2601);
    cubeProgram(b, gl, 0);
    // Incomplete: the draw samples no texture, then restores the guest binding.
    expect(externalDrawUnits(b)).toEqual([{ unit: 0, target: ARRAY, native: null, guest: cube }]);
    faces(b, 0, () => 1, 2);
    // Complete in its own array: nothing to bind.
    expect(externalDrawUnits(b)).toEqual([]);
    // A program without external or cube samplers pays no unit work.
    const plain = {} as WebGLProgram;
    b.shadow.currentProgram = b.currentProgram = plain;
    expect(externalDrawUnits(b)).toEqual([]);
  });
});
