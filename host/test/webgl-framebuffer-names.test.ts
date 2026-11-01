import { expect, it } from "vitest";
import { GlContextRegistry } from "../src/webgl/registry.js";
import { decodeAndDispatch } from "../src/webgl/bridge.js";
import { runGlQuery } from "../src/webgl/query.js";
import * as O from "../src/webgl/ops.js";

/* ES 2.0 section 4.4.1: GenFramebuffers returns names that are not yet
 * framebuffer objects. The object is created by the first BindFramebuffer
 * of the name, whether or not the name came from GenFramebuffers. */
class FramebufferGl {
  created: object[] = [];
  deleted: object[] = [];
  bound = new Map<number, object | null>();
  getError() { return 0; }
  isContextLost() { return false; }
  createFramebuffer() { const object = {}; this.created.push(object); return object; }
  deleteFramebuffer(object: object) { this.deleted.push(object); }
  bindFramebuffer(target: number, object: object | null) {
    if (target === 0x8d40 || target === 0x8ca9) this.bound.set(0x8ca9,object);
    if (target === 0x8d40 || target === 0x8ca8) this.bound.set(0x8ca8,object);
  }
  isFramebuffer(object: object) { return this.created.includes(object) && !this.deleted.includes(object); }
}

function setup() {
  const registry = new GlContextRegistry(); registry.bind({pid:1,cmdbufAddr:0,cmdbufLen:256});
  const b = registry.get(1)!, gl = new FramebufferGl();
  b.gl = gl as unknown as WebGL2RenderingContext;
  const send = (op: number, words: number[]) => {
    const record = new Uint8Array(4+words.length*4), v = new DataView(record.buffer);
    v.setUint16(0,op,true); v.setUint16(2,words.length*4,true);
    words.forEach((word,i) => v.setUint32(4+i*4,word,true));
    b.cmdbufView = record; expect(decodeAndDispatch(b,0,record.length)).toBe(0);
  };
  const isFramebuffer = (name: number) => {
    const out = new Uint8Array(12);
    expect(runGlQuery(b,O.QOP_IS_OBJECT,new Uint8Array(new Uint32Array([3,name]).buffer),out)).toBeGreaterThan(0);
    const reply = new DataView(out.buffer);
    expect(reply.getUint32(0,true)).toBe(0);
    return reply.getUint32(4,true) === 1;
  };
  return {b,gl,send,isFramebuffer};
}

it("reserves generated framebuffer names and creates each object at its first bind", () => {
  const {b,gl,send,isFramebuffer} = setup();
  send(O.OP_GEN_FRAMEBUFFERS,[2,7,8]);
  expect(gl.created).toEqual([]); expect(b.fbos.size).toBe(0);
  expect(isFramebuffer(7)).toBe(false);
  send(O.OP_BIND_FRAMEBUFFER,[0x8d40,7]);
  expect(gl.created).toHaveLength(1); expect(b.fbos.get(7)).toBe(gl.created[0]);
  expect(b.shadow.fbo).toBe(gl.created[0]);
  expect(isFramebuffer(7)).toBe(true); expect(isFramebuffer(8)).toBe(false);
  expect(b.errors).toEqual([]);
});

it("never replaces a framebuffer that a bind already created for the generated name", () => {
  const {b,gl,send} = setup();
  send(O.OP_BIND_FRAMEBUFFER,[0x8d40,5]);
  const object = b.fbos.get(5)!;
  send(O.OP_GEN_FRAMEBUFFERS,[1,5]);
  expect(b.fbos.get(5)).toBe(object); expect(gl.created).toEqual([object]); expect(gl.deleted).toEqual([]);
  send(O.OP_BIND_FRAMEBUFFER,[0x8d40,0]); send(O.OP_BIND_FRAMEBUFFER,[0x8d40,5]);
  expect(b.shadow.fbo).toBe(object); expect(gl.created).toEqual([object]);
  expect(b.errors).toEqual([]);
});

it("deletes a generated but never bound name without native effects", () => {
  const {b,gl,send} = setup();
  send(O.OP_GEN_FRAMEBUFFERS,[1,9]); send(O.OP_DELETE_FRAMEBUFFERS,[1,9]);
  expect(gl.created).toEqual([]); expect(gl.deleted).toEqual([]); expect(b.errors).toEqual([]);
});
