import {GlImageGenerationPin} from "../src/webgl/image-generations.js";
import {expect,it,vi} from "vitest";
import {registerFramebufferColorStorage,storageWrites} from "../src/webgl/image-writes.js";
import {PreparedOwnedDraw} from "../src/webgl/prepared-owned-draw.js";
import {PreparedUniformValues} from "../src/webgl/prepared-uniform-values.js";
import {GlContextRegistry} from "../src/webgl/registry.js";
import {GlMuxer} from "../src/webgl/muxer.js";
import {recordLinkedSources} from "../src/webgl/reversed-depth.js";
import {recordTextureLevel,textureLevel} from "../src/webgl/texture-levels.js";
import {setTextureFilters} from "../src/webgl/lod-switchover.js";
import {framebufferInputsChanged} from "../src/webgl/framebuffer-revision.js";
import {refreshImageGenerationMetadata,retireImageGeneration} from "../src/webgl/image-generations.js";
import {uniformLayout} from "../src/webgl/uniform-layout.js";
import {withNativeBatch} from "../src/webgl/native-batch.js";
import {rendererLost,RENDERER_LOST} from "../src/webgl/renderer-loss.js";
import * as O from "../src/webgl/ops.js";

type Program={id:number;values:Map<string,Float32Array|Int32Array>};
const uniforms=[{name:"image",type:0x8b5e,size:1},{name:"palette",type:0x8b5e,size:1},
 {name:"tint",type:0x8b52,size:1},{name:"transform",type:0x8b5c,size:1}];
