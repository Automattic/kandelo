import type { GlBinding, GlContextExecutionLease } from "./registry.js";
import { checkedGlCall, recordGlError, requireProgramObject } from "./program-objects.js";
import { captureContextGlProgram, isContextGlProgramCapture, releaseGlProgramCapture, useContextGlProgramCapture } from "./program-captures.js";
import { checkedQueryReply } from "./state-query.js";
import { nativeGlFault, rethrowNativeGlFault } from "./native-recovery.js";
import { isKernelExportFailure } from "../kernel-entry-gate.js";

/** Optional GL17 cold capture/checked selection/retirement. These operations
 * use ordinary query ordering and current-thread authority, never a dead
 * session. Public context retirement also closes its acquired cache owners. */
export function validProgramCaptureRequest(input: Uint8Array, outputBytes: number): boolean {
  if(outputBytes!==16 || (input.byteLength!==8 && input.byteLength!==12)) return false;
  const view=new DataView(input.buffer,input.byteOffset,input.byteLength),action=view.getUint32(0,true);
  return action===1 ? input.byteLength===8 : action===2 ? input.byteLength===12 && view.getUint32(8,true)!==0 :
    action===3 && input.byteLength===8 && view.getUint32(4,true)!==0;
}

export function runProgramCaptureQuery(b: GlBinding, input: Uint8Array, out: Uint8Array,
    execution?: GlContextExecutionLease): number {
  if(!validProgramCaptureRequest(input,out.byteLength)) return -22;
  const request=new DataView(input.buffer,input.byteOffset,input.byteLength);
  const action=request.getUint32(0,true),nameOrHandle=request.getUint32(4,true);
  return checkedQueryReply(b,out,8,payload=>{
    // Reserve the result view before publishing any native/capture owner.
    const result=new DataView(payload.buffer,payload.byteOffset,payload.byteLength);
    if(action===1) {
      const program=requireProgramObject(b,nameOrHandle);
      if(!program) return -5;
      if(!execution || execution.binding!==b) {recordGlError(b,0x505);return -12;}
      let linked=false;
      if(!checkedGlCall(b,()=>{linked=!!b.gl!.getProgramParameter(program,0x8b82);})) return -5;
      // Failed linking is a successful status observation, with no executable
      // capture. It must not replace an older installed current executable.
      if(!linked) return 8;
      const handle=captureContextGlProgram(execution,nameOrHandle);
      if(!handle) return -5;
      result.setUint32(0,1,true);result.setUint32(4,handle,true);
    } else if(action===2) {
      const handle=request.getUint32(8,true);
      if(!useContextGlProgramCapture(b,nameOrHandle,handle)) return -5;
      result.setUint32(0,1,true);result.setUint32(4,handle,true);
    } else {
      if(!isContextGlProgramCapture(b,nameOrHandle)) {recordGlError(b,0x502);return -5;}
      // A refused private cleanup is a host fault, not a successful release.
      try {
        if(!releaseGlProgramCapture(b,nameOrHandle)) nativeGlFault("Program capture query could not retire its exact native owner");
      } catch(error) {rethrowNativeGlFault(error);if(isKernelExportFailure(error))throw error;
        nativeGlFault("Program capture query native retirement threw",error);
      }
      result.setUint32(0,1,true);
    }
    return 8;
  });
}
