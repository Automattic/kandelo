/**
 * Unit tests for the BIND_FOREIGN_TEXTURE host upload path
 * (`host/src/webgl/foreign-texture.ts`). The kernel-side ioctl dispatch
 * is covered in Rust (drm_bind_foreign_texture_uploads_and_writes_
 * texture_id); these pin the TS half: texture-id allocation from
 * 0x40000000, texImage2D-then-texSubImage2D reuse, stride-aware upload
 * with GL state save/restore, and bo-lifetime cleanup.
 */
import { afterEach, describe, expect, it } from "vitest";
import { foreignTextureGl } from "./support/foreign-texture-gl.js";
import { runGlQuery } from "../src/webgl/query.js";
import { NativeGlFault, setNativeGlFaultReporter } from "../src/webgl/native-recovery.js";
import { textureNative } from "../src/webgl/image-storage.js";
import * as O from "../src/webgl/ops.js";
import { bindGpuForeignTexture, bindForeignTexture } from "../src/webgl/foreign-texture.js";
import { GlContextRegistry } from "../src/webgl/registry.js";
import type { GlBinding } from "../src/webgl/registry.js";

const GL_UNPACK_ROW_LENGTH = 0x0cf2;

afterEach(() => setNativeGlFaultReporter(null));
/** Run `run` with a fault reporter installed. Some production paths swallow
 * the thrown NativeGlFault into an error return; the reporter is what
 * latches the fault as fatal either way. */
function faultOutcome<T>(run: () => T): { faults: Error[]; thrown: unknown; result: T | undefined } {
  const faults: Error[] = [];
  let thrown: unknown, result: T | undefined;
  setNativeGlFaultReporter(fault => faults.push(fault));
  try { result = run(); } catch (error) { thrown = error; }
  finally { setNativeGlFaultReporter(null); }
  return { faults, thrown, result };
}
const REFUSED_RESTORE = /live renderer refused to restore native state after a rejected change/;
/** `failure` is the error return of a path that swallows the thrown fault,
 * or "throws" for a path that propagates it. */
function expectFault(outcome: { faults: Error[]; thrown: unknown; result: unknown }, message: RegExp,
    failure: unknown): void {
  expect(outcome.faults.length).toBeGreaterThanOrEqual(1);
  expect(outcome.faults[0]).toBeInstanceOf(NativeGlFault);
  expect(outcome.faults[0].message).toMatch(message);
  if (failure === "throws") expect(outcome.thrown).toBeInstanceOf(NativeGlFault);
  else if (outcome.thrown !== undefined) expect(outcome.thrown).toBeInstanceOf(NativeGlFault);
  else expect(outcome.result).toBe(failure);
}

function makeFakeGl() {
  // Sentinels the upload path must save and restore around itself —
  // it runs outside the muxer, on a context another user was driving.
  const state = {
    activeTexture: 0x84c2, // "unit 2 was active"
    binding2d: { name: "prev-tex" },
    unpackRowLength: 0,
    unpackAlignment: 4,
    unpackSkipRows: 0,
    unpackSkipPixels: 0,
  };
  const calls = {
    texImage2D: 0,
    texSubImage2D: 0,
    pixelStorei: [] as number[][],
    bindTexture: [] as unknown[],
    activeTexture: [] as number[],
    deletedTextures: [] as unknown[],
    uploadState: [] as [number, number, number, number][],
  };
  let texN = 0;
  const alive = new Set<object>();
  const bindings = new Map<number,unknown>([[0x84c0,state.binding2d],[0x84c2,{name:"active-tex"}]]);
  const gl = {
    getError: () => 0,
    TEXTURE0: 0x84c0,
    ACTIVE_TEXTURE: 0x84e0,
    TEXTURE_BINDING_2D: 0x8069,
    RGBA: 0x1908,
    UNSIGNED_BYTE: 0x1401,
    LINEAR: 0x2601,
    CLAMP_TO_EDGE: 0x812f,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    createTexture: () => { const tex = {id:++texN}; alive.add(tex); return tex; },
    deleteTexture: (t: object) => {
      calls.deletedTextures.push(t); alive.delete(t);
      for (const [unit,texture] of bindings) if (texture === t) bindings.set(unit,null);
    },
    getParameter: (p: number) =>
      p === 0x84e0
        ? state.activeTexture
        : p === GL_UNPACK_ROW_LENGTH
          ? state.unpackRowLength
          : p === 0x0cf5 ? state.unpackAlignment
            : p === 0x0cf3 ? state.unpackSkipRows
              : p === 0x0cf4 ? state.unpackSkipPixels : bindings.get(state.activeTexture) ?? null,
    activeTexture: (u: number) => { calls.activeTexture.push(u); state.activeTexture = u; },
    pixelStorei: (p: number, v: number) => {
      calls.pixelStorei.push([p, v]);
      if (p === 0x0cf2) state.unpackRowLength = v;
      if (p === 0x0cf5) state.unpackAlignment = v;
      if (p === 0x0cf3) state.unpackSkipRows = v;
      if (p === 0x0cf4) state.unpackSkipPixels = v;
    },
    bindTexture: (_target: number, tex: unknown) => { calls.bindTexture.push(tex); bindings.set(state.activeTexture,tex); },
    texParameteri: () => {},
    texImage2D: () => { calls.texImage2D++;
      calls.uploadState.push([state.unpackRowLength, state.unpackAlignment,
        state.unpackSkipRows, state.unpackSkipPixels]);
    },
    texSubImage2D: () => { calls.texSubImage2D++; },
  };
  return { gl: gl as unknown as WebGL2RenderingContext, calls, state, alive, bindings };
}

