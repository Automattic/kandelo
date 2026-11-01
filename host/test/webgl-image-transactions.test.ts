import { expect, it, vi } from "vitest";
import { GlContextRegistry } from "../src/webgl/registry.js";
import { runGlQuery } from "../src/webgl/query.js";
import { decodeAndDispatch } from "../src/webgl/bridge.js";
import * as O from "../src/webgl/ops.js";
const TEX = 0x0de1, RBO = 0x8d41, FBO = 0x8d40, DRAW = 0x8ca9, READ = 0x8ca8, COLOR = 0x8ce0;
class ImageTransactionsGl {
  errors: number[] = [];
  calls: string[] = [];
  active = 0;
  textures = new Map<number, object | null>();
  renderbuffer: object | null = null;
  draw: object | null = null;
  read: object | null = null;
  attachments = new Map<object, Map<number, object>>();
  reject: string | undefined;
  deleted: object[] = [];
  getError() { return this.errors.shift() ?? 0; }
  before(name: string) {
    this.calls.push(name);
    if (this.reject === name) {
      this.reject = undefined;
      this.errors.push(0x505);
      return false;
    }
    return true;
  }
  activeTexture(value: number) {
    if (this.before("active"))
      this.active = value - 0x84c0;
  }
  bindTexture(_target: number, value: object | null) {
    if (this.before("texture"))
      this.textures.set(this.active, value);
  }
  bindRenderbuffer(_target: number, value: object | null) {
    if (this.before("renderbuffer"))
      this.renderbuffer = value;
  }
  bindFramebuffer(target: number, value: object | null) {
    if (!this.before("framebuffer"))
      return;
    if (target !== READ)
      this.draw = value;
    if (target !== DRAW)
      this.read = value;
  }
  framebufferTexture2D(target: number, point: number, _imageTarget: number, value: object | null, _level: number) { this.attach("attach-texture", target, point, value); }
  framebufferRenderbuffer(target: number, point: number, _imageTarget: number, value: object | null) { this.attach("attach-renderbuffer", target, point, value); }
  attach(method: string, target: number, point: number, value: object | null) {
    if (!this.before(method))
      return;
    const framebuffer = (target === READ ? this.read : this.draw)!;
    let points = this.attachments.get(framebuffer);
    if (!points) {
      points = new Map();
      this.attachments.set(framebuffer, points);
    }
    if (value)
      points.set(point, value);
    else
      points.delete(point);
  }
  createFramebuffer() { return this.before("create-framebuffer") ? {} : null; }
  deleteFramebuffer(value: object) {
    if (this.before("delete-framebuffer"))
      this.deleted.push(value);
  }
  deleteTexture(value: object) {
    if (this.before("delete-texture"))
      this.deleted.push(value);
  }
  deleteRenderbuffer(value: object) {
    if (this.before("delete-renderbuffer"))
      this.deleted.push(value);
  }
}
function setup(kind = 1) {
  const registry = new GlContextRegistry();
  registry.bind({ pid: 1, cmdbufAddr: 0, cmdbufLen: 64 });
  const b = registry.get(1)!, gl = new ImageTransactionsGl(), old = {}, fresh = {}, framebuffer = {};
  b.gl = gl as unknown as WebGL2RenderingContext;
  b.cmdbufView = new Uint8Array(64);
  b.fbos.set(71, framebuffer);
  b.shadow.fbo = b.shadow.readFbo = framebuffer;
  gl.draw = gl.read = framebuffer;
  if (kind === 1) {
    b.textures.set(17, old);
    b.textures.set(18, fresh);
    b.shadow.textureUnits[0] = old;
    gl.textures.set(0, old);
  }
  else {
    b.rbos.set(17, old);
    b.rbos.set(18, fresh);
    b.shadow.renderbuffer = old;
    gl.renderbuffer = old;
  }
  b.framebufferAttachments.set(framebuffer, new Map([[COLOR, kind === 1 ? { kind: "texture", object: old, target: TEX, level: 0 } : { kind: "renderbuffer", object: old }]]));
  gl.attachments.set(framebuffer, new Map([[COLOR, old]]));
  const query = (op: number, words: number[]) => {
    const out = new Uint8Array(12);
    expect(runGlQuery(b, op, new Uint8Array(new Uint32Array(words).buffer), out)).toBe(12);
    const values = [...new Uint32Array(out.buffer)];
    expect(values[2]).toBe(0x47514c33);
    return values.slice(0, 2);
  };
  const queued = (op: number, words: number[]) => {
    const view = new DataView(b.cmdbufView!.buffer);
    view.setUint16(0, op, true);
    view.setUint16(2, words.length * 4, true);
    words.forEach((word, i) => view.setUint32(4 + i * 4, word, true));
    expect(decodeAndDispatch(b, 0, 4 + words.length * 4)).toBe(0);
  };
  return { registry, b, gl, old, fresh, framebuffer, query, queued };
}
it("validates complete image attachment/deletion request and reply spans before native effects", () => {
  const { b, gl, query } = setup();
  for (const [op, size] of [[O.QOP_IMAGE_OBJECT_DELETE, 8], [O.QOP_IMAGE_ATTACHMENT, 24]]) {
    for (const [inputLength, replyLength] of [[size - 4, 12], [size + 4, 12], [size, 8], [size, op === O.QOP_IMAGE_ATTACHMENT ? 20 : 16]]) {
      const out = new Uint8Array(replyLength).fill(0xa5);
      expect(runGlQuery(b, op, new Uint8Array(inputLength), out)).toBe(-22);
      expect([...out]).toEqual(Array(replyLength).fill(0xa5));
    }
  }
  expect(gl.calls).toEqual([]);
  expect(query(O.QOP_IMAGE_OBJECT_DELETE, [99, 17])).toEqual([1, 0]);
  expect(query(O.QOP_IMAGE_ATTACHMENT, [99, FBO, COLOR, TEX, 17, 0])).toEqual([1, 0]);
  expect(gl.calls).toEqual([]);
});
for (const kind of [1, 2]) {
  it(`preserves attachment identity on native and metadata rejection before accepted replacement (kind ${kind})`, () => {
    const { b, gl, old, fresh, framebuffer, query } = setup(kind), target = kind === 1 ? TEX : RBO;
    const points = b.framebufferAttachments.get(framebuffer)!;
    gl.reject = kind === 1 ? "attach-texture" : "attach-renderbuffer";
    expect(query(O.QOP_IMAGE_ATTACHMENT, [kind, FBO, COLOR, target, 18, 0])).toEqual([1, 0]);
    expect(b.framebufferAttachments.get(framebuffer)).toBe(points);
    expect(points.get(COLOR)!.object).toBe(old);
    expect(gl.attachments.get(framebuffer)!.get(COLOR)).toBe(old);
    const iterator = b.framebufferAttachments[Symbol.iterator];
    b.framebufferAttachments[Symbol.iterator] = () => { throw new RangeError("metadata allocation failed"); };
    const before = gl.calls.length;
    try {
      expect(query(O.QOP_IMAGE_ATTACHMENT, [kind, FBO, COLOR, target, 18, 0])).toEqual([1, 0]);
    }
    finally {
      b.framebufferAttachments[Symbol.iterator] = iterator;
    }
    expect(gl.calls).toHaveLength(before);
    expect(query(O.QOP_IMAGE_ATTACHMENT, [kind, FBO, COLOR, target, 18, 0])).toEqual([0, 1]);
    expect(b.framebufferAttachments.get(framebuffer)!.get(COLOR)!.object).toBe(fresh);
    expect(gl.attachments.get(framebuffer)!.get(COLOR)).toBe(fresh);
    expect(query(O.QOP_IMAGE_ATTACHMENT, [kind, FBO, COLOR, target, 0, 0])).toEqual([0, 1]);
    expect(b.framebufferAttachments.has(framebuffer)).toBe(false);
  });
  it(`rolls back detached containers and native bindings after failed deletion (kind ${kind})`, () => {
    const { b, gl, old, framebuffer, query } = setup(kind);
    gl.reject = kind === 1 ? "texture" : "renderbuffer";
    b.errors.push(0x501);
    expect(query(O.QOP_IMAGE_OBJECT_DELETE, [kind, 17])).toEqual([1, 0]);
    expect((kind === 1 ? b.textures : b.rbos).get(17)).toBe(old);
    expect(kind === 1 ? b.shadow.textureUnits[0] : b.shadow.renderbuffer).toBe(old);
    expect(kind === 1 ? gl.textures.get(0) : gl.renderbuffer).toBe(old);
    expect(gl.attachments.get(framebuffer)!.get(COLOR)).toBe(old);
    expect(b.framebufferAttachments.get(framebuffer)!.get(COLOR)!.object).toBe(old);
    expect(kind === 1 ? b.retiredTextures.size : b.retiredRenderbuffers.size).toBe(0);
    expect(b.errors).toEqual([0x501, 0x505]);
    expect(query(O.QOP_IMAGE_OBJECT_DELETE, [kind, 17])).toEqual([0, 1]);
    expect((kind === 1 ? b.textures : b.rbos).has(17)).toBe(false);
    expect(gl.deleted).toEqual([old]);
  });
  it(`reserves retired metadata before native deletion effects (kind ${kind})`, () => {
    const { b, gl, old, query } = setup(kind), retired = kind === 1 ? b.retiredTextures : b.retiredRenderbuffers;
    const set = retired.set;
    retired.set = () => { throw new RangeError("retired allocation failed"); };
    try {
      expect(query(O.QOP_IMAGE_OBJECT_DELETE, [kind, 17])).toEqual([1, 0]);
    }
    finally {
      retired.set = set;
    }
    expect(gl.calls).toEqual([]);
    expect((kind === 1 ? b.textures : b.rbos).get(17)).toBe(old);
    expect(b.errors).toEqual([0x505]);
  });
  for (const route of ["queued", "checked"]) {
    it(`uses the same accepted attachment/delete ownership through ${route} dispatch (kind ${kind})`, () => {
      const { b, gl, fresh, framebuffer, query, queued } = setup(kind), target = kind === 1 ? TEX : RBO;
      if (route === "checked")
        expect(query(O.QOP_IMAGE_ATTACHMENT, [kind, FBO, COLOR, target, 18, 0])).toEqual([0, 1]);
      else
        queued(kind === 1 ? O.OP_FRAMEBUFFER_TEXTURE_2D : O.OP_FRAMEBUFFER_RENDERBUFFER, [FBO, COLOR, target, 18, ...(kind === 1 ? [0] : [])]);
      expect(b.framebufferAttachments.get(framebuffer)!.get(COLOR)!.object).toBe(fresh);
      if (route === "checked")
        expect(query(O.QOP_IMAGE_OBJECT_DELETE, [kind, 18])).toEqual([0, 1]);
      else
        queued(kind === 1 ? O.OP_DELETE_TEXTURES : O.OP_DELETE_RENDERBUFFERS, [1, 18]);
      expect((kind === 1 ? b.textures : b.rbos).has(18)).toBe(false);
      expect(gl.attachments.get(framebuffer)!.has(COLOR)).toBe(false);
      expect(gl.deleted).toContain(fresh);
    });
  }
}
it("preserves separate framebuffer defaults and retained attachments on failed delete and accepts retry", () => {
  const { b, gl, framebuffer, query } = setup(), drawDefault = {}, readDefault = {};
  b.drawSurface = { renderTargetFbo: drawDefault } as any;
  b.readSurface = { renderTargetFbo: readDefault } as any;
  for (const failure of ["framebuffer", "delete-framebuffer"]) {
    gl.reject = failure;
    expect(query(O.QOP_IMAGE_OBJECT_DELETE, [3, 71])).toEqual([1, 0]);
    expect(b.fbos.get(71)).toBe(framebuffer);
    expect(b.framebufferAttachments.has(framebuffer)).toBe(true);
    expect(b.shadow.fbo).toBe(framebuffer);
    expect(b.shadow.readFbo).toBe(framebuffer);
    expect(gl.draw).toBe(framebuffer);
    expect(gl.read).toBe(framebuffer);
    expect(gl.deleted).toEqual([]);
  }
  expect(query(O.QOP_IMAGE_OBJECT_DELETE, [3, 71])).toEqual([0, 1]);
  expect(gl.draw).toBe(drawDefault);
  expect(gl.read).toBe(readDefault);
  expect(b.shadow.fbo).toBe(drawDefault);
  expect(b.shadow.readFbo).toBe(readDefault);
  expect(b.fbos.has(71)).toBe(false);
  expect(b.framebufferAttachments.has(framebuffer)).toBe(false);
});
it("restores every texture unit and separate read/draw attachment after a later unit rejects deletion", () => {
  const { b, gl, old, framebuffer, query } = setup(), read = {};
  b.shadow.textureUnits[3] = old;
  gl.textures.set(3, old);
  b.shadow.activeTexture = gl.active = 2;
  b.shadow.readFbo = gl.read = read;
  b.framebufferAttachments.set(read, new Map([[COLOR, { kind: "texture", object: old, target: TEX, level: 0 }]]));
  gl.attachments.set(read, new Map([[COLOR, old]]));
  const bind = gl.bindTexture.bind(gl);
  let count = 0;
  gl.bindTexture = (target, value) => {
    if (++count === 2)
      gl.reject = "texture";
    bind(target, value);
  };
  expect(query(O.QOP_IMAGE_OBJECT_DELETE, [1, 17])).toEqual([1, 0]);
  expect(gl.textures.get(0)).toBe(old);
  expect(gl.textures.get(3)).toBe(old);
  expect(gl.active).toBe(2);
  expect(gl.attachments.get(framebuffer)!.get(COLOR)).toBe(old);
  expect(gl.attachments.get(read)!.get(COLOR)).toBe(old);
  expect(b.textures.get(17)).toBe(old);
  expect(b.shadow.textureUnits[0]).toBe(old);
  expect(b.shadow.textureUnits[3]).toBe(old);
});
it("does not bind a texture into the wrong unit after a failed active-unit selection", () => {
  const { b, gl, old, framebuffer, query } = setup();
  b.shadow.activeTexture = gl.active = 2;
  const untouched = {};
  gl.textures.set(2, untouched);
  gl.reject = "active";
  expect(query(O.QOP_IMAGE_OBJECT_DELETE, [1, 17])).toEqual([1, 0]);
  expect(gl.textures.get(0)).toBe(old);
  expect(gl.textures.get(2)).toBe(untouched);
  expect(gl.active).toBe(2);
  expect(b.textures.get(17)).toBe(old);
  expect(gl.attachments.get(framebuffer)!.get(COLOR)).toBe(old);
  expect(b.errors).toEqual([0x505]);
});
it("validates allocation-only storage requests without publishing replies or touching native state", () => {
  const { b, gl } = setup();
  const valid = [O.OP_TEX_IMAGE_2D, TEX, 0, 0x1908, 1, 1, 0, 0x1908, 0x1401, 0];
  const subimage = [O.OP_TEX_SUB_IMAGE_2D,TEX,0,0,0,1,1,0x1908,0x1401,0];
  for (const words of [[], valid.slice(0, -1), [...valid, 0], [...valid.slice(0, -1), 4],
    subimage.slice(0,-1), [...subimage,0], [...subimage.slice(0,-1),4],
    [O.OP_CLEAR, 0], [O.OP_RENDERBUFFER_STORAGE, RBO, 0x8056, 1]]) {
    const out = new Uint8Array(12).fill(0xa5);
    expect(runGlQuery(b, O.QOP_IMAGE_STORAGE, new Uint8Array(new Uint32Array(words).buffer), out)).toBe(-22);
    expect([...out]).toEqual(Array(12).fill(0xa5));
  }
  for (const size of [8, 16]) {
    const out = new Uint8Array(size).fill(0xa5);
    expect(runGlQuery(b, O.QOP_IMAGE_STORAGE, new Uint8Array(new Uint32Array(valid).buffer), out)).toBe(-22);
    expect([...out]).toEqual(Array(size).fill(0xa5));
  }
  expect(gl.calls).toEqual([]);
});
for (const kind of [1, 2]) {
  it(`shares storage allocation validation and definite rejection between checked and queued paths (kind ${kind})`, () => {
    const { gl, old, query, queued } = setup(kind);
    const sizes = new Map<object, number>();
    sizes.set(old, 7);
    Object.assign(gl, {
      texImage2D: (_target: number, _level: number, _format: number, width: number) => {
        if (gl.before("storage"))
          sizes.set(gl.textures.get(gl.active)!, width);
      },
      renderbufferStorage: (_target: number, _format: number, width: number) => {
        if (gl.before("storage"))
          sizes.set(gl.renderbuffer!, width);
      },
    });
    const op = kind === 1 ? O.OP_TEX_IMAGE_2D : O.OP_RENDERBUFFER_STORAGE;
    const words = kind === 1 ? [TEX, 0, 0x1908, 1, 1, 0, 0x1908, 0x1401, 0] : [RBO, 0x8056, 1, 1];
    gl.reject = "storage";
    expect(query(O.QOP_IMAGE_STORAGE, [op, ...words])).toEqual([1, 0]);
    expect(sizes.get(old)).toBe(7);
    expect(query(O.QOP_IMAGE_STORAGE, [op, ...words])).toEqual([0, 1]);
    expect(sizes.get(old)).toBe(1);
    sizes.set(old, 7);
    gl.reject = "storage";
    queued(op, words);
    expect(sizes.get(old)).toBe(7);
    queued(op, words);
    expect(sizes.get(old)).toBe(1);
  });
}
it("admits subimage destination metadata without uploading or respecifying pixels", () => {
  const { b, gl, old, query } = setup();
  const calls: unknown[][] = [];
  Object.assign(gl, {
    getParameter: () => null,
    texSubImage2D: (...args: unknown[]) => { calls.push(args); },
  });
  expect(query(O.QOP_IMAGE_STORAGE, [O.OP_TEX_SUB_IMAGE_2D,TEX,0,2,1,4,3,0x1908,0x1401,0])).toEqual([0,1]);
  expect(calls).toHaveLength(1);
  expect(calls[0].slice(0,8)).toEqual([TEX,0,6,4,0,0,0x1908,0x1401]);
  expect(calls[0][8]).toBeInstanceOf(Uint8Array);
  expect((calls[0][8] as Uint8Array).byteLength).toBe(0);
  expect(b.textures.get(17)).toBe(old);
  expect(gl.textures.get(0)).toBe(old);
  expect(b.errors).toEqual([]);
});
it.each([
  [-1,0,1,1], [0,-1,1,1], [0,0,-1,1], [0,0,1,-1],
  [0x7fffffff,0,1,1], [0,0x7fffffff,1,1],
])("rejects invalid subimage destination geometry %j before native effects", (x,y,w,h) => {
  const { b, gl, query } = setup();
  expect(query(O.QOP_IMAGE_STORAGE, [O.OP_TEX_SUB_IMAGE_2D,TEX,0,x,y,w,h,0x1908,0x1401,0])).toEqual([1,0]);
  expect(b.errors).toEqual([0x501]);
  expect(gl.calls).toEqual([]);
});
it("retains a native subimage refusal and never treats metadata failure as accepted", () => {
  const { b, gl, query } = setup();
  Object.assign(gl, {
    getParameter: () => null,
    texSubImage2D: () => { gl.errors.push(0x501); },
  });
  expect(query(O.QOP_IMAGE_STORAGE, [O.OP_TEX_SUB_IMAGE_2D,TEX,0,3,3,2,2,0x1908,0x1401,0])).toEqual([1,0]);
  expect(b.errors).toEqual([0x501]);
});
it("selects the PBO offset overload only from the checked actual binding", () => {
  const { b, gl, query } = setup();
  const calls: unknown[][] = [], buffer = {};
  Object.assign(gl, {
    getParameter: (name: number) => { expect(name).toBe(0x88ef); return buffer; },
    texSubImage2D: (...args: unknown[]) => { calls.push(args); },
  });
  expect(query(O.QOP_IMAGE_STORAGE, [O.OP_TEX_SUB_IMAGE_2D,TEX,0,0,0,1,1,0x1908,0x1401,0])).toEqual([0,1]);
  expect(calls[0][8]).toBe(0);
  gl.errors.push(0x500);
  Object.assign(gl, { getParameter: () => { gl.errors.push(0x505); return buffer; } });
  expect(query(O.QOP_IMAGE_STORAGE, [O.OP_TEX_SUB_IMAGE_2D,TEX,0,0,0,1,1,0x1908,0x1401,0])).toEqual([1,0]);
  expect(calls).toHaveLength(1);
  expect(b.errors).toEqual([0x500,0x505]);
});
it("admits imported subimage destinations against the actual shared source and restores selectors", () => {
  const { b, gl, old, framebuffer, query } = setup(), sourceTexture = {};
  const source = { token: 1, bo: 77, texture: sourceTexture, width: 4, height: 4 };
  const view = { native: old, source, read: null };
  b.textureViews.set(old,view);
  let calls = 0;
  Object.assign(gl, {
    getParameter: (name: number) => name === 0x84e0 ? 0x84c0
      : name === 0x8069 ? gl.textures.get(0)
      : name === 0x8ca6 ? gl.draw : name === 0x8caa ? gl.read : null,
    texSubImage2D: (...args: unknown[]) => {
      calls++;
      expect(gl.textures.get(0)).toBe(sourceTexture);
      expect(args.slice(2,6)).toEqual([2,2,0,0]);
    },
  });
  expect(query(O.QOP_IMAGE_STORAGE, [O.OP_TEX_SUB_IMAGE_2D,TEX,0,1,1,1,1,0x1908,0x1401,0])).toEqual([0,1]);
  expect(calls).toBe(1);
  expect(b.textureViews.get(old)).toBe(view);
  expect(view.source).toBe(source);
  expect(gl.textures.get(0)).toBe(old);
  expect(gl.draw).toBe(framebuffer);
  expect(gl.read).toBe(framebuffer);
  expect(gl.deleted).toEqual([]);
});
it.each([TEX,0x8515,0x8516,0x8517,0x8518,0x8519,0x851a])(
  "validates subimage/copy mip limits for target %i before native destination access", target => {
    const { b, gl, query, queued } = setup();
    b.shadow.cubeTextureUnits[0] = {};
    const lookups: number[] = [];
    let updates = 0;
    Object.assign(gl, {
      getParameter: (name: number) => {
        if (name === 0x88ef) return null;
        lookups.push(name);
        return name === 0x851c ? 64 : 128;
      },
      texSubImage2D: () => { updates++; gl.errors.push(0x502); },
      copyTexSubImage2D: () => { updates++; gl.errors.push(0x502); },
    });
    const limit = target === TEX ? 7 : 6;
    expect(query(O.QOP_IMAGE_STORAGE,[O.OP_TEX_SUB_IMAGE_2D,target,limit+1,0,0,0,0,0x1908,0x1401,0])).toEqual([1,0]);
    queued(O.OP_COPY_TEX_SUB_IMAGE_2D,[target,limit+1,0,0,0,0,0,0]);
    expect(updates).toBe(0);
    expect(lookups).toEqual([target === TEX ? 0x0d33 : 0x851c]);
    expect(b.errors).toEqual([0x501]);
    // The exact maximum is admitted; missing destination storage then retains
    // the distinct native INVALID_OPERATION rather than a fabricated limit.
    expect(query(O.QOP_IMAGE_STORAGE,[O.OP_TEX_SUB_IMAGE_2D,target,limit,0,0,0,0,0x1908,0x1401,0])).toEqual([1,0]);
    expect(updates).toBe(1);
    expect(b.errors).toEqual([0x501,0x502]);
    expect(lookups).toHaveLength(1);
  });