function fixture(){
 let next=0,current:Program|null=null,unit=0,error=0,warm=false,drawn:Program|null=null;
 const programs=new Set<Program>(),bound=new Array<WebGLTexture|null>(32).fill(null),binds:number[]=[],drawInputs:WebGLTexture[]=[];
 let reflections=0,builds=0;
 const make=():Program=>{if(warm)throw new Error("late shader construction");builds++;const values=new Map<string,Float32Array|Int32Array>();
  values.set("image",new Int32Array([0]));values.set("palette",new Int32Array([1]));values.set("tint",new Float32Array([1,1,1,1]));
  values.set("transform",new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]));
  const p={id:++next,values};programs.add(p);return p;};
 const vector=(location:{program:Program;name:string},data:ArrayLike<number>,offset=0,length=data.length)=>{
  if(current!==location.program)throw new Error("upload before private executable selection");
  const values=location.program.values.get(location.name)!;for(let i=0;i<length;i++)values[i]=data[offset+i];
 };
 const raw={getError:()=>{const e=error;error=0;return e;},isContextLost:()=>false,createProgram:make,
  deleteProgram:(p:Program)=>{programs.delete(p);},useProgram:(p:Program|null)=>{current=p;},
  createShader:(type:number)=>{if(warm)throw new Error("late shader");return {type};},
  getProgramParameter:(_p:Program,pname:number)=>pname===0x8b82?true:pname===0x8b86?uniforms.length:0,
  getActiveUniform:(_p:Program,i:number)=>{if(warm)throw new Error("late reflection");reflections++;return uniforms[i];},
  getUniformLocation:(program:Program,name:string)=>{if(warm)throw new Error("late location");return {program,name};},
  getUniform:(program:Program,l:{name:string})=>{if(warm)throw new Error("late uniform reflection");reflections++;return program.values.get(l.name);},
  getParameter:(pname:number)=>pname===0x8b8d?current:pname===0x84e0?0x84c0+unit:pname===0x8069?bound[unit]:pname===0x8b4d?16:null,
  activeTexture:(value:number)=>{unit=value-0x84c0;},bindTexture:(_target:number,texture:WebGLTexture|null)=>{bound[unit]=texture;binds.push(unit);},
  uniform1iv:vector,uniform2iv:vector,uniform3iv:vector,uniform4iv:vector,uniform1fv:vector,uniform2fv:vector,uniform3fv:vector,uniform4fv:vector,
  uniformMatrix2fv:(l:any,_t:boolean,d:Float32Array,o:number,n:number)=>vector(l,d,o,n),
  uniformMatrix3fv:(l:any,_t:boolean,d:Float32Array,o:number,n:number)=>vector(l,d,o,n),
  uniformMatrix4fv:(l:any,_t:boolean,d:Float32Array,o:number,n:number)=>vector(l,d,o,n),
  drawArrays:()=>{drawn=current;drawInputs[0]=bound[0]!;drawInputs[1]=bound[1]!;},
 };
 const noop=()=>null,gl=new Proxy(raw,{get:(target,key)=>Reflect.get(target,key)??noop}) as unknown as WebGL2RenderingContext;
 const registry=new GlContextRegistry(),muxer=new GlMuxer(gl);registry.bind({pid:1,sessionId:0,cmdbufAddr:0,cmdbufLen:65536});
 const b=registry.get(1,0)!;b.gl=gl;b.contextId=1;const primary=make();current=primary;
 b.programs.set(20,primary as unknown as WebGLProgram);b.programShaders.set(20,new Set());b.currentProgram=b.shadow.currentProgram=primary as unknown as WebGLProgram;b.currentProgramId=20;
 recordLinkedSources(b.currentProgram,"attribute vec2 p;uniform mat4 transform;varying vec2 uv;void main(){gl_Position=transform*vec4(p,0.,1.);uv=p*.5+.5;}",
  "precision mediump float;uniform sampler2D image,palette;uniform vec4 tint;varying vec2 uv;void main(){gl_FragColor=(texture2D(image,uv)+texture2D(palette,uv)*.01)*tint;}",false);
 const inputs=[{} as WebGLTexture,{} as WebGLTexture,{} as WebGLTexture];
 const spec=(object:WebGLTexture,depth=false)=>recordTextureLevel(object,0xde1,0,{width:320,height:200,internalFormat:depth?0x81a5:0x1906,format:depth?0x1902:0x1906,type:depth?0x1403:0x1401,compressed:false,
  gles:{internalFormat:depth?0x1902:0x1906,format:depth?0x1902:0x1906,type:depth?0x1403:0x1401,expanded:false,colorRenderable:false,depth,stencil:false}});
 for(let i=0;i<3;i++){b.textures.set(7+i,inputs[i]);b.shadow.textureUnits[i===2?10:i]=inputs[i];bound[i===2?10:i]=inputs[i];spec(inputs[i]);setTextureFilters(inputs[i],0x2601,0x2601);}
 const execution=registry.retainContextExecution(1,0,muxer)!;
 const draw={mode:4,maxVertex:2,issue:()=>gl.drawArrays(4,0,3),vertices:()=>{throw new Error("late vertices");}};
 return {b,gl,raw,registry,muxer,execution,primary,inputs,spec,draw,programs,binds,drawInputs,
  warm:(value:boolean)=>{warm=value;},error:(value:number)=>{error=value;},drawn:()=>drawn,stats:()=>({reflections,builds}),
  dispose(){b.currentProgram=b.shadow.currentProgram=null;current=null;b.currentProgramId=0;execution.release();registry.unbind(1);}};
}
it("cold-prepares all16 two-sampler variants, selecting current traits without new CPU/native control construction",()=>{
 const f=fixture(),proof=PreparedOwnedDraw.prepare(f.execution,f.b)!;expect(proof).not.toBeNull();
 const cold=f.stats(),programs=new Set<Program>();
 for(let mask=0;mask<16;mask++){
  for(let i=0;i<2;i++){f.spec(f.inputs[i],!!(mask&(1<<(i*2))));setTextureFilters(f.inputs[i],mask&(2<<(i*2))?0x2702:0x2601,0x2601);}
  framebufferInputsChanged();f.binds.length=0;f.warm(true);
  const originalFloat=globalThis.Float32Array,originalInt=globalThis.Int32Array;
  const map=vi.spyOn(Array.prototype,"map").mockImplementation(()=>{throw new Error("late map");});
  const flat=vi.spyOn(Array.prototype,"flatMap").mockImplementation(()=>{throw new Error("late flatMap");});
  try{
   vi.stubGlobal("Float32Array",new Proxy(originalFloat,{construct(){throw new Error("late float CPU receiver");}}));
   vi.stubGlobal("Int32Array",new Proxy(originalInt,{construct(){throw new Error("late integer CPU receiver");}}));
   expect(withNativeBatch(f.b,"prepared sampling",()=>proof.issue(f.draw)?0:-5)).toBe(0);
  }finally{map.mockRestore();flat.mockRestore();vi.stubGlobal("Float32Array",originalFloat);vi.stubGlobal("Int32Array",originalInt);f.warm(false);}
  programs.add(f.drawn()!);expect(f.binds.every(unit=>unit===0||unit===1)).toBe(true);expect(f.binds).toHaveLength(4);
 }
 expect(programs.size).toBe(16);expect(f.stats()).toEqual(cold);expect(f.b.errors).toEqual([]);
 const layout=uniformLayout(f.b,f.b.currentProgram!)!;expect(layout.ownedValues).not.toBeNull();expect(proof.retire()).toBe(true);expect(layout.ownedValues).toBeNull();f.dispose();
});
it("keeps canonical public identity separate when cold-preparing from an older retained input descriptor",()=>{
 const f=fixture(),first=PreparedOwnedDraw.prepare(f.execution,f.b)!;expect(first).not.toBeNull();
 const oldView=first.executionView,oldNative=f.inputs[0],descriptor=oldView.textureViews;
 refreshImageGenerationMetadata(oldNative,f.inputs[0]);
 const replacement={} as WebGLTexture;f.b.textureViews.set(f.inputs[0],{native:replacement,source:null,read:null});
 f.spec(f.inputs[0],true);setTextureFilters(f.inputs[0],0x2702,0x2601);
 expect(withNativeBatch(f.b,"old generation",()=>first.issue(f.draw)?0:-5)).toBe(0);
 const sampled=oldView.shadow.textureUnits[0]!;expect(sampled).not.toBe(f.inputs[0]);
 const before=textureLevel(sampled,0xde1,0);refreshImageGenerationMetadata(oldNative,sampled);expect(textureLevel(sampled,0xde1,0)).toBe(before);
 const second=PreparedOwnedDraw.prepare(f.execution,oldView)!;expect(second).not.toBeNull();
 expect(withNativeBatch(f.b,"cold proof from old descriptor",()=>second.issue(f.draw)?0:-5)).toBe(0);
 expect(f.drawInputs[0]).toBe(oldNative);expect(f.drawn()).toBe(f.primary);expect(descriptor).toBe(oldView.textureViews);
 // New source-side preparation resolves current public storage; only the
 // already-accepted old proof may keep its retained sampled generation.
 const fresh=PreparedOwnedDraw.prepare(f.execution,f.b,undefined,true)!;expect(fresh).not.toBeNull();
 expect(withNativeBatch(f.b,"fresh proof after peer replacement",()=>fresh.issue(f.draw)?0:-5)).toBe(0);
 expect(f.drawInputs[0]).toBe(replacement);expect(f.drawn()).not.toBe(f.primary);
 expect(withNativeBatch(f.b,"old accepted proof remains owned",()=>first.issue(f.draw)?0:-5)).toBe(0);
 expect(f.drawInputs[0]).toBe(oldNative);expect(f.drawn()).toBe(f.primary);
 expect(fresh.retire()).toBe(true);
 expect(retireImageGeneration(oldNative)).toBe(true);expect(second.retire()).toBe(true);expect(first.retire()).toBe(true);f.dispose();
});