function makeBinding(gl: WebGL2RenderingContext | null): { reg: GlContextRegistry; b: GlBinding } {
  const reg = new GlContextRegistry();
  reg.bind({ pid: 7, cmdbufAddr: 0, cmdbufLen: 0 });
  const b = reg.get(7)!;
  b.gl = gl;
  return { reg, b };
}

describe("bindForeignTexture — BIND_FOREIGN_TEXTURE upload path", () => {
  it("first bind uploads at the bo stride, mirrors the id, and restores GL state", () => {
    const { gl, calls, state } = makeFakeGl();
    const { b } = makeBinding(gl);
    const dims = { w: 4, h: 2, stride: 32 }; // 8-px stride over a 4-px row
    const bytes = new Uint8Array(dims.stride * dims.h);

    const id = bindForeignTexture(b, 55, bytes, dims);
    expect(id).toBe(0x4000_0000);
    expect(calls.texImage2D).toBe(1);
    // The id is mirrored into the cmdbuf texture table so glBindTexture
    // in a subsequent submit resolves it.
    expect(b.textures.get(id)).toBe(b.foreignTextures.get(55)!.tex);
    // Rows upload at the bo stride, then unpack state resets.
    expect(calls.pixelStorei).toContainEqual([GL_UNPACK_ROW_LENGTH, 8]);
    expect(calls.pixelStorei.at(-2)).toEqual([GL_UNPACK_ROW_LENGTH, 0]);
    // The previously-bound texture and active unit are restored.
    expect(calls.bindTexture.at(-1)).toBe(state.binding2d);
    expect(calls.activeTexture.at(-1)).toBe(state.activeTexture);
  });

  it("rebind refreshes via texSubImage2D under a stable id; resize reallocates", () => {
    const { gl, calls } = makeFakeGl();
    const { b } = makeBinding(gl);
    const bytes = new Uint8Array(32 * 4);

    const id = bindForeignTexture(b, 55, bytes, { w: 4, h: 2, stride: 32 });
    expect(bindForeignTexture(b, 55, bytes, { w: 4, h: 2, stride: 32 })).toBe(id);
    expect(calls.texImage2D).toBe(1);
    expect(calls.texSubImage2D).toBe(1);

    expect(bindForeignTexture(b, 55, bytes, { w: 8, h: 4, stride: 32 })).toBe(id);
    expect(calls.texImage2D).toBe(2);
  });

  it("distinct bos get distinct ids", () => {
    const { gl } = makeFakeGl();
    const { b } = makeBinding(gl);
    const bytes = new Uint8Array(64);
    const a = bindForeignTexture(b, 1, bytes, { w: 2, h: 2, stride: 8 });
    const c = bindForeignTexture(b, 2, bytes, { w: 2, h: 2, stride: 8 });
    expect(a).toBe(0x4000_0000);
    expect(c).toBe(0x4000_0001);
  });

  it("rejects a sub-row stride (EINVAL) and a missing GL context (EIO)", () => {
    const { gl } = makeFakeGl();
    const { b } = makeBinding(gl);
    const bytes = new Uint8Array(64);
    expect(bindForeignTexture(b, 1, bytes, { w: 4, h: 2, stride: 12 })).toBe(-22);
    const { b: noGl } = makeBinding(null);
    expect(bindForeignTexture(noGl, 1, bytes, { w: 4, h: 2, stride: 16 })).toBe(-5);
  });

  it("restores a caller-set UNPACK_ROW_LENGTH instead of resetting it to 0", () => {
    // Row length isn't muxer-shadow-tracked, so a guest that set it via
    // pixelStorei would be silently clobbered by an interleaved foreign
    // upload unless the live value is queried and restored.
    const { gl, calls, state } = makeFakeGl();
    const { b } = makeBinding(gl);
    state.unpackRowLength = 5;
    bindForeignTexture(b, 55, new Uint8Array(64), { w: 4, h: 2, stride: 32 });
    expect(calls.pixelStorei.at(-2)).toEqual([GL_UNPACK_ROW_LENGTH, 5]);
  });

  it("unbind deletes the binding's foreign textures from the surviving context", () => {
    // The KMS canvas context outlives a dead compositor's binding (the
    // pump keeps using it), so unbind must free textures deterministically
    // rather than leave them to GC.
    const { gl, calls } = makeFakeGl();
    const { reg, b } = makeBinding(gl);
    const bytes = new Uint8Array(64);
    bindForeignTexture(b, 1, bytes, { w: 2, h: 2, stride: 8 });
    bindForeignTexture(b, 2, bytes, { w: 2, h: 2, stride: 8 });
    const texes = [b.foreignTextures.get(1)!.tex, b.foreignTextures.get(2)!.tex];

    reg.unbind(7);
    expect(calls.deletedTextures).toEqual(texes);
    expect(reg.get(7)).toBeUndefined();
  });

  it("dropForeignTexturesForBo deletes the texture and both mirror entries", () => {
    const { gl, calls } = makeFakeGl();
    const { reg, b } = makeBinding(gl);
    const bytes = new Uint8Array(64);
    const id = bindForeignTexture(b, 55, bytes, { w: 2, h: 2, stride: 8 });
    const tex = b.foreignTextures.get(55)!.tex;

    reg.dropForeignTexturesForBo(55);
    expect(calls.deletedTextures).toEqual([tex]);
    expect(b.foreignTextures.has(55)).toBe(false);
    expect(b.textures.has(id)).toBe(false);
  });
});

