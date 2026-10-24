import { foreignTextureGl } from "./support/foreign-texture-gl.js";
import { expect, it } from "vitest";
import { GlContextRegistry } from "../src/webgl/registry.js";
import { registerImageSource, textureNative, canonicalTexture, WPK_IMAGE_SOURCE_TARGET, imageTextureOperation, imageRenderbufferStorage, destroyTextureView, destroyRenderbufferView } from "../src/webgl/image-storage.js";
import { runGlQuery } from "../src/webgl/query.js";
import { createWasmPosixKernelTestHarness } from "../src/kernel.js";
import { createKernelScratchTestInstance } from "./support/kernel-scratch-instance.js";
import * as O from "../src/webgl/ops.js";
function setup() {
  const reg = new GlContextRegistry();
  reg.bind({ pid: 7, sessionId: 11, cmdbufAddr: 0, cmdbufLen: 0 });
  const b = reg.get(7, 11)!;
  const gl = new Proxy({ getError: () => 0, getParameter: () => null, isTexture: () => true, isRenderbuffer: () => true }, { get: (target, name) => Reflect.get(target, name) ?? (() => null) }) as unknown as WebGL2RenderingContext;
  b.gl = gl;
  b.contextId = 21;
  return { reg, b, gl };
}
function checked(b: ReturnType<typeof setup>["b"], op: number, words: number[], size = 12) {
  const out = new Uint8Array(size), input = new Uint8Array(new Uint32Array(words).buffer);
  expect(runGlQuery(b, op, input, out)).toBe(size);
  return new Uint32Array(out.buffer);
}
it("keeps source tokens separate from every legal public texture name and reuses one live BO source", () => {
  const { b } = setup(), publicTexture = {} as WebGLTexture, source = {} as WebGLTexture;
  b.textures.set(1, publicTexture);
  b.textures.set(0x60000000, publicTexture);
  expect(registerImageSource(b, 41, source, 2, 3)).toBe(1);
  expect(registerImageSource(b, 41, source, 2, 3)).toBe(1);
  expect(b.imageSources.size).toBe(1);
  expect(b.textures.get(1)).toBe(publicTexture);
  expect(b.textures.get(0x60000000)).toBe(publicTexture);
  b.imageSources.delete(1);
  expect(registerImageSource(b, 42, source, 4, 4)).toBe(2);
  b.nextImageSource = 0x80000000;
  expect(registerImageSource(b, 43, source, 4, 4)).toBe(-12);
  expect(b.imageSources.size).toBe(1);
});
it("preserves the source allocator and public names on metadata allocation failure", () => {
  const { b } = setup(), set = b.imageSources.set;
  b.imageSources.set = () => { throw new RangeError("allocation failed"); };
  try {
    expect(registerImageSource(b, 41, {} as WebGLTexture, 1, 1)).toBe(-12);
  }
  finally {
    b.imageSources.set = set;
  }
  expect(b.nextImageSource).toBe(1);
  expect(b.imageSources.size).toBe(0);
  expect(b.textures.size).toBe(0);
});
it("rejects incomplete image requests and reply spans before invoking the renderer", () => {
  const { b } = setup();
  for (const op of [O.QOP_IMAGE_TARGET, O.QOP_IMAGE_SOURCE_STATE])
    for (const length of [0, 4, 16]) {
      const out = new Uint8Array(12).fill(0xa5);
      expect(runGlQuery(b, op, new Uint8Array(length), out)).toBe(-22);
      expect([...out]).toEqual(Array(12).fill(0xa5));
    }
  for (const length of [0, 8, 16])
    expect(runGlQuery(b, O.QOP_IMAGE_TARGET, new Uint8Array(12), new Uint8Array(length))).toBe(-22);
  expect(b.textureViews.size).toBe(0);
  expect(b.errors).toEqual([]);
});
it("rejects unknown sources and unrealized names without publishing image state", () => {
  const { b } = setup();
  b.textures.set(17, {} as WebGLTexture);
  expect([...checked(b, O.QOP_IMAGE_TARGET, [1, 17, 8])]).toEqual([1, 0, 0x47514c33]);
  expect([...checked(b, O.QOP_IMAGE_TARGET, [1, 18, 8])]).toEqual([1, 0, 0x47514c33]);
  expect([...checked(b, O.QOP_IMAGE_SOURCE_STATE, [1, 18])]).toEqual([1, 0, 0x47514c33]);
  expect(b.textureViews.size).toBe(0);
  expect(b.textures.size).toBe(1);
});
it("queries logical names and realization through a native view after the old native anchor is gone", () => {
  const { b, gl } = setup(), anchor = {} as WebGLTexture, view = {} as WebGLTexture;
  b.textures.set(17, anchor);
  b.textureViews.set(anchor, { native: view, source: null, read: null });
  b.textureViewOwners.set(view, anchor);
  Object.assign(gl, { getParameter: () => view, isTexture: (value: WebGLTexture) => value === view });
  expect(textureNative(b, anchor)).toBe(view);
  expect(canonicalTexture(b, view)).toBe(anchor);
  const out = new Uint8Array(4);
  expect(runGlQuery(b, O.QOP_GET_INTEGERV, new Uint8Array(new Uint32Array([0x8069]).buffer), out)).toBe(4);
  expect(new Uint32Array(out.buffer)[0]).toBe(17);
  expect(checked(b, O.QOP_IS_OBJECT, [1, 17])[1]).toBe(1);
  expect(checked(b, O.QOP_IMAGE_SOURCE_STATE, [1, 17])[1]).toBe(0);
});
it("reports logical renderbuffer dimensions and attachment type for imported texture backing", () => {
  const { b } = setup(), object = {} as WebGLRenderbuffer, fbo = {} as WebGLFramebuffer;
  b.rbos.set(19, object);
  b.shadow.renderbuffer = object;
  b.shadow.fbo = b.shadow.readFbo = fbo;
  b.renderbufferViews.set(object, { native: object, source: { token: 1, bo: 41, texture: {} as WebGLTexture, width: 7, height: 9 } });
  b.framebufferAttachments.set(fbo, new Map([[0x8ce0, { kind: "renderbuffer", object }]]));
  expect(checked(b, O.QOP_GET_RENDERBUFFER_PARAMETER, [0x8d41, 0x8d42])[1]).toBe(7);
  expect(checked(b, O.QOP_GET_RENDERBUFFER_PARAMETER, [0x8d41, 0x8d43])[1]).toBe(9);
  expect(checked(b, O.QOP_GET_RENDERBUFFER_PARAMETER, [0x8d41, 0x8d44])[1]).toBe(0x8058);
  expect([...checked(b, O.QOP_GET_FB_ATTACHMENT, [0x8d40, 0x8ce0], 24)].slice(0, 3)).toEqual([0, 0x8d41, 19]);
});
it("registers a GPU source through the actual kernel host import without overwriting a public texture", () => {
  const memory = new WebAssembly.Memory({ initial: 2, maximum: 2 });
  const kernel = createWasmPosixKernelTestHarness({ io: {} as any, callbacks: { getProcessMemory: () => memory }, memory, pointerWidth: 4,
    instance: createKernelScratchTestInstance(4, memory, () => ({}), () => 4096) });
  const api = (kernel.testAuthority.buildImportObject(memory) as {
    env: Record<string, (...args: any[]) => number>;
  }).env;
  const gl = new Proxy({ getError: () => 0, getParameter: () => null, createTexture: () => ({}), createFramebuffer: () => ({}), createRenderbuffer: () => ({}),
    FRAMEBUFFER_COMPLETE: 0x8cd5, checkFramebufferStatus: () => 0x8cd5 }, { get: (target, name) => Reflect.get(target, name) ?? (() => { }) }) as unknown as WebGL2RenderingContext;
  kernel.gl.bind({ pid: 7, sessionId: 11, cmdbufAddr: 0, cmdbufLen: 0 });
  const b = kernel.gl.get(7, 11)!;
  b.gl = gl;
  b.contextId = 21;
  const ordinary = {} as WebGLTexture;
  b.textures.set(0x60000000, ordinary);
  expect(kernel.gl.createGpuBo(41, gl, 2, 2)).toBe(0x60000000);
  expect(api.host_gl_bind_foreign_texture(7, 21, 41, WPK_IMAGE_SOURCE_TARGET)).toBe(1);
  expect(b.textures.get(0x60000000)).toBe(ordinary);
  expect(b.textures.size).toBe(1);
  expect(b.imageSources.size).toBe(1);
  expect(api.host_gl_bind_foreign_texture(7, 21, 999, WPK_IMAGE_SOURCE_TARGET)).toBe(-22);
});
it("reads the retained bound image and revision after public name deletion and reuse", () => {
  const { b } = setup(), old = {} as WebGLTexture, fresh = {} as WebGLTexture, view = {} as WebGLTexture;
  b.textures.set(17, fresh);
  b.retiredTextures.set(old, 17);
  b.shadow.textureUnits[0] = old;
  b.textureViews.set(old, { native: view, source: { token: 3, bo: 41, texture: {} as WebGLTexture, width: 2, height: 2 }, read: null });
  b.imageRevisions.set(old, 9);
  expect([...checked(b, O.QOP_BOUND_IMAGE_STATE, [1, 0x0de1], 16)]).toEqual([0, 3, 9, 0x47514c33]);
  expect([...checked(b, O.QOP_IMAGE_SOURCE_STATE, [1, 17])]).toEqual([0, 0, 0x47514c33]);
  b.shadow.renderbuffer = {} as WebGLRenderbuffer;
  b.imageRevisions.set(b.shadow.renderbuffer, 4);
  expect([...checked(b, O.QOP_BOUND_IMAGE_STATE, [2, 0x8d41], 16)]).toEqual([0, 0, 4, 0x47514c33]);
});
it("validates bound-image selectors and complete V11 spans before touching renderer state", () => {
  const { b } = setup();
  for (const op of [O.QOP_BOUND_IMAGE_TARGET, O.QOP_BOUND_IMAGE_STATE]) {
    const expected = op === O.QOP_BOUND_IMAGE_TARGET ? 12 : 8;
    for (const [inputLength, replyLength] of [[expected - 4, 16], [expected + 4, 16], [expected, 12], [expected, 20]]) {
      const output = new Uint8Array(replyLength).fill(0xa5);
      expect(runGlQuery(b, op, new Uint8Array(inputLength), output)).toBe(-22);
      expect([...output]).toEqual(Array(replyLength).fill(0xa5));
    }
  }
  expect([...checked(b, O.QOP_BOUND_IMAGE_STATE, [1, 0x8513], 16)]).toEqual([1, 0, 0, 0x47514c33]);
  expect([...checked(b, O.QOP_BOUND_IMAGE_STATE, [1, 0x0de1], 16)]).toEqual([1, 0, 0, 0x47514c33]);
  expect(b.imageRevisions.size).toBe(0);
});
for (const kind of [1, 2]) {
  it(`advances accepted image revisions and removes them only at final collection (kind ${kind})`, () => {
    const { b, gl } = setup(), object = {} as WebGLTexture & WebGLRenderbuffer;
    Object.assign(gl, { createTexture: () => ({}), createFramebuffer: () => ({}), createRenderbuffer: () => ({}), checkFramebufferStatus: () => 0x8cd5 });
    if (kind === 1)
      b.shadow.textureUnits[0] = object;
    else
      b.shadow.renderbuffer = object;
    registerImageSource(b, 41, {} as WebGLTexture, 2, 2);
    const target = kind === 1 ? 0x0de1 : 0x8d41;
    expect([...checked(b, O.QOP_BOUND_IMAGE_TARGET, [kind, target, 1], 16)]).toEqual([0, 1, 1, 0x47514c33]);
    expect([...checked(b, O.QOP_BOUND_IMAGE_TARGET, [kind, target, 1], 16)]).toEqual([0, 1, 2, 0x47514c33]);
    expect(kind === 1 ? imageTextureOperation(b, target, true, () => { }, false) : imageRenderbufferStorage(b, () => { })).toBe(true);
    expect([...checked(b, O.QOP_BOUND_IMAGE_STATE, [kind, target], 16)]).toEqual([0, 0, 3, 0x47514c33]);
    expect(kind === 1 ? destroyTextureView(b, object) : destroyRenderbufferView(b, object)).toBe(true);
    expect(b.imageRevisions.has(object)).toBe(false);
  });
  it(`preserves image revisions after metadata, native retarget and exhaustion rejection (kind ${kind})`, () => {
    const { b, gl } = setup(), object = {} as WebGLTexture & WebGLRenderbuffer, fbo = {} as WebGLFramebuffer;
    Object.assign(gl, { createTexture: () => ({}), createFramebuffer: () => ({}), checkFramebufferStatus: () => 0x8cd5 });
    if (kind === 1)
      b.shadow.textureUnits[0] = object;
    else
      b.shadow.renderbuffer = object;
    registerImageSource(b, 41, {} as WebGLTexture, 2, 2);
    const target = kind === 1 ? 0x0de1 : 0x8d41;
    expect(checked(b, O.QOP_BOUND_IMAGE_TARGET, [kind, target, 1], 16)[0]).toBe(0);
    const oldView = kind === 1 ? b.textureViews.get(object) : b.renderbufferViews.get(object);
    const set = b.imageRevisions.set;
    b.imageRevisions.set = (key, value) => { if (value === 2)
      throw new RangeError("metadata exhausted"); return set.call(b.imageRevisions, key, value); };
    try {
      expect(checked(b, O.QOP_BOUND_IMAGE_TARGET, [kind, target, 1], 16)[0]).toBe(1);
    }
    finally {
      b.imageRevisions.set = set;
    }
    expect(b.imageRevisions.get(object)).toBe(1);
    b.framebufferAttachments.set(fbo, new Map([[0x8ce0, kind === 1 ? { kind: "texture", object, target, level: 0 } : { kind: "renderbuffer", object }]]));
    let reject = true;
    Object.assign(gl, { framebufferTexture2D: (fbTarget: number) => { if (reject && fbTarget === 0x8ca9) {
        reject = false;
        throw new Error("retarget rejected");
      } } });
    expect(checked(b, O.QOP_BOUND_IMAGE_TARGET, [kind, target, 1], 16)[0]).toBe(1);
    expect(b.imageRevisions.get(object)).toBe(1);
    expect(kind === 1 ? b.textureViews.get(object) : b.renderbufferViews.get(object)).toBe(oldView);
    b.imageRevisions.set(object, 0xffffffff);
    expect(checked(b, O.QOP_BOUND_IMAGE_TARGET, [kind, target, 1], 16)[0]).toBe(1);
    expect(b.imageRevisions.get(object)).toBe(0xffffffff);
    expect(kind === 1 ? b.textureViews.get(object) : b.renderbufferViews.get(object)).toBe(oldView);
  });
}

