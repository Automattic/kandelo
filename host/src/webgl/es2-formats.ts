import { glesExtensionAdvertised } from "./capabilities.js";

/**
 * GLES 2.0.25 image format admission.
 *
 * The native renderer is WebGL 2, which also accepts the GLES 3 sized,
 * integer and sRGB formats. A GLES 2 guest must not reach those: section
 * 3.7.1 (TexImage2D), section 3.7.2 (TexSubImage2D, CopyTexImage2D) and
 * section 4.4.3 (RenderbufferStorage) define the accepted values, and an
 * extension adds values only when the context advertises it. Every row below
 * names the extensions that must be advertised (empty = ES 2.0 core).
 *
 * The guest encoder (libc/glue/libglesv2_stub.c) applies the same table before
 * any checked storage request, because it must also know the bytes per pixel
 * of every admitted upload. This copy is the host's defence for records that
 * did not come through that encoder. GL_EXT_texture_format_BGRA8888 is a
 * client extension: the encoder validates BGRA and sends RGBA, so BGRA never
 * reaches this table.
 */

type Requirement = readonly string[];
type GlesExtensionProvider = { getExtension?(name: string): object | null };

const ALPHA = 0x1906, RGB = 0x1907, RGBA = 0x1908, LUMINANCE = 0x1909, LUMINANCE_ALPHA = 0x190a;
const RED = 0x1903, RG = 0x8227, DEPTH_COMPONENT = 0x1902, DEPTH_STENCIL = 0x84f9;
const UNSIGNED_BYTE = 0x1401, UNSIGNED_SHORT = 0x1403, UNSIGNED_INT = 0x1405, FLOAT = 0x1406;
const HALF_FLOAT_OES = 0x8d61, UNSIGNED_INT_24_8 = 0x84fa;
const BGRA = 0x80e1, BGRA8 = 0x93a1;
const UNSIGNED_SHORT_4_4_4_4 = 0x8033, UNSIGNED_SHORT_5_5_5_1 = 0x8034, UNSIGNED_SHORT_5_6_5 = 0x8363;

const CORE: Requirement = [];
const FLOAT_EXT = "GL_OES_texture_float", HALF_EXT = "GL_OES_texture_half_float";
const RG_EXT = "GL_EXT_texture_rg";

/** (format, type) rows of table 3.4 plus advertised extensions. For
 * TexImage2D the internal format must equal the format. */
const PIXEL_ROWS: ReadonlyArray<readonly [number, number, Requirement]> = [
  [RGBA, UNSIGNED_BYTE, CORE], [RGBA, UNSIGNED_SHORT_4_4_4_4, CORE], [RGBA, UNSIGNED_SHORT_5_5_5_1, CORE],
  [RGB, UNSIGNED_BYTE, CORE], [RGB, UNSIGNED_SHORT_5_6_5, CORE],
  [LUMINANCE_ALPHA, UNSIGNED_BYTE, CORE], [LUMINANCE, UNSIGNED_BYTE, CORE], [ALPHA, UNSIGNED_BYTE, CORE],
  ...[RGBA, RGB, LUMINANCE_ALPHA, LUMINANCE, ALPHA].flatMap(format => [
    [format, FLOAT, [FLOAT_EXT]] as const, [format, HALF_FLOAT_OES, [HALF_EXT]] as const,
  ]),
  // EXT_texture_rg interacts with OES_texture_float and OES_texture_half_float.
  ...[RED, RG].flatMap(format => [
    [format, UNSIGNED_BYTE, [RG_EXT]] as const, [format, FLOAT, [RG_EXT, FLOAT_EXT]] as const,
    [format, HALF_FLOAT_OES, [RG_EXT, HALF_EXT]] as const,
  ]),
  [DEPTH_COMPONENT, UNSIGNED_SHORT, ["GL_OES_depth_texture"]],
  [DEPTH_COMPONENT, UNSIGNED_INT, ["GL_OES_depth_texture"]],
  [DEPTH_STENCIL, UNSIGNED_INT_24_8, ["GL_OES_packed_depth_stencil"]],
];

/** CopyTexImage2D internal formats (section 3.7.2 plus EXT_texture_rg). */
const COPY_ROWS: ReadonlyArray<readonly [number, Requirement]> = [
  [ALPHA, CORE], [LUMINANCE, CORE], [LUMINANCE_ALPHA, CORE], [RGB, CORE], [RGBA, CORE],
  [RED, [RG_EXT]], [RG, [RG_EXT]],
];

/** RenderbufferStorage internal formats (section 4.4.3 plus extensions). */
const RENDERBUFFER_ROWS: ReadonlyArray<readonly [number, Requirement]> = [
  [0x8056, CORE], [0x8057, CORE], [0x8d62, CORE], [0x81a5, CORE], [0x8d48, CORE],
  [0x8051, ["GL_OES_rgb8_rgba8"]], [0x8058, ["GL_OES_rgb8_rgba8"]],
  [0x88f0, ["GL_OES_packed_depth_stencil"]],
  [0x8229, [RG_EXT]], [0x822b, [RG_EXT]],
  // EXT_texture_format_BGRA8888 is a client extension advertised by the
  // encoder, so it has no host requirement. The dEQP-GLES2 tables make BGRA
  // and BGRA8_EXT required-renderable renderbuffer formats
  // (glsFboCompletenessTests.cpp s_extTextureFormatBGRA8888Formats); the host
  // stores them as RGBA8.
  [BGRA, CORE], [BGRA8, CORE],
  // No color-buffer float extension is advertised to GLES 2 (capabilities.ts).
];