it("foreign uploads neutralize skips and restore the physical context's alignment", () => {
  const { gl, calls, state } = makeFakeGl();
  const { b } = makeBinding(gl);
  state.unpackAlignment = 8; state.unpackRowLength = 5;
  state.unpackSkipRows = 2; state.unpackSkipPixels = 3;
  b.shadow.unpackAlignment = 1; // A different guest last owned the context.
  expect(bindForeignTexture(b, 1, new Uint8Array(64), { w: 4, h: 2, stride: 32 })).toBeGreaterThan(0);
  expect(calls.uploadState).toEqual([[8,4,0,0]]);
  expect(state).toMatchObject({ unpackAlignment: 8, unpackRowLength: 5,
    unpackSkipRows: 2, unpackSkipPixels: 3 });
});

it("foreign upload failure restores state and rolls back a new texture", () => {
  const { gl, calls, state } = makeFakeGl();
  const { b } = makeBinding(gl);
  state.unpackRowLength = 5;
  gl.texImage2D = () => { throw new Error("context upload failure"); };
  expect(bindForeignTexture(b, 1, new Uint8Array(64), { w: 4, h: 2, stride: 32 })).toBe(-5);
  expect(state.unpackRowLength).toBe(5);
  expect(calls.bindTexture.at(-1)).toBe(state.binding2d);
  expect(calls.activeTexture.at(-1)).toBe(state.activeTexture);
  expect(calls.deletedTextures).toHaveLength(1);
  expect(b.foreignTextures.size).toBe(0);
  expect(b.textures.size).toBe(0);
});

