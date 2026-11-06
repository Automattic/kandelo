import {test,expect} from "@playwright/test";
import {fileURLToPath} from "node:url";
import {writeFileSync} from "node:fs";
import {installBrowserMemoryBoundaryProbe,memoryBoundaryFailures} from "./support/browser-memory-boundary";
test.use({serviceWorkers:"block"});
for(const audit of [false,true])test(`retained offscreen target/input generations execute with exact publication (${audit?"fatal":"production"})`,async({page,baseURL,browser})=>{
 const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));await installBrowserMemoryBoundaryProbe(page);await page.goto(new URL("/trap-signal-test.html",baseURL).href);
 const source=fileURLToPath(new URL("../../../host/src/webgl/",import.meta.url));
 const result=await page.evaluate(async({source,audit})=>{
  const load=(name:string)=>import(/* @vite-ignore */ `/@fs${source}${name}.ts`);
  const [{GlContextRegistry},{GlMuxer},{runGlQuery},{decodeAndDispatch},{bindBufferObject},{imageTextureOperation,textureNative,registerImageSource,importImageStorage},{recordTextureLevel},{setTextureFilters},{storageWrites},nativeBatch,{configureGlAudit,resetGlAuditForTesting},{nativeGlFault}]=await Promise.all([
   load("registry"),load("muxer"),load("query"),load("bridge"),load("buffer-storage"),load("image-storage"),load("texture-levels"),load("lod-switchover"),load("image-writes"),load("native-batch"),load("native-audit"),load("native-recovery")]);
  const rows:any[]=[];if(audit)configureGlAudit({mode:"fatal",sink:(value:any)=>rows.push(value),fault:(message:string)=>nativeGlFault(message)});
  const canvas=document.createElement("canvas");canvas.width=canvas.height=16;const gl=canvas.getContext("webgl2",{preserveDrawingBuffer:true})!;if(!gl)throw new Error("WebGL2 unavailable");
  const live=new Map<string,Set<object>>(),created:any={},deleted:any={};
  for(const kind of ["Texture","Framebuffer","Buffer"]){const make=(gl as any)[`create${kind}`].bind(gl),remove=(gl as any)[`delete${kind}`].bind(gl),set=new Set<object>();live.set(kind,set);created[kind]=deleted[kind]=0;(gl as any)[`create${kind}`]=()=>{const value=make();if(value){set.add(value);created[kind]++;}return value;};(gl as any)[`delete${kind}`]=(value:object)=>{remove(value);if(value&&set.delete(value))deleted[kind]++;};}
  let errorReads=0,draws=0;const nativeError=gl.getError.bind(gl),nativeDraw=gl.drawArrays.bind(gl);gl.getError=()=>{errorReads++;return nativeError();};gl.drawArrays=(...args)=>{draws++;nativeDraw(...args);};
  const registry=new GlContextRegistry(),muxer=new GlMuxer(gl);const make=(session:number)=>{registry.bind({pid:1,sessionId:session,cmdbufAddr:0,cmdbufLen:256});const binding=registry.get(1,session)!;binding.gl=gl;binding.contextId=session+1;return binding;};
  const b=make(0),execution=registry.retainContextExecution(1,0,muxer)!;
  const query=(words:number[])=>{const out=new Uint8Array(48);if(runGlQuery(b,0x3b,new Uint8Array(new Uint32Array(words).buffer),out,execution)!==48)throw new Error("query refused");return [...new Uint32Array(out.buffer)];};
  const emit=(op:number,words:number[],tail=new Uint8Array())=>{const cmd=new Uint8Array(4+words.length*4+tail.length),v=new DataView(cmd.buffer);v.setUint16(0,op,true);v.setUint16(2,cmd.length-4,true);words.forEach((word,index)=>v.setUint32(4+index*4,word,true));cmd.set(tail,4+words.length*4);b.cmdbufView=cmd;if(decodeAndDispatch(b,0,cmd.length))throw new Error("command refused");};
  const id=query([1,1,8])[3];if(query([10,2,id,2])[4]!==2)throw new Error("buffer bank refused");
  bindBufferObject(b,0x8892,7);const original=b.buffers.get(7)!;const vertex=new Uint8Array(new Float32Array([-1,-1,1,-1,0,1]).buffer);
  b.vertexArrays.get(0)!.attributes.set(0,{enabled:true,buffer:original,size:2,type:gl.FLOAT,normalized:false,stride:0,offset:0});
  if(nativeBatch.withNativeBatch(b,"offscreen-buffer",()=>emit(0x107,[id,0,1,0x8892,vertex.length,gl.STATIC_DRAW],vertex)))throw new Error("buffer reset");
  const spec=(format:number,width=4)=>({width,height:width,internalFormat:format===gl.ALPHA?gl.ALPHA:gl.RGBA8,format,type:gl.UNSIGNED_BYTE,compressed:false,gles:{internalFormat:format,format,type:gl.UNSIGNED_BYTE,expanded:false,colorRenderable:format===gl.RGBA,depth:false,stencil:false}});
  const texture=(name:number,format:number,width=4)=>{const object=gl.createTexture()!;gl.bindTexture(gl.TEXTURE_2D,object);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);gl.texImage2D(gl.TEXTURE_2D,0,format===gl.ALPHA?gl.ALPHA:gl.RGBA8,width,width,0,format,gl.UNSIGNED_BYTE,new Uint8Array(width*width*(format===gl.ALPHA?1:4)).fill(255));b.textures.set(name,object);setTextureFilters(object,gl.NEAREST,gl.NEAREST);recordTextureLevel(object,gl.TEXTURE_2D,0,spec(format,width));return object;};
  const target=texture(1,gl.RGBA,16),alpha=texture(2,gl.ALPHA),palette=texture(3,gl.RGBA),fbo=gl.createFramebuffer()!;
  b.fbos.set(5,fbo);b.framebufferAttachments.set(fbo,new Map([[gl.COLOR_ATTACHMENT0,{kind:"texture",object:target,target:gl.TEXTURE_2D,level:0}]]));b.shadow.fbo=fbo;gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,target,0);
  b.shadow.textureUnits[0]=alpha;b.shadow.textureUnits[1]=palette;gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,alpha);gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,palette);b.shadow.activeTexture=1;
  if(query([12,3,id,0,1,5])[4]!==1)throw new Error("target capture refused");
  const peer=make(12);if(!registry.shareObjects(1,12,0))throw new Error("sharing refused");peer.shadow.textureUnits[0]=target;gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,target);
  if(!imageTextureOperation(peer,gl.TEXTURE_2D,true,()=>gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,2,2,0,gl.RGBA,gl.UNSIGNED_BYTE,null),false,0))throw new Error("target replacement refused");recordTextureLevel(target,gl.TEXTURE_2D,0,spec(gl.RGBA,2));const replacement=textureNative(peer,target);
  // Sampling-only custody must permit ordinary ALPHA respecification in place.
  peer.shadow.textureUnits[0]=alpha;gl.bindTexture(gl.TEXTURE_2D,alpha);if(!imageTextureOperation(peer,gl.TEXTURE_2D,true,()=>gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,4,4,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array(64).fill(255)),false,0))throw new Error("input replacement refused");recordTextureLevel(alpha,gl.TEXTURE_2D,0,spec(gl.RGBA));
  const imageTexture=gl.createTexture()!;gl.bindTexture(gl.TEXTURE_2D,imageTexture);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,4,4,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array(64));const token=registerImageSource(peer,99,imageTexture,4,4);if(token<0||!importImageStorage(peer,1,2,token))throw new Error("legitimate input import refused");
  const shader=(type:number,text:string)=>{const value=gl.createShader(type)!;gl.shaderSource(value,text);gl.compileShader(value);if(!gl.getShaderParameter(value,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(value)??"compile");return value;};
  const vs=shader(gl.VERTEX_SHADER,"#version 300 es\nin vec2 p;out vec2 uv;void main(){gl_Position=vec4(p,0.,1.);uv=vec2(.5);}"),fs=shader(gl.FRAGMENT_SHADER,"#version 300 es\nprecision mediump float;uniform sampler2D a;uniform sampler2D pal;uniform vec4 tint;in vec2 uv;out vec4 c;void main(){c=tint*texture(a,uv).aaaa*texture(pal,uv);}"),program=gl.createProgram()!;gl.attachShader(program,vs);gl.attachShader(program,fs);gl.bindAttribLocation(program,0,"p");gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program)??"link");gl.useProgram(program);gl.uniform1i(gl.getUniformLocation(program,"a"),0);gl.uniform1i(gl.getUniformLocation(program,"pal"),1);b.currentProgram=program;
  const vao=gl.createVertexArray();gl.bindVertexArray(vao);gl.bindBuffer(gl.ARRAY_BUFFER,original);gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);gl.enableVertexAttribArray(0);gl.bindBuffer(gl.ARRAY_BUFFER,b.shadow.arrayBuffer);gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);gl.viewport(0,0,16,16);
  gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,textureNative(b,alpha));gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,palette);gl.clearColor(0,0,0,1);gl.clear(gl.COLOR_BUFFER_BIT);
  const oldWrites=storageWrites(target),newWrites=storageWrites(replacement),beforeOld=oldWrites.count,beforeNew=newWrites.count;
  const pixels:number[][]=[];const checks:number[]=[],clearChecks:number[]=[];
  for(let i=0;i<2;i++){
    gl.clearColor(0,0,0,1);let clearBefore=errorReads;if(nativeBatch.withNativeBatch(b,"offscreen-owned-clear",()=>emit(0x509,[id,0,1,gl.COLOR_BUFFER_BIT])))throw new Error("clear reset");clearChecks.push(errorReads-clearBefore);
    gl.uniform4f(gl.getUniformLocation(program,"tint"),i?.8:.2,i?.2:.6,i?.6:.8,1);
    const before=errorReads;if(nativeBatch.withNativeBatch(b,"offscreen-owned-draw",()=>emit(0x508,[id,4,0,3,1,0,1,0,0,1,2,gl.FLOAT,0,0,0])))throw new Error("draw reset");checks.push(errorReads-before);
    const capture=(b.programJournal as any).framebufferDrawChanges(0,1);gl.bindFramebuffer(gl.READ_FRAMEBUFFER,capture.view.shadow.fbo);const pixel=new Uint8Array(4);gl.readPixels(8,8,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);pixels.push([...pixel]);gl.bindFramebuffer(gl.READ_FRAMEBUFFER,b.shadow.readFbo);
  }
  const counters={old:oldWrites.count-beforeOld,replacement:newWrites.count-beforeNew};
  b.currentProgram=null;gl.useProgram(null);gl.deleteProgram(program);gl.deleteShader(vs);gl.deleteShader(fs);gl.bindVertexArray(null);gl.deleteVertexArray(vao);b.vertexArrays.get(0)!.attributes.clear();
  b.programJournal!.retire();execution.release();registry.unbind(1);gl.deleteTexture(imageTexture);const clean=gl.getError()===0;resetGlAuditForTesting();
  return {pixels,checks,clearChecks,draws,counters,errors:[...b.errors,...peer.errors],created,deleted,live:[...live].map(([kind,values])=>[kind,values.size]),clean,auditRows:rows};
 },{source,audit});
 writeFileSync(test.info().outputPath("offscreen-result.json"),JSON.stringify({engine:test.info().project.name,version:browser.version(),audit,...result},null,2));
 expect(result.pixels).toEqual([[51,153,204,255],[204,51,153,255]]);expect(result.draws).toBe(2);expect(result.checks).toEqual([1,1]);expect(result.clearChecks).toEqual([1,1]);expect(result.counters).toEqual({old:4,replacement:0});expect(result.errors).toEqual([]);expect(result.clean).toBe(true);expect(result.created).toEqual(result.deleted);expect(result.live.every((row:any)=>row[1]===0)).toBe(true);expect(result.auditRows.filter((row:any)=>row.kind==="divergence")).toEqual([]);expect(errors).toEqual([]);expect(await memoryBoundaryFailures(page)).toEqual([]);
});
