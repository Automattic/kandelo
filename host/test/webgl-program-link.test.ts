import { describe, expect, it, vi } from "vitest";
import { decodeAndDispatch } from "../src/webgl/bridge.js";
import { uniformLocation } from "../src/webgl/uniform-queries.js";
import { hasNativeRepair, repairNativeState } from "../src/webgl/native-recovery.js";
import { KernelEntryGate } from "../src/kernel-entry-gate.js";
import { GlMuxer } from "../src/webgl/muxer.js";
import * as O from "../src/webgl/ops.js";
import { runGlQuery } from "../src/webgl/query.js";
import { GlContextRegistry } from "../src/webgl/registry.js";
import { GlProgramQueryPin, createShaderIfAccepted, createProgramIfAccepted, linkProgramRetainingExecutable, useProgramIfAccepted } from "../src/webgl/program-objects.js";

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
  failCreateAfterAllocation = false;
  failCreateShaderAfterAllocation = false;
  failPrepare = false;
  failLink = false;
  failDeleteProgram = false;
  failDeleteShader = false;
  failUnbind = false;
  createdPrograms: Program[] = [];
  createdShaders: Shader[] = [];
  deleteAttempts: object[] = [];
  uniformWrites = 0;
  uniformValue: unknown = new Float32Array([0.25,-1.75,2.5,1]);
  getUniform() { return this.uniformValue; }
  getUniformLocation(_program: Program, _name: string) { return {}; }
  createShader() {
    const shader={ compiled: true, deleted: false }; this.createdShaders.push(shader);
    if(this.failCreateShaderAfterAllocation) this.error=0x505;
    return shader;
  }
  createProgram(): Program | null {
    if (this.failCreate) { this.error = 0x505; return null; }
    const program:Program={ linked: false, shaders: new Set(), attributes: new Map() };
    this.createdPrograms.push(program);
    if(this.failCreateAfterAllocation) this.error=0x505;
    return program;
  }
  attachShader(p: Program, s: Shader) {
    if(this.failPrepare) {this.error=0x502;return;}
    if (s.deleted) this.error = 0x501;
    else p.shaders.add(s);
  }
  bindAttribLocation(p: Program, index: number, name: string) { p.attributes.set(name, index); }
  linkProgram(p: Program) { if(this.failLink) {this.error=0x502;return;} p.linked = p.shaders.size === 2 && [...p.shaders].every(s => s.compiled); }
  uniforms = [{name:"color",size:1,type:0x1406},{name:"colors[0]",size:2,type:0x8b52},
    {name:"other",size:1,type:0x1406},{name:"A",size:1,type:0x1406}];
  getActiveUniform(_p:Program,index:number) { return this.uniforms[index] ?? null; }
  getProgramParameter(p: Program, name: number) { return name === 0x8b82 ? p.linked : name===0x8b86?this.uniforms.length:0; }
  useProgram(p: Program | null) {
    if(this.failUnbind && p===null) {this.error=0x502;return;}
    if (p && (!p.linked || this.deleted.has(p))) this.error = 0x502;
    else this.current = p;
  }
  getError() { const error = this.error; this.error = 0; return error; }
  getParameter(name: number) { return name === 0x8b8d ? this.current : 0; }
  deleteProgram(p: Program) {
    this.deleteAttempts.push(p);
    if(this.failDeleteProgram) {this.error=0x502;return;}
    this.deleted.add(p);
    this.deletions.set(p, (this.deletions.get(p) ?? 0) + 1);
  }
  deleteShader(s: Shader) {
    this.deleteAttempts.push(s);
    if(this.failDeleteShader) {this.error=0x502;return;}
    s.deleted = true;
  }
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
  b.uniformLocationRecords.set(1,{program:20,canonical:"seed",native:{} as WebGLUniformLocation,metadata:{executable:original,type:0x8b52,array:false,remaining:1},state:"published",references:0});
  b.nextUniformLoc=1;
  return { b, gl, native, registry, send, query, original };
}