it("skips realized public names and checks signed-result allocator exhaustion", () => {
  const {gl} = makeFakeGl(), {b} = makeBinding(gl), ordinary = {} as WebGLTexture;
  b.textures.set(0x40000000,ordinary); b.textures.set(0x40000001,ordinary);
  expect(bindForeignTexture(b,1,new Uint8Array(4),{w:1,h:1,stride:4})).toBe(0x40000002);
  expect(b.textures.get(0x40000000)).toBe(ordinary); expect(b.textures.get(0x40000001)).toBe(ordinary);
  b.nextForeignTexId = 0x80000000;
  expect(bindForeignTexture(b,2,new Uint8Array(4),{w:1,h:1,stride:4})).toBe(-12);
  expect(b.foreignTextures.has(2)).toBe(false);
});
it("revokes by object identity without deleting a replacement under the old number", () => {
  const {gl,calls} = makeFakeGl(), {reg,b} = makeBinding(gl);
  const id = bindForeignTexture(b,1,new Uint8Array(4),{w:1,h:1,stride:4}), old = b.textures.get(id)!;
  const replacement = {} as WebGLTexture; b.textures.set(id,replacement);
  expect(reg.dropForeignTexturesForBo(1)).toBe(true);
  expect(b.textures.get(id)).toBe(replacement); expect(calls.deletedTextures).toEqual([old]);
  expect(b.foreignTextureBos.size).toBe(0);
});
it("does not adopt the replacement when refreshing a stale raw cache", () => {
  const {gl} = makeFakeGl(), {reg,b} = makeBinding(gl);
  const id = bindForeignTexture(b,1,new Uint8Array(4),{w:1,h:1,stride:4}), old = b.textures.get(id)!;
  const replacement = {} as WebGLTexture; b.textures.set(id,replacement);
  const next = bindForeignTexture(b,1,new Uint8Array(4),{w:1,h:1,stride:4});
  expect(next).toBeGreaterThan(id); expect(b.textures.get(id)).toBe(replacement);
  expect(b.textures.get(next)).not.toBe(old); expect(b.foreignTextureBos.size).toBe(2);
  expect(reg.dropForeignTexturesForBo(1)).toBe(true); expect(b.textures.get(id)).toBe(replacement);
  expect(b.foreignTextureBos.size).toBe(0);
});
it("rejects new CPU uploads before binding when namespace metadata cannot be staged", () => {
  for (const field of ["textures","foreignTextures","foreignTextureBos"] as const) {
    const {gl,calls,state} = makeFakeGl(), {b} = makeBinding(gl), map = b[field], set = map.set;
    map.set = () => { throw new RangeError("allocation failed"); };
    try { expect(bindForeignTexture(b,1,new Uint8Array(4),{w:1,h:1,stride:4})).toBe(-5); } finally { map.set = set; }
    expect(b.textures.size).toBe(0); expect(b.foreignTextures.size).toBe(0); expect(b.foreignTextureBos.size).toBe(0);
    expect(calls.deletedTextures).toHaveLength(1); expect(calls.texImage2D).toBe(0);
    expect(calls.bindTexture).toEqual([]); expect(state.activeTexture).toBe(0x84c2);
  }
});
it("rejects a native CPU upload error and preserves binding and unpack state", () => {
  const {gl,calls,state} = makeFakeGl(), {b} = makeBinding(gl); let error = 0;
  gl.getError = () => { const value = error; error = 0; return value; };
  gl.texImage2D = () => { error = 0x501; };
  expect(bindForeignTexture(b,1,new Uint8Array(4),{w:1,h:1,stride:4})).toBe(-5);
  expect(b.textures.size).toBe(0); expect(b.errors).toEqual([0x501]); expect(calls.deletedTextures).toHaveLength(1);
  expect(calls.bindTexture.at(-1)).toBe(state.binding2d); expect(calls.activeTexture.at(-1)).toBe(state.activeTexture);
});

