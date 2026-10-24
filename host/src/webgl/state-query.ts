import type { GlBinding } from "./registry.js";
import { activeVertexArray, vertexAttribute } from "./buffer-references.js";
import { canonicalBuffer, BUFFER_TRANSFER_BYTES, withBufferTransfer } from "./buffer-storage.js";
import { checkedGlCall, recordGlError } from "./program-objects.js";
import * as O from "./ops.js";

export function capabilityEnabled(b: GlBinding, cap: number): boolean | undefined {
  const s = b.shadow;
  switch (cap) {
    case 0x0be2: return s.blendEnabled;
    case 0x0b44: return s.cullFaceEnabled;
    case 0x0b71: return s.depthTestEnabled;
    case 0x0bd0: return s.ditherEnabled;
    case 0x8037: return s.polygonOffsetFillEnabled;
    case 0x809e: return s.sampleAlphaToCoverageEnabled;
    case 0x80a0: return s.sampleCoverageEnabled;
    case 0x0c11: return s.scissor.enabled;
    case 0x0b90: return s.stencilTestEnabled;
    default: return undefined;
  }
}
function fail(b: GlBinding, error: number): number { recordGlError(b,error); return -22; }
function bufferName(b: GlBinding, object: WebGLBuffer | null): number {
  if (!object) return 0;
  for (const [name,value] of b.buffers) if (value === object) return name;
  return b.retiredBuffers.get(object) ?? 0;
}

/** Op-table v3 replies carry status + payload + completion marker. GL
 * errors are recorded by the host once; malformed RPC spans return errno. */
export function runStateQuery(b: GlBinding, op: number, input: Uint8Array, out: Uint8Array): number | undefined {
  let size: number, inputSize = 8;
  switch (op) {
    case O.QOP_GET_BUFFER_PARAMETER: case O.QOP_IS_OBJECT: size = 4; break;
    case O.QOP_IS_ENABLED: size = 4; inputSize = 4; break;
    case O.QOP_GET_VERTEX_ATTRIBIV: case O.QOP_GET_VERTEX_ATTRIBFV:
      size = input.length === 8 && new DataView(input.buffer,input.byteOffset,8).getUint32(4,true) === 0x8626 ? 16 : 4; break;
    case O.QOP_GET_INDEX_USAGE: size = 8196; inputSize = 12; break;
    default: return undefined;
  }
  if (input.length !== inputSize || out.length < size+8) return -22;
  return checkedQueryReply(b,out,size,payload => runStatePayload(b,op,input,payload)!);
}

/** Build replies privately so a failed native read cannot publish partial data. */
export function checkedQueryReply(b: GlBinding, out: Uint8Array, size: number,
    write: (payload: Uint8Array<ArrayBuffer>) => number): number {
  const view = new DataView(out.buffer,out.byteOffset,out.byteLength);
  let payload: Uint8Array<ArrayBuffer>, rc: number;
  try { payload = new Uint8Array(size); }
  catch {
    recordGlError(b,0x505); out.fill(0,4,size+4); view.setUint32(0,1,true); view.setUint32(size+4,0x47514c33,true); return size+8;
  }
  try { rc = write(payload); }
  catch { recordGlError(b,0x505); rc = -12; }
  view.setUint32(0,rc < 0 ? 1 : 0,true);
  if (rc < 0) out.fill(0,4,size+4); else out.set(payload,4);
  view.setUint32(size+4,0x47514c33,true);
  return size+8;
}