/** Sized texture internal formats accepted with one unsized (format, type).
 * EXT_texture_rg's R8/RG8 follow the dEQP-GLES2 tables
 * (glsFboCompletenessTests.cpp s_extTextureRgRboFormats: TEXTURE_VALID and
 * required color-renderable), uploaded as texImage2D(R8, RED, UNSIGNED_BYTE).
 * BGRA8_EXT with BGRA is mapped to RGBA by the encoder before it arrives. */
const SIZED_TEXTURE_ROWS: ReadonlyArray<readonly [number, number, number, Requirement]> = [
  [0x8229, RED, UNSIGNED_BYTE, [RG_EXT]], [0x822b, RG, UNSIGNED_BYTE, [RG_EXT]],
];

const INVALID_ENUM = 0x500, INVALID_VALUE = 0x501, INVALID_OPERATION = 0x502;

function advertised(gl: GlesExtensionProvider, requirement: Requirement): boolean {
  return requirement.every(name => glesExtensionAdvertised(gl, name));
}

function admittedPixelRows(gl: GlesExtensionProvider) {
  return PIXEL_ROWS.filter(([, , requirement]) => advertised(gl, requirement));
}

/** Format/type enum validity and the combination rule shared by both image
 * specification commands. INVALID_ENUM for a token no advertised API accepts,
 * then INVALID_OPERATION for a pair outside table 3.4. */
function pixelError(rows: ReturnType<typeof admittedPixelRows>, format: number, type: number): number {
  if (!rows.some(([f]) => f === format) || !rows.some(([, t]) => t === type)) return INVALID_ENUM;
  return 0;
}

export function texImageFormatError(gl: GlesExtensionProvider, internal: number, format: number, type: number): number {
  const rows = admittedPixelRows(gl);
  const enumError = pixelError(rows, format, type);
  if (enumError) return enumError;
  const sized = SIZED_TEXTURE_ROWS.find(([i, , , requirement]) => i === internal && advertised(gl, requirement));
  if (sized) return sized[1] === format && sized[2] === type ? 0 : INVALID_OPERATION;
  // Section 3.7.1: an internal format outside the base formats is
  // INVALID_VALUE, and one that differs from format is INVALID_OPERATION.
  if (!rows.some(([f]) => f === internal)) return INVALID_VALUE;
  if (internal !== format) return INVALID_OPERATION;
  return rows.some(([f, t]) => f === format && t === type) ? 0 : INVALID_OPERATION;
}

export function texSubImageFormatError(gl: GlesExtensionProvider, format: number, type: number): number {
  const rows = admittedPixelRows(gl);
  return pixelError(rows, format, type) ||
    (rows.some(([f, t]) => f === format && t === type) ? 0 : INVALID_OPERATION);
}

export function copyTexImageFormatError(gl: GlesExtensionProvider, internal: number): number {
  return COPY_ROWS.some(([format, requirement]) => format === internal && advertised(gl, requirement))
    ? 0 : INVALID_ENUM;
}

export function renderbufferFormatError(gl: GlesExtensionProvider, internal: number): number {
  return RENDERBUFFER_ROWS.some(([format, requirement]) => format === internal && advertised(gl, requirement))
    ? 0 : INVALID_ENUM;
}

/**
 * Section 4.4.5 color-renderability of an accepted image under ES 2.0 plus the
 * extensions this context advertises, following the dEQP-GLES2 format tables
 * (es2fFboCompletenessTests.cpp s_es2Formats/s_es2ExtFormats and
 * glsFboCompletenessTests.cpp s_esExtFormats): RGBA/RGB bytes
 * (OES_rgb8_rgba8), the 16-bit packed types, RED/RG of any admitted type
 * (EXT_texture_rg), and the ES2 and extension renderbuffer color formats.
 * LUMINANCE/ALPHA, depth/stencil and RGBA/RGB FLOAT or HALF_FLOAT_OES are not:
 * no advertised GLES 2 extension makes them so, although the host may enable
 * WebGL EXT_color_buffer_float natively for its own render targets.
 */
export function textureColorRenderable(internal: number, format: number, type: number): boolean {
  if (internal === 0x8229 || internal === 0x822b) return true;
  if (format === RED || format === RG) return true;
  if (format === RGBA) return type === UNSIGNED_BYTE || type === UNSIGNED_SHORT_4_4_4_4 || type === UNSIGNED_SHORT_5_5_5_1;
  if (format === RGB) return type === UNSIGNED_BYTE || type === UNSIGNED_SHORT_5_6_5;
  return false;
}

/** CopyTexImage2D produces an unsized level of the read buffer's component
 * type; only its base format decides color-renderability here. */
export function copiedTextureColorRenderable(internal: number): boolean {
  return internal === RGBA || internal === RGB || internal === RED || internal === RG;
}

export function renderbufferColorRenderable(internal: number): boolean {
  return [0x8056, 0x8057, 0x8d62, 0x8051, 0x8058, 0x8229, 0x822b, BGRA, BGRA8].includes(internal);
}

/** Native storage for a renderbuffer format: BGRA has no WebGL 2 format and
 * is stored as RGBA8 (the encoder swizzles BGRA texels the same way). */
export function nativeRenderbufferFormat(internal: number): number {
  return internal === BGRA || internal === BGRA8 ? 0x8058 : internal;
}