function gpuRawSetup() {
  const native=foreignTextureGl(), {gl}=native, reg=new GlContextRegistry();
  reg.bind({pid:7,sessionId:11,cmdbufAddr:0,cmdbufLen:64});const b=reg.get(7,11)!;b.gl=gl;b.contextId=21;
  expect(reg.createGpuBo(41,gl,2,2)).toBeGreaterThan(0);const gpu=reg.gpuBo(41)!;
  const query=(owner:GlBinding,op:number,words:number[])=>{
    const out=new Uint8Array(12);
    expect(runGlQuery(owner,op,new Uint8Array(new Uint32Array(words).buffer),out)).toBe(12);
    return [...new Uint32Array(out.buffer)];
  };
  return {...native,reg,b,gpu,query};
}
it("publishes a distinct GPU logical view without overwriting a realized public name",()=>{
  const {b,gpu,alive,gl}=gpuRawSetup(),ordinary=gl.createTexture()!;
  b.textures.set(gpu.texId,ordinary);
  const name=bindGpuForeignTexture(b,41,gpu),object=b.textures.get(name)!;
  expect(name).toBe(gpu.texId+1);expect(b.textures.get(gpu.texId)).toBe(ordinary);
  expect(object).not.toBe(gpu.tex);expect(textureNative(b,object)).not.toBe(gpu.tex);
  expect(b.textureViews.get(object)!.source!.texture).toBe(gpu.tex);expect(alive.has(gpu.tex)).toBe(true);
  expect(bindGpuForeignTexture(b,41,gpu)).toBe(name);expect(b.foreignTextureBos.get(object)).toBe(41);
});
it("keeps deleted GPU views distinct across reimport and revokes peers by identity",()=>{
  const {reg,b,gpu,gl,query,frames,alive}=gpuRawSetup();
  const first=bindGpuForeignTexture(b,41,gpu),old=b.textures.get(first)!;
  reg.bind({pid:7,sessionId:12,cmdbufAddr:0,cmdbufLen:64});const peer=reg.get(7,12)!;peer.gl=gl;peer.contextId=22;
  expect(reg.shareObjects(7,12,11)).toBe(true);
  query(peer,O.QOP_BIND_IMAGE_OBJECT,[1,0x0de1,first]);
  const fbo=gl.createFramebuffer()!;peer.fbos.set(42,fbo);peer.shadow.fbo=peer.shadow.readFbo=fbo;
  gl.bindFramebuffer(0x8d40,fbo);query(peer,O.QOP_IMAGE_ATTACHMENT,[1,0x8d40,0x8ce0,0x0de1,first,0]);
  query(b,O.QOP_IMAGE_OBJECT_DELETE,[1,first]);
  const next=bindGpuForeignTexture(b,41,gpu),fresh=b.textures.get(next)!;
  expect(next).toBeGreaterThan(first);expect(fresh).not.toBe(old);expect(alive.has(textureNative(b,old))).toBe(true);
  query(b,O.QOP_BIND_IMAGE_OBJECT,[1,0x0de1,first]);const replacement=b.textures.get(first)!;
  peer.shadow.textureUnits[1]=fresh;gl.activeTexture(0x84c1);gl.bindTexture(0x0de1,textureNative(b,fresh));
  expect(reg.dropForeignTexturesForBo(41)).toBe(true);
  expect(b.textures.get(first)).toBe(replacement);expect(b.textures.has(next)).toBe(false);
  expect(b.shadow.textureUnits[0]).toBe(replacement);expect(peer.shadow.textureUnits.slice(0,2)).toEqual([null,null]);
  expect(frames.get(fbo)!.get(0x8ce0)).toBeNull();expect(peer.framebufferAttachments.size).toBe(0);
  expect(gl.getParameter(0x84e0)).toBe(0x84c1);gl.activeTexture(0x84c0);
  expect(gl.getParameter(0x8069)).toBe(replacement);expect(alive.has(gpu.tex)).toBe(true);
  expect(b.foreignTextureBos.size).toBe(0);expect(b.retiredTextures.size).toBe(0);
});
it("retains canonical GPU backing after rejected revocation and completes a later retry",()=>{
  const {reg,b,gpu,gl,query,control,alive,frames}=gpuRawSetup();
  const name=bindGpuForeignTexture(b,41,gpu),object=b.textures.get(name)!;
  query(b,O.QOP_BIND_IMAGE_OBJECT,[1,0x0de1,name]);
  const fbo=gl.createFramebuffer()!;b.fbos.set(42,fbo);b.shadow.fbo=b.shadow.readFbo=fbo;
  gl.bindFramebuffer(0x8d40,fbo);query(b,O.QOP_IMAGE_ATTACHMENT,[1,0x8d40,0x8ce0,0x0de1,name,0]);
  control.fault="framebufferTexture2D";reg.retireForeignBo(41);
  expect(b.textures.get(name)).toBe(object);expect(b.shadow.textureUnits[0]).toBe(object);
  expect(frames.get(fbo)!.get(0x8ce0)).toBe(gpu.tex);expect(alive.has(gpu.tex)).toBe(true);
  expect(reg.retireForeignBo(41)).toBe(true);
  expect(b.textures.has(name)).toBe(false);expect(b.foreignTextureBos.size).toBe(0);expect(alive.has(gpu.tex)).toBe(false);
});
it("faults when the live renderer refuses a canonical BO deletion after all raw views have retired",()=>{
  const {reg,control}=gpuRawSetup();control.fault="deleteFramebuffer";
  const outcome=faultOutcome(()=>reg.retireForeignBo(41));
  expectFault(outcome,/live renderer refused deleteFramebuffer/,"throws");expect(outcome.thrown).toBe(outcome.faults[0]);
});
it("finds raw BO views in execution groups after their public context was replaced",()=>{
  const {reg,b,gl,alive}=gpuRawSetup();bindGpuForeignTexture(b,41,reg.gpuBo(41)!);
  const group=b.objects,guard={context:gl,prepareRetirement:()=>true};
  const lease=reg.retainContextExecution(7,11,guard)!;expect(lease).not.toBeNull();
  reg.destroyContext(7,11);expect(reg.get(7,11)).not.toBe(b);expect(group.foreignTextureBos.size).toBe(1);
  reg.retireForeignBo(41);expect(group.foreignTextureBos.size).toBe(0);
  expect(lease.release()).toBe(true);reg.unbind(7);expect(alive.size).toBe(0);
});