it("refuses unavailable or rejected image limits without caching or invoking a dependent update", () => {
  const { b, gl, query } = setup();
  let size: unknown = 0, calls = 0, updates = 0, fail = false;
  Object.assign(gl, {
    getParameter: (name: number) => {
      if (name === 0x88ef) return null;
      calls++; if (fail) gl.errors.push(0x505); return size;
    },
    texSubImage2D: () => { updates++; },
  });
  const words=[O.OP_TEX_SUB_IMAGE_2D,TEX,1,0,0,0,0,0x1908,0x1401,0];
  expect(query(O.QOP_IMAGE_STORAGE,words)).toEqual([1,0]);
  expect(b.errors).toEqual([0x502]);
  size=128; fail=true;
  expect(query(O.QOP_IMAGE_STORAGE,words)).toEqual([1,0]);
  expect(updates).toBe(0);
  fail=false;
  expect(query(O.QOP_IMAGE_STORAGE,words)).toEqual([0,1]);
  expect(calls).toBe(3);
  expect(updates).toBe(1);
  expect(b.errors).toEqual([0x502,0x505]);
});
it("checks exact framebuffer bind spans and selectors before native allocation", () => {
  const { b, gl, query } = setup();
  for (const [inputSize, replySize] of [[4, 12], [12, 12], [8, 8], [8, 16]]) {
    const out = new Uint8Array(replySize).fill(0xa5);
    expect(runGlQuery(b, O.QOP_BIND_FRAMEBUFFER, new Uint8Array(inputSize), out)).toBe(-22);
    expect([...out]).toEqual(Array(replySize).fill(0xa5));
  }
  expect(query(O.QOP_BIND_FRAMEBUFFER, [0xdead, 72])).toEqual([1, 0]);
  expect(gl.calls).toEqual([]);
  expect(b.errors).toEqual([0x500]);
});
it("preserves framebuffer selection on native creation/bind failure and accepts a clean retry", () => {
  const { b, gl, framebuffer, query } = setup();
  for (const failure of ["create-framebuffer", "framebuffer"]) {
    gl.reject = failure;
    expect(query(O.QOP_BIND_FRAMEBUFFER, [FBO, 72])).toEqual([1, 0]);
    expect(b.fbos.has(72)).toBe(false);
    expect(b.shadow.fbo).toBe(framebuffer);
    expect(b.shadow.readFbo).toBe(framebuffer);
    expect(gl.draw).toBe(framebuffer);
    expect(gl.read).toBe(framebuffer);
  }
  expect(gl.deleted).toHaveLength(1);
  expect(query(O.QOP_BIND_FRAMEBUFFER, [FBO, 72])).toEqual([0, 1]);
  expect(b.fbos.get(72)).toBe(gl.draw);
  expect(b.shadow.fbo).toBe(gl.draw);
  expect(gl.read).toBe(gl.draw);
});
it("cleans a framebuffer candidate when namespace metadata allocation fails", () => {
  const { b, gl, framebuffer, query } = setup(), set = b.fbos.set;
  b.fbos.set = () => { throw new RangeError("namespace allocation failed"); };
  try {
    expect(query(O.QOP_BIND_FRAMEBUFFER, [FBO, 72])).toEqual([1, 0]);
  }
  finally {
    b.fbos.set = set;
  }
  expect(gl.calls).toEqual(["create-framebuffer", "delete-framebuffer"]);
  expect(gl.deleted).toHaveLength(1);
  expect(b.fbos.has(72)).toBe(false);
  expect(b.shadow.fbo).toBe(framebuffer);
  expect(gl.draw).toBe(framebuffer);
});
it("rolls back the first framebuffer default when selecting the second default fails", () => {
  const { b, gl, framebuffer, query } = setup(), draw = {}, read = {};
  b.drawSurface = { renderTargetFbo: draw } as any;
  b.readSurface = { renderTargetFbo: read } as any;
  const bind = gl.bindFramebuffer.bind(gl);
  let inject = true;
  gl.bindFramebuffer = (target, value) => { if (inject && target === READ) {
    inject = false;
    gl.reject = "framebuffer";
  } bind(target, value); };
  expect(query(O.QOP_BIND_FRAMEBUFFER, [FBO, 0])).toEqual([1, 0]);
  expect(b.shadow.fbo).toBe(framebuffer);
  expect(b.shadow.readFbo).toBe(framebuffer);
  expect(gl.draw).toBe(framebuffer);
  expect(gl.read).toBe(framebuffer);
  expect(query(O.QOP_BIND_FRAMEBUFFER, [FBO, 0])).toEqual([0, 1]);
  expect(b.shadow.fbo).toBe(draw);
  expect(b.shadow.readFbo).toBe(read);
  expect(gl.draw).toBe(draw);
  expect(gl.read).toBe(read);
});
it("shares framebuffer bind realization and rollback between queued and checked routes", () => {
  const { b, gl, framebuffer, query, queued } = setup();
  gl.reject = "framebuffer";
  queued(O.OP_BIND_FRAMEBUFFER, [FBO, 72]);
  expect(b.fbos.has(72)).toBe(false);
  expect(gl.draw).toBe(framebuffer);
  expect(b.shadow.fbo).toBe(framebuffer);
  queued(O.OP_BIND_FRAMEBUFFER, [FBO, 72]);
  const accepted = b.fbos.get(72)!;
  expect(accepted).toBe(gl.draw);
  // GLES 2 has no READ_FRAMEBUFFER target: the checked route rejects it
  // before realizing a name, exactly as the queued route does.
  expect(query(O.QOP_BIND_FRAMEBUFFER, [READ, 73])).toEqual([1, 0]);
  expect(b.errors).toContain(0x500);
  expect(b.fbos.has(73)).toBe(false);
  expect(b.shadow.fbo).toBe(accepted);
  expect(b.shadow.readFbo).toBe(accepted);
  expect(query(O.QOP_BIND_FRAMEBUFFER, [FBO, 71])).toEqual([0, 1]);
  expect(b.shadow.fbo).toBe(framebuffer);
  expect(b.shadow.readFbo).toBe(framebuffer);
});