function storageRepairSetup(kind = 1) {
  const registry = new GlContextRegistry(), native = foreignTextureGl(), {gl} = native;
  registry.bind({pid:7,sessionId:11,cmdbufAddr:0,cmdbufLen:0});
  const b = registry.get(7,11)!; b.gl = gl; b.contextId = 21;
  const object = (kind === 1 ? gl.createTexture()! : gl.createRenderbuffer()!) as WebGLTexture & WebGLRenderbuffer;
  if (kind === 1) { b.textures.set(17,object); b.shadow.textureUnits[0] = object; gl.bindTexture(0x0de1,object); }
  else { b.rbos.set(17,object); b.shadow.renderbuffer = object; gl.bindRenderbuffer(0x8d41,object); }
  const first = gl.createTexture()!, second = gl.createTexture()!;
  registerImageSource(b,41,first,2,2); registerImageSource(b,42,second,2,2);
  const target = kind === 1 ? 0x0de1 : 0x8d41;
  return {registry,b,object,first,second,target,...native};
}
for (const kind of [1,2]) it(`retains peer storage rollback after the submitting context retires (kind ${kind})`, () => {
  const {registry,b,object,first,second,target,gl,frames,alive,control} = storageRepairSetup(kind);
  expect(checked(b,O.QOP_BOUND_IMAGE_TARGET,[kind,target,1],16)[0]).toBe(0);
  const oldView = kind === 1 ? b.textureViews.get(object) : b.renderbufferViews.get(object);
  registry.bind({pid:7,sessionId:12,cmdbufAddr:0,cmdbufLen:0}); const peer = registry.get(7,12)!;
  peer.gl = gl; peer.contextId = 22; expect(registry.shareObjects(7,12,11)).toBe(true);
  const sourceFrame = gl.createFramebuffer()!, peerFrame = gl.createFramebuffer()!;
  for (const [owner,frame] of [[b,sourceFrame],[peer,peerFrame]] as const) {
    owner.fbos.set(71,frame); owner.shadow.fbo = owner.shadow.readFbo = frame;
    owner.framebufferAttachments.set(frame,new Map([[0x8ce0,kind === 1 ? {kind:"texture",object,target,level:0} : {kind:"renderbuffer",object}]]));
    gl.bindFramebuffer(0x8d40,frame); gl.framebufferTexture2D(0x8d40,0x8ce0,0x0de1,first,0);
  }
  gl.bindFramebuffer(0x8d40,sourceFrame);
  const attach = gl.framebufferTexture2D.bind(gl), bindFrame = gl.bindFramebuffer.bind(gl);
  let rejected = false, block = true, deadBinds = 0, retired = false;
  gl.framebufferTexture2D = (fbTarget,point,texTarget,texture,level) => {
    if (!rejected && fbTarget === 0x8ca9 && texture === second && gl.getParameter(0x8ca6) === peerFrame) {
      rejected = true; control.fault = "framebufferTexture2D";
    } else if (rejected && block && texture === first) control.fault = "framebufferTexture2D";
    attach(fbTarget,point,texTarget,texture,level);
  };
  gl.bindFramebuffer = (selected,frame) => { if (retired && frame === sourceFrame) deadBinds++; bindFrame(selected,frame); };
  expect(checked(b,O.QOP_BOUND_IMAGE_TARGET,[kind,target,2],16)[0]).toBe(1);
  expect(rejected).toBe(true); expect(frames.get(sourceFrame)!.get(0x8ce0)).toBe(second);
  expect(b.imageRevisions.get(object)).toBe(1);
  expect(kind === 1 ? b.textureViews.get(object) : b.renderbufferViews.get(object)).toBe(oldView);
  const out = new Uint8Array(4).fill(0xa5);
  expect(runGlQuery(peer,O.QOP_GET_ERROR,new Uint8Array(),out)).toBe(-5);
  expect([...out]).toEqual([165,165,165,165]);
  registry.destroyContext(7,11); retired = true;
  expect(alive.has(sourceFrame)).toBe(false); expect(alive.has(peerFrame)).toBe(true);
  expect(runGlQuery(peer,O.QOP_GET_ERROR,new Uint8Array(),out)).toBe(-5);
  block = false;
  expect(runGlQuery(peer,O.QOP_GET_ERROR,new Uint8Array(),out)).toBe(4);
  expect(deadBinds).toBe(0); expect(frames.get(peerFrame)!.get(0x8ce0)).toBe(first);
  expect(peer.imageRevisions.get(object)).toBe(1);
  expect(checked(peer,O.QOP_IMAGE_TARGET,[kind,17,2])[0]).toBe(0);
  expect(frames.get(peerFrame)!.get(0x8ce0)).toBe(second);
  registry.destroyContext(7,12); gl.deleteTexture(first); gl.deleteTexture(second);
  expect(alive.size).toBe(0);
});

