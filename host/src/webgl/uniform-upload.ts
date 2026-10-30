import type { GlBinding } from "./registry.js";
import type { GlUniformMetadata } from "./object-group.js";
import { acceptedUniformCount } from "./uniform-setters.js";
import { checkedGlCall, currentProgramName, recordGlError } from "./program-objects.js";
import * as O from "./ops.js";

export type GlUniformUpload = {
  token: number; op: number; location: number; total: number; cursor: number; stride: number;
  payload: Uint8Array<ArrayBuffer> | null;
  gl: GlBinding["gl"]; context: GlBinding["contextId"]; objects: GlBinding["objects"];
  executable: WebGLProgram | null; program: number;
  nativeLocation: WebGLUniformLocation | undefined; metadata: GlUniformMetadata | undefined;
};

export function uniformUploadComponents(op: number): number {
  switch (op) {
    case O.OP_UNIFORM1FV: case O.OP_UNIFORM1IV: return 1;
    case O.OP_UNIFORM2FV: case O.OP_UNIFORM2IV: return 2;
    case O.OP_UNIFORM3FV: case O.OP_UNIFORM3IV: return 3;
    case O.OP_UNIFORM4FV: case O.OP_UNIFORM4IV: case O.OP_UNIFORM_MATRIX2FV: return 4;
    case O.OP_UNIFORM_MATRIX3FV: return 9;
    case O.OP_UNIFORM_MATRIX4FV: return 16;
    default: return 0;
  }
}
export function uniformUploadOp(op: number): boolean {
  return op >= O.OP_UNIFORM_UPLOAD_BEGIN && op <= O.OP_UNIFORM_UPLOAD_CANCEL;
}
function matrix(op: number): boolean {
  return op===O.OP_UNIFORM_MATRIX2FV || op===O.OP_UNIFORM_MATRIX3FV || op===O.OP_UNIFORM_MATRIX4FV;
}

/** Structural validation is independent of a live transaction so the whole
 * command batch is judged before its first allocation or native mutation. */
export function validUniformUploadPayload(op: number, view: DataView): boolean {
  if (view.byteLength<4 || !view.getUint32(0,true)) return false;
  if (op===O.OP_UNIFORM_UPLOAD_COMMIT || op===O.OP_UNIFORM_UPLOAD_CANCEL) return view.byteLength===4;
  if (op===O.OP_UNIFORM_UPLOAD_BEGIN) return view.byteLength===20
    && uniformUploadComponents(view.getUint32(4,true))!==0
    && (matrix(view.getUint32(4,true)) || view.getUint32(16,true)===0);
  if (op!==O.OP_UNIFORM_UPLOAD_CHUNK || view.byteLength<16) return false;
  const components=uniformUploadComponents(view.getUint32(4,true)), count=view.getUint32(12,true);
  return !!components && count>0 && view.byteLength===16+count*components*4;
}

/** A partial guest call owns no native uniform writes. Refuse an unrelated
 * same-context operation rather than exposing a prefix or holding peers. */
export function interruptUniformUpload(b: GlBinding): boolean {
  if (!b.uniformUpload) return false;
  b.uniformUpload=null;
  recordGlError(b,0x502);
  return true;
}

/** Stage only actual reflected storage, independent of guest address spaces.
 * Original counts are checked before a prefix can be published; native storage
 * changes exactly once, only after complete data and unchanged authority. */
export function runUniformUpload(b: GlBinding, command: number, view: DataView,
  commit: (op: number, payload: DataView) => void): void {
  const token=view.getUint32(0,true);
  const invalid=(clear=true)=>{if(clear)b.uniformUpload=null;recordGlError(b,0x502);};
  if (command===O.OP_UNIFORM_UPLOAD_CANCEL) {
    if (b.uniformUpload && token<b.uniformUpload.token) {invalid(false);return;}
    b.uniformUpload=null;
    b.uniformUploadSerial=Math.max(b.uniformUploadSerial,token);
    return;
  }
  if (command===O.OP_UNIFORM_UPLOAD_BEGIN) {
    if (token<=b.uniformUploadSerial) {invalid(false);return;}
    b.uniformUploadSerial=token;
    b.uniformUpload=null;
    const op=view.getUint32(4,true), location=view.getInt32(8,true), total=view.getUint32(12,true);
    const stride=uniformUploadComponents(op)*4, header=matrix(op)?12:8;
    // A rejection tombstone consumes this call's records without retaining
    // requested bytes or replacing its first GL error with continuation errors.
    const pending: GlUniformUpload={token,op,location,total,cursor:0,stride,payload:null,
      gl:b.gl,context:b.contextId,objects:b.objects,executable:b.currentProgram,program:currentProgramName(b),
      nativeLocation:b.uniformLocations.get(location),metadata:b.uniformMetadata.get(location)};
    b.uniformUpload=pending;
    if (total>0x7fffffff) {recordGlError(b,0x501);return;}
    const original=new DataView(new ArrayBuffer(header));
    original.setInt32(0,location,true);original.setUint32(4,total,true);
    if (header===12) original.setUint32(8,view.getUint32(16,true),true);
    else if (view.getUint32(16,true)!==0) {invalid();return;}
    const accepted=acceptedUniformCount(b,op,original,0);
    if (accepted===null) return;
    try {
      const bytes=header+accepted*stride;
      if (!Number.isSafeInteger(bytes)) {recordGlError(b,0x505);return;}
      const payload=new Uint8Array(bytes);
      payload.set(new Uint8Array(original.buffer));
      new DataView(payload.buffer).setUint32(4,accepted,true);
      pending.payload=payload;
    } catch {recordGlError(b,0x505);}
    return;
  }
  const pending=b.uniformUpload;
  if (!pending || pending.token!==token) {invalid(!pending || token>=pending.token);return;}
  if (command===O.OP_UNIFORM_UPLOAD_CHUNK) {
    const op=view.getUint32(4,true), offset=view.getUint32(8,true), count=view.getUint32(12,true);
    if (op!==pending.op || offset!==pending.cursor || count>pending.total-offset) {invalid();return;}
    if (pending.payload) {
      const header=matrix(op)?12:8;
      const accepted=(pending.payload.byteLength-header)/pending.stride;
      const elements=Math.max(0,Math.min(count,accepted-offset));
      if (elements) pending.payload.set(new Uint8Array(view.buffer,view.byteOffset+16,elements*pending.stride),header+offset*pending.stride);
    }
    pending.cursor+=count;
    return;
  }
  b.uniformUpload=null;
  if (pending.cursor!==pending.total) {invalid();return;}
  if (!pending.payload) return;
  if (pending.gl!==b.gl || pending.context!==b.contextId || pending.objects!==b.objects
      || pending.executable!==b.currentProgram || pending.program!==currentProgramName(b)
      || pending.nativeLocation!==b.uniformLocations.get(pending.location)
      || pending.metadata!==b.uniformMetadata.get(pending.location)) {invalid();return;}
  checkedGlCall(b,()=>commit(pending.op,new DataView(pending.payload!.buffer)));
}
