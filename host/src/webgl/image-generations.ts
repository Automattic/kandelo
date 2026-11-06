import {recordCpuGlOutOfMemory} from "./errors.js";
/** Native image storage retained by accepted private draws. A GLuint and its
 * logical metadata may move to new storage; a queued draw owns the old native
 * generation until its last explicit lease ends. EGLImage ownership stays
 * independent: all final native deletion paths converge on the same receipt. */
import type {GlBinding} from "./registry.js";
import {rendererObjectEpoch} from "./renderer-loss.js";
import {reserveNativeRetirement,retainNativeRetirement,retireNativeRetirement,
  rethrowNativeGlFault,transferNativeRetirement,type NativeRetirement,type NativeRetirementLease,type NativeDeletion} from "./native-recovery.js";
import {recordGlError} from "./errors.js";
import {textureFaces,replaceTextureLevels,recordTextureLevel} from "./texture-levels.js";
import {copyTextureFilters} from "./lod-switchover.js";

type Generation={gl:WebGL2RenderingContext;epoch:number;renderbuffer:boolean;retirement:NativeRetirement;immutable:number;descriptor:WebGLTexture|null};
const generations=new WeakMap<object,Generation>();

export class GlImageGenerationPin {
  private released=false;
  private lease:NativeRetirementLease|null=null;
  private generation:Generation|null=null;
  private immutable=false;
  private constructor(readonly native:WebGLTexture|WebGLRenderbuffer){}
  static acquire(b:GlBinding,native:WebGLTexture|WebGLRenderbuffer,renderbuffer=false,immutable=true,logicalSource?:WebGLTexture):GlImageGenerationPin|null {
    if(!b.gl)return null;
    let generation=generations.get(native);
    if(generation && (generation.gl!==b.gl || generation.epoch!==rendererObjectEpoch(b) || generation.renderbuffer!==renderbuffer))return null;
    let reserved:NativeRetirement|null=null;
    try {
      const pin=new GlImageGenerationPin(native);
      if(!generation){
        // Reserve final deletion custody before publishing the first pin. The
        // receipt is requested only when the ordinary object/BO relinquishes
        // storage; dropping a cache pin must not delete a still-live texture.
        const retirement=reserveNativeRetirement(b,[[renderbuffer?"deleteRenderbuffer":"deleteTexture",native] as NativeDeletion]);
        if(!retirement)return null;
        reserved=retirement;
        generation={gl:b.gl,epoch:rendererObjectEpoch(b),renderbuffer,retirement,immutable:0,descriptor:null};
        generations.set(native,generation);reserved=null;
      }
      if(logicalSource){
        if(!generation.descriptor)generation.descriptor={} as WebGLTexture;
        refreshImageGenerationMetadata(native,logicalSource);
      }
      pin.lease=retainNativeRetirement(generation.retirement);
      if(!pin.lease)return null;
      pin.generation=generation;pin.immutable=immutable;
      if(immutable)generation.immutable++;
      return pin;
    }catch(error){if(reserved)transferNativeRetirement(reserved);rethrowNativeGlFault(error);recordCpuGlOutOfMemory(b);return null;}
  }
  get descriptor():WebGLTexture|null{return this.generation?.descriptor??null;}
  get active():boolean{return !this.released&&!!this.lease?.active;}
  release():boolean {
    if(this.released)return true;
    if(this.lease&&!this.lease.release(null))return false;
    if(this.immutable&&this.generation)this.generation.immutable--;
    this.released=true;return true;
  }
}
/** Only a held generation needs orphaning. A cold receipt without references
 * remains the ordinary object's cleanup receiver, not an immutable pin. */
export function imageGenerationHeld(native:object):boolean {
  const generation=generations.get(native);
  return !!generation && !generation.retirement.complete && generation.immutable!==0;
}
/** Keep one deletion owner even if a pin later coexists with an EGLImage BO.
 * A completed receipt also suppresses a repeated cleanup attempt after refusal. */
export function imageGenerationOwnsDeletion(native:object):boolean{return generations.has(native);}
export function retireImageGeneration(native:object):boolean {
  const retirement=generations.get(native)?.retirement;
  if(!retirement)return true;
  const complete=retireNativeRetirement(retirement);
  // Retained work is an explicit live owner, not a failed cleanup. Releasing
  // its last lease performs the already-requested deletion and remains loud.
  return complete || retirement.references!==0;
}

/** Capture the last public metadata of a native sampling generation before
 * replacement/deletion. Input pins preserve handle identity, not immutable
 * texels: ordinary updates remain in place, including nonrenderable formats.
 * This cold copy lets old-generation shader emulations stop following the new
 * public source when its native handle changes. */
export function refreshImageGenerationMetadata(native:object,source:WebGLTexture):void {
  const descriptor=generations.get(native)?.descriptor;
  if(!descriptor||descriptor===source)return;
  // A cold proof can borrow an existing retained descriptor as its source.
  // Clearing that descriptor before copying itself would erase old levels.
  replaceTextureLevels(descriptor,0xde1,null);
  for(const [face,levels] of textureFaces(source))for(const [level,spec] of levels)
    recordTextureLevel(descriptor,face,level,{...spec,gles:spec.gles&&{...spec.gles}});
  copyTextureFilters(source,descriptor);
}
