/**
 * Cmdbuf TLV walker + per-op dispatch.
 *
 * The kernel forwards a `(pid, offset, length)` triple via
 * `host_gl_submit`. Bytes live in the process's wasm Memory SAB,
 * already viewed through `GlBinding.cmdbufView`. Each entry is a TLV
 * `{u16 op, u16 payload_len, payload[payload_len]}` little-endian; we
 * walk the run, lookup the op, decode its payload, and call the matching
 * `WebGL2RenderingContext` method.
 *
 * Cmdbuf-side u32 names round-trip through `GlBinding.{buffers,
 * textures, shaders, programs, vaos, fbos, rbos}` maps. The C side
 * (Phase C `libGLESv2_stub.c`) picks names itself with a monotonic
 * counter; OP_GEN_BUFFERS / OP_CREATE_SHADER / etc. tell the host
 * which name to allocate.
 *
 * Unknown or malformed opcodes are rejected as guest input. The bridge
 * returns a negative errno so `GLIO_SUBMIT` can fail like any other
 * ioctl-style device operation instead of hiding the failure in host code.
 */
import type { GlBinding, GlVertexAttribPointer } from "./registry.js";
import * as O from "./ops.js";
import {
  GL_BACK,
  GL_FRONT,
  GL_FRONT_AND_BACK,
  setCap,
  type GlStencilFaceState,
  GL_PACK_ALIGNMENT,
  GL_READ_FRAMEBUFFER,
  GL_TEXTURE0,
  GL_UNPACK_ALIGNMENT,
} from "./shadow.js";

export const GL_SUBMIT_OK = 0;
export const GL_SUBMIT_EIO = -5;
export const GL_SUBMIT_EINVAL = -22;

const GL_ARRAY_BUFFER = 0x8892;
const GL_ELEMENT_ARRAY_BUFFER = 0x8893;
const GL_STREAM_DRAW = 0x88E0;
const GL_BYTE = 0x1400;
const GL_UNSIGNED_BYTE = 0x1401;
const GL_SHORT = 0x1402;
const GL_UNSIGNED_SHORT = 0x1403;
const GL_INT = 0x1404;
const GL_UNSIGNED_INT = 0x1405;
const GL_FLOAT = 0x1406;
const GL_HALF_FLOAT = 0x140B;
const GL_FIXED = 0x140C;
const GL_INT_2_10_10_10_REV = 0x8D9F;
const GL_UNSIGNED_INT_2_10_10_10_REV = 0x8368;

function updateStencilFaces(
  shadow: GlBinding["shadow"],
  face: number,
  update: (state: GlStencilFaceState) => void,
): void {
  if (face === GL_FRONT || face === GL_FRONT_AND_BACK) update(shadow.stencil.front);
  if (face === GL_BACK || face === GL_FRONT_AND_BACK) update(shadow.stencil.back);
}

let glBridgeFailureLogs = 0;
function logGlBridgeFailure(phase: string, op: number, err: unknown): void {
  if (glBridgeFailureLogs >= 20) return;
  glBridgeFailureLogs += 1;
  const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  console.warn(`[webgl] ${phase} failed op=0x${op.toString(16)} ${detail}`);
}

export function decodeAndDispatch(
  b: GlBinding,
  offset: number,
  length: number,
): number {
  if (!b.cmdbufView || !b.gl) return GL_SUBMIT_OK;
  return walkCommandBuffer(b.cmdbufView, offset, length, (payload, op) => {
    try {
      dispatch(b.gl!, b, payload, 0, op);
      return GL_SUBMIT_OK;
    } catch (err) {
      logGlBridgeFailure("submit", op, err);
      return GL_SUBMIT_EIO;
    }
  });
}

export function validateCommandBuffer(
  buf: Uint8Array,
  offset: number,
  length: number,
): number {
  return walkCommandBuffer(buf, offset, length, () => GL_SUBMIT_OK);
}

function walkCommandBuffer(
  buf: Uint8Array,
  offset: number,
  length: number,
  visit: (payload: DataView, op: number) => number,
): number {
  if (!isSafeSpan(offset, length, buf.byteLength)) return GL_SUBMIT_EINVAL;
  const view = new DataView(buf.buffer, buf.byteOffset + offset, length);
  let p = 0;
  while (p < length) {
    if (length - p < 4) return GL_SUBMIT_EINVAL;
    const op = view.getUint16(p, true);
    const payloadLen = view.getUint16(p + 2, true);
    const payloadStart = p + 4;
    const payloadEnd = payloadStart + payloadLen;
    if (payloadEnd > length) return GL_SUBMIT_EINVAL;
    const payload = new DataView(
      view.buffer,
      view.byteOffset + payloadStart,
      payloadLen,
    );
    if (!validPayload(op, payload)) {
      logGlBridgeFailure(
        "invalid-payload",
        op,
        `payloadLen=${payloadLen} commandOffset=${p}`,
      );
      return GL_SUBMIT_EINVAL;
    }
    const rc = visit(payload, op);
    if (rc !== GL_SUBMIT_OK) return rc;
    p = payloadEnd;
  }
  return GL_SUBMIT_OK;
}

function isSafeSpan(offset: number, length: number, limit: number): boolean {
  return Number.isSafeInteger(offset)
    && Number.isSafeInteger(length)
    && offset >= 0
    && length >= 0
    && offset <= limit
    && length <= limit - offset;
}

function exact(v: DataView, len: number): boolean {
  return v.byteLength === len;
}

function u32ArrayPayload(v: DataView): boolean {
  if (v.byteLength < 4) return false;
  const n = v.getUint32(0, true);
  return v.byteLength === 4 + n * 4;
}

function tailBytesPayload(v: DataView, headerLen: number, lenOffset: number): boolean {
  if (v.byteLength < lenOffset + 4) return false;
  const dataLen = v.getUint32(lenOffset, true);
  return v.byteLength === headerLen + dataLen;
}

function bufferDataPayload(v: DataView): boolean {
  if (v.byteLength < 12) return false;
  const byteLength = v.getUint32(4, true);
  return v.byteLength === 12 || v.byteLength === 12 + byteLength;
}

function countedFloatPayload(
  v: DataView,
  headerLen: number,
  countOffset: number,
  floatsPerCount: number,
): boolean {
  if (v.byteLength < countOffset + 4) return false;
  const count = v.getUint32(countOffset, true);
  return v.byteLength === headerLen + count * floatsPerCount * 4;
}