for (const kind of [1, 2]) it(`fences later queries and batches until failed container rollback accepts (kind ${kind})`, () => {
  const { b, gl, old, framebuffer, query } = setup(kind);
  const before = gl.before.bind(gl), binding = kind === 1 ? "texture" : "renderbuffer";
  const attachment = kind === 1 ? "attach-texture" : "attach-renderbuffer";
  let rejected = false, blockRestore = true;
  gl.before = name => {
    if (!rejected && name === binding) { rejected = true; gl.errors.push(0x505); return false; }
    if (rejected && blockRestore && name === attachment) { gl.errors.push(0x502); return false; }
    return before(name);
  };
  expect(query(O.QOP_IMAGE_OBJECT_DELETE,[kind,17])).toEqual([1,0]);
  expect(gl.attachments.get(framebuffer)!.has(COLOR)).toBe(false);
  expect(b.framebufferAttachments.get(framebuffer)!.get(COLOR)!.object).toBe(old);
  const out = new Uint8Array(4).fill(0xa5);
  expect(runGlQuery(b,O.QOP_GET_ERROR,new Uint8Array(),out)).toBe(-5);
  expect([...out]).toEqual([165,165,165,165]);
  const view = new DataView(b.cmdbufView!.buffer);
  view.setUint16(0,O.OP_ACTIVE_TEXTURE,true); view.setUint16(2,4,true); view.setUint32(4,0x84c4,true);
  expect(decodeAndDispatch(b,0,8)).toBe(-5);
  expect(gl.active).toBe(0); expect(b.shadow.activeTexture).toBe(0);
  expect((kind === 1 ? b.textures : b.rbos).get(17)).toBe(old);
  const calls = gl.calls.length;
  view.setUint16(2,3,true);
  expect(decodeAndDispatch(b,0,7)).toBe(-22);
  expect(gl.calls.length).toBe(calls);
  blockRestore = false;
  expect(runGlQuery(b,O.QOP_GET_ERROR,new Uint8Array(),out)).toBe(4);
  expect(gl.attachments.get(framebuffer)!.get(COLOR)).toBe(old);
  expect(kind === 1 ? gl.textures.get(0) : gl.renderbuffer).toBe(old);
  expect(query(O.QOP_IMAGE_OBJECT_DELETE,[kind,17])).toEqual([0,1]);
});