it("retains image utility restoration and partial candidate cleanup without duplicate deletion", () => {
  const {b,object,gl,alive,control} = storageRepairSetup();
  const read = gl.createFramebuffer()!, draw = gl.createFramebuffer()!;
  gl.bindFramebuffer(0x8ca8,read); gl.bindFramebuffer(0x8ca9,draw);
  const count = alive.size, create = gl.createTexture.bind(gl), bind = gl.bindFramebuffer.bind(gl);
  const destroyTexture = gl.deleteTexture.bind(gl), destroyFrame = gl.deleteFramebuffer.bind(gl);
  const deleted: object[] = []; let allocated = false, block = true, blockCleanup = true;
  gl.createTexture = () => { allocated = true; return create(); };
  gl.bindFramebuffer = (target,frame) => { if (allocated && block && target === 0x8ca8 && frame === read) control.fault = "bindFramebuffer"; bind(target,frame); };
  gl.deleteTexture = value => { deleted.push(value); destroyTexture(value); };
  gl.deleteFramebuffer = value => { if (blockCleanup && value !== read && value !== draw) control.fault = "deleteFramebuffer"; else deleted.push(value); destroyFrame(value); };
  expect(checked(b,O.QOP_BOUND_IMAGE_TARGET,[1,0x0de1,1],16)[0]).toBe(1);
  expect(b.textureViews.has(object)).toBe(false); expect(alive.size).toBe(count+2);
  const out = new Uint8Array(4).fill(0xa5);
  expect(runGlQuery(b,O.QOP_GET_ERROR,new Uint8Array(),out)).toBe(-5);
  block = false;
  expect(runGlQuery(b,O.QOP_GET_ERROR,new Uint8Array(),out)).toBe(-5);
  expect(deleted.length).toBe(1);
  expect(gl.getParameter(0x8069)).toBe(object); expect(gl.getParameter(0x8caa)).toBe(read); expect(gl.getParameter(0x8ca6)).toBe(draw);
  blockCleanup = false;
  expect(runGlQuery(b,O.QOP_GET_ERROR,new Uint8Array(),out)).toBe(4);
  expect(new Set(deleted).size).toBe(2); expect(deleted.length).toBe(2); expect(alive.size).toBe(count);
  expect(checked(b,O.QOP_BOUND_IMAGE_TARGET,[1,0x0de1,1],16)[0]).toBe(0);
});