function countedIntPayload(
  v: DataView,
  headerLen: number,
  countOffset: number,
  intsPerCount: number,
): boolean {
  if (v.byteLength < countOffset + 4) return false;
  const count = v.getUint32(countOffset, true);
  return v.byteLength === headerLen + count * intsPerCount * 4;
}

function copyBytes(v: DataView, offset: number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  out.set(new Uint8Array(v.buffer, v.byteOffset + offset, length));
  return out;
}

function copyFloat32Array(v: DataView, offset: number, count: number): Float32Array {
  const bytes = copyBytes(v, offset, count * 4);
  return new Float32Array(bytes.buffer, bytes.byteOffset, count);
}

function copyInt32Array(v: DataView, offset: number, count: number): Int32Array {
  const bytes = copyBytes(v, offset, count * 4);
  return new Int32Array(bytes.buffer, bytes.byteOffset, count);
}

function checkedGuestBytes(b: GlBinding, addr: number, length: number): Uint8Array {
  if (!b.memoryView) {
    throw new Error("native GLES client arrays require a process memory view");
  }
  if (!Number.isSafeInteger(addr) || !Number.isSafeInteger(length)
      || addr < 0 || length < 0 || addr > b.memoryView.byteLength
      || length > b.memoryView.byteLength - addr) {
    throw new Error(`native GLES client array span is out of range addr=${addr} len=${length}`);
  }
  return b.memoryView.slice(addr, addr + length);
}

function attribComponentBytes(type: number): number {
  switch (type) {
    case GL_BYTE:
    case GL_UNSIGNED_BYTE:
      return 1;
    case GL_SHORT:
    case GL_UNSIGNED_SHORT:
    case GL_HALF_FLOAT:
      return 2;
    case GL_INT:
    case GL_UNSIGNED_INT:
    case GL_FLOAT:
    case GL_FIXED:
    case GL_INT_2_10_10_10_REV:
    case GL_UNSIGNED_INT_2_10_10_10_REV:
      return 4;
    default:
      throw new Error(`unsupported native GLES vertex attribute type 0x${type.toString(16)}`);
  }
}

function indexComponentBytes(type: number): number {
  switch (type) {
    case GL_UNSIGNED_BYTE:
      return 1;
    case GL_UNSIGNED_SHORT:
      return 2;
    case GL_UNSIGNED_INT:
      return 4;
    default:
      throw new Error(`unsupported native GLES index type 0x${type.toString(16)}`);
  }
}

function effectiveAttribStride(a: GlVertexAttribPointer): number {
  return a.stride === 0 ? a.size * attribComponentBytes(a.type) : a.stride;
}

function attribElementBytes(a: GlVertexAttribPointer): number {
  if (a.type === GL_INT_2_10_10_10_REV || a.type === GL_UNSIGNED_INT_2_10_10_10_REV) {
    return 4;
  }
  return a.size * attribComponentBytes(a.type);
}

function hasClientVertexAttribs(b: GlBinding): boolean {
  for (const index of b.enabledVertexAttribs) {
    const attrib = b.vertexAttribPointers.get(index);
    if (attrib && attrib.buffer === null) return true;
  }
  return false;
}

function uploadClientVertexAttribs(b: GlBinding, maxVertexIndex: number): void {
  const gl = b.gl;
  if (!gl || maxVertexIndex < 0) return;

  for (const index of b.enabledVertexAttribs) {
    const attrib = b.vertexAttribPointers.get(index);
    if (!attrib || attrib.buffer !== null) continue;

    const stride = effectiveAttribStride(attrib);
    const elementBytes = attribElementBytes(attrib);
    const byteLength = maxVertexIndex * stride + elementBytes;
    const data = checkedGuestBytes(b, attrib.offset, byteLength);

    let buffer = b.clientVertexBuffers.get(index);
    if (!buffer) {
      buffer = gl.createBuffer();
      if (!buffer) throw new Error("WebGL failed to create a client vertex buffer");
      b.clientVertexBuffers.set(index, buffer);
    }

    gl.bindBuffer(GL_ARRAY_BUFFER, buffer);
    gl.bufferData(GL_ARRAY_BUFFER, data, GL_STREAM_DRAW);
    gl.vertexAttribPointer(
      index,
      attrib.size,
      attrib.type,
      attrib.normalized,
      attrib.stride,
      0,
    );
  }

  gl.bindBuffer(GL_ARRAY_BUFFER, b.boundArrayBuffer);
}