it("reserves target write metadata cold without publishing a phantom draw",()=>{
 const f=fixture(),framebuffer={} as WebGLFramebuffer,storage={};
 registerFramebufferColorStorage(framebuffer,storage);f.b.shadow.fbo=framebuffer;
 const writes=storageWrites(storage),before=writes.count,proof=PreparedOwnedDraw.prepare(f.execution,f.b)!;
 expect(proof).not.toBeNull();expect(writes.count).toBe(before);
 framebufferInputsChanged();const set=vi.spyOn(WeakMap.prototype,"set").mockImplementation(()=>{throw new Error("late target metadata");});
 try{expect(withNativeBatch(f.b,"unrelated framebuffer revision",()=>proof.issue(f.draw)?0:-5)).toBe(0);}finally{set.mockRestore();}
 expect(writes.count).toBe(before+1);expect(proof.retire()).toBe(true);f.dispose();
});
it("revokes exact readiness before native mutation when executable or input identity changes",()=>{
 const f=fixture(),proof=PreparedOwnedDraw.prepare(f.execution,f.b)!;expect(proof.matches()).toBe(true);
 const original=f.b.shadow.textureUnits[0];f.b.shadow.textureUnits[0]={} as WebGLTexture;expect(proof.matches()).toBe(false);
 f.b.shadow.textureUnits[0]=original;expect(proof.matches()).toBe(true);f.b.currentProgram={} as WebGLProgram;expect(proof.matches()).toBe(false);
 f.b.currentProgram=f.primary as unknown as WebGLProgram;expect(proof.retire()).toBe(true);expect(proof.matches()).toBe(false);f.dispose();
});

