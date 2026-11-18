/**
 * Read the GL device's guest-visible state for a machine checkpoint.
 *
 * A GL guest's screen never reaches a host buffer, but its *state* — the
 * sessions, surfaces and contexts the kernel granted, the objects the guest
 * created, the values it set — is what a replica needs, because the replica
 * re-executes the guest and the guest re-issues its own draws. This module
 * reads that state at checkpoint freeze time through the host's model of the
 * guest (object maps, texture levels, uniform layouts, vertex arrays,
 * framebuffer attachments, the shadow) and reads from WebGL2 only what lives
 * nowhere else: buffer bytes, texel values, uniform values, compile and link
 * status, sampler parameters.
 *
 * The read runs under the checkpoint freeze, inside the kernel's graphics
 * scope (`withGraphicsState`), which hands the renderer back to the next
 * session with a full state replay; reads still restore the private
 * bindings they borrow.
 *
 * Two kinds of loss are kept apart. State the rebuild cannot reproduce at
 * all — a share group, an EGLImage sibling, a cube map, a live fence —
 * refuses the checkpoint with the reason (`GlCaptureRefusal`): a restore
 * that silently dropped it would present a different machine. State that
 * is carried but not exactly — texel values WebGL2 cannot read back — adds
 * one line to the session's `boundaries`, which travels with the checkpoint
 * so a restore reports the machine as exactly as incomplete as it is.
 */
import type { GlBinding, GpuBo } from "./registry.js";
import { textureFaces, type GlTextureLevel } from "./texture-levels.js";
import { isCubeTexture } from "./cube-storage.js";
import { isExternalTexture } from "./external-texture.js";
import { textureNative } from "./image-storage.js";
import { renderbufferLogicalFormat, renderbufferRecordedSize } from "./image-sizes.js";
import { uniformLayout } from "./uniform-layout.js";
import { canonicalBuffer } from "./buffer-storage.js";
import { shaderType } from "./program-objects.js";
import { linkInputsChanged } from "./link-inputs.js";
import { MAX_RECORD_PAYLOAD, uniformTypeCarried } from "./rebuild.js";
import { checkpointProgramJournalOrder, type CheckpointGlProgramJournal } from "./program-journal.js";
import { checkpointGlProgramCaptures } from "./program-captures.js";

export const GL_TEXTURE_2D = 0x0de1;
export const GL_ARRAY_BUFFER = 0x8892;
export const GL_ELEMENT_ARRAY_BUFFER = 0x8893;
const GL_COPY_READ_BUFFER = 0x8f36;
const GL_READ_FRAMEBUFFER = 0x8ca8;
const GL_READ_FRAMEBUFFER_BINDING = 0x8caa;
const GL_COLOR_ATTACHMENT0 = 0x8ce0;
const GL_FRAMEBUFFER_COMPLETE = 0x8cd5;
const GL_PACK_ALIGNMENT = 0x0d05;
const GL_TEXTURE_BINDING_2D = 0x8069;
const GL_COMPILE_STATUS = 0x8b81;
const GL_LINK_STATUS = 0x8b82;
const GL_TEXTURE_MAG_FILTER = 0x2800;
const GL_TEXTURE_MIN_FILTER = 0x2801;
const GL_TEXTURE_WRAP_S = 0x2802;
const GL_TEXTURE_WRAP_T = 0x2803;
const GL_RGBA8 = 0x8058;

export const GL_UNSIGNED_BYTE = 0x1401;
export const GL_FLOAT = 0x1406;
export const GL_HALF_FLOAT = 0x140b;
export const GL_ALPHA = 0x1906;
export const GL_RGB = 0x1907;
export const GL_RGBA = 0x1908;
export const GL_LUMINANCE = 0x1909;
export const GL_LUMINANCE_ALPHA = 0x190a;

/** A state the rebuild cannot reproduce; the checkpoint fails with it. */
export class GlCaptureRefusal extends Error {}

function refuse(reason: string): never {
  throw new GlCaptureRefusal(reason);
}

/** One GPU-tier GBM buffer and the texels it held at the freeze (RGBA8). */
export interface CheckpointGpuBo {
  readonly boId: number;
  /** The texture id the host numbered it with; a foreign texture bound to
   *  the buffer takes it as its guest name. */
  readonly texId: number;
  readonly width: number;
  readonly height: number;
  readonly format: number;
  readonly pixels: Uint8Array;
}

/** The kernel surface a session renders into; see `GlSurfaceCreation`. */
export interface CheckpointGlSurface {
  readonly surfaceId: number;
  readonly kind: number;
  readonly width: number;
  readonly height: number;
  readonly samples: number;
  /** The GBM buffer the surface was created on, or 0. */
  readonly targetBoId: number;
  /** The GBM buffer the surface renders into now (`host_gl_update_surface`
   *  moves it at every swap), or 0. */
  readonly borrowedBoId: number;
}

