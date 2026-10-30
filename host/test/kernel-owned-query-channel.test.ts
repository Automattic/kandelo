import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolveBinary } from "../src/binary-resolver.js";
import { createCentralizedKernelWorkerTestDouble, CAPTURED_STDIO } from "../src/kernel-worker.js";
import { WasmPosixKernel, getWasmPosixKernelRuntimeAccess } from "../src/kernel.js";
import { installKernelWorkerTestScratch } from "./kernel-worker-test-scratch.js";
import { VirtualPlatformIO } from "../src/vfs/vfs.js";
import { NodeTimeProvider } from "../src/vfs/time.js";
import { FixedTreeBackend } from "./support/fixed-tree-backend.js";
import { decodeQueryRequest, encodeQueryRequest } from "../src/webgl/query-receipt-codec.js";
import { GlNativeQueryAdapter } from "../src/webgl/native-query-adapter.js";
import { ABI_SYSCALLS as S, CH_ARGS, CH_ARG_SIZE, CH_DATA, CH_ERRNO, CH_RETURN, CH_STATUS, CH_SYSCALL, CH_TOTAL_SIZE } from "../src/generated/abi.js";
import { QOP_GET_ERROR, OP_VERSION } from "../src/webgl/ops.js";

// Normal prepared runs use the normal resolver. Focused bridge development can
// explicitly name its actual compiler output without claiming normal product
// acceptance. Neither path belongs in the graphics source-only gate.
const wasm=readFileSync(process.env.KANDELO_TEST_OWNED_QUERY_KERNEL_WASM ?? resolveBinary("kernel.wasm"));
afterEach(()=>vi.restoreAllMocks());
async function turn() {await new Promise<void>(resolve=>setImmediate(resolve));}
async function until(predicate:()=>boolean) {for(let index=0;index<20&&!predicate();index++)await turn();expect(predicate()).toBe(true);}
function words(...values:number[]) {const out=new Uint8Array(values.length*4),view=new DataView(out.buffer);values.forEach((value,index)=>view.setUint32(index*4,value,true));return out;}
async function fixture(width:4|8=4) {
  const memory=new WebAssembly.Memory({initial:64,maximum:64,shared:true}),channelOffset=0x10000;
  const io=new VirtualPlatformIO([{mountPoint:"/",backend:new FixedTreeBackend({"/":{mode:0o040755,ino:1}})}],new NodeTimeProvider());
  const kernel=new WasmPosixKernel({maxWorkers:1,dataBufferSize:65536,useSharedMemory:true},io,{getProcessMemory:()=>memory});
  await kernel.init(wasm);
  const worker=createCentralizedKernelWorkerTestDouble({io}),access=getWasmPosixKernelRuntimeAccess(kernel);
  installKernelWorkerTestScratch(worker,access.memory()!,0,4,{boundInstance:access.instance()!,gate:access.gate});
  const merge=vi.spyOn(kernel,"mergeCallbacks");
  worker.testAuthority.replaceKernelForScratchBoundaryTest(kernel);
  const wake=merge.mock.calls.at(-1)![0].onGlQueryWake!;merge.mockRestore();
  const pid=worker.createProcess(CAPTURED_STDIO);
  worker.registerProcess(pid,memory,[channelOffset],{ptrWidth:width,brkBase:0x30000,mmapBase:0x80000,maxAddr:0x400000});
  const [channel]=worker.testAuthority.replaceProcessRegistrationForLifecycleTest({pid,memory,channelOffsets:[channelOffset],pointerWidth:width});
  worker.testAuthority.configureScratchBoundaryHooksForTest({relistenChannel:()=>{}});
  const view=()=>new DataView(memory.buffer,channelOffset,CH_TOTAL_SIZE);
  const prepare=(syscall:number,args:(number|bigint)[])=>{
    const v=view();v.setUint32(CH_SYSCALL,syscall,true);v.setUint32(CH_ERRNO,0,true);v.setBigInt64(CH_RETURN,0n,true);
    for(let i=0;i<6;i++)v.setBigInt64(CH_ARGS+i*CH_ARG_SIZE,BigInt(args[i]??0),true);
    Atomics.store(new Int32Array(memory.buffer,channelOffset),CH_STATUS/4,1);
  };
  const issue=(syscall:number,args:(number|bigint)[])=>{
    prepare(syscall,args);worker.testAuthority.dispatchRegisteredMainChannelForAdvisoryLockTest(pid);
    expect(view().getUint32(CH_ERRNO,true)).toBe(0);return Number(view().getBigInt64(CH_RETURN,true));
  };
  const bytes=(at:number,value:Uint8Array)=>new Uint8Array(memory.buffer,at,value.length).set(value);
  const open=()=>{bytes(4096,new TextEncoder().encode("/dev/dri/renderD128\0"));return issue(S.Open,[4096,2,0]);};
  const ioctl=(fd:number,op:number,input:Uint8Array)=>{bytes(4096,input);issue(S.Ioctl,[fd,op,4096]);return new Uint8Array(memory.buffer,4096,input.length).slice();};
  const display=open(),init=ioctl(display,0x40,words(OP_VERSION,1,0xffffffff,0)),displayId=new DataView(init.buffer).getUint32(12,true);
  const fd=open();ioctl(fd,0x40,words(OP_VERSION,2,display,displayId));
  issue(S.Mmap,[0,1<<20,3,1,fd,0]);
  const binding=kernel.gl.get(pid)!;
  let blocked=false;const nativeErrors:number[]=[];
  const gl=new Proxy({getError:()=>nativeErrors.shift()??0,isContextLost:()=>false,
    getParameter:(p:number)=>p===0x84e0?0x84c0:0,checkFramebufferStatus:()=>0x8cd5,
  },{get:(target,key)=>Reflect.get(target,key)??(String(key).startsWith("create")?()=>({}):String(key).startsWith("delete")?()=>{if(blocked)throw new Error("native cleanup refused");}:()=>null)}) as unknown as WebGL2RenderingContext;
  binding.gl=gl;
  const context=ioctl(fd,0x42,words(2,0,0,0));ioctl(fd,0x46,words(new DataView(context.buffer).getUint32(12,true),0,0));
  const native=access.instance()!.exports;
  expect((native.kernel_set_current_tid as (pid:number,tid:number)=>number)(pid,pid)).toBe(0);
  const peerTid=(native.kernel_clone as (...args:number[])=>number)(0,0x60000,0x10100,0,0,0,0);
  expect(peerTid).toBeGreaterThan(pid);
  // Independent real kernel scratch ingress exercises fd close/reuse without
  // overwriting the original guest's parked mailbox.
  const rawIssue=(syscall:number,args:(number|bigint)[],path?:string)=>{
    const instance=access.instance()!,km=access.memory()!;
    const scratch=(instance.exports.kernel_alloc_scratch as (size:number)=>number)(CH_TOTAL_SIZE);
    const out=new DataView(km.buffer,scratch,CH_TOTAL_SIZE);new Uint8Array(km.buffer,scratch,CH_TOTAL_SIZE).fill(0);
    out.setUint32(CH_SYSCALL,syscall,true);
    const actual=[...args];
    if(path){new Uint8Array(km.buffer,scratch+CH_DATA).set(new TextEncoder().encode(path+"\0"));actual[0]=scratch+CH_DATA;}
    for(let i=0;i<6;i++)out.setBigInt64(CH_ARGS+i*CH_ARG_SIZE,BigInt(actual[i]??0),true);
    expect((instance.exports.kernel_set_current_tid as (pid:number,tid:number)=>number)(pid,peerTid)).toBe(0);
    (instance.exports.kernel_handle_channel as (p:number,n:number,pid:number,token:bigint)=>number)(scratch,CH_TOTAL_SIZE,pid,0n);
    expect(out.getUint32(CH_ERRNO,true)).toBe(0);return Number(out.getBigInt64(CH_RETURN,true));
  };
  const start=()=>{
    bytes(8192,width===4?words(QOP_GET_ERROR,0,0,12288,4,0):words(QOP_GET_ERROR,0,0,0,0,0,12288,0,4,0));bytes(12288,words(0xfeedface));
    prepare(S.Ioctl,[fd,0x49,8192]);return worker.testAuthority.beginOwnedGlQueryForTest(channel!);
  };
  return {kernel,worker,memory,pid,fd,channel:channel!,view,issue,prepare,bytes,binding,gl,nativeErrors,start,rawIssue,access,wake,block:(value:boolean)=>{blocked=value;}};
}

