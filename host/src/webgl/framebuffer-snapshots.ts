import {recordCpuGlOutOfMemory} from "./errors.js";
/** Exact native target/input generations for locally validated offscreen
 * draws. These containers are private execution state, never guest names. */
import type {GlBinding,GlContextExecutionLease} from "./registry.js";
import {GlImageGenerationPin} from "./image-generations.js";
import {textureNative,attachedNativeStorage,type GlTextureView} from "./image-storage.js";
import {textureLevel,textureFaces,recordTextureLevel,type GlTextureLevel} from "./texture-levels.js";
import {prepareDrawTarget,isOpaqueAlphaStorage} from "./opaque-alpha.js";
import {storageWrites} from "./image-writes.js";
import {framebufferInputsRevision} from "./framebuffer-revision.js";
import {rendererLost,shareRendererLossAuthority} from "./renderer-loss.js";
import {withNativeBookkeeping} from "./native-batch.js";
import {checkedGlCall,recordGlError} from "./program-objects.js";
import {applyNativeChanges,nativeInverse,reserveNativeRetirement,retireNativeRetirement,
  PreparedNativeChanges,prepareNativeInverse,prepareNativeCall,checkedPreparedNativeCall,
  rethrowNativeGlFault,type NativeRetirement,type NativeCall} from "./native-recovery.js";

export const FRAMEBUFFER_SNAPSHOT_CAPACITY=16;
const TEX=0xde1,DRAW=0x8ca9,COLOR=0x8ce0;
type Input={unit:number;object:WebGLTexture;native:WebGLTexture;pin:GlImageGenerationPin|null;descriptor:WebGLTexture|null};
type DrawPlan={apply:NativeCall[];restore:NativeCall[];view:GlBinding;execute(work:()=>boolean):boolean;executeTargetOnly(work:()=>boolean):boolean;clear(mask:number):boolean};
type Capture={plan:DrawPlan|null;framebuffer:WebGLFramebuffer|null;source:WebGLFramebuffer;target:WebGLTexture;
  pin:GlImageGenerationPin|null;inputs:Input[];retirement:NativeRetirement|null;view:GlBinding|null;ready:boolean};
type Cell={token:number;capture:Capture|null};