for (const fault of ["texture","active","unit-zero","row-length","alignment","skip-rows","skip-pixels"]) {
  it(`faults when the live renderer refuses CPU upload ${fault} restoration`, () => {
    const {gl,calls,state} = makeFakeGl(), {b} = makeBinding(gl);
    state.unpackRowLength = 5; state.unpackAlignment = 8; state.unpackSkipRows = 2; state.unpackSkipPixels = 3;
    const previous = {...state};
    const active = gl.activeTexture.bind(gl), bind = gl.bindTexture.bind(gl), pixel = gl.pixelStorei.bind(gl);
    const upload = gl.texImage2D.bind(gl);
    let uploaded = false;
    const reject = (selected: string) => { if (uploaded && fault === selected) throw new Error("restore rejected"); };
    gl.texImage2D = ((...args: Parameters<typeof gl.texImage2D>) => { upload(...args); uploaded = true; }) as typeof gl.texImage2D;
    gl.activeTexture = value => { reject(value === 0x84c2 ? "active" : "unit-zero"); active(value); };
    gl.bindTexture = (target,object) => { if (object === previous.binding2d) reject("texture"); bind(target,object); };
    gl.pixelStorei = (pname,value) => {
      const restore = new Map([[0x0cf2,[5,"row-length"]],[0x0cf5,[8,"alignment"]],[0x0cf3,[2,"skip-rows"]],[0x0cf4,[3,"skip-pixels"]]]).get(pname);
      if (restore && value === restore[0]) reject(String(restore[1])); pixel(pname,value);
    };
    const outcome = faultOutcome(() => bindForeignTexture(b,1,new Uint8Array(4),{w:1,h:1,stride:4}));
    expectFault(outcome,REFUSED_RESTORE,-5);
    expect(calls.texImage2D).toBe(1); expect(b.textures.size).toBe(0); expect(b.foreignTextures.size).toBe(0);
  });
}

it("restores the active unit when nested CPU utility reservation rejects before upload", () => {
  const {gl,state,calls,alive} = makeFakeGl(), {b} = makeBinding(gl), set = WeakMap.prototype.set;
  let reservations = 0, rc = 0;
  WeakMap.prototype.set = function(key,value) { if (++reservations === 3) throw new RangeError("nested inverse reservation failed"); return set.call(this,key,value); };
  try { rc = bindForeignTexture(b,1,new Uint8Array(4),{w:1,h:1,stride:4}); }
  finally { WeakMap.prototype.set = set; }
  expect(reservations).toBe(3); expect(rc).toBe(-5); expect(state.activeTexture).toBe(0x84c2);
  expect(calls.texImage2D).toBe(0); expect(calls.deletedTextures).toHaveLength(1); expect(alive.size).toBe(0); expect(b.textures.size).toBe(0);
});

for (const gpu of [false,true]) {
  it(`faults when the live renderer refuses deleting a ${gpu ? "GPU" : "CPU"} raw candidate after a creation error`, () => {
    const {gl} = makeFakeGl(), {b} = makeBinding(gl), create = gl.createTexture.bind(gl); let error = 0;
    gl.getError = () => { const result = error; error = 0; return result; };
    gl.createTexture = () => { const object = create(); error = 0x505; return object; };
    gl.deleteTexture = () => { error = 0x502; };
    const outcome = faultOutcome(() => gpu ? bindGpuForeignTexture(b,1,{tex:{} as WebGLTexture,texId:17,w:1,h:1})
      : bindForeignTexture(b,1,new Uint8Array(4),{w:1,h:1,stride:4}));
    expectFault(outcome,/live renderer refused deleteTexture/,"throws"); expect(b.textures.size).toBe(0);
  });
  it(`reserves ${gpu ? "GPU" : "CPU"} raw candidate ownership before native allocation`, () => {
    const {gl,alive} = makeFakeGl(), {b} = makeBinding(gl), original = globalThis.Set;
    globalThis.Set = class extends original { constructor() { super(); throw new RangeError("ownership allocation failed"); } } as SetConstructor;
    let rc = 0;
    try { rc = gpu ? bindGpuForeignTexture(b,1,{tex:{} as WebGLTexture,texId:17,w:1,h:1})
      : bindForeignTexture(b,1,new Uint8Array(4),{w:1,h:1,stride:4}); } finally { globalThis.Set = original; }
    expect(rc).toBe(-12); expect(alive.size).toBe(0); expect(b.textures.size).toBe(0);
  });
  it(`faults when the live renderer refuses ${gpu ? "GPU" : "CPU"} raw cleanup after namespace staging rejects`, () => {
    for (const field of ["textures","foreignTextures","foreignTextureBos"] as const) {
      const {gl,calls} = makeFakeGl(), {b} = makeBinding(gl), set = b[field].set;
      gl.deleteTexture = () => { throw new Error("delete rejected"); };
      b[field].set = () => { throw new RangeError("metadata allocation failed"); };
      let outcome;
      try {
        outcome = faultOutcome(() => gpu ? bindGpuForeignTexture(b,1,{tex:{} as WebGLTexture,texId:17,w:1,h:1})
          : bindForeignTexture(b,1,new Uint8Array(4),{w:1,h:1,stride:4}));
      } finally { b[field].set = set; }
      expectFault(outcome,/live renderer refused deleteTexture/,"throws");
      expect(b.textures.size).toBe(0); expect(b.foreignTextures.size).toBe(0); expect(b.foreignTextureBos.size).toBe(0);
      expect(calls.texImage2D).toBe(0); expect(calls.bindTexture).toHaveLength(0);
    }
  });
}

