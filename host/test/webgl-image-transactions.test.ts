import { expect, it } from "vitest";
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
    for (const [inputLength, replyLength] of [[size - 4, 12], [size + 4, 12], [size, 8], [size, 16]]) {
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
  for (const words of [[], valid.slice(0, -1), [...valid, 0], [...valid.slice(0, -1), 4], [O.OP_CLEAR, 0], [O.OP_RENDERBUFFER_STORAGE, RBO, 0x8056, 1]]) {
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
  expect(query(O.QOP_BIND_FRAMEBUFFER, [READ, 71])).toEqual([0, 1]);
  expect(b.shadow.fbo).toBe(accepted);
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