it("retains failed framebuffer deletion rollback and restores both native selectors before retry", () => {
  const { b, gl, framebuffer, query } = setup();
  const before = gl.before.bind(gl); let rejected = false, block = true;
  gl.before = name => {
    if (!rejected && name === "delete-framebuffer") { rejected = true; gl.errors.push(0x505); return false; }
    if (rejected && block && name === "framebuffer") { gl.errors.push(0x502); return false; }
    return before(name);
  };
  expect(query(O.QOP_IMAGE_OBJECT_DELETE,[3,71])).toEqual([1,0]);
  expect(gl.draw).toBeNull(); expect(gl.read).toBeNull();
  expect(b.shadow.fbo).toBe(framebuffer); expect(b.shadow.readFbo).toBe(framebuffer);
  const out = new Uint8Array(4).fill(0xa5);
  expect(runGlQuery(b,O.QOP_GET_ERROR,new Uint8Array(),out)).toBe(-5);
  expect([...out]).toEqual([165,165,165,165]);
  block = false;
  expect(runGlQuery(b,O.QOP_GET_ERROR,new Uint8Array(),out)).toBe(4);
  expect(gl.draw).toBe(framebuffer); expect(gl.read).toBe(framebuffer);
  expect(b.fbos.get(71)).toBe(framebuffer);
  expect(query(O.QOP_IMAGE_OBJECT_DELETE,[3,71])).toEqual([0,1]);
});