it("faults when the live renderer refuses GPU carrier initialization restoration", () => {
  const {gl,b,gpu,control} = gpuRawSetup(), previous = gl.createTexture()!;
  gl.activeTexture(0x84c2); gl.bindTexture(0x0de1,previous);
  const bind = gl.bindTexture.bind(gl), parameter = gl.texParameteri.bind(gl); let initialized = false;
  gl.texParameteri = (target,pname,value) => { parameter(target,pname,value); initialized = true; };
  gl.bindTexture = (target,object) => { if (initialized && object === previous) control.fault = "bindTexture"; bind(target,object); };
  const outcome = faultOutcome(() => bindGpuForeignTexture(b,41,gpu));
  expectFault(outcome,REFUSED_RESTORE,-12);
  expect(b.textures.size).toBe(0); expect(b.foreignTextureBos.size).toBe(0);
});

it("faults when the live renderer refuses raw GPU carrier cleanup after rejected image metadata", () => {
  const {b,gpu,control} = gpuRawSetup(), set = b.textureViews.set;
  b.textureViews.set = () => { throw new RangeError("image view allocation failed"); }; control.failDelete = true;
  let outcome;
  try { outcome = faultOutcome(() => bindGpuForeignTexture(b,41,gpu)); } finally { b.textureViews.set = set; }
  expectFault(outcome,/live renderer refused deleteTexture/,"throws");
  expect(b.textures.size).toBe(0); expect(b.foreignTextures.size).toBe(0); expect(b.foreignTextureBos.size).toBe(0);
});

it("faults when the live renderer refuses obsolete GPU carrier cleanup after a successful view transfer", () => {
  const {b,gpu,control} = gpuRawSetup();
  control.failDelete = true;
  const outcome = faultOutcome(() => bindGpuForeignTexture(b,41,gpu));
  expectFault(outcome,/live renderer refused deleteTexture/,"throws");
});

function revocationSetup() {
  const setup = gpuRawSetup(), {reg,b,gl,gpu,query} = setup;
  const name = bindGpuForeignTexture(b,41,gpu), object = b.textures.get(name)!, native = textureNative(b,object);
  reg.bind({pid:7,sessionId:12,cmdbufAddr:0,cmdbufLen:64}); const peer = reg.get(7,12)!; peer.gl = gl; peer.contextId = 22;
  expect(reg.shareObjects(7,12,11)).toBe(true);
  const frames = [gl.createFramebuffer()!,gl.createFramebuffer()!];
  for (const [index,owner] of [b,peer].entries()) {
    const frame = frames[index]; owner.fbos.set(70+index,frame); owner.shadow.fbo = owner.shadow.readFbo = frame;
    gl.bindFramebuffer(0x8d40,frame); query(owner,O.QOP_IMAGE_ATTACHMENT,[1,0x8d40,0x8ce0,0x0de1,name,0]);
    owner.shadow.textureUnits[index] = object; gl.activeTexture(0x84c0+index); gl.bindTexture(0x0de1,native);
  }
  const unrelated = gl.createTexture()!;
  gl.activeTexture(0x84c2); gl.bindTexture(0x0de1,unrelated);
  gl.bindFramebuffer(0x8ca9,frames[0]); gl.bindFramebuffer(0x8ca8,frames[1]);
  return {...setup,peer,name,object,native,framebuffers:frames,unrelated};
}
function blockedRevocationQueries(b: GlBinding, peer: GlBinding) {
  for (const owner of [b,peer]) {
    const out = new Uint8Array(4).fill(0xa5);
    expect(runGlQuery(owner,O.QOP_GET_ERROR,new Uint8Array(),out)).toBe(-5);
    expect([...out]).toEqual([165,165,165,165]);
  }
}

