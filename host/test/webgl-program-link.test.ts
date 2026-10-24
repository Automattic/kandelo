import { describe, expect, it } from "vitest";
import { decodeAndDispatch } from "../src/webgl/bridge.js";
import { GlMuxer } from "../src/webgl/muxer.js";
import * as O from "../src/webgl/ops.js";
import { runGlQuery } from "../src/webgl/query.js";
import { GlContextRegistry } from "../src/webgl/registry.js";
import { linkProgramRetainingExecutable, useProgramIfAccepted } from "../src/webgl/program-objects.js";

type Shader = { compiled: boolean; deleted: boolean };
type Program = { linked: boolean; shaders: Set<Shader>; attributes: Map<string, number> };

/** WebGL model: relinking a native program destroys its previous executable.
 * Drawing evidence belongs to the rendered browser test, not this model. */
class NativePrograms {
  current: Program | null = null;
  deleted = new Set<Program>();
  deletions = new Map<Program, number>();
  error = 0;
  failCreate = false;
  uniformWrites = 0;
  uniformValue: unknown = new Float32Array([0.25,-1.75,2.5,1]);
  getUniform() { return this.uniformValue; }
  createShader() { return { compiled: true, deleted: false }; }
  createProgram(): Program | null {
    if (this.failCreate) { this.error = 0x505; return null; }
    return { linked: false, shaders: new Set(), attributes: new Map() };
  }
  attachShader(p: Program, s: Shader) {
    if (s.deleted) this.error = 0x501;
    else p.shaders.add(s);
  }
  bindAttribLocation(p: Program, index: number, name: string) { p.attributes.set(name, index); }
  linkProgram(p: Program) { p.linked = p.shaders.size === 2 && [...p.shaders].every(s => s.compiled); }
  getProgramParameter(p: Program, name: number) { return name === 0x8b82 ? p.linked : 0; }
  useProgram(p: Program | null) {
    if (p && (!p.linked || this.deleted.has(p))) this.error = 0x502;
    else this.current = p;
  }
  getError() { const error = this.error; this.error = 0; return error; }
  getParameter(name: number) { return name === 0x8b8d ? this.current : 0; }
  deleteProgram(p: Program) {
    this.deleted.add(p);
    this.deletions.set(p, (this.deletions.get(p) ?? 0) + 1);
  }
  deleteShader(s: Shader) { s.deleted = true; }
  uniform1f() { this.uniformWrites++; }
}

function setup() {
  const native = new NativePrograms();
  const gl = new Proxy(native, {
    get(target, key) {
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value ?? (() => {});
    },
  }) as unknown as WebGL2RenderingContext;
  const registry = new GlContextRegistry();
  registry.bind({ pid: 1, cmdbufAddr: 0, cmdbufLen: 4096 });
  const b = registry.get(1)!;
  b.gl = gl;
  b.cmdbufView = new Uint8Array(4096);
  const send = (op: number, words: number[], text = "") => {
    const bytes = new TextEncoder().encode(text);
    const view = new DataView(b.cmdbufView!.buffer);
    view.setUint16(0, op, true);
    view.setUint16(2, words.length * 4 + bytes.length, true);
    words.forEach((word, i) => view.setUint32(4 + i * 4, word, true));
    b.cmdbufView!.set(bytes, 4 + words.length * 4);
    expect(decodeAndDispatch(b, 0, 4 + words.length * 4 + bytes.length)).toBe(0);
  };
  const query = (op: number, words: number[] = []) => {
    const input = new Uint8Array(words.length * 4), output = new Uint8Array(4);
    words.forEach((word, i) => new DataView(input.buffer).setUint32(i * 4, word, true));
    expect(runGlQuery(b, op, input, output)).toBe(4);
    return new DataView(output.buffer).getUint32(0, true);
  };
  send(O.OP_CREATE_SHADER, [0x8b31, 10]);
  send(O.OP_CREATE_SHADER, [0x8b30, 11]);
  send(O.OP_CREATE_PROGRAM, [20]);
  send(O.OP_ATTACH_SHADER, [20, 10]);
  send(O.OP_ATTACH_SHADER, [20, 11]);
  send(O.OP_BIND_ATTRIB_LOCATION, [20, 3, 8], "position");
  send(O.OP_LINK_PROGRAM, [20]);
  send(O.OP_USE_PROGRAM, [20]);
  const original = native.current!;
  b.uniformLocations.set(1, {} as WebGLUniformLocation);
  b.uniformLocationPrograms.set(1, 20);
  return { b, gl, native, registry, send, query, original };
}