it("retires context-local repair targets without reviving dead containers or losing peer objects", () => {
  const {registry,b,gl,old,framebuffer,query} = setup();
  registry.bind({pid:1,sessionId:2,cmdbufAddr:0,cmdbufLen:0});
  const peer = registry.get(1,2)!; peer.gl = b.gl;
  b.contextId = 11; peer.contextId = 12;
  expect(registry.shareObjects(1,2,0)).toBe(true);
  const before = gl.before.bind(gl); let rejected = false, restores = 0;
  gl.before = name => {
    if (!rejected && name === "texture") { rejected = true; gl.errors.push(0x505); return false; }
    if (rejected && name === "attach-texture") { restores++; gl.errors.push(0x502); return false; }
    return before(name);
  };
  expect(query(O.QOP_IMAGE_OBJECT_DELETE,[1,17])).toEqual([1,0]);
  const attempts = restores;
  registry.destroyContext(1,0);
  expect(gl.deleted).toContain(framebuffer);
  expect(gl.deleted).not.toContain(old);
  expect(peer.textures.get(17)).toBe(old);
  expect(runGlQuery(peer,O.QOP_GET_ERROR,new Uint8Array(),new Uint8Array(4))).toBe(4);
  expect(restores).toBe(attempts);
  registry.destroyContext(1,2);
  expect(gl.deleted).toContain(old);
});