it.each([4,8] as const)("publishes a real Rust %s-byte captured result once, then releases only after channel publication",async width=>{
  const f=await fixture(width);f.binding.errors.push(0x501,0x500);const controls=vi.spyOn(GlNativeQueryAdapter.prototype,"control");
  const token=f.start();expect(token).toBeGreaterThan(0n);expect(f.view().getUint32(CH_STATUS,true)).toBe(1);
  f.bytes(8192,new Uint8Array(24).fill(0xff));
  await until(()=>f.worker.testAuthority.ownedGlQueryStateForTest(f.channel)===null);
  expect(new DataView(f.memory.buffer).getUint32(12288,true)).toBe(0x501);
  expect(f.view().getUint32(CH_STATUS,true)).toBe(2);expect(f.view().getUint32(CH_ERRNO,true)).toBe(0);
  expect(f.binding.errors).toEqual([0x500]);expect(controls.mock.calls.length).toBeGreaterThanOrEqual(4);
});

it("retains uncertain Begin and Commit acknowledgements without repeating error publication",async()=>{
  const f=await fixture();f.binding.errors.push(0x501,0x500);const original=GlNativeQueryAdapter.prototype.control;
  const lost=new Set<string>();
  vi.spyOn(GlNativeQueryAdapter.prototype,"control").mockImplementation(function(this:GlNativeQueryAdapter,owner,bytes){
    const op=new DataView(bytes.buffer,bytes.byteOffset).getUint16(6,true);
    const result=original.call(this,owner,bytes);
    if((op===1||op===3)&&!lost.has(String(op))){lost.add(String(op));throw new Error("actual native ACK lost");}
    return result;
  });
  f.start();await until(()=>f.worker.testAuthority.ownedGlQueryStateForTest(f.channel)===null);
  expect(lost.size).toBe(2);expect(f.binding.errors).toEqual([0x500]);
  expect(new DataView(f.memory.buffer).getUint32(12288,true)).toBe(0x501);
  expect(f.view().getUint32(CH_STATUS,true)).toBe(2);
});

