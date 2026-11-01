import type { GlBinding } from "./registry.js";
import { checkedGlCall, recordGlError } from "./program-objects.js";
import { checkedQueryReply } from "./state-query.js";
import type { GlImageStorage } from "./image-storage.js";
import { renderbufferLogicalFormat } from "./image-sizes.js";
import { boundFramebuffer, isDefaultFramebuffer } from "./framebuffer.js";
import { prepareTextureOperation, validGlesTextureParameter } from "./texture-bindings.js";
import * as O from "./ops.js";

function fail(b: GlBinding, error: number): number { recordGlError(b,error); return -22; }
function objectName<T>(names: Map<number,T>, retired: Map<T,number>, object: T): number {
  for (const [name,value] of names) if (value === object) return name;
  return retired.get(object) ?? 0;
}

/** V4 variable results have fixed requested capacity, including zero padding.
 * Offsets/capacities count bytes for strings and names for attached shaders.
 * Chunking keeps every reply inside the existing independent 64 KiB mailbox. */
export function runObjectQuery(b: GlBinding, op: number, input: Uint8Array, out: Uint8Array): number | undefined {
  let inputSize: number, size = 0, header = 0, unit = 1;
  switch (op) {
    case O.QOP_GET_ACTIVE_UNIFORM_INFO:
    case O.QOP_GET_ACTIVE_ATTRIB: inputSize = 16; header = 12; break;
    case O.QOP_GET_ATTACHED_SHADERS: inputSize = 12; header = 4; unit = 4; break;
    case O.QOP_GET_SHADER_SOURCE: inputSize = 12; header = 4; break;
    case O.QOP_GET_FB_ATTACHMENT: inputSize = 8; size = 16; break;
    case O.QOP_GET_RENDERBUFFER_PARAMETER: case O.QOP_GET_TEX_PARAMETER: inputSize = 8; size = 4; break;
    default: return undefined;
  }
  if (input.length !== inputSize) return -22;
  const v = new DataView(input.buffer,input.byteOffset,input.length);
  if (header) {
    const capacity = v.getUint32(inputSize-4,true);
    if (capacity > Math.floor((65536-8-header)/unit)) return -22;
    size = header+capacity*unit;
  }
  if (out.length < size+8) return -22;
  return checkedQueryReply(b,out,size,payload => {
    const gl = b.gl!, result = new DataView(payload.buffer);
    const name = v.getUint32(0,true), arg = v.getUint32(4,true);
    switch (op) {
      case O.QOP_GET_ACTIVE_UNIFORM_INFO:
      case O.QOP_GET_ACTIVE_ATTRIB:
      case O.QOP_GET_ATTACHED_SHADERS: {
        const program = b.programs.get(name);
        if (!program) return fail(b,b.shaders.has(name) ? 0x502 : 0x501);
        if (op === O.QOP_GET_ATTACHED_SHADERS) {
          const names = [...(b.programShaders.get(name) ?? [])];
          const offset = arg, capacity = v.getUint32(8,true);
          if (offset > names.length) return fail(b,0x501);
          result.setUint32(0,names.length,true);
          names.slice(offset,offset+capacity).forEach((value,i) => result.setUint32(4+4*i,value,true));
          return payload.length;
        }
        let count = 0, info: WebGLActiveInfo | null = null;
        if (!checkedGlCall(b, () => { count = Number(gl.getProgramParameter(program,op === O.QOP_GET_ACTIVE_UNIFORM_INFO ? 0x8b86 : 0x8b89)); })) return -5;
        if (arg >= count) return fail(b,0x501);
        if (!checkedGlCall(b, () => { info = op === O.QOP_GET_ACTIVE_UNIFORM_INFO ? gl.getActiveUniform(program,arg) : gl.getActiveAttrib(program,arg); })) return -5;
        if (!info) return fail(b,0x502);
        const active = info as WebGLActiveInfo, bytes = new TextEncoder().encode(active.name);
        const offset = v.getUint32(8,true), capacity = v.getUint32(12,true);
        if (offset > bytes.length) return fail(b,0x501);
        result.setUint32(0,bytes.length,true); result.setInt32(4,active.size,true); result.setUint32(8,active.type,true);
        payload.set(bytes.subarray(offset,offset+capacity),12);
        return payload.length;
      }
      case O.QOP_GET_SHADER_SOURCE: {
        const shader = b.shaders.get(name);
        if (!shader) return fail(b,b.programs.has(name) ? 0x502 : 0x501);
        const bytes = b.shaderSources.get(shader), total = bytes?.length ?? 0;
        if (arg > total) return fail(b,0x501);
        result.setUint32(0,total,true);
        if (bytes) payload.set(bytes.subarray(arg,arg+v.getUint32(8,true)),4);
        return payload.length;
      }
      case O.QOP_GET_FB_ATTACHMENT: {
        if (name !== 0x8d40 || ![0x8ce0,0x8d00,0x8d20].includes(arg)) return fail(b,0x500);
        const framebuffer = boundFramebuffer(b,name);
        if (isDefaultFramebuffer(b,framebuffer)) return fail(b,0x502);
        const image = b.framebufferAttachments.get(framebuffer!)?.get(arg);
        if (image) {
          const texture = image.kind === "texture";
          result.setUint32(0,texture ? 0x1702 : 0x8d41,true);
          result.setUint32(4,texture ? objectName(b.textures,b.retiredTextures,image.object as WebGLTexture)
            : objectName(b.rbos,b.retiredRenderbuffers,image.object as WebGLRenderbuffer),true);
          if (image.kind === "texture") {
            result.setInt32(8,image.level,true);
            result.setUint32(12,image.target === 0x0de1 ? 0 : image.target,true);
          }
        }
        return payload.length;
      }
      case O.QOP_GET_RENDERBUFFER_PARAMETER: {
        if (name !== 0x8d41 || ![0x8d42,0x8d43,0x8d44,0x8d50,0x8d51,0x8d52,0x8d53,0x8d54,0x8d55].includes(arg)) return fail(b,0x500);
        if (!b.shadow.renderbuffer) return fail(b,0x502);
        const image=b.renderbufferViews.get(b.shadow.renderbuffer)?.source;
        if(image){
          const format=imageRenderbufferFormat(image);
          const value=arg===0x8d42?image.width:arg===0x8d43?image.height:arg===0x8d44?format[0]:format[1][arg-0x8d50];
          result.setInt32(0,value,true);return 4;
        }
        let value = 0;
        if (!checkedGlCall(b, () => { value = Number(gl.getRenderbufferParameter(name,arg)); })) return -5;
        // BGRA renderbuffers are stored as RGBA8; report the requested format.
        if (arg === 0x8d44) value = renderbufferLogicalFormat(b.shadow.renderbuffer) ?? value;
        result.setInt32(0,value,true); return 4;
      }
      case O.QOP_GET_TEX_PARAMETER: {
        if ((name !== 0x0de1 && name !== 0x8513) || !validGlesTextureParameter(arg)) return fail(b,0x500);
        if (!prepareTextureOperation(b,name)) return -5;
        let value = 0;
        if (!checkedGlCall(b, () => { value = Number(gl.getTexParameter(name,arg)); })) return -5;
        result.setInt32(0,value,true); return 4;
      }
      default: return -22;
    }
  });
}

/** Sized format and red/green/blue/alpha/depth/stencil bits of an EGLImage
 * as a renderbuffer sibling. BO images are RGBA8; an exported GLES image has
 * its source's format (EGL 1.5 section 3.9). */
function imageRenderbufferFormat(image: GlImageStorage): [number, number[]] {
  const sized: Record<number, number[]> = {
    0x8058: [8,8,8,8,0,0], 0x8051: [8,8,8,0,0,0], 0x8056: [4,4,4,4,0,0], 0x8057: [5,5,5,1,0,0],
    0x8d62: [5,6,5,0,0,0], 0x81a5: [0,0,0,0,16,0], 0x8d48: [0,0,0,0,0,8], 0x88f0: [0,0,0,0,24,8],
  };
  let internal = image.internalFormat ?? 0x8058;
  if (!sized[internal]) {
    const rgb = image.format === 0x1907, type = image.type ?? 0x1401;
    internal = type === 0x8033 ? 0x8056 : type === 0x8034 ? 0x8057 : type === 0x8363 ? 0x8d62 : rgb ? 0x8051 : 0x8058;
  }
  return [internal, sized[internal]];
}
