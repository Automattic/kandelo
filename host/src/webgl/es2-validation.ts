/**
 * GLES 2.0 argument rules the host evaluates itself instead of asking the
 * native WebGL renderer (Stage A2 of the GL predict-then-execute plan,
 * decision D-48).
 *
 * WHY. Each rule here used to be decided by native refusal: the host called
 * WebGL, then getError(), a synchronous GPU-process round trip, and passed
 * the native error to the guest. The native-divergence audit (native-audit.ts)
 * found these rules exercised by dEQP-GLES2. Evaluated here, from the
 * command's arguments and host state, the host records the GLES 2.0 error
 * before any native call, and the native renderer only ever sees commands it
 * accepts.
 *
 * Each function is pure: it returns the GL error the command raises (0 when
 * none), so the rules are table-driven and testable without a renderer, and a
 * later stage can move them into the guest library or the kernel unchanged.
 * Limits are passed in by the caller from the renderer's cached values.
 */

const INVALID_ENUM = 0x500, INVALID_VALUE = 0x501, INVALID_OPERATION = 0x502;

const NEAREST = 0x2600, LINEAR = 0x2601;
/** ES 2.0 table 3.10: the values each TexParameter name accepts. */
const TEXTURE_PARAMETER_VALUES: ReadonlyMap<number, ReadonlySet<number>> = new Map([
  [0x2800 /* MAG_FILTER */, new Set([NEAREST, LINEAR])],
  [0x2801 /* MIN_FILTER */, new Set([NEAREST, LINEAR, 0x2700, 0x2701, 0x2702, 0x2703])],
  [0x2802 /* WRAP_S */, new Set([0x2901 /* REPEAT */, 0x812f /* CLAMP_TO_EDGE */, 0x8370 /* MIRRORED_REPEAT */])],
  [0x2803 /* WRAP_T */, new Set([0x2901, 0x812f, 0x8370])],
]);

/** ES 2.0 section 3.7.4 / table 3.10: INVALID_ENUM for a value the name does
 * not accept. A float value names an enum after conversion to the nearest
 * integer (section 2.3.1). Names outside the table are the caller's check. */
export function texParameterValueError(pname: number, value: number): number {
  const accepted = TEXTURE_PARAMETER_VALUES.get(pname);
  if (!accepted) return 0;
  return accepted.has(Math.round(value)) ? 0 : INVALID_ENUM;
}

/** ES 2.0 section 3.7.1 (TexImage2D, CopyTexImage2D) for a 2D image: width
 * and height in [0, maxSize >> level], border 0; INVALID_VALUE otherwise.
 * The level itself is checked by the caller. A null `maxSize` (limit
 * unavailable) predicts only the sign and border rules. */
export function texImageSizeError(maxSize: number | null, level: number, width: number, height: number, border: number): number {
  const limit = maxSize === null ? Infinity : level >= 0 && level < 32 ? Math.floor(maxSize / 2 ** level) : 0;
  if (width < 0 || height < 0 || width > limit || height > limit || border !== 0) return INVALID_VALUE;
  return 0;
}

/** ES 2.0 section 3.7.2 (TexSubImage2D, CopyTexSubImage2D): negative offsets
 * or sizes and x+w / y+h past the level's size are INVALID_VALUE. `level` is
 * the host's record of the destination image; without one (an image the host
 * did not record) only the sign rule is predicted. */
export function subImageError(level: { width: number; height: number } | undefined,
    x: number, y: number, width: number, height: number): number {
  if (x < 0 || y < 0 || width < 0 || height < 0) return INVALID_VALUE;
  if (level && (x + width > level.width || y + height > level.height)) return INVALID_VALUE;
  return 0;
}

/** ES 2.0 section 4.4.2.1 RenderbufferStorage, after the internal format:
 * target RENDERBUFFER (INVALID_ENUM), sizes in [0, MAX_RENDERBUFFER_SIZE]
 * (INVALID_VALUE), a renderbuffer bound (INVALID_OPERATION, section 4.4.3). */