describe("program link attempts and installed executables", () => {
  function sharePeer(parent: ReturnType<typeof setup>) {
    parent.b.contextId = 21;
    parent.registry.bind({pid:1,sessionId:12,cmdbufAddr:0,cmdbufLen:32});
    const peer = parent.registry.get(1,12)!;
    peer.gl = parent.gl; peer.contextId = 22;
    peer.cmdbufView = new Uint8Array(32);
    expect(parent.registry.shareObjects(1,12,0)).toBe(true);
    return peer;
  }

  function uniformReply(b: ReturnType<typeof setup>["b"], name=20, location=1, integer=0) {
    const input = new Uint8Array(12), reply = new Uint8Array(76).fill(0xaa);
    [name,location,integer].forEach((word,i)=>new DataView(input.buffer).setUint32(i*4,word,true));
    expect(runGlQuery(b,O.QOP_GET_UNIFORM_VALUES,input,reply)).toBe(76);
    const v=new DataView(reply.buffer), count=v.getUint32(4,true);
    expect(v.getUint32(72,true)).toBe(0x47514c33);
    return {status:v.getUint32(0,true),count,values:Array.from({length:count},(_,i)=>integer?v.getInt32(8+i*4,true):v.getFloat32(8+i*4,true)),reply};
  }
  it.each([1,2,3,4,9,16])("gets %s uniform values without prior C reflection and through a shared peer",count=>{
    const parent=setup(),peer=sharePeer(parent);
    parent.native.uniformValue=new Float32Array(Array.from({length:count},(_,i)=>i+.25));
    const result=uniformReply(peer);
    expect(result.status).toBe(0);expect(result.count).toBe(count);
    expect(result.values).toEqual([...parent.native.uniformValue as Float32Array]);
    expect([...result.reply.slice(8+count*4,72)]).toEqual(new Array((16-count)*4).fill(0));
  });
  it("converts uniform booleans and rounds float results for integer getters",()=>{
    const {b,native}=setup();native.uniformValue=[true,false,true,false];
    expect(uniformReply(b,20,1,1).values).toEqual([1,0,1,0]);
    native.uniformValue=new Float32Array([.25,-1.75,2.5,1]);
    expect(uniformReply(b,20,1,1).values).toEqual([0,-2,3,1]);
  });
  it("checks program type, link state and location ownership without publishing failed values",()=>{
    const {b,native,original}=setup();
    for(const [name,location,error] of [[0,1,0x501],[10,1,0x502],[20,-1,0x502],[20,99,0x502]]) {
      const result=uniformReply(b,name,location);expect(result.status).toBe(1);expect(result.count).toBe(0);expect(b.errors.pop()).toBe(error);
    }
    b.uniformLocationPrograms.set(1,99);expect(uniformReply(b).status).toBe(1);expect(b.errors.pop()).toBe(0x502);
    b.uniformLocationPrograms.set(1,20);original.linked=false;expect(uniformReply(b).status).toBe(1);expect(b.errors.pop()).toBe(0x502);
    original.linked=true;native.getUniform=()=>{native.error=0x502;return new Float32Array(16).fill(42);};
    expect(uniformReply(b).status).toBe(1);expect(b.errors.pop()).toBe(0x502);
  });
  it("invalidates shared locations after successful peer relink and rejects failed link queries",()=>{
    const parent=setup(),peer=sharePeer(parent);
    (peer.shaders.get(11) as unknown as Shader).compiled=false;
    linkProgramRetainingExecutable(peer,20);expect(uniformReply(parent.b).status).toBe(1);expect(parent.b.errors.pop()).toBe(0x502);
    (peer.shaders.get(11) as unknown as Shader).compiled=true;
    linkProgramRetainingExecutable(peer,20);expect(parent.b.uniformLocations.has(1)).toBe(false);
    expect(uniformReply(parent.b).status).toBe(1);expect(parent.b.errors.pop()).toBe(0x502);
  });
  it("rejects malformed uniform requests before writing and rejects impossible native widths",()=>{
    const {b,native}=setup();const input=new Uint8Array(12),reply=new Uint8Array(76).fill(0xaa);
    new DataView(input.buffer).setUint32(8,2,true);
    expect(runGlQuery(b,O.QOP_GET_UNIFORM_VALUES,input,reply)).toBe(-22);
    expect(runGlQuery(b,O.QOP_GET_UNIFORM_VALUES,input.slice(0,8),reply)).toBe(-22);
    expect(runGlQuery(b,O.QOP_GET_UNIFORM_VALUES,new Uint8Array(12),reply.slice(0,75))).toBe(-22);
    expect([...reply]).toEqual(new Array(76).fill(0xaa));
    native.uniformValue=new Float32Array(17);expect(uniformReply(b).status).toBe(1);expect(b.errors.pop()).toBe(0x502);
  });

  it("retains a deleted shared program until every current owner releases it", () => {
    const parent = setup(), peer = sharePeer(parent);
    useProgramIfAccepted(peer,20);
    const view = new DataView(peer.cmdbufView!.buffer);
    view.setUint16(0,O.OP_DELETE_PROGRAM,true); view.setUint16(2,4,true); view.setUint32(4,20,true);
    expect(decodeAndDispatch(peer,0,8)).toBe(0);
    useProgramIfAccepted(peer,0);
    expect(parent.native.deleted.has(parent.original)).toBe(false);
    expect(peer.programs.has(20)).toBe(true);
    parent.registry.destroyContext(1,0);
    expect(parent.native.deletions.get(parent.original)).toBe(1);
    expect(peer.programs.has(20)).toBe(false);
    parent.registry.destroyContext(1,12);
    expect(parent.native.deletions.get(parent.original)).toBe(1);
  });

  it("keeps another context's executable through a peer's failed relink and final retirement", () => {
    const parent = setup(), peer = sharePeer(parent);
    (peer.shaders.get(11) as unknown as Shader).compiled = false;
    linkProgramRetainingExecutable(peer,20);
    expect(peer.programs.get(20)).not.toBe(parent.original);
    expect(parent.original.linked).toBe(true);
    expect(parent.b.currentProgram).toBe(parent.original);
    expect(parent.native.deleted.has(parent.original)).toBe(false);
    (peer.shaders.get(11) as unknown as Shader).compiled = true;
    linkProgramRetainingExecutable(peer,20); useProgramIfAccepted(peer,20);
    const replacement = peer.currentProgram as unknown as Program;
    parent.registry.destroyContext(1,0);
    expect(parent.native.deletions.get(parent.original)).toBe(1);
    expect(peer.currentProgram).toBe(replacement);
    parent.registry.destroyContext(1,12);
    expect(parent.native.deletions.get(replacement)).toBe(1);
  });

  it("retains the current executable after failed relink and an owner switch", () => {
    const { b, gl, native, send, query, original } = setup();
    (b.shaders.get(11) as unknown as Shader).compiled = false;
    send(O.OP_LINK_PROGRAM, [20]);
    expect(query(O.QOP_GET_PROGRAMIV, [20, 0x8b82])).toBe(0);
    expect(query(O.QOP_GET_INTEGERV, [0x8b8d])).toBe(20);
    expect(original.linked).toBe(true);
    expect(native.current).toBe(original);
    expect(b.uniformLocations.has(1)).toBe(true);
    const muxer = new GlMuxer(gl);
    muxer.switchTo({ shadow: { ...b.shadow, currentProgram: null }, errors: [] });
    muxer.switchTo(b);
    expect(native.current).toBe(original);
    expect(query(O.QOP_GET_ERROR)).toBe(0);
    send(O.OP_USE_PROGRAM, [20]);
    expect(query(O.QOP_GET_ERROR)).toBe(0x502);
    expect(native.current).toBe(original);
    send(O.OP_USE_PROGRAM, [0]);
    expect(native.deleted.has(original)).toBe(true);
    expect(native.deletions.get(original)).toBe(1);
    send(O.OP_USE_PROGRAM, [20]);
    expect(query(O.QOP_GET_ERROR)).toBe(0x502);
    expect(native.current).toBeNull();
  });

  it("installs a successful replacement and invalidates old uniform handles", () => {
    const { b, native, send, query, original } = setup();
    send(O.OP_LINK_PROGRAM, [20]);
    const replacement = b.programs.get(20) as unknown as Program;
    expect(replacement).not.toBe(original);
    expect(replacement.shaders.size).toBe(2);
    expect(replacement.attributes.get("position")).toBe(3);
    expect(native.current).toBe(replacement);
    expect(native.deleted.has(original)).toBe(true);
    expect(native.deletions.get(original)).toBe(1);
    expect(b.uniformLocations.has(1)).toBe(false);
    expect(query(O.QOP_GET_INTEGERV, [0x8b8d])).toBe(20);
    send(O.OP_UNIFORM1F, [1, 0]);
    expect(query(O.QOP_GET_ERROR)).toBe(0x502);
    expect(native.uniformWrites).toBe(0);
  });

  it("recovers from a failed attempt while the old executable remains installed", () => {
    const { b, native, send, query, original } = setup();
    const fragment = b.shaders.get(11) as unknown as Shader;
    fragment.compiled = false;
    send(O.OP_LINK_PROGRAM, [20]);
    fragment.compiled = true;
    send(O.OP_LINK_PROGRAM, [20]);
    expect(query(O.QOP_GET_PROGRAMIV, [20, 0x8b82])).toBe(1);
    expect(native.current).toBe(b.programs.get(20));
    expect(native.current).not.toBe(original);
    expect(native.deleted.has(original)).toBe(true);
    expect(b.uniformLocations.has(1)).toBe(false);
  });

  it("can relink a deletion-pending current program with deletion-pending shaders", () => {
    const { b, native, send, query } = setup();
    send(O.OP_DELETE_SHADER, [10]);
    send(O.OP_DELETE_PROGRAM, [20]);
    send(O.OP_LINK_PROGRAM, [20]);
    expect(query(O.QOP_GET_PROGRAMIV, [20, 0x8b82])).toBe(1);
    expect(query(O.QOP_GET_PROGRAMIV, [20, 0x8b80])).toBe(1);
    expect(query(O.QOP_GET_ERROR)).toBe(0);
    const replacement = native.current!;
    send(O.OP_USE_PROGRAM, [0]);
    expect(b.programs.has(20)).toBe(false);
    expect(b.shaders.has(10)).toBe(false);
    expect(native.deleted.has(replacement)).toBe(true);
  });

  it("keeps the current executable when replacement allocation fails", () => {
    const { b, native, send, query, original } = setup();
    native.failCreate = true;
    send(O.OP_LINK_PROGRAM, [20]);
    expect(query(O.QOP_GET_ERROR)).toBe(0x505);
    expect(b.programs.get(20)).toBe(original);
    expect(native.current).toBe(original);
    expect(b.uniformLocations.has(1)).toBe(true);
  });

  it("destroys both failed-link state and its retained executable on context teardown", () => {
    const { b, native, registry, send, original } = setup();
    (b.shaders.get(11) as unknown as Shader).compiled = false;
    send(O.OP_LINK_PROGRAM, [20]);
    const attempted = b.programs.get(20) as unknown as Program;
    expect(attempted).not.toBe(original);
    registry.destroyContext(1);
    expect(native.deleted.has(original)).toBe(true);
    expect(native.deleted.has(attempted)).toBe(true);
    expect(native.deletions.get(original)).toBe(1);
    expect(native.deletions.get(attempted)).toBe(1);
    expect(native.current).toBeNull();
  });
});