it("cancels after actual fresh-copyout EFAULT, preserving the prepared logical error",async()=>{
  const f=await fixture();f.binding.errors.push(0x501);f.start();
  // Begin is already admitted; the next fresh copyout loses memory authority.
  f.kernel.mergeCallbacks({getProcessMemory:()=>undefined});
  await until(()=>f.worker.testAuthority.ownedGlQueryStateForTest(f.channel)===null);
  expect(new DataView(f.memory.buffer).getUint32(12288,true)).toBe(0xfeedface);
  expect(f.binding.errors).toEqual([0x501]);expect(f.view().getUint32(CH_ERRNO,true)).toBe(14);
});

it("does not deliver an old result into an altered PENDING mailbox",async()=>{
  const f=await fixture();f.binding.errors.push(0x501);f.start();
  f.view().setBigInt64(CH_ARGS+2*CH_ARG_SIZE,16384n,true);
  await until(()=>f.worker.testAuthority.ownedGlQueryStateForTest(f.channel)===null);
  expect(f.view().getUint32(CH_STATUS,true)).toBe(1);
  expect(new DataView(f.memory.buffer).getUint32(12288,true)).toBe(0xfeedface);
  expect(f.binding.errors).toEqual([0x501]);
});

it("rejects a replacement process registration even when its Memory and mailbox address are identical",async()=>{
  const f=await fixture();f.binding.errors.push(0x501);f.start();
  const [replacement]=f.worker.testAuthority.replaceProcessRegistrationForLifecycleTest({pid:f.pid,memory:f.memory,channelOffsets:[f.channel.channelOffset]});
  expect(replacement).not.toBe(f.channel);
  await until(()=>f.worker.testAuthority.ownedGlQueryStateForTest(f.channel)===null);
  expect(f.view().getUint32(CH_STATUS,true)).toBe(1);
  expect(new DataView(f.memory.buffer).getUint32(12288,true)).toBe(0xfeedface);
});

