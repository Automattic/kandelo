import { expect, it } from "vitest";
import { GlContextRegistry } from "../src/webgl/registry.js";
import { decodeAndDispatch } from "../src/webgl/bridge.js";
import * as O from "../src/webgl/ops.js";

/* ES 2.0 section 2.9: a store the GL cannot create is OUT_OF_MEMORY. Buffer
 * offsets travel as i32, so a store beyond 0x7fffffff bytes could never be
 * addressed by later updates; it must not reach native allocation. */
class SizeGl {
  calls: [string, unknown[]][] = [];
  getError() { return 0; }
  getParameter() { return null; }
  createBuffer() { return {}; }
  bindBuffer(target: number, object: object | null) { this.calls.push(["bindBuffer",[target,object]]); }
  bufferData(target: number, size: number, usage: number) { this.calls.push(["bufferData",[target,size,usage]]); }
}

it("reports OUT_OF_MEMORY for a store the transport cannot address, before native allocation", () => {
  const registry = new GlContextRegistry(); registry.bind({pid:1,cmdbufAddr:0,cmdbufLen:64});
  const b = registry.get(1)!, gl = new SizeGl();
  b.gl = gl as unknown as WebGL2RenderingContext;
  const send = (op: number, words: number[]) => {
    const record = new Uint8Array(4+words.length*4), v = new DataView(record.buffer);
    v.setUint16(0,op,true); v.setUint16(2,words.length*4,true);
    words.forEach((word,i) => v.setUint32(4+i*4,word,true));
    b.cmdbufView = record; expect(decodeAndDispatch(b,0,record.length)).toBe(0);
  };
  send(O.OP_BIND_BUFFER,[0x8892,5]);
  const store = b.bufferStores.get(b.buffers.get(5)!)!;
  send(O.OP_BUFFER_DATA,[0x8892,0x80000000,0x88e4]);
  send(O.OP_BUFFER_DATA,[0x8892,0xffffffff,0x88e4]);
  expect(b.errors).toEqual([0x505]); expect(gl.calls.filter(([name]) => name === "bufferData")).toEqual([]);
  expect(store.size).toBe(0);
  send(O.OP_BUFFER_DATA,[0x8892,0x7fffffff,0x88e4]);
  expect(gl.calls.filter(([name]) => name === "bufferData")).toEqual([["bufferData",[0x8892,0x7fffffff,0x88e4]]]);
  expect(store.size).toBe(0x7fffffff);
});
