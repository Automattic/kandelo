import {runProgramJournalQuery,validProgramJournalBarrierRequest} from "./program-journal-query.js";
import { rendererLost } from "./renderer-loss.js";
import { createShaderIfAccepted, createProgramIfAccepted } from "./program-objects.js";
import { externalValidationFailed, guestUniformType } from "./external-texture.js";
import { validationHadNoExecutable } from "./validate-status.js";
import { programGuestName } from "./essl3-translation.js";
import { runObjectCapture } from "./object-capture.js";
import { interruptCompressedUpload, runCompressedUpload } from "./compressed-upload.js";
import { runReadbackCapture } from "./readback-capture.js";
import { attributeAliasLayout } from "./attribute-aliasing.js";
import { glesFramebufferStatus, requireGlesFramebufferComplete } from "./image-sizes.js";
import { uniformLayout } from "./uniform-layout.js";
import { interruptUniformUpload } from "./uniform-upload.js";
import {
  GL_IMAGE_MUTATION_LEGACY_REPLY_BYTES,
  GL_IMAGE_ATTACHMENT_CONTAINER_REPLY_BYTES,
  GL_IMAGE_DELETION_CONTAINERS_REPLY_BYTES,
} from "../generated/abi.js";
import { repairNativeState } from "./native-recovery.js";
import { reconcileClientArrayRestore } from "./client-array.js";
import { querySurfaceCapabilities, validSurfaceCapabilitiesLength } from "./surface-capabilities.js";
import { withMultisampleRead } from "./multisample.js";
import { guestLimit, maxCubeMapTextureSize } from "./limits.js";
import { finishRenderer } from "./finish.js";
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
 * objects; the cmdbuf needs an integer. Each program numbers its own
 * uniforms densely, as Linux drivers do (uniform-layout.ts, D-41).
 */
import { validImageStorageRequest, executeImageStorageRequest,
  validProgramMutationRequest, executeProgramMutationRequest } from "./bridge.js";
import { canonicalTexture, canonicalRenderbuffer, imageSourceToken, importImageStorage, boundImageState } from "./image-storage.js";
import { collectRetiredImages, deleteImageObject, attachImageObject, bindFramebufferObject } from "./image-references.js";
import { bindImageObject } from "./image-bindings.js";
import { runUniformLookup, uniformLocation } from "./uniform-queries.js";
import { capabilityEnabled, checkedQueryReply, runStateQuery } from "./state-query.js";
import { runObjectQuery } from "./object-query.js";
import { runShaderSourceUpload } from "./shader-source.js";
import { collectRetiredBuffers, deleteBufferNames } from "./buffer-references.js";
import { bindBufferObject, canonicalBuffer } from "./buffer-storage.js";
import type { GlBinding, GlContextExecutionLease } from "./registry.js";
import { runProgramCaptureQuery } from "./program-capture-query.js";
import * as O from "./ops.js";
import { getGlesExtensionString } from "./capabilities.js";
import { checkedGlCall, publicCurrentProgramName, recordGlError, linkedProgramForQuery, attributeLocation } from "./program-objects.js";
import { captureNativeGlErrors, mergeClientGlErrors } from "./errors.js";
import { drainGlErrors, readGlErrorQuery } from "./error-query.js";
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

