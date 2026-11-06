import type { GlBinding } from "./registry.js";
import { combinedTextureUnits } from "./limits.js";
import { currentProgramName, recordGlError } from "./program-objects.js";
import { uniformLayout, type GlUniformLayout } from "./uniform-layout.js";
import * as O from "./ops.js";

/** The accepted command's native target, filled by acceptedUniformCount. */
export type GlUniformTarget = { native: WebGLUniformLocation | null; layout: GlUniformLayout | null };

/** Return the GLES elements to submit, after authoritative executable/type
 * validation. GLES ignores zero counts and excessive array tails only after
 * checking program, location and signature; WebGL cannot judge that no-op.
 * The location is resolved against the installed executable's own numbering
 * (uniform-layout.ts, decision D-41): any program's location is accepted
 * where this executable has a uniform of a matching signature there. */
export function acceptedUniformCount(b: GlBinding, op: number, v: DataView, p: number,
    target?: GlUniformTarget): number | null {
  const matrix=op===O.OP_UNIFORM_MATRIX2FV || op===O.OP_UNIFORM_MATRIX3FV || op===O.OP_UNIFORM_MATRIX4FV;
  if(matrix && v.getUint32(p+8,true)!==0) {recordGlError(b,0x501);return null;}
  const location=v.getInt32(p,true), executable=b.currentProgram;
  if(!executable || !currentProgramName(b)) return rejectUniform(b);
  if(location===-1) return 0;
  const layout=uniformLayout(b,executable);
  if(!layout) return null;
  const meta=location>=0 ? layout.slots[location] : undefined;
  if(!meta) return rejectUniform(b);
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
  // A samplerCube of a translated program is a sampler2DArray natively
  // (essl3-translation.ts); ES 2.0 has no other 2D array sampler.
  const sampler=(meta.type===0x8b5e || meta.type===0x8b60 || meta.type===0x8dc1) && type===0x1404;
  if((meta.type!==type && meta.type!==boolean && !sampler) || (!meta.array && count>1)) return rejectUniform(b);
  const accepted=Math.min(count,meta.location+meta.size-location);
  // Sampler values are texture units; the limit is unknown (0) only on a
  // renderer that cannot report it, which then predicts nothing.
  const units=sampler && b.gl ? combinedTextureUnits(b.gl) : 0;
  if(units>0) {
    // Scan the accepted prefix directly. Arrays or scalar wrapper lists here
    // would allocate after the driver has already predicted this exact call.
    for(let i=0;i<accepted;i++){
      const value=v.getInt32(p+(op===O.OP_UNIFORM1I?4:8+i*4),true);
      if(value<0||value>=units){recordGlError(b,0x501);return null;}
    }
  }
  if(target && accepted) {
    const native=layout.native(b,location);
    if(native===false) return null;
    if(!native) return rejectUniform(b);
    target.native=native;target.layout=layout;
  }
  return accepted;
}

function rejectUniform(b:GlBinding):null {recordGlError(b,0x502);return null;}

/** Kept outside the decoder's nullable-target flow analysis. The authority
 * lives on the immutable layout and is absent for ordinary programs. */
export function recordPreparedUniformValues(target:GlUniformTarget,op:number,v:DataView,p:number,count:number):void {
  target.layout?.ownedValues?.write(op,v,p,count);
}