export interface CheckpointGlBuffer {
  readonly name: number;
  /** The target the rebuild first binds it to: WebGL classifies a buffer by
   *  its first binding, and an index buffer must stay one. */
  readonly target: number;
  readonly usage: number;
  readonly bytes: Uint8Array;
}

/**
 * One texture level, in the guest's own GLES 2 format.
 *
 * `pixels` is packed tightly in `format`/`type`, ready for the same
 * TexSubImage2D the guest would issue; null when WebGL2 cannot read the
 * level back, which the session's `boundaries` names.
 */
export interface CheckpointGlTextureLevel {
  readonly level: number;
  readonly internalFormat: number;
  readonly width: number;
  readonly height: number;
  readonly format: number;
  readonly type: number;
  readonly pixels: Uint8Array | null;
}

export interface CheckpointGlTexture {
  readonly name: number;
  readonly levels: readonly CheckpointGlTextureLevel[];
  readonly minFilter: number;
  readonly magFilter: number;
  readonly wrapS: number;
  readonly wrapT: number;
}

/**
 * A texture the guest bound to a GBM buffer
 * (`DRM_IOCTL_WPK_BIND_FOREIGN_TEXTURE`, `webgl/foreign-texture.ts`).
 *
 * `pixels` holds a CPU-tier buffer's texture as RGBA8 rows, packed; null
 * for a GPU-tier buffer, whose texels its `CheckpointGpuBo` carries.
 */
export interface CheckpointGlForeignTexture {
  readonly name: number;
  readonly boId: number;
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array | null;
  readonly minFilter: number;
  readonly magFilter: number;
  readonly wrapS: number;
  readonly wrapT: number;
}

export interface CheckpointGlRenderbuffer {
  readonly name: number;
  /** Zero for a renderbuffer the guest never gave storage. */
  readonly internalFormat: number;
  readonly width: number;
  readonly height: number;
}

export interface CheckpointGlShader {
  readonly name: number;
  readonly type: number;
  /** The guest's original source bytes; null before any ShaderSource. */
  readonly source: Uint8Array | null;
  readonly compiled: boolean;
  readonly deletePending: boolean;
}

/** One active uniform as the program numbers it (`uniform-layout.ts`). */
export interface CheckpointGlUniformEntry {
  readonly name: string;
  readonly type: number;
  readonly guestType: number;
  readonly size: number;
  readonly array: boolean;
  readonly location: number;
}

/** The value at one uniform location, as the setter of `type` takes it. */
export interface CheckpointGlUniformValue {
  readonly location: number;
  readonly type: number;
  readonly values: readonly number[];
}

export interface CheckpointGlProgram {
  readonly name: number;
  readonly shaders: readonly number[];
  readonly attribBindings: readonly { readonly name: string; readonly index: number }[];
  readonly linked: boolean;
  readonly deletePending: boolean;
  /** The numbering a relink must keep, so the guest's locations hold. */
  readonly uniforms: readonly CheckpointGlUniformEntry[];
  readonly values: readonly CheckpointGlUniformValue[];
}

export interface CheckpointGlVertexAttribute {
  readonly index: number;
  readonly buffer: number | null;
  readonly enabled: boolean;
  readonly size: number;
  readonly type: number;
  readonly normalized: boolean;
  readonly stride: number;
  readonly offset: number;
}

/** One vertex array; name 0 is the context's default vertex array. */
export interface CheckpointGlVertexArray {
  readonly name: number;
  readonly element: number | null;
  readonly attributes: readonly CheckpointGlVertexAttribute[];
}

export interface CheckpointGlAttachment {
  readonly attachment: number;
  readonly kind: "texture" | "renderbuffer";
  readonly target: number;
  readonly name: number;
  readonly level: number;
}

export interface CheckpointGlFramebuffer {
  readonly name: number;
  readonly attachments: readonly CheckpointGlAttachment[];
}