it("faults when the live renderer refuses raw BO attachment restoration during revocation", () => {
  const {reg,b,peer,gl,gpu,control,framebuffers,name,object} = revocationSetup();
  const attach = gl.framebufferTexture2D.bind(gl); let rejected = false;
  gl.framebufferTexture2D = (target,point,imageTarget,texture,level) => {
    const frame = gl.getParameter(0x8ca6);
    if (!rejected && frame === framebuffers[1] && !texture) { rejected = true; control.fault = "framebufferTexture2D"; }
    else if (rejected && frame === framebuffers[0] && texture === gpu.tex) control.fault = "framebufferTexture2D";
    attach(target,point,imageTarget,texture,level);
  };
  const outcome = faultOutcome(() => reg.retireForeignBo(41));
  expect(rejected).toBe(true); expectFault(outcome,REFUSED_RESTORE,false);
  expect(b.textures.get(name)).toBe(object); expect(peer.shadow.textureUnits[1]).toBe(object);
});

it("faults when the live renderer refuses raw BO texture-unit restoration during revocation", () => {
  const {reg,b,peer,gl,control,native,object} = revocationSetup();
  const bind = gl.bindTexture.bind(gl); let rejected = false;
  gl.bindTexture = (target,texture) => {
    const unit = gl.getParameter(0x84e0);
    if (!rejected && unit === 0x84c1 && !texture) { rejected = true; control.fault = "bindTexture"; }
    else if (rejected && unit === 0x84c0 && texture === native) control.fault = "bindTexture";
    bind(target,texture);
  };
  const outcome = faultOutcome(() => reg.retireForeignBo(41));
  expect(rejected).toBe(true); expectFault(outcome,REFUSED_RESTORE,false);
  expect(b.shadow.textureUnits[0]).toBe(object); expect(peer.shadow.textureUnits[1]).toBe(object);
});

it("faults when the live renderer refuses active-unit restoration after a rejected unit capture", () => {
  const {reg,b,gl,gpu,frames,framebuffers,control,object} = revocationSetup();
  const get = gl.getParameter.bind(gl), active = gl.activeTexture.bind(gl); let rejected = false;
  gl.getParameter = (pname: number) => {
    if (!rejected && pname === 0x8069 && get(0x84e0) === 0x84c1) { rejected = true; throw new Error("capture rejected"); }
    return get(pname);
  };
  gl.activeTexture = unit => { if (rejected && unit === 0x84c2) control.fault = "activeTexture"; active(unit); };
  const outcome = faultOutcome(() => reg.retireForeignBo(41));
  expect(rejected).toBe(true); expectFault(outcome,REFUSED_RESTORE,"throws");
  expect(b.shadow.textureUnits[0]).toBe(object);
  for (const frame of framebuffers) expect(frames.get(frame)!.get(0x8ce0)).toBe(gpu.tex);
});


for (const fault of ["draw","read","active"]) it(`faults when the live renderer refuses raw BO detachment ${fault} finalization`, () => {
  const {reg,b,peer,gl,control,framebuffers,object} = revocationSetup();
  const texture = gl.bindTexture.bind(gl), frame = gl.bindFramebuffer.bind(gl), active = gl.activeTexture.bind(gl);
  let detached = false;
  gl.bindTexture = (target,value) => { texture(target,value); if (gl.getParameter(0x84e0) === 0x84c1 && !value) detached = true; };
  gl.bindFramebuffer = (target,value) => {
    if (detached && ((fault === "draw" && target === 0x8ca9 && value === framebuffers[0]) ||
        (fault === "read" && target === 0x8ca8 && value === framebuffers[1]))) control.fault = "bindFramebuffer";
    frame(target,value);
  };
  gl.activeTexture = value => { if (detached && fault === "active" && value === 0x84c2) control.fault = "activeTexture"; active(value); };
  const outcome = faultOutcome(() => reg.retireForeignBo(41));
  expect(detached).toBe(true); expectFault(outcome,REFUSED_RESTORE,false);
  expect(b.shadow.textureUnits[0]).toBe(object); expect(peer.shadow.textureUnits[1]).toBe(object);
});

it("reserves raw BO mutation rollback after unit capture before detaching shared references", () => {
  const {reg,b,peer,gl,gpu,frames,framebuffers,object}=revocationSetup(),map=Array.prototype.map;
  let reservations=0;
  // The stable renderer stack cell no longer allocates on each publication;
  // refuse the second real inverse-list reservation after unit capture.
  Array.prototype.map=function(callback,thisArg){
    if(this[0]?.restore&&++reservations===2)throw new RangeError("mutation inverse reservation failed");
    return map.call(this,callback,thisArg);
  };
  try{reg.retireForeignBo(41);}finally{Array.prototype.map=map;}
  expect(reservations).toBe(2); expect(b.shadow.textureUnits[0]).toBe(object);
  for (const frame of framebuffers) expect(frames.get(frame)!.get(0x8ce0)).toBe(gpu.tex);
  expect(gl.getParameter(0x84e0)).toBe(0x84c2); expect(peer.shadow.textureUnits[1]).toBe(object);
  expect(reg.retireForeignBo(41)).toBe(true);
});



