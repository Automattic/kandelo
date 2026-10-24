/**
 * Synchronous GL query handler invoked by `host_gl_query`.
 *
 * Sync queries can't ride the cmdbuf — `glGetError`, `glGetUniformLocation`,
 * etc. need a reply *now*. The C side issues `ioctl(GLIO_QUERY)` with
 * `(op, in, out)` buffers; the kernel forwards the call to
 * `HostIO::gl_query`, which lands here.
 *
 * Returns the number of bytes written to `out`, or a negative errno-ish
 * value: `-EPERM` (-1) when the binding has no live context, `-EINVAL`
 * (-22) for an unknown query op.
 *
 * Uniform locations: WebGL hands back opaque `WebGLUniformLocation`
 * objects; the cmdbuf needs an integer. We allocate monotonic indices
 * via `++b.nextUniformLoc` (audit finding #12 — Map.size shrinks on
 * delete and would collide). Indices are number-keyed for clean u32
 * round-tripping.
 */
import { runUniformLookup, uniformLocation } from "./uniform-queries.js";
import { checkedQueryReply, runStateQuery } from "./state-query.js";
import { runObjectQuery } from "./object-query.js";
import { runShaderSourceUpload } from "./shader-source.js";
import { canonicalBuffer } from "./buffer-storage.js";
import type { GlBinding } from "./registry.js";
import * as O from "./ops.js";
import { getGlesExtensionString } from "./capabilities.js";
import { checkedGlCall, currentProgramName, recordGlError } from "./program-objects.js";
import { captureNativeGlErrors } from "./errors.js";
import { boundFramebuffer, isDefaultFramebuffer, validFramebufferTarget, GL_FRAMEBUFFER_UNDEFINED } from "./framebuffer.js";

const GL_VENDOR = 0x1F00;
const GL_RENDERER = 0x1F01;
const GL_VERSION = 0x1F02;
const GL_EXTENSIONS = 0x1F03;
const GL_VIEWPORT = 0x0BA2;
const GL_SCISSOR_BOX = 0x0C10;
const GL_SHADING_LANGUAGE_VERSION = 0x8B8C;
const GL_CURRENT_PROGRAM = 0x8B8D;
const GL_ACTIVE_UNIFORMS = 0x8B86;
const GL_ACTIVE_UNIFORM_MAX_LENGTH = 0x8B87;
const GL_INFO_LOG_LENGTH = 0x8B84;
const GL_UNSIGNED_SHORT = 0x1403;
const GL_UNSIGNED_INT = 0x1405;
const GL_FLOAT = 0x1406;
const GL_HALF_FLOAT = 0x140B;
const GL_HALF_FLOAT_OES = 0x8D61;
const GL_UNSIGNED_SHORT_4_4_4_4 = 0x8033;
const GL_UNSIGNED_SHORT_5_5_5_1 = 0x8034;
const GL_UNSIGNED_SHORT_5_6_5 = 0x8363;
const GL_UNSIGNED_INT_2_10_10_10_REV = 0x8368;
const GL_UNSIGNED_INT_24_8 = 0x84FA;
const GL_UNSIGNED_INT_10F_11F_11F_REV = 0x8C3B;

function normalizeHalfFloatType(type: number): number {
  return type === GL_HALF_FLOAT_OES ? GL_HALF_FLOAT : type;
}

function alignedFloat32View(out: Uint8Array): Float32Array {
  if (out.byteOffset % 4 === 0) {
    return new Float32Array(out.buffer, out.byteOffset, (out.byteLength / 4) | 0);
  }
  return new Float32Array((out.byteLength / 4) | 0);
}

function alignedUint32View(out: Uint8Array): Uint32Array {
  if (out.byteOffset % 4 === 0) {
    return new Uint32Array(out.buffer, out.byteOffset, (out.byteLength / 4) | 0);
  }
  return new Uint32Array((out.byteLength / 4) | 0);
}

function alignedUint16View(out: Uint8Array): Uint16Array {
  if (out.byteOffset % 2 === 0) {
    return new Uint16Array(out.buffer, out.byteOffset, (out.byteLength / 2) | 0);
  }
  return new Uint16Array((out.byteLength / 2) | 0);
}

