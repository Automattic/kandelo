import {fileURLToPath} from "node:url";
import {writeFileSync} from "node:fs";
import {expect,test} from "@playwright/test";
import {installBrowserMemoryBoundaryProbe,memoryBoundaryFailures} from "./support/browser-memory-boundary";
const source=fileURLToPath(new URL("../../../host/src/webgl/",import.meta.url));
test.use({serviceWorkers:"block"});
for(const capture of [false,true])for(const audit of [false,true])test(`owned VBO draw retains ${capture?"static capture":"definition"} across shared replacement (${audit?"fatal":"production"})`,async({page,browser})=>{
 const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));await installBrowserMemoryBoundaryProbe(page);await page.goto("/trap-signal-test.html");
 const result=await page.evaluate(async({source,capture,audit})=>{
  const load=(n:string)=>import(/* @vite-ignore */ `/@fs${source}${n}.ts`);
  const [{GlContextRegistry},{GlMuxer},{runGlQuery},{decodeAndDispatch},{bindBufferObject,replaceBufferData},
   {deleteBufferNames,collectRetiredBuffers},nativeBatch,{configureGlAudit,resetGlAuditForTesting},{nativeGlFault}]=await Promise.all([
   load("registry"),load("muxer"),load("query"),load("bridge"),load("buffer-storage"),load("buffer-references"),load("native-batch"),load("native-audit"),load("native-recovery")]);
  const auditRows:any[]=[];if(audit)configureGlAudit({mode:"fatal",sink:(r:unknown)=>auditRows.push(r),fault:(m:string)=>nativeGlFault(m)});
  const canvas=document.createElement("canvas");canvas.width=canvas.height=16;const gl=canvas.getContext("webgl2",{preserveDrawingBuffer:true});if(!gl)throw new Error("WebGL2 unavailable");
  const live=new Set<WebGLBuffer>(),create=gl.createBuffer.bind(gl),remove=gl.deleteBuffer.bind(gl),getError=gl.getError.bind(gl);let created=0,deleted=0,errorReads=0;
  gl.createBuffer=()=>{const b=create();if(b){created++;live.add(b);}return b;};gl.deleteBuffer=b=>{remove(b);if(b&&live.delete(b))deleted++;};gl.getError=()=>{errorReads++;return getError();};
  const registry=new GlContextRegistry(),muxer=new GlMuxer(gl),ARRAY=0x8892,STATIC=0x88e4;
  const make=(session:number)=>{registry.bind({pid:1,sessionId:session,cmdbufAddr:0,cmdbufLen:256});const b=registry.get(1,session)!;b.gl=gl;b.contextId=session+1;return b;};
  const b=make(0);b.robustAccess=true;const execution=registry.retainContextExecution(1,0,muxer);if(!execution)throw new Error("No execution owner");
  const query=(words:number[])=>{const out=new Uint8Array(48);if(runGlQuery(b,0x3b,new Uint8Array(new Uint32Array(words).buffer),out,execution)!==48)throw new Error("Query refused");return [...new Uint32Array(out.buffer)];};
  const emit=(op:number,words:number[],tail=new Uint8Array())=>{const cmd=new Uint8Array(4+words.length*4+tail.byteLength),v=new DataView(cmd.buffer);v.setUint16(0,op,true);v.setUint16(2,cmd.byteLength-4,true);words.forEach((w,i)=>v.setUint32(4+i*4,w,true));cmd.set(tail,4+words.length*4);b.cmdbufView=cmd;if(decodeAndDispatch(b,0,cmd.byteLength))throw new Error("Command refused");};
  const reserved=query([1,1,4]),id=reserved[3];if(reserved[0]||query([10,2,id,2])[4]!==2)throw new Error("Bank unavailable");
  if(!bindBufferObject(b,ARRAY,7))throw new Error("Bind failed");const original=b.buffers.get(7)!;
  const bytes=new Uint8Array(new Float32Array([-1,-1,1,-1,0,1]).buffer);
  b.vertexArrays.get(0)!.attributes.set(0,{buffer:original,enabled:true,size:2,type:0x1406,normalized:false,stride:0,offset:0});
  if(capture){replaceBufferData(b,ARRAY,bytes,STATIC);if(query([11,3,id,0,1,0])[4]!==24)throw new Error("Static capture failed");}
  else if(nativeBatch.withNativeBatch(b,"owned-definition",()=>emit(0x107,[id,0,1,ARRAY,24,STATIC],bytes)))throw new Error("Definition reset");
  const peer=make(12);if(!registry.shareObjects(1,12,0)||!bindBufferObject(peer,ARRAY,7))throw new Error("Peer failed");replaceBufferData(peer,ARRAY,new Uint8Array([8,9]),STATIC);
  bindBufferObject(b,ARRAY,0);deleteBufferNames(peer,[7]);collectRetiredBuffers(peer);const originalHeld=gl.isBuffer(original);
  if(!bindBufferObject(peer,ARRAY,7))throw new Error("Reuse failed");const replacement=peer.buffers.get(7)!;
  const identityRefused=b.programJournal!.resolveBufferSnapshot(0,1,replacement,24)===null;
  const shader=(type:number,text:string)=>{const s=gl.createShader(type)!;gl.shaderSource(s,text);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(s)??"compile");return s;};
  const v=shader(gl.VERTEX_SHADER,"#version 300 es\nin vec2 p;void main(){gl_Position=vec4(p,0.,1.);}"),f=shader(gl.FRAGMENT_SHADER,"#version 300 es\nprecision mediump float;out vec4 c;void main(){c=vec4(.2,.6,.8,1.);}"),program=gl.createProgram()!;
  gl.attachShader(program,v);gl.attachShader(program,f);gl.bindAttribLocation(program,0,"p");gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program)??"link");
  const vao=gl.createVertexArray();gl.bindVertexArray(vao);gl.bindBuffer(ARRAY,original);gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);gl.enableVertexAttribArray(0);gl.bindBuffer(ARRAY,b.shadow.arrayBuffer);
  b.currentProgram=program;gl.useProgram(program);gl.viewport(0,0,16,16);gl.clearColor(0,0,0,1);gl.clear(gl.COLOR_BUFFER_BIT);
  const before=errorReads;
  if(nativeBatch.withNativeBatch(b,"owned-buffer-draw",()=>emit(0x507,[id,4,0,3,1,0,0,1,2,0x1406,0,0,0])))throw new Error("Draw reset");
  const drawNativeChecks=errorReads-before,pointerRestored=gl.getVertexAttrib(0,gl.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING)===original;
  const pixel=new Uint8Array(4);gl.readPixels(8,8,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);const ordinaryBytes=b.bufferStores.get(original)!.size;
  b.currentProgram=null;gl.useProgram(null);gl.deleteProgram(program);gl.deleteShader(v);gl.deleteShader(f);gl.bindVertexArray(null);gl.deleteVertexArray(vao);gl.bindBuffer(ARRAY,peer.shadow.arrayBuffer);
  b.vertexArrays.get(0)!.attributes.clear();collectRetiredBuffers(peer);const originalCollected=!gl.isBuffer(original);
  const nativeClean=gl.getError()===0,logicalErrors=[...b.errors,...peer.errors];b.programJournal!.retire();execution.release();registry.unbind(1);const finalClean=gl.getError()===0;resetGlAuditForTesting();
  return {drawNativeChecks,pointerRestored,pixel:[...pixel],ordinaryBytes,originalHeld,originalCollected,identityRefused,nativeClean,finalClean,logicalErrors,created,deleted,live:live.size,auditRows};
 },{source,capture,audit});
 writeFileSync(test.info().outputPath("owned-draw-result.json"),JSON.stringify({engine:test.info().project.name,version:browser.version(),capture,audit,...result},null,2));
 expect(result.pixel).toEqual([51,153,204,255]);expect(result.ordinaryBytes).toBe(2);expect(result.pointerRestored&&result.originalHeld&&result.originalCollected&&result.identityRefused).toBe(true);
 expect(result.drawNativeChecks).toBe(1);expect(result.nativeClean&&result.finalClean).toBe(true);expect(result.logicalErrors).toEqual([]);expect(result.live).toBe(0);expect(result.deleted).toBe(result.created);
 expect(result.auditRows.filter((r:any)=>r.kind==="divergence")).toEqual([]);expect(errors).toEqual([]);expect(await memoryBoundaryFailures(page)).toEqual([]);
});