function runStatePayload(b: GlBinding, op: number, input: Uint8Array, out: Uint8Array): number | undefined {
  const gl = b.gl!, v = new DataView(input.buffer,input.byteOffset,input.byteLength);
  const result = new DataView(out.buffer,out.byteOffset,out.byteLength);
  switch (op) {
    case O.QOP_GET_BUFFER_PARAMETER: {
      if (input.length !== 8 || out.length < 4) return -22;
      const target = v.getUint32(0,true), pname = v.getUint32(4,true);
      if (target !== 0x8892 && target !== 0x8893) return fail(b,0x500);
      if (pname !== 0x8764 && pname !== 0x8765) return fail(b,0x500);
      const object = target === 0x8892 ? b.shadow.arrayBuffer && canonicalBuffer(b,b.shadow.arrayBuffer) : activeVertexArray(b).element;
      const store = object && b.bufferStores.get(object);
      if (!store) return fail(b,0x502);
      result.setUint32(0,pname === 0x8764 ? store.size : store.usage,true); return 4;
    }
    case O.QOP_GET_VERTEX_ATTRIBIV:
    case O.QOP_GET_VERTEX_ATTRIBFV: {
      if (input.length !== 8 || out.length < 4) return -22;
      const index = v.getUint32(0,true), pname = v.getUint32(4,true);
      let limit = 0;
      if (!checkedGlCall(b, () => { limit = Number(gl.getParameter(0x8869)); })) return -5;
      if (index >= limit) return fail(b,0x501);
      const a = vertexAttribute(b,index);
      let values: number[];
      switch (pname) {
        case 0x8622: values = [a.enabled ? 1 : 0]; break;
        case 0x8623: values = [a.size]; break;
        case 0x8624: values = [a.stride]; break;
        case 0x8625: values = [a.type]; break;
        case 0x886a: values = [a.normalized ? 1 : 0]; break;
        case 0x889f: values = [bufferName(b,a.buffer)]; break;
        case 0x8626: values = b.shadow.vertexAttribValues.get(index) ?? [0,0,0,1]; break;
        default: return fail(b,0x500);
      }
      if (out.length < values.length*4) return -22;
      values.forEach((value,i) => op === O.QOP_GET_VERTEX_ATTRIBFV
        ? result.setFloat32(i*4,value,true) : result.setInt32(i*4,Math.round(value),true));
      return values.length*4;
    }
    case O.QOP_IS_OBJECT: {
      if (input.length !== 8 || out.length < 4) return -22;
      const kind = v.getUint32(0,true), name = v.getUint32(4,true);
      let value = false;
      if (kind > 5) return fail(b,0x500);
      if (!checkedGlCall(b, () => {
        switch (kind) {
          case 0: { const o = b.buffers.get(name); value = !!o && b.bufferStores.has(o); break; }
          case 1: { const o = b.textures.get(name); value = !!o && gl.isTexture(o); break; }
          case 2: { const o = b.rbos.get(name); value = !!o && gl.isRenderbuffer(o); break; }
          case 3: { const o = b.fbos.get(name); value = !!o && gl.isFramebuffer(o); break; }
          case 4: { const o = b.shaders.get(name); value = !!o && gl.isShader(o); break; }
          case 5: { const o = b.programs.get(name); value = !!o && gl.isProgram(o); break; }
        }
      })) return -5;
      result.setUint32(0,value ? 1 : 0,true); return 4;
    }
    case O.QOP_IS_ENABLED: {
      if (input.length !== 4 || out.length < 4) return -22;
      const enabled = capabilityEnabled(b,v.getUint32(0,true));
      if (enabled === undefined) return fail(b,0x500);
      result.setUint32(0,enabled ? 1 : 0,true); return 4;
    }
    case O.QOP_GET_INDEX_USAGE: {
      if (input.length !== 12 || out.length < 8196) return -22;
      const type = v.getUint32(0,true), offset = v.getUint32(4,true), count = v.getInt32(8,true);
      if (type !== 0x1401 && type !== 0x1403) return fail(b,0x500);
      if (count <= 0) return fail(b,0x501);
      const width = type === 0x1401 ? 1 : 2;
      const object = activeVertexArray(b).element, store = object && b.bufferStores.get(object);
      if (!store || offset%width || offset+count*width > store.size) return fail(b,0x502);
      let reply: Uint8Array<ArrayBuffer>, scratch: Uint8Array<ArrayBuffer>;
      try { reply = new Uint8Array(8196); scratch = new Uint8Array(Math.min(count*width,BUFFER_TRANSFER_BYTES)); }
      catch { recordGlError(b,0x505); return -12; }
      const bits = reply.subarray(4);
      let maximum = 0;
      if (!withBufferTransfer(b,store.source,store.source,() => {
        for (let at=0; at<count*width; at+=scratch.length) {
          const bytes = scratch.subarray(0,Math.min(scratch.length,count*width-at));
          if (!checkedGlCall(b, () => gl.getBufferSubData(0x8f36,offset+at,bytes))) return false;
          const data = new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
          for (let i=0; i<bytes.length; i+=width) {
            const index = width === 1 ? data.getUint8(i) : data.getUint16(i,true);
            bits[index>>3] |= 1<<(index&7); maximum = Math.max(maximum,index);
          }
        }
        return true;
      })) return -5;
      const view = new DataView(reply.buffer); view.setUint32(0,maximum,true);
      out.set(reply); return reply.length;
    }
    default: return undefined;
  }
}
