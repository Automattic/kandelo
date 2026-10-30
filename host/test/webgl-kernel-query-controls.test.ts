import { expect, it, vi } from "vitest";
import { createWasmPosixKernelTestHarness } from "../src/kernel.js";
import { createKernelScratchTestInstance } from "./support/kernel-scratch-instance.js";
import { resizeSurfaceTarget } from "../src/webgl/present-target.js";
import { applyCurrentDrawable } from "../src/webgl/current.js";
import { encodeQueryRequest, decodeQueryReply, type QueryReceiptRequest, type QueryMode } from "../src/webgl/query-receipt-codec.js";
import * as O from "../src/webgl/ops.js";

function fixture(pointerWidth:4|8) {
  const memory=new WebAssembly.Memory({initial:2,maximum:2}), wakes:unknown[][]=[];
  const kernel=createWasmPosixKernelTestHarness({io:{} as any,memory,pointerWidth,
    callbacks:{getProcessMemory:()=>memory,onGlQueryWake:(...args:unknown[])=>wakes.push(args)},
    instance:createKernelScratchTestInstance(pointerWidth,memory,()=>({}),()=>4096)});
  const env=(kernel.testAuthority.buildImportObject(memory) as {env:Record<string,(...args:any[])=>any>}).env;
  let blocked=false;const live=new Set<object>();
  const make=()=>{const value={};live.add(value);return value;};
  const remove=(value:object)=>{if(blocked)throw new Error("native cleanup refused");live.delete(value);};
  const gl=new Proxy({getError:()=>0,isContextLost:()=>false,
    getParameter:(p:number)=>p===0x84e0?0x84c0:p===0x0d33?4096:0,
    checkFramebufferStatus:()=>0x8cd5,
  },{get:(target,key)=>Reflect.get(target,key)??(String(key).startsWith("create")?make:String(key).startsWith("delete")?remove:()=>null)}) as unknown as WebGL2RenderingContext;
  kernel.gl.bind({pid:7,sessionId:11,cmdbufAddr:0,cmdbufLen:0});
  const binding=kernel.gl.get(7,11)!;binding.gl=gl;binding.contextId=21;binding.surfaceId=31;
  resizeSurfaceTarget(binding,4,3);applyCurrentDrawable(binding,{drawSurfaceId:31,readSurfaceId:31,width:4,height:3});
  const pointer=(value:number)=>pointerWidth===8?BigInt(value):value;
  const invoke=(request:QueryReceiptRequest,capacity=4,mode?:QueryMode,pid=7,session=11)=>{
    const bytes=encodeQueryRequest(request);new Uint8Array(memory.buffer,1024,bytes.length).set(bytes);
    const rc=env.host_gl_query(pid,O.KERNEL_GL_QUERY_CONTROL,pointer(1024),pointer(bytes.length),pointer(2048),pointer(32+capacity),session);
    if(rc<0)return {error:rc};
    return decodeQueryReply(new Uint8Array(memory.buffer,2048,rc),{
      control:request.control,token:request.token,capacity,...(mode?{retirementMode:mode}:{})});
  };
  const begin=(token:bigint)=>({control:"begin",token,begin:{op:O.QOP_GET_ERROR,input:new Uint8Array(),capacity:4,
    hasCurrent:true,context:21,draw:31,read:31}} as const);
  return {kernel,env,memory,binding,gl,wakes,pointer,invoke,begin,live,blockDeletes:(value:boolean)=>{blocked=value;}};
}

it.each([4,8] as const)("routes exact owned controls through the %s-byte kernel import without eager error consumption",pointerWidth=>{
  const f=fixture(pointerWidth);f.binding.errors.push(0x501,0x500);
  expect(f.invoke(f.begin(1n))).toEqual({phase:"pending"});expect(f.wakes).toEqual([]);
  expect(f.binding.errors).toEqual([0x501,0x500]);f.kernel.drainGlQueryControls(4);
  const ready=f.invoke({control:"poll",token:1n});expect(ready).toMatchObject({phase:"ready",result:4});
  if(!("phase" in ready)||ready.phase!=="ready")throw new Error("missing owned Ready");
  expect(new DataView(ready.bytes.buffer).getUint32(0,true)).toBe(0x501);
  expect(f.binding.errors).toEqual([0x501,0x500]);
  expect(f.invoke({control:"cancel",token:1n},4,"cancel")).toEqual({phase:"retired",mode:"cancel",accepted:true});
  expect(f.binding.errors).toEqual([0x501,0x500]);
  expect(f.invoke(f.begin(2n))).toEqual({phase:"pending"});f.kernel.drainGlQueryControls(4);
  expect(f.invoke({control:"commit",token:2n},4,"commit")).toEqual({error:-22});
  expect(f.binding.errors).toEqual([0x501,0x500]);
  expect(f.invoke({control:"poll",token:2n})).toMatchObject({phase:"ready",result:4});
  expect(f.invoke({control:"commit",token:2n},4,"commit")).toEqual({phase:"retired",mode:"commit",accepted:true});
  expect(f.invoke({control:"commit",token:2n},4,"commit")).toEqual({phase:"retired",mode:"commit",accepted:true});
  expect(f.binding.errors).toEqual([0x500]);
  expect(f.invoke({control:"forget",token:2n},4,"commit")).toEqual({phase:"retired",mode:"commit",accepted:true});
  const registration=f.wakes[0][2];expect(registration).toBeGreaterThan(0);
  expect(f.wakes).toEqual([[7,11,registration,1n],[7,11,registration,1n],[7,11,registration,2n]]);
});