export function renderbufferStorageError(target: number, width: number, height: number, maxSize: number | null,
    bound: boolean): number {
  if (target !== 0x8d41) return INVALID_ENUM;
  const limit = maxSize ?? Infinity;
  if (width < 0 || height < 0 || width > limit || height > limit) return INVALID_VALUE;
  return bound ? 0 : INVALID_OPERATION;
}

/** ES 2.0 section 2.10.3 AttachShader: a program holds at most one shader of
 * each type (INVALID_OPERATION). `attachedTypes` are the types of the
 * shaders already attached; an unknown type (undefined) predicts nothing. */
export function attachShaderError(attachedTypes: Iterable<number | undefined>, type: number | undefined): number {
  if (type === undefined) return 0;
  for (const attached of attachedTypes) if (attached === type) return INVALID_OPERATION;
  return 0;
}

/** ES 2.0 section 2.10.4 BindAttribLocation: index < MAX_VERTEX_ATTRIBS
 * (INVALID_VALUE); a name starting with "gl_" (INVALID_OPERATION). */
export function bindAttribLocationError(index: number, maxAttributes: number | null, name: string): number {
  if (maxAttributes !== null && index >= maxAttributes) return INVALID_VALUE;
  return name.startsWith("gl_") ? INVALID_OPERATION : 0;
}

/** ES 2.0 section 2.7 Enable/DisableVertexAttribArray (and the other
 * per-attribute commands): index < MAX_VERTEX_ATTRIBS (INVALID_VALUE). */
export function vertexAttribIndexError(index: number, maxAttributes: number): number {
  return index >= maxAttributes ? INVALID_VALUE : 0;
}

/** ES 2.0 section 2.10.1 CreateShader: VERTEX_SHADER or FRAGMENT_SHADER,
 * else INVALID_ENUM. */
export function createShaderError(type: number): number {
  return type === 0x8b31 || type === 0x8b30 ? 0 : INVALID_ENUM;
}

/** ES 2.0 section 2.10.3 UseProgram: a program whose last link did not
 * succeed is INVALID_OPERATION (0 selects no program). */
export function useProgramError(program: object | null, linked: boolean): number {
  return program === null || linked ? 0 : INVALID_OPERATION;
}

/** ES 2.0 section 3.7.13 BindTexture: a texture keeps the target of its first
 * bind; another target is INVALID_OPERATION. `fixed` is that target when the
 * host knows it. */
export function bindTextureError(fixed: number | undefined, target: number): number {
  return fixed === undefined || fixed === target ? 0 : INVALID_OPERATION;
}

/** Sampler uniforms take texture unit numbers in [0, units). ES 2.0 lists no
 * error for other values; WebGL 2 (and ES 3.0) raise INVALID_VALUE and leave
 * the uniform unchanged, which is the behavior the guest has always seen
 * here, so the host predicts the same. */
export function samplerValueError(values: Iterable<number>, units: number): number {
  for (const value of values) if (value < 0 || value >= units) return INVALID_VALUE;
  return 0;
}

/** BufferData usage: ES 2.0 section 2.9 names STREAM_DRAW, STATIC_DRAW and
 * DYNAMIC_DRAW; the WebGL 2 renderer also accepts the six ES 3.0 READ/COPY
 * usages, and the host keeps accepting what it accepted before. Any other
 * value is INVALID_ENUM. */
const BUFFER_USAGES = new Set([0x88e0, 0x88e1, 0x88e2, 0x88e4, 0x88e5, 0x88e6, 0x88e8, 0x88e9, 0x88ea]);
export function bufferUsageError(usage: number): number {
  return BUFFER_USAGES.has(usage) ? 0 : INVALID_ENUM;
}