// Guest-visible numeric state: GLES 2.0.25 section 6.1 tables 6.2-6.21 plus
// the names added by advertised extensions. The renderer is WebGL 2, but its
// WebGL 2 and WEBGL-only names (3D/array limits, draw/read buffers, VAO,
// transform feedback, pack/unpack row state, UNPACK_FLIP_Y_WEBGL...) are host
// internals and INVALID_ENUM for a GLES 2 guest. Capability toggles use
// capabilityEnabled. EXT_unpack_subimage state is answered by the encoder.
// String names belong to QOP_GET_STRING. GLES-only compiler/format-count
// names are derived in queryParameter, rather than sent to WebGL.
const numericParameterNames = new Set([
  0x84e0, // ACTIVE_TEXTURE
  0x846e, // ALIASED_LINE_WIDTH_RANGE
  0x846d, // ALIASED_POINT_SIZE_RANGE
  0x0d55, // ALPHA_BITS
  0x8894, // ARRAY_BUFFER_BINDING
  0x8005, // BLEND_COLOR
  0x80ca, // BLEND_DST_ALPHA
  0x80c8, // BLEND_DST_RGB
  0x883d, // BLEND_EQUATION_ALPHA
  0x8009, // BLEND_EQUATION_RGB
  0x80cb, // BLEND_SRC_ALPHA
  0x80c9, // BLEND_SRC_RGB
  0x0d54, // BLUE_BITS
  0x0c22, // COLOR_CLEAR_VALUE
  0x0c23, // COLOR_WRITEMASK
  0x86a3, // COMPRESSED_TEXTURE_FORMATS
  0x0b45, // CULL_FACE_MODE
  0x8b8d, // CURRENT_PROGRAM
  0x0d56, // DEPTH_BITS
  0x0b73, // DEPTH_CLEAR_VALUE
  0x0b74, // DEPTH_FUNC
  0x0b70, // DEPTH_RANGE
  0x0b72, // DEPTH_WRITEMASK
  0x8895, // ELEMENT_ARRAY_BUFFER_BINDING
  0x8ca6, // FRAMEBUFFER_BINDING
  0x0b46, // FRONT_FACE
  0x8192, // GENERATE_MIPMAP_HINT
  0x0d53, // GREEN_BITS
  0x8b9b, // IMPLEMENTATION_COLOR_READ_FORMAT
  0x8b9a, // IMPLEMENTATION_COLOR_READ_TYPE
  0x0b21, // LINE_WIDTH
  0x8b4d, // MAX_COMBINED_TEXTURE_IMAGE_UNITS
  0x851c, // MAX_CUBE_MAP_TEXTURE_SIZE
  0x8dfd, // MAX_FRAGMENT_UNIFORM_VECTORS
  0x84e8, // MAX_RENDERBUFFER_SIZE
  0x8872, // MAX_TEXTURE_IMAGE_UNITS
  0x0d33, // MAX_TEXTURE_SIZE
  0x8dfc, // MAX_VARYING_VECTORS
  0x8869, // MAX_VERTEX_ATTRIBS
  0x8b4c, // MAX_VERTEX_TEXTURE_IMAGE_UNITS
  0x8dfb, // MAX_VERTEX_UNIFORM_VECTORS
  0x0d3a, // MAX_VIEWPORT_DIMS
  0x0d05, // PACK_ALIGNMENT
  0x8038, // POLYGON_OFFSET_FACTOR
  0x2a00, // POLYGON_OFFSET_UNITS
  0x0d52, // RED_BITS
  0x8ca7, // RENDERBUFFER_BINDING
  0x80a8, // SAMPLE_BUFFERS
  0x80ab, // SAMPLE_COVERAGE_INVERT
  0x80aa, // SAMPLE_COVERAGE_VALUE
  0x80a9, // SAMPLES
  0x0c10, // SCISSOR_BOX
  0x8801, // STENCIL_BACK_FAIL
  0x8800, // STENCIL_BACK_FUNC
  0x8802, // STENCIL_BACK_PASS_DEPTH_FAIL
  0x8803, // STENCIL_BACK_PASS_DEPTH_PASS
  0x8ca3, // STENCIL_BACK_REF
  0x8ca4, // STENCIL_BACK_VALUE_MASK
  0x8ca5, // STENCIL_BACK_WRITEMASK
  0x0d57, // STENCIL_BITS
  0x0b91, // STENCIL_CLEAR_VALUE
  0x0b94, // STENCIL_FAIL
  0x0b92, // STENCIL_FUNC
  0x0b95, // STENCIL_PASS_DEPTH_FAIL
  0x0b96, // STENCIL_PASS_DEPTH_PASS
  0x0b97, // STENCIL_REF
  0x0b93, // STENCIL_VALUE_MASK
  0x0b98, // STENCIL_WRITEMASK
  0x0d50, // SUBPIXEL_BITS
  0x8069, // TEXTURE_BINDING_2D
  0x8514, // TEXTURE_BINDING_CUBE_MAP
  0x8d67, // TEXTURE_BINDING_EXTERNAL_OES (GL_OES_EGL_image_external)
  0x0cf5, // UNPACK_ALIGNMENT
  0x0ba2, // VIEWPORT
  0x8df8, 0x8df9, 0x8dfa, 0x86a2, // GLES compiler and format counts
]);
// Names added by extensions the host always advertises
// (capabilities.ts WEBGL2_CORE_GLES2_EXTENSIONS).
const extensionParameterNames = new Set([
  0x8b8b, // FRAGMENT_SHADER_DERIVATIVE_HINT_OES (GL_OES_standard_derivatives)
]);

function validNumericParameter(b: GlBinding, pname: number): boolean {
  return numericParameterNames.has(pname) || extensionParameterNames.has(pname)
    || capabilityEnabled(b, pname) !== undefined;
}

