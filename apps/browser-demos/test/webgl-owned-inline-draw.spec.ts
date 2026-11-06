import {test,expect} from "@playwright/test";
import {fileURLToPath} from "node:url";
import {writeFileSync} from "node:fs";
import {installBrowserMemoryBoundaryProbe,memoryBoundaryFailures} from "./support/browser-memory-boundary";
test.use({serviceWorkers:"block"});
for(const audit of [false,true])test(`cold owned inline upload preserves first, changing pixels and cleanup (${audit?"fatal":"production"})`,async({page,baseURL,browser})=>{
 const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
 await installBrowserMemoryBoundaryProbe(page);await page.goto(new URL("/trap-signal-test.html",baseURL).href);
 const source=fileURLToPath(new URL("../../../host/src/webgl/",import.meta.url));
 const result=await page.evaluate(async({source,audit})=>{
  const load=(name:string)=>import(/* @vite-ignore */ `/@fs${source}${name}.ts`);
  const [{GlContextRegistry},{GlMuxer},{GlInlineDraws},nativeBatch,{configureGlAudit,resetGlAuditForTesting},{nativeGlFault}]=await Promise.all([
   load("registry"),load("muxer"),load("owned-inline-draw"),load("native-batch"),load("native-audit"),load("native-recovery")]);
  const auditRows:any[]=[];if(audit)configureGlAudit({mode:"fatal",sink:(value:any)=>auditRows.push(value),fault:(message:string)=>nativeGlFault(message)});
  const canvas=document.createElement("canvas");canvas.width=canvas.height=16;
  const gl=canvas.getContext("webgl2",{preserveDrawingBuffer:true})!;if(!gl)throw new Error("WebGL2 unavailable");
  let created=0,deleted=0,draws=0,errorReads=0;const live=new Set<WebGLBuffer>();
  const create=gl.createBuffer.bind(gl),remove=gl.deleteBuffer.bind(gl),nativeDraw=gl.drawArrays.bind(gl),nativeError=gl.getError.bind(gl);
  gl.createBuffer=()=>{const value=create();if(value){created++;live.add(value);}return value;};
  gl.deleteBuffer=value=>{remove(value);if(value&&live.delete(value))deleted++;};
  gl.drawArrays=(mode,first,count)=>{draws++;nativeDraw(mode,first,count);};gl.getError=()=>{errorReads++;return nativeError();};
  const registry=new GlContextRegistry();registry.bind({pid:79,sessionId:0,cmdbufAddr:0,cmdbufLen:128});const b=registry.get(79)!;b.gl=gl;b.contextId=1;
  const execution=registry.retainContextExecution(79,0,new GlMuxer(gl))!;
  const publicArray=gl.createBuffer()!;b.buffers.set(1,publicArray);b.shadow.arrayBuffer=publicArray;gl.bindBuffer(gl.ARRAY_BUFFER,publicArray);
  b.vertexArrays.get(0)!.attributes.set(0,{buffer:null,enabled:true,size:2,type:gl.FLOAT,normalized:false,stride:0,offset:0});
  const shader=(type:number,text:string)=>{const shader=gl.createShader(type)!;gl.shaderSource(shader,text);gl.compileShader(shader);if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(shader)??"compile");return shader;};
  const vs=shader(gl.VERTEX_SHADER,"#version 300 es\nin vec2 p;uniform int minimumId;void main(){gl_Position=gl_VertexID<minimumId?vec4(2.,2.,0.,1.):vec4(p,0.,1.);}"),fs=shader(gl.FRAGMENT_SHADER,"#version 300 es\nprecision mediump float;uniform vec4 tint;out vec4 c;void main(){c=tint;}");
  const program=gl.createProgram()!;gl.attachShader(program,vs);gl.attachShader(program,fs);gl.bindAttribLocation(program,0,"p");gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program)??"link");
  gl.useProgram(program);b.currentProgram=program;const tint=gl.getUniformLocation(program,"tint"),minimum=gl.getUniformLocation(program,"minimumId");
  gl.enableVertexAttribArray(0);gl.viewport(0,0,16,16);
  const beforeCold=created,map=Array.prototype.map;let refused=false;
  try{Array.prototype.map=()=>{throw new Error("injected cold inline CPU metadata refusal");};refused=GlInlineDraws.reserve(b)===null;}finally{Array.prototype.map=map;}
  const cold={refused,created:created-beforeCold,errors:[...b.errors]};b.errors.length=0;
  const bank=GlInlineDraws.reserve(b)!;if(!bank||!bank.initialize(execution))throw new Error("inline admission failed");
  const proof={executionView:bank.executionView(b)!,issue(draw:any){draw.issue();return true;}};
  const wire=(first:number,fixed:boolean)=>{
   const points=fixed?new Int32Array([-65536,-65536,196608,-65536,-65536,196608]):new Float32Array([-1,-1,3,-1,-1,3]);
   const bytes=new Uint8Array(48+points.byteLength),v=new DataView(bytes.buffer);
   [1,0,1,4,first,3,1,0,2,fixed?0x140c:gl.FLOAT,0,points.byteLength].forEach((word,i)=>v.setUint32(i*4,word,true));bytes.set(new Uint8Array(points.buffer),48);return v;
  };
  const common=wire(3,false),compactBytes=new Uint8Array(common.byteLength-12);compactBytes.set(new Uint8Array(common.buffer,12));
  const compact=new DataView(compactBytes.buffer);compact.setUint32(0,4|(1<<3)|(3<<13),true);compact.setUint32(8,1,true);compact.setUint32(12,1,true);
  const wires=[wire(0,false),wire(3,false),wire(3,true),compact],pixels:number[][]=[],samples:number[]=[];
  const pixel=new Uint8Array(4);
  for(let i=0;i<wires.length;i++){
   const first=i===0?0:3;b.vertexArrays.get(0)!.attributes.get(0)!.type=i===2?0x140c:gl.FLOAT;
   gl.uniform1i(minimum,first);gl.uniform4f(tint,i%2?.8:.2,i%2?.2:.6,i%2?.6:.8,1);gl.clearColor(0,0,0,1);gl.clear(gl.COLOR_BUFFER_BIT);
   const before=errorReads;
   const originalMap=Array.prototype.map,flat=Array.prototype.flatMap,set=WeakMap.prototype.set,TypedArray=globalThis.Uint8Array;
   try{
    if(i){const forbidden=()=>{throw new Error("injected warm inline metadata refusal");};Array.prototype.map=forbidden;Array.prototype.flatMap=forbidden;WeakMap.prototype.set=forbidden;globalThis.Uint8Array=class extends TypedArray{constructor(){throw new Error("warm inline typed-array allocation");}} as typeof Uint8Array;}
    if(nativeBatch.withNativeBatch(b,"owned inline real pixels",()=>{if(!(i===3?bank.drawPreparedCompact(b,wires[i],proof):bank.drawPrepared(b,wires[i],proof)))throw new Error("inline refused");}))throw new Error("inline reset");
   }finally{Array.prototype.map=originalMap;Array.prototype.flatMap=flat;WeakMap.prototype.set=set;globalThis.Uint8Array=TypedArray;}
   samples.push(errorReads-before);gl.readPixels(8,8,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);pixels.push(Array.from(pixel));
   if(gl.getParameter(gl.ARRAY_BUFFER_BINDING)!==publicArray)throw new Error("public selection was not restored");
  }
  b.currentProgram=null;gl.useProgram(null);gl.deleteProgram(program);gl.deleteShader(vs);gl.deleteShader(fs);
  if(!bank.retire())throw new Error("stream retirement refused");execution.release();registry.unbind(79);
  const clean=gl.getError()===0;resetGlAuditForTesting();return{cold,pixels,samples,draws,created,deleted,live:live.size,clean,errors:[...b.errors],auditRows};
 },{source,audit});
 writeFileSync(test.info().outputPath("inline-result.json"),JSON.stringify({engine:test.info().project.name,version:browser.version(),audit,...result},null,2));
 expect(result.cold).toEqual({refused:true,created:0,errors:[0x505]});expect(result.pixels).toEqual([[51,153,204,255],[204,51,153,255],[51,153,204,255],[204,51,153,255]]);
 expect(result.samples).toEqual([1,1,1,1]);expect(result.draws).toBe(4);expect(result.created).toBe(result.deleted);expect(result.live).toBe(0);expect(result.clean).toBe(true);expect(result.errors).toEqual([]);
 expect(result.auditRows.filter((row:any)=>row.kind==="divergence")).toEqual([]);expect(errors).toEqual([]);expect(await memoryBoundaryFailures(page)).toEqual([]);
});
