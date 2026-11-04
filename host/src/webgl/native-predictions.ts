/**
 * Every known place where the host still lets the native WebGL renderer
 * decide whether a guest GL command is accepted (or which error it raises),
 * named with the GLES 2.0 / WebGL rule the host does not evaluate itself.
 *
 * WHY A TABLE. Stage A of the GL predict-then-execute plan makes host
 * validation authoritative (maintainer decision D-48). Each entry is a
 * prediction gap to close in Stage A2: replace it with a predicate that
 * computes the outcome from host state, then let the native-divergence audit
 * (native-audit.ts) prove that on dEQP and the compositors. The gaps are
 * keyed by the guest command (TLV op), guest query (QOP) or kernel import
 * that issues the native call, plus the native method that carries the
 * guest's arguments. That keeps the prediction logic in one table instead of
 * entangled with WebGL call sites, so a later stage can move it into the
 * guest library or the kernel without hunting through the host.
 *
 * The table changes nothing in production: it only labels native calls for
 * the test-only audit. A native call no entry matches is one the host
 * predicts will be accepted, so a native error there is a surprise.
 */
import * as O from "./ops.js";

/** A statement about a native call's outcome. */
export type NativePrediction = Readonly<
  | { kind: "native-decides"; label: string; rule: string }
  | { kind: "error"; label: string; error: number }
>;

/** The host does not predict this call: native refusal decides acceptance.
 * `rule` names the GLES 2.0 / WebGL rule the host does not yet evaluate. */
export function nativeDecides(label: string, rule: string): NativePrediction {
  return Object.freeze({ kind: "native-decides", label, rule });
}

// --- Guest commands (class (a): a native refusal decides the guest error) ---

export const TEX_SUB_IMAGE = nativeDecides("glTexSubImage2D",
  "ES 2.0 3.7.2: an undefined level or a format/type the level's native storage does not accept raise " +
  "INVALID_OPERATION, and bounds of a level the host did not record (sizes and client-data length are predicted)");
export const GENERATE_MIPMAP = nativeDecides("glGenerateMipmap",
  "ES 2.0 3.7.11 / WebGL 2: a compressed or non-color-renderable/filterable level 0, or an undefined " +
  "level 0, raise INVALID_OPERATION");
export const COMPRESSED_TEX_IMAGE = nativeDecides("glCompressedTexImage2D",
  "ES 2.0 3.7.3: imageSize inconsistent with format/size raises INVALID_VALUE; level, size and border " +
  "limits; an unsupported format raises INVALID_ENUM");
export const COMPRESSED_TEX_SUB_IMAGE = nativeDecides("glCompressedTexSubImage2D",
  "ES 2.0 3.7.3: offsets, size, format equal to the level's, imageSize");
export const COPY_TEX_IMAGE = nativeDecides("glCopyTexImage2D",
  "ES 2.0 3.7.2 / table 3.9: internalformat incompatible with the read buffer raises INVALID_OPERATION");
export const COPY_TEX_SUB_IMAGE = nativeDecides("glCopyTexSubImage2D",
  "ES 2.0 3.7.2: read-buffer format compatibility, an undefined level, bounds of an unrecorded level");
export const BIND_ATTRIB_LOCATION = nativeDecides("glBindAttribLocation",
  "WebGL's name length/character-set/webgl_ errors, which ES 2.0 does not define (the ES 2.0 index and " +
  "gl_ rules are predicted)");
export const DRAW = nativeDecides("glDrawArrays/glDrawElements",
  "WebGL draw validation: no current program (no ES 2.0 error), out-of-range attribute fetch (WebGL 1.0 6.6), " +
  "feedback loops, mixed sampler types on one unit (ES 2.0 2.10.4); framebuffer completeness is predicted");
export const USE_PROGRAM = nativeDecides("glUseProgram",
  "ES 2.0 2.10.3: a program the host never saw linked raises INVALID_OPERATION natively (a failed link is predicted)");
export const DRAW_BUFFERS = nativeDecides("glDrawBuffers(EXT)",
  "EXT_draw_buffers / ES 3.0 DrawBuffers rules (n, BACK/NONE/COLOR_ATTACHMENTi per framebuffer); no host validation");
export const READ_BUFFER = nativeDecides("glReadBuffer",
  "ES 3.0 / NV_read_buffer ReadBuffer rules; no host validation");

// --- Guest queries ---

export const READ_PIXELS = nativeDecides("glReadPixels",
  "ES 2.0 4.3.1: unknown format/type INVALID_ENUM; a pair other than RGBA/UNSIGNED_BYTE or the " +
  "IMPLEMENTATION_COLOR_READ pair INVALID_OPERATION (framebuffer completeness is predicted)");
export const LEGACY_ACTIVE_UNIFORM = nativeDecides("legacy QOP_GET_ACTIVE_UNIFORM",
  "ES 2.0 2.10.4: index >= ACTIVE_UNIFORMS raises INVALID_VALUE");