it("borrows exact unaligned shared payloads and drops old memory authority at the end of each walk",async()=>{
 const {GlWirePayload}=await import("../src/webgl/wire-payload.js");
 const memory=new WebAssembly.Memory({initial:1,maximum:3,shared:true}),old=memory.buffer;
 const bytes=new Uint8Array(old,3,100),native=new DataView(old,8,72),reader=new GlWirePayload();
 const values:[string,number|bigint,number][]=[["Int8",-7,1],["Uint8",250,1],["Int16",-1234,2],["Uint16",65000,2],
  ["Int32",-123456,4],["Uint32",0xfedcba98,4],["Float32",-1.25,4],["Float64",Math.PI,8],["BigInt64",-1234567890123n,8],["BigUint64",0xfedcba9876543210n,8]];
 for(const [name,value,size] of values)for(const little of [false,true]){
  reader.begin();reader.reset(bytes,5,72);
  const set=`set${name}` as keyof DataView,get=`get${name}` as keyof DataView;
  Reflect.apply(native[set] as Function,native,[1,value,little]);
  expect(Reflect.apply(reader[get] as Function,reader,[1,little])).toBe(Reflect.apply(native[get] as Function,native,[1,little]));
  Reflect.apply(reader[set] as Function,reader,[11,value,little]);
  expect(Reflect.apply(native[get] as Function,native,[11,little])).toBe(Reflect.apply(native[get] as Function,native,[1,little]));
  expect(()=>Reflect.apply(reader[get] as Function,reader,[73-size,little])).toThrow(RangeError);reader.end();expect(reader.buffer).not.toBe(old);expect(reader.byteLength).toBe(0);
 }
 memory.grow(2);const grown=memory.buffer;expect(grown).not.toBe(old);
 const maximum=new Uint8Array(grown,7,131078);maximum[65537]=0xef;maximum[65538]=0xcd;maximum[65539]=0xab;maximum[65540]=0x89;
 reader.begin();try{reader.reset(maximum,65536,65535);expect(reader.getUint32(1,true)).toBe(0x89abcdef);expect(reader.byteOffset).toBe(65543);expect(reader.buffer).toBe(grown);}finally{reader.end();}
 expect(reader.buffer).not.toBe(grown);expect(()=>reader.getUint8(0)).toThrow(RangeError);
});

it.each([false,true])("selects the retained target's component kind cold and restores the current public framebuffer (float %s)",async floating=>{
 const {ownedDrawColorBufferKind}=await import("../src/webgl/blend-constant.js");
 const f=fixture(),retained={} as WebGLFramebuffer,publicTarget={} as WebGLFramebuffer;let selected:WebGLFramebuffer|null=publicTarget;
 const ordinary=f.raw.getParameter;
 Object.assign(f.raw,{getParameter:(pname:number)=>pname===0x8ca6?selected:ordinary(pname),
  bindFramebuffer:(_target:number,next:WebGLFramebuffer|null)=>{selected=next;},
  getFramebufferAttachmentParameter:(_target:number,_attachment:number,pname:number)=>pname===0x8cd0?0x1702:(selected===retained?floating:!floating)?0x1406:0x8c17});
 f.b.shadow.fbo=retained;expect(ownedDrawColorBufferKind(f.b)).toBe(floating?"float":"fixed");expect(selected).toBe(publicTarget);f.b.shadow.fbo=null;f.dispose();
});