describe("program link attempts and installed executables", () => {
  it.each(["named","current","query pin"] as const)("never deletes an unknown %s owner while eligibility inspection is failing",kind=>{
    const parent=setup();let target=parent.b;
    let lease:ReturnType<GlContextRegistry["retainContextExecution"]>=null,pin:GlProgramQueryPin|null=null;
    if(kind==="current") target=sharePeer(parent);
    else {
      useProgramIfAccepted(target,0);
      if(kind==="query pin") {
        target.contextId=21;lease=parent.registry.retainContextExecution(1,0,new GlMuxer(parent.gl))!;
        pin=GlProgramQueryPin.acquire(lease,20)!;
      }
    }
    target.errors.push(0x501);
    const nativeLink=parent.native.linkProgram.bind(parent.native);
    let has:ReturnType<typeof vi.spyOn>|undefined;
    const link=vi.spyOn(parent.native,"linkProgram").mockImplementation(program=>{
      nativeLink(program);has=vi.spyOn(target.programQueryPins,"has").mockImplementation(()=>{throw new Error("ownership lookup refused");});
    });
    try {
      linkProgramRetainingExecutable(target,20);
      expect(hasNativeRepair(parent.gl)).toBe(true);expect(repairNativeState(parent.gl)).toBe(false);
      expect(parent.native.deleted.has(parent.original)).toBe(false);expect(target.errors).toEqual([0x501,0x505]);
    } finally {has?.mockRestore();link.mockRestore();}
    expect(repairNativeState(parent.gl)).toBe(true);expect(parent.native.deleted.has(parent.original)).toBe(false);
    if(kind==="current") useProgramIfAccepted(parent.b,0);
    else if(kind==="query pin") {expect(pin!.release()).toBe(true);expect(lease!.release()).toBe(true);}
    else parent.send(O.OP_DELETE_PROGRAM,[20]);
    expect(parent.native.deletions.get(parent.original)).toBe(1);
    expect(repairNativeState(parent.gl)).toBe(true);expect(parent.native.deletions.get(parent.original)).toBe(1);
  });

  it.each(["filter","delete"] as const)("preserves the original branded link failure while %s cleanup throws",phase=>{
    const {b,native,original}=setup();
    const branded=(label:string)=>{const gate=new KernelEntryGate();try {gate.invokeKernelExport(label,()=>{throw new Error(label);});}catch(error){return error;}};
    const primary=branded("link failure"),secondary=branded("cleanup failure");
    let cleanup:ReturnType<typeof vi.spyOn>|undefined;
    const link=vi.spyOn(native,"linkProgram").mockImplementation(()=>{
      cleanup=phase==="filter"?vi.spyOn(b.programQueryPins,"has").mockImplementation(()=>{throw secondary;})
        :vi.spyOn(native,"deleteProgram").mockImplementation(()=>{throw secondary;});
      throw primary;
    });
    let actual:unknown;
    try {linkProgramRetainingExecutable(b,20);} catch(error) {actual=error;}
    finally {cleanup?.mockRestore();link.mockRestore();}
    expect(actual).toBe(primary);expect(hasNativeRepair(b.gl!)).toBe(true);
    expect(b.programs.get(20)).toBe(original);expect(b.currentProgram).toBe(original);
    expect(repairNativeState(b.gl!)).toBe(true);expect(native.deleted.has(original)).toBe(false);
    const candidate=native.createdPrograms.at(-1)!;expect(native.deletions.get(candidate)).toBe(1);
  });

  it("preserves a use-program body exception while the armed cleanup guard also throws",()=>{
    const {b,native,original}=setup();(b.shaders.get(11) as unknown as Shader).compiled=false;
    linkProgramRetainingExecutable(b,20);
    const primary=new Error("finalization failed"),gate=new KernelEntryGate();let secondary:unknown;
    try {gate.invokeKernelExport("cleanup failure",()=>{throw new Error("cleanup failure");});}catch(error){secondary=error;}
    const nativeUse=native.useProgram.bind(native);
    let body:ReturnType<typeof vi.spyOn>|undefined,guard:ReturnType<typeof vi.spyOn>|undefined;
    const use=vi.spyOn(native,"useProgram").mockImplementation(program=>{
      nativeUse(program);
      body=vi.spyOn(b.programDeletePending,"has").mockImplementation(()=>{throw primary;});
      guard=vi.spyOn(b.programQueryPins,"has").mockImplementation(()=>{throw secondary;});
    });
    let actual:unknown;
    try {useProgramIfAccepted(b,0);}catch(error){actual=error;}
    finally {body?.mockRestore();guard?.mockRestore();use.mockRestore();}
    expect(actual).toBe(primary);expect(b.currentProgram).toBeNull();expect(native.current).toBeNull();
    expect(hasNativeRepair(b.gl!)).toBe(true);expect(repairNativeState(b.gl!)).toBe(true);
    expect(native.deletions.get(original)).toBe(1);
  });

  it.each(["relink","use"] as const)("keeps %s cleanup retryable when ownership iteration throws after the accepted switch",mode=>{
    const {b,native,original}=setup();
    if(mode==="use") {(b.shaders.get(11) as unknown as Shader).compiled=false;linkProgramRetainingExecutable(b,20);}
    const values=vi.spyOn(b.programs,"values").mockImplementation(()=>{throw new Error("ownership iteration refused");});
    let failure:unknown;
    try {if(mode==="relink")linkProgramRetainingExecutable(b,20);else useProgramIfAccepted(b,0);} catch(error) {failure=error;}
    expect(b.currentProgram).not.toBe(original);expect(native.deleted.has(original)).toBe(false);
    try {
      expect(hasNativeRepair(b.gl!)).toBe(true);expect(repairNativeState(b.gl!)).toBe(false);
    } finally {values.mockRestore();}
    expect(repairNativeState(b.gl!)).toBe(true);expect(native.deletions.get(original)).toBe(1);
    expect(repairNativeState(b.gl!)).toBe(true);expect(native.deletions.get(original)).toBe(1);
    expect(failure).toBeUndefined();expect(b.errors).toContain(0x505);
  });

  it.each(["shader", "program", "first clone receiver", "second clone receiver"] as const)("refuses %s receiver allocation before native creation",kind=>{
    const {b,native,original}=setup(),programs=native.createdPrograms.length,shaders=native.createdShaders.length;
    const add=Set.prototype.add;let calls=0;
    const spy=vi.spyOn(Set.prototype,"add").mockImplementation(function(this:Set<unknown>,value:unknown){
      if(++calls===(kind==="second clone receiver"?2:1)) throw new Error("receiver allocation rejected");
      return add.call(this,value);
    });
    try {
      if(kind==="shader") createShaderIfAccepted(b,0x8b31,99);
      else if(kind==="program") createProgramIfAccepted(b,99);
      else linkProgramRetainingExecutable(b,20);
    } finally {spy.mockRestore();}
    expect(native.createdPrograms.length).toBe(programs);expect(native.createdShaders.length).toBe(shaders);
    expect(b.programs.get(20)).toBe(original);expect(b.currentProgram).toBe(original);
    expect(b.errors).toContain(0x505);expect(hasNativeRepair(b.gl!)).toBe(false);
  });

  it.each(["shader", "program"] as const)("owns a %s returned together with a native create error",kind=>{
    const {b,native}=setup();native.failDeleteShader=true;native.failDeleteProgram=true;
    if(kind==="shader") {native.failCreateShaderAfterAllocation=true;createShaderIfAccepted(b,0x8b31,99);}
    else {native.failCreateAfterAllocation=true;createProgramIfAccepted(b,99);}
    expect(b.shaders.has(99)||b.programs.has(99)).toBe(false);expect(hasNativeRepair(b.gl!)).toBe(true);
    expect(b.errors).toContain(0x505);expect(b.errors).toContain(0x502);
    native.failDeleteShader=false;native.failDeleteProgram=false;
    expect(repairNativeState(b.gl!)).toBe(true);
    const candidate=kind==="shader"?native.createdShaders.at(-1)!:native.createdPrograms.at(-1)!;
    expect(kind==="shader"?(candidate as Shader).deleted:native.deletions.get(candidate as Program)).toBe(kind==="shader"?true:1);
  });

  it("reserves old-executable deletion before a successful relink publishes its replacement",()=>{
    const {b,native,original}=setup();native.failDeleteProgram=true;
    linkProgramRetainingExecutable(b,20);
    const replacement=b.programs.get(20);
    expect(replacement).not.toBe(original);expect(b.currentProgram).toBe(replacement);
    expect(native.current).toBe(replacement);expect(native.deleted.has(original)).toBe(false);
    expect(hasNativeRepair(b.gl!)).toBe(true);
    const creations=native.createdPrograms.length;
    native.failDeleteProgram=false;expect(repairNativeState(b.gl!)).toBe(true);
    expect(native.deletions.get(original)).toBe(1);expect(native.createdPrograms.length).toBe(creations);
    expect(b.programs.get(20)).toBe(replacement);expect(repairNativeState(b.gl!)).toBe(true);
    expect(native.deletions.get(original)).toBe(1);
  });

  it("reserves orphaned current-executable deletion before accepting useProgram",()=>{
    const {b,native,original}=setup();(b.shaders.get(11) as unknown as Shader).compiled=false;
    linkProgramRetainingExecutable(b,20);const attempt=b.programs.get(20);
    native.failDeleteProgram=true;useProgramIfAccepted(b,0);
    expect(b.currentProgram).toBeNull();expect(native.current).toBeNull();expect(b.programs.get(20)).toBe(attempt);
    expect(hasNativeRepair(b.gl!)).toBe(true);expect(native.deleted.has(original)).toBe(false);
    native.failDeleteProgram=false;expect(repairNativeState(b.gl!)).toBe(true);
    expect(native.deletions.get(original)).toBe(1);expect(native.deleted.has(attempt as unknown as Program)).toBe(false);
  });

  it("does not switch away from an orphaned current executable without a reserved receiver",()=>{
    const {b,native,original}=setup();(b.shaders.get(11) as unknown as Shader).compiled=false;
    linkProgramRetainingExecutable(b,20);
    const spy=vi.spyOn(Set.prototype,"add").mockImplementationOnce(()=>{throw new Error("receiver allocation rejected");});
    try {useProgramIfAccepted(b,0);} finally {spy.mockRestore();}
    expect(b.currentProgram).toBe(original);expect(native.current).toBe(original);
    expect(b.errors).toContain(0x505);expect(hasNativeRepair(b.gl!)).toBe(false);
  });

  it("keeps a real query pin and pending name when native unbind rejects deletion",()=>{
    const {b,native,registry,gl,original,send}=setup();b.contextId=21;
    const lease=registry.retainContextExecution(1,0,new GlMuxer(gl))!;
    const pin=GlProgramQueryPin.acquire(lease,20)!;
    useProgramIfAccepted(b,0);send(O.OP_DELETE_PROGRAM,[20]);
    // Native selector replay may still have the pinned executable installed;
    // this does not grant a logical current owner or permission to delete it.
    gl.useProgram(original as unknown as WebGLProgram);
    native.failUnbind=true;
    expect(pin.release()).toBe(false);
    expect(native.deleted.has(original)).toBe(false);
    expect(b.programQueryPins.get(original as unknown as WebGLProgram)).toBe(1);
    expect(b.programs.get(20)).toBe(original);expect(b.programDeletePending.has(20)).toBe(true);
    native.failUnbind=false;expect(pin.release()).toBe(true);expect(pin.release()).toBe(true);
    expect(native.deletions.get(original)).toBe(1);expect(b.programs.has(20)).toBe(false);
    expect(b.programQueryPins.size).toBe(0);expect(lease.release()).toBe(true);
  });

  it("preserves selected-peer error flags and shared current ownership during rollback retries",()=>{
    const parent=setup(),peer=sharePeer(parent),muxer=new GlMuxer(parent.gl);
    muxer.switchTo(parent.b);parent.native.error=0x500;muxer.switchTo(peer);
    parent.native.failPrepare=true;parent.native.failDeleteProgram=true;
    linkProgramRetainingExecutable(peer,20);
    const candidate=parent.native.createdPrograms.at(-1)!;
    expect(parent.b.currentProgram).toBe(parent.original);expect(peer.currentProgram).toBeNull();
    expect(parent.b.errors).toEqual([0x500]);expect(peer.errors).toEqual([0x502]);
    parent.native.error=0x501;
    expect(()=>muxer.switchTo(parent.b)).toThrow("Native GL restoration remains pending");
    expect(peer.errors).toEqual([0x502,0x501]);expect(parent.b.errors).toEqual([0x500]);
    parent.native.failDeleteProgram=false;muxer.switchTo(parent.b);
    expect(parent.native.current).toBe(parent.original);expect(parent.native.deletions.get(candidate)).toBe(1);
    expect(parent.native.deleted.has(parent.original)).toBe(false);expect(parent.b.errors).toEqual([0x500]);
  });

  it.each(["create", "prepare", "link", "publication"] as const)("retains rejected %s clone deletion until actual native retry",phase=>{
    const {b,native,original}=setup();
    if(phase==="create") native.failCreateAfterAllocation=true;
    if(phase==="prepare") native.failPrepare=true;
    if(phase==="link") native.failLink=true;
    if(phase==="publication") b.programs.set=()=>{throw new Error("allocation rejected");};
    native.failDeleteProgram=true;
    linkProgramRetainingExecutable(b,20);
    const candidate=native.createdPrograms.at(-1)!;
    expect(candidate).not.toBe(original);
    expect(b.programs.get(20)).toBe(original);
    expect(b.currentProgram).toBe(original);expect(native.current).toBe(original);
    expect(b.uniformLocationRecords.has(1)).toBe(true);
    expect(native.deleted.has(candidate)).toBe(false);expect(hasNativeRepair(b.gl!)).toBe(true);
    expect(repairNativeState(b.gl!)).toBe(false);
    native.failDeleteProgram=false;
    expect(repairNativeState(b.gl!)).toBe(true);
    expect(native.deletions.get(candidate)).toBe(1);
    expect(repairNativeState(b.gl!)).toBe(true);expect(native.deletions.get(candidate)).toBe(1);
    expect(native.deleted.has(original)).toBe(false);
  });

  it.each(["shader", "program"] as const)("retains unpublished %s after publication and deletion both fail",kind=>{
    const {b,native}=setup();
    if(kind==="shader") {b.shaders.set=()=>{throw new Error("allocation rejected");};native.failDeleteShader=true;}
    else {b.programs.set=()=>{throw new Error("allocation rejected");};native.failDeleteProgram=true;}
    const view=new DataView(b.cmdbufView!.buffer);
    view.setUint16(0,kind==="shader"?O.OP_CREATE_SHADER:O.OP_CREATE_PROGRAM,true);
    view.setUint16(2,kind==="shader"?8:4,true);
    view.setUint32(4,kind==="shader"?0x8b31:99,true);
    if(kind==="shader") view.setUint32(8,99,true);
    expect(decodeAndDispatch(b,0,kind==="shader"?12:8)).toBeLessThan(0);
    const candidate=kind==="shader"?native.createdShaders.at(-1)!:native.createdPrograms.at(-1)!;
    expect(b.shaders.has(99)||b.programs.has(99)).toBe(false);
    expect(b.programShaders.has(99)).toBe(false);
    expect(hasNativeRepair(b.gl!)).toBe(true);
    native.failDeleteShader=false;native.failDeleteProgram=false;
    expect(decodeAndDispatch(b,0,0)).toBe(0);
    expect(kind==="shader"?(candidate as Shader).deleted:native.deleted.has(candidate as Program)).toBe(true);
    const attempts=native.deleteAttempts.length;
    expect(decodeAndDispatch(b,0,0)).toBe(0);expect(native.deleteAttempts.length).toBe(attempts);
  });

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

  it("validates positive zero-count setters against executable, type and location before ignoring data", () => {
    const {b,native,send,query} = setup();
    (native as any).getActiveUniform=()=>({name:"color",size:1,type:0x8b52});
    const parameter=native.getProgramParameter.bind(native);
    native.getProgramParameter=(program,pname)=>pname===0x8b86?1:parameter(program,pname);
    const location=uniformLocation(b,20,"color")!;
    send(O.OP_UNIFORM4FV,[location,0]);
    expect(query(O.QOP_GET_ERROR)).toBe(0);
    send(O.OP_UNIFORM3FV,[location,0]);
    expect(query(O.QOP_GET_ERROR)).toBe(0x502);
    send(O.OP_UNIFORM4FV,[location+99,0]);
    expect(query(O.QOP_GET_ERROR)).toBe(0x502);
    send(O.OP_USE_PROGRAM,[0]);
    send(O.OP_UNIFORM4FV,[location,0]);
    expect(query(O.QOP_GET_ERROR)).toBe(0x502);
  });

  it("rejects non-array counts and ignores only an array's excess tail", () => {
    const {b,native,send,query} = setup();
    const infos=[{name:"value",size:1,type:0x1406},{name:"colors[0]",size:3,type:0x8b52}];
    (native as any).getActiveUniform=(_program:Program,index:number)=>infos[index];
    const parameter=native.getProgramParameter.bind(native);
    native.getProgramParameter=(program,pname)=>pname===0x8b86?infos.length:parameter(program,pname);
    const scalar=uniformLocation(b,20,"value")!, array=uniformLocation(b,20,"colors[0001]")!;
    send(O.OP_UNIFORM1FV,[scalar,2,0,0]);
    expect(query(O.QOP_GET_ERROR)).toBe(0x502);
    let values:number[]=[];(native as any).uniform4fv=(_location:unknown,data:Float32Array)=>{values=[...data];};
    send(O.OP_UNIFORM4FV,[array,4,...Array(16).fill(0)]);
    expect(query(O.QOP_GET_ERROR)).toBe(0);
    expect(values).toHaveLength(8);
  });

  const positiveSignatures: [string,number,number,number][] = [
    ["1f",O.OP_UNIFORM1F,0x1406,1],["2f",O.OP_UNIFORM2F,0x8b50,2],
    ["3f",O.OP_UNIFORM3F,0x8b51,3],["4f",O.OP_UNIFORM4F,0x8b52,4],
    ["1i",O.OP_UNIFORM1I,0x1404,1],
    ...[1,2,3,4].map((n):[string,number,number,number]=>[`${n}fv`,
      [O.OP_UNIFORM1FV,O.OP_UNIFORM2FV,O.OP_UNIFORM3FV,O.OP_UNIFORM4FV][n-1],
      [0x1406,0x8b50,0x8b51,0x8b52][n-1],n]),
    ...[1,2,3,4].map((n):[string,number,number,number]=>[`${n}iv`,
      [O.OP_UNIFORM1IV,O.OP_UNIFORM2IV,O.OP_UNIFORM3IV,O.OP_UNIFORM4IV][n-1],
      [0x1404,0x8b53,0x8b54,0x8b55][n-1],n]),
    ...[2,3,4].map((n):[string,number,number,number]=>[`Matrix${n}fv`,
      [O.OP_UNIFORM_MATRIX2FV,O.OP_UNIFORM_MATRIX3FV,O.OP_UNIFORM_MATRIX4FV][n-2],0x8b5a+n-2,n*n]),
  ];
  it.each(positiveSignatures)("validates %s without native reflection on each setter", (_name,op,type,components)=>{
    const {b,native,send,query}=setup();native.uniforms=[{name:"value",size:1,type}];
    const location=uniformLocation(b,20,"value")!;
    const scalar=op<=O.OP_UNIFORM4F,matrix=type>=0x8b5a && type<=0x8b5c;
    const words=scalar?[location,...Array(components).fill(0)]:[location,0,...(matrix?[0]:[])];
    native.getActiveUniform=()=>{throw new Error("setter queried reflection");};
    send(op,words);expect(query(O.QOP_GET_ERROR)).toBe(0);
    if(!scalar) {
      send(op,[location,2,...(matrix?[0]:[]),...Array(components*2).fill(0)]);
      expect(query(O.QOP_GET_ERROR)).toBe(0x502);
    }
    b.uniformLocationRecords.get(location)!.metadata={...b.uniformLocationRecords.get(location)!.metadata,type:0x8b60};
    send(op,words);expect(query(O.QOP_GET_ERROR)).toBe(type===0x1404?0:0x502);
  });
  it.each([1,2,3,4])("allows both float and integer signatures for boolean width %s",n=>{
    const {b,native,send,query}=setup();native.uniforms=[{name:"flag",size:1,type:0x8b55+n}];
    const location=uniformLocation(b,20,"flag")!;
    for(const op of [[O.OP_UNIFORM1FV,O.OP_UNIFORM2FV,O.OP_UNIFORM3FV,O.OP_UNIFORM4FV][n-1],
      [O.OP_UNIFORM1IV,O.OP_UNIFORM2IV,O.OP_UNIFORM3IV,O.OP_UNIFORM4IV][n-1]]) {
      send(op,[location,0]);expect(query(O.QOP_GET_ERROR)).toBe(0);
    }
  });
  it("captures reduced struct fields and only the final array's remaining elements",()=>{
    const {b,native}=setup();native.uniforms=[{name:"lights[2].colors[0]",size:4,type:0x8b52},
      {name:"lights[1].enabled",size:1,type:0x8b56}];
    const location=uniformLocation(b,20,"lights[0002].colors[0003]")!;
    expect(b.uniformLocationRecords.get(location)?.metadata).toEqual({executable:b.currentProgram,type:0x8b52,array:true,remaining:1});
    const field=uniformLocation(b,20,"lights[1].enabled")!;
    expect(b.uniformLocationRecords.get(field)?.metadata?.array).toBe(false);
  });
  it("preserves metadata through failed use, failed relink and deleted-current ownership",()=>{
    const {b,native,send,query,original}=setup();const location=uniformLocation(b,20,"color")!;
    send(O.OP_CREATE_PROGRAM,[21]);send(O.OP_USE_PROGRAM,[21]);expect(query(O.QOP_GET_ERROR)).toBe(0x502);
    (b.shaders.get(11) as unknown as Shader).compiled=false;send(O.OP_LINK_PROGRAM,[20]);
    send(O.OP_UNIFORM1FV,[location,0]);expect(query(O.QOP_GET_ERROR)).toBe(0);
    expect(b.uniformLocationRecords.get(location)?.metadata?.executable).toBe(original);
    send(O.OP_DELETE_PROGRAM,[20]);send(O.OP_UNIFORM1FV,[location,0]);expect(query(O.QOP_GET_ERROR)).toBe(0);
    send(O.OP_USE_PROGRAM,[0]);expect(b.uniformLocationRecords.has(location)).toBe(false);
    expect(native.deleted.has(original)).toBe(true);
  });
  it("rejects a newer program executable's location against an older shared current executable",()=>{
    const parent=setup(),peer=sharePeer(parent);
    const old=uniformLocation(parent.b,20,"color")!;
    linkProgramRetainingExecutable(peer,20);
    expect(parent.b.currentProgram).toBe(parent.original);
    const fresh=uniformLocation(peer,20,"color")!;
    expect(parent.b.uniformLocationRecords.has(old)).toBe(false);
    expect(parent.b.uniformLocationRecords.get(fresh)?.metadata?.executable).not.toBe(parent.original);
    parent.send(O.OP_UNIFORM1FV,[fresh,0]);expect(parent.query(O.QOP_GET_ERROR)).toBe(0x502);
    useProgramIfAccepted(parent.b,20);parent.send(O.OP_UNIFORM1FV,[fresh,0]);expect(parent.query(O.QOP_GET_ERROR)).toBe(0);
    parent.registry.destroyContext(1,0);parent.registry.destroyContext(1,12);expect(peer.uniformLocationRecords.size).toBe(0);
  });
  it("does not publish a location record if its allocation fails",()=>{
    const {b}=setup();const before=b.nextUniformLoc;
    b.uniformLocationRecords.set=()=>{throw new Error("allocation failed");};
    expect(uniformLocation(b,20,"color")).toBeNull();expect(b.errors).toEqual([0x505]);
    expect(b.nextUniformLoc).toBe(before);
    for(const map of [b.uniformLocationRecords]) expect(map.has(before+1)).toBe(false);
  });
  it("does not expose reserved or invalid location records to setters or value queries",()=>{
    const {b,native,send,query}=setup();const location=uniformLocation(b,20,"color")!;
    const record=b.uniformLocationRecords.get(location)!;
    for(const state of ["reserved","invalid"] as const) {
      record.state=state;
      send(O.OP_UNIFORM1F,[location,0]);expect(query(O.QOP_GET_ERROR)).toBe(0x502);
      expect(uniformReply(b,20,location).status).toBe(1);expect(query(O.QOP_GET_ERROR)).toBe(0x502);
      expect(native.uniformWrites).toBe(0);
    }
    record.state="published";send(O.OP_UNIFORM1F,[location,0]);expect(query(O.QOP_GET_ERROR)).toBe(0);
    expect(native.uniformWrites).toBe(1);
  });
  it("invalidates an unpublished reservation without making its old native location usable",()=>{
    const parent=setup(),peer=sharePeer(parent);
    const location=uniformLocation(parent.b,20,"color")!,record=parent.b.uniformLocationRecords.get(location)!;
    record.state="reserved";record.references=1;
    linkProgramRetainingExecutable(peer,20);
    expect(record.state).toBe("invalid");expect(parent.b.uniformLocationRecords.get(location)).toBe(record);
    parent.send(O.OP_UNIFORM1F,[location,0]);expect(parent.query(O.QOP_GET_ERROR)).toBe(0x502);
    const fresh=uniformLocation(peer,20,"color")!;expect(fresh).toBeGreaterThan(location);
    expect(peer.uniformLocationRecords.get(fresh)?.native).not.toBe(record.native);
  });

  it("keeps transpose errors observable before zero-count or inactive no-ops",()=>{
    const {send,query}=setup();
    for(const op of [O.OP_UNIFORM_MATRIX2FV,O.OP_UNIFORM_MATRIX3FV,O.OP_UNIFORM_MATRIX4FV]) {
      send(op,[-1,0,1]);expect(query(O.QOP_GET_ERROR)).toBe(0x501);
    }
  });
  it("preserves pending errors and treats declared single-element arrays as arrays",()=>{
    const {b,native,send,query}=setup();native.uniforms=[{name:"single[0]",size:1,type:0x1406}];
    const location=uniformLocation(b,20,"single")!;
    let values:number[]=[];(native as any).uniform1fv=(_location:unknown,data:Float32Array)=>{values=[...data];};
    b.errors.push(0x500);send(O.OP_UNIFORM1FV,[location,3,0,0,0]);
    expect(query(O.QOP_GET_ERROR)).toBe(0x500);expect(query(O.QOP_GET_ERROR)).toBe(0);expect(values).toHaveLength(1);
    send(O.OP_UNIFORM2FV,[location,0]);expect(query(O.QOP_GET_ERROR)).toBe(0x502);
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
    parent.native.getProgramParameter=original;
    (parent.native as any).getActiveUniform=(_p:Program,index:number)=>parent.native.uniforms[index];
    const short=new TextEncoder().encode("color");const first=lookup(parent.b,0,1,short.length,short);
    expect(lookup(peer,0,2,short.length,short).location).toBe(first.location);
    expect(done.location).not.toBe(first.location);
  });
  it("rejects in-place relinking between accepted lookup chunks instead of resolving a later executable",()=>{
    const {b,send,native}=setup();send(O.OP_USE_PROGRAM,[0]);
    const text=new TextEncoder().encode("color");
    expect(lookup(b,1,1,text.length).status).toBe(0);
    expect(lookup(b,2,1,0,text).status).toBe(0);
    const program=b.programs.get(20);linkProgramRetainingExecutable(b,20);
    expect(b.programs.get(20)).toBe(program);
    const before=b.nextUniformLoc;
    expect(lookup(b,3,1).status).toBe(1);
    expect(b.nextUniformLoc).toBe(before);expect(b.uniformLookup).toBeNull();expect(b.errors).toContain(0x502);
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
    parent.registry.destroyContext(1,12);expect(peer.uniformLookup).toBeNull();expect(peer.uniformLocationRecords.size).toBe(0);
  });
  it("rejects a program retired during a name transfer and preserves location state on allocation failure",()=>{
    const {b,native}=setup();b.nextUniformLoc=1;lookup(b,1,1,1);lookup(b,2,1,0,new Uint8Array([65]));b.programs.delete(20);
    expect(lookup(b,3,1).status).toBe(1);expect(b.uniformLookup).toBeNull();expect(b.errors.pop()).toBe(0x501);
    const program=native.createProgram()!;program.linked=true;b.programs.set(20,program);
    const set=b.uniformLocationRecords.set.bind(b.uniformLocationRecords);b.uniformLocationRecords.set=()=>{throw new Error("allocation rejected");};
    const text=new TextEncoder().encode("color");expect(lookup(b,0,2,text.length,text).status).toBe(1);
    expect(b.nextUniformLoc).toBe(1);expect(b.uniformLocationRecords.has(2)).toBe(false);expect(b.uniformLocationRecords.has(2)).toBe(false);expect(b.errors.pop()).toBe(0x505);
    b.uniformLocationRecords.set=set;expect(lookup(b,0,3,text.length,text).location).toBe(2);
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
    b.uniformLocationRecords.get(1)!.program=99;expect(uniformReply(b).status).toBe(1);expect(b.errors.pop()).toBe(0x502);
    b.uniformLocationRecords.get(1)!.program=20;original.linked=false;expect(uniformReply(b).status).toBe(1);expect(b.errors.pop()).toBe(0x502);
    original.linked=true;native.getUniform=()=>{native.error=0x502;return new Float32Array(16).fill(42);};
    expect(uniformReply(b).status).toBe(1);expect(b.errors.pop()).toBe(0x502);
  });
  it("invalidates shared locations after successful peer relink and rejects failed link queries",()=>{
    const parent=setup(),peer=sharePeer(parent);
    (peer.shaders.get(11) as unknown as Shader).compiled=false;
    linkProgramRetainingExecutable(peer,20);expect(uniformReply(parent.b).status).toBe(1);expect(parent.b.errors.pop()).toBe(0x502);
    (peer.shaders.get(11) as unknown as Shader).compiled=true;
    linkProgramRetainingExecutable(peer,20);expect(parent.b.uniformLocationRecords.has(1)).toBe(false);
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
    expect(b.uniformLocationRecords.has(1)).toBe(true);
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
    expect(b.uniformLocationRecords.has(1)).toBe(false);
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
    expect(b.uniformLocationRecords.has(1)).toBe(false);
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
    expect(b.uniformLocationRecords.has(1)).toBe(true);
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