const shaderParameterNames = new Set([
  0x8b4f, 0x8b80, 0x8b81, GL_INFO_LOG_LENGTH, 0x8b88,
  // SHADER_TYPE, DELETE_STATUS, COMPILE_STATUS, INFO_LOG_LENGTH, SOURCE_LENGTH
]);
// GLES 2 section 6.1.8: DELETE_STATUS, LINK_STATUS, VALIDATE_STATUS,
// ATTACHED_SHADERS, ACTIVE_UNIFORMS, ACTIVE_ATTRIBUTES, INFO_LOG_LENGTH,
// ACTIVE_UNIFORM_MAX_LENGTH, ACTIVE_ATTRIBUTE_MAX_LENGTH. WebGL 2 transform
// feedback and uniform-block names are not GLES 2 program state.
const programParameterNames = new Set([
  0x8b80, 0x8b82, 0x8b83, 0x8b85, 0x8b86, 0x8b89,
  GL_INFO_LOG_LENGTH, GL_ACTIVE_UNIFORM_MAX_LENGTH, 0x8b8a,
]);

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

/** Resolve only authoritative logical containers. Physical default storage can
 * have a native FBO; an unregistered named selection is not logical zero. */
function selectedContainerName(b: GlBinding, framebuffer: WebGLFramebuffer | null): number | null {
  if (isDefaultFramebuffer(b,framebuffer)) return 0;
  let name: number | null = null;
  for (const [candidate,object] of b.fbos) if (object === framebuffer) {
    if (!candidate || name !== null) { recordGlError(b,0x502); return null; }
    name = candidate;
  }
  if (name === null) recordGlError(b,0x502);
  return name;
}

/** QOP_INFO_LOG emits UTF-8 bytes. Empty logs have no terminator to count. */
function infoLogByteCapacity(log: string | null): number {
  return log ? new TextEncoder().encode(log).byteLength + 1 : 0;
}