it.each([4,8] as const)("preflights the complete %s-byte Rust reply span before native capture",pointerWidth=>{
  const f=fixture(pointerWidth),capture=vi.spyOn(f.kernel.gl,"retainSubmitExecution");
  const bytes=encodeQueryRequest(f.begin(1n));new Uint8Array(f.memory.buffer,1024,bytes.length).set(bytes);
  expect(f.env.host_gl_query(7,O.KERNEL_GL_QUERY_CONTROL,f.pointer(1024),f.pointer(bytes.length),
    f.pointer(f.memory.buffer.byteLength-32),f.pointer(36),11)).toBe(-14);
  expect(f.env.host_gl_query(7,O.KERNEL_GL_QUERY_CONTROL,f.pointer(1024),f.pointer(bytes.length),
    f.pointer(2048),f.pointer(32),11)).toBe(-22);
  expect(capture).not.toHaveBeenCalled();expect(f.wakes).toEqual([]);
  expect(f.invoke(f.begin(1n))).toEqual({phase:"pending"});expect(capture).toHaveBeenCalledOnce();
});

it("routes retirement controls to captured custody after public context removal and refuses foreign lookups",()=>{
  const f=fixture(4);f.binding.errors.push(0x501);
  expect(f.invoke(f.begin(1n))).toEqual({phase:"pending"});f.kernel.gl.destroyContext(7,11);
  expect(f.invoke({control:"poll",token:1n},4,undefined,8)).toEqual({error:-2});
  expect(f.invoke({control:"poll",token:1n},4,undefined,7,12)).toEqual({error:-2});
  f.kernel.drainGlQueryControls(4);
  expect(f.invoke({control:"poll",token:1n})).toMatchObject({phase:"ready",result:4});
  expect(f.invoke({control:"cancel",token:1n},4,"cancel")).toEqual({phase:"retired",mode:"cancel",accepted:true});
});

it("keeps the old registration through numeric session reuse without admitting replacement work",()=>{
  const f=fixture(4);
  expect(f.invoke(f.begin(1n))).toEqual({phase:"pending"});f.kernel.gl.unbind(7,11);
  f.kernel.gl.bind({pid:7,sessionId:11,cmdbufAddr:0,cmdbufLen:0});
  const replacement=f.kernel.gl.get(7,11)!;expect(replacement.operations).not.toBe(f.binding.operations);
  const capture=vi.spyOn(f.kernel.gl,"retainSubmitExecution");
  expect(f.invoke(f.begin(2n))).toEqual({phase:"rejected",error:13});expect(capture).not.toHaveBeenCalled();
  expect(f.invoke({control:"cancel",token:1n},4,"cancel")).toEqual({phase:"retired",mode:"cancel",accepted:true});
  expect(f.kernel.gl.get(7,11)).toBe(replacement);
});

it("retains actual failed cleanup and terminal ACK metadata until independently completed lifecycle cleanup",()=>{
  const f=fixture(4),texture=f.gl.createTexture()!;f.binding.textures.set(99,texture);
  expect(f.invoke(f.begin(1n))).toEqual({phase:"pending"});
  expect(f.kernel.forgetGlQueryControlsAfterKernelLifecycle(7)).toBe(false);
  f.kernel.gl.destroyContext(7,11);f.blockDeletes(true);
  expect(f.kernel.prepareGlQueryControlTeardown(7)).toBe(false);expect(f.live.has(texture)).toBe(true);
  expect(f.kernel.forgetGlQueryControlsAfterKernelLifecycle(7)).toBe(false);
  expect(f.invoke({control:"poll",token:1n},4,"cancel")).toEqual({phase:"retiring",mode:"cancel"});
  f.blockDeletes(false);f.kernel.drainGlQueryControls(4);
  expect(f.kernel.prepareGlQueryControlTeardown(7)).toBe(true);expect(f.live.has(texture)).toBe(false);
  expect(f.invoke({control:"poll",token:1n},4,"cancel")).toEqual({phase:"retired",mode:"cancel",accepted:true});
  expect(f.kernel.forgetGlQueryControlsAfterKernelLifecycle(7)).toBe(true);
  expect(f.invoke({control:"poll",token:1n},4,"cancel")).toEqual({error:-2});
});


it.each([4,8] as const)("rejects changed first-input retries through the actual %s-byte private import without replacing custody",pointerWidth=>{
  const f=fixture(pointerWidth),capture=vi.spyOn(f.kernel.gl,"retainSubmitExecution");
  const initial=f.begin(1n),input=new Uint8Array(4);
  const original={...initial,begin:{...initial.begin,input}};
  const changed={...initial,begin:{...initial.begin,input:new Uint8Array([1,0,0,0])}};
  f.binding.errors.push(0x501);
  expect(f.invoke(original)).toEqual({phase:"pending"});
  expect(f.invoke(changed)).toEqual({error:-22});
  expect(f.invoke(original)).toEqual({phase:"pending"});
  expect(capture).toHaveBeenCalledOnce();expect(f.binding.errors).toEqual([0x501]);
  f.kernel.drainGlQueryControls(4);
  const ready=f.invoke({control:"poll",token:1n});expect(ready).toMatchObject({phase:"ready",result:4});
  expect(f.invoke(changed)).toEqual({error:-22});expect(f.invoke(original)).toEqual(ready);
  expect(f.invoke({control:"poll",token:1n})).toEqual(ready);expect(f.binding.errors).toEqual([0x501]);
  expect(capture).toHaveBeenCalledOnce();
  expect(f.invoke({control:"commit",token:1n},4,"commit")).toEqual({phase:"retired",mode:"commit",accepted:true});
  expect(f.binding.errors).toEqual([]);
  expect(f.invoke(original)).toEqual({error:-22});
  expect(f.invoke({control:"commit",token:1n},4,"commit")).toEqual({phase:"retired",mode:"commit",accepted:true});
  f.kernel.gl.unbind(7,11);
});