/** The context state the guest set, with objects replaced by names. */
export interface CheckpointGlState {
  readonly viewport: readonly [number, number, number, number];
  readonly scissor: readonly [number, number, number, number];
  readonly capabilities: readonly { readonly cap: number; readonly enabled: boolean }[];
  readonly clearColor: readonly [number, number, number, number];
  readonly clearDepth: number;
  readonly clearStencil: number;
  readonly colorMask: readonly [boolean, boolean, boolean, boolean];
  readonly depthFunc: number;
  readonly depthMask: boolean;
  readonly depthRange: readonly [number, number];
  readonly stencil: readonly {
    readonly face: number;
    readonly func: number;
    readonly ref: number;
    readonly valueMask: number;
    readonly writeMask: number;
    readonly fail: number;
    readonly zfail: number;
    readonly zpass: number;
  }[];
  readonly blendFunc: readonly [number, number, number, number];
  readonly blendEquation: readonly [number, number];
  readonly blendColor: readonly [number, number, number, number];
  readonly cullFace: number;
  readonly frontFace: number;
  readonly lineWidth: number;
  readonly polygonOffset: readonly [number, number];
  readonly sampleCoverage: readonly [number, boolean];
  readonly unpackAlignment: number;
  readonly packAlignment: number;
  readonly vertexAttribValues: readonly {
    readonly index: number;
    readonly value: readonly [number, number, number, number];
  }[];
  readonly activeTexture: number;
  readonly textureUnits: readonly { readonly unit: number; readonly name: number }[];
  readonly program: number;
  readonly vertexArray: number;
  /** GLES 2 binds one framebuffer for drawing and reading. */
  readonly framebuffer: number;
  readonly renderbuffer: number;
  readonly arrayBuffer: number;
}

/** One kernel GL session (one open render file), as a checkpoint carries it. */
export interface CheckpointGlSession {
  readonly pid: number;
  readonly sessionId: number;
  /** The session's kernel display file, as a decimal string; null for an
   *  embedder context. */
  readonly displayFileId: string | null;
  readonly cmdbufAddr: number;
  readonly cmdbufLen: number;
  /** The CRTC whose canvas this session paints, for the restore to find
   *  the replacement canvas; null when it paints none. */
  readonly crtcId: number | null;
  readonly surface: CheckpointGlSurface | null;
  readonly context: { readonly contextId: number; readonly robustAccess: boolean } | null;
  /** The drawable last made current; null when never made current. */
  readonly drawable: {
    readonly drawSurfaceId: number;
    readonly readSurfaceId: number;
    readonly width: number;
    readonly height: number;
  } | null;
  readonly buffers: readonly CheckpointGlBuffer[];
  readonly textures: readonly CheckpointGlTexture[];
  readonly foreignTextures: readonly CheckpointGlForeignTexture[];
  /** The name the next foreign texture takes, unless its buffer's is higher. */
  readonly nextForeignTexId: number;
  readonly renderbuffers: readonly CheckpointGlRenderbuffer[];
  readonly shaders: readonly CheckpointGlShader[];
  readonly programs: readonly CheckpointGlProgram[];
  readonly vertexArrays: readonly CheckpointGlVertexArray[];
  readonly framebuffers: readonly CheckpointGlFramebuffer[];
  /** Null when the session has no live renderer: nothing to rebuild. */
  readonly state: CheckpointGlState | null;
  /** Error flags the guest has not read yet. */
  readonly errors: readonly number[];
  readonly boundaries: readonly string[];
  /** The program capture handles the guest holds; null when it never
   *  captured one. */
  readonly programCaptures: {
    readonly next: number;
    readonly handles: readonly { readonly handle: number; readonly name: number }[];
  } | null;
  /** The publication sequence and next journal id of the session's object
   *  group; null when it never admitted a program journal. */
  readonly programJournalOrder: { readonly sequence: number; readonly nextJournal: number } | null;
  readonly programJournal: CheckpointGlProgramJournal | null;
  /** The last journal transaction's receipt words: the guest numbers its
   *  next transaction from it, and reads it back after a lost reply. */
  readonly programJournalReceipt: readonly number[];
}

/** The GL device: its GPU-tier buffers, then every session. */
export interface CheckpointGl {
  readonly gpuBos: readonly CheckpointGpuBo[];
  readonly sessions: readonly CheckpointGlSession[];
}

function nameOf<T>(map: ReadonlyMap<number, T>, object: T | null, what: string): number {
  if (object === null) return 0;
  for (const [name, value] of map) if (value === object) return name;
  return refuse(`${what} has no guest name`);
}

