import type { GlBinding } from "./registry.js";
import { currentProgramName, recordGlError } from "./program-objects.js";
import * as O from "./ops.js";

/** Return the GLES elements to submit, after authoritative executable/type
 * validation. GLES ignores zero counts and excessive array tails only after
 * checking program, location and signature; WebGL cannot judge that no-op. */
export function acceptedUniformCount(b: GlBinding, op: number, v: DataView, p: number): number | null {
  const matrix=op===O.OP_UNIFORM_MATRIX2FV || op===O.OP_UNIFORM_MATRIX3FV || op===O.OP_UNIFORM_MATRIX4FV;
  if(matrix && v.getUint32(p+8,true)!==0) {recordGlError(b,0x501);return null;}
  const location=v.getInt32(p,true), program=currentProgramName(b);
  const reject=()=>{recordGlError(b,0x502);return null;};
  if(!program) return reject();
  if(location===-1) return 0;
  const meta=b.uniformMetadata.get(location);
  if(!meta || !b.uniformLocations.has(location) || b.uniformLocationPrograms.get(location)!==program
      || meta.executable!==b.currentProgram) return reject();
  const scalar=op<=O.OP_UNIFORM4F;
  const count=scalar?1:v.getUint32(p+4,true);
  let type=0, boolean=0;
  switch(op) {
    case O.OP_UNIFORM1I: case O.OP_UNIFORM1IV: type=0x1404;boolean=0x8b56;break;
    case O.OP_UNIFORM2IV: type=0x8b53;boolean=0x8b57;break;
    case O.OP_UNIFORM3IV: type=0x8b54;boolean=0x8b58;break;
    case O.OP_UNIFORM4IV: type=0x8b55;boolean=0x8b59;break;
    case O.OP_UNIFORM1F: case O.OP_UNIFORM1FV: type=0x1406;boolean=0x8b56;break;
    case O.OP_UNIFORM2F: case O.OP_UNIFORM2FV: type=0x8b50;boolean=0x8b57;break;
    case O.OP_UNIFORM3F: case O.OP_UNIFORM3FV: type=0x8b51;boolean=0x8b58;break;
    case O.OP_UNIFORM4F: case O.OP_UNIFORM4FV: type=0x8b52;boolean=0x8b59;break;
    case O.OP_UNIFORM_MATRIX2FV: type=0x8b5a;break;
    case O.OP_UNIFORM_MATRIX3FV: type=0x8b5b;break;
    case O.OP_UNIFORM_MATRIX4FV: type=0x8b5c;break;
  }
  const sampler=(meta.type===0x8b5e || meta.type===0x8b60) && type===0x1404;
  if((meta.type!==type && meta.type!==boolean && !sampler) || (!meta.array && count>1)) return reject();
  return Math.min(count,meta.remaining);
}
