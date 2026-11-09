import type {GlBinding} from "./registry.js";
import {recordGlError} from "./program-objects.js";
import {rethrowNativeGlFault} from "./native-recovery.js";
export function validFramebufferSnapshotClear(v:DataView):boolean {
 return v.byteLength===16&&v.getUint32(0,true)!==0&&v.getUint32(4,true)<16&&v.getUint32(8,true)!==0&&(v.getUint32(12,true)&~0x4500)===0;
}
export function clearFramebufferSnapshot(b:GlBinding,v:DataView):boolean {
 try{
  if(!b.gl||!validFramebufferSnapshotClear(v)||b.programJournal?.id!==v.getUint32(0,true)){recordGlError(b,0x502);return false;}
  const target=b.programJournal.framebufferTargetChanges(v.getUint32(4,true),v.getUint32(8,true));
  if(!target){recordGlError(b,0x502);return false;}
  // Clear has no program/vertex dependency. It shares the immutable target's
  // own alpha/write facts rather than revalidating a mutable public FBO.
  return target.clear(v.getUint32(12,true));
 }catch(error){rethrowNativeGlFault(error);recordGlError(b,0x505);return false;}
}
