import { fileURLToPath } from "node:url";
import { expect, test } from "../playwright-test";
const source=fileURLToPath(new URL("../../../host/src/webgl/",import.meta.url));
test.use({serviceWorkers:"block"});
test("fatal batch samples the original native getter and attributes unexpected flags",async({page,browser})=>{
 const pageErrors:string[]=[];page.on("pageerror",e=>pageErrors.push(e.message));await page.goto("/trap-signal-test.html");
 const result=await page.evaluate(async source=>{
  const load=(name:string)=>import(/* @vite-ignore */ `/@fs${source}${name}.ts`);
  const [nativeBatch,{GlContextRegistry},{GlMuxer},{prepareScalarState},{decodeAndDispatch},audit,{nativeGlFault},{setGlDiagnosticReporter},{rendererLost},O]=await Promise.all([load("native-batch"),load("registry"),load("muxer"),load("scalar-state"),load("bridge"),load("native-audit"),load("native-recovery"),load("diagnostics"),load("renderer-loss"),load("ops")]);
  // Install BEFORE configure/getContext: the audit captures this original
  // getter. A wrapper added to gl.getError afterwards would miss its oracle.
  let prototype:object|null=WebGL2RenderingContext.prototype,descriptor:PropertyDescriptor|undefined;
  while(prototype&&!descriptor){descriptor=Object.getOwnPropertyDescriptor(prototype,"getError");if(!descriptor)prototype=Object.getPrototypeOf(prototype);}
  if(!prototype||!descriptor||typeof descriptor.value!=="function")throw Error("Native getError prototype unavailable");
  const saved=descriptor,nativeGetter=descriptor.value;let nativeReads=0;
  Object.defineProperty(prototype,"getError",{...descriptor,value:function(this:WebGL2RenderingContext){nativeReads++;return Reflect.apply(nativeGetter,this,[]);}});
  const rows:unknown[]=[],diagnostics:unknown[]=[];
  setGlDiagnosticReporter((d:unknown)=>diagnostics.push(d));
  try{
   audit.configureGlAudit({mode:"fatal",sink:(r:unknown)=>rows.push(r),fault:(m:string)=>nativeGlFault(m)});
   const canvas=document.createElement("canvas");canvas.width=canvas.height=16;
   const gl=canvas.getContext("webgl2",{preserveDrawingBuffer:true,antialias:false,premultipliedAlpha:false});if(!gl)throw Error("WebGL2 unavailable");
   const registry=new GlContextRegistry();registry.bind({pid:7,sessionId:11,cmdbufAddr:0,cmdbufLen:128});const b=registry.get(7,11)!;b.gl=gl;b.contextId=21;prepareScalarState(b);new GlMuxer(gl).switchTo(b);
   const wire=new Uint8Array(20+20+8),v=new DataView(wire.buffer);let at=0;
   const command=(op:number,values:number[],floating=false)=>{v.setUint16(at,op,true);v.setUint16(at+2,values.length*4,true);for(let i=0;i<values.length;i++)floating?v.setFloat32(at+4+i*4,values[i],true):v.setUint32(at+4+i*4,values[i],true);at+=4+values.length*4;};
   command(O.OP_VIEWPORT,[0,0,16,16]);command(O.OP_CLEAR_COLOR,[.25,.5,.75,1],true);command(O.OP_CLEAR,[gl.COLOR_BUFFER_BIT]);
   b.cmdbufView=wire;const before=nativeReads;
   const rc=nativeBatch.withNativeBatch(b,"real native sampler",()=>decodeAndDispatch(b,0,wire.length));
   const batchReads=nativeReads-before;
   const pixels=new Uint8Array(4);gl.readPixels(8,8,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
   const peer={gl,pid:8,sessionId:12,errors:[] as number[]};let failure="";
   try{nativeBatch.withNativeBatch(b,"invalid native acceptance",()=>gl.enable(0xdead));}catch(error){failure=String(error);}
   return{rc,batchReads,pixels:[...pixels],failure,guiltyLost:rendererLost(b),peerLost:rendererLost(peer),rows,diagnostics};
  }finally{audit.resetGlAuditForTesting();setGlDiagnosticReporter(null);Object.defineProperty(prototype,"getError",saved);}
 },source);
 expect(result.rc).toBe(0);expect(result.batchReads).toBe(1);
 expect(result.pixels).toEqual([64,128,191,255]);expect(result.failure).toContain("NativeGlFault");expect(result.guiltyLost).toBe(true);expect(result.peerLost).toBe(false);
 expect(result.rows).toContainEqual(expect.objectContaining({kind:"divergence",cause:"batch-native-error",pid:7,session:11,observed:"INVALID_ENUM",op:null}));
 expect(result.diagnostics).toContainEqual(expect.objectContaining({pid:7,source:"gl-context-reset"}));
 expect(pageErrors).toEqual([]);console.log(JSON.stringify({engine:browser.browserType().name(),version:browser.version(),...result}));
});