for(const stage of ["receiver","mapping"] as const)it(`retires exact native input custody when cold ${stage} reservation refuses, then permits retry`,()=>{
 const f=fixture(),native=f.inputs[0],acquire=GlImageGenerationPin.acquire,push=Array.prototype.push,set=Map.prototype.set;
 let first:GlImageGenerationPin|null=null,refused=0,deleted=0;
 const capture=vi.spyOn(GlImageGenerationPin,"acquire").mockImplementation((...args)=>{const pin=Reflect.apply(acquire,GlImageGenerationPin,args);if(args[1]===native&&!first)first=pin;return pin;});
 Object.assign(f.raw,{deleteTexture:(texture:WebGLTexture)=>{if(texture===native)deleted++;}});
 let insertion:{mockRestore():unknown};
 if(stage==="receiver"){
  // Spy bookkeeping itself uses push. Replace it directly so only the
  // intended receiver allocation fails, not the test runner's call ledger.
  Array.prototype.push=function(this:unknown[],...values:unknown[]){
   const row=values[0];if(!refused&&row&&typeof row==="object"&&"publicObject"in row&&"pin"in row){refused++;throw new Error("cold input receiver refused");}return Reflect.apply(push,this,values);
  };insertion={mockRestore(){Array.prototype.push=push;}};
 }else insertion=vi.spyOn(Map.prototype,"set").mockImplementation(function(this:Map<unknown,unknown>,key:unknown,value:unknown){
  if(!refused&&value&&typeof value==="object"&&"native"in value&&(value as {native:unknown}).native===native){refused++;throw new Error("cold sampled map refused");}return Reflect.apply(set,this,[key,value]);
 });
 try{
  expect(PreparedOwnedDraw.prepare(f.execution,f.b)).toBeNull();
 }finally{insertion.mockRestore();capture.mockRestore();}
 const stranded=first as GlImageGenerationPin|null;
 try{
  expect(refused).toBe(1);expect(stranded?.active??false).toBe(false);expect(f.b.errors).toEqual([]);
  const retry=PreparedOwnedDraw.prepare(f.execution,f.b)!;expect(retry).not.toBeNull();expect(withNativeBatch(f.b,"retry cold input",()=>retry.issue(f.draw)?0:-5)).toBe(0);expect(retry.retire()).toBe(true);
  expect(retireImageGeneration(native)).toBe(true);expect(deleted).toBe(1);
 }finally{if(stranded?.active)stranded.release();retireImageGeneration(native);f.dispose();}
});
it.each([false,true])("retires and retries a compiled native variant after cache publication refuses (inserted %s)",inserted=>{
 const f=fixture(),set=Map.prototype.set,remove=f.raw.deleteProgram,counts=new Map<Program,number>();let refused=0,compiled:Program|null=null;
 f.raw.deleteProgram=(program:Program)=>{counts.set(program,(counts.get(program)??0)+1);remove(program);};
 const publication=vi.spyOn(Map.prototype,"set").mockImplementation(function(this:Map<unknown,unknown>,key:unknown,value:unknown){
  if(!refused&&value&&typeof value==="object"&&"program"in value&&"sources"in value&&"renamed"in value){refused++;compiled=(value as {program:Program}).program;if(inserted)Reflect.apply(set,this,[key,value]);throw new Error("cold native variant cache refused");}
  return Reflect.apply(set,this,[key,value]);
 });
 try{expect(PreparedOwnedDraw.prepare(f.execution,f.b)).toBeNull();}finally{publication.mockRestore();}
 try{
  expect(refused).toBe(1);expect(compiled).not.toBeNull();expect(f.programs.has(compiled!)).toBe(false);expect(counts.get(compiled!)).toBe(1);
  const retry=PreparedOwnedDraw.prepare(f.execution,f.b)!;expect(retry).not.toBeNull();expect(withNativeBatch(f.b,"retry cache publication",()=>retry.issue(f.draw)?0:-5)).toBe(0);expect(retry.retire()).toBe(true);
 }finally{if(compiled&&f.programs.has(compiled))f.gl.deleteProgram(compiled as unknown as WebGLProgram);f.dispose();}
 expect([...counts.values()].every(n=>n===1)).toBe(true);
});