function readPixelsViewForType(type: number, out: Uint8Array): ArrayBufferView {
  switch (type) {
    case GL_FLOAT:
      return alignedFloat32View(out);
    case GL_UNSIGNED_SHORT:
    case GL_HALF_FLOAT:
    case GL_HALF_FLOAT_OES:
    case GL_UNSIGNED_SHORT_4_4_4_4:
    case GL_UNSIGNED_SHORT_5_5_5_1:
    case GL_UNSIGNED_SHORT_5_6_5:
      return alignedUint16View(out);
    case GL_UNSIGNED_INT:
    case GL_UNSIGNED_INT_2_10_10_10_REV:
    case GL_UNSIGNED_INT_24_8:
    case GL_UNSIGNED_INT_10F_11F_11F_REV:
      return alignedUint32View(out);
    default:
      return out;
  }
}

function copyReadPixelsResult(view: ArrayBufferView, out: Uint8Array): void {
  if (view.buffer === out.buffer && view.byteOffset === out.byteOffset) return;
  const bytes = new Uint8Array(view.buffer, view.byteOffset, Math.min(view.byteLength, out.byteLength));
  out.set(bytes);
}

export function runGlQuery(
  b: GlBinding,
  op: number,
  input: Uint8Array,
  out: Uint8Array,
): number {
  if (!b.gl) return -1;
  const gl = b.gl;
  if (op === O.QOP_LOOKUP_UNIFORM) return runUniformLookup(b,input,out);
  if (op === O.QOP_SHADER_SOURCE_UPLOAD) return runShaderSourceUpload(b,input,out);
  const inDv = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const outDv = new DataView(out.buffer, out.byteOffset, out.byteLength);

  const state = runStateQuery(b,op,input,out);
  if (state !== undefined) return state;
  const object = runObjectQuery(b,op,input,out);
  if (object !== undefined) return object;

  switch (op) {
    case O.QOP_GET_ERROR:
      if (out.byteLength < 4) return -22;
      captureNativeGlErrors(gl, b);
      outDv.setUint32(0, b.errors.shift() ?? 0, true);
      return 4;

    // in: u32 name, optional u32 opVersion for extensions;
    // out: u32 strLen, u8 str[strLen]. Version 1 keeps its empty list.
    case O.QOP_GET_STRING: {
      if (input.byteLength < 4) return -22;
      const name = inDv.getUint32(0, true);
      const version = input.byteLength >= 8 ? inDv.getUint32(4, true) : 1;
      if (name === GL_EXTENSIONS && (version < 1 || version > O.OP_VERSION)) return -22;
      const s = name === GL_EXTENSIONS
        ? (version >= 2 ? getGlesExtensionString(gl) : "")
        : (gl.getParameter(name) as string | null) ?? "";
      const bytes = new TextEncoder().encode(s);
      const need = 4 + bytes.byteLength;
      if (out.byteLength < need) return -22;
      outDv.setUint32(0, bytes.byteLength, true);
      out.set(bytes, 4);
      return need;
    }

    // in: u32 pname; out: i32 value(s)
    case O.QOP_GET_INTEGERV: {
      if (input.byteLength < 4 || out.byteLength < 4) return -22;
      const pname = inDv.getUint32(0, true);
      if (pname === GL_VIEWPORT) {
        return writeNumericValues(outDv, out.byteLength, b.shadow.viewport, false, pname);
      }
      if (pname === GL_SCISSOR_BOX) {
        return writeNumericValues(outDv, out.byteLength, b.shadow.scissor.rect, false, pname);
      }
      let value: unknown;
      if (!checkedGlCall(b, () => { value = queryParameter(b, pname); })) return -22;
      return writeNumericValues(outDv, out.byteLength, value, false, pname);
    }

    // in: u32 pname; out: f32 value(s)
    case O.QOP_GET_FLOATV: {
      if (input.byteLength < 4 || out.byteLength < 4) return -22;
      const pname = inDv.getUint32(0, true);
      if (pname === GL_VIEWPORT) {
        return writeNumericValues(outDv, out.byteLength, b.shadow.viewport, true, pname);
      }
      if (pname === GL_SCISSOR_BOX) {
        return writeNumericValues(outDv, out.byteLength, b.shadow.scissor.rect, true, pname);
      }
      let value: unknown;
      if (!checkedGlCall(b, () => { value = queryParameter(b, pname); })) return -22;
      return writeNumericValues(outDv, out.byteLength, value, true, pname);
    }

    // in: u32 program, u32 nameLen, u8 name[nameLen]; out: i32 location-index
    case O.QOP_GET_UNIFORM_LOC: {
      if (input.byteLength < 8 || out.byteLength < 4) return -22;
      const programName = inDv.getUint32(0, true);
      const nameLen = inDv.getUint32(4, true);
      if (input.byteLength < 8 + nameLen) return -22;
      const text = new TextDecoder().decode(new Uint8Array(input.subarray(8,8+nameLen)));
      const location = uniformLocation(b,programName,text);
      if (location === null) return -22;
      outDv.setInt32(0,location,true);
      return 4;
    }

    // in: u32 program, u32 nameLen, u8 name[nameLen]; out: i32 attrib-index
    case O.QOP_GET_ATTRIB_LOC: {
      if (input.byteLength < 8 || out.byteLength < 4) return -22;
      const programName = inDv.getUint32(0, true);
      const nameLen = inDv.getUint32(4, true);
      if (input.byteLength < 8 + nameLen) return -22;
      const program = b.programs.get(programName);
      const attrName = new TextDecoder().decode(input.subarray(8, 8 + nameLen));
      const loc = program ? gl.getAttribLocation(program, attrName) : -1;
      outDv.setInt32(0, loc, true);
      return 4;
    }

    // in: u32 shaderName, u32 pname; out: i32 value
    case O.QOP_GET_SHADERIV: {
      if (input.byteLength < 8 || out.byteLength < 4) return -22;
      const sh = b.shaders.get(inDv.getUint32(0, true));
      if (!sh) {
        outDv.setInt32(0, 0, true);
        return 4;
      }
      const pname = inDv.getUint32(4, true);
      const sourceLength = b.shaderSources.get(sh)?.length ?? 0;
      const v = pname === 0x8b80 ? b.shaderDeletePending.has(inDv.getUint32(0, true))
        : pname === 0x8b88 ? (sourceLength ? sourceLength+1 : 0)
        : pname === GL_INFO_LOG_LENGTH
        ? ((gl.getShaderInfoLog(sh) ?? "").length + 1)
        : gl.getShaderParameter(sh, pname);
      outDv.setInt32(0, typeof v === "boolean" ? (v ? 1 : 0) : Number(v ?? 0), true);
      return 4;
    }

    // in: u32 shaderName; out: u32 strLen, u8 str[strLen]
    case O.QOP_GET_SHADER_INFO_LOG: {
      if (input.byteLength < 4) return -22;
      const sh = b.shaders.get(inDv.getUint32(0, true));
      const log = (sh && gl.getShaderInfoLog(sh)) ?? "";
      const bytes = new TextEncoder().encode(log);
      const need = 4 + bytes.byteLength;
      if (out.byteLength < need) {
        outDv.setUint32(0, 0, true);
        return 4;
      }
      outDv.setUint32(0, bytes.byteLength, true);
      out.set(bytes, 4);
      return need;
    }

    // in: u32 programName, u32 pname; out: i32 value
    case O.QOP_GET_PROGRAMIV: {
      if (input.byteLength < 8 || out.byteLength < 4) return -22;
      const prog = b.programs.get(inDv.getUint32(0, true));
      if (!prog) {
        outDv.setInt32(0, 0, true);
        return 4;
      }
      const pname = inDv.getUint32(4, true);
      let v: unknown;
      if (pname === 0x8b80) {
        v = b.programDeletePending.has(inDv.getUint32(0, true));
      } else if (pname === GL_INFO_LOG_LENGTH) {
        v = (gl.getProgramInfoLog(prog) ?? "").length + 1;
      } else if (pname === GL_ACTIVE_UNIFORM_MAX_LENGTH || pname === 0x8b8a) {
        const attributes = pname === 0x8b8a;
        const n = Number(gl.getProgramParameter(prog, attributes ? 0x8b89 : GL_ACTIVE_UNIFORMS) ?? 0);
        let max = 0;
        for (let i = 0; i < n; i++) {
          const info = attributes ? gl.getActiveAttrib(prog, i) : gl.getActiveUniform(prog, i);
          if (info) max = Math.max(max, info.name.length + 1);
        }
        v = max;
      } else {
        v = gl.getProgramParameter(prog, pname);
      }
      outDv.setInt32(0, typeof v === "boolean" ? (v ? 1 : 0) : Number(v ?? 0), true);
      return 4;
    }

    // in: u32 programName; out: u32 strLen, u8 str[strLen]
    case O.QOP_GET_PROGRAM_INFO_LOG: {
      if (input.byteLength < 4) return -22;
      const prog = b.programs.get(inDv.getUint32(0, true));
      const log = (prog && gl.getProgramInfoLog(prog)) ?? "";
      const bytes = new TextEncoder().encode(log);
      const need = 4 + bytes.byteLength;
      if (out.byteLength < need) {
        outDv.setUint32(0, 0, true);
        return 4;
      }
      outDv.setUint32(0, bytes.byteLength, true);
      out.set(bytes, 4);
      return need;
    }

    // in: i32 x, i32 y, i32 w, i32 h, u32 format, u32 type; out: u8 pixels[...]
    case O.QOP_READ_PIXELS: {
      if (input.byteLength < 24) return -22;
      const x = inDv.getInt32(0, true);
      const y = inDv.getInt32(4, true);
      const w = inDv.getInt32(8, true);
      const h = inDv.getInt32(12, true);
      const format = inDv.getUint32(16, true);
      const type = normalizeHalfFloatType(inDv.getUint32(20, true));
      // WebGL2 readPixels requires the destination view to match `type`.
      const view = readPixelsViewForType(type, out);
      if (!checkedGlCall(b, () => { gl.readPixels(x, y, w, h, format, type, view); })) return -22;
      copyReadPixelsResult(view, out);
      // gl.readPixels writes into `out` directly. Bytes-written depends
      // on (format,type,w,h); the kernel cap (`MAX_QUERY_OUT_LEN`) is
      // the upper bound. Return the full out length — the C side knows
      // the geometry.
      return out.byteLength;
    }

    // in: u32 shadertype, u32 precisiontype; out: i32 rangeMin, i32 rangeMax,
    // i32 precision
    case O.QOP_GET_SHADER_PRECISION_FORMAT: {
      if (input.byteLength < 8 || out.byteLength < 12) return -22;
      const fmt = gl.getShaderPrecisionFormat(
        inDv.getUint32(0, true),
        inDv.getUint32(4, true),
      );
      outDv.setInt32(0, fmt?.rangeMin ?? 0, true);
      outDv.setInt32(4, fmt?.rangeMax ?? 0, true);
      outDv.setInt32(8, fmt?.precision ?? 0, true);
      return 12;
    }

    // glFinish. The query is answered after the host has decoded every
    // earlier command, so finishing the context here completes them all.
    case O.QOP_FINISH:
      gl.finish();
      return 0;

    // in: u32 target; out: u32 status
    case O.QOP_CHECK_FB_STATUS: {
      if (input.byteLength < 4 || out.byteLength < 4) return -22;
      const target = inDv.getUint32(0, true);
      const surface = target === 0x8ca8 ? b.currentDrawable?.readSurfaceId : b.currentDrawable?.drawSurfaceId;
      const status = validFramebufferTarget(target) && surface === 0 && isDefaultFramebuffer(b, boundFramebuffer(b, target))
        ? GL_FRAMEBUFFER_UNDEFINED : gl.checkFramebufferStatus(target);
      outDv.setUint32(0, status, true);
      return 4;
    }

    // in: u32 programName, u32 uniformIndex, u32 nameCapacity;
    // out: u32 nameLen, i32 size, u32 type, u8 name[nameLen]
    case O.QOP_GET_ACTIVE_UNIFORM: {
      if (input.byteLength < 12 || out.byteLength < 12) return -22;
      const prog = b.programs.get(inDv.getUint32(0, true));
      const index = inDv.getUint32(4, true);
      const cap = inDv.getUint32(8, true);
      const info = prog ? gl.getActiveUniform(prog, index) : null;
      if (!info) {
        outDv.setUint32(0, 0, true);
        outDv.setInt32(4, 0, true);
        outDv.setUint32(8, 0, true);
        return 12;
      }
      const nameBytes = new TextEncoder().encode(info.name);
      const nameLen = Math.min(nameBytes.byteLength, cap, out.byteLength - 12);
      outDv.setUint32(0, nameLen, true);
      outDv.setInt32(4, info.size, true);
      outDv.setUint32(8, info.type, true);
      out.set(nameBytes.subarray(0, nameLen), 12);
      return 12 + nameLen;
    }

    // V7: one checked reply contains the width and values of one element.
    // Program/location ownership lives in the shared group, not a C cache.
    case O.QOP_GET_UNIFORM_VALUES: {
      if (input.length !== 12 || out.length < 76) return -22;
      const name = inDv.getUint32(0,true), index = inDv.getInt32(4,true), integer = inDv.getUint32(8,true);
      if (integer > 1) return -22;
      return checkedQueryReply(b,out,68,payload => {
        const fail = (error: number) => { recordGlError(b,error); return -22; };
        const program = b.programs.get(name);
        if (!program) return fail(b.shaders.has(name) ? 0x502 : 0x501);
        const location = b.uniformLocations.get(index);
        if (!location || b.uniformLocationPrograms.get(index) !== name) return fail(0x502);
        let linked = false, value: unknown;
        if (!checkedGlCall(b,() => { linked = !!gl.getProgramParameter(program,0x8b82); })) return -5;
        if (!linked) return fail(0x502);
        if (!checkedGlCall(b,() => { value = gl.getUniform(program,location); })) return -5;
        if (value == null || !(typeof value === "number" || typeof value === "boolean" || Array.isArray(value) || ArrayBuffer.isView(value))) return fail(0x502);
        const values = normalizeNumericValues(value,0);
        if (![1,2,3,4,9,16].includes(values.length)) return fail(0x502);
        const result = new DataView(payload.buffer);
        result.setUint32(0,values.length,true);
        for (let i=0;i<values.length;i++) {
          if (integer) result.setInt32(4+i*4,integerQueryValue(values[i],0),true);
          else result.setFloat32(4+i*4,values[i],true);
        }
        return payload.length;
      });
    }

    // in: u32 programName, i32 locationIndex; out: f32 values[]
    case O.QOP_GET_UNIFORMFV:
    case O.QOP_GET_UNIFORMIV: {
      if (input.byteLength < 8 || out.byteLength < 4) return -22;
      const prog = b.programs.get(inDv.getUint32(0, true));
      const loc = b.uniformLocations.get(inDv.getInt32(4, true)) ?? null;
      const value = prog && loc ? gl.getUniform(prog, loc) : null;
      return writeNumericValues(outDv, out.byteLength, value, op === O.QOP_GET_UNIFORMFV, 0);
    }

    default:
      return -22;
  }
}