export const LEGACY_GET_UNIFORM = nativeDecides("legacy QOP_GET_UNIFORMFV/IV",
  "ES 2.0 6.1.8: an unlinked program or a location of another program raises INVALID_OPERATION");
export const IMPLEMENTATION_COLOR_READ = nativeDecides("glGetIntegerv(IMPLEMENTATION_COLOR_READ_*)",
  "WebGL 2: the read framebuffer's state (incomplete, no read buffer) decides INVALID_OPERATION");
export const UNIFORM_LOCATION_LENGTH = nativeDecides("glGetUniformLocation",
  "WebGL: a name longer than the location-name limit raises INVALID_VALUE; ES 2.0 has no such error");

// --- Host allocations sized by guest input (class (c) beyond OUT_OF_MEMORY) ---

export const GPU_STORAGE_SIZE = nativeDecides("GBM/EGLImage GPU storage",
  "texture/renderbuffer size against MAX_TEXTURE_SIZE / MAX_RENDERBUFFER_SIZE and the format's framebuffer " +
  "completeness are left to the native allocation");
export const SURFACE_TARGET_SIZE = nativeDecides("EGL surface present target",
  "the surface or canvas size against MAX_TEXTURE_SIZE / MAX_RENDERBUFFER_SIZE is left to the native allocation");
export const MULTISAMPLE_TARGET = nativeDecides("multisampled EGL surface",
  "size and sample count against MAX_RENDERBUFFER_SIZE / MAX_SAMPLES are left to the native allocation");
export const FRAMEBUFFER_ATTACHMENT = nativeDecides("glFramebufferTexture2D/Renderbuffer",
  "ES 2.0 4.4.3: attachment and textarget enums, textarget/texture type mismatch and level != 0 are left " +
  "to WebGL 2, which also accepts attachments ES 2.0 refuses");
export const BIND_TEXTURE_TARGET = nativeDecides("glBindTexture",
  "ES 2.0 3.7.13: the first bind of a texture whose native target the host has not recorded (a recorded " +
  "target mismatch is predicted)");
export const FOREIGN_TEXTURE_SIZE = nativeDecides("DRM bind-foreign-texture upload",
  "the buffer's width/height against MAX_TEXTURE_SIZE is left to the native upload");

type Gap = Readonly<{ methods: readonly string[]; prediction: NativePrediction }>;
const gap = (prediction: NativePrediction, ...methods: string[]): Gap => Object.freeze({ methods, prediction });

/** Guest commands, by TLV op (also used for a command carried by a checked
 * query such as QOP_IMAGE_STORAGE). Closed in Stage A2 and removed from this
 * table: glClear and draw framebuffer completeness, TexParameter values,
 * TexImage2D/CopyTexImage2D sizes and border, sub-image bounds of recorded
 * levels, RenderbufferStorage, AttachShader types, the ES 2.0
 * BindAttribLocation rules, vertex attribute array indices, CreateShader
 * types, a failed link at UseProgram, sampler uniform values, BufferData
 * usages and TexImage2D (with WebGL's client-data length rule)
 * (es2-validation.ts, image-sizes.ts). */
const OP_GAPS: ReadonlyMap<number, readonly Gap[]> = new Map<number, readonly Gap[]>([
  [O.OP_TEX_SUB_IMAGE_2D, [gap(TEX_SUB_IMAGE, "texSubImage2D", "texSubImage3D")]],
  [O.OP_GENERATE_MIPMAP, [gap(GENERATE_MIPMAP, "generateMipmap")]],
  [O.OP_COMPRESSED_TEX_IMAGE_2D, [gap(COMPRESSED_TEX_IMAGE, "compressedTexImage2D", "compressedTexImage3D", "compressedTexSubImage3D")]],
  [O.OP_COMPRESSED_TEX_SUB_IMAGE_2D, [gap(COMPRESSED_TEX_SUB_IMAGE, "compressedTexSubImage2D", "compressedTexSubImage3D")]],
  [O.OP_COPY_TEX_IMAGE_2D, [gap(COPY_TEX_IMAGE, "copyTexImage2D", "texImage3D", "copyTexSubImage3D")]],
  [O.OP_COPY_TEX_SUB_IMAGE_2D, [gap(COPY_TEX_SUB_IMAGE, "copyTexSubImage2D", "copyTexSubImage3D")]],
  [O.OP_USE_PROGRAM, [gap(USE_PROGRAM, "useProgram")]],
  // Journal admission already checked this immutable linked generation. Its
  // stored API error is replayed without a native call at the selector slot.
  [O.OP_USE_PROGRAM_JOURNAL, []],
  [O.OP_BIND_ATTRIB_LOCATION, [gap(BIND_ATTRIB_LOCATION, "bindAttribLocation")]],
  [O.OP_DRAW_ARRAYS, [gap(DRAW, "drawArrays")]],
  [O.OP_DRAW_ELEMENTS, [gap(DRAW, "drawElements")]],
  [O.OP_DRAW_CLIENT_ARRAYS, [gap(DRAW, "drawArrays")]],
  [O.OP_DRAW_BUFFER, [gap(DRAW_BUFFERS, "drawBuffers")]],
  [O.OP_DRAW_BUFFERS, [gap(DRAW_BUFFERS, "drawBuffers")]],
  [O.OP_READ_BUFFER, [gap(READ_BUFFER, "readBuffer")]],
  [O.OP_FRAMEBUFFER_TEXTURE_2D, [gap(FRAMEBUFFER_ATTACHMENT, "framebufferTexture2D", "framebufferTextureLayer")]],
  [O.OP_FRAMEBUFFER_RENDERBUFFER, [gap(FRAMEBUFFER_ATTACHMENT, "framebufferRenderbuffer")]],
  [O.OP_BIND_TEXTURE, [gap(BIND_TEXTURE_TARGET, "bindTexture")]],
]);