function maxClientElementIndex(data: Uint8Array, type: number, count: number): number {
  if (count <= 0) return -1;
  if (type === GL_UNSIGNED_BYTE) {
    let max = 0;
    for (let i = 0; i < count; i++) max = Math.max(max, data[i]);
    return max;
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let max = 0;
  if (type === GL_UNSIGNED_SHORT) {
    for (let i = 0; i < count; i++) max = Math.max(max, view.getUint16(i * 2, true));
    return max;
  }
  if (type === GL_UNSIGNED_INT) {
    for (let i = 0; i < count; i++) max = Math.max(max, view.getUint32(i * 4, true));
    return max;
  }
  throw new Error(`unsupported native GLES index type 0x${type.toString(16)}`);
}

function bindClientElementBuffer(
  b: GlBinding,
  indicesAddr: number,
  type: number,
  count: number,
): { drawOffset: number; maxVertexIndex: number; restoreElementBuffer: WebGLBuffer | null } {
  const gl = b.gl;
  if (!gl) return { drawOffset: indicesAddr, maxVertexIndex: -1, restoreElementBuffer: null };

  const byteLength = count * indexComponentBytes(type);
  const data = checkedGuestBytes(b, indicesAddr, byteLength);
  let buffer = b.clientElementArrayBuffer;
  if (!buffer) {
    buffer = gl.createBuffer();
    if (!buffer) throw new Error("WebGL failed to create a client element buffer");
    b.clientElementArrayBuffer = buffer;
  }

  const restoreElementBuffer = b.boundElementArrayBuffer;
  gl.bindBuffer(GL_ELEMENT_ARRAY_BUFFER, buffer);
  gl.bufferData(GL_ELEMENT_ARRAY_BUFFER, data, GL_STREAM_DRAW);
  return {
    drawOffset: 0,
    maxVertexIndex: maxClientElementIndex(data, type, count),
    restoreElementBuffer,
  };
}

function validPayload(op: number, v: DataView): boolean {
  switch (op) {
    case O.OP_CLEAR:
    case O.OP_ENABLE:
    case O.OP_DISABLE:
    case O.OP_DEPTH_FUNC:
    case O.OP_CULL_FACE:
    case O.OP_FRONT_FACE:
    case O.OP_LINE_WIDTH:
    case O.OP_ACTIVE_TEXTURE:
    case O.OP_GENERATE_MIPMAP:
    case O.OP_COMPILE_SHADER:
    case O.OP_DELETE_SHADER:
    case O.OP_CREATE_PROGRAM:
    case O.OP_LINK_PROGRAM:
    case O.OP_USE_PROGRAM:
    case O.OP_DELETE_PROGRAM:
    case O.OP_ENABLE_VERTEX_ATTRIB_ARRAY:
    case O.OP_DISABLE_VERTEX_ATTRIB_ARRAY:
    case O.OP_BIND_VERTEX_ARRAY:
    case O.OP_DRAW_BUFFER:
    case O.OP_READ_BUFFER:
    case O.OP_BLEND_EQUATION:
    case O.OP_CLEAR_DEPTHF:
    case O.OP_CLEAR_STENCIL:
    case O.OP_DEPTH_MASK:
    case O.OP_STENCIL_MASK:
      return exact(v, 4);

    case O.OP_BLEND_FUNC:
    case O.OP_PIXEL_STOREI:
    case O.OP_BIND_BUFFER:
    case O.OP_BIND_TEXTURE:
    case O.OP_CREATE_SHADER:
    case O.OP_ATTACH_SHADER:
    case O.OP_UNIFORM1I:
    case O.OP_UNIFORM1F:
    case O.OP_BIND_FRAMEBUFFER:
    case O.OP_BIND_RENDERBUFFER:
    case O.OP_BLEND_EQUATION_SEPARATE:
    case O.OP_STENCIL_MASK_SEPARATE:
    case O.OP_DEPTH_RANGEF:
    case O.OP_SAMPLE_COVERAGE:
      return exact(v, 8);

    case O.OP_TEX_PARAMETERI:
    case O.OP_TEX_PARAMETERF:
    case O.OP_UNIFORM2F:
    case O.OP_DRAW_ARRAYS:
    case O.OP_STENCIL_FUNC:
    case O.OP_STENCIL_OP:
      return exact(v, 12);

    case O.OP_STENCIL_FUNC_SEPARATE:
    case O.OP_STENCIL_OP_SEPARATE:
    case O.OP_CLEAR_COLOR:
    case O.OP_VIEWPORT:
    case O.OP_SCISSOR:
    case O.OP_UNIFORM3F:
    case O.OP_DRAW_ELEMENTS:
    case O.OP_RENDERBUFFER_STORAGE:
    case O.OP_FRAMEBUFFER_RENDERBUFFER:
    case O.OP_BLEND_COLOR:
    case O.OP_BLEND_FUNC_SEPARATE:
    case O.OP_COLOR_MASK:
      return exact(v, 16);

    case O.OP_POLYGON_OFFSET:
      return exact(v, 8);

    case O.OP_UNIFORM4F:
    case O.OP_FRAMEBUFFER_TEXTURE_2D:
    case O.OP_VERTEX_ATTRIB4F:
      return exact(v, 20);

    case O.OP_VERTEX_ATTRIB_POINTER:
      return exact(v, 24);

    case O.OP_GEN_BUFFERS:
    case O.OP_DELETE_BUFFERS:
    case O.OP_GEN_TEXTURES:
    case O.OP_DELETE_TEXTURES:
    case O.OP_GEN_VERTEX_ARRAYS:
    case O.OP_DELETE_VERTEX_ARRAYS:
    case O.OP_GEN_FRAMEBUFFERS:
    case O.OP_GEN_RENDERBUFFERS:
    case O.OP_DELETE_FRAMEBUFFERS:
    case O.OP_DELETE_RENDERBUFFERS:
      return u32ArrayPayload(v);
    case O.OP_DRAW_BUFFERS:
      return u32ArrayPayload(v);

    case O.OP_BUFFER_SUB_DATA:
      return tailBytesPayload(v, 12, 8);
    case O.OP_TEX_IMAGE_2D:
    case O.OP_TEX_SUB_IMAGE_2D:
      return tailBytesPayload(v, 36, 32);
    case O.OP_COMPRESSED_TEX_IMAGE_2D:
      return tailBytesPayload(v, 28, 24);
    case O.OP_COMPRESSED_TEX_SUB_IMAGE_2D:
      return tailBytesPayload(v, 32, 28);
    case O.OP_SHADER_SOURCE:
      return tailBytesPayload(v, 8, 4);
    case O.OP_BIND_ATTRIB_LOCATION:
      return tailBytesPayload(v, 12, 8);

    case O.OP_BUFFER_DATA:
      return bufferDataPayload(v);
    case O.OP_UNIFORM_MATRIX4FV:
      return countedFloatPayload(v, 12, 4, 16);
    case O.OP_UNIFORM4FV:
      return countedFloatPayload(v, 8, 4, 4);
    case O.OP_UNIFORM1FV:
      return countedFloatPayload(v, 8, 4, 1);
    case O.OP_UNIFORM2FV:
      return countedFloatPayload(v, 8, 4, 2);
    case O.OP_UNIFORM3FV:
      return countedFloatPayload(v, 8, 4, 3);
    case O.OP_UNIFORM1IV:
      return countedIntPayload(v, 8, 4, 1);
    case O.OP_UNIFORM2IV:
      return countedIntPayload(v, 8, 4, 2);
    case O.OP_UNIFORM3IV:
      return countedIntPayload(v, 8, 4, 3);
    case O.OP_UNIFORM4IV:
      return countedIntPayload(v, 8, 4, 4);
    case O.OP_UNIFORM_MATRIX2FV:
      return countedFloatPayload(v, 12, 4, 4);
    case O.OP_UNIFORM_MATRIX3FV:
      return countedFloatPayload(v, 12, 4, 9);
    case O.OP_COPY_TEX_IMAGE_2D:
      return exact(v, 32);
    case O.OP_COPY_TEX_SUB_IMAGE_2D:
      return exact(v, 32);
    case O.OP_VERTEX_ATTRIB4FV:
      return exact(v, 20);

    default:
      return false;
  }
}

function dispatch(
  gl: WebGL2RenderingContext,
  b: GlBinding,
  v: DataView,
  p: number,
  op: number,
): void {
  switch (op) {
    // ----- state ----------------------------------------------------------
    case O.OP_CLEAR:
      gl.clear(v.getUint32(p, true));
      return;
    case O.OP_CLEAR_COLOR:
      b.shadow.clearColor = [
        v.getFloat32(p, true), v.getFloat32(p + 4, true),
        v.getFloat32(p + 8, true), v.getFloat32(p + 12, true),
      ];
      gl.clearColor(...b.shadow.clearColor);
      return;
    case O.OP_VIEWPORT:
      b.shadow.viewport = [
        v.getInt32(p, true), v.getInt32(p + 4, true),
        v.getInt32(p + 8, true), v.getInt32(p + 12, true),
      ];
      gl.viewport(...b.shadow.viewport);
      return;
    case O.OP_SCISSOR: {
      const x = v.getInt32(p, true);
      const y = v.getInt32(p + 4, true);
      const w = v.getInt32(p + 8, true);
      const h = v.getInt32(p + 12, true);
      gl.scissor(x, y, w, h);
      b.shadow.scissor.rect = [x, y, w, h];
      return;
    }
    case O.OP_ENABLE: {
      const cap = v.getUint32(p, true);
      gl.enable(cap);
      setCap(b.shadow, cap, true);
      return;
    }
    case O.OP_DISABLE: {
      const cap = v.getUint32(p, true);
      gl.disable(cap);
      setCap(b.shadow, cap, false);
      return;
    }
    case O.OP_BLEND_FUNC: {
      const s = v.getUint32(p, true), d = v.getUint32(p + 4, true);
      gl.blendFunc(s, d);
      b.shadow.blendFunc = { srcRGB: s, dstRGB: d, srcA: s, dstA: d };
      return;
    }
    case O.OP_BLEND_FUNC_SEPARATE: {
      const srcRGB = v.getUint32(p, true);
      const dstRGB = v.getUint32(p + 4, true);
      const srcA = v.getUint32(p + 8, true);
      const dstA = v.getUint32(p + 12, true);
      gl.blendFuncSeparate(srcRGB, dstRGB, srcA, dstA);
      b.shadow.blendFunc = { srcRGB, dstRGB, srcA, dstA };
      return;
    }
    case O.OP_BLEND_EQUATION: {
      const mode = v.getUint32(p, true);
      gl.blendEquation(mode);
      b.shadow.blendEquation = { modeRGB: mode, modeA: mode };
      return;
    }
    case O.OP_BLEND_EQUATION_SEPARATE: {
      const modeRGB = v.getUint32(p, true);
      const modeA = v.getUint32(p + 4, true);
      gl.blendEquationSeparate(modeRGB, modeA);
      b.shadow.blendEquation = { modeRGB, modeA };
      return;
    }
    case O.OP_BLEND_COLOR:
      b.shadow.blendColor = [
        v.getFloat32(p, true),
        v.getFloat32(p + 4, true),
        v.getFloat32(p + 8, true),
        v.getFloat32(p + 12, true),
      ];
      gl.blendColor(...b.shadow.blendColor);
      return;
    case O.OP_CLEAR_DEPTHF:
      gl.clearDepth(v.getFloat32(p, true));
      return;
    case O.OP_CLEAR_STENCIL:
      gl.clearStencil(v.getInt32(p, true));
      return;
    case O.OP_COLOR_MASK:
      b.shadow.colorMask = [
        v.getUint32(p, true) !== 0,
        v.getUint32(p + 4, true) !== 0,
        v.getUint32(p + 8, true) !== 0,
        v.getUint32(p + 12, true) !== 0,
      ];
      gl.colorMask(...b.shadow.colorMask);
      return;
    case O.OP_DEPTH_MASK:
      b.shadow.depthMask = v.getUint32(p, true) !== 0;
      gl.depthMask(b.shadow.depthMask);
      return;
    case O.OP_DEPTH_FUNC:
      b.shadow.depthFunc = v.getUint32(p, true);
      gl.depthFunc(b.shadow.depthFunc);
      return;
    case O.OP_CULL_FACE:
      b.shadow.cullFace = v.getUint32(p, true);
      gl.cullFace(b.shadow.cullFace);
      return;
    case O.OP_FRONT_FACE:
      b.shadow.frontFace = v.getUint32(p, true);
      gl.frontFace(b.shadow.frontFace);
      return;
    case O.OP_LINE_WIDTH:
      gl.lineWidth(v.getFloat32(p, true));
      return;
    case O.OP_STENCIL_FUNC: {
      const func = v.getUint32(p, true);
      const ref = v.getInt32(p + 4, true);
      const mask = v.getUint32(p + 8, true);
      b.shadow.stencil.front.func = func;
      b.shadow.stencil.front.ref = ref;
      b.shadow.stencil.front.valueMask = mask;
      b.shadow.stencil.back.func = func;
      b.shadow.stencil.back.ref = ref;
      b.shadow.stencil.back.valueMask = mask;
      gl.stencilFunc(func, ref, mask);
      return;
    }
    case O.OP_STENCIL_FUNC_SEPARATE: {
      const face = v.getUint32(p, true);
      const func = v.getUint32(p + 4, true);
      const ref = v.getInt32(p + 8, true);
      const mask = v.getUint32(p + 12, true);
      updateStencilFaces(b.shadow, face, (state) => {
        state.func = func;
        state.ref = ref;
        state.valueMask = mask;
      });
      gl.stencilFuncSeparate(face, func, ref, mask);
      return;
    }
    case O.OP_STENCIL_MASK: {
      const mask = v.getUint32(p, true);
      b.shadow.stencil.front.writeMask = mask;
      b.shadow.stencil.back.writeMask = mask;
      gl.stencilMask(mask);
      return;
    }
    case O.OP_STENCIL_MASK_SEPARATE: {
      const face = v.getUint32(p, true);
      const mask = v.getUint32(p + 4, true);
      updateStencilFaces(b.shadow, face, (state) => {
        state.writeMask = mask;
      });
      gl.stencilMaskSeparate(face, mask);
      return;
    }
    case O.OP_STENCIL_OP: {
      const fail = v.getUint32(p, true);
      const zfail = v.getUint32(p + 4, true);
      const zpass = v.getUint32(p + 8, true);
      b.shadow.stencil.front.fail = fail;
      b.shadow.stencil.front.zfail = zfail;
      b.shadow.stencil.front.zpass = zpass;
      b.shadow.stencil.back.fail = fail;
      b.shadow.stencil.back.zfail = zfail;
      b.shadow.stencil.back.zpass = zpass;
      gl.stencilOp(fail, zfail, zpass);
      return;
    }
    case O.OP_STENCIL_OP_SEPARATE: {
      const face = v.getUint32(p, true);
      const fail = v.getUint32(p + 4, true);
      const zfail = v.getUint32(p + 8, true);
      const zpass = v.getUint32(p + 12, true);
      updateStencilFaces(b.shadow, face, (state) => {
        state.fail = fail;
        state.zfail = zfail;
        state.zpass = zpass;
      });
      gl.stencilOpSeparate(face, fail, zfail, zpass);
      return;
    }
    case O.OP_POLYGON_OFFSET:
      gl.polygonOffset(v.getFloat32(p, true), v.getFloat32(p + 4, true));
      return;
    case O.OP_DEPTH_RANGEF:
      gl.depthRange(v.getFloat32(p, true), v.getFloat32(p + 4, true));
      return;
    case O.OP_SAMPLE_COVERAGE:
      gl.sampleCoverage(v.getFloat32(p, true), v.getUint32(p + 4, true) !== 0);
      return;
    case O.OP_PIXEL_STOREI: {
      const pname = v.getUint32(p, true);
      const param = v.getInt32(p + 4, true);
      gl.pixelStorei(pname, param);
      if (pname === GL_UNPACK_ALIGNMENT) b.shadow.unpackAlignment = param;
      else if (pname === GL_PACK_ALIGNMENT) b.shadow.packAlignment = param;
      return;
    }

    // ----- buffers --------------------------------------------------------
    // Payload: u32 n, u32 names[n]
    case O.OP_GEN_BUFFERS: {
      const n = v.getUint32(p, true);
      for (let i = 0; i < n; i++) {
        const name = v.getUint32(p + 4 + i * 4, true);
        const buf = gl.createBuffer();
        if (buf) b.buffers.set(name, buf);
      }
      return;
    }
    case O.OP_DELETE_BUFFERS: {
      const n = v.getUint32(p, true);
      for (let i = 0; i < n; i++) {
        const name = v.getUint32(p + 4 + i * 4, true);
        const obj = b.buffers.get(name);
        if (obj) gl.deleteBuffer(obj);
        if (obj && b.boundArrayBuffer === obj) b.boundArrayBuffer = null;
        if (obj && b.boundElementArrayBuffer === obj) b.boundElementArrayBuffer = null;
        b.buffers.delete(name);
      }
      return;
    }
    case O.OP_BIND_BUFFER: {
      const target = v.getUint32(p, true);
      const buffer = b.buffers.get(v.getUint32(p + 4, true)) ?? null;
      gl.bindBuffer(target, buffer);
      if (target === GL_ARRAY_BUFFER) b.boundArrayBuffer = buffer;
      else if (target === GL_ELEMENT_ARRAY_BUFFER) b.boundElementArrayBuffer = buffer;
      return;
    }
    // Payload with data: u32 target, u32 dataLen, u8 data[dataLen], u32 usage.
    // Payload without data: u32 target, u32 byteLength, u32 usage.
    case O.OP_BUFFER_DATA: {
      const target = v.getUint32(p, true);
      const byteLength = v.getUint32(p + 4, true);
      if (v.byteLength === 12) {
        const usage = v.getUint32(p + 8, true);
        gl.bufferData(target, byteLength, usage);
      } else {
        const usage = v.getUint32(p + 8 + byteLength, true);
        const data = copyBytes(v, p + 8, byteLength);
        gl.bufferData(target, data, usage);
      }
      return;
    }
    // Payload: u32 target, i32 dstOffset, u32 dataLen, u8 data[dataLen]
    case O.OP_BUFFER_SUB_DATA: {
      const target = v.getUint32(p, true);
      const dstOff = v.getInt32(p + 4, true);
      const dataLen = v.getUint32(p + 8, true);
      const data = copyBytes(v, p + 12, dataLen);
      gl.bufferSubData(target, dstOff, data);
      return;
    }

    // ----- textures -------------------------------------------------------
    case O.OP_GEN_TEXTURES: {
      const n = v.getUint32(p, true);
      for (let i = 0; i < n; i++) {
        const name = v.getUint32(p + 4 + i * 4, true);
        const tex = gl.createTexture();
        if (tex) b.textures.set(name, tex);
      }
      return;
    }
    case O.OP_DELETE_TEXTURES: {
      const n = v.getUint32(p, true);
      for (let i = 0; i < n; i++) {
        const name = v.getUint32(p + 4 + i * 4, true);
        const obj = b.textures.get(name);
        if (obj) gl.deleteTexture(obj);
        b.textures.delete(name);
      }
      return;
    }
    case O.OP_BIND_TEXTURE: {
      const target = v.getUint32(p, true);
      const texName = v.getUint32(p + 4, true);
      const tex = b.textures.get(texName) ?? null;
      gl.bindTexture(target, tex);
      const unit = b.shadow.activeTexture;
      if (unit >= 0 && unit < b.shadow.textureUnits.length) {
        b.shadow.textureUnits[unit] = tex;
      }
      return;
    }
    // Payload: u32 target, i32 level, i32 internalFormat, i32 width,
    //          i32 height, i32 border, u32 format, u32 type,
    //          u32 dataLen, u8 data[dataLen]
    case O.OP_TEX_IMAGE_2D: {
      const target = v.getUint32(p, true);
      const level = v.getInt32(p + 4, true);
      const internalFormat = v.getInt32(p + 8, true);
      const width = v.getInt32(p + 12, true);
      const height = v.getInt32(p + 16, true);
      const border = v.getInt32(p + 20, true);
      const format = v.getUint32(p + 24, true);
      const type = v.getUint32(p + 28, true);
      const dataLen = v.getUint32(p + 32, true);
      const data = dataLen === 0
        ? null
        : copyBytes(v, p + 36, dataLen);
      gl.texImage2D(
        target, level, internalFormat, width, height, border,
        format, type, data,
      );
      return;
    }
    // Payload: u32 target, i32 level, i32 xoff, i32 yoff, i32 width,
    //          i32 height, u32 format, u32 type,
    //          u32 dataLen, u8 data[dataLen]
    case O.OP_TEX_SUB_IMAGE_2D: {
      const target = v.getUint32(p, true);
      const level = v.getInt32(p + 4, true);
      const xoff = v.getInt32(p + 8, true);
      const yoff = v.getInt32(p + 12, true);
      const width = v.getInt32(p + 16, true);
      const height = v.getInt32(p + 20, true);
      const format = v.getUint32(p + 24, true);
      const type = v.getUint32(p + 28, true);
      const dataLen = v.getUint32(p + 32, true);
      const data = copyBytes(v, p + 36, dataLen);
      gl.texSubImage2D(
        target, level, xoff, yoff, width, height, format, type, data,
      );
      return;
    }
    case O.OP_TEX_PARAMETERI:
      gl.texParameteri(
        v.getUint32(p, true),
        v.getUint32(p + 4, true),
        v.getInt32(p + 8, true),
      );
      return;
    case O.OP_TEX_PARAMETERF:
      gl.texParameterf(
        v.getUint32(p, true),
        v.getUint32(p + 4, true),
        v.getFloat32(p + 8, true),
      );
      return;
    case O.OP_ACTIVE_TEXTURE: {
      const unit = v.getUint32(p, true);
      gl.activeTexture(unit);
      b.shadow.activeTexture = unit - GL_TEXTURE0;
      return;
    }
    case O.OP_GENERATE_MIPMAP:
      gl.generateMipmap(v.getUint32(p, true));
      return;
    case O.OP_COMPRESSED_TEX_IMAGE_2D: {
      const dataLen = v.getUint32(p + 24, true);
      const data = copyBytes(v, p + 28, dataLen);
      gl.compressedTexImage2D(
        v.getUint32(p, true),
        v.getInt32(p + 4, true),
        v.getUint32(p + 8, true),
        v.getInt32(p + 12, true),
        v.getInt32(p + 16, true),
        v.getInt32(p + 20, true),
        data,
      );
      return;
    }
    case O.OP_COMPRESSED_TEX_SUB_IMAGE_2D: {
      const dataLen = v.getUint32(p + 28, true);
      const data = copyBytes(v, p + 32, dataLen);
      gl.compressedTexSubImage2D(
        v.getUint32(p, true),
        v.getInt32(p + 4, true),
        v.getInt32(p + 8, true),
        v.getInt32(p + 12, true),
        v.getInt32(p + 16, true),
        v.getInt32(p + 20, true),
        v.getUint32(p + 24, true),
        data,
      );
      return;
    }
    case O.OP_COPY_TEX_IMAGE_2D:
      gl.copyTexImage2D(
        v.getUint32(p, true),
        v.getInt32(p + 4, true),
        v.getUint32(p + 8, true),
        v.getInt32(p + 12, true),
        v.getInt32(p + 16, true),
        v.getInt32(p + 20, true),
        v.getInt32(p + 24, true),
        v.getInt32(p + 28, true),
      );
      return;
    case O.OP_COPY_TEX_SUB_IMAGE_2D:
      gl.copyTexSubImage2D(
        v.getUint32(p, true),
        v.getInt32(p + 4, true),
        v.getInt32(p + 8, true),
        v.getInt32(p + 12, true),
        v.getInt32(p + 16, true),
        v.getInt32(p + 20, true),
        v.getInt32(p + 24, true),
        v.getInt32(p + 28, true),
      );
      return;

    // ----- shaders / programs --------------------------------------------
    // Payload: u32 type, u32 cmdbufName
    case O.OP_CREATE_SHADER: {
      const type = v.getUint32(p, true);
      const name = v.getUint32(p + 4, true);
      const sh = gl.createShader(type);
      if (sh) b.shaders.set(name, sh);
      return;
    }
    // Payload: u32 cmdbufName, u32 srcLen, u8 src[srcLen] (UTF-8)
    case O.OP_SHADER_SOURCE: {
      const name = v.getUint32(p, true);
      const srcLen = v.getUint32(p + 4, true);
      // TextDecoder rejects views over SharedArrayBuffer, which the
      // cmdbuf is when the user program runs against shared memory
      // (the wasm-posix-kernel default). Copy into a fresh
      // Uint8Array — also detaches from SAB grow races.
      const srcBytes = new Uint8Array(srcLen);
      srcBytes.set(new Uint8Array(v.buffer, v.byteOffset + p + 8, srcLen));
      const src = new TextDecoder().decode(srcBytes);
      const sh = b.shaders.get(name);
      if (sh) gl.shaderSource(sh, src);
      return;
    }
    case O.OP_COMPILE_SHADER: {
      const sh = b.shaders.get(v.getUint32(p, true));
      if (sh) gl.compileShader(sh);
      return;
    }
    case O.OP_DELETE_SHADER: {
      const name = v.getUint32(p, true);
      const sh = b.shaders.get(name);
      if (sh) gl.deleteShader(sh);
      b.shaders.delete(name);
      return;
    }
    case O.OP_CREATE_PROGRAM: {
      const name = v.getUint32(p, true);
      const prog = gl.createProgram();
      if (prog) b.programs.set(name, prog);
      return;
    }
    case O.OP_ATTACH_SHADER: {
      const prog = b.programs.get(v.getUint32(p, true));
      const sh = b.shaders.get(v.getUint32(p + 4, true));
      if (prog && sh) gl.attachShader(prog, sh);
      return;
    }
    case O.OP_LINK_PROGRAM: {
      const prog = b.programs.get(v.getUint32(p, true));
      if (prog) gl.linkProgram(prog);
      return;
    }
    case O.OP_USE_PROGRAM: {
      const prog = b.programs.get(v.getUint32(p, true)) ?? null;
      gl.useProgram(prog);
      b.currentProgram = prog;
      b.shadow.currentProgram = prog;
      return;
    }
    // Payload: u32 program, u32 index, u32 nameLen, u8 name[nameLen]
    case O.OP_BIND_ATTRIB_LOCATION: {
      const prog = b.programs.get(v.getUint32(p, true));
      const index = v.getUint32(p + 4, true);
      const nameLen = v.getUint32(p + 8, true);
      // Copy off the (possibly shared) cmdbuf — TextDecoder rejects
      // views over SharedArrayBuffer.
      const nameBytes = new Uint8Array(nameLen);
      nameBytes.set(new Uint8Array(v.buffer, v.byteOffset + p + 12, nameLen));
      const name = new TextDecoder().decode(nameBytes);
      if (prog) gl.bindAttribLocation(prog, index, name);
      return;
    }
    case O.OP_DELETE_PROGRAM: {
      const name = v.getUint32(p, true);
      const prog = b.programs.get(name);
      if (prog) gl.deleteProgram(prog);
      b.programs.delete(name);
      return;
    }

    // ----- uniforms -------------------------------------------------------
    // Locations are kernel-routed indices issued by `runGlQuery` for
    // `QOP_GET_UNIFORM_LOC`; they round-trip back here as i32.
    case O.OP_UNIFORM1I: {
      const loc = b.uniformLocations.get(v.getInt32(p, true)) ?? null;
      gl.uniform1i(loc, v.getInt32(p + 4, true));
      return;
    }
    case O.OP_UNIFORM1F: {
      const loc = b.uniformLocations.get(v.getInt32(p, true)) ?? null;
      gl.uniform1f(loc, v.getFloat32(p + 4, true));
      return;
    }
    case O.OP_UNIFORM2F: {
      const loc = b.uniformLocations.get(v.getInt32(p, true)) ?? null;
      gl.uniform2f(loc, v.getFloat32(p + 4, true), v.getFloat32(p + 8, true));
      return;
    }
    case O.OP_UNIFORM3F: {
      const loc = b.uniformLocations.get(v.getInt32(p, true)) ?? null;
      gl.uniform3f(
        loc,
        v.getFloat32(p + 4, true),
        v.getFloat32(p + 8, true),
        v.getFloat32(p + 12, true),
      );
      return;
    }
    case O.OP_UNIFORM4F: {
      const loc = b.uniformLocations.get(v.getInt32(p, true)) ?? null;
      gl.uniform4f(
        loc,
        v.getFloat32(p + 4, true),
        v.getFloat32(p + 8, true),
        v.getFloat32(p + 12, true),
        v.getFloat32(p + 16, true),
      );
      return;
    }
    // Payload: i32 location, u32 count, u32 transposeBool, f32 mat[count*16]
    case O.OP_UNIFORM_MATRIX4FV: {
      const loc = b.uniformLocations.get(v.getInt32(p, true)) ?? null;
      const count = v.getUint32(p + 4, true);
      const transpose = v.getUint32(p + 8, true) !== 0;
      const mat = copyFloat32Array(v, p + 12, count * 16);
      gl.uniformMatrix4fv(loc, transpose, mat);
      return;
    }
    // Payload: i32 location, u32 count, f32 v[count*4]
    case O.OP_UNIFORM4FV: {
      const loc = b.uniformLocations.get(v.getInt32(p, true)) ?? null;
      const count = v.getUint32(p + 4, true);
      const arr = copyFloat32Array(v, p + 8, count * 4);
      gl.uniform4fv(loc, arr);
      return;
    }
    case O.OP_UNIFORM1FV: {
      const loc = b.uniformLocations.get(v.getInt32(p, true)) ?? null;
      const count = v.getUint32(p + 4, true);
      gl.uniform1fv(loc, copyFloat32Array(v, p + 8, count));
      return;
    }
    case O.OP_UNIFORM2FV: {
      const loc = b.uniformLocations.get(v.getInt32(p, true)) ?? null;
      const count = v.getUint32(p + 4, true);
      gl.uniform2fv(loc, copyFloat32Array(v, p + 8, count * 2));
      return;
    }
    case O.OP_UNIFORM3FV: {
      const loc = b.uniformLocations.get(v.getInt32(p, true)) ?? null;
      const count = v.getUint32(p + 4, true);
      gl.uniform3fv(loc, copyFloat32Array(v, p + 8, count * 3));
      return;
    }
    case O.OP_UNIFORM1IV: {
      const locIndex = v.getInt32(p, true);
      const loc = b.uniformLocations.get(locIndex) ?? null;
      const count = v.getUint32(p + 4, true);
      const values = copyInt32Array(v, p + 8, count);
      gl.uniform1iv(loc, values);
      return;
    }
    case O.OP_UNIFORM2IV: {
      const loc = b.uniformLocations.get(v.getInt32(p, true)) ?? null;
      const count = v.getUint32(p + 4, true);
      gl.uniform2iv(loc, copyInt32Array(v, p + 8, count * 2));
      return;
    }
    case O.OP_UNIFORM3IV: {
      const loc = b.uniformLocations.get(v.getInt32(p, true)) ?? null;
      const count = v.getUint32(p + 4, true);
      gl.uniform3iv(loc, copyInt32Array(v, p + 8, count * 3));
      return;
    }
    case O.OP_UNIFORM4IV: {
      const loc = b.uniformLocations.get(v.getInt32(p, true)) ?? null;
      const count = v.getUint32(p + 4, true);
      gl.uniform4iv(loc, copyInt32Array(v, p + 8, count * 4));
      return;
    }
    case O.OP_UNIFORM_MATRIX2FV: {
      const loc = b.uniformLocations.get(v.getInt32(p, true)) ?? null;
      const count = v.getUint32(p + 4, true);
      const transpose = v.getUint32(p + 8, true) !== 0;
      gl.uniformMatrix2fv(loc, transpose, copyFloat32Array(v, p + 12, count * 4));
      return;
    }
    case O.OP_UNIFORM_MATRIX3FV: {
      const loc = b.uniformLocations.get(v.getInt32(p, true)) ?? null;
      const count = v.getUint32(p + 4, true);
      const transpose = v.getUint32(p + 8, true) !== 0;
      gl.uniformMatrix3fv(loc, transpose, copyFloat32Array(v, p + 12, count * 9));
      return;
    }

    // ----- vertex attribs / draws -----------------------------------------
    case O.OP_ENABLE_VERTEX_ATTRIB_ARRAY: {
      const index = v.getUint32(p, true);
      b.enabledVertexAttribs.add(index);
      gl.enableVertexAttribArray(index);
      return;
    }
    case O.OP_DISABLE_VERTEX_ATTRIB_ARRAY: {
      const index = v.getUint32(p, true);
      b.enabledVertexAttribs.delete(index);
      gl.disableVertexAttribArray(index);
      return;
    }
    // Payload: u32 index, i32 size, u32 type, u32 normalizedBool,
    //          i32 stride, i32 offset
    case O.OP_VERTEX_ATTRIB_POINTER: {
      const index = v.getUint32(p, true);
      const size = v.getInt32(p + 4, true);
      const type = v.getUint32(p + 8, true);
      const normalized = v.getUint32(p + 12, true) !== 0;
      const stride = v.getInt32(p + 16, true);
      const off = v.getInt32(p + 20, true);
      const buffer = b.boundArrayBuffer;
      b.vertexAttribPointers.set(index, { size, type, normalized, stride, offset: off, buffer });
      if (buffer !== null) {
        gl.vertexAttribPointer(index, size, type, normalized, stride, off);
      }
      return;
    }
    case O.OP_DRAW_ARRAYS: {
      const mode = v.getUint32(p, true);
      const first = v.getInt32(p + 4, true);
      const count = v.getInt32(p + 8, true);
      if (hasClientVertexAttribs(b)) {
        uploadClientVertexAttribs(b, first + count - 1);
      }
      gl.drawArrays(
        mode,
        first,
        count,
      );
      return;
    }
    case O.OP_DRAW_ELEMENTS: {
      const mode = v.getUint32(p, true);
      const count = v.getInt32(p + 4, true);
      const type = v.getUint32(p + 8, true);
      const offset = v.getUint32(p + 12, true);
      if (b.boundElementArrayBuffer === null) {
        const clientElement = bindClientElementBuffer(b, offset, type, count);
        uploadClientVertexAttribs(b, clientElement.maxVertexIndex);
        gl.drawElements(mode, count, type, clientElement.drawOffset);
        gl.bindBuffer(GL_ELEMENT_ARRAY_BUFFER, clientElement.restoreElementBuffer);
      } else {
        if (hasClientVertexAttribs(b)) {
          throw new Error("mixed native GLES client vertex arrays with a WebGL element buffer are not representable");
        }
        gl.drawElements(mode, count, type, offset);
      }
      return;
    }
    case O.OP_VERTEX_ATTRIB4F: {
      const index = v.getUint32(p, true);
      const x = v.getFloat32(p + 4, true);
      const y = v.getFloat32(p + 8, true);
      const z = v.getFloat32(p + 12, true);
      const w = v.getFloat32(p + 16, true);
      b.shadow.vertexAttribValues.set(index, [x, y, z, w]);
      gl.vertexAttrib4f(index, x, y, z, w);
      return;
    }
    case O.OP_VERTEX_ATTRIB4FV: {
      const index = v.getUint32(p, true);
      const values = copyFloat32Array(v, p + 4, 4);
      b.shadow.vertexAttribValues.set(index, [values[0], values[1], values[2], values[3]]);
      gl.vertexAttrib4fv(index, values);
      return;
    }

    // ----- VAOs -----------------------------------------------------------
    case O.OP_GEN_VERTEX_ARRAYS: {
      const n = v.getUint32(p, true);
      for (let i = 0; i < n; i++) {
        const name = v.getUint32(p + 4 + i * 4, true);
        const vao = gl.createVertexArray();
        if (vao) b.vaos.set(name, vao);
      }
      return;
    }
    case O.OP_DELETE_VERTEX_ARRAYS: {
      const n = v.getUint32(p, true);
      for (let i = 0; i < n; i++) {
        const name = v.getUint32(p + 4 + i * 4, true);
        const obj = b.vaos.get(name);
        if (obj) gl.deleteVertexArray(obj);
        b.vaos.delete(name);
      }
      return;
    }
    case O.OP_BIND_VERTEX_ARRAY: {
      const vao = b.vaos.get(v.getUint32(p, true)) ?? null;
      gl.bindVertexArray(vao);
      b.shadow.vao = vao;
      return;
    }

    // ----- framebuffers / renderbuffers -----------------------------------
    case O.OP_GEN_FRAMEBUFFERS: {
      const n = v.getUint32(p, true);
      for (let i = 0; i < n; i++) {
        const name = v.getUint32(p + 4 + i * 4, true);
        const fbo = gl.createFramebuffer();
        if (fbo) b.fbos.set(name, fbo);
      }
      return;
    }
    case O.OP_DELETE_FRAMEBUFFERS: {
      const n = v.getUint32(p, true);
      for (let i = 0; i < n; i++) {
        const name = v.getUint32(p + 4 + i * 4, true);
        const obj = b.fbos.get(name);
        if (obj) gl.deleteFramebuffer(obj);
        b.fbos.delete(name);
      }
      return;
    }
    case O.OP_BIND_FRAMEBUFFER: {
      const target = v.getUint32(p, true);
      const fbo = b.fbos.get(v.getUint32(p + 4, true)) ?? null;
      gl.bindFramebuffer(target, fbo);
      if (target !== GL_READ_FRAMEBUFFER) b.shadow.fbo = fbo;
      return;
    }
    // Payload: u32 target, u32 attachment, u32 textarget, u32 textureName,
    //          i32 level
    case O.OP_FRAMEBUFFER_TEXTURE_2D: {
      const target = v.getUint32(p, true);
      const attachment = v.getUint32(p + 4, true);
      const textarget = v.getUint32(p + 8, true);
      const tex = b.textures.get(v.getUint32(p + 12, true)) ?? null;
      const level = v.getInt32(p + 16, true);
      gl.framebufferTexture2D(target, attachment, textarget, tex, level);
      return;
    }
    case O.OP_GEN_RENDERBUFFERS: {
      const n = v.getUint32(p, true);
      for (let i = 0; i < n; i++) {
        const name = v.getUint32(p + 4 + i * 4, true);
        const rbo = gl.createRenderbuffer();
        if (rbo) b.rbos.set(name, rbo);
      }
      return;
    }
    case O.OP_DELETE_RENDERBUFFERS: {
      const n = v.getUint32(p, true);
      for (let i = 0; i < n; i++) {
        const name = v.getUint32(p + 4 + i * 4, true);
        const obj = b.rbos.get(name);
        if (obj) gl.deleteRenderbuffer(obj);
        b.rbos.delete(name);
      }
      return;
    }
    case O.OP_BIND_RENDERBUFFER:
      gl.bindRenderbuffer(
        v.getUint32(p, true),
        b.rbos.get(v.getUint32(p + 4, true)) ?? null,
      );
      return;
    // Payload: u32 target, u32 internalformat, i32 width, i32 height
    case O.OP_RENDERBUFFER_STORAGE:
      gl.renderbufferStorage(
        v.getUint32(p, true),
        v.getUint32(p + 4, true),
        v.getInt32(p + 8, true),
        v.getInt32(p + 12, true),
      );
      return;
    // Payload: u32 target, u32 attachment, u32 rbtarget, u32 rboName
    case O.OP_FRAMEBUFFER_RENDERBUFFER: {
      const target = v.getUint32(p, true);
      const attachment = v.getUint32(p + 4, true);
      const rbtarget = v.getUint32(p + 8, true);
      const rbo = b.rbos.get(v.getUint32(p + 12, true)) ?? null;
      gl.framebufferRenderbuffer(target, attachment, rbtarget, rbo);
      return;
    }
    case O.OP_DRAW_BUFFER: {
      gl.drawBuffers([v.getUint32(p, true)]);
      return;
    }
    case O.OP_DRAW_BUFFERS: {
      const n = v.getUint32(p, true);
      const buffers: number[] = [];
      for (let i = 0; i < n; i++) buffers.push(v.getUint32(p + 4 + i * 4, true));
      gl.drawBuffers(buffers);
      return;
    }
    case O.OP_READ_BUFFER: {
      gl.readBuffer(v.getUint32(p, true));
      return;
    }

    default:
      throw new Error(
        `gl bridge: unknown op 0x${op.toString(16).padStart(4, "0")} at offset ${p - 4}`,
      );
  }
}