function nameForObject<T>(objects: Map<number, T>, object: T | null): number {
  if (!object) return 0;
  for (const [name, candidate] of objects) {
    if (candidate === object) return name;
  }
  return 0;
}

/** Native objects never cross the GLES numeric query protocol. Name zero
 * includes host-owned default-FBO redirects absent from the guest map. */
function queryParameter(b: GlBinding, pname: number): unknown {
  if (pname === GL_CURRENT_PROGRAM) return currentProgramName(b);
  // WebGL exposes source compilation and its compressed-format vector, but
  // does not expose GLES's binary-compiler and vector-count query enums.
  if (pname === 0x8df8) return []; // SHADER_BINARY_FORMATS: no binary loader
  if (pname === 0x8df9) return 0; // NUM_SHADER_BINARY_FORMATS
  if (pname === 0x8dfa) return true; // SHADER_COMPILER
  if (pname === 0x86a2) { // NUM_COMPRESSED_TEXTURE_FORMATS
    return (b.gl!.getParameter(0x86a3) as Uint32Array).length;
  }
  const value = b.gl!.getParameter(pname);
  switch (pname) {
    case 0x8894: // ARRAY_BUFFER_BINDING
    case 0x8895: // ELEMENT_ARRAY_BUFFER_BINDING (VAO-local)
      return value ? nameForObject(b.buffers, canonicalBuffer(b,value as WebGLBuffer))
        || b.retiredBuffers.get(canonicalBuffer(b,value as WebGLBuffer)) || 0 : 0;
    case 0x8069: // TEXTURE_BINDING_2D
    case 0x8514: // TEXTURE_BINDING_CUBE_MAP
      return nameForObject(b.textures, value as WebGLTexture | null)
        || b.retiredTextures.get(value as WebGLTexture) || 0;
    case 0x8ca6: // FRAMEBUFFER_BINDING
    case 0x8caa: // READ_FRAMEBUFFER_BINDING
      return nameForObject(b.fbos, value as WebGLFramebuffer | null);
    case 0x8ca7: // RENDERBUFFER_BINDING
      return nameForObject(b.rbos, value as WebGLRenderbuffer | null)
        || b.retiredRenderbuffers.get(value as WebGLRenderbuffer) || 0;
    default: return value;
  }
}