export function runGlQuery(
  b: GlBinding,
  op: number,
  input: Uint8Array,
  out: Uint8Array,
  execution?: GlContextExecutionLease,
): number {
  // Journal control is not guest rendering or an upload barrier. In particular
  // recovery/status must not interrupt a transfer, replay state or drain errors.
  if(op===O.QOP_PROGRAM_JOURNAL_BARRIER){
    if(!b.gl || b.contextId===null || !validProgramJournalBarrierRequest(input,out.byteLength))return -22;
    return runProgramJournalQuery(b,input,out);
  }
  if(op===O.QOP_PROGRAM_JOURNAL)return runProgramJournalQuery(b,input,out,execution);
  const errorQuery = op === O.QOP_GET_ERROR ? readGlErrorQuery(input) : null;
  if (op === O.QOP_GET_ERROR && (errorQuery === null ||
      (errorQuery.drain ? out.byteLength !== O.GL_ERROR_DRAIN_REPLY_BYTES : out.byteLength < 4))) return -22;
  if (interruptUniformUpload(b)) return -5;
  if (op !== O.QOP_COMPRESSED_UPLOAD && interruptCompressedUpload(b)) return -5;
  if ((op === O.QOP_FINISH || op === O.QOP_FLUSH) && (input.byteLength !== 0 || out.byteLength !== 0)) return -22;
  if (op === O.QOP_SURFACE_CAPABILITIES) {
    if (input.byteLength !== 0 || !validSurfaceCapabilitiesLength(out.byteLength)) return -22;
    if (!b.gl) return -1;
    captureNativeGlErrors(b.gl,b);
    return querySurfaceCapabilities(b.gl,input,out);
  }
  if (!b.gl) return -1;
  const gl = b.gl;
  if (op === O.QOP_COMPRESSED_UPLOAD && gl.isContextLost?.()) {
    b.compressedUpload = null;
    return -5;
  }
  if (!repairNativeState(gl) || !reconcileClientArrayRestore(b,gl)) {
    if (op === O.QOP_COMPRESSED_UPLOAD) b.compressedUpload = null;
    return -5;
  }
  if (op === O.QOP_OBJECT_CAPTURE) return runObjectCapture(b,input,out);
  if (op === O.QOP_READBACK_CAPTURE) return runReadbackCapture(b,input,out,(metadata,bytes)=>readNativePixels(b,metadata,bytes));
  if (op === O.QOP_LOOKUP_UNIFORM) return runUniformLookup(b,input,out);
  if (op === O.QOP_PROGRAM_CAPTURE) return runProgramCaptureQuery(b,input,out,execution);
  if (op === O.QOP_COMPRESSED_UPLOAD) return runCompressedUpload(b,input,out);
  if (op === O.QOP_SHADER_SOURCE_UPLOAD) return runShaderSourceUpload(b,input,out);
  const inDv = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const outDv = new DataView(out.buffer, out.byteOffset, out.byteLength);

  if (op === O.QOP_DELETE_BUFFER) {
    if (input.byteLength !== 4 || out.byteLength !== 12) return -22;
    return checkedQueryReply(b, out, 4, payload => {
      if (!deleteBufferNames(b, [inDv.getUint32(0, true)])) return -5;
      collectRetiredBuffers(b);
      new DataView(payload.buffer).setUint32(0, 1, true);
      return 4;
    });
  }
  if (op === O.QOP_BIND_BUFFER) {
    if (input.byteLength !== 8 || out.byteLength !== 12) return -22;
    return checkedQueryReply(b, out, 4, payload => {
      if (!bindBufferObject(b, inDv.getUint32(0, true), inDv.getUint32(4, true))) return -5;
      collectRetiredBuffers(b);
      new DataView(payload.buffer).setUint32(0, 1, true);
      return 4;
    });
  }
  if (op === O.QOP_BIND_FRAMEBUFFER) {
    if (input.byteLength !== 8 || out.byteLength !== 12) return -22;
    return checkedQueryReply(b, out, 4, payload => {
      if (!bindFramebufferObject(b, inDv.getUint32(0, true), inDv.getUint32(4, true))) return -5;
      collectRetiredImages(b);
      new DataView(payload.buffer).setUint32(0, 1, true);
      return 4;
    });
  }
  if (op === O.QOP_IMAGE_STORAGE) {
    if (out.byteLength !== 12 || !validImageStorageRequest(input)) return -22;
    return checkedQueryReply(b, out, 4, payload => {
      if (!executeImageStorageRequest(b, input)) return -5;
      new DataView(payload.buffer).setUint32(0, 1, true);
      return 4;
    });
  }
  if (op === O.QOP_PROGRAM_MUTATION) {
    if (out.byteLength !== 12 || !validProgramMutationRequest(input)) return -22;
    return checkedQueryReply(b, out, 4, payload => {
      // Reserve every reply view before a possibly irreversible mutation.
      const reply = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
      if (!executeProgramMutationRequest(b, input)) return -5;
      reply.setUint32(0, 1, true);
      return 4;
    });
  }
  if (op === O.QOP_IMAGE_OBJECT_DELETE || op === O.QOP_IMAGE_ATTACHMENT) {
    const deletion = op === O.QOP_IMAGE_OBJECT_DELETE;
    const extended = out.byteLength === (deletion
      ? GL_IMAGE_DELETION_CONTAINERS_REPLY_BYTES : GL_IMAGE_ATTACHMENT_CONTAINER_REPLY_BYTES);
    if (input.byteLength !== (deletion ? 8 : 24) || (!extended && out.byteLength !== GL_IMAGE_MUTATION_LEGACY_REPLY_BYTES)) return -22;
    return checkedQueryReply(b, out, extended ? (deletion ? 12 : 8) : 4, payload => {
      const result = new DataView(payload.buffer), kind = inDv.getUint32(0,true);
      // Stage receipt identity before any mutation, including allocation or
      // retirement. The legacy12-byte reply retains its exact old semantics.
      let draw = 0, read = 0;
      if (extended && (deletion ? kind >= 1 && kind <= 3 :
          (kind === 1 || kind === 2) && validFramebufferTarget(inDv.getUint32(4,true)))) {
        const selected = selectedContainerName(b,deletion ? b.shadow.fbo : boundFramebuffer(b,inDv.getUint32(4,true)));
        if (selected === null) return -5;
        draw = selected;
        if (deletion) {
          const selectedRead = selectedContainerName(b,b.shadow.readFbo);
          if (selectedRead === null) return -5;
          read = selectedRead;
        }
      }
      const accepted = deletion ? deleteImageObject(b,kind,inDv.getUint32(4,true)) :
        attachImageObject(b,kind,inDv.getUint32(4,true),inDv.getUint32(8,true),inDv.getUint32(12,true),inDv.getUint32(16,true),inDv.getInt32(20,true));
      if (!accepted) return -5;
      collectRetiredImages(b);
      result.setUint32(0,1,true);
      if (extended) {
        result.setUint32(4,draw,true);
        if (deletion) result.setUint32(8,read,true);
      }
      return payload.byteLength;
    });
  }
  if (op === O.QOP_BOUND_IMAGE_TARGET || op === O.QOP_BOUND_IMAGE_STATE) {
    if (input.byteLength !== (op === O.QOP_BOUND_IMAGE_TARGET ? 12 : 8) || out.byteLength !== 16) return -22;
    return checkedQueryReply(b, out, 8, payload => {
      const result = new DataView(payload.buffer);
      const state = boundImageState(b, inDv.getUint32(0, true), inDv.getUint32(4, true),
        op === O.QOP_BOUND_IMAGE_TARGET ? inDv.getUint32(8, true) : undefined);
      if (!state) return -5;
      result.setUint32(0, state.source, true);
      result.setUint32(4, state.revision, true);
      return 8;
    });
  }
  if(op===O.QOP_IMAGE_TARGET||op===O.QOP_IMAGE_SOURCE_STATE){
    if(input.byteLength!==(op===O.QOP_IMAGE_TARGET?12:8)||out.byteLength!==12)return -22;
    return checkedQueryReply(b,out,4,payload=>{
      const result=new DataView(payload.buffer);
      const kind=inDv.getUint32(0,true),name=inDv.getUint32(4,true);
      if(op===O.QOP_IMAGE_TARGET&&!importImageStorage(b,kind,name,inDv.getUint32(8,true)))return -5;
      const source=imageSourceToken(b,kind,name);
      if(source===null){recordGlError(b,0x502);return -5;}
      result.setUint32(0,source,true);return 4;
    });
  }
  if (op === O.QOP_BIND_IMAGE_OBJECT) {
    if (input.byteLength !== 12 || out.byteLength !== 12) return -22;
    return checkedQueryReply(b,out,4,payload => {
      if (!bindImageObject(b,inDv.getUint32(0,true),inDv.getUint32(4,true),inDv.getUint32(8,true))) return -5;
      collectRetiredImages(b);
      new DataView(payload.buffer).setUint32(0,1,true);
      return 4;
    });
  }

  const state = runStateQuery(b,op,input,out);
  if (state !== undefined) return state;
  const object = runObjectQuery(b,op,input,out);
  if (object !== undefined) return object;

  switch (op) {
    case O.QOP_CREATE_SHADER_PROGRAM: {
      if (input.byteLength !== 12 || out.byteLength !== 12) return -22;
      const kind = inDv.getUint32(0, true), type = inDv.getUint32(4, true),
        name = inDv.getUint32(8, true);
      if ((kind !== 4 && kind !== 5) || (kind === 5 && type !== 0)) return -22;
      return checkedQueryReply(b, out, 4, payload => {
        // Reserve the checked reply before creating a namespace/native owner.
        // An existing object must never turn a rejected duplicate into an ACK.
        const reply = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
        const existed = b.shaders.has(name) || b.programs.has(name);
        // Allocation is private bookkeeping: verify native creation before
        // publishing its handle to a share group. Preserve the actual guest's
        // older flags while collecting this operation's validation result.
        const owner = Object.create(b) as GlBinding;
        owner.errors = [];
        if (kind === 4) createShaderIfAccepted(owner, type, name);
        else createProgramIfAccepted(owner, name);
        if (!rendererLost(b)) for (const error of owner.errors) recordGlError(b, error);
        const object = kind === 4 ? b.shaders.get(name) : b.programs.get(name);
        if (existed || !name || owner.errors.length || !object) return -5;
        reply.setUint32(0, name, true);
        return 4;
      });
    }

    case O.QOP_GET_ERROR:
      captureNativeGlErrors(gl, b);
      // Failed command submission can leave C flags for this fallback route.
      // Merge into the same owner as native/trailer flags, without duplicates.
      mergeClientGlErrors(b, errorQuery!.mask);
      if (errorQuery!.drain) return drainGlErrors(b, out);
      outDv.setUint32(0, b.errors[0] ?? 0, true);
      b.errors.shift();
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
      if (!validNumericParameter(b, pname)) {
        recordGlError(b, 0x500);
        return -22;
      }
      if (pname === GL_VIEWPORT) {
        return writeNumericValues(outDv, out.byteLength, b.shadow.viewport, false, pname);
      }
      if (pname === GL_SCISSOR_BOX) {
        return writeNumericValues(outDv, out.byteLength, b.shadow.scissor.rect, false, pname);
      }
      let value: unknown;
      if (!checkedGlCall(b, () => { value = queryParameter(b, pname); })) return -22;
      // Outside the checked call: an impossible limit is a renderer fault,
      // never a guest GL error.
      return writeNumericValues(outDv, out.byteLength, guestLimit(pname, value), false, pname);
    }

    // in: u32 pname; out: f32 value(s)
    case O.QOP_GET_FLOATV: {
      if (input.byteLength < 4 || out.byteLength < 4) return -22;
      const pname = inDv.getUint32(0, true);
      if (!validNumericParameter(b, pname)) {
        recordGlError(b, 0x500);
        return -22;
      }
      if (pname === GL_VIEWPORT) {
        return writeNumericValues(outDv, out.byteLength, b.shadow.viewport, true, pname);
      }
      if (pname === GL_SCISSOR_BOX) {
        return writeNumericValues(outDv, out.byteLength, b.shadow.scissor.rect, true, pname);
      }
      let value: unknown;
      if (!checkedGlCall(b, () => { value = queryParameter(b, pname); })) return -22;
      // Outside the checked call: an impossible limit is a renderer fault,
      // never a guest GL error.
      return writeNumericValues(outDv, out.byteLength, guestLimit(pname, value), true, pname);
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
      const program = linkedProgramForQuery(b, programName);
      if (!program) return -22;
      const attrName = new TextDecoder().decode(input.subarray(8, 8 + nameLen));
      const loc = attributeLocation(b, program, attrName);
      if (loc === null) return -22;
      outDv.setInt32(0, loc, true);
      return 4;
    }

    // in: u32 shaderName, u32 pname; out: i32 value
    case O.QOP_GET_SHADERIV: {
      if (input.byteLength < 8 || out.byteLength < 4) return -22;
      const name = inDv.getUint32(0, true);
      const sh = b.shaders.get(name);
      if (!sh) {
        recordGlError(b, b.programs.has(name) ? 0x502 : 0x501);
        return -22;
      }
      const pname = inDv.getUint32(4, true);
      if (!shaderParameterNames.has(pname)) {
        recordGlError(b, 0x500);
        return -22;
      }
      const sourceLength = b.shaderSources.get(sh)?.length ?? 0;
      let v: unknown;
      if (!checkedGlCall(b, () => {
        v = pname === 0x8b80 ? b.shaderDeletePending.has(name)
          : pname === 0x8b88 ? (sourceLength ? sourceLength+1 : 0)
          : pname === GL_INFO_LOG_LENGTH
          ? infoLogByteCapacity(gl.getShaderInfoLog(sh))
          : gl.getShaderParameter(sh, pname);
      })) return -5;
      outDv.setInt32(0, typeof v === "boolean" ? (v ? 1 : 0) : Number(v ?? 0), true);
      return 4;
    }

    // in: u32 shaderName; out: u32 strLen, u8 str[strLen]
    case O.QOP_GET_SHADER_INFO_LOG: {
      if (input.byteLength < 4 || out.byteLength < 4) return -22;
      const name = inDv.getUint32(0, true);
      const sh = b.shaders.get(name);
      if (!sh) {
        recordGlError(b, b.programs.has(name) ? 0x502 : 0x501);
        return -22;
      }
      let log = "";
      if (!checkedGlCall(b, () => { log = gl.getShaderInfoLog(sh) ?? ""; })) return -5;
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
      const name = inDv.getUint32(0, true);
      const prog = b.programs.get(name);
      if (!prog) {
        recordGlError(b, b.shaders.has(name) ? 0x502 : 0x501);
        return -22;
      }
      const pname = inDv.getUint32(4, true);
      if (!programParameterNames.has(pname)) {
        recordGlError(b, 0x500);
        return -22;
      }
      let v: unknown;
      if (!checkedGlCall(b, () => {
        if (pname === 0x8b80) {
          v = b.programDeletePending.has(inDv.getUint32(0, true));
        } else if (pname === GL_INFO_LOG_LENGTH) {
          v = infoLogByteCapacity(gl.getProgramInfoLog(prog));
        } else if (attributeAliasLayout(prog) && (pname === 0x8b89 || pname === 0x8b8a || pname === 0x8b85)) {
          // Aliasing executables reflect the guest's attributes and attachments.
          const attributes = attributeAliasLayout(prog)!.attributes;
          v = pname === 0x8b89 ? attributes.length : pname === 0x8b85 ? b.programShaders.get(name)?.size ?? 0
            : Math.max(0, ...attributes.map(info => info.name.length + 1));
        } else if (pname === GL_ACTIVE_UNIFORM_MAX_LENGTH || pname === 0x8b8a) {
          const attributes = pname === 0x8b8a;
          const n = Number(gl.getProgramParameter(prog, attributes ? 0x8b89 : GL_ACTIVE_UNIFORMS) ?? 0);
          let max = 0;
          for (let i = 0; i < n; i++) {
            const info = attributes ? gl.getActiveAttrib(prog, i) : gl.getActiveUniform(prog, i);
            // Guest names: a translated program's native names are longer.
            if (info) max = Math.max(max, programGuestName(prog, info.name).length + 1);
          }
          v = max;
        } else if (pname === 0x8b83 && externalValidationFailed(prog)) {
          // A sampler2D and a samplerExternalOES share a unit (ES 2.0
          // 2.10.4); WebGL validated two sampler2Ds.
          v = false;
        } else if (pname === 0x8b83 && validationHadNoExecutable(prog)) {
          // [RUNTIME-WORKAROUND: FIREFOX-VALIDATE-UNLINKED-PROGRAM] No
          // linked executable at ValidateProgram: Firefox answers TRUE.
          v = false;
        } else {
          v = gl.getProgramParameter(prog, pname);
        }
      })) return -5;
      outDv.setInt32(0, typeof v === "boolean" ? (v ? 1 : 0) : Number(v ?? 0), true);
      return 4;
    }

    // in: u32 programName; out: u32 strLen, u8 str[strLen]
    case O.QOP_GET_PROGRAM_INFO_LOG: {
      if (input.byteLength < 4 || out.byteLength < 4) return -22;
      const name = inDv.getUint32(0, true);
      const prog = b.programs.get(name);
      if (!prog) {
        recordGlError(b, b.shaders.has(name) ? 0x502 : 0x501);
        return -22;
      }
      let log = "";
      if (!checkedGlCall(b, () => { log = gl.getProgramInfoLog(prog) ?? ""; })) return -5;
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
    case O.QOP_READ_PIXELS:
      return readNativePixels(b,input,out);

    // in: u32 shadertype, u32 precisiontype; out: i32 rangeMin, i32 rangeMax,
    // i32 precision
    case O.QOP_GET_SHADER_PRECISION_FORMAT: {
      if (input.byteLength < 8 || out.byteLength < 12) return -22;
      const shader = inDv.getUint32(0,true), precision = inDv.getUint32(4,true);
      if ((shader !== 0x8b30 && shader !== 0x8b31) || precision < 0x8df0 || precision > 0x8df5) {
        recordGlError(b,0x500); return -22;
      }
      let fmt: WebGLShaderPrecisionFormat | null = null;
      if (!checkedGlCall(b, () => { fmt = gl.getShaderPrecisionFormat(shader,precision); })) return -5;
      if (!fmt) { recordGlError(b,0x502); return -5; }
      // A rejected query must preserve every caller byte. A real zero-valued
      // fragment precision result remains distinct from a missing native one.
      const accepted = fmt as WebGLShaderPrecisionFormat;
      outDv.setInt32(0, accepted.rangeMin, true);
      outDv.setInt32(4, accepted.rangeMax, true);
      outDv.setInt32(8, accepted.precision, true);
      return 12;
    }

    // glFlush and glFinish. Each query is answered after the host has
    // decoded every earlier command; finish.ts waits for their completion.
    case O.QOP_FLUSH:
      return checkedGlCall(b, () => {
        if (gl.isContextLost()) throw new Error("Cannot flush a lost renderer");
        gl.flush();
        if (gl.isContextLost()) throw new Error("Renderer lost during flush");
      }) ? 0 : -5;
    case O.QOP_FINISH:
      return finishRenderer(b) ? 0 : -5;

    // in: u32 target; out: u32 status
    case O.QOP_CHECK_FB_STATUS: {
      if (input.byteLength < 4 || out.byteLength < 4) return -22;
      const target = inDv.getUint32(0, true);
      // Section 4.4.5: a target other than FRAMEBUFFER is INVALID_ENUM and
      // returns zero; WebGL 2 would answer READ/DRAW_FRAMEBUFFER natively.
      if (!validFramebufferTarget(target)) {
        recordGlError(b, 0x500);
        outDv.setUint32(0, 0, true);
        return 4;
      }
      const drawable = b.executionDrawable?.drawable ?? b.currentDrawable;
      const surface = target === 0x8ca8 ? drawable?.readSurfaceId : drawable?.drawSurfaceId;
      let status = surface === 0 && isDefaultFramebuffer(b, boundFramebuffer(b, target))
        ? GL_FRAMEBUFFER_UNDEFINED : gl.checkFramebufferStatus(target);
      // WebGL 2 applies ES 3.0 completeness, which has no dimensions rule.
      if (validFramebufferTarget(target)) status = glesFramebufferStatus(b, boundFramebuffer(b, target), status);
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
      const guestName = programGuestName(prog!, info.name);
      const nameBytes = new TextEncoder().encode(guestName);
      const nameLen = Math.min(nameBytes.byteLength, cap, out.byteLength - 12);
      outDv.setUint32(0, nameLen, true);
      outDv.setInt32(4, info.size, true);
      outDv.setUint32(8, guestUniformType(prog!, guestName, info.type), true);
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
        let linked = false, value: unknown;
        if (!checkedGlCall(b,() => { linked = !!gl.getProgramParameter(program,0x8b82); })) return -5;
        if (!linked) return fail(0x502);
        // The location is numbered by this program (uniform-layout.ts).
        const layout = uniformLayout(b,program);
        if (!layout) return -5;
        const location = index >= 0 && layout.slots[index] ? layout.native(b,index) : null;
        if (location === false) return -5;
        if (!location) return fail(0x502);
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
      const prog = b.programs.get(inDv.getUint32(0, true)), index = inDv.getInt32(4, true);
      const layout = prog ? uniformLayout(b, prog) : null;
      const loc = layout && index >= 0 && layout.slots[index] ? layout.native(b, index) : null;
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
  if (pname === GL_CURRENT_PROGRAM) return publicCurrentProgramName(b);
  // WebGL exposes source compilation and its compressed-format vector, but
  // does not expose GLES's binary-compiler and vector-count query enums.
  if (pname === 0x8df8) return []; // SHADER_BINARY_FORMATS: no binary loader
  if (pname === 0x8df9) return 0; // NUM_SHADER_BINARY_FORMATS
  if (pname === 0x8dfa) return true; // SHADER_COMPILER
  if (pname === 0x86a2) { // NUM_COMPRESSED_TEXTURE_FORMATS
    return (b.gl!.getParameter(0x86a3) as Uint32Array).length;
  }
  // The native range is the ordered (min, max) pair; ES 2.0 reports the
  // logical, possibly reversed, values given to glDepthRangef.
  if (pname === 0x0b70) return [...b.shadow.depthRange];
  // The native RGB source factor can differ from the guest's (a constant
  // color/constant alpha pair, blend-constant.ts); report the logical ones.
  if (pname === 0x80c9) return b.shadow.blendFunc.srcRGB;
  if (pname === 0x80c8) return b.shadow.blendFunc.dstRGB;
  if (pname === 0x80cb) return b.shadow.blendFunc.srcA;
  if (pname === 0x80ca) return b.shadow.blendFunc.dstA;
  // The native mask holds alpha off for RGB storage kept as RGBA
  // (opaque-alpha.ts); ES 2.0 reports the guest's COLOR_WRITEMASK.
  if (pname === 0x0c23) return [...b.shadow.colorMask];
  // External bindings have no native target (external-texture.ts).
  if (pname === 0x8d67) {
    const object = b.shadow.externalTextureUnits[b.shadow.activeTexture] ?? null;
    return nameForObject(b.textures, object) || (object ? b.retiredTextures.get(object) : 0) || 0;
  }
  // Cube maps are 2D array textures natively (cube-storage.ts): the
  // binding is the guest's, and the size limit is what that storage holds.
  if (pname === 0x8514) {
    const object = b.shadow.cubeTextureUnits[b.shadow.activeTexture] ?? null;
    return nameForObject(b.textures, object) || (object ? b.retiredTextures.get(object) : 0) || 0;
  }
  if (pname === 0x851c) return maxCubeMapTextureSize(b) ?? 0;
  const value = b.gl!.getParameter(pname);
  switch (pname) {
    case 0x8894: // ARRAY_BUFFER_BINDING
    case 0x8895: // ELEMENT_ARRAY_BUFFER_BINDING (VAO-local)
      return value ? nameForObject(b.buffers, canonicalBuffer(b,value as WebGLBuffer))
        || b.retiredBuffers.get(canonicalBuffer(b,value as WebGLBuffer)) || 0 : 0;
    case 0x8069: // TEXTURE_BINDING_2D
      return nameForObject(b.textures, value ? canonicalTexture(b,value as WebGLTexture) : null)
        || (value ? b.retiredTextures.get(canonicalTexture(b,value as WebGLTexture)) : 0) || 0;
    case 0x8ca6: // FRAMEBUFFER_BINDING
    case 0x8caa: // READ_FRAMEBUFFER_BINDING
      return nameForObject(b.fbos, value as WebGLFramebuffer | null);
    case 0x8ca7: // RENDERBUFFER_BINDING
      return nameForObject(b.rbos, value ? canonicalRenderbuffer(b,value as WebGLRenderbuffer) : null)
        || (value ? b.retiredRenderbuffers.get(canonicalRenderbuffer(b,value as WebGLRenderbuffer)) : 0) || 0;
    case 0x8b9a: // IMPLEMENTATION_COLOR_READ_TYPE: GLES 2 names half float
      return value === GL_HALF_FLOAT ? GL_HALF_FLOAT_OES : value;
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
  if (ArrayBuffer.isView(value)) return Array.from(value as unknown as ArrayLike<number>, Number);
  return [Number(value) || 0];
}

function readNativePixels(b: GlBinding, input: Uint8Array, out: Uint8Array): number {
      if (input.byteLength < 24) return -22;
      if (!requireGlesFramebufferComplete(b, true)) return -22;
      const inDv = new DataView(input.buffer,input.byteOffset,input.byteLength);
      const gl = b.gl!;
      const x = inDv.getInt32(0, true);
      const y = inDv.getInt32(4, true);
      const w = inDv.getInt32(8, true);
      const h = inDv.getInt32(12, true);
      const format = inDv.getUint32(16, true);
      const type = normalizeHalfFloatType(inDv.getUint32(20, true));
      // WebGL2 readPixels requires the destination view to match `type`.
      const view = readPixelsViewForType(type, out);
      // A multisampled default framebuffer is read as resolved values.
      if (!withMultisampleRead(b, () => checkedGlCall(b, () => { gl.readPixels(x, y, w, h, format, type, view); }))) return -22;
      copyReadPixelsResult(view, out);
      // Both routes own independent staging. The capture route validates its
      // complete geometry separately from each bounded transport reply.
      return out.byteLength;
}