it("keeps accepted image storage while retired native cleanup rejects and retries", () => {
  const {b,object,gl,alive,control} = storageRepairSetup();
  expect(checked(b,O.QOP_BOUND_IMAGE_TARGET,[1,0x0de1,1],16)[0]).toBe(0);
  const old = b.textureViews.get(object)!;
  const destroyFrame = gl.deleteFramebuffer.bind(gl), deleted: object[] = [];
  gl.deleteFramebuffer = value => { deleted.push(value); destroyFrame(value); };
  control.failDelete = true;
  expect(checked(b,O.QOP_BOUND_IMAGE_TARGET,[1,0x0de1,2],16)[0]).toBe(0);
  const accepted = b.textureViews.get(object)!;
  expect(accepted.source!.token).toBe(2); expect(b.imageRevisions.get(object)).toBe(2);
  expect(alive.has(old.native)).toBe(true); expect(alive.has(old.read!)).toBe(false);
  const out = new Uint8Array(4).fill(0xa5);
  expect(runGlQuery(b,O.QOP_GET_ERROR,new Uint8Array(),out)).toBe(-5);
  expect([...out]).toEqual([165,165,165,165]);
  control.failDelete = false;
  expect(runGlQuery(b,O.QOP_GET_ERROR,new Uint8Array(),out)).toBe(4);
  expect(b.textureViews.get(object)).toBe(accepted); expect(alive.has(old.native)).toBe(false);
  expect(deleted.filter(value => value === old.read).length).toBe(1);
});