it("schedules unsent cancellation after owner preparation throws instead of orphaning the captured Rust pin",async()=>{
  const f=await fixture(),controls=vi.spyOn(GlNativeQueryAdapter.prototype,"control");
  vi.spyOn(f.kernel,"prepareGlQueryControlOwner").mockImplementationOnce(()=>{throw new Error("owner preparation refused");});
  expect(f.start()).toBeGreaterThan(0n);
  expect(f.worker.testAuthority.ownedGlQueryStateForTest(f.channel)?.preparationFailure).toEqual({kind:"exception"});
  await until(()=>f.worker.testAuthority.ownedGlQueryStateForTest(f.channel)===null);
  expect(controls).not.toHaveBeenCalled();expect(f.view().getUint32(CH_ERRNO,true)).toBe(4);
});

it("does not spin on uncertain native cleanup and completes on explicit renewed work",async()=>{
  const f=await fixture();f.start();
  f.block(true);f.kernel.gl.destroyContext(f.pid,f.binding.sessionId);
  f.worker.testAuthority.retryOwnedGlQueryForTest(f.channel,true);
  for(let i=0;i<5;i++)await turn();
  const controls=vi.spyOn(GlNativeQueryAdapter.prototype,"control");
  for(let i=0;i<5;i++)await turn();expect(controls).not.toHaveBeenCalled();
  expect(f.worker.testAuthority.ownedGlQueryStateForTest(f.channel)).not.toBe(null);
  f.block(false);f.worker.testAuthority.retryOwnedGlQueryForTest(f.channel,true);
  await until(()=>f.worker.testAuthority.ownedGlQueryStateForTest(f.channel)===null);
  expect(f.view().getUint32(CH_ERRNO,true)).toBe(4);
});


it("retains the exact last pin and source registration after real fd close/reuse without retry spin",async()=>{
  const f=await fixture();f.binding.errors.push(0x501);const token=f.start();
  expect(f.rawIssue(S.Close,[f.fd])).toBe(0);
  expect(f.rawIssue(S.Open,[0,2,0],"/dev/null")).toBe(f.fd);
  await until(()=>f.worker.testAuthority.ownedGlQueryStateForTest(f.channel)?.published===true);
  for(let i=0;i<5;i++)await turn();
  expect(f.worker.testAuthority.ownedGlQueryStateForTest(f.channel)).toMatchObject({token,terminal:0,published:true,dirty:false});
  expect(f.kernel.gl.get(f.pid,f.binding.sessionId)).toBe(f.binding);
  const exports=f.access.instance()!.exports;
  expect((exports.kernel_gl_query_session as (...args:any[])=>bigint)(f.pid,f.pid,token)).toBe(BigInt(f.binding.sessionId));
  expect((exports.kernel_gl_query_release as (...args:any[])=>number)(f.pid,f.pid,token)).toBe(-16);
  const controls=vi.spyOn(GlNativeQueryAdapter.prototype,"control");
  for(let i=0;i<5;i++)await turn();expect(controls).not.toHaveBeenCalled();
  f.worker.testAuthority.retryOwnedGlQueryForTest(f.channel);for(let i=0;i<3;i++)await turn();
  expect(f.worker.testAuthority.ownedGlQueryStateForTest(f.channel)?.dirty).toBe(false);
  expect(f.kernel.gl.get(f.pid,f.binding.sessionId)).toBe(f.binding);
});


it("ignores wrong owner/session/token hints and only polls once on an exact renewed wake",async()=>{
  const f=await fixture(),prefix=f.binding.operations.reserve("commands")!;expect(prefix.start()).toBe(true);
  const prepared=f.kernel.prepareGlQueryControlOwner(f.pid,f.binding.sessionId);if("error" in prepared)throw new Error("fixture owner refused");
  const owner=prepared.owner,token=f.start();for(let i=0;i<4;i++)await turn();
  const controls=vi.spyOn(GlNativeQueryAdapter.prototype,"control");
  f.wake(f.pid,f.binding.sessionId,owner.registration+1,token);
  f.wake(f.pid,f.binding.sessionId+1,owner.registration,token);
  f.wake(f.pid,f.binding.sessionId,owner.registration,token+1n);
  for(let i=0;i<3;i++)await turn();expect(controls).not.toHaveBeenCalled();
  f.wake(f.pid,f.binding.sessionId,owner.registration,token);
  for(let i=0;i<3;i++)await turn();expect(controls).toHaveBeenCalledTimes(1);
  prefix.finish();f.worker.testAuthority.retryOwnedGlQueryForTest(f.channel);
  await until(()=>f.worker.testAuthority.ownedGlQueryStateForTest(f.channel)===null);
});