function containerReply(b: ReturnType<typeof setup>["b"], op: number, words: number[], length: number) {
  const out = new Uint8Array(length).fill(0xa5);
  expect(runGlQuery(b,op,new Uint8Array(new Uint32Array(words).buffer),out)).toBe(length);
  const reply = [...new Uint32Array(out.buffer)];
  expect(reply.at(-1)).toBe(0x47514c33);
  return reply.slice(0,-1);
}
for (const kind of [1,2]) {
  it(`returns actual accepted attachment container without changing legacy receipts (kind ${kind})`,() => {
    const {b,gl,framebuffer,query,queued} = setup(kind), target = kind === 1 ? TEX : RBO;
    const args = [kind,FBO,COLOR,target,18,0];
    expect(query(O.QOP_IMAGE_ATTACHMENT,args)).toEqual([0,1]);
    const rejected = {}; b.fbos.set(92,rejected);
    gl.reject = "framebuffer"; queued(O.OP_BIND_FRAMEBUFFER,[FBO,92]);
    expect(b.shadow.fbo).toBe(framebuffer);
    expect(containerReply(b,O.QOP_IMAGE_ATTACHMENT,args,16)).toEqual([0,1,71]);
    gl.reject = kind === 1 ? "attach-texture" : "attach-renderbuffer";
    expect(containerReply(b,O.QOP_IMAGE_ATTACHMENT,[kind,FBO,COLOR,target,17,0],16)).toEqual([1,0,0]);
    expect(b.framebufferAttachments.get(framebuffer)!.get(COLOR)!.object).toBe(kind === 1 ? b.textures.get(18) : b.rbos.get(18));
  });
  it(`acknowledges exact deletion selection and retains unbound/peer containers (kind ${kind})`,() => {
    const {registry,b,gl,old,framebuffer} = setup(kind), read = {}, unbound = {};
    b.fbos.set(72,read); b.fbos.set(73,unbound); b.shadow.readFbo = gl.read = read;
    const image = kind === 1 ? {kind:"texture" as const,object:old,target:TEX,level:0} : {kind:"renderbuffer" as const,object:old};
    for (const fbo of [read,unbound]) {
      b.framebufferAttachments.set(fbo,new Map([[COLOR,image]])); gl.attachments.set(fbo,new Map([[COLOR,old]]));
    }
    registry.bind({pid:1,sessionId:2,cmdbufAddr:0,cmdbufLen:64});
    const peer = registry.get(1,2)!; peer.gl = b.gl; b.contextId = 11; peer.contextId = 12;
    expect(registry.shareObjects(1,2,0)).toBe(true); peer.fbos.set(71,{});
    peer.framebufferAttachments.set(peer.fbos.get(71)!,new Map([[COLOR,image]]));
    gl.reject = kind === 1 ? "texture" : "renderbuffer";
    expect(containerReply(b,O.QOP_IMAGE_OBJECT_DELETE,[kind,17],20)).toEqual([1,0,0,0]);
    expect(b.framebufferAttachments.get(framebuffer)!.get(COLOR)!.object).toBe(old);
    expect(containerReply(b,O.QOP_IMAGE_OBJECT_DELETE,[kind,17],20)).toEqual([0,1,71,72]);
    expect(b.framebufferAttachments.has(framebuffer)).toBe(false); expect(b.framebufferAttachments.has(read)).toBe(false);
    expect(b.framebufferAttachments.get(unbound)!.get(COLOR)!.object).toBe(old);
    expect(peer.framebufferAttachments.get(peer.fbos.get(71)!)!.get(COLOR)!.object).toBe(old);
  });
}
it("does not invent container zero for unknown named logical selection",() => {
  const {b,gl} = setup(); b.shadow.fbo = gl.draw = {};
  expect(containerReply(b,O.QOP_IMAGE_ATTACHMENT,[1,FBO,COLOR,TEX,18,0],16)).toEqual([1,0,0]);
  expect(containerReply(b,O.QOP_IMAGE_OBJECT_DELETE,[1,17],20)).toEqual([1,0,0,0]);
  expect(gl.calls).toEqual([]); expect(b.textures.has(17)).toBe(true);
});

it("distinguishes native default storage from a missing named container in deletion receipts",() => {
  const {b,gl,framebuffer} = setup(), drawDefault = {};
  b.drawSurface = {renderTargetFbo:drawDefault} as any; b.shadow.fbo = gl.draw = drawDefault;
  expect(containerReply(b,O.QOP_IMAGE_OBJECT_DELETE,[1,17],20)).toEqual([0,1,0,71]);
  expect(b.framebufferAttachments.has(framebuffer)).toBe(false);
});
it("stages receipt metadata before effects and preserves the actual error owner on allocation failure",() => {
  const {b,gl} = setup(), iterator = b.fbos[Symbol.iterator]; b.errors.push(0x500);
  b.fbos[Symbol.iterator] = () => { throw new RangeError("receipt iterator allocation refused"); };
  try {
    expect(containerReply(b,O.QOP_IMAGE_ATTACHMENT,[1,FBO,COLOR,TEX,18,0],16)).toEqual([1,0,0]);
    expect(containerReply(b,O.QOP_IMAGE_OBJECT_DELETE,[1,17],20)).toEqual([1,0,0,0]);
  } finally { b.fbos[Symbol.iterator] = iterator; }
  expect(gl.calls).toEqual([]); expect(b.errors).toEqual([0x500,0x505]);
  expect(b.textures.has(17)).toBe(true);
});