/** Guest queries, by QOP (the QOP's own native calls; a TLV op it carries is
 * looked up in OP_GAPS first). */
const QUERY_GAPS: ReadonlyMap<number, readonly Gap[]> = new Map<number, readonly Gap[]>([
  [O.QOP_READ_PIXELS, [gap(READ_PIXELS, "readPixels")]],
  [O.QOP_READBACK_CAPTURE, [gap(READ_PIXELS, "readPixels")]],
  [O.QOP_GET_ACTIVE_UNIFORM, [gap(LEGACY_ACTIVE_UNIFORM, "getActiveUniform")]],
  [O.QOP_GET_UNIFORMFV, [gap(LEGACY_GET_UNIFORM, "getUniform")]],
  [O.QOP_GET_UNIFORMIV, [gap(LEGACY_GET_UNIFORM, "getUniform")]],
  [O.QOP_GET_INTEGERV, [gap(IMPLEMENTATION_COLOR_READ, "getParameter")]],
  [O.QOP_GET_FLOATV, [gap(IMPLEMENTATION_COLOR_READ, "getParameter")]],
  [O.QOP_GET_UNIFORM_LOC, [gap(UNIFORM_LOCATION_LENGTH, "getUniformLocation")]],
  [O.QOP_LOOKUP_UNIFORM, [gap(UNIFORM_LOCATION_LENGTH, "getUniformLocation")]],
  [O.QOP_COMPRESSED_UPLOAD, [gap(COMPRESSED_TEX_IMAGE, "compressedTexImage2D", "compressedTexImage3D"),
    gap(COMPRESSED_TEX_SUB_IMAGE, "compressedTexSubImage2D", "compressedTexSubImage3D")]],
  [O.QOP_IMAGE_ATTACHMENT, [gap(FRAMEBUFFER_ATTACHMENT, "framebufferTexture2D", "framebufferTextureLayer", "framebufferRenderbuffer")]],
  [O.QOP_BIND_IMAGE_OBJECT, [gap(BIND_TEXTURE_TARGET, "bindTexture")]],
]);

/** Host allocations sized by guest input, by kernel import. */
const ENTRY_GAPS: ReadonlyMap<string, readonly Gap[]> = new Map<string, readonly Gap[]>([
  ["host_gbm_gpu_bo_create", [gap(GPU_STORAGE_SIZE, "texImage2D", "renderbufferStorage")]],
  ["host_gl_import_image", [gap(GPU_STORAGE_SIZE, "texImage2D", "renderbufferStorage")]],
  ["host_gl_import_planar_image", [gap(GPU_STORAGE_SIZE, "texImage2D", "renderbufferStorage")]],
  ["host_gl_bind_foreign_texture", [gap(FOREIGN_TEXTURE_SIZE, "texImage2D")]],
  ...["host_gl_create_surface", "host_gl_update_surface", "host_gl_create_context", "host_kms_set_fb", "host_gl_present"]
    .map(entry => [entry, [gap(SURFACE_TARGET_SIZE, "texImage2D", "renderbufferStorage"),
      gap(MULTISAMPLE_TARGET, "renderbufferStorageMultisample")]] as const),
]);

function match(gaps: readonly Gap[] | undefined, method: string): NativePrediction | undefined {
  if (gaps) for (const entry of gaps) if (entry.methods.includes(method)) return entry.prediction;
  return undefined;
}

/** The recorded gap for `method` called while executing guest op `op`,
 * guest query `query`, inside kernel import `entry`; undefined means the
 * host predicts acceptance. */
export function nativePredictionGap(op: number | null, query: number | null, entry: string | null,
    method: string): NativePrediction | undefined {
  return (op === null ? undefined : match(OP_GAPS.get(op), method))
    ?? (query === null ? undefined : match(QUERY_GAPS.get(query), method))
    ?? (entry === null ? undefined : match(ENTRY_GAPS.get(entry), method));
}