it("captures source storage before returning private intent and retains it through later context retirement",async()=>{
  const f=await fixture(),capture=vi.spyOn(f.kernel.gl,"retainSubmitExecution");f.binding.errors.push(0x501);
  f.start();expect(capture).toHaveBeenCalledOnce();
  const work=capture.mock.results[0]!.value!;expect(work.context).toBe(f.gl);
  f.kernel.gl.destroyContext(f.pid,f.binding.sessionId);expect(work.context).toBe(f.gl);
  await until(()=>f.worker.testAuthority.ownedGlQueryStateForTest(f.channel)===null);
  expect(new DataView(f.memory.buffer).getUint32(12288,true)).toBe(0x501);
  expect(f.view().getUint32(CH_STATUS,true)).toBe(2);
});


it("does not narrow a wasm64 guest header address in the actual wasm32 kernel capture export",async()=>{
  const f=await fixture(8),capture=vi.spyOn(f.kernel.gl,"retainSubmitExecution");
  f.bytes(8192,words(QOP_GET_ERROR,0,0,0,0,0,12288,0,4,0));
  f.prepare(S.Ioctl,[f.fd,0x49,0x1_0000_2000n]);
  expect(f.worker.testAuthority.beginOwnedGlQueryForTest(f.channel)).toBe(-14n);
  expect(capture).not.toHaveBeenCalled();expect(f.worker.testAuthority.ownedGlQueryStateForTest(f.channel)).toBe(null);
});


it("suppresses old channel completion when its mailbox changes during the final native ACK",async()=>{
  const f=await fixture();f.binding.errors.push(0x501);const original=GlNativeQueryAdapter.prototype.control;
  vi.spyOn(GlNativeQueryAdapter.prototype,"control").mockImplementation(function(this:GlNativeQueryAdapter,owner,bytes){
    const result=original.call(this,owner,bytes);
    if(new DataView(bytes.buffer,bytes.byteOffset).getUint16(6,true)===3)f.view().setBigInt64(CH_ARGS+2*CH_ARG_SIZE,16384n,true);
    return result;
  });
  f.start();await until(()=>f.worker.testAuthority.ownedGlQueryStateForTest(f.channel)===null);
  expect(f.view().getUint32(CH_STATUS,true)).toBe(1);
  expect(new DataView(f.memory.buffer).getUint32(12288,true)).toBe(0x501);
  expect(f.binding.errors).toEqual([]);
});


it("drives the first Commit on a later turn when actual retained native storage is already Ready at Begin acknowledgement",async()=>{
  const f=await fixture();f.binding.errors.push(0x501);const original=GlNativeQueryAdapter.prototype.control;
  let commits=0;
  vi.spyOn(GlNativeQueryAdapter.prototype,"control").mockImplementation(function(this:GlNativeQueryAdapter,owner,bytes){
    const request=decodeQueryRequest(bytes);
    if(request.control==="commit")commits++;
    const result=original.call(this,owner,bytes);
    if(request.control!=="begin")return result;
    // Exercise the strict already-ready reply edge with the real native
    // receipt/candidate, not a fabricated successful result or cleanup ACK.
    this.drain(1);
    return original.call(this,owner,encodeQueryRequest({control:"poll",token:request.token}));
  });
  f.start();expect(commits).toBe(0);expect(f.view().getUint32(CH_STATUS,true)).toBe(1);
  expect(new DataView(f.memory.buffer).getUint32(12288,true)).toBe(0x501);expect(f.binding.errors).toEqual([0x501]);
  await until(()=>f.worker.testAuthority.ownedGlQueryStateForTest(f.channel)===null);
  expect(commits).toBe(1);expect(f.binding.errors).toEqual([]);
});