it("retires programs and shaders once after normal cache ownership and a nested private frame",async()=>{
 const {applyNativeChanges,nativeInverse}=await import("../src/webgl/native-recovery.js");
 const {useProgramIfAccepted,finalizeProgram}=await import("../src/webgl/program-objects.js");
 const f=fixture(),remove=f.raw.deleteProgram,createShader=f.raw.createShader,counts=new Map<Program,number>(),shaders=new Map<object,number>();let proof:PreparedOwnedDraw|null=null;
 f.raw.createShader=(type:number)=>{const shader=createShader(type);shaders.set(shader,0);return shader;};
 Object.assign(f.raw,{deleteShader:(shader:object)=>{shaders.set(shader,(shaders.get(shader)??0)+1);}});
 f.raw.deleteProgram=(program:Program)=>{counts.set(program,(counts.get(program)??0)+1);remove(program);};
 expect(applyNativeChanges(f.b,[{apply:()=>{proof=PreparedOwnedDraw.prepare(f.execution,f.b);return proof!==null;},restore:nativeInverse(f.b)}])).toBe(true);
 const ready=proof as PreparedOwnedDraw|null;expect(ready).not.toBeNull();expect(f.programs.size).toBe(16);
 expect(withNativeBatch(f.b,"nested cold native ownership",()=>ready!.issue(f.draw)?0:-5)).toBe(0);expect(ready!.retire()).toBe(true);
 expect(shaders.size).toBe(30);expect([...shaders.values()].every(n=>n===1)).toBe(true);
 f.b.programDeletePending.add(20);expect(useProgramIfAccepted(f.b,0)).toBe(true);finalizeProgram(f.b,20);
 expect(f.programs.size).toBe(0);expect(counts.size).toBe(16);expect([...counts.values()].every(n=>n===1)).toBe(true);f.dispose();expect([...counts.values()].every(n=>n===1)).toBe(true);
});
it("keeps a refused private program cleanup loud and owned until the exact receipt can finish",async()=>{
 const {NativeGlFault,repairNativeState}=await import("../src/webgl/native-recovery.js");
 const f=fixture(),set=Map.prototype.set,remove=f.raw.deleteProgram;let refused=0,blocked=0,compiled:Program|null=null;
 const publication=vi.spyOn(Map.prototype,"set").mockImplementation(function(this:Map<unknown,unknown>,key:unknown,value:unknown){
  if(!refused&&value&&typeof value==="object"&&"program"in value&&"sources"in value&&"renamed"in value){refused++;compiled=(value as {program:Program}).program;throw new Error("cold native cache refused");}
  return Reflect.apply(set,this,[key,value]);
 });
 f.raw.deleteProgram=(program:Program)=>{if(program===compiled&&!blocked++){f.error(0x502);return;}remove(program);};
 try{expect(()=>PreparedOwnedDraw.prepare(f.execution,f.b)).toThrow(NativeGlFault);}finally{publication.mockRestore();f.raw.deleteProgram=remove;}
 expect(compiled).not.toBeNull();expect(f.programs.has(compiled!)).toBe(true);expect(repairNativeState(f.gl)).toBe(true);expect(f.programs.has(compiled!)).toBe(false);
 const retry=PreparedOwnedDraw.prepare(f.execution,f.b)!;expect(retry).not.toBeNull();expect(retry.retire()).toBe(true);f.dispose();
});
