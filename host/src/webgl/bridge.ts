import { interruptCompressedUpload } from "./compressed-upload.js";
import { validateDrawFramebufferWithoutProgram } from "./framebuffer.js";
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
import { interruptUniformUpload, runUniformUpload, uniformUploadOp, validUniformUploadPayload } from "./uniform-upload.js";
import { GL_CLIENT_ERROR_MASK, mergeClientGlErrors } from "./errors.js";
import { acceptedUniformCount, type GlUniformTarget } from "./uniform-setters.js";
import { imageTextureOperation, imageRenderbufferStorage, prepareCubeRespecification, prepareImageDraw, renderbufferNative } from "./image-storage.js";
import { cubeGenerateMipmap, cubeImagesChanged, cubeSpecifyImage, cubeTexParameter, cubeUpdateImage, TEXTURE_2D_ARRAY } from "./cube-storage.js";
import { boundTextureObject, isCubeFace, recordGeneratedMipmaps, recordTextureLevel, textureLevel } from "./texture-levels.js";
import { noteTextureFilter } from "./lod-switchover.js";
import { repairNativeState, rethrowNativeGlFault } from "./native-recovery.js";
import { bindImageObject } from "./image-bindings.js";
import { beginClientArray, endClientArray, reconcileClientArrayRestore, requestClientArrayRestore } from "./client-array.js";
import { capabilityEnabled } from "./state-query.js";
import { prepareTextureOperation, validGlesTextureParameter } from "./texture-bindings.js";
import { expandedFloatFormat, expandedNative, expandedSourceBytes, expandRows } from "./luminance-float.js";
import { glesExtensionAdvertised } from "./capabilities.js";
import { clearStorageAlphaToOne, nativeColorMask, setOpaqueAlphaStorage, prepareDrawTarget } from "./opaque-alpha.js";
import { copiedTextureColorRenderable, depthTextureFormat, nativeRenderbufferFormat, renderbufferColorRenderable,
  renderbufferOpaqueAlpha,
  renderbufferDepthRenderable, renderbufferStencilRenderable, textureColorRenderable } from "./es2-formats.js";
import { copyTexImageFormatError, renderbufferFormatError, texImageFormatError, texSubImageFormatError } from "./es2-formats.js";
import { installShaderSource, nativeShaderSource } from "./shader-source.js";
import { compileGuestShader, recordShaderLanguage, type ShaderLanguage } from "./essl3-translation.js";
import { issueGlesDraw, sequentialVertices } from "./draw-state.js";
import { nativeBlendFunc, updateBlendSourceFactor } from "./blend-constant.js";
import { attributeAliasLayout } from "./attribute-aliasing.js";
import { noteSamplerWrite } from "./depth-sampling.js";
import { externalTexParameter, recordCompiledExternalSamplers, TEXTURE_EXTERNAL_OES, validateExternalSamplers } from "./external-texture.js";
import { recordProgramValidation } from "./validate-status.js";
import { recordRenderbufferSize, requireGlesFramebufferComplete } from "./image-sizes.js";
import { nativeDepthRange, noteUniformWrite, recordCompiledShader } from "./reversed-depth.js";
import { drawGlesElements } from "./index-data.js";
import { drawPrivateClientArrays, validPrivateClientDraw } from "./private-client-draw.js";
import { installVertexAttribute, installVertexConstant } from "./vertex-data.js";
import { bindBufferObject, canonicalBuffer, prepareBufferDraw, replaceBufferData, updateBufferData } from "./buffer-storage.js";
import type { GlBinding } from "./registry.js";
import { createShaderIfAccepted, createProgramIfAccepted, checkedGlCall, finalizeProgram, finalizeShader, linkProgramRetainingExecutable, recordGlError, useProgramIfAccepted, requireProgramObject, requireShaderObject, shaderType } from "./program-objects.js";
import { stateArgumentError } from "./state-validation.js";
import { attachShaderError, bindAttribLocationError, renderbufferStorageError, subImageError, texImageSizeError,
  texParameterValueError, uploadBytes, uploadSizeError, vertexAttribIndexError } from "./es2-validation.js";
import { glAuditOn, noteGlAuditOp, withGlAuditFrame } from "./native-audit.js";
import { combinedTextureUnits, knownVertexAttributeLimit, MAX_RENDERBUFFER_SIZE, MAX_TEXTURE_SIZE, MAX_VERTEX_ATTRIBS,
  maxCubeMapTextureSize, maxViewport, predictionLimit } from "./limits.js";
import * as O from "./ops.js";
import { withMultisampleRead } from "./multisample.js";
import { collectRetiredImages, deleteRenderbufferName, deleteTextureName, deleteFramebufferName, attachImageObject, bindFramebufferObject } from "./image-references.js";
import { activeVertexArray, collectRetiredBuffers, defaultVertexArray, deleteBufferNames, vertexAttribute } from "./buffer-references.js";
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
const GL_HALF_FLOAT_OES = 0x8D61;
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

/** ES 2.0 clamps ClearColor/BlendColor to [0,1]; with a floating-point
 * color buffer extension the values are kept as specified. */
function colorClamp(gl: WebGL2RenderingContext): (value: number) => number {
  return glesExtensionAdvertised(gl, "GL_EXT_color_buffer_half_float") ? value => value : clampUnit;
}

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
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
  storage?: {before: () => boolean; after: () => boolean},
): number {
  // Test-only native-divergence audit: attribute this frame's native calls.
  if (glAuditOn) return withGlAuditFrame(b, () => decodeAndDispatchFrame(b, offset, length, storage));
  return decodeAndDispatchFrame(b, offset, length, storage);
}