export class GlFramebufferSnapshots {
  private readonly cells:Cell[]=Array.from({length:FRAMEBUFFER_SNAPSHOT_CAPACITY},()=>({token:0,capture:null}));
  private readonly objects:GlBinding["objects"];
  private readonly contextId:GlBinding["contextId"];
  private constructor(readonly binding:GlBinding,private execution:GlContextExecutionLease|null){this.objects=binding.objects;this.contextId=binding.contextId;}
  static create(execution:GlContextExecutionLease):GlFramebufferSnapshots|null {
    const b=execution.binding;
    try {
      const snapshots=new GlFramebufferSnapshots(b,null);
      snapshots.execution=execution.clone();
      if(!snapshots.execution){recordCpuGlOutOfMemory(b);return null;}
      return snapshots;
    }catch(error){rethrowNativeGlFault(error);recordCpuGlOutOfMemory(b);return null;}
  }
  private owns():boolean {
    const b=this.binding;
    return !!this.execution&&!this.execution.retired&&this.execution.context===b.gl&&b.contextId!==null&&b.contextId===this.contextId&&b.objects===this.objects&&!rendererLost(b);
  }
  /** Return 1 for the completed capture, 0 for unavailable (no API error),
   * null for a failed effect. The caller seals this result before copyout. */
  capture(index:number,token:number,name:number):number|null {
    const b=this.binding;
    if(!this.owns()||!Number.isInteger(index)||index<0||index>=this.cells.length||!Number.isInteger(token)||!token||token>0xffffffff||!Number.isInteger(name)||!name||name>0xffffffff){recordGlError(b,0x502);return null;}
    const cell=this.cells[index]!;
    if(cell.token===0xffffffff||token!==cell.token+1){recordGlError(b,0x502);return null;}
    if(cell.capture&&!this.retireCapture(cell.capture))return null;
    cell.token=token;cell.capture=null;
    try {
    const source=b.shadow.fbo,points=source&&b.framebufferAttachments.get(source),image=points?.get(COLOR);
    if(!source||b.fbos.get(name)!==source||points?.size!==1||image?.kind!=="texture"||image.target!==TEX||image.level!==0)return 0;
    const level=textureLevel(image.object,TEX,0),view=b.textureViews.get(image.object);
    if(!level||level.width<=0||level.height<=0||level.compressed||level.gles?.colorRenderable!==true||view?.source||b.externallyOwnedTextures.has(view?.native??image.object))return 0;
    // Every image an immutable target orphan may need to preserve must be
    // color-copyable. Other layouts retain ordinary observed execution.
    for(const levels of textureFaces(image.object).values())for(const spec of levels.values())
      if(spec.compressed||spec.gles?.colorRenderable!==true)return 0;
    const target=attachedNativeStorage(b,image) as WebGLTexture|null;
    if(!target)return 0;
    // An input can become aliased or be respecified by a future peer after C
    // accepts the draw. Retain its exact native generation too; a target-only
    // pin would still let that peer manufacture feedback at execution time.
    const inputs:Input[]=[];
    for(const units of [b.shadow.cubeTextureUnits,b.shadow.externalTextureUnits])if(units.some(Boolean))return 0;
    for(let unit=0;unit<b.shadow.textureUnits.length;unit++){
      const object=b.shadow.textureUnits[unit];if(!object)continue;
      if(unit>=16)return 0;
      const inputView=b.textureViews.get(object),native=textureNative(b,object);
      if(inputView?.source||b.externallyOwnedTextures.has(native)||native===target)return 0;
      inputs.push({unit,object,native,pin:null,descriptor:null});
    }
    const capture:Capture={source,target,plan:null,framebuffer:null,pin:null,inputs,retirement:null,view:null,ready:false};
    cell.capture=capture;
      capture.pin=GlImageGenerationPin.acquire(b,target);if(!capture.pin)return null;
      for(const input of inputs){input.pin=GlImageGenerationPin.acquire(b,input.native,false,false,input.object);if(!input.pin)return null;}
      capture.retirement=reserveNativeRetirement(b,[["deleteFramebuffer",null]]);if(!capture.retirement)return null;
      const gl=b.gl!,old=b.shadow.fbo;
      let complete=false;
      const accepted=withNativeBookkeeping(()=>applyNativeChanges(b,[{apply:()=>{
        if(!checkedGlCall(b,()=>{capture.framebuffer=gl.createFramebuffer();capture.retirement!.calls[0]![1]=capture.framebuffer;}))return false;
        if(!capture.framebuffer){recordGlError(b,0x505);return false;}
        return checkedGlCall(b,()=>{
          gl.bindFramebuffer(DRAW,capture.framebuffer);
          gl.framebufferTexture2D(DRAW,COLOR,TEX,target,0);
          complete=gl.checkFramebufferStatus(DRAW)===0x8cd5;
        });
      },restore:nativeInverse(b,[["bindFramebuffer",DRAW,old]])}],{finalizer:nativeInverse(b,[["bindFramebuffer",DRAW,old]])}));
      if(!accepted)return null;
      if(!complete){
        if(!this.retireCapture(capture))return null;
        cell.capture=null;return 0;
      }
      capture.view=this.executionView(capture,image.object,level);
      capture.plan=this.prepareChanges(capture);
      capture.ready=true;return 1;
    }catch(error){rethrowNativeGlFault(error);recordCpuGlOutOfMemory(b);return null;}
  }
  private executionView(capture:Capture,object:WebGLTexture,level:GlTextureLevel):GlBinding {
    const b=this.binding,framebuffer=capture.framebuffer!;
    // Private logical metadata describes the retained native attachment. Using
    // the public object's level record here would rederive size/write facts
    // from its replacement after any unrelated framebuffer revision.
    const descriptor={} as WebGLTexture;
    recordTextureLevel(descriptor,TEX,0,{...level,gles:level.gles&&{...level.gles}});
    const textures=new Map<WebGLTexture,GlTextureView>(),ordinaryGet=b.textureViews.get.bind(b.textureViews);
    textures.set(descriptor,{native:capture.target,source:null,read:null});
    const units=[...b.shadow.textureUnits];
    for(const input of capture.inputs){
      input.descriptor=input.pin!.descriptor!;
      units[input.unit]=input.object;
      textures.set(input.descriptor,{native:input.native,source:null,read:null});
    }
    const privateGet=textures.get.bind(textures),privateObjects=new Set([descriptor,...capture.inputs.map(input=>input.descriptor!)]);
    textures.get=(key:WebGLTexture)=>privateObjects.has(key)?privateGet(key):ordinaryGet(key);
    const attachments=new Map([[framebuffer,new Map([[COLOR,{kind:"texture" as const,object:descriptor,target:TEX,level:0}]])]]);
    const shadow=Object.create(b.shadow,{fbo:{value:framebuffer},textureUnits:{value:units},
      samplingUnits:{value:{...b.shadow.samplingUnits,revision:-1},writable:true},drawTarget:{value:{fbo:framebuffer,
      revision:framebufferInputsRevision(),locked:isOpaqueAlphaStorage(capture.target),writes:storageWrites(capture.target)}}});
    const view=Object.create(b,{shadow:{value:shadow},framebufferAttachments:{value:attachments},textureViews:{value:textures},robustAccess:{value:false}}) as GlBinding;
    shareRendererLossAuthority(b,view);return view;
  }
  resolve(index:number,token:number):Capture|null {
    if(!this.owns()||!Number.isInteger(index)||index<0||index>=this.cells.length)return null;
    const cell=this.cells[index],capture=cell.capture;
    if(cell.token!==token||!capture?.ready||!capture.pin?.active||!capture.view)return null;
    const b=this.binding;
    // Bindings are context-local. A later same-context bind needs a different
    // cache entry; peer respecification can keep the identity while the record
    // correctly continues to use its retained native storage.
    let count=0;
    for(let unit=0;unit<b.shadow.textureUnits.length;unit++)if(b.shadow.textureUnits[unit])count++;
    if(count!==capture.inputs.length)return null;
    for(const input of capture.inputs)if(b.shadow.textureUnits[input.unit]!==input.object||!input.pin?.active)return null;
    if(b.shadow.cubeTextureUnits.some(Boolean)||b.shadow.externalTextureUnits.some(Boolean))return null;
    // Ordinary sampling storage can be updated in place. Its public metadata
    // remains exact while it still names this native handle; replacement
    // freezes the generation descriptor before publishing the new view.
    for(const input of capture.inputs){
      const object=textureNative(b,input.object)===input.native?input.object:input.descriptor!;
      if(capture.view.shadow.textureUnits[input.unit]!==object){
        capture.view.shadow.textureUnits[input.unit]=object;
        capture.view.shadow.samplingUnits.revision=-1;
      }
    }
    return capture;
  }
  /** All target/input selector rows are reserved at cold capture. Reusing
   * scalar cells avoids discovering a new target-plan allocation failure after
   * the guest already answered glGetError locally for a warmed draw. */
  private prepareChanges(capture:Capture):DrawPlan {
    const b=this.binding,view=capture.view!;
    const apply:NativeCall[]=[["bindFramebuffer",DRAW,capture.framebuffer],["colorMask",false,false,false,false]];
    const restore:NativeCall[]=[];
    for(const input of capture.inputs){
      apply.push(["activeTexture",0x84c0+input.unit],["bindTexture",TEX,input.native]);
      restore.push(["activeTexture",0x84c0+input.unit],["bindTexture",TEX,null]);
    }
    apply.push(["activeTexture",0x84c0]);
    restore.push(["activeTexture",0x84c0],["bindFramebuffer",DRAW,null],["colorMask",false,false,false,false]);
    const calls=apply.map(call=>prepareNativeCall(b.gl!,call)),inverse=prepareNativeInverse(b,restore);
    if(!inverse)throw new Error("Unable to reserve framebuffer inverse");
    let work:()=>boolean,mask=0;
    const clear=()=>{prepareDrawTarget(view);b.gl!.clear(mask);return true;};
    const receiver=PreparedNativeChanges.reserve(b,[{apply:()=>{
      for(const call of calls)if(!checkedPreparedNativeCall(b,call))return false;
      return work();
    },restore:inverse}],{finalizer:inverse});
    if(!receiver)throw new Error("Unable to reserve framebuffer receiver");
    // Readiness supplies its own active sampler selectors. Clear has no
    // sampler dependency at all. A separate cold receiver avoids binding all
    // captured units for either operation, without allocating another plan
    // after the guest has locally accepted the command.
    const targetCalls=[calls[0],calls[1]];
    const targetInverse=prepareNativeInverse(b,[restore[restore.length-2],restore[restore.length-1]]);
    if(!targetInverse)throw new Error("Unable to reserve target-only inverse");
    const targetReceiver=PreparedNativeChanges.reserve(b,[{apply:()=>{
      for(const call of targetCalls)if(!checkedPreparedNativeCall(b,call))return false;
      return work();
    },restore:targetInverse}],{finalizer:targetInverse});
    if(!targetReceiver)throw new Error("Unable to reserve target-only receiver");
    // The receivers and callbacks are cold metadata. Updating this borrow
    // cannot fail after the guest has locally accepted a warmed clear/draw.
    return {apply,restore,view,execute(next){work=next;return receiver.apply();},
      executeTargetOnly(next){work=next;return targetReceiver.apply();},
      clear(next){mask=next;work=clear;return targetReceiver.apply();}};
  }
  /** Native selectors are borrowed only on the current synchronous stack. */
  /** Refresh only target state for clears or a readiness-owned sampler plan.
   * Legacy input restore cells are unused there; touching every captured unit
   * would charge those operations for selectors they never borrow. */
  targetChanges(capture:Capture):DrawPlan {
    const b=this.binding,plan=capture.plan!,applyMask=plan.apply[1] as ["colorMask",boolean,boolean,boolean,boolean];
    for(let i=0;i<4;i++)applyMask[i+1]=b.shadow.colorMask[i]&&(i!==3||!plan.view.shadow.drawTarget.locked);
    (plan.restore[plan.restore.length-2] as ["bindFramebuffer",number,WebGLFramebuffer|null])[2]=b.shadow.fbo;
    const restoreMask=plan.restore[plan.restore.length-1] as ["colorMask",boolean,boolean,boolean,boolean];
    for(let i=0;i<4;i++)restoreMask[i+1]=b.shadow.colorMask[i]&&(i!==3||!b.shadow.drawTarget.locked);
    return plan;
  }
  /** Native selectors are borrowed only on the current synchronous stack. */
  changes(capture:Capture):DrawPlan {
    const b=this.binding,plan=this.targetChanges(capture);
    plan.apply[plan.apply.length-1][1]=0x84c0+b.shadow.activeTexture;
    for(let i=0;i<capture.inputs.length;i++)(plan.restore[i*2+1] as ["bindTexture",number,WebGLTexture|null])[2]=textureNative(b,capture.inputs[i].object);
    plan.restore[plan.restore.length-3][1]=0x84c0+b.shadow.activeTexture;
    return plan;
  }
  private retireCapture(capture:Capture):boolean {
    capture.ready=false;
    // Delete the private container before releasing its attachment generation.
    // A refused deletion leaves both receipts in this owned cell for retry.
    if(capture.retirement&&!retireNativeRetirement(capture.retirement))return false;
    for(const input of capture.inputs)if(input.pin&&!input.pin.release())return false;
    if(capture.pin&&!capture.pin.release())return false;
    return true;
  }
  retire():boolean {
    for(const cell of this.cells)if(cell.capture&&!this.retireCapture(cell.capture))return false;
    if(this.execution&&!this.execution.release())return false;
    this.execution=null;return true;
  }
}
