import { expect, it, vi } from "vitest";
import { createCentralizedKernelWorkerTestDouble } from "../src/kernel-worker.js";
import { GlNativeQueryAdapter } from "../src/webgl/native-query-adapter.js";
import { KernelEntryGate, createKernelEntryGatedInstance } from "../src/kernel-entry-gate.js";
import { createWasmPosixKernelTestHarness } from "../src/kernel.js";
import { installKernelWorkerTestScratch } from "./kernel-worker-test-scratch.js";
import { createKernelScratchTestInstance } from "./support/kernel-scratch-instance.js";
import { resizeSurfaceTarget } from "../src/webgl/present-target.js";
import { applyCurrentDrawable } from "../src/webgl/current.js";
import { encodeQueryRequest, decodeQueryReply, type QueryReceiptRequest } from "../src/webgl/query-receipt-codec.js";
import * as O from "../src/webgl/ops.js";

function fixture(width:4|8=4) {
  const memory=new WebAssembly.Memory({initial:2,maximum:2});
  const fatals:Error[]=[];
  const worker=createCentralizedKernelWorkerTestDouble({callbacks:{onKernelFatal:error=>{fatals.push(error);}}});
  let exportAction:(()=>void)|undefined;
  const gate=new KernelEntryGate(),instance=createKernelEntryGatedInstance(createKernelScratchTestInstance(width,memory,
    ()=>({kernel_handle_channel:()=>{exportAction?.();return 0;}}),()=>width===8?4096n:4096),gate);
  installKernelWorkerTestScratch(worker,memory,4096,width,{boundInstance:instance,gate});
  const kernel=createWasmPosixKernelTestHarness({io:{} as any,memory,pointerWidth:width,
    instance:createKernelScratchTestInstance(width,memory,()=>({}),()=>4096)});
  worker.testAuthority.replaceKernelForScratchBoundaryTest(kernel);
  const env=(kernel.testAuthority.buildImportObject(memory) as {env:Record<string,(...args:any[])=>any>}).env;
  let inImport=false,blocked=false;const calls:number[]=[];
  const gl=new Proxy({getError:()=>0,isContextLost:()=>false,
    getParameter:(p:number)=>p===0x84e0?0x84c0:0,checkFramebufferStatus:()=>0x8cd5,
    finish:()=>{expect(inImport).toBe(false);calls.push(1);},
  },{get:(target,key)=>Reflect.get(target,key)??(String(key).startsWith("create")?()=>({}):String(key).startsWith("delete")?()=>{if(blocked)throw new Error("cleanup refused");}:()=>null)}) as unknown as WebGL2RenderingContext;
  const add=(session:number)=>{
    kernel.gl.bind({pid:7,sessionId:session,cmdbufAddr:0,cmdbufLen:0});
    const b=kernel.gl.get(7,session)!;b.gl=gl;b.contextId=session+10;b.surfaceId=session+20;
    resizeSurfaceTarget(b,4,3);applyCurrentDrawable(b,{drawSurfaceId:session+20,readSurfaceId:session+20,width:4,height:3});return b;
  };
  const binding=add(11),p=(value:number)=>width===8?BigInt(value):value;
  const invoke=(request:QueryReceiptRequest,session=11)=>{
    const bytes=encodeQueryRequest(request);new Uint8Array(memory.buffer,1024,bytes.length).set(bytes);
    inImport=true;let rc:number;
    try {rc=env.host_gl_query(7,O.KERNEL_GL_QUERY_CONTROL,p(1024),p(bytes.length),p(2048),p(32),session);}
    finally {inImport=false;}
    return rc<0?{error:rc}:decodeQueryReply(new Uint8Array(memory.buffer,2048,rc),{control:request.control,token:request.token,capacity:0,
      ...(request.control==="commit"||request.control==="cancel"?{retirementMode:request.control}:{})});
  };
  const begin=(token=1n,session=11)=>({control:"begin",token,begin:{op:O.QOP_FINISH,input:new Uint8Array(),capacity:0,
    hasCurrent:true,context:session+10,draw:session+20,read:session+20}} as const);
  const fromExport=(action:()=>void)=>{
    exportAction=action;
    try {(instance.exports.kernel_handle_channel as (...args:any[])=>number)(p(4096),0,width,0n);}
    finally {exportAction=undefined;}
  };
  return {worker,kernel,env,gl,binding,calls,fatals,add,invoke,begin,fromExport,block:(value:boolean)=>{blocked=value;}};
}
async function turn():Promise<void> {await new Promise<void>(resolve=>setImmediate(resolve));}

it.each([4,8] as const)("runs admitted private %s-byte query on a fresh shared-worker turn without manual draining",async width=>{
  const f=fixture(width);
  f.fromExport(()=>{expect(f.invoke(f.begin())).toEqual({phase:"pending"});expect(f.calls).toEqual([]);});
  await turn();expect(f.invoke({control:"poll",token:1n})).toMatchObject({phase:"ready",result:0});expect(f.calls).toHaveLength(1);
  await turn();expect(f.calls).toHaveLength(1);
  expect(f.invoke({control:"commit",token:1n})).toEqual({phase:"retired",mode:"commit",accepted:true});
});