// Full opaque compressed uploads must not be approximated by zero-area calls.
const COMPRESSED_UPLOAD = 0x0032, COMPRESSED_FORMAT = 0x83f1;
function compressedFixture() {
  const state = setup(), {b,gl} = state;
  const writes: {op:number; args:unknown[]; bytes:number[]}[] = [];
  Object.assign(gl, {
    getParameter: (pname:number) => {
      if (pname === 0x86a3) return new Uint32Array([COMPRESSED_FORMAT]);
      if (pname === 0x8b4d) return 8;
      if (pname === 0x84e0) return 0x84c0+gl.active;
      if (pname === 0x8069) return gl.textures.get(gl.active) ?? null;
      if (pname === 0x8ca6) return gl.draw;
      if (pname === 0x8caa) return gl.read;
      if (pname === 0x8ca7) return gl.renderbuffer;
      return null;
    },
    getTexParameter: ()=>0x2601, texParameteri: ()=>{}, createTexture: ()=>({}),
    compressedTexImage2D: (...args:unknown[]) => { writes.push({op:O.OP_COMPRESSED_TEX_IMAGE_2D,args,bytes:[...(args[6] as Uint8Array)]}); },
    compressedTexSubImage2D: (...args:unknown[]) => { writes.push({op:O.OP_COMPRESSED_TEX_SUB_IMAGE_2D,args,bytes:[...(args[7] as Uint8Array)]}); },
  });
  const request = (words:number[], data:number[]=[]): number[] => {
    const input = new Uint8Array(words.length*4+data.length), v = new DataView(input.buffer);
    words.forEach((x,i)=>v.setUint32(i*4,x,true));input.set(data,words.length*4);
    const out=new Uint8Array(12).fill(0xa5);
    expect(runGlQuery(b,COMPRESSED_UPLOAD,input,out)).toBe(12);
    return [...new Uint32Array(out.buffer)].slice(0,2);
  };
  const begin = (token=1, size=4, present=1, op=O.OP_COMPRESSED_TEX_SUB_IMAGE_2D,
      format=COMPRESSED_FORMAT, level=0) => request([1,token,op,TEX,level,format,0,0,4,4,0,size,present]);
  return {...state,writes,request,begin};
}
it("stages compressed bytes independently and invokes exactly one full original native operation",()=>{
  const {b,old,gl,begin,request,writes}=compressedFixture();
  expect(begin()).toEqual([0,1]); expect(writes).toEqual([]);
  expect(request([2,1,0],[11,12])).toEqual([0,1]);expect(writes).toEqual([]);
  expect(request([2,1,2],[13,14])).toEqual([0,1]);
  expect(request([3,1,0])).toEqual([0,1]);
  expect(writes).toEqual([{op:O.OP_COMPRESSED_TEX_SUB_IMAGE_2D,args:[TEX,0,0,0,4,4,COMPRESSED_FORMAT,expect.any(Uint8Array)],bytes:[11,12,13,14]}]);
  expect(b.textures.get(17)).toBe(old);expect(gl.textures.get(0)).toBe(old);
  expect(request([3,1,0])).toEqual([1,0]);expect(writes).toHaveLength(1);
});
it("checks signed size and unsupported formats before allocation/source admission, retaining exact empty operations",()=>{
  const {b,begin,request,writes}=compressedFixture();
  expect(begin(1,-1)).toEqual([1,0]);expect(b.errors.splice(0)).toEqual([0x501]);
  expect(begin(2,0,0,O.OP_COMPRESSED_TEX_SUB_IMAGE_2D,0)).toEqual([1,0]);expect(b.errors.splice(0)).toEqual([0x500]);
  expect(begin(3,4,0)).toEqual([1,0]);expect(b.errors.splice(0)).toEqual([0x501]);
  expect(begin(4,0,0)).toEqual([0,4]);expect(request([3,4,0])).toEqual([0,4]);
  expect(writes[0].args.slice(0,7)).toEqual([TEX,0,0,0,4,4,COMPRESSED_FORMAT]);expect(writes[0].bytes).toEqual([]);
});
it("rejects missing/reordered chunks and stale destination/context authority without native writes",()=>{
  const {b,begin,request,writes}=compressedFixture();
  expect(begin()).toEqual([0,1]);expect(request([2,1,1],[1])).toEqual([1,0]);
  expect(request([3,1,0])).toEqual([1,0]);
  expect(begin(2)).toEqual([0,2]);expect(request([2,2,0],[1,2,3,4])).toEqual([0,2]);
  b.shadow.textureUnits[0]={};expect(request([3,2,0])).toEqual([1,0]);expect(writes).toEqual([]);
});
it("retires cancelled and incomplete uploads and consumes native commit refusal exactly once",()=>{
  const {b,gl,begin,request,writes}=compressedFixture();
  expect(begin()).toEqual([0,1]);expect(request([3,1,0])).toEqual([1,0]);expect(writes).toEqual([]);
  expect(begin(2)).toEqual([0,2]);expect(request([4,2,0])).toEqual([0,2]);expect(request([4,2,0])).toEqual([0,2]);
  expect(begin(2)).toEqual([1,0]);
  expect(begin(3)).toEqual([0,3]);expect(request([2,3,0],[1,2,3,4])).toEqual([0,3]);
  Object.assign(gl,{compressedTexSubImage2D:()=>{gl.errors.push(0x501);}});
  expect(request([3,3,0])).toEqual([1,0]);expect(request([3,3,0])).toEqual([1,0]);expect(writes).toEqual([]);
  expect(b.errors).toContain(0x501);
});
it("does not impose universal nonnegative levels on advertised compressed extension formats",()=>{
  const {begin,request,writes}=compressedFixture();
  expect(begin(1,0,0,O.OP_COMPRESSED_TEX_IMAGE_2D,COMPRESSED_FORMAT,-1)).toEqual([0,1]);
  expect(request([3,1,0])).toEqual([0,1]);expect(writes[0].args[1]).toBe(-1);
});

it.each(["context","gl","objects","shadow","unit","view","revision"])("rejects compressed commit after %s authority changes",which=>{
  const {b,begin,request,writes}=compressedFixture();
  expect(begin()).toEqual([0,1]);expect(request([2,1,0],[1,2,3,4])).toEqual([0,1]);
  if(which==="context") b.contextId=123 as typeof b.contextId;
  if(which==="gl") b.gl={getError:()=>0} as WebGL2RenderingContext;
  if(which==="objects") b.objects={...b.objects};
  if(which==="shadow") b.shadow={...b.shadow};
  if(which==="unit") {b.shadow.activeTexture=1;b.shadow.textureUnits[1]=b.shadow.textureUnits[0];}
  if(which==="view") b.textureViews.set(b.shadow.textureUnits[0]!,{native:{},source:null,read:null});
  if(which==="revision") b.imageRevisions.set(b.shadow.textureUnits[0]!,1);
  expect(request([3,1,0])).toEqual([1,0]);expect(writes).toEqual([]);expect(b.compressedUpload).toBeNull();
});
it("copies compressed chunk bytes before returning and preserves a newer upload against a stale cancellation",()=>{
  const {b,begin,request,writes}=compressedFixture();
  expect(begin(2)).toEqual([0,2]);expect(request([4,1,0])).toEqual([1,0]);
  const raw=new Uint8Array(16),v=new DataView(raw.buffer);v.setUint32(0,2,true);v.setUint32(4,2,true);raw.set([21,22,23,24],12);
  expect(runGlQuery(b,COMPRESSED_UPLOAD,raw,new Uint8Array(12))).toBe(12);raw.fill(0);
  expect(request([3,2,0])).toEqual([0,2]);expect(writes[0].bytes).toEqual([21,22,23,24]);
});
it("cleans abandoned compressed custody on an unrelated query without executing that query",()=>{
  const {b,begin,writes}=compressedFixture();expect(begin()).toEqual([0,1]);
  expect(runGlQuery(b,O.QOP_GET_ERROR,new Uint8Array(0),new Uint8Array(4))).toBe(-5);
  expect(b.compressedUpload).toBeNull();expect(b.errors).toEqual([0x502]);expect(writes).toEqual([]);
});
it("rejects malformed compressed envelopes before touching outputs or native state",()=>{
  const {b,gl}=compressedFixture();
  for(const words of [[],[1,0,0],[1,1,0],[2,1,0],[3,1,1],[4,1,1],[5,1,0],
      [1,1,O.OP_COMPRESSED_TEX_IMAGE_2D,TEX,0,COMPRESSED_FORMAT,0,0,4,4,0,4,2]]) {
    const out=new Uint8Array(12).fill(0xa5);
    expect(runGlQuery(b,COMPRESSED_UPLOAD,new Uint8Array(new Uint32Array(words).buffer),out)).toBe(-22);
    expect([...out]).toEqual(Array(12).fill(0xa5));
  }
  expect(gl.calls).toEqual([]);
});
it("preserves native capability query failures and refuses oversize custody visibly",()=>{
  const {b,gl,begin}=compressedFixture();
  expect(begin(1,16*1024*1024+1)).toEqual([1,0]);expect(b.errors.splice(0)).toEqual([0x505]);expect(b.compressedUpload).toBeNull();
  Object.assign(gl,{getParameter:()=>{gl.errors.push(0x502);return new Uint32Array([COMPRESSED_FORMAT]);}});
  expect(begin(2)).toEqual([1,0]);expect(b.errors).toEqual([0x502]);expect(b.compressedUpload).toBeNull();
});
it("drops compressed custody on actual context resource destruction",()=>{
  const {registry,b,gl,begin}=compressedFixture();expect(begin()).toEqual([0,1]);
  Object.assign(gl,{deleteBuffer:()=>{},deleteProgram:()=>{},deleteShader:()=>{},deleteVertexArray:()=>{}});
  registry.unbind(1);expect(b.compressedUpload).toBeNull();
});

