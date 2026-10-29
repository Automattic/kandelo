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
  getUniformLocation(_program: Program, _name: string) { return {}; }
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
  const inactiveSetters = [
    ["glUniform1f", O.OP_UNIFORM1F, [-1, 0]],
    ["glUniform2f", O.OP_UNIFORM2F, [-1, 0, 0]],
    ["glUniform3f", O.OP_UNIFORM3F, [-1, 0, 0, 0]],
    ["glUniform4f", O.OP_UNIFORM4F, [-1, 0, 0, 0, 0]],
    ["glUniform1i", O.OP_UNIFORM1I, [-1, 0]],
    ...[2, 3, 4].map(n => [`glUniform${n}i`,
      [O.OP_UNIFORM2IV, O.OP_UNIFORM3IV, O.OP_UNIFORM4IV][n - 2], [-1, 1, ...Array(n).fill(0)]]),
    ...[1, 2, 3, 4].map(n => [`glUniform${n}fv`,
      [O.OP_UNIFORM1FV, O.OP_UNIFORM2FV, O.OP_UNIFORM3FV, O.OP_UNIFORM4FV][n - 1],
      [-1, 1, ...Array(n).fill(0)]]),
    ...[1, 2, 3, 4].map(n => [`glUniform${n}iv`,
      [O.OP_UNIFORM1IV, O.OP_UNIFORM2IV, O.OP_UNIFORM3IV, O.OP_UNIFORM4IV][n - 1],
      [-1, 1, ...Array(n).fill(0)]]),
    ...[2, 3, 4].map(n => [`glUniformMatrix${n}fv`,
      [O.OP_UNIFORM_MATRIX2FV, O.OP_UNIFORM_MATRIX3FV, O.OP_UNIFORM_MATRIX4FV][n - 2],
      [-1, 1, 0, ...Array(n * n).fill(0)]]),
  ] as [string, number, number[]][];

  it.each(inactiveSetters)("requires an accepted current executable for inactive %s", (_name, op, words) => {
    const { send, query, native } = setup();
    send(O.OP_USE_PROGRAM, [0]);
    send(op, words);
    expect(query(O.QOP_GET_ERROR)).toBe(0x502);
    expect(query(O.QOP_GET_ERROR)).toBe(0);
    send(O.OP_USE_PROGRAM, [20]);
    send(op, words);
    expect(query(O.QOP_GET_ERROR)).toBe(0);
    expect(native.uniformWrites).toBe(0);
  });

  it("deduplicates pending invalid-operation flags and preserves distinct earlier errors", () => {
    const { send, query } = setup();
    send(O.OP_USE_PROGRAM, [0]);
    send(O.OP_CREATE_PROGRAM, [21]);
    send(O.OP_USE_PROGRAM, [21]);
    for (const [, op, words] of inactiveSetters) send(op, words);
    expect(query(O.QOP_GET_ERROR)).toBe(0x502);
    expect(query(O.QOP_GET_ERROR)).toBe(0);
    send(O.OP_USE_PROGRAM, [999]);
    for (const [, op, words] of inactiveSetters) send(op, words);
    expect(new Set([query(O.QOP_GET_ERROR), query(O.QOP_GET_ERROR)])).toEqual(new Set([0x501, 0x502]));
    expect(query(O.QOP_GET_ERROR)).toBe(0);
  });

  it("validates inactive uniforms in order with program changes in the same command batch", () => {
    const { b, query, native } = setup();
    const commands: [number, number[]][] = [
      [O.OP_USE_PROGRAM, [0]], [O.OP_UNIFORM1F, [-1, 0]],
      [O.OP_USE_PROGRAM, [20]], [O.OP_UNIFORM1F, [-1, 0]],
    ];
    const view = new DataView(b.cmdbufView!.buffer);
    let offset = 0;
    for (const [op, words] of commands) {
      view.setUint16(offset, op, true); view.setUint16(offset + 2, words.length * 4, true);
      words.forEach((word, i) => view.setUint32(offset + 4 + i * 4, word, true));
      offset += 4 + words.length * 4;
    }
    expect(decodeAndDispatch(b, 0, offset)).toBe(0);
    expect(query(O.QOP_GET_INTEGERV, [0x8b8d])).toBe(20);
    expect(query(O.QOP_GET_ERROR)).toBe(0x502);
    expect(query(O.QOP_GET_ERROR)).toBe(0);
    expect(native.uniformWrites).toBe(0);
  });

  it("judges inactive uniforms against retained executables after failed use, relink and deletion", () => {
    const { b, native, send, query, original } = setup();
    send(O.OP_CREATE_PROGRAM, [21]);
    send(O.OP_USE_PROGRAM, [21]);
    for (const [, op, words] of inactiveSetters) send(op, words);
    expect(query(O.QOP_GET_ERROR)).toBe(0x502);
    expect(query(O.QOP_GET_ERROR)).toBe(0);
    (b.shaders.get(11) as unknown as Shader).compiled = false;
    send(O.OP_LINK_PROGRAM, [20]);
    send(O.OP_USE_PROGRAM, [20]);
    for (const [, op, words] of inactiveSetters) send(op, words);
    expect(query(O.QOP_GET_ERROR)).toBe(0x502);
    expect(query(O.QOP_GET_ERROR)).toBe(0);
    expect(b.currentProgram).toBe(original);
    send(O.OP_DELETE_PROGRAM, [20]);
    for (const [, op, words] of inactiveSetters) send(op, words);
    expect(query(O.QOP_GET_ERROR)).toBe(0);
    send(O.OP_USE_PROGRAM, [0]);
    for (const [, op, words] of inactiveSetters) send(op, words);
    expect(query(O.QOP_GET_ERROR)).toBe(0x502);
    expect(query(O.QOP_GET_ERROR)).toBe(0);
    expect(native.uniformWrites).toBe(0);
  });

  function sharePeer(parent: ReturnType<typeof setup>) {
    parent.b.contextId = 21;
    parent.registry.bind({pid:1,sessionId:12,cmdbufAddr:0,cmdbufLen:32});
    const peer = parent.registry.get(1,12)!;
    peer.gl = parent.gl; peer.contextId = 22;
    peer.cmdbufView = new Uint8Array(32);
    expect(parent.registry.shareObjects(1,12,0)).toBe(true);
    return peer;
  }

  it("uses each logical context's accepted program rather than the physical installation", () => {
    const parent = setup(), peer = sharePeer(parent);
    // The physical WebGL context still has the parent's executable, while a
    // newly created sharing context has no logical current program.
    expect(parent.native.current).toBe(parent.original);
    peer.cmdbufLen = 4096;
    peer.cmdbufView = new Uint8Array(4096);
    const sendPeer = (op: number, words: number[]) => {
      const view = new DataView(peer.cmdbufView!.buffer);
      view.setUint16(0, op, true); view.setUint16(2, words.length * 4, true);
      words.forEach((word, i) => view.setUint32(4 + i * 4, word, true));
      expect(decodeAndDispatch(peer, 0, 4 + words.length * 4)).toBe(0);
    };
    for (const [, op, words] of inactiveSetters) sendPeer(op, words);
    expect(peer.errors).toEqual([0x502]);
    expect(parent.b.errors).toEqual([]);
    peer.errors.length = 0;
    sendPeer(O.OP_USE_PROGRAM, [20]);
    for (const [, op, words] of inactiveSetters) sendPeer(op, words);
    expect(peer.errors).toEqual([]);
    sendPeer(O.OP_USE_PROGRAM, [0]);
    for (const [, op, words] of inactiveSetters) sendPeer(op, words);
    expect(peer.errors).toEqual([0x502]);
    for (const [, op, words] of inactiveSetters) parent.send(op, words);
    expect(parent.query(O.QOP_GET_ERROR)).toBe(0);
    expect(parent.native.uniformWrites).toBe(0);
  });

  it("keeps repeated uniform locations stable across a sharing peer until successful relink",()=>{
    const parent=setup(),peer=sharePeer(parent);parent.b.nextUniformLoc=1;
    const location=(b: typeof peer,name:string)=>{
      const bytes=new TextEncoder().encode(name),input=new Uint8Array(8+bytes.length),out=new Uint8Array(4);
      const view=new DataView(input.buffer);view.setUint32(0,20,true);view.setUint32(4,bytes.length,true);input.set(bytes,8);
      expect(runGlQuery(b,O.QOP_GET_UNIFORM_LOC,input,out)).toBe(4);return new DataView(out.buffer).getInt32(0,true);
    };
    const first=location(parent.b,"colors[0]");
    expect(location(parent.b,"colors[0]")).toBe(first);
    expect(location(peer,"colors")).toBe(first);
    expect(location(peer,"colors[000]")).toBe(first);
    expect(location(peer,"colors[1]")).not.toBe(first);
    linkProgramRetainingExecutable(peer,20);
    expect(location(parent.b,"colors")).not.toBe(first);
  });

  function lookup(owner: ReturnType<typeof setup>["b"], action: number, token: number, arg=0, bytes=new Uint8Array(), program=20) {
    const input=new Uint8Array(16+bytes.length),reply=new Uint8Array(16).fill(0xaa);
    [action,program,token,arg].forEach((word,i)=>new DataView(input.buffer).setUint32(i*4,word,true));input.set(bytes,16);
    const rc=runGlQuery(owner,O.QOP_LOOKUP_UNIFORM,input,reply),v=new DataView(reply.buffer);
    if(rc>=0)expect(v.getUint32(12,true)).toBe(0x47514c33);
    return {rc,status:v.getUint32(0,true),token:v.getUint32(4,true),location:v.getInt32(8,true)};
  }
  it("assembles a long name in bounded chunks and resolves the live shared program only at commit",()=>{
    const parent=setup(),peer=sharePeer(parent);parent.b.nextUniformLoc=1;
    const name="u"+"n".repeat(140000),bytes=new TextEncoder().encode(name),seen:string[]=[];
    parent.native.getUniformLocation=(_program,text)=>{seen.push(text);return {};};
    const original=parent.native.getProgramParameter.bind(parent.native);parent.native.getProgramParameter=(program,pname)=>pname===0x8b86?1:original(program,pname);
    (parent.native as any).getActiveUniform=()=>({name,size:1,type:0x1406});
    expect(lookup(peer,1,1,bytes.length).status).toBe(0);
    for(let offset=0;offset<bytes.length;offset+=65520)expect(lookup(peer,2,1,offset,bytes.subarray(offset,offset+65520)).status).toBe(0);
    expect(seen).toEqual([]);const done=lookup(peer,3,1);expect(done.status).toBe(0);expect(seen).toEqual([name]);expect(peer.uniformLookup).toBeNull();
    const short=new TextEncoder().encode("color");const first=lookup(parent.b,0,1,short.length,short);
    expect(lookup(peer,0,2,short.length,short).location).toBe(first.location);
    expect(done.location).not.toBe(first.location);
  });
  it("returns inactive long roots and invalid or reserved names without WebGL-only name errors",()=>{
    const {b,native}=setup();let calls=0;native.getUniformLocation=()=>{calls++;return {};};
    for(const name of ["unknown"+"x".repeat(70000),"gl_reserved","","bad name","value[-1]"]) {
      const bytes=new TextEncoder().encode(name);
      if(bytes.length>65520){expect(lookup(b,1,1,bytes.length).status).toBe(0);
        for(let at=0;at<bytes.length;at+=65520)lookup(b,2,1,at,bytes.subarray(at,at+65520));expect(lookup(b,3,1).location).toBe(-1);}
      else {const result=lookup(b,0,b.uniformLookupSerial+1,bytes.length,bytes);expect(result.status).toBe(0);expect(result.location).toBe(-1);}
    }
    expect(calls).toBe(0);expect(b.errors).toEqual([]);
  });
  it("rejects incomplete chunks and stale tokens while cancellation never erases a newer lookup",()=>{
    const {b}=setup();lookup(b,1,1,3);expect(lookup(b,2,1,1,new Uint8Array([65])).status).toBe(1);expect(b.uniformLookup).toBeNull();
    lookup(b,1,2,3);lookup(b,2,2,0,new Uint8Array([65]));expect(lookup(b,3,2).status).toBe(1);expect(b.uniformLookup).toBeNull();
    lookup(b,1,3,1);lookup(b,1,4,1);expect(lookup(b,4,3).status).toBe(1);expect(b.uniformLookup?.token).toBe(4);
    expect(lookup(b,4,4).status).toBe(0);expect(lookup(b,4,4).status).toBe(0);expect(b.uniformLookup).toBeNull();
    expect(lookup(b,1,4,1).status).toBe(1);expect(b.uniformLookup).toBeNull();
  });
  it("keeps lookup storage context-local and retires it on replacement or destruction",()=>{
    const parent=setup(),peer=sharePeer(parent);lookup(parent.b,1,1,32);lookup(peer,1,1,64);
    expect(parent.b.uniformLookup?.bytes.length).toBe(32);expect(peer.uniformLookup?.bytes.length).toBe(64);
    const text=new TextEncoder().encode("color");expect(lookup(peer,0,2,text.length,text).status).toBe(0);expect(peer.uniformLookup).toBeNull();
    lookup(peer,1,3,64);parent.registry.destroyContext(1,0);expect(parent.b.uniformLookup).toBeNull();expect(peer.uniformLookup?.bytes.length).toBe(64);
    parent.registry.destroyContext(1,12);expect(peer.uniformLookup).toBeNull();expect(peer.uniformLocationNames.size).toBe(0);
  });
  it("rejects a program retired during a name transfer and preserves location state on allocation failure",()=>{
    const {b,native}=setup();b.nextUniformLoc=1;lookup(b,1,1,1);lookup(b,2,1,0,new Uint8Array([65]));b.programs.delete(20);
    expect(lookup(b,3,1).status).toBe(1);expect(b.uniformLookup).toBeNull();expect(b.errors.pop()).toBe(0x501);
    const program=native.createProgram()!;program.linked=true;b.programs.set(20,program);
    const set=b.uniformLocationNames.set.bind(b.uniformLocationNames);b.uniformLocationNames.set=()=>{throw new Error("allocation rejected");};
    const text=new TextEncoder().encode("color");expect(lookup(b,0,2,text.length,text).status).toBe(1);
    expect(b.nextUniformLoc).toBe(1);expect(b.uniformLocations.has(2)).toBe(false);expect(b.uniformLocationPrograms.has(2)).toBe(false);expect(b.errors.pop()).toBe(0x505);
    b.uniformLocationNames.set=set;expect(lookup(b,0,3,text.length,text).location).toBe(2);
  });
  it("returns an existing location at counter exhaustion and rejects new indices without wrapping",()=>{
    const {b}=setup();b.nextUniformLoc=1;const text=new TextEncoder().encode("color");const first=lookup(b,0,1,text.length,text).location;
    b.nextUniformLoc=0x7fffffff;expect(lookup(b,0,2,text.length,text).location).toBe(first);
    const other=new TextEncoder().encode("other");expect(lookup(b,0,3,other.length,other).status).toBe(1);expect(b.errors.pop()).toBe(0x505);expect(b.nextUniformLoc).toBe(0x7fffffff);
  });
  it("rejects malformed lookup records before publishing a reply or allocating pending storage",()=>{
    const {b}=setup(),reply=new Uint8Array(16).fill(0xaa);
    for(const words of [[5,20,1,0],[0,20,0,0],[0,20,1,1],[3,20,1,1]]) {
      expect(runGlQuery(b,O.QOP_LOOKUP_UNIFORM,new Uint8Array(new Uint32Array(words).buffer),reply)).toBe(-22);
    }
    expect([...reply]).toEqual(new Array(16).fill(0xaa));expect(b.uniformLookup).toBeNull();
  });
  it("reads checked active-uniform metadata and long name chunks without mutating old error outputs",()=>{
    const {b,native}=setup();const name="u"+"x".repeat(70000);
    const original=native.getProgramParameter.bind(native);native.getProgramParameter=(program,pname)=>pname===0x8b86?1:original(program,pname);
    (native as any).getActiveUniform=()=>({name,size:3,type:0x8b51});
    const query=(index:number,offset:number,capacity:number)=>{
      const input=new Uint8Array(new Uint32Array([20,index,offset,capacity]).buffer),out=new Uint8Array(20+capacity);
      expect(runGlQuery(b,O.QOP_GET_ACTIVE_UNIFORM_INFO,input,out)).toBe(out.length);return {v:new DataView(out.buffer),out};
    };
    const meta=query(0,0,0);expect(meta.v.getUint32(0,true)).toBe(0);expect(meta.v.getUint32(4,true)).toBe(name.length);expect(meta.v.getUint32(8,true)).toBe(3);expect(meta.v.getUint32(12,true)).toBe(0x8b51);
    const tail=query(0,69998,4);expect(new TextDecoder().decode(tail.out.subarray(16,20))).toBe("xxx\0");
    expect(query(1,0,0).v.getUint32(0,true)).toBe(1);expect(b.errors.pop()).toBe(0x501);
    expect(query(0,name.length+1,0).v.getUint32(0,true)).toBe(1);expect(b.errors.pop()).toBe(0x501);
  });

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