const COMPONENTS: ReadonlyMap<number, number> = new Map([
  [0x1908 /* RGBA */, 4], [0x1907 /* RGB */, 3], [0x190a /* LUMINANCE_ALPHA */, 2], [0x1909 /* LUMINANCE */, 1],
  [0x1906 /* ALPHA */, 1], [0x1903 /* RED */, 1], [0x8227 /* RG */, 2], [0x1902 /* DEPTH_COMPONENT */, 1],
  [0x84f9 /* DEPTH_STENCIL */, 1],
]);
const COMPONENT_BYTES: ReadonlyMap<number, number> = new Map([
  [0x1401 /* UNSIGNED_BYTE */, 1], [0x1406 /* FLOAT */, 4], [0x140b /* HALF_FLOAT */, 2],
  [0x1403 /* UNSIGNED_SHORT */, 2], [0x1405 /* UNSIGNED_INT */, 4],
]);
const PACKED_BYTES: ReadonlyMap<number, number> = new Map([
  [0x8363 /* UNSIGNED_SHORT_5_6_5 */, 2], [0x8033 /* UNSIGNED_SHORT_4_4_4_4 */, 2],
  [0x8034 /* UNSIGNED_SHORT_5_5_5_1 */, 2], [0x8368 /* UNSIGNED_INT_2_10_10_10_REV */, 4],
  [0x84fa /* UNSIGNED_INT_24_8 */, 4], [0x8dad /* FLOAT_32_UNSIGNED_INT_24_8_REV */, 8],
]);
/** Bytes of one pixel of a native (format, type) transfer; null when the
 * host has no row for the pair (and so predicts nothing about its size). */
export function pixelBytes(format: number, type: number): number | null {
  const packed = PACKED_BYTES.get(type);
  if (packed !== undefined) return packed;
  const components = COMPONENTS.get(format), bytes = COMPONENT_BYTES.get(type);
  return components === undefined || bytes === undefined ? null : components * bytes;
}

/** Pixel data a TexImage2D/TexSubImage2D upload of width x height reads with
 * rows padded to the unpack alignment (the host leaves ROW_LENGTH and SKIP_*
 * at 0; the guest library applies EXT_unpack_subimage itself). WebGL refuses
 * shorter client data with INVALID_OPERATION. Null when unknown. */
export function uploadBytes(width: number, height: number, format: number, type: number, alignment: number): number | null {
  const bytes = pixelBytes(format, type);
  if (bytes === null || width < 0 || height < 0) return null;
  if (width === 0 || height === 0) return 0;
  const row = width * bytes, stride = Math.ceil(row / alignment) * alignment;
  return (height - 1) * stride + row;
}

/** WebGL's client-data size rule: INVALID_OPERATION when `available` bytes
 * are fewer than the upload reads; nothing predicted when the size is
 * unknown. */
export function uploadSizeError(required: number | null, available: number): number {
  return required !== null && available < required ? INVALID_OPERATION : 0;
}

/** The WebGL 2 TexImage2D (format, type) transfer pair for a sized internal
 * format (OpenGL ES 3.0 table 3.2), used where the host allocates texture
 * storage for an image that only records its sized format, such as a
 * renderbuffer EGLImage source. Null for a format with no color transfer. */
const SIZED_TRANSFER: ReadonlyMap<number, readonly [number, number]> = new Map([
  [0x8058 /* RGBA8 */, [0x1908, 0x1401]],
  [0x8056 /* RGBA4 */, [0x1908, 0x8033]],
  [0x8057 /* RGB5_A1 */, [0x1908, 0x8034]],
  [0x8051 /* RGB8 */, [0x1907, 0x1401]],
  [0x8d62 /* RGB565 */, [0x1907, 0x8363]],
  [0x8229 /* R8 */, [0x1903, 0x1401]],
  [0x822b /* RG8 */, [0x8227, 0x1401]],
  [0x881a /* RGBA16F */, [0x1908, 0x140b]],
  [0x881b /* RGB16F */, [0x1907, 0x140b]],
  [0x8814 /* RGBA32F */, [0x1908, 0x1406]],
  [0x8059 /* RGB10_A2 */, [0x1908, 0x8368]],
  [0x8c43 /* SRGB8_ALPHA8 */, [0x1908, 0x1401]],
]);
export function sizedFormatTransfer(internal: number): { format: number; type: number } | null {
  const pair = SIZED_TRANSFER.get(internal);
  return pair ? { format: pair[0], type: pair[1] } : null;
}
