import {isDefaultFramebuffer} from "./framebuffer.js";
/** Cold complete CPU authority for bounded, locally accepted owned draws. */
import type {GlBinding,GlContextExecutionLease} from "./registry.js";
import {GlProgramQueryPin,checkedGlSequence} from "./program-objects.js";
import {prepareSamplerWrites} from "./depth-sampling.js";
import {uniformLayout} from "./uniform-layout.js";
import {PreparedUniformValues} from "./prepared-uniform-values.js";
import {ownedVertexDepthRange,prepareOwnedVariantPrograms,depthRangeReversed,prepareUniformWrites,type OwnedVariantProgram} from "./reversed-depth.js";
import {blendFoldNeeded,ownedDrawColorBufferKind} from "./blend-constant.js";
import {GlImageGenerationPin} from "./image-generations.js";
import {textureNative,type GlTextureView} from "./image-storage.js";
import {textureLevel,levelSamplesDepth} from "./texture-levels.js";
import {textureSwitchesAtHalf} from "./lod-switchover.js";
import {reserveOwnedDrawTargetStorage,prepareOwnedDrawTarget} from "./opaque-alpha.js";
import {nativeTextureBinding} from "./texture-bindings.js";
import {shareRendererLossAuthority,rendererLost,rendererLossCount} from "./renderer-loss.js";
import {PreparedNativeChanges,prepareNativeCall,prepareNativeInverse,checkedPreparedNativeCall,
  rethrowNativeGlFault,nativeGlFault,type NativeCall,type PreparedNativeCall,type PreparedNativeInverse} from "./native-recovery.js";