function writeLengthPrefixedString(
  out: Uint8Array,
  outDv: DataView,
  value: string,
): number {
  const bytes = new TextEncoder().encode(value);
  const need = 4 + bytes.byteLength;
  if (out.byteLength < need) return -22;
  outDv.setUint32(0, bytes.byteLength, true);
  out.set(bytes, 4);
  return need;
}

function writeNumericValues(
  outDv: DataView,
  outLen: number,
  value: unknown,
  asFloat: boolean,
  pname: number,
): number {
  const values = normalizeNumericValues(value, pname);
  const count = values.length;
  if (count > Math.floor(outLen / 4)) return -22;
  for (let i = 0; i < count; i++) {
    if (asFloat) outDv.setFloat32(i * 4, values[i], true);
    else outDv.setInt32(i * 4, integerQueryValue(values[i], pname), true);
  }
  return count * 4;
}

// GLES2 section 6.1.2: floating state rounds to nearest, while normalized
// color/depth state uses the signed INT conversion in table 4.4. Integer
// names, enums and masks retain their 32-bit representation. In particular,
// an all-ones stencil mask must not be mistaken for a large floating value.
const normalizedQueryState = new Set([0x0c22, 0x8005, 0x0b70, 0x0b73]);
const floatingQueryState = new Set([
  0x0b21, 0x846d, 0x846e, 0x8038, 0x2a00, 0x80aa,
]);

function integerQueryValue(value: number, pname: number): number {
  if (normalizedQueryState.has(pname)) {
    return Math.trunc((Math.min(1, Math.max(-1, value)) * 0xffffffff - 1) / 2);
  }
  // pname zero denotes a uniform result, rather than ordinary Get state.
  if (pname === 0 || floatingQueryState.has(pname)) {
    return Math.min(0x7fffffff, Math.max(-0x80000000, Math.round(value)));
  }
  return value | 0;
}

function normalizeNumericValues(value: unknown, pname: number): number[] {
  if (value == null) {
    if (pname === GL_VIEWPORT || pname === GL_SCISSOR_BOX) return [0, 0, 0, 0];
    return [0];
  }
  if (typeof value === "boolean") return [value ? 1 : 0];
  if (typeof value === "number") return [value];
  if (Array.isArray(value)) return value.map(Number);
  if (ArrayBuffer.isView(value)) return Array.from(value as ArrayLike<number>, Number);
  return [Number(value) || 0];
}