it("reserves candidate native ownership before allocating a texture view", () => {
  const {b,object,gl,alive} = storageRepairSetup();
  const create = gl.createTexture.bind(gl), count = alive.size; let allocations = 0;
  gl.createTexture = () => { allocations++; return create(); };
  const OriginalSet = globalThis.Set;
  globalThis.Set = class extends OriginalSet { constructor() { super(); throw new RangeError("native ownership allocation failed"); } } as SetConstructor;
  try { expect(checked(b,O.QOP_BOUND_IMAGE_TARGET,[1,0x0de1,1],16)[0]).toBe(1); }
  finally { globalThis.Set = OriginalSet; }
  expect(allocations).toBe(0); expect(alive.size).toBe(count);
  expect(b.textureViews.has(object)).toBe(false); expect(b.imageRevisions.has(object)).toBe(false);
  expect(b.errors).toContain(0x505);
  expect(checked(b,O.QOP_BOUND_IMAGE_TARGET,[1,0x0de1,1],16)[0]).toBe(0);
});

it("reserves final image cleanup ownership before deleting any native resource", () => {
  const {b,object,gl,alive} = storageRepairSetup();
  expect(checked(b,O.QOP_BOUND_IMAGE_TARGET,[1,0x0de1,1],16)[0]).toBe(0);
  const view = b.textureViews.get(object)!, set = b.imageRetirements.set;
  b.imageRetirements.set = () => { throw new RangeError("retirement receipt allocation failed"); };
  try { expect(destroyTextureView(b,object)).toBe(false); }
  finally { b.imageRetirements.set = set; }
  expect(alive.has(view.native)).toBe(true); expect(alive.has(view.read!)).toBe(true);
  expect(b.textureViews.get(object)).toBe(view); expect(b.imageRetirements.size).toBe(0);
  expect(destroyTextureView(b,object)).toBe(true);
  expect(alive.has(view.native)).toBe(false); expect(alive.has(view.read!)).toBe(false);
});

it("keeps retired native cleanup errors separate from a reused session", () => {
  const {registry,b,gl,control} = storageRepairSetup();
  expect(checked(b,O.QOP_BOUND_IMAGE_TARGET,[1,0x0de1,1],16)[0]).toBe(0);
  const oldErrors = b.errors; control.failDelete = true;
  registry.destroyContext(7,11);
  expect(b.errors).not.toBe(oldErrors); expect(b.errors).toEqual([]);
  b.gl = gl; b.contextId = 23;
  const out = new Uint8Array(4).fill(0xa5);
  expect(runGlQuery(b,O.QOP_GET_ERROR,new Uint8Array(),out)).toBe(-5);
  expect(b.errors).toEqual([]); expect(oldErrors).toContain(0x500);
  control.failDelete = false;
  expect(runGlQuery(b,O.QOP_GET_ERROR,new Uint8Array(),out)).toBe(4);
  expect([...out]).toEqual([0,0,0,0]); expect(b.errors).toEqual([]);
});