it("preserves an accepted prefix and progresses beyond one visit quota across exact owners",async()=>{
  const f=fixture(),prefix=f.binding.operations.reserve("commands")!;expect(prefix.start()).toBe(true);
  expect(f.invoke(f.begin())).toEqual({phase:"pending"});
  for(let session=12;session<90;session++){f.add(session);expect(f.invoke(f.begin(1n,session),session)).toEqual({phase:"pending"});}
  await turn();expect(f.calls.length).toBeGreaterThan(0);
  for(let i=0;i<6;i++)await turn();expect(f.calls).toHaveLength(78);
  expect(f.invoke({control:"poll",token:1n})).toEqual({phase:"pending"});
  prefix.finish(); // A later private control is an explicit renewed work signal.
  expect(f.invoke({control:"poll",token:1n})).toEqual({phase:"pending"});await turn();expect(f.calls).toHaveLength(79);
});

it("does not spin on a blocked prefix or failed cleanup and retries only on a renewed control",async()=>{
  const f=fixture(),drain=vi.spyOn(f.kernel,"drainGlQueryControls"),prefix=f.binding.operations.reserve("commands")!;
  expect(prefix.start()).toBe(true);f.invoke(f.begin());await turn();const count=drain.mock.calls.length;
  for(let i=0;i<3;i++)await turn();expect(drain).toHaveBeenCalledTimes(count);expect(f.calls).toEqual([]);
  prefix.finish();f.invoke({control:"poll",token:1n});await turn();expect(f.calls).toHaveLength(1);
  f.block(true);f.kernel.gl.destroyContext(7,11);
  expect(f.invoke({control:"cancel",token:1n})).toEqual({phase:"retiring",mode:"cancel"});await turn();const failed=drain.mock.calls.length;
  for(let i=0;i<3;i++)await turn();expect(drain).toHaveBeenCalledTimes(failed);
  f.block(false);f.invoke({control:"cancel",token:1n});await turn();expect(f.invoke({control:"cancel",token:1n})).toEqual({phase:"retired",mode:"cancel",accepted:true});
});

it("revokes scheduled and late work hints from a replaced exact backend generation",async()=>{
  const old=fixture(),replacement=fixture(),oldDrain=vi.spyOn(old.kernel,"drainGlQueryControls"),newDrain=vi.spyOn(replacement.kernel,"drainGlQueryControls");
  old.invoke(old.begin());old.worker.testAuthority.replaceKernelForScratchBoundaryTest(replacement.kernel);
  expect(old.invoke({control:"poll",token:1n})).toEqual({phase:"pending"});await turn();
  expect(oldDrain).not.toHaveBeenCalled();expect(newDrain).not.toHaveBeenCalled();expect(old.calls).toEqual([]);
  replacement.invoke(replacement.begin());await turn();expect(replacement.calls).toHaveLength(1);
  expect(old.calls).toEqual([]);expect(old.invoke({control:"cancel",token:1n})).toEqual({phase:"retired",mode:"cancel",accepted:true});
});

it("stops scheduled work after a worker fault without pretending retained physical custody was retired",async()=>{
  const f=fixture(),capture=vi.spyOn(f.kernel.gl,"retainSubmitExecution");f.invoke(f.begin());
  const work=capture.mock.results[0].value!;expect(work.context).toBe(f.gl);
  const drain=vi.spyOn(f.kernel,"drainGlQueryControls").mockImplementation(()=>{throw new Error("forced worker fault");});
  await turn();await Promise.resolve();expect(f.fatals).toHaveLength(1);
  f.kernel.gl.destroyContext(7,11);expect(work.context).toBe(f.gl);
  f.invoke({control:"poll",token:1n});for(let i=0;i<3;i++)await turn();expect(drain).toHaveBeenCalledOnce();
  expect(work.context).toBe(f.gl);expect(f.calls).toEqual([]);
});

it("notifies work after uncertain native admission even when the initial backend response is lost",async()=>{
  const f=fixture(),original=GlNativeQueryAdapter.prototype.control;
  vi.spyOn(GlNativeQueryAdapter.prototype,"control").mockImplementationOnce(function(...args){
    original.apply(this,args);throw new Error("response lost after actual admission");
  });
  expect(f.invoke(f.begin())).toEqual({error:-5});expect(f.calls).toEqual([]);await turn();
  expect(f.invoke({control:"poll",token:1n})).toMatchObject({phase:"ready",result:0});expect(f.calls).toHaveLength(1);
  expect(f.invoke({control:"commit",token:1n})).toEqual({phase:"retired",mode:"commit",accepted:true});
});
