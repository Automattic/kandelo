import {fileURLToPath} from "node:url";
import {writeFileSync} from "node:fs";
import {expect,test} from "@playwright/test";
import {installBrowserMemoryBoundaryProbe,memoryBoundaryFailures} from "./support/browser-memory-boundary";
const source=fileURLToPath(new URL("../../../host/src/webgl/",import.meta.url));
test.use({serviceWorkers:"block"});
for(const journal of [false,true])for(const audit of [false,true])test(`scalar state keeps first/warm framebuffer pixels (journal ${journal}, audit ${audit})`,async({page,browser})=>{
 const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));await installBrowserMemoryBoundaryProbe(page);await page.goto("/trap-signal-test.html");
 const result=await page.evaluate(async({source,journal,audit})=>{
  const load=(name:string)=>import(/* @vite-ignore */ `/@fs${source}${name}.ts`);
  const [{GlContextRegistry},{GlMuxer},{GlProgramJournal},{prepareScalarState},{decodeAndDispatch},nativeBatch,{configureGlAudit,resetGlAuditForTesting},{nativeGlFault},{observeRendererLoss},O]=await Promise.all([load("registry"),load("muxer"),load("program-journal"),load("scalar-state"),load("bridge"),load("native-batch"),load("native-audit"),load("native-recovery"),load("renderer-loss"),load("ops")]);
  const auditRows:any[]=[];if(audit)configureGlAudit({mode:"fatal",sink:(r:unknown)=>auditRows.push(r),fault:(m:string)=>nativeGlFault(m)});
  const canvas=document.createElement("canvas");canvas.width=canvas.height=16;const gl=canvas.getContext("webgl2",{preserveDrawingBuffer:true,antialias:false,premultipliedAlpha:false});if(!gl)throw new Error("WebGL2 unavailable");
  const reg=new GlContextRegistry();reg.bind({pid:7,sessionId:11,cmdbufAddr:0,cmdbufLen:65536});const b=reg.get(7,11)!;b.gl=gl;b.contextId=21;
  prepareScalarState(b);observeRendererLoss(b);const muxer=new GlMuxer(gl),execution=journal?reg.retainContextExecution(7,11,muxer):null;if(journal&&!GlProgramJournal.create(execution!,4))throw new Error("Journal admission refused");
  const fields=[b.shadow.viewport,b.shadow.scissor.rect,b.shadow.clearColor,b.shadow.blendColor,b.shadow.colorMask,b.shadow.depthRange],make=(rows:[number,number[],boolean?][])=>{
   const size=rows.reduce((n,row)=>n+4+row[1].length*4,0),bytes=new Uint8Array(size),v=new DataView(bytes.buffer);let p=0;
   for(const [op,values,floating]of rows){v.setUint16(p,op,true);v.setUint16(p+2,values.length*4,true);for(let i=0;i<values.length;i++)floating?v.setFloat32(p+4+i*4,values[i],true):v.setUint32(p+4+i*4,values[i],true);p+=4+values.length*4;}return bytes;
  };
  const first=make([[O.OP_VIEWPORT,[0,0,16,16]],[O.OP_SCISSOR,[0,0,8,16]],[O.OP_ENABLE,[gl.SCISSOR_TEST]],[O.OP_COLOR_MASK,[1,0,1,0]],[O.OP_CLEAR_COLOR,[.25,.5,.75,.5],true],[O.OP_CLEAR,[gl.COLOR_BUFFER_BIT]]]);
  const warm=make([[O.OP_VIEWPORT,[2,3,14,13]],[O.OP_DISABLE,[gl.SCISSOR_TEST]],[O.OP_COLOR_MASK,[1,1,1,1]],[O.OP_CLEAR_COLOR,[.75,.25,.5,.5],true],[O.OP_BLEND_COLOR,[.25,.5,.75,.5],true],[O.OP_DEPTH_RANGEF,[.8,.2],true],[O.OP_CLEAR,[gl.COLOR_BUFFER_BIT]]]);
  gl.clearColor(0,0,0,1);gl.clear(gl.COLOR_BUFFER_BIT);
  const getError=gl.getError.bind(gl);let checks=0;gl.getError=()=>{checks++;return getError();};
  const getParameter=gl.getParameter.bind(gl),getExtension=gl.getExtension.bind(gl);let lateCapabilities=0;
  gl.getParameter=(p:number)=>{if(p===gl.MAX_VIEWPORT_DIMS){lateCapabilities++;throw new Error("late viewport capability");}return getParameter(p);};gl.getExtension=()=>{lateCapabilities++;throw new Error("late scalar extension capability");};
  const samples:number[][]=[],nativeChecks:number[]=[];
  const issue=(bytes:Uint8Array)=>{
   b.cmdbufView=bytes;const before=checks,Data=globalThis.DataView,Int=globalThis.Int32Array,Float=globalThis.Float32Array,map=Array.prototype.map,flat=Array.prototype.flatMap,set=WeakMap.prototype.set;
   const forbidden=()=>{throw new Error("late scalar CPU metadata allocation");};
   try{globalThis.DataView=new Proxy(Data,{construct:forbidden});globalThis.Int32Array=new Proxy(Int,{construct:forbidden});globalThis.Float32Array=new Proxy(Float,{construct:forbidden});Array.prototype.map=forbidden;Array.prototype.flatMap=forbidden;WeakMap.prototype.set=forbidden;
    if(nativeBatch.withNativeBatch(b,"scalar framebuffer batch",()=>decodeAndDispatch(b,0,bytes.length)))throw new Error("Scalar execution refused");
   }finally{globalThis.DataView=Data;globalThis.Int32Array=Int;globalThis.Float32Array=Float;Array.prototype.map=map;Array.prototype.flatMap=flat;WeakMap.prototype.set=set;}
   nativeChecks.push(checks-before);
  };
  const read=(x:number)=>{const pixel=new Uint8Array(4);gl.readPixels(x,8,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);samples.push([...pixel]);};
  issue(first);read(4);read(12);issue(warm);read(4);read(12);issue(warm);read(4);
  const stable=fields[0]===b.shadow.viewport&&fields[1]===b.shadow.scissor.rect&&fields[2]===b.shadow.clearColor&&fields[3]===b.shadow.blendColor&&fields[4]===b.shadow.colorMask&&fields[5]===b.shadow.depthRange;
  gl.getParameter=getParameter;gl.getExtension=getExtension;const nativeRange=Array.from(gl.getParameter(gl.DEPTH_RANGE) as Float32Array),logicalRange=[...b.shadow.depthRange],viewport=[...b.shadow.viewport],logicalErrors=[...b.errors];b.programJournal?.retire();execution?.release();reg.unbind(7);const clean=gl.getError()===0;resetGlAuditForTesting();return {samples,nativeChecks,stable,lateCapabilities,nativeRange,logicalRange,viewport,logicalErrors,clean,auditRows};
 },{source,journal,audit});
 writeFileSync(test.info().outputPath("scalar-state.json"),JSON.stringify({engine:test.info().project.name,version:browser.version(),journal,audit,...result},null,2));
 expect(result.samples).toEqual([[64,0,191,255],[0,0,0,255],[191,64,128,128],[191,64,128,128],[191,64,128,128]]);expect(result.nativeChecks).toEqual([1,1,1]);expect(result.stable).toBe(true);expect(result.lateCapabilities).toBe(0);expect(result.viewport).toEqual([2,3,14,13]);expect(result.logicalRange[0]).toBeCloseTo(.8,6);expect(result.logicalRange[1]).toBeCloseTo(.2,6);expect(result.nativeRange[0]).toBeCloseTo(.2,6);expect(result.nativeRange[1]).toBeCloseTo(.8,6);expect(result.logicalErrors).toEqual([]);expect(result.clean).toBe(true);expect(result.auditRows.filter((r:any)=>r.kind==="divergence")).toEqual([]);expect(errors).toEqual([]);expect(await memoryBoundaryFailures(page)).toEqual([]);
});