function decodeAndDispatchFrame(
  b: GlBinding,
  offset: number,
  length: number,
  storage?: {before: () => boolean; after: () => boolean},
): number {
  if (!b.cmdbufView || !b.gl) return GL_SUBMIT_OK;
  // Validate the entire batch before the first observable mutation. A bad
  // trailing record must not leave a partially executed, rejected batch.
  const validation = validateCommandBuffer(b.cmdbufView, offset, length);
  if (validation !== GL_SUBMIT_OK) {b.compressedUpload=null;b.uniformUpload=null;return validation;}
  const result = walkCommandBuffer(b.cmdbufView, offset, length, (payload, op) => {
    if (glAuditOn) noteGlAuditOp(op, payload);
    // Flags have no native effects and may accompany a partial upload batch.
    // Merge before repair/utility work without interrupting that transaction.
    if (op === O.OP_CLIENT_ERRORS) {
      mergeClientGlErrors(b,payload.getUint32(0,true));
      return GL_SUBMIT_OK;
    }
    if (interruptCompressedUpload(b)) return GL_SUBMIT_OK;
    if (!uniformUploadOp(op) && interruptUniformUpload(b)) return GL_SUBMIT_OK;
    try {
      if (!repairNativeState(b.gl!) || !reconcileClientArrayRestore(b,b.gl!)) return GL_SUBMIT_EIO;
      if (storage && !storage.before()) return GL_SUBMIT_EIO;
      // Publish CPU-image storage even when dispatch threw, but never let
      // that result replace the exception: a NativeGlFault must propagate.
      let failure: { error: unknown } | null = null;
      try { dispatch(b.gl!, b, payload, 0, op); }
      catch (error) { failure = { error }; }
      const published = !storage || storage.after();
      if (failure) throw failure.error;
      return published ? GL_SUBMIT_OK : GL_SUBMIT_EIO;
    } catch (err) { rethrowNativeGlFault(err);
      logGlBridgeFailure("submit", op, err);
      return GL_SUBMIT_EIO;
    }
  });
  if (result < 0) {b.uniformUpload=null;requestClientArrayRestore(b);}
  if (!repairNativeState(b.gl) || !reconcileClientArrayRestore(b,b.gl)) {
    b.uniformUpload=null;
    requestClientArrayRestore(b);
    return GL_SUBMIT_EIO;
  }
  collectRetiredImages(b);
  collectRetiredBuffers(b);
  return result;
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

/** `n` little-endian f32s at byte `at` of `v`. Records are packed with no
 *  padding, so any record after one whose payload is not a multiple of 4
 *  bytes (a texture upload with an odd row width, say) starts unaligned. A
 *  Float32Array cannot view unaligned bytes, so those are copied out. */
function floatsAt(v: DataView, at: number, n: number): Float32Array {
  const start = v.byteOffset + at;
  if (start % 4 === 0) return new Float32Array(v.buffer, start, n);
  const out = new Float32Array(n);
  new Uint8Array(out.buffer).set(new Uint8Array(v.buffer, start, n * 4));
  return out;
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

function copyBytes(v: DataView, offset: number, length: number): Uint8Array<ArrayBuffer> {
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

/** WebGL requires non-shared, correctly typed upload views. TLV data can be
 * unaligned, so copy before constructing the view (also for float textures). */
function copyPixels(v: DataView, offset: number, length: number, type: number) {
  const bytes = copyBytes(v, offset, length);
  switch (type) {
    case GL_FLOAT: return new Float32Array(bytes.buffer);
    case GL_HALF_FLOAT: case GL_UNSIGNED_SHORT:
    case 0x8363: case 0x8033: case 0x8034:
      return new Uint16Array(bytes.buffer);
    case GL_UNSIGNED_INT: case 0x84fa: case 0x8368: case 0x8c3b:
      return new Uint32Array(bytes.buffer);
    default: return bytes;
  }
}

/** Expand guest rows packed at the current UNPACK_ALIGNMENT. A short
 * payload is the same INVALID_OPERATION a native upload would raise. */
function expandedUpload(b: GlBinding, format: number, type: number, bytes: Uint8Array,
                        width: number, height: number): ArrayBufferView | null {
  const alignment = b.shadow.unpackAlignment;
  const stride = Math.ceil(width * expandedSourceBytes(format, type) / alignment) * alignment;
  const data = width < 0 || height < 0 ? null : expandRows(format, type, bytes, width, height, stride);
  if (!data) recordGlError(b, 0x502);
  return data;
}

/** 16-bit depth rows packed at the current UNPACK_ALIGNMENT, widened to
 * tightly packed 32-bit values (c * 65537 maps 0xffff to 0xffffffff). */
function widenedDepthUpload(b: GlBinding, bytes: Uint8Array, width: number, height: number): Uint32Array | null {
  const alignment = b.shadow.unpackAlignment, stride = Math.ceil(width * 2 / alignment) * alignment;
  if (width < 0 || height < 0 || (width && height && bytes.length < (height - 1) * stride + width * 2)) {
    recordGlError(b, 0x502); return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), out = new Uint32Array(width * height);
  for (let r = 0; r < height; r++)
    for (let x = 0; x < width; x++) out[r * width + x] = view.getUint16(r * stride + x * 2, true) * 65537;
  return out;
}

function normalizeTextureType(type: number): number {
  // GLES2's OES_texture_half_float extension uses GL_HALF_FLOAT_OES, while
  // WebGL2 accepts the core GL_HALF_FLOAT token. Native renderers such as LOVE
  // pick the OES token when GL_OES_texture_half_float is advertised.
  return type === GL_HALF_FLOAT_OES ? GL_HALF_FLOAT : type;
}

function normalizeTextureInternalFormat(internal: number, format: number, type: number): number {
  // GLES2 extensions use unsized RED/RG and floating-point formats. WebGL2
  // requires their sized GLES3 equivalents. es2-formats.ts has already
  // required internal === format, so only those unsized pairs arrive here.
  if (internal !== format) return internal;
  switch (format) {
    case 0x1903 /* RED */:
      if (type === GL_UNSIGNED_BYTE) return 0x8229; // R8
      if (type === GL_HALF_FLOAT) return 0x822D; // R16F
      if (type === GL_FLOAT) return 0x822E; // R32F
      break;
    case 0x8227 /* RG */:
      if (type === GL_UNSIGNED_BYTE) return 0x822B; // RG8
      if (type === GL_HALF_FLOAT) return 0x822F; // RG16F
      if (type === GL_FLOAT) return 0x8230; // RG32F
      break;
    case 0x1907 /* RGB */:
      if (type === GL_HALF_FLOAT) return 0x881B; // RGB16F
      if (type === GL_FLOAT) return 0x8815; // RGB32F
      break;
    case 0x1908 /* RGBA */:
      if (type === GL_HALF_FLOAT) return 0x881A; // RGBA16F
      if (type === GL_FLOAT) return 0x8814; // RGBA32F
      break;
    case 0x1902 /* DEPTH_COMPONENT */:
      if (type === GL_UNSIGNED_SHORT) return 0x81A5; // DEPTH_COMPONENT16
      if (type === GL_UNSIGNED_INT) return 0x81A6; // DEPTH_COMPONENT24
      if (type === GL_FLOAT) return 0x8CAC; // DEPTH_COMPONENT32F
      break;
    case 0x84F9 /* DEPTH_STENCIL */:
      if (type === 0x84FA /* UNSIGNED_INT_24_8 */) return 0x88F0; // DEPTH24_STENCIL8
      break;
  }
  return internal;
}

function validPayload(op: number, v: DataView): boolean {
  if (op === O.OP_CLIENT_ERRORS) return exact(v,4) && (v.getUint32(0,true) & ~GL_CLIENT_ERROR_MASK) === 0;
  if (uniformUploadOp(op)) return validUniformUploadPayload(op,v);
  switch (op) {
    case O.OP_DRAW_CLIENT_ARRAYS:
      return validPrivateClientDraw(v);
    case O.OP_BEGIN_CLIENT_ARRAY:
    case O.OP_END_CLIENT_ARRAY:
      return exact(v,0);
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
    case O.OP_VALIDATE_PROGRAM:
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
    case O.OP_BLEND_EQUATION_SEPARATE:
    case O.OP_PIXEL_STOREI:
    case O.OP_BIND_BUFFER:
    case O.OP_BIND_TEXTURE:
    case O.OP_CREATE_SHADER:
    case O.OP_ATTACH_SHADER:
    case O.OP_DETACH_SHADER:
    case O.OP_UNIFORM1I:
    case O.OP_UNIFORM1F:
    case O.OP_BIND_FRAMEBUFFER:
    case O.OP_BIND_RENDERBUFFER:
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
    case O.OP_VERTEX_ATTRIB_4FV:
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
    case O.OP_DELETE_FRAMEBUFFERS:
    case O.OP_GEN_RENDERBUFFERS:
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

    default:
      return false;
  }
}

/** Checked storage requests prefix an unchanged command payload with its opcode.
 * Subimages admit only destination metadata here; pixel rows follow separately.
 * Validate complete spans before replies or native side effects. */
export function validImageStorageRequest(input: Uint8Array): boolean {
  if (input.byteLength < 4) return false;
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength), op = view.getUint32(0, true);
  if (op === O.OP_TEX_IMAGE_2D || op === O.OP_TEX_SUB_IMAGE_2D) {
    if (input.byteLength !== 40 || view.getUint32(36, true) !== 0) return false;
  } else if (op === O.OP_RENDERBUFFER_STORAGE) {
    if (input.byteLength !== 20) return false;
  } else return false;
  return validPayload(op, new DataView(input.buffer, input.byteOffset + 4, input.byteLength - 4));
}
/** Execute storage allocation or destination admission after span validation. */
export function executeImageStorageRequest(b: GlBinding, input: Uint8Array): boolean {
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const payload = new DataView(input.buffer, input.byteOffset + 4, input.byteLength - 4);
  if (glAuditOn) noteGlAuditOp(view.getUint32(0, true), payload);
  return dispatch(b.gl!, b, payload, 0, view.getUint32(0, true), true) === true;
}

/** Record a predicted GLES 2.0 error; true when there is none. */
function predicted(b: GlBinding, error: number): boolean {
  if (error === 0) return true;
  recordGlError(b, error);
  return false;
}

/** ES 2.0 section 3.7.1 sizes of a 2D image (es2-validation.ts). */
function texImageSizeValid(b: GlBinding, level: number, width: number, height: number, border: number): boolean {
  return predicted(b, texImageSizeError(predictionLimit(b.gl!, MAX_TEXTURE_SIZE), level, width, height, border));
}

/** ES 2.0 section 3.7.2 destination rules of a sub-image update against the
 * level the host recorded for the bound texture (es2-validation.ts). */
function subImageValid(b: GlBinding, target: number, level: number, x: number, y: number, width: number, height: number): boolean {
  const object = boundTextureObject(b, target);
  return predicted(b, subImageError(object ? textureLevel(object, target, level) : undefined, x, y, width, height));
}

/** ES 2.0 section 3.7.1 sizes of a cube-map face image: square, within
 * MAX_CUBE_MAP_TEXTURE_SIZE at its level, border 0 (INVALID_VALUE). Native
 * cube targets checked this; the face's 2D array storage
 * (cube-storage.ts) would accept a non-square layer. */
function cubeImageSizeValid(b: GlBinding, level: number, width: number, height: number, border: number): boolean {
  const maximum = maxCubeMapTextureSize(b);
  if (maximum === null) return false;
  if (width < 0 || height < 0 || width !== height || width > maximum >> level || border !== 0) {
    recordGlError(b, 0x501); return false;
  }
  return true;
}

/** Compressed formats are those the native renderer lists, as for 2D
 * images (compressed-upload.ts); any other is INVALID_ENUM. */
function compressedFormatListed(b: GlBinding, format: number): boolean {
  let formats: unknown = null;
  if (!checkedGlCall(b, () => { formats = b.gl!.getParameter(0x86a3); })) return false;
  if (!(ArrayBuffer.isView(formats) || Array.isArray(formats)) || !Array.from(formats as ArrayLike<number>).includes(format)) {
    recordGlError(b, 0x500); return false;
  }
  return true;
}

/** One reused holder: each Uniform* command fills it while validating and
 * consumes it in the same dispatch, so a setter allocates nothing. */
const uniformTarget: GlUniformTarget = { native: null, layout: null };

function dispatch(
  gl: WebGL2RenderingContext,
  b: GlBinding,
  v: DataView,
  p: number,
  op: number,
  destinationOnly = false,
): boolean | void {
  if (uniformUploadOp(op)) {
    runUniformUpload(b,op,v,(original,payload)=>{dispatch(gl,b,payload,0,original);});
    return;
  }
  if (interruptUniformUpload(b)) return;

  const error = stateArgumentError(op, v);
  if (error !== 0) {
    recordGlError(b, error);
    return;
  }
  // GLES 2 format admission precedes target materialization and native calls:
  // WebGL 2 would otherwise accept GLES 3 sized/integer formats.
  const formatError =
    op === O.OP_TEX_IMAGE_2D ? texImageFormatError(gl,v.getUint32(p+8,true),v.getUint32(p+24,true),v.getUint32(p+28,true))
    : op === O.OP_TEX_SUB_IMAGE_2D ? texSubImageFormatError(gl,v.getUint32(p+24,true),v.getUint32(p+28,true))
    : op === O.OP_COPY_TEX_IMAGE_2D ? copyTexImageFormatError(gl,v.getUint32(p+8,true))
    : op === O.OP_RENDERBUFFER_STORAGE ? renderbufferFormatError(gl,v.getUint32(p+4,true)) : 0;
  if (formatError !== 0) {
    recordGlError(b, formatError);
    return;
  }
  // OES_depth_texture and OES_packed_depth_stencil: depth and depth-stencil
  // textures exist only for TEXTURE_2D; any other image target is
  // INVALID_OPERATION (WebGL 2 accepts depth cube maps).
  if ((op === O.OP_TEX_IMAGE_2D || op === O.OP_TEX_SUB_IMAGE_2D) &&
      depthTextureFormat(v.getUint32(p+24,true)) && isCubeFace(v.getUint32(p,true))) {
    recordGlError(b, 0x502);
    return;
  }
  switch (op) {
    case O.OP_TEX_IMAGE_2D: case O.OP_TEX_SUB_IMAGE_2D:
    case O.OP_COPY_TEX_IMAGE_2D: case O.OP_COPY_TEX_SUB_IMAGE_2D:
      if (!prepareTextureOperation(b,v.getUint32(p,true),true,v.getInt32(p+4,true))) return;
      break;
    case O.OP_COMPRESSED_TEX_IMAGE_2D: case O.OP_COMPRESSED_TEX_SUB_IMAGE_2D:
      // Compressed extensions can define different level rules (including
      // negative paletted levels); keep their native format validation separate.
      if (!prepareTextureOperation(b,v.getUint32(p,true),true)) return;
      break;
    case O.OP_TEX_PARAMETERI: case O.OP_TEX_PARAMETERF:
      if (!validGlesTextureParameter(v.getUint32(p+4,true))) { recordGlError(b,0x500); return; }
      // An external texture has no native target (external-texture.ts),
      // and its own value rules.
      if (v.getUint32(p,true) !== TEXTURE_EXTERNAL_OES) {
        if (!prepareTextureOperation(b,v.getUint32(p,true))) return;
        const value = op === O.OP_TEX_PARAMETERI ? v.getInt32(p+8,true) : v.getFloat32(p+8,true);
        if (!predicted(b, texParameterValueError(v.getUint32(p+4,true), value))) return;
      }
      break;
    case O.OP_GENERATE_MIPMAP:
      if (!prepareTextureOperation(b,v.getUint32(p,true))) return;
      break;
  }
  let uniformCount=1;
  if (op >= O.OP_UNIFORM1I && op <= O.OP_UNIFORM_MATRIX3FV) {
    uniformTarget.native=null;uniformTarget.layout=null;
    const count=acceptedUniformCount(b,op,v,p,uniformTarget);
    if(count===null || count===0) return;
    uniformCount=count;
    noteUniformWrite(b.currentProgram);
    // Sampler units, which select depth-sampling variants, change only here.
    if (op === O.OP_UNIFORM1I || op === O.OP_UNIFORM1IV) noteSamplerWrite(b.currentProgram);
  }
  switch (op) {
    // ----- state ----------------------------------------------------------
    case O.OP_CLEAR: {
      if (!requireGlesFramebufferComplete(b)) return;
      // RGB color storage kept as RGBA: the native alpha is never written;
      // sampled siblings of the storage see the write.
      prepareDrawTarget(b);
      gl.clear(v.getUint32(p, true));
      return;
    }
    case O.OP_CLEAR_COLOR: {
      // GL_EXT_color_buffer_half_float issues 5 and 8: the clear color is not
      // clamped when specified (fixed-point buffers clamp when cleared).
      const color = colorClamp(gl);
      b.shadow.clearColor = [
        color(v.getFloat32(p, true)), color(v.getFloat32(p + 4, true)),
        color(v.getFloat32(p + 8, true)), color(v.getFloat32(p + 12, true)),
      ];
      gl.clearColor(...b.shadow.clearColor);
      return;
    }
    case O.OP_VIEWPORT: {
      const maximum = maxViewport(gl);
      b.shadow.viewport = [
        v.getInt32(p, true), v.getInt32(p + 4, true),
        Math.min(v.getInt32(p + 8, true), maximum?.[0] ?? Infinity),
        Math.min(v.getInt32(p + 12, true), maximum?.[1] ?? Infinity),
      ];
      gl.viewport(...b.shadow.viewport);
      return;
    }
    case O.OP_SCISSOR: {
      const x = v.getInt32(p, true);
      const y = v.getInt32(p + 4, true);
      const w = v.getInt32(p + 8, true);
      const h = v.getInt32(p + 12, true);
      gl.scissor(x, y, w, h);
      b.shadow.scissor.rect = [x, y, w, h];
      return;
    }
    // The capability is one of ES 2.0's nine, each a WebGL 2 capability, and
    // glEnable/glDisable's only error is INVALID_ENUM for any other. Native
    // acceptance is therefore known before the call, the shadow is committed
    // with it, and no getError pair is spent per toggle (compositors toggle
    // blending and scissoring around most draws). Flags already pending stay
    // native and owned by this selected context.
    case O.OP_ENABLE: {
      const cap = v.getUint32(p, true);
      if (capabilityEnabled(b,cap) === undefined) { recordGlError(b,0x500); return; }
      gl.enable(cap);
      setCap(b.shadow, cap, true);
      return;
    }
    case O.OP_DISABLE: {
      const cap = v.getUint32(p, true);
      if (capabilityEnabled(b,cap) === undefined) { recordGlError(b,0x500); return; }
      gl.disable(cap);
      setCap(b.shadow, cap, false);
      return;
    }
    case O.OP_BLEND_FUNC:
    case O.OP_BLEND_FUNC_SEPARATE: {
      const separate = op === O.OP_BLEND_FUNC_SEPARATE;
      const srcRGB = v.getUint32(p, true), dstRGB = v.getUint32(p + 4, true);
      const srcA = separate ? v.getUint32(p + 8, true) : srcRGB, dstA = separate ? v.getUint32(p + 12, true) : dstRGB;
      const logical = { srcRGB, dstRGB, srcA, dstA };
      // ES 2.0 table 4.1 allows constant color with constant alpha; WebGL
      // does not, so that RGB source factor is applied by the draw
      // (blend-constant.ts) and the native one is ONE.
      if (!checkedGlCall(b, () => gl.blendFuncSeparate(...nativeBlendFunc(logical)))) return;
      b.shadow.blendFunc = logical;
      updateBlendSourceFactor(b.shadow);
      return;
    }
    case O.OP_BLEND_EQUATION: {
      const mode = v.getUint32(p, true);
      gl.blendEquation(mode);
      b.shadow.blendEquation = { rgb: mode, alpha: mode };
      return;
    }
    case O.OP_BLEND_EQUATION_SEPARATE: {
      const modeRGB = v.getUint32(p, true);
      const modeA = v.getUint32(p + 4, true);
      gl.blendEquationSeparate(modeRGB, modeA);
      b.shadow.blendEquation = { rgb: modeRGB, alpha: modeA };
      return;
    }
    case O.OP_BLEND_COLOR: {
      // Issue 7: the constant blend color is not clamped when specified.
      const color = colorClamp(gl);
      b.shadow.blendColor = [
        color(v.getFloat32(p, true)), color(v.getFloat32(p + 4, true)),
        color(v.getFloat32(p + 8, true)), color(v.getFloat32(p + 12, true)),
      ];
      gl.blendColor(...b.shadow.blendColor);
      updateBlendSourceFactor(b.shadow);
      return;
    }
    case O.OP_CLEAR_DEPTHF:
      b.shadow.clearDepth = Math.min(1, Math.max(0, v.getFloat32(p, true)));
      gl.clearDepth(b.shadow.clearDepth);
      return;
    case O.OP_CLEAR_STENCIL:
      b.shadow.clearStencil = v.getInt32(p, true);
      gl.clearStencil(b.shadow.clearStencil);
      return;
    case O.OP_COLOR_MASK:
      b.shadow.colorMask = [
        v.getUint32(p, true) !== 0,
        v.getUint32(p + 4, true) !== 0,
        v.getUint32(p + 8, true) !== 0,
        v.getUint32(p + 12, true) !== 0,
      ];
      gl.colorMask(...nativeColorMask(b.shadow));
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
      b.shadow.lineWidth = v.getFloat32(p, true);
      gl.lineWidth(b.shadow.lineWidth);
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
      b.shadow.polygonOffset = [v.getFloat32(p, true), v.getFloat32(p + 4, true)];
      gl.polygonOffset(...b.shadow.polygonOffset);
      return;
    case O.OP_DEPTH_RANGEF: {
      // ES 2.0 section 2.5: a command that generates an error has no effect,
      // so the shadow (replayed by the muxer) changes only after acceptance.
      // ES 2.0 section 2.12.1 permits n > f; WebGL does not. The native range
      // is the ordered pair and reversed draws run a z-negating twin
      // executable (reversed-depth.ts), so the shadow keeps the logical pair.
      const range = [v.getFloat32(p, true), v.getFloat32(p + 4, true)].map(clampUnit) as [number, number];
      if (!checkedGlCall(b, () => gl.depthRange(...nativeDepthRange(range)))) return;
      b.shadow.depthRange = range;
      return;
    }
    case O.OP_SAMPLE_COVERAGE:
      b.shadow.sampleCoverage = [Math.min(1, Math.max(0, v.getFloat32(p, true))), v.getUint32(p + 4, true) !== 0];
      gl.sampleCoverage(...b.shadow.sampleCoverage);
      return;
    case O.OP_PIXEL_STOREI: {
      const pname = v.getUint32(p, true);
      const param = v.getInt32(p + 4, true);
      gl.pixelStorei(pname, param);
      // stateArgumentError admitted only the two alignments.
      if (pname === GL_UNPACK_ALIGNMENT) b.shadow.unpackAlignment = param;
      else b.shadow.packAlignment = param;
      return;
    }

    // ----- buffers --------------------------------------------------------
    // Payload: u32 n, u32 names[n]
    // Name reservations belong to the C namespace owner. GPU objects acquire
    // state on first bind; a delayed reservation must never recreate or
    // replace an object already realized (or deleted) by a sharing peer.
    case O.OP_GEN_BUFFERS: return;

    case O.OP_DELETE_BUFFERS: {
      const n = v.getUint32(p, true);
      deleteBufferNames(b,Array.from({length:n},(_,i) => v.getUint32(p+4+i*4,true)));
      return;
    }
    case O.OP_BEGIN_CLIENT_ARRAY:
      beginClientArray(b); return;
    case O.OP_END_CLIENT_ARRAY:
      endClientArray(b); return;
    case O.OP_BIND_BUFFER:
      bindBufferObject(b,v.getUint32(p,true),v.getUint32(p+4,true));
      return;
    // Payload: u32 target, u32 dataLen, u8 data[dataLen], u32 usage
    case O.OP_BUFFER_DATA: {
      const target = v.getUint32(p, true);
      const byteLength = v.getUint32(p + 4, true);
      if (v.byteLength === 12) {
        const usage = v.getUint32(p + 8, true);
        replaceBufferData(b,target,byteLength,usage);
      } else {
        const usage = v.getUint32(p + 8 + byteLength, true);
        const data = copyBytes(v, p + 8, byteLength);
        replaceBufferData(b,target,data,usage);
      }
      return;
    }
    // Payload: u32 target, i32 dstOffset, u32 dataLen, u8 data[dataLen]
    case O.OP_BUFFER_SUB_DATA: {
      const target = v.getUint32(p, true);
      const dstOff = v.getInt32(p + 4, true);
      const dataLen = v.getUint32(p + 8, true);
      const data = copyBytes(v, p + 12, dataLen);
      updateBufferData(b,target,dstOff,data);
      return;
    }

    // ----- textures -------------------------------------------------------
    case O.OP_GEN_TEXTURES: return;

    case O.OP_DELETE_TEXTURES: {
      const n = v.getUint32(p, true);
      for (let i = 0; i < n; i++) {
        const name = v.getUint32(p + 4 + i * 4, true);
        deleteTextureName(b,name);
      }
      return;
    }
    case O.OP_BIND_TEXTURE: {
      bindImageObject(b,1,v.getUint32(p,true),v.getUint32(p+4,true));
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
      const type = normalizeTextureType(v.getUint32(p + 28, true));
      const dataLen = v.getUint32(p + 32, true);
      // Luminance/alpha float levels are stored as expanded RGBA (see
      // luminance-float.ts); every other admitted triple maps directly.
      const expanded = expandedFloatFormat(format, type);
      // WebGL refuses client data shorter than the upload reads.
      if (dataLen !== 0 && !expanded &&
          !predicted(b, uploadSizeError(uploadBytes(width, height, format, type, b.shadow.unpackAlignment), dataLen))) return false;
      let data: ArrayBufferView | null = null;
      if (dataLen !== 0) {
        data = expanded
          ? expandedUpload(b, format, type, copyBytes(v, p + 36, dataLen), width, height)
          : copyPixels(v, p + 36, dataLen, type);
        if (!data) return false;
      }
      const native = expanded ? expandedNative(type)
        : { internal: normalizeTextureInternalFormat(internalFormat, format, type), format };
      // A cube face is a layer of the cube's 2D array storage (cube-storage.ts).
      const cube = isCubeFace(target);
      if (cube && (!cubeImageSizeValid(b, level, width, height, border) || !prepareCubeRespecification(b))) return false;
      if (!cube && !texImageSizeValid(b, level, width, height, border)) return false;
      const accepted = cube
        ? cubeSpecifyImage(b, target, level, { size: width, internalFormat: native.internal, format: native.format, type, compressed: false },
          data === null ? null : layer => gl.texSubImage3D(TEXTURE_2D_ARRAY, level, 0, 0, layer, width, height, 1, native.format, type, data),
          { inPlace: true })
        : imageTextureOperation(b,target,true,()=>gl.texImage2D(
          target, level, native.internal, width, height, border, native.format, type, data,
        ),level!==0,level);
      if (accepted) {
        recordTextureLevel(boundTextureObject(b,target),target,level,
          {width,height,internalFormat:native.internal,format:native.format,type,compressed:false,
            gles:{internalFormat,format,type,expanded,
              colorRenderable:textureColorRenderable(internalFormat,format,type,glesExtensionAdvertised(gl,"GL_EXT_color_buffer_half_float")),
              depth:depthTextureFormat(format),stencil:format===0x84f9}});
        if (cube) cubeImagesChanged(b);
      }
      return accepted;
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
      const type = normalizeTextureType(v.getUint32(p + 28, true));
      const dataLen = v.getUint32(p + 32, true);
      // GLES 2 performs no format conversion. An expanded level accepts only
      // its own logical format/type, and an expanded format reaches only such
      // a level; the RGBA stand-in would otherwise accept RGBA data natively.
      const expanded = expandedFloatFormat(format, type);
      const logical = textureLevel(boundTextureObject(b,target)!,target,level)?.gles;
      if ((expanded || logical?.expanded) && (!logical?.expanded || logical.format !== format || logical.type !== type)) {
        recordGlError(b,0x502); return false;
      }
      // OES_packed_depth_stencil 3.8.1: depth data only for depth levels, and
      // depth levels only from depth data.
      if (logical && logical.depth !== depthTextureFormat(format)) { recordGlError(b,0x502); return false; }
      // OES_depth_texture issue 3: the type only selects the bits supplied.
      // WebGL 2 stores 32-bit depth as DEPTH_COMPONENT24, which accepts only
      // UNSIGNED_INT, so 16-bit data is widened exactly (c * 65537).
      const widenDepth = logical?.format === 0x1902 && logical.type === 0x1405 && format === 0x1902 && type === 0x1403;
      const nativeType = widenDepth ? 0x1405 : type;
      const nativeFormat = expanded ? expandedNative(type).format : format;
      let data: ArrayBufferView | null;
      if (expanded && dataLen !== 0) {
        data = expandedUpload(b, format, type, copyBytes(v, p + 36, dataLen), width, height);
        if (!data) return false;
      } else if (widenDepth && dataLen !== 0) {
        data = widenedDepthUpload(b, copyBytes(v, p + 36, dataLen), width, height);
        if (!data) return false;
      } else {
        // WebGL refuses client data shorter than the upload reads.
        if (!destinationOnly && !predicted(b, uploadSizeError(
          uploadBytes(width, height, nativeFormat, nativeType, b.shadow.unpackAlignment), dataLen))) return false;
        data = copyPixels(v, p + 36, dataLen, nativeType);
      }
      if (destinationOnly) {
        // GLES 2.0 section 3.7.2 bounds are x>=0, y>=0, x+w<=wt, y+h<=ht.
        // A zero-area native update at the checked endpoint validates the same
        // destination without writing texels or reading a caller pixel pointer.
        // Source layout is validated when the actual packed rows are submitted.
        const endX = xoff + width, endY = yoff + height;
        if (xoff < 0 || yoff < 0 || width < 0 || height < 0 ||
            endX > 0x7fff_ffff || endY > 0x7fff_ffff) {
          recordGlError(b,0x501); return false;
        }
        if (!subImageValid(b, target, level, xoff, yoff, width, height)) return false;
        let unpackBuffer: WebGLBuffer | null = null;
        if (!checkedGlCall(b,()=>{ unpackBuffer=gl.getParameter(0x88ef); })) return false;
        if (isCubeFace(target)) return cubeUpdateImage(b,target,level,layer=>{
          if (unpackBuffer) gl.texSubImage3D(TEXTURE_2D_ARRAY,level,endX,endY,layer,0,0,1,nativeFormat,nativeType,0);
          else gl.texSubImage3D(TEXTURE_2D_ARRAY,level,endX,endY,layer,0,0,1,nativeFormat,nativeType,data);
        });
        return imageTextureOperation(b,target,false,()=>{
          // WebGL2 requires the offset overload exactly when a real unpack
          // buffer is bound. Neither branch changes that binding or reads data.
          if (unpackBuffer) gl.texSubImage2D(target,level,endX,endY,0,0,nativeFormat,nativeType,0);
          else gl.texSubImage2D(target,level,endX,endY,0,0,nativeFormat,nativeType,data);
        });
      }
      if (isCubeFace(target)) {
        // Negative values are INVALID_VALUE before an undefined image's
        // INVALID_OPERATION, as for the native call.
        if (xoff < 0 || yoff < 0 || width < 0 || height < 0) { recordGlError(b,0x501); return false; }
        if (!subImageValid(b, target, level, xoff, yoff, width, height)) return false;
        return cubeUpdateImage(b,target,level,layer=>gl.texSubImage3D(
          TEXTURE_2D_ARRAY, level, xoff, yoff, layer, width, height, 1, nativeFormat, nativeType, data));
      }
      if (!subImageValid(b, target, level, xoff, yoff, width, height)) return false;
      return imageTextureOperation(b,v.getUint32(p,true),false,()=>gl.texSubImage2D(
        target, level, xoff, yoff, width, height, nativeFormat, nativeType, data,
      ));
    }
    case O.OP_TEX_PARAMETERI:
      if (v.getUint32(p, true) === TEXTURE_EXTERNAL_OES) {
        externalTexParameter(b, v.getUint32(p + 4, true), v.getInt32(p + 8, true));
        return;
      }
      // Filters are tracked for ES 2.0's switch-over point (lod-switchover.ts).
      if (v.getUint32(p, true) === 0x8513) {
        if (cubeTexParameter(b, v.getUint32(p + 4, true), target => gl.texParameteri(target, v.getUint32(p + 4, true), v.getInt32(p + 8, true))))
          noteTextureFilter(boundTextureObject(b, 0x8513), v.getUint32(p + 4, true), v.getInt32(p + 8, true));
        return;
      }
      gl.texParameteri(
        v.getUint32(p, true),
        v.getUint32(p + 4, true),
        v.getInt32(p + 8, true),
      );
      noteTextureFilter(boundTextureObject(b, v.getUint32(p, true)), v.getUint32(p + 4, true), v.getInt32(p + 8, true));
      return;
    case O.OP_TEX_PARAMETERF:
      // An external texture's parameters are enums, which a float names
      // after conversion to the nearest integer (ES 2.0 section 2.3.1).
      if (v.getUint32(p, true) === TEXTURE_EXTERNAL_OES) {
        externalTexParameter(b, v.getUint32(p + 4, true), Math.round(v.getFloat32(p + 8, true)));
        return;
      }
      if (v.getUint32(p, true) === 0x8513) {
        if (cubeTexParameter(b, v.getUint32(p + 4, true), target => gl.texParameterf(target, v.getUint32(p + 4, true), v.getFloat32(p + 8, true))))
          noteTextureFilter(boundTextureObject(b, 0x8513), v.getUint32(p + 4, true), v.getFloat32(p + 8, true));
        return;
      }
      gl.texParameterf(
        v.getUint32(p, true),
        v.getUint32(p + 4, true),
        v.getFloat32(p + 8, true),
      );
      noteTextureFilter(boundTextureObject(b, v.getUint32(p, true)), v.getUint32(p + 4, true), v.getFloat32(p + 8, true));
      return;
    case O.OP_ACTIVE_TEXTURE: {
      const unit = v.getUint32(p, true);
      const index = unit - GL_TEXTURE0;
      if (index < 0 || index >= combinedTextureUnits(gl)) {
        recordGlError(b, 0x500); // INVALID_ENUM
        return;
      }
      gl.activeTexture(unit);
      b.shadow.activeTexture = index;
      while (b.shadow.textureUnits.length <= index) b.shadow.textureUnits.push(null);
      while (b.shadow.cubeTextureUnits.length <= index) b.shadow.cubeTextureUnits.push(null);
      while (b.shadow.externalTextureUnits.length <= index) b.shadow.externalTextureUnits.push(null);
      return;
    }
    case O.OP_GENERATE_MIPMAP: {
      const target = v.getUint32(p,true);
      // OES_depth_texture issue 1 (resolution b): GenerateMipmap on a depth
      // texture is INVALID_OPERATION. Depth textures are 2D only.
      if (target === 0x0de1 && textureLevel(boundTextureObject(b,target)!,target,0)?.gles?.depth) {
        recordGlError(b,0x502); return;
      }
      if (target === 0x8513) {
        if (prepareCubeRespecification(b) && cubeGenerateMipmap(b)) {
          recordGeneratedMipmaps(boundTextureObject(b,target),target);
          cubeImagesChanged(b);
        }
        return;
      }
      if (imageTextureOperation(b,target,true,()=>gl.generateMipmap(target)))
        recordGeneratedMipmaps(boundTextureObject(b,target),target);
      return;
    }
    case O.OP_COMPRESSED_TEX_IMAGE_2D: {
      const dataLen = v.getUint32(p + 24, true);
      const data = copyBytes(v, p + 28, dataLen);
      const target = v.getUint32(p, true), level = v.getInt32(p + 4, true);
      const internalFormat = v.getUint32(p + 8, true);
      const width = v.getInt32(p + 12, true), height = v.getInt32(p + 16, true);
      const cube = isCubeFace(target);
      if (cube && (!compressedFormatListed(b, internalFormat) || !cubeImageSizeValid(b, level, width, height, v.getInt32(p + 20, true))
          || !prepareCubeRespecification(b))) return;
      if (cube ? cubeSpecifyImage(b, target, level, { size: width, internalFormat, format: internalFormat, type: 0, compressed: true },
          layer => gl.compressedTexSubImage3D(TEXTURE_2D_ARRAY, level, 0, 0, layer, width, height, 1, internalFormat, data),
          { inPlace: true, compressedBytes: dataLen })
        : imageTextureOperation(b,target,true,()=>gl.compressedTexImage2D(
        target, level, internalFormat, width, height,
        v.getInt32(p + 20, true),
        data,
      ),level!==0,level)) {
        // ES 2.0 section 4.4.5: compressed formats are not color-renderable.
        recordTextureLevel(boundTextureObject(b,target),target,level,
          {width,height,internalFormat,format:internalFormat,type:0,compressed:true,
            gles:{internalFormat,format:internalFormat,type:0,expanded:false,colorRenderable:false,depth:false,stencil:false}});
        if (cube) cubeImagesChanged(b);
      }
      return;
    }
    case O.OP_COMPRESSED_TEX_SUB_IMAGE_2D: {
      const dataLen = v.getUint32(p + 28, true);
      const data = copyBytes(v, p + 32, dataLen);
      if (isCubeFace(v.getUint32(p, true))) {
        const level = v.getInt32(p + 4, true), format = v.getUint32(p + 24, true);
        if (compressedFormatListed(b, format))
          cubeUpdateImage(b, v.getUint32(p, true), level, layer => gl.compressedTexSubImage3D(TEXTURE_2D_ARRAY, level,
            v.getInt32(p + 8, true), v.getInt32(p + 12, true), layer, v.getInt32(p + 16, true), v.getInt32(p + 20, true), 1, format, data));
        return;
      }
      imageTextureOperation(b,v.getUint32(p,true),false,()=>gl.compressedTexSubImage2D(
        v.getUint32(p, true),
        v.getInt32(p + 4, true),
        v.getInt32(p + 8, true),
        v.getInt32(p + 12, true),
        v.getInt32(p + 16, true),
        v.getInt32(p + 20, true),
        v.getUint32(p + 24, true),
        data,
      ));
      return;
    }
    case O.OP_COPY_TEX_IMAGE_2D: {
      if (!requireGlesFramebufferComplete(b,true)) return;
      const target = v.getUint32(p, true), level = v.getInt32(p + 4, true);
      const internalFormat = v.getUint32(p + 8, true);
      const width = v.getInt32(p + 20, true), height = v.getInt32(p + 24, true);
      // A cube face is a layer of the cube's 2D array storage
      // (cube-storage.ts): the copied format (sized for RED and RG, which
      // WebGL 2 has no unsized form of) is allocated, then copied into.
      const cube = isCubeFace(target);
      if (cube && (!cubeImageSizeValid(b, level, width, height, v.getInt32(p + 28, true)) || !prepareCubeRespecification(b))) return;
      if (!cube && !texImageSizeValid(b, level, width, height, v.getInt32(p + 28, true))) return;
      const nativeInternal = cube ? normalizeTextureInternalFormat(internalFormat, internalFormat, GL_UNSIGNED_BYTE) : internalFormat;
      // ES 2.0 copies take an unsized internal format from the framebuffer;
      // a multisampled default framebuffer supplies its resolved values.
      if (withMultisampleRead(b,()=>cube
        ? cubeSpecifyImage(b, target, level, { size: width, internalFormat: nativeInternal, format: internalFormat, type: GL_UNSIGNED_BYTE, compressed: false },
          layer => gl.copyTexSubImage3D(TEXTURE_2D_ARRAY, level, 0, 0, layer, v.getInt32(p + 12, true), v.getInt32(p + 16, true), width, height),
          { inPlace: false })
        : imageTextureOperation(b,target,true,()=>gl.copyTexImage2D(
        target, level, internalFormat,
        v.getInt32(p + 12, true),
        v.getInt32(p + 16, true),
        width, height,
        v.getInt32(p + 28, true),
      ),level!==0,level))) {
        recordTextureLevel(boundTextureObject(b,target),target,level,
          {width,height,internalFormat:nativeInternal,format:internalFormat,type:0x1401,compressed:false,
            gles:{internalFormat,format:internalFormat,type:0x1401,expanded:false,
              colorRenderable:copiedTextureColorRenderable(internalFormat),depth:false,stencil:false}});
        if (cube) cubeImagesChanged(b);
      }
      return;
    }
    case O.OP_COPY_TEX_SUB_IMAGE_2D:
      if (!requireGlesFramebufferComplete(b,true)) return;
      // OES_depth_texture: CopyTexSubImage2D is not supported for depth
      // levels; the color read buffer has no components for them.
      if (textureLevel(boundTextureObject(b,v.getUint32(p,true))!,v.getUint32(p,true),v.getInt32(p+4,true))?.gles?.depth) {
        recordGlError(b,0x502); return;
      }
      if (!subImageValid(b, v.getUint32(p,true), v.getInt32(p+4,true), v.getInt32(p+8,true), v.getInt32(p+12,true),
          v.getInt32(p+24,true), v.getInt32(p+28,true))) return;
      if (isCubeFace(v.getUint32(p,true))) {
        withMultisampleRead(b,()=>cubeUpdateImage(b,v.getUint32(p,true),v.getInt32(p+4,true),layer=>gl.copyTexSubImage3D(
          TEXTURE_2D_ARRAY, v.getInt32(p+4,true), v.getInt32(p+8,true), v.getInt32(p+12,true), layer,
          v.getInt32(p+16,true), v.getInt32(p+20,true), v.getInt32(p+24,true), v.getInt32(p+28,true))));
        return;
      }
      withMultisampleRead(b,()=>imageTextureOperation(b,v.getUint32(p,true),false,()=>gl.copyTexSubImage2D(
        v.getUint32(p, true),
        v.getInt32(p + 4, true),
        v.getInt32(p + 8, true),
        v.getInt32(p + 12, true),
        v.getInt32(p + 16, true),
        v.getInt32(p + 20, true),
        v.getInt32(p + 24, true),
        v.getInt32(p + 28, true),
      )));
      return;

    // ----- shaders / programs --------------------------------------------
    // Payload: u32 type, u32 cmdbufName
    case O.OP_CREATE_SHADER: {
      const type = v.getUint32(p, true);
      const name = v.getUint32(p + 4, true);
      createShaderIfAccepted(b,type,name);
      return;
    }
    // Payload: u32 cmdbufName, u32 srcLen, u8 src[srcLen] (UTF-8)
    case O.OP_SHADER_SOURCE: {
      const name = v.getUint32(p, true);
      const srcLen = v.getUint32(p + 4, true);
      // [RUNTIME-WORKAROUND: CHROMIUM-TEXTDECODER-REJECTS-SHARED-VIEWS] Suspected engine defect; the copy below is the workaround.
      // The copy also guards against memory grow/detach, so it stays even if the engine is fixed.
      // TextDecoder rejects views over SharedArrayBuffer, which the
      // cmdbuf is when the user program runs against shared memory
      // (the wasm-posix-kernel default). Copy into a fresh
      // Uint8Array — also detaches from SAB grow races.
      const srcBytes = new Uint8Array(srcLen);
      srcBytes.set(new Uint8Array(v.buffer, v.byteOffset + p + 8, srcLen));
      const sh = b.shaders.get(name);
      if (!sh) { recordGlError(b,b.programs.has(name) ? 0x502 : 0x501); return; }
      b.shaderUpload = null;
      installShaderSource(b,sh,srcBytes);
      return;
    }
    case O.OP_COMPILE_SHADER: {
      const sh = requireShaderObject(b, v.getUint32(p, true));
      if (!sh) return;
      // The ES 1.00 compile judges the shader; one rejected only for GLSL ES
      // 1.00 Appendix A limits compiles as ESSL 3.00 (essl3-translation.ts).
      // Twins and private executables rebuild from the ES 1.00 source.
      const native = nativeShaderSource(sh), source = native?.text ?? "";
      let language: ShaderLanguage | null = null, fragment = false;
      if (checkedGlCall(b, () => {
        fragment = Number(gl.getShaderParameter(sh, 0x8b4f)) === 0x8b30;
        language = compileGuestShader(gl, sh, source, fragment);
      })) {
        recordCompiledShader(sh, native ? source : undefined);
        recordCompiledExternalSamplers(sh, native?.samplers);
        recordShaderLanguage(sh, language, source, fragment);
      }
      return;
    }
    case O.OP_VALIDATE_PROGRAM: {
      const name = v.getUint32(p,true), program = b.programs.get(name);
      if (!program) { recordGlError(b,b.shaders.has(name) ? 0x502 : 0x501); return; }
      if (checkedGlCall(b, () => gl.validateProgram(program))) {
        validateExternalSamplers(b, program);
        // [RUNTIME-WORKAROUND: FIREFOX-VALIDATE-UNLINKED-PROGRAM]
        recordProgramValidation(b, program);
      }
      return;
    }
    case O.OP_DELETE_SHADER: {
      const name = v.getUint32(p, true);
      const sh = b.shaders.get(name);
      if (!sh) { if (name !== 0) recordGlError(b, 0x501); return; }
      if (!b.shaderDeletePending.has(name)) {
        // Keep the native shader attachable while logical programs retain
        // it, including a replacement native program for current relinking.
        b.shaderDeletePending.add(name);
        finalizeShader(b, name);
      }
      return;
    }
    case O.OP_CREATE_PROGRAM: {
      const name = v.getUint32(p, true);
      createProgramIfAccepted(b,name);
      return;
    }
    case O.OP_ATTACH_SHADER: {
      const programName = v.getUint32(p, true), shaderName = v.getUint32(p + 4, true);
      const prog = requireProgramObject(b, programName);
      if (!prog) return;
      const sh = requireShaderObject(b, shaderName);
      if (!sh) return;
      if (b.programShaders.get(programName)?.has(shaderName)) { recordGlError(b, 0x502); return; }
      const attachedTypes = [...b.programShaders.get(programName) ?? []].map(name => shaderType(b.shaders.get(name)));
      if (!predicted(b, attachShaderError(attachedTypes, shaderType(sh)))) return;
      // Aliasing executables keep attachments logical (attribute-aliasing.ts).
      if (attributeAliasLayout(prog) || checkedGlCall(b, () => gl.attachShader(prog, sh))) {
        let attached = b.programShaders.get(programName);
        if (!attached) { attached = new Set(); b.programShaders.set(programName, attached); }
        attached.add(shaderName);
      }
      return;
    }
    case O.OP_LINK_PROGRAM: {
      linkProgramRetainingExecutable(b, v.getUint32(p, true));
      return;
    }
    case O.OP_USE_PROGRAM: {
      useProgramIfAccepted(b, v.getUint32(p, true));
      return;
    }
    // Payload: u32 program, u32 index, u32 nameLen, u8 name[nameLen]
    case O.OP_BIND_ATTRIB_LOCATION: {
      const programName = v.getUint32(p, true);
      const prog = requireProgramObject(b, programName);
      if (!prog) return;
      const index = v.getUint32(p + 4, true);
      const nameLen = v.getUint32(p + 8, true);
      // [RUNTIME-WORKAROUND: CHROMIUM-TEXTDECODER-REJECTS-SHARED-VIEWS] Suspected engine defect; the copy below is the workaround.
      // Copy off the (possibly shared) cmdbuf — TextDecoder rejects
      // views over SharedArrayBuffer.
      const nameBytes = new Uint8Array(nameLen);
      nameBytes.set(new Uint8Array(v.buffer, v.byteOffset + p + 12, nameLen));
      const name = new TextDecoder().decode(nameBytes);
      if (!predicted(b, bindAttribLocationError(index, predictionLimit(gl, MAX_VERTEX_ATTRIBS), name))) return;
      if (checkedGlCall(b, () => gl.bindAttribLocation(prog, index, name))) {
        let attributes = b.programAttributeBindings.get(programName);
        if (!attributes) { attributes = new Map(); b.programAttributeBindings.set(programName, attributes); }
        attributes.set(name, index);
      }
      return;
    }
    case O.OP_DELETE_PROGRAM: {
      const name = v.getUint32(p, true);
      const prog = b.programs.get(name);
      if (!prog) { if (name !== 0) recordGlError(b, 0x501); return; }
      b.programDeletePending.add(name);
      finalizeProgram(b, name);
      return;
    }
    case O.OP_DETACH_SHADER: {
      const programName = v.getUint32(p, true), shaderName = v.getUint32(p + 4, true);
      const prog = requireProgramObject(b, programName);
      if (!prog) return;
      const sh = requireShaderObject(b, shaderName);
      if (!sh) return;
      if (!b.programShaders.get(programName)?.has(shaderName)) { recordGlError(b, 0x502); return; }
      if (attributeAliasLayout(prog) || checkedGlCall(b, () => gl.detachShader(prog, sh))) {
        b.programShaders.get(programName)!.delete(shaderName);
        finalizeShader(b, shaderName);
      }
      return;
    }

    // ----- uniforms -------------------------------------------------------
    // Locations are per-program indices (uniform-layout.ts); the accepted
    // command's native location was resolved by acceptedUniformCount.
    case O.OP_UNIFORM1I: {
      const loc = uniformTarget.native;
      gl.uniform1i(loc, v.getInt32(p + 4, true));
      return;
    }
    case O.OP_UNIFORM1F: {
      const loc = uniformTarget.native;
      gl.uniform1f(loc, v.getFloat32(p + 4, true));
      return;
    }
    case O.OP_UNIFORM2F: {
      const loc = uniformTarget.native;
      gl.uniform2f(loc, v.getFloat32(p + 4, true), v.getFloat32(p + 8, true));
      return;
    }
    case O.OP_UNIFORM3F: {
      const loc = uniformTarget.native;
      gl.uniform3f(
        loc,
        v.getFloat32(p + 4, true),
        v.getFloat32(p + 8, true),
        v.getFloat32(p + 12, true),
      );
      return;
    }
    case O.OP_UNIFORM4F: {
      const loc = uniformTarget.native;
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
      const loc = uniformTarget.native;
      const count = uniformCount;
      const transpose = v.getUint32(p + 8, true) !== 0;
      gl.uniformMatrix4fv(loc, transpose, floatsAt(v, p + 12, count * 16));
      return;
    }
    // Payload: i32 location, u32 count, f32 v[count*4]
    case O.OP_UNIFORM4FV: {
      const loc = uniformTarget.native;
      const count = uniformCount;
      gl.uniform4fv(loc, floatsAt(v, p + 8, count * 4));
      return;
    }
    case O.OP_UNIFORM1FV: {
      const loc = uniformTarget.native;
      const count = uniformCount;
      gl.uniform1fv(loc, copyFloat32Array(v, p + 8, count));
      return;
    }
    case O.OP_UNIFORM2FV: {
      const loc = uniformTarget.native;
      const count = uniformCount;
      gl.uniform2fv(loc, copyFloat32Array(v, p + 8, count * 2));
      return;
    }
    case O.OP_UNIFORM3FV: {
      const loc = uniformTarget.native;
      const count = uniformCount;
      gl.uniform3fv(loc, copyFloat32Array(v, p + 8, count * 3));
      return;
    }
    case O.OP_UNIFORM1IV: {
      const loc = uniformTarget.native;
      const count = uniformCount;
      const values = copyInt32Array(v, p + 8, count);
      gl.uniform1iv(loc, values);
      return;
    }
    case O.OP_UNIFORM2IV: {
      const loc = uniformTarget.native;
      const count = uniformCount;
      gl.uniform2iv(loc, copyInt32Array(v, p + 8, count * 2));
      return;
    }
    case O.OP_UNIFORM3IV: {
      const loc = uniformTarget.native;
      const count = uniformCount;
      gl.uniform3iv(loc, copyInt32Array(v, p + 8, count * 3));
      return;
    }
    case O.OP_UNIFORM4IV: {
      const loc = uniformTarget.native;
      const count = uniformCount;
      gl.uniform4iv(loc, copyInt32Array(v, p + 8, count * 4));
      return;
    }
    case O.OP_UNIFORM_MATRIX2FV: {
      const loc = uniformTarget.native;
      const count = uniformCount;
      const transpose = v.getUint32(p + 8, true) !== 0;
      gl.uniformMatrix2fv(loc, transpose, copyFloat32Array(v, p + 12, count * 4));
      return;
    }
    case O.OP_UNIFORM_MATRIX3FV: {
      const loc = uniformTarget.native;
      const count = uniformCount;
      const transpose = v.getUint32(p + 8, true) !== 0;
      gl.uniformMatrix3fv(loc, transpose, copyFloat32Array(v, p + 12, count * 9));
      return;
    }

    // ----- vertex attribs / draws -----------------------------------------
    // The only error is INVALID_VALUE for an index at or past the native
    // MAX_VERTEX_ATTRIBS. Below the limit already read from this renderer the
    // call is accepted, as for OP_ENABLE; otherwise the native answer decides.
    case O.OP_ENABLE_VERTEX_ATTRIB_ARRAY: {
      const index = v.getUint32(p,true);
      if (index >= knownVertexAttributeLimit(gl)) {
        const attributes = predictionLimit(gl, MAX_VERTEX_ATTRIBS);
        if (attributes === null) { if (!checkedGlCall(b, () => gl.enableVertexAttribArray(index))) return; }
        else if (!predicted(b, vertexAttribIndexError(index, attributes))) return;
        else gl.enableVertexAttribArray(index);
      } else gl.enableVertexAttribArray(index);
      activeVertexArray(b).attributes.set(index,{...vertexAttribute(b,index),enabled:true});
      return;
    }
    case O.OP_DISABLE_VERTEX_ATTRIB_ARRAY: {
      const index = v.getUint32(p,true);
      if (index >= knownVertexAttributeLimit(gl)) {
        const attributes = predictionLimit(gl, MAX_VERTEX_ATTRIBS);
        if (attributes === null) { if (!checkedGlCall(b, () => gl.disableVertexAttribArray(index))) return; }
        else if (!predicted(b, vertexAttribIndexError(index, attributes))) return;
        else gl.disableVertexAttribArray(index);
      } else gl.disableVertexAttribArray(index);
      activeVertexArray(b).attributes.set(index,{...vertexAttribute(b,index),enabled:false});
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
      const attribute = {buffer:b.shadow.arrayBuffer && canonicalBuffer(b,b.shadow.arrayBuffer),enabled:vertexAttribute(b,index).enabled,
        size,type,normalized,stride,offset:off};
      const vao = activeVertexArray(b);
      let attributes: typeof vao.attributes;
      try { attributes = new Map(vao.attributes); attributes.set(index,attribute); }
      catch (caught) { rethrowNativeGlFault(caught); recordGlError(b,0x505); return; }
      if (!installVertexAttribute(b,index,attribute)) return;
      vao.attributes = attributes;
      return;
    }
    case O.OP_DRAW_CLIENT_ARRAYS:
      drawPrivateClientArrays(b,v); return;
    case O.OP_DRAW_ARRAYS:
      if (b.savedClientArrayBuffer !== undefined) { recordGlError(b,0x502); return; }
      if (v.getUint32(p,true) > 6) { recordGlError(b,0x500); return; }
      if (v.getInt32(p+4,true) < 0 || v.getInt32(p+8,true) < 0) { recordGlError(b,0x501); return; }
      if (!requireGlesFramebufferComplete(b) || !validateDrawFramebufferWithoutProgram(b)) return;
      if (!prepareBufferDraw(b,false)||!prepareImageDraw(b)) return;
      issueGlesDraw(b,{mode:v.getUint32(p,true),empty:v.getInt32(p+8,true) === 0,observed:false,
        issue:() => gl.drawArrays(v.getUint32(p,true),v.getInt32(p+4,true),v.getInt32(p+8,true)),
        vertices:() => sequentialVertices(v.getInt32(p+4,true),v.getInt32(p+8,true)),
        maxVertex:v.getInt32(p+4,true)+v.getInt32(p+8,true)-1});
      return;
    case O.OP_DRAW_ELEMENTS:
      if (b.savedClientArrayBuffer !== undefined) { recordGlError(b,0x502); return; }
      if(!prepareImageDraw(b))return;
      drawGlesElements(b,v.getUint32(p,true),v.getInt32(p+4,true),v.getUint32(p+8,true),v.getUint32(p+12,true));
      return;
    // Payload: u32 index, f32 x, f32 y, f32 z, f32 w
    case O.OP_VERTEX_ATTRIB_4FV:
      installVertexConstant(b,v.getUint32(p,true),v.getFloat32(p+4,true),v.getFloat32(p+8,true),
        v.getFloat32(p+12,true),v.getFloat32(p+16,true));
      return;

    // ----- VAOs -----------------------------------------------------------
    case O.OP_GEN_VERTEX_ARRAYS: {
      const n = v.getUint32(p, true);
      for (let i = 0; i < n; i++) {
        const name = v.getUint32(p + 4 + i * 4, true);
        if (!name || b.vaos.has(name)) { recordGlError(b,0x502); continue; }
        let vao: WebGLVertexArrayObject | null = null;
        if (checkedGlCall(b, () => { vao = gl.createVertexArray(); }) && vao) {
          b.vaos.set(name,vao); b.vertexArrays.set(name,defaultVertexArray());
        } else recordGlError(b,0x505);
      }
      return;
    }
    case O.OP_DELETE_VERTEX_ARRAYS: {
      const n = v.getUint32(p, true);
      for (let i = 0; i < n; i++) {
        const name = v.getUint32(p + 4 + i * 4, true);
        const obj = b.vaos.get(name);
        if (obj && !checkedGlCall(b, () => gl.deleteVertexArray(obj))) continue;
        if (obj && name === b.vertexArrayId) {
          gl.bindVertexArray(b.shadow.defaultVao);
          b.shadow.vao = null; b.vertexArrayId = 0;
        }
        b.vaos.delete(name);
        if (name) b.vertexArrays.delete(name);
      }
      return;
    }
    case O.OP_BIND_VERTEX_ARRAY: {
      const name = v.getUint32(p,true), vao = b.vaos.get(name) ?? null;
      if (name !== 0 && !vao) { recordGlError(b,0x502); return; }
      // Vertex array 0 is this binding's own default (see GlShadowState).
      if (!checkedGlCall(b, () => gl.bindVertexArray(vao ?? b.shadow.defaultVao))) return;
      b.shadow.vao = vao;
      b.vertexArrayId = name;
      activeVertexArray(b);
      return;
    }

    // ----- framebuffers / renderbuffers -----------------------------------
    // A generated name is not a framebuffer until its first bind (ES 2.0
    // section 4.4.1), which bindFramebufferObject realizes. Creating one here
    // would also replace an object a bind already created for that name,
    // orphaning it and its attachments. The encoder owns name reservation.
    case O.OP_GEN_FRAMEBUFFERS: return;
    case O.OP_DELETE_FRAMEBUFFERS: {
      const n = v.getUint32(p, true);
      for (let i = 0; i < n; i++) deleteFramebufferName(b,v.getUint32(p+4+i*4,true));
      return;
    }
    case O.OP_BIND_FRAMEBUFFER:
      bindFramebufferObject(b,v.getUint32(p,true),v.getUint32(p+4,true));
      return;
    // Payload: u32 target, u32 attachment, u32 textarget, u32 textureName,
    //          i32 level
    case O.OP_FRAMEBUFFER_TEXTURE_2D:
      attachImageObject(b,1,v.getUint32(p,true),v.getUint32(p+4,true),v.getUint32(p+8,true),v.getUint32(p+12,true),v.getInt32(p+16,true));
      return;
    case O.OP_GEN_RENDERBUFFERS: return;

    case O.OP_DELETE_RENDERBUFFERS: {
      const n = v.getUint32(p, true);
      for (let i = 0; i < n; i++) {
        const name = v.getUint32(p + 4 + i * 4, true);
        deleteRenderbufferName(b,name);
      }
      return;
    }
    case O.OP_BIND_RENDERBUFFER: {
      bindImageObject(b,2,v.getUint32(p,true),v.getUint32(p+4,true));
      return;
    }
    // Payload: u32 target, u32 internalformat, i32 width, i32 height
    case O.OP_RENDERBUFFER_STORAGE: {
      const internal = v.getUint32(p + 4, true);
      if (!predicted(b, renderbufferStorageError(v.getUint32(p, true), v.getInt32(p + 8, true),
          v.getInt32(p + 12, true), predictionLimit(gl, MAX_RENDERBUFFER_SIZE), b.shadow.renderbuffer !== null))) return false;
      const accepted = imageRenderbufferStorage(b,()=>{
        gl.renderbufferStorage(v.getUint32(p, true), nativeRenderbufferFormat(internal),
          v.getInt32(p + 8, true), v.getInt32(p + 12, true));
        // RGB16F is stored as RGBA16F with alpha 1.0 that is never written
        // (opaque-alpha.ts). The bound storage is the one just specified.
        if (renderbufferOpaqueAlpha(internal)) {
          const native = gl.getParameter(0x8ca7) as WebGLRenderbuffer | null;
          clearStorageAlphaToOne(gl, target => gl.framebufferRenderbuffer(target, 0x8ce0, 0x8d41, native));
        }
      });
      // New storage replaces earlier contents, opaque or not.
      if (accepted && b.shadow.renderbuffer)
        setOpaqueAlphaStorage(renderbufferNative(b, b.shadow.renderbuffer), renderbufferOpaqueAlpha(internal));
      if (accepted) recordRenderbufferSize(b.shadow.renderbuffer,v.getInt32(p+8,true),v.getInt32(p+12,true),
        internal,{colorRenderable:renderbufferColorRenderable(internal),
          depthRenderable:renderbufferDepthRenderable(internal),stencilRenderable:renderbufferStencilRenderable(internal)});
      return accepted;
    }
    // Payload: u32 target, u32 attachment, u32 rbtarget, u32 rboName
    case O.OP_FRAMEBUFFER_RENDERBUFFER:
      attachImageObject(b,2,v.getUint32(p,true),v.getUint32(p+4,true),v.getUint32(p+8,true),v.getUint32(p+12,true),0);
      return;
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