import type {GlesDraw} from "./draw-state.js";
const TEX=0x0de1;
type Input={unit:number;publicObject:WebGLTexture;native:WebGLTexture;pin:GlImageGenerationPin|null;descriptor:WebGLTexture|null};
function equalStencil(b:GlBinding):boolean {
  const a=b.shadow.stencil.front,c=b.shadow.stencil.back;
  return a.ref===c.ref&&a.valueMask===c.valueMask&&a.writeMask===c.writeMask;
}
export class PreparedOwnedDraw {
  private pin:GlProgramQueryPin|null=null;
  private mirror:PreparedUniformValues|null=null;
  private readonly inputs:Input[]=[];
  private readonly samplerLocations:number[]=[];
  private readonly calls:PreparedNativeCall[]=[];
  private readonly restore:NativeCall[]=[];
  private variants:readonly (OwnedVariantProgram|null)[]=[];
  private view!:GlBinding;
  private receiver!:PreparedNativeChanges;
  private inverse!:PreparedNativeInverse;
  private readonly objects:GlBinding["objects"];
  private readonly native:WebGL2RenderingContext;
  private readonly epoch:number;
  private draw:GlesDraw|null=null;
  private mask=0;
  private active=false;
  private readonly reversed:boolean;
  private readonly folded:boolean;
  private constructor(readonly binding:GlBinding,private base:GlBinding,private readonly defaultOnly:boolean){
    this.objects=binding.objects;this.native=binding.gl!;this.epoch=rendererLossCount(this.native);
    this.reversed=depthRangeReversed(base.shadow.depthRange);this.folded=blendFoldNeeded(base.shadow);
  }
  static prepare(execution:GlContextExecutionLease,base:GlBinding,reserve?:(receiver:PreparedOwnedDraw)=>void,defaultOnly=false):PreparedOwnedDraw|null {
    const b=execution.binding,primary=b.currentProgram;
    if(!primary||execution.retired||rendererLost(b)||!equalStencil(base)||
      (defaultOnly&&(!isDefaultFramebuffer(b,b.shadow.fbo)||(b.undefinedDefaultFbo!==null&&b.shadow.fbo===b.undefinedDefaultFbo))))return null;
    let prepared:PreparedOwnedDraw|null=null;
    try{
      const layout=uniformLayout(b,primary);if(!layout)return null;
      const names:string[]=[],locations:number[]=[];
      for(const entry of layout.entries){
        if(entry.type!==0x8b5e&&entry.type!==0x8b60&&entry.type!==0x8dc1)continue;
        if(entry.guestType!==0x8b5e||names.length+entry.size>2)return null;
        for(let i=0;i<entry.size;i++){names.push(entry.array?`${entry.name}[${i}]`:entry.name);locations.push(entry.location+i);}
      }
      prepared=new PreparedOwnedDraw(b,base,defaultOnly);reserve?.(prepared);
      prepared.pin=GlProgramQueryPin.acquireInstalled(execution);if(!prepared.pin)return null;
      prepareUniformWrites(primary);prepareSamplerWrites(primary);
      prepared.mirror=PreparedUniformValues.acquire(b,layout);if(!prepared.mirror){prepared.retire();return null;}
      prepared.samplerLocations.push(...locations);
      if(!prepared.captureInputs()){prepared.retire();return null;}
      const vertexDepthRange=ownedVertexDepthRange(base,primary);if(vertexDepthRange===null){prepared.retire();return null;}
      const blendFold=prepared.folded?ownedDrawColorBufferKind(base):undefined;if(blendFold===null){prepared.retire();return null;}
      const variants=prepareOwnedVariantPrograms(base,primary,prepared.mirror,names,
        {reversedDepth:prepared.reversed,vertexDepthRange,blendFold});
      if(!variants){prepared.retire();return null;}prepared.variants=variants;
      reserveOwnedDrawTargetStorage(base);prepared.prepareReceivers();prepared.active=true;return prepared;
    }catch(error){rethrowNativeGlFault(error);prepared?.retire();return null;}
  }
  private captureInputs():boolean {
    const b=this.binding,base=this.base,units=base.shadow.textureUnits.slice();
    // Active guest kinds were checked against the pinned executable. An
    // unused cube/external binding cannot be sampled by its ordinary2D
    // uniforms and must not tax or revoke their prepared draw authority.
    const textures=new Map<WebGLTexture,GlTextureView>(),ordinaryGet=base.textureViews.get.bind(base.textureViews);
    for(let unit=0;unit<units.length;unit++){
      const object=units[unit];if(!object)continue;if(unit>=16)return false;
      // A retained target may already contain private descriptors. Keep the
      // canonical public identity separately: resolving the descriptor as a
      // public object would either reject live input or recapture replacement
      // storage instead of the generation this proof actually owns.
      const publicObject=b.shadow.textureUnits[unit];if(!publicObject)return false;
      const view=base.textureViews.get(object),native=textureNative(base,object);
      if(view?.source||base.externallyOwnedTextures.has(native))return false;
      // This pin owns native identity, not immutable content. Shared in-place
      // respec/filter changes remain visible and select existing cold variants;
      // freezing those traits would make a healthy peer sample stale state.
      // Publish the CPU receiver before acquiring its native pin. A failed
      // row/array allocation after acquisition would otherwise strand a lease
      // that retire() cannot find when cold preparation returns unavailable.
      const input:Input={unit,publicObject,native,pin:null,descriptor:null};this.inputs.push(input);
      input.pin=GlImageGenerationPin.acquire(b,native,false,false,object);if(!input.pin)return false;
      const descriptor=input.pin.descriptor;if(!descriptor)return false;
      input.descriptor=descriptor;textures.set(descriptor,{native,source:null,read:null});
    }
    textures.get=(object:WebGLTexture)=>textures.has(object)?Map.prototype.get.call(textures,object):ordinaryGet(object);
    const shadow=Object.create(base.shadow,{textureUnits:{value:units}});
    this.view=Object.create(base,{shadow:{value:shadow},textureViews:{value:textures},robustAccess:{value:false}}) as GlBinding;
    shareRendererLossAuthority(b,this.view);return true;
  }
  get executionView():GlBinding{return this.view;}
  private prepareReceivers():void {
    const b=this.binding,gl=b.gl!;
    for(let i=0;i<this.samplerLocations.length;i++){
      this.calls.push(prepareNativeCall(gl,["activeTexture",0x84c0]),prepareNativeCall(gl,["bindTexture",TEX,null]));
      this.restore.push(["activeTexture",0x84c0],["bindTexture",TEX,null]);
    }
    this.calls.push(prepareNativeCall(gl,["activeTexture",0x84c0]),prepareNativeCall(gl,["useProgram",null]));
    this.restore.push(["activeTexture",0x84c0],["useProgram",null]);
    const inverse=prepareNativeInverse(b,this.restore);if(!inverse)throw new Error("Unable to reserve owned sampling inverse");this.inverse=inverse;
    const receiver=PreparedNativeChanges.reserve(b,[{apply:()=>{
      for(const call of this.calls)if(!checkedPreparedNativeCall(b,call))return false;
      const variant=this.variants[this.mask],mirror=this.mirror!;
      if(variant){
        if(mirror.generation<0||variant.generation!==mirror.generation){
          if(!checkedGlSequence(b,variant.upload))return false;variant.generation=mirror.generation;
        }
        if(variant.range&&!checkedGlSequence(b,variant.rangeCalls))return false;
        if(variant.blend&&!checkedGlSequence(b,variant.blendCalls))return false;
      }
      prepareOwnedDrawTarget(this.view);this.draw!.issue();return true;
    },restore:inverse}],{finalizer:inverse});
    if(!receiver)throw new Error("Unable to reserve owned sampling receiver");this.receiver=receiver;
  }
  /** Validate authority before any fetch/upload mutation. Ordinary malformed
   * records get their original error path; issue also checks the invariant so
   * corruption between preflight and native entry cannot become a late flag. */
  matches():boolean {
    const b=this.binding;
    if(!this.active||!this.mirror||!this.pin||this.pin.binding!==b||b.gl!==this.native||b.objects!==this.objects||rendererLost(b)||rendererLossCount(this.native)!==this.epoch||b.currentProgram!==this.pin.program||
      !equalStencil(this.base)||depthRangeReversed(this.base.shadow.depthRange)!==this.reversed||blendFoldNeeded(this.base.shadow)!==this.folded)return false;
    // Default surfaces can rotate their already-admitted native backing each
    // present. Check drawable authority rather than freeze a framebuffer name
    // and force a new cold query per frame; user/surfaceless targets never
    // inherit this proof merely by reusing a guest token.
    if(this.defaultOnly&&(!isDefaultFramebuffer(b,b.shadow.fbo)||(b.undefinedDefaultFbo!==null&&b.shadow.fbo===b.undefinedDefaultFbo)))return false;
    let count=0;for(const object of b.shadow.textureUnits)if(object)count++;
    if(count!==this.inputs.length)return false;
    for(const input of this.inputs)if(!input.pin?.active||!input.descriptor||b.shadow.textureUnits[input.unit]!==input.publicObject)return false;
    return true;
  }
  issue(draw:GlesDraw):boolean {
    const b=this.binding,mirror=this.mirror!;
    if(!this.matches())nativeGlFault("Owned draw lost its cold executable, sampling or context-state authority");
    let count=0;for(const object of b.shadow.textureUnits)if(object)count++;
    if(count!==this.inputs.length)nativeGlFault("Owned draw input bindings changed without a new proof");
    for(const input of this.inputs){
      if(!input.pin?.active||!input.descriptor||b.shadow.textureUnits[input.unit]!==input.publicObject)nativeGlFault("Owned draw lost an exact sampling identity");
      this.view.shadow.textureUnits[input.unit]=textureNative(b,input.publicObject)===input.native?input.publicObject:input.descriptor;
    }
    let mask=0,previousUnit=-1;
    for(let i=0;i<this.samplerLocations.length;i++){
      const unit=mirror.sampler(this.samplerLocations[i]),object=this.view.shadow.textureUnits[unit]??this.view.shadow.defaultTextures.get(TEX);
      if(object&&levelSamplesDepth(textureLevel(object,TEX,0)))mask|=1<<(i*2);
      // ALPHA/luminance lanes, NPOT completeness/wrap and ordinary format
      // sampling remain the native texture's state (OES_texture_npot is
      // advertised). Only depth luminance and GLES2's half-LOD rule rewrite
      // the executable; peer changes select existing prepared combinations.
      if(textureSwitchesAtHalf(object))mask|=2<<(i*2);
      const at=i*2,unique=unit!==previousUnit;this.calls[at].enabled=this.calls[at+1].enabled=unique;
      this.inverse.prepared.groups[0][at].enabled=this.inverse.prepared.groups[0][at+1].enabled=unique;
      this.calls[at].call[1]=0x84c0+unit;
      (this.calls[at+1].call as ["bindTexture",number,WebGLTexture|null])[2]=nativeTextureBinding(this.view.shadow,TEX,unit,this.view.textureViews);
      this.restore[at][1]=0x84c0+unit;
      (this.restore[at+1] as ["bindTexture",number,WebGLTexture|null])[2]=nativeTextureBinding(b.shadow,TEX,unit,b.textureViews);
      previousUnit=unit;
    }
    this.mask=mask;this.draw=draw;
    const at=this.calls.length-2,variant=this.variants[mask];
    this.calls[at].call[1]=0x84c0+b.shadow.activeTexture;
    this.calls[at].enabled=this.samplerLocations.length!==0;
    this.inverse.prepared.groups[0][at].enabled=this.samplerLocations.length!==0;
    this.calls[at+1].enabled=!!variant;this.inverse.prepared.groups[0][at+1].enabled=!!variant;
    (this.calls[at+1].call as ["useProgram",WebGLProgram|null])[1]=variant?.program??null;
    this.restore[at][1]=0x84c0+b.shadow.activeTexture;
    (this.restore[at+1] as ["useProgram",WebGLProgram|null])[1]=b.currentProgram;
    try{return this.receiver.apply();}finally{this.draw=null;}
  }
  retire():boolean {
    this.active=false;
    for(const input of this.inputs)if(input.pin&&!input.pin.release())return false;
    if(this.mirror){this.mirror.release();this.mirror=null;}
    if(this.pin&&!this.pin.release())return false;this.pin=null;return true;
  }
}