/** Read one GPU-tier buffer's texels through its own framebuffer. */
export function captureGpuBo(gl: WebGL2RenderingContext, boId: number, bo: GpuBo): CheckpointGpuBo {
  if (bo.internalFormat !== GL_RGBA8) {
    refuse(`GPU BO ${boId} uses storage 0x${bo.internalFormat.toString(16)}, which the checkpoint does not carry`);
  }
  const pixels = new Uint8Array(bo.w * bo.h * 4);
  const priorRead = gl.getParameter(GL_READ_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
  gl.bindFramebuffer(GL_READ_FRAMEBUFFER, bo.fbo);
  gl.pixelStorei(GL_PACK_ALIGNMENT, 1);
  gl.readPixels(0, 0, bo.w, bo.h, GL_RGBA, GL_UNSIGNED_BYTE, pixels);
  gl.bindFramebuffer(GL_READ_FRAMEBUFFER, priorRead);
  return { boId, texId: bo.texId, width: bo.w, height: bo.h, format: bo.drmFormat, pixels };
}

/**
 * Read one session; see the module doc for what and how.
 *
 * `crtcId` and `borrowedBoId` are the caller's knowledge — the binding does
 * not know which CRTC a canvas scans out or which BO id an FBO belongs to —
 * and ride through unchanged.
 */
export function captureGlSession(
  b: GlBinding,
  crtcId: number | null,
  borrowedBoId: number,
): CheckpointGlSession {
  if (b.objects.members.size > 1) {
    refuse(`pid ${b.pid}'s GL session ${b.sessionId} shares objects with another context`);
  }
  const boundaries: string[] = [];
  const surface: CheckpointGlSurface | null = b.surfaceId === null ? null : {
    surfaceId: b.surfaceId,
    kind: b.surface.kind,
    width: b.surfaceSize?.width ?? 0,
    height: b.surfaceSize?.height ?? 0,
    samples: b.surface.samples,
    targetBoId: b.pendingRenderTargetBoId,
    borrowedBoId,
  };
  const session = {
    pid: b.pid,
    sessionId: b.sessionId,
    displayFileId: b.displayFileId === null ? null : b.displayFileId.toString(),
    cmdbufAddr: b.cmdbufAddr,
    cmdbufLen: b.cmdbufLen,
    crtcId,
    surface,
    context: b.contextId === null ? null : { contextId: b.contextId, robustAccess: b.robustAccess },
    drawable: b.currentDrawable === null ? null : { ...b.currentDrawable },
    nextForeignTexId: b.nextForeignTexId,
    errors: [...b.errors],
    boundaries,
    programJournalReceipt: [...b.programJournalControl.receipt],
  };
  const gl = b.gl;
  if (!gl) {
    return {
      ...session,
      buffers: [],
      textures: [],
      foreignTextures: [],
      renderbuffers: [],
      shaders: [],
      programs: [],
      vertexArrays: [],
      framebuffers: [],
      state: null,
      programCaptures: null,
      programJournalOrder: null,
      programJournal: null,
    };
  }
  refuseUncarried(b);
  return {
    ...session,
    programCaptures: checkpointGlProgramCaptures(b, refuse),
    programJournalOrder: checkpointProgramJournalOrder(b),
    programJournal: b.programJournal?.checkpoint(refuse, {
      framebuffer: (object) => nameOf(b.fbos, object, "a framebuffer snapshot's framebuffer"),
      texture: (object) => nameOf(b.textures, object, "a framebuffer snapshot's input"),
      buffer: (object) => nameOf(b.buffers, object, "a buffer snapshot's source"),
    }, (native, bytes) => readBufferBytes(gl, native, bytes)) ?? null,
    buffers: readBuffers(gl, b),
    textures: readTextures(gl, b, boundaries),
    foreignTextures: readForeignTextures(gl, b),
    renderbuffers: readRenderbuffers(b, boundaries),
    shaders: readShaders(gl, b),
    programs: readPrograms(gl, b),
    vertexArrays: readVertexArrays(b),
    framebuffers: readFramebuffers(b),
    state: readState(b),
  };
}

/** Refuse what the rebuild has no path for; see the module doc. */
function refuseUncarried(b: GlBinding): void {
  const where = `pid ${b.pid}'s GL session ${b.sessionId}`;
  if (b.renderbufferViews.size) refuse(`${where} holds an EGLImage renderbuffer`);
  for (const [bo, entry] of b.foreignTextures) {
    if (b.textures.get(entry.texId) !== entry.tex) refuse(`${where} still uses an object the guest deleted`);
    const view = b.textureViews.get(entry.tex);
    if (view ? view.source?.bo !== bo : textureFaces(entry.tex).get(GL_TEXTURE_2D)?.get(0)?.gles) {
      refuse(`${where} respecified foreign texture ${entry.texId}`);
    }
  }
  for (const texture of b.textureViews.keys()) {
    if (!b.foreignTextureBos.has(texture)) refuse(`${where} holds an EGLImage texture`);
  }
  for (const source of b.imageSources.values()) {
    const entry = b.foreignTextures.get(source.bo);
    if (!entry || b.textureViews.get(entry.tex)?.source !== source) refuse(`${where} holds an EGLImage`);
  }
  if (b.retiredTextures.size || b.retiredBuffers.size || b.retiredRenderbuffers.size) {
    refuse(`${where} still uses an object the guest deleted`);
  }
  if (b.shadow.defaultTextures.size) {
    refuse(`${where} uses texture zero's storage`);
  }
  if (b.fences.size) refuse(`${where} has live fences`);
  if (b.savedClientArrayBuffer !== undefined || b.uniformUpload || b.compressedUpload || b.shaderUpload) {
    refuse(`${where} is inside a staged upload`);
  }
  if (b.surface.samples) refuse(`${where} renders into a multisampled surface`);
  if (b.currentProgram !== null && b.programs.get(b.currentProgramId) !== b.currentProgram) {
    refuse(`${where} runs a program whose latest relink failed`);
  }
  for (const texture of b.textures.values()) {
    if (isCubeTexture(texture)) refuse(`${where} holds a cube-map texture`);
    if (isExternalTexture(texture)) refuse(`${where} holds an external texture`);
  }
}

/** Read a private buffer's bytes, then put back the binding it borrowed. */
function readBufferBytes(gl: WebGL2RenderingContext, native: WebGLBuffer, size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  const priorCopyRead = gl.getParameter(GL_COPY_READ_BUFFER) as WebGLBuffer | null;
  gl.bindBuffer(GL_COPY_READ_BUFFER, native);
  if (size > 0) gl.getBufferSubData(GL_COPY_READ_BUFFER, 0, bytes);
  gl.bindBuffer(GL_COPY_READ_BUFFER, priorCopyRead);
  return bytes;
}

function readBuffers(gl: WebGL2RenderingContext, b: GlBinding): CheckpointGlBuffer[] {
  const out: CheckpointGlBuffer[] = [];
  const priorCopyRead = gl.getParameter(GL_COPY_READ_BUFFER) as WebGLBuffer | null;
  for (const [name, buffer] of b.buffers) {
    const store = b.bufferStores.get(buffer);
    if (!store) {
      out.push({ name, target: GL_ARRAY_BUFFER, usage: 0x88e4, bytes: new Uint8Array(0) });
      continue;
    }
    const bytes = new Uint8Array(store.size);
    gl.bindBuffer(GL_COPY_READ_BUFFER, store.source);
    if (store.size > 0) gl.getBufferSubData(GL_COPY_READ_BUFFER, 0, bytes);
    const target = store.views.has(GL_ARRAY_BUFFER) || !store.views.has(GL_ELEMENT_ARRAY_BUFFER)
      ? GL_ARRAY_BUFFER
      : GL_ELEMENT_ARRAY_BUFFER;
    out.push({ name, target, usage: store.usage, bytes });
  }
  gl.bindBuffer(GL_COPY_READ_BUFFER, priorCopyRead);
  return out;
}

/** Run `read` with a scratch read framebuffer bound and rows packed
 * tightly, then put back the bindings it borrowed. */
function withScratchRead<T>(gl: WebGL2RenderingContext, read: () => T): T {
  const priorRead = gl.getParameter(GL_READ_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
  const priorTexture = gl.getParameter(GL_TEXTURE_BINDING_2D) as WebGLTexture | null;
  const scratch = gl.createFramebuffer();
  gl.bindFramebuffer(GL_READ_FRAMEBUFFER, scratch);
  gl.pixelStorei(GL_PACK_ALIGNMENT, 1);
  try {
    return read();
  } finally {
    gl.framebufferTexture2D(GL_READ_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, null, 0);
    gl.bindFramebuffer(GL_READ_FRAMEBUFFER, priorRead);
    gl.deleteFramebuffer(scratch);
    gl.bindTexture(GL_TEXTURE_2D, priorTexture);
  }
}

/** The sampler parameters of the texture bound to TEXTURE_2D. */
function readParameters(gl: WebGL2RenderingContext) {
  const parameter = (pname: number) => Number(gl.getTexParameter(GL_TEXTURE_2D, pname));
  return {
    minFilter: parameter(GL_TEXTURE_MIN_FILTER),
    magFilter: parameter(GL_TEXTURE_MAG_FILTER),
    wrapS: parameter(GL_TEXTURE_WRAP_S),
    wrapT: parameter(GL_TEXTURE_WRAP_T),
  };
}

function readTextures(
  gl: WebGL2RenderingContext,
  b: GlBinding,
  boundaries: string[],
): CheckpointGlTexture[] {
  return withScratchRead(gl, () => {
    const out: CheckpointGlTexture[] = [];
    for (const [name, texture] of b.textures) {
      if (b.foreignTextureBos.has(texture)) continue;
      const native = textureNative(b, texture);
      gl.bindTexture(GL_TEXTURE_2D, native);
      const levels: CheckpointGlTextureLevel[] = [];
      for (const [level, spec] of textureFaces(texture).get(GL_TEXTURE_2D) ?? []) {
        levels.push(readLevel(gl, native, name, level, spec, boundaries));
      }
      levels.sort((left, right) => left.level - right.level);
      out.push({ name, levels, ...readParameters(gl) });
    }
    return out;
  });
}

function readForeignTextures(gl: WebGL2RenderingContext, b: GlBinding): CheckpointGlForeignTexture[] {
  return withScratchRead(gl, () => {
    const out: CheckpointGlForeignTexture[] = [];
    for (const [boId, entry] of b.foreignTextures) {
      const native = textureNative(b, entry.tex);
      gl.bindTexture(GL_TEXTURE_2D, native);
      const parameters = readParameters(gl);
      if (b.textureViews.has(entry.tex)) {
        out.push({ name: entry.texId, boId, width: entry.w, height: entry.h, pixels: null, ...parameters });
        continue;
      }
      gl.framebufferTexture2D(GL_READ_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, native, 0);
      if (gl.checkFramebufferStatus(GL_READ_FRAMEBUFFER) !== GL_FRAMEBUFFER_COMPLETE) {
        refuse(`foreign texture ${entry.texId} is not readable on this GPU`);
      }
      const pixels = new Uint8Array(entry.w * entry.h * 4);
      gl.readPixels(0, 0, entry.w, entry.h, GL_RGBA, GL_UNSIGNED_BYTE, pixels);
      out.push({ name: entry.texId, boId, width: entry.w, height: entry.h, pixels, ...parameters });
    }
    return out;
  });
}

/** Channels of a guest format, in the order the RGBA readback holds them. */
function guestChannels(format: number): readonly number[] | null {
  switch (format) {
    case GL_RGBA: return [0, 1, 2, 3];
    case GL_RGB: return [0, 1, 2];
    case GL_LUMINANCE: return [0];
    case GL_ALPHA: return [3];
    case GL_LUMINANCE_ALPHA: return [0, 3];
    default: return null;
  }
}

function readLevel(
  gl: WebGL2RenderingContext,
  native: WebGLTexture,
  name: number,
  level: number,
  spec: GlTextureLevel,
  boundaries: string[],
): CheckpointGlTextureLevel {
  if (spec.compressed || !spec.gles) {
    refuse(`texture ${name} level ${level} holds storage the guest did not specify`);
  }
  const gles = spec.gles;
  const carried = {
    level,
    internalFormat: gles.internalFormat,
    width: spec.width,
    height: spec.height,
    format: gles.format,
    type: gles.type,
  };
  const unreadable = (reason: string): CheckpointGlTextureLevel => {
    boundaries.push(`texture ${name} level ${level} ${reason}; restored uninitialized`);
    return { ...carried, pixels: null };
  };
  if (gles.depth || gles.stencil) return unreadable("holds depth or stencil data");
  const channels = guestChannels(gles.format);
  const float = gles.type === GL_FLOAT || gles.type === GL_HALF_FLOAT;
  if (!channels || (!float && gles.type !== GL_UNSIGNED_BYTE)) {
    return unreadable(`uses format 0x${gles.format.toString(16)}/0x${gles.type.toString(16)}`);
  }
  // Byte LUMINANCE/ALPHA storage is not color-renderable; only expanded
  // float levels hold their channels in RGBA (luminance-float.ts).
  if (channels.length !== 3 && channels.length !== 4 && !gles.expanded) {
    return unreadable("is not readable as a color attachment");
  }
  gl.framebufferTexture2D(GL_READ_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, native, level);
  if (gl.checkFramebufferStatus(GL_READ_FRAMEBUFFER) !== GL_FRAMEBUFFER_COMPLETE) {
    return unreadable("is not readable as a color attachment on this GPU");
  }
  const count = spec.width * spec.height;
  const rgba = float ? new Float32Array(count * 4) : new Uint8Array(count * 4);
  gl.readPixels(0, 0, spec.width, spec.height, GL_RGBA, float ? GL_FLOAT : GL_UNSIGNED_BYTE, rgba);
  return { ...carried, pixels: packTexels(rgba, count, channels, gles.type) };
}

/** IEEE 754 binary16 bits of `value`, rounding to nearest even. */
export function halfBits(value: number): number {
  const word = new Float32Array([value]);
  const bits = new Uint32Array(word.buffer)[0]!;
  const sign = (bits >>> 16) & 0x8000;
  const exponent = (bits >>> 23) & 0xff;
  let mantissa = bits & 0x7fffff;
  if (exponent === 0xff) return sign | 0x7c00 | (mantissa ? 0x200 : 0);
  let e = exponent - 127 + 15;
  if (e >= 0x1f) return sign | 0x7c00;
  if (e <= 0) {
    if (e < -10) return sign;
    mantissa |= 0x800000;
    const shift = 14 - e;
    const half = mantissa >>> shift;
    const rest = mantissa & ((1 << shift) - 1);
    const midpoint = 1 << (shift - 1);
    return sign | (half + (rest > midpoint || (rest === midpoint && (half & 1)) ? 1 : 0));
  }
  const rest = mantissa & 0x1fff;
  let half = (e << 10) | (mantissa >>> 13);
  if (rest > 0x1000 || (rest === 0x1000 && (half & 1))) half++;
  return sign | half;
}

function packTexels(
  rgba: Float32Array | Uint8Array,
  count: number,
  channels: readonly number[],
  type: number,
): Uint8Array {
  const width = channels.length;
  const out = type === GL_FLOAT ? new Float32Array(count * width)
    : type === GL_HALF_FLOAT ? new Uint16Array(count * width)
      : new Uint8Array(count * width);
  for (let texel = 0; texel < count; texel++) {
    for (let channel = 0; channel < width; channel++) {
      const value = rgba[texel * 4 + channels[channel]!]!;
      out[texel * width + channel] = type === GL_HALF_FLOAT ? halfBits(value) : value;
    }
  }
  return new Uint8Array(out.buffer);
}

function readRenderbuffers(b: GlBinding, boundaries: string[]): CheckpointGlRenderbuffer[] {
  const out: CheckpointGlRenderbuffer[] = [];
  for (const [name, renderbuffer] of b.rbos) {
    const size = renderbufferRecordedSize(renderbuffer);
    out.push({
      name,
      internalFormat: size ? renderbufferLogicalFormat(renderbuffer) ?? 0 : 0,
      width: size?.[0] ?? 0,
      height: size?.[1] ?? 0,
    });
  }
  if (out.some((renderbuffer) => renderbuffer.internalFormat !== 0)) {
    boundaries.push("renderbuffer contents cannot be read out of WebGL2; restored uninitialized");
  }
  return out;
}

function readShaders(gl: WebGL2RenderingContext, b: GlBinding): CheckpointGlShader[] {
  const out: CheckpointGlShader[] = [];
  for (const [name, shader] of b.shaders) {
    const source = b.shaderSources.get(shader);
    if (source && source.byteLength > MAX_RECORD_PAYLOAD - 8) {
      refuse(`shader ${name}'s source is longer than one command record carries`);
    }
    out.push({
      name,
      type: shaderType(shader) ?? refuse(`shader ${name} has no recorded type`),
      source: source ? source.slice() : null,
      compiled: gl.getShaderParameter(shader, GL_COMPILE_STATUS) === true,
      deletePending: b.shaderDeletePending.has(name),
    });
  }
  return out;
}

function uniformValues(value: unknown): number[] | null {
  if (typeof value === "number") return [value];
  if (typeof value === "boolean") return [value ? 1 : 0];
  if (value instanceof Float32Array || value instanceof Int32Array || value instanceof Uint32Array) {
    return [...value];
  }
  if (Array.isArray(value)) return value.map((element) => Number(element));
  return null;
}

function readPrograms(gl: WebGL2RenderingContext, b: GlBinding): CheckpointGlProgram[] {
  const out: CheckpointGlProgram[] = [];
  for (const [name, program] of b.programs) {
    const linked = gl.getProgramParameter(program, GL_LINK_STATUS) === true;
    if (linked && linkInputsChanged(b, name)) {
      refuse(`program ${name} changed its shaders, sources or attribute bindings after its link, which the rebuild cannot link again`);
    }
    const uniforms: CheckpointGlUniformEntry[] = [];
    const values: CheckpointGlUniformValue[] = [];
    if (linked) {
      const layout = uniformLayout(b, program)
        ?? refuse(`program ${name}'s uniforms could not be reflected`);
      for (const entry of layout.entries) {
        uniforms.push({
          name: entry.name,
          type: entry.type,
          guestType: entry.guestType,
          size: entry.size,
          array: entry.array,
          location: entry.location,
        });
        if (!uniformTypeCarried(entry.type)) {
          refuse(`program ${name}'s uniform ${entry.name} has type 0x${entry.type.toString(16)}, which the rebuild cannot set`);
        }
        for (let element = 0; element < entry.size; element++) {
          const location = entry.location + element;
          const native = layout.native(b, location)
            || refuse(`program ${name}'s uniform ${entry.name} has no native location`);
          const read = uniformValues(gl.getUniform(program, native))
            ?? refuse(`program ${name}'s uniform ${entry.name} holds a value the checkpoint does not carry`);
          values.push({ location, type: entry.type, values: read });
        }
      }
    }
    out.push({
      name,
      shaders: [...(b.programShaders.get(name) ?? [])],
      attribBindings: [...(b.programAttributeBindings.get(name) ?? [])].map(
        ([attribute, index]) => ({ name: attribute, index }),
      ),
      linked,
      deletePending: b.programDeletePending.has(name),
      uniforms,
      values,
    });
  }
  return out;
}

function readVertexArrays(b: GlBinding): CheckpointGlVertexArray[] {
  const out: CheckpointGlVertexArray[] = [];
  for (const [name, array] of b.vertexArrays) {
    if (name !== 0 && !b.vaos.has(name)) continue;
    out.push({
      name,
      element: array.element === null ? null : nameOf(b.buffers, array.element, `vertex array ${name}'s index buffer`),
      attributes: [...array.attributes].map(([index, attribute]) => ({
        index,
        buffer: attribute.buffer === null ? null : nameOf(b.buffers, attribute.buffer, `attribute ${index}'s buffer`),
        enabled: attribute.enabled,
        size: attribute.size,
        type: attribute.type,
        normalized: attribute.normalized,
        stride: attribute.stride,
        offset: attribute.offset,
      })),
    });
  }
  return out;
}

function readFramebuffers(b: GlBinding): CheckpointGlFramebuffer[] {
  const out: CheckpointGlFramebuffer[] = [];
  for (const [name, framebuffer] of b.fbos) {
    const attachments: CheckpointGlAttachment[] = [];
    for (const [attachment, image] of b.framebufferAttachments.get(framebuffer) ?? []) {
      attachments.push(image.kind === "texture"
        ? {
          attachment,
          kind: "texture",
          target: image.target,
          name: nameOf(b.textures, image.object, `framebuffer ${name}'s texture`),
          level: image.level,
        }
        : {
          attachment,
          kind: "renderbuffer",
          target: 0x8d41,
          name: nameOf(b.rbos, image.object, `framebuffer ${name}'s renderbuffer`),
          level: 0,
        });
    }
    out.push({ name, attachments });
  }
  return out;
}

const CAPABILITIES = [
  [0x0b71, "depthTestEnabled"],
  [0x0b90, "stencilTestEnabled"],
  [0x0be2, "blendEnabled"],
  [0x0b44, "cullFaceEnabled"],
  [0x8037, "polygonOffsetFillEnabled"],
  [0x0bd0, "ditherEnabled"],
  [0x80a0, "sampleCoverageEnabled"],
  [0x809e, "sampleAlphaToCoverageEnabled"],
] as const;

function readState(b: GlBinding): CheckpointGlState {
  const s = b.shadow;
  // A framebuffer the guest does not name is its window or surfaceless
  // default framebuffer, name 0.
  const framebuffer = (object: WebGLFramebuffer | null): number => {
    for (const [name, value] of b.fbos) if (value === object) return name;
    return 0;
  };
  const textureUnits: { unit: number; name: number }[] = [];
  s.textureUnits.forEach((texture, unit) => {
    if (texture) textureUnits.push({ unit, name: nameOf(b.textures, texture, `texture unit ${unit}'s texture`) });
  });
  if (s.cubeTextureUnits.some(Boolean) || s.externalTextureUnits.some(Boolean)) {
    refuse(`pid ${b.pid}'s GL session ${b.sessionId} binds a cube-map or external texture`);
  }
  if (framebuffer(s.fbo) !== framebuffer(s.readFbo)) {
    refuse(`pid ${b.pid}'s GL session ${b.sessionId} draws and reads different framebuffers`);
  }
  const face = (code: number, state: typeof s.stencil.front) => ({ face: code, ...state });
  return {
    viewport: [...s.viewport],
    scissor: [...s.scissor.rect],
    capabilities: [
      { cap: 0x0c11, enabled: s.scissor.enabled },
      ...CAPABILITIES.map(([cap, field]) => ({ cap, enabled: s[field] })),
    ],
    clearColor: [...s.clearColor],
    clearDepth: s.clearDepth,
    clearStencil: s.clearStencil,
    colorMask: [...s.colorMask],
    depthFunc: s.depthFunc,
    depthMask: s.depthMask,
    depthRange: [...s.depthRange],
    stencil: [face(0x0404, s.stencil.front), face(0x0405, s.stencil.back)],
    blendFunc: [s.blendFunc.srcRGB, s.blendFunc.dstRGB, s.blendFunc.srcA, s.blendFunc.dstA],
    blendEquation: [s.blendEquation.rgb, s.blendEquation.alpha],
    blendColor: [...s.blendColor],
    cullFace: s.cullFace,
    frontFace: s.frontFace,
    lineWidth: s.lineWidth,
    polygonOffset: [...s.polygonOffset],
    sampleCoverage: [...s.sampleCoverage],
    unpackAlignment: s.unpackAlignment,
    packAlignment: s.packAlignment,
    vertexAttribValues: [...s.vertexAttribValues].map(([index, value]) => ({ index, value: [...value] })),
    activeTexture: s.activeTexture,
    textureUnits,
    program: b.currentProgram === null ? 0 : b.currentProgramId,
    vertexArray: b.vertexArrayId,
    framebuffer: framebuffer(s.fbo),
    renderbuffer: nameOf(b.rbos, s.renderbuffer, "the bound renderbuffer"),
    arrayBuffer: s.arrayBuffer === null
      ? 0
      : nameOf(b.buffers, canonicalBuffer(b, s.arrayBuffer), "the bound array buffer"),
  };
}