it("drops staged compressed bytes on observed native loss without pretending COMMIT succeeded",()=>{
  const {b,gl,begin,request,writes}=compressedFixture();expect(begin()).toEqual([0,1]);
  Object.assign(gl,{isContextLost:()=>true});
  const out=new Uint8Array(12).fill(0xa5),input=new Uint8Array(new Uint32Array([3,1,0]).buffer);
  expect(runGlQuery(b,COMPRESSED_UPLOAD,input,out)).toBe(-5);
  expect([...out]).toEqual(Array(12).fill(0xa5));expect(b.compressedUpload).toBeNull();expect(writes).toEqual([]);
});
it("uses the canonical imported source for subimage commit without detaching it",()=>{
  const {b,gl,old,begin,request,writes}=compressedFixture(),source={token:1,bo:7,texture:{},width:4,height:4};
  const view={native:old,source,read:{}};b.textureViews.set(old,view);
  Object.assign(gl,{compressedTexSubImage2D:()=>{expect(gl.textures.get(gl.active)).toBe(source.texture);}});
  expect(begin()).toEqual([0,1]);expect(request([2,1,0],[1,2,3,4])).toEqual([0,1]);
  expect(request([3,1,0])).toEqual([0,1]);expect(b.textureViews.get(old)).toBe(view);
  expect(view.source).toBe(source);expect(gl.textures.get(gl.active)).toBe(old);expect(writes).toEqual([]);
});

it("releases compressed custody when a public slot retires while an older accepted execution remains leased",()=>{
  const {registry,b,gl,begin}=compressedFixture();b.contextId=77;
  const guard={context:gl as unknown as WebGL2RenderingContext,prepareRetirement:()=>true};
  const lease=registry.retainContextExecution(1,b.sessionId,guard)!;expect(lease).not.toBeNull();
  expect(begin()).toEqual([0,1]);registry.destroyContext(1,b.sessionId);
  expect(lease.retired).toBe(true);expect(b.compressedUpload).toBeNull();
  expect(registry.get(1,b.sessionId)).not.toBe(b);expect(registry.get(1,b.sessionId)!.compressedUpload).toBeNull();
  expect(lease.release()).toBe(true);
  // Native resource disposal is already covered by the execution-retirement
  // tests; this case proves staging leaves the old owner before that fence.
});
it("consumes a compressed native commit that throws after its effect and never replays it",()=>{
  const {gl,begin,request}=compressedFixture();let calls=0;
  expect(begin()).toEqual([0,1]);expect(request([2,1,0],[1,2,3,4])).toEqual([0,1]);
  Object.assign(gl,{compressedTexSubImage2D:()=>{calls++;throw new Error("post-effect driver exception");}});
  expect(request([3,1,0])).toEqual([1,0]);expect(request([3,1,0])).toEqual([1,0]);
  expect(request([4,1,0])).toEqual([0,1]);expect(calls).toBe(1);
});
it("catches detached compressed staging allocation failure without retaining bytes or accepting BEGIN",()=>{
  const {b,begin}=compressedFixture();const original=Uint8Array;
  vi.stubGlobal("Uint8Array",new Proxy(original,{construct(target,args){
    if(args[0]===9) throw new RangeError("staging allocation denied");
    return Reflect.construct(target,args);
  }}));
  try {expect(begin(1,9)).toEqual([1,0]);expect(b.compressedUpload).toBeNull();expect(b.errors).toEqual([0x505]);}
  finally {vi.unstubAllGlobals();}
});
it("commits a complete compressed respecification only after native acceptance, preserving imported ownership on refusal",()=>{
  const {b,gl,old,begin,request,writes}=compressedFixture(),source={token:1,bo:7,texture:{},width:4,height:4};
  const prior={native:old,source,read:{}};b.textureViews.set(old,prior);
  const native=gl as unknown as {compressedTexImage2D:(...args:unknown[])=>void}, original=native.compressedTexImage2D;
  native.compressedTexImage2D=(...args)=>{original(...args);gl.errors.push(0x501);};
  expect(begin(1,0,0,O.OP_COMPRESSED_TEX_IMAGE_2D)).toEqual([0,1]);expect(writes).toEqual([]);
  expect(request([3,1,0])).toEqual([1,0]);expect(b.textureViews.get(old)).toBe(prior);
  native.compressedTexImage2D=original;
  expect(begin(2,0,0,O.OP_COMPRESSED_TEX_IMAGE_2D)).toEqual([0,2]);expect(request([3,2,0])).toEqual([0,2]);
  expect(writes).toHaveLength(2);expect(b.textureViews.get(old)!.source).toBeNull();expect(b.imageRevisions.get(old)).toBe(1);
});

it("releases compressed ABORT custody even when its checked reply allocation fails",()=>{
  const {b,begin,request}=compressedFixture();expect(begin()).toEqual([0,1]);const original=Uint8Array;
  vi.stubGlobal("Uint8Array",new Proxy(original,{construct(target,args){
    if(args[0]===4) throw new RangeError("checked reply allocation denied");
    return Reflect.construct(target,args);
  }}));
  try {expect(request([4,1,0])).toEqual([1,0]);expect(b.compressedUpload).toBeNull();expect(b.compressedUploadSerial).toBe(1);}
  finally {vi.unstubAllGlobals();}
});
