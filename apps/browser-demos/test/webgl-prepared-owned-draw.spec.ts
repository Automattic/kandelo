import {fileURLToPath} from "node:url";
import {writeFileSync} from "node:fs";
import {expect,test} from "../playwright-test";
import {installBrowserMemoryBoundaryProbe,memoryBoundaryFailures} from "./support/browser-memory-boundary";
const source=fileURLToPath(new URL("../../../host/src/webgl/",import.meta.url));
test.use({serviceWorkers:"block"});
for(const audit of [false,true])test(`cold-owned two-sampler ALPHA and current peer traits (${audit?"fatal":"production"})`,async({page,browser})=>{
 const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));await installBrowserMemoryBoundaryProbe(page);await page.goto("/trap-signal-test.html");
 const result=await page.evaluate(async({source,audit})=>{
  const load=(name:string)=>import(/* @vite-ignore */ `/@fs${source}${name}.ts`);
  const [{GlContextRegistry},{GlMuxer},{PreparedOwnedDraw},{recordLinkedSources},{recordTextureLevel},{setTextureFilters},
   {framebufferInputsChanged},nativeBatch,{configureGlAudit,resetGlAuditForTesting},{nativeGlFault},{uniformLayout},{decodeAndDispatch},{OP_UNIFORM1I},{RENDERER_LOST},{runGlQuery},{bindBufferObject,replaceBufferData}]=await Promise.all([
   load("registry"),load("muxer"),load("prepared-owned-draw"),load("reversed-depth"),load("texture-levels"),load("lod-switchover"),
   load("framebuffer-revision"),load("native-batch"),load("native-audit"),load("native-recovery"),load("uniform-layout"),load("bridge"),load("ops"),load("renderer-loss"),load("query"),load("buffer-storage")]);
  const auditRows:any[]=[];if(audit)configureGlAudit({mode:"fatal",sink:(r:unknown)=>auditRows.push(r),fault:(m:string)=>nativeGlFault(m)});
  const canvas=document.createElement("canvas");canvas.width=canvas.height=16;const gl=canvas.getContext("webgl2",{preserveDrawingBuffer:true});if(!gl)throw new Error("WebGL2 unavailable");
  let shaderCreates=0,programCreates=0,reflections=0,errorReads=0,pendingControlledNativeError=0,drawCalls=0;
  const rawDraw=gl.drawArrays.bind(gl);gl.drawArrays=(mode,first,count)=>{drawCalls++;rawDraw(mode,first,count);};const failures:string[]=[];
  const createShader=gl.createShader.bind(gl),createProgram=gl.createProgram.bind(gl),getError=gl.getError.bind(gl),getUniform=gl.getUniform.bind(gl),getUniformLocation=gl.getUniformLocation.bind(gl),getActiveUniform=gl.getActiveUniform.bind(gl),link=gl.linkProgram.bind(gl);
  gl.createShader=(t:number)=>{shaderCreates++;return createShader(t);};gl.createProgram=()=>{programCreates++;return createProgram();};
  gl.getError=()=>{errorReads++;if(pendingControlledNativeError){const error=pendingControlledNativeError;pendingControlledNativeError=0;return error;}return getError();};gl.getUniform=(p,l)=>{reflections++;return getUniform(p,l);};gl.getUniformLocation=(p,n)=>{reflections++;return getUniformLocation(p,n);};gl.getActiveUniform=(p,i)=>{reflections++;return getActiveUniform(p,i);};
  gl.linkProgram=p=>{link(p);if(!gl.getProgramParameter(p,gl.LINK_STATUS))failures.push(gl.getProgramInfoLog(p)??"link failure");};
  const vertex="attribute vec2 p;varying vec2 uv;void main(){gl_Position=vec4(p,0.,1.);uv=p*.5+.5;}";
  const fragment="precision mediump float;uniform sampler2D image,palette;varying vec2 uv;void main(){float index=texture2D(image,uv).a;gl_FragColor=texture2D(palette,vec2(index,.5));}";
  const shader=(type:number,text:string)=>{const s=gl.createShader(type)!;gl.shaderSource(s,text);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(s)??"compile failure");return s;};
  const vs=shader(gl.VERTEX_SHADER,vertex),fs=shader(gl.FRAGMENT_SHADER,fragment),primary=gl.createProgram()!;gl.attachShader(primary,vs);gl.attachShader(primary,fs);gl.bindAttribLocation(primary,0,"p");gl.linkProgram(primary);if(!gl.getProgramParameter(primary,gl.LINK_STATUS))throw new Error(failures.join("\n"));gl.useProgram(primary);gl.uniform1i(gl.getUniformLocation(primary,"image"),0);gl.uniform1i(gl.getUniformLocation(primary,"palette"),1);
  const registry=new GlContextRegistry(),muxer=new GlMuxer(gl);registry.bind({pid:1,sessionId:0,cmdbufAddr:0,cmdbufLen:65536});const b=registry.get(1,0)!;b.gl=gl;b.contextId=1;b.programs.set(20,primary);b.programShaders.set(20,new Set());b.currentProgram=b.shadow.currentProgram=primary;b.currentProgramId=20;recordLinkedSources(primary,vertex,fragment,false);
  const textures=[gl.createTexture()!,gl.createTexture()!];
  const spec=(unit:number,depth=false)=>{const object=textures[unit],width=depth?1:unit===0?320:256,height=depth?1:unit===0?200:1;
   recordTextureLevel(object,gl.TEXTURE_2D,0,{width,height,internalFormat:depth?gl.DEPTH_COMPONENT16:unit===0?gl.ALPHA:gl.RGBA,format:depth?gl.DEPTH_COMPONENT:unit===0?gl.ALPHA:gl.RGBA,type:depth?gl.UNSIGNED_SHORT:gl.UNSIGNED_BYTE,compressed:false,gles:{internalFormat:depth?gl.DEPTH_COMPONENT:unit===0?gl.ALPHA:gl.RGBA,format:depth?gl.DEPTH_COMPONENT:unit===0?gl.ALPHA:gl.RGBA,type:depth?gl.UNSIGNED_SHORT:gl.UNSIGNED_BYTE,expanded:false,colorRenderable:!depth&&unit===1,depth,stencil:false}});
  };
  const palette=new Uint8Array(256*4);for(let i=0;i<256;i++)palette.set(i<128?[51,153,204,255]:[204,51,102,255],i*4);
  for(let i=0;i<2;i++){gl.activeTexture(gl.TEXTURE0+i);gl.bindTexture(gl.TEXTURE_2D,textures[i]);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
   gl.texImage2D(gl.TEXTURE_2D,0,i===0?gl.ALPHA:gl.RGBA,i===0?320:256,i===0?200:1,0,i===0?gl.ALPHA:gl.RGBA,gl.UNSIGNED_BYTE,i===0?new Uint8Array(320*200).fill(64):palette);b.textures.set(i+2,textures[i]);b.shadow.textureUnits[i]=textures[i];spec(i);setTextureFilters(textures[i],gl.NEAREST,gl.NEAREST);
  }
  gl.activeTexture(gl.TEXTURE0);b.shadow.activeTexture=0;
  const vao=gl.createVertexArray();gl.bindVertexArray(vao);if(!bindBufferObject(b,gl.ARRAY_BUFFER,7)||!replaceBufferData(b,gl.ARRAY_BUFFER,new Uint8Array(new Float32Array([-1,-1,3,-1,-1,3]).buffer),gl.STATIC_DRAW))throw new Error("Logical buffer setup refused");const buffer=b.buffers.get(7)!;gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);gl.enableVertexAttribArray(0);b.vertexArrays.get(0)!.attributes.set(0,{buffer,enabled:true,size:2,type:gl.FLOAT,normalized:false,stride:0,offset:0});gl.viewport(0,0,16,16);
  const execution=registry.retainContextExecution(1,0,muxer)!;
  const query=(words:number[])=>{const out=new Uint8Array(48);if(runGlQuery(b,0x3b,new Uint8Array(new Uint32Array(words).buffer),out,execution)!==48)throw new Error("Query failed");return [...new Uint32Array(out.buffer)];};
  const id=query([1,1,4])[3];if(query([10,2,id,1])[4]!==1||query([11,3,id,0,1,0])[4]!==24)throw new Error("Owned buffer admission failed");
  const ready=query([13,4,id,0,1,0,0xffffffff,0]);const proof=b.programJournal!.ownedDraw(0,1,0xffffffff,0);if(ready[0]||ready[4]!==1||!proof)throw new Error(`Preparation refused: ${JSON.stringify({ready,failures,errors:b.errors,shaderCreates,programCreates,native:gl.getError()})}`);
  let wire=new Uint8Array(72),wireView=new DataView(wire.buffer);wireView.setUint16(0,0x050a,true);wireView.setUint16(2,68,true);[id,4,0,3,1,0,1,0xffffffff,0,0,0,1,2,gl.FLOAT,0,0,0].forEach((word,i)=>wireView.setUint32(4+i*4,word,true));
  const cold={shaderCreates,programCreates,reflections};const draw={mode:4,maxVertex:2,issue:()=>gl.drawArrays(gl.TRIANGLES,0,3),vertices:()=>{throw new Error("late vertex gathering");}};
  const samples:number[][]=[],checks:number[]=[];
  const issue=()=>{const before=errorReads;
   const Float=globalThis.Float32Array,Int=globalThis.Int32Array,Data=globalThis.DataView,MapSet=WeakMap.prototype.set,map=Array.prototype.map,flatMap=Array.prototype.flatMap;
   const forbidden=()=>{throw new Error("late CPU metadata construction during accepted draw");};
   try{
    globalThis.Float32Array=new Proxy(Float,{construct:forbidden});globalThis.Int32Array=new Proxy(Int,{construct:forbidden});globalThis.DataView=new Proxy(Data,{construct:forbidden});
    Array.prototype.map=forbidden;Array.prototype.flatMap=forbidden;WeakMap.prototype.set=forbidden;
    b.cmdbufView=wire;if(nativeBatch.withNativeBatch(b,"prepared two-sampler wire draw",()=>decodeAndDispatch(b,0,wire.byteLength)))throw new Error("Owned draw reset");
   }finally{globalThis.Float32Array=Float;globalThis.Int32Array=Int;globalThis.DataView=Data;Array.prototype.map=map;Array.prototype.flatMap=flatMap;WeakMap.prototype.set=MapSet;}
   checks.push(errorReads-before);const pixel=new Uint8Array(4);gl.readPixels(8,8,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);samples.push([...pixel]);};
  // A token proves cold readiness, not immutable public context state. Raw
  // clients can reuse it after legitimate changes; refuse before fetches or
  // writes, retaining ordinary INVALID_OPERATION and a usable peer renderer.
  const staleCases:number[]=[];
  for(const kind of ["program","texture","stencil","framebuffer"]){
   const program=b.currentProgram,input=b.shadow.textureUnits[0],ref=b.shadow.stencil.back.ref,fbo=b.shadow.fbo;
   if(kind==="program")b.currentProgram=null;else if(kind==="texture")b.shadow.textureUnits[0]=textures[1];else if(kind==="stencil")b.shadow.stencil.back.ref=1;else b.shadow.fbo={} as WebGLFramebuffer;
   const before=drawCalls;b.cmdbufView=wire;const rc=nativeBatch.withNativeBatch(b,"stale owned wire",()=>decodeAndDispatch(b,0,wire.byteLength));
   staleCases.push(rc,drawCalls-before,...b.errors);b.errors.length=0;b.currentProgram=program;b.shadow.textureUnits[0]=input;b.shadow.stencil.back.ref=ref;b.shadow.fbo=fbo;
  }
  const malformed=new Uint8Array(wire.byteLength+7);malformed.set(wire);new DataView(malformed.buffer).setUint16(wire.byteLength,0x0001,true);new DataView(malformed.buffer).setUint16(wire.byteLength+2,8,true);const beforeMalformed=drawCalls;b.cmdbufView=malformed;const malformedResult=decodeAndDispatch(b,0,malformed.byteLength),malformedWrites=drawCalls-beforeMalformed;
  issue();gl.activeTexture(gl.TEXTURE0);gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,320,200,gl.ALPHA,gl.UNSIGNED_BYTE,new Uint8Array(320*200).fill(192));issue();
  // A future sharing peer may mutate the same native image generation. The
  // accepted proof must choose a cold-built variant from its current traits.
  registry.bind({pid:1,sessionId:12,cmdbufAddr:0,cmdbufLen:256});const peer=registry.get(1,12)!;peer.gl=gl;peer.contextId=13;if(!registry.shareObjects(1,12,0))throw new Error("Peer sharing refused");
  gl.texImage2D(gl.TEXTURE_2D,0,gl.DEPTH_COMPONENT16,1,1,0,gl.DEPTH_COMPONENT,gl.UNSIGNED_SHORT,new Uint16Array([32768]));spec(0,true);framebufferInputsChanged();issue();
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST_MIPMAP_LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);setTextureFilters(textures[0],gl.NEAREST_MIPMAP_LINEAR,gl.LINEAR);framebufferInputsChanged();issue();
  const warm={shaderCreates,programCreates,reflections};
  const originalWire=wire,attribute=b.vertexArrays.get(0)!.attributes.get(0)!,originalBuffer=attribute.buffer;attribute.buffer=null;
  const inlineReady=query([13,5,id,1,1,1,0xffffffff,0]);if(inlineReady[0]||inlineReady[4]!==1)throw new Error("Inline family readiness unavailable");
  const points=new Uint8Array(new Float32Array([-1,-1,3,-1,-1,3]).buffer),common=new Uint8Array(76),commonView=new DataView(common.buffer);commonView.setUint16(0,0x050b,true);commonView.setUint16(2,72,true);[id,1,1,4,3,3,1,0,2,gl.FLOAT,0,24].forEach((word,i)=>commonView.setUint32(4+i*4,word,true));common.set(points,52);
  const compact=new Uint8Array(64),compactView=new DataView(compact.buffer);compactView.setUint16(0,0x050c,true);compactView.setUint16(2,60,true);[4|(1<<3)|(1<<8)|(3<<13),3,id,1,0,2,gl.FLOAT,0,24].forEach((word,i)=>compactView.setUint32(4+i*4,word,true));compact.set(points,40);
  const inlineCold={shaderCreates,programCreates,reflections};wire=common;issue();wire=compact;issue();const inlineWarm={shaderCreates,programCreates,reflections};wire=originalWire;attribute.buffer=originalBuffer;gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);gl.bindBuffer(gl.ARRAY_BUFFER,b.shadow.arrayBuffer);

  // This is a controlled native-error observation, not physical GPU memory
  // exhaustion: reject one setter without changing its native value, then
  // expose native505 through the ordinary submitted-batch sample. A healthy
  // peer's shared mirror must reconcile before its private variant uploads.
  gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,textures[0]);gl.texImage2D(gl.TEXTURE_2D,0,gl.ALPHA,320,200,0,gl.ALPHA,gl.UNSIGNED_BYTE,new Uint8Array(320*200).fill(64));gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);spec(0);setTextureFilters(textures[0],gl.NEAREST,gl.NEAREST);
  gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,textures[1]);gl.generateMipmap(gl.TEXTURE_2D);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST_MIPMAP_LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);setTextureFilters(textures[1],gl.NEAREST_MIPMAP_LINEAR,gl.LINEAR);gl.activeTexture(gl.TEXTURE0);framebufferInputsChanged();
  peer.currentProgram=peer.shadow.currentProgram=primary;peer.currentProgramId=20;peer.shadow.textureUnits[0]=textures[0];peer.shadow.textureUnits[1]=textures[1];const peerExecution=registry.retainContextExecution(1,12,muxer)!;const peerProof=PreparedOwnedDraw.prepare(peerExecution,peer);if(!peerProof)throw new Error("Healthy peer proof unavailable");
  const layout=uniformLayout(b,primary)!,imageLocation=layout.entries.find((entry:any)=>entry.name==="image")!.location;
  const setter=new Uint8Array(12),setterView=new DataView(setter.buffer);setterView.setUint16(0,OP_UNIFORM1I,true);setterView.setUint16(2,8,true);setterView.setInt32(4,imageLocation,true);setterView.setInt32(8,1,true);b.cmdbufView=setter;
  const uniform1i=gl.uniform1i.bind(gl);let rejected=0;gl.uniform1i=()=>{rejected++;pendingControlledNativeError=0x505;};
  let reset:number;try{reset=nativeBatch.withNativeBatch(b,"controlled rejected shared uniform",()=>decodeAndDispatch(b,0,setter.byteLength));}finally{gl.uniform1i=uniform1i;}
  const pixelAfterReset=new Uint8Array(4);if(nativeBatch.withNativeBatch(peer,"healthy peer after rejected uniform",()=>peerProof.issue(draw)?0:-5))throw new Error("Healthy peer reset");gl.readPixels(8,8,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixelAfterReset);
  const controlledRecovery={reset,rejected,expectedReset:RENDERER_LOST,pixel:[...pixelAfterReset],nativeImage:getUniform(primary,getUniformLocation(primary,"image")!)};if(!peerProof.retire())throw new Error("Peer proof retirement refused");peerExecution.release();
  const logicalErrors=[...b.errors,...peer.errors],nativeClean=gl.getError()===0;b.programJournal!.retire();const retired=!proof.matches();b.currentProgram=b.shadow.currentProgram=null;b.currentProgramId=0;gl.useProgram(null);execution.release();registry.unbind(1);gl.deleteProgram(primary);gl.deleteShader(vs);gl.deleteShader(fs);gl.deleteTexture(textures[0]);gl.deleteTexture(textures[1]);gl.deleteBuffer(buffer);gl.deleteVertexArray(vao);resetGlAuditForTesting();return {samples,checks,cold,warm,logicalErrors,nativeClean,retired,auditRows,failures,controlledRecovery,staleCases,malformedResult,malformedWrites,inlineCold,inlineWarm};
 },{source,audit});
 writeFileSync(test.info().outputPath("prepared-owned-result.json"),JSON.stringify({engine:test.info().project.name,version:browser.version(),audit,...result},null,2));
 expect(result.staleCases).toEqual([0,0,0x502,0,0,0x502,0,0,0x502,0,0,0x502]);expect(result.malformedResult).toBe(-22);expect(result.malformedWrites).toBe(0);
 expect(result.controlledRecovery.reset).toBe(result.controlledRecovery.expectedReset);expect(result.controlledRecovery.rejected).toBe(1);expect(result.controlledRecovery.nativeImage).toBe(0);expect(result.controlledRecovery.pixel).toEqual([51,153,204,255]);
 expect(result.samples).toEqual([[51,153,204,255],[204,51,102,255],[204,51,102,255],[204,51,102,255],[204,51,102,255],[204,51,102,255]]);expect(result.checks).toEqual([1,1,1,1,1,1]);expect(result.inlineWarm).toEqual(result.inlineCold);expect(result.cold).toEqual(result.warm);expect(result.cold.programCreates).toBe(16);expect(result.failures).toEqual([]);expect(result.logicalErrors).toEqual([]);expect(result.nativeClean&&result.retired).toBe(true);expect(result.auditRows.filter((r:any)=>r.kind==="divergence")).toEqual([]);expect(errors).toEqual([]);expect(await memoryBoundaryFailures(page)).toEqual([]);
});
