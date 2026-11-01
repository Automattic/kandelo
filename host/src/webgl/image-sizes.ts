/**
 * Logical image sizes for ES 2.0 framebuffer completeness (section 4.4.5).
 *
 * ES 2.0 requires every attached image to have the same width and height,
 * else FRAMEBUFFER_INCOMPLETE_DIMENSIONS, and draw/clear/read/copy on an
 * incomplete framebuffer raise INVALID_FRAMEBUFFER_OPERATION. WebGL 2 follows
 * ES 3.0, which dropped that rule (mismatched attachments are complete and
 * render to their intersection), and it has no GetTexLevelParameter to ask
 * the size of a texture level. The host therefore records the size of every
 * accepted image specification, keyed by the logical texture or renderbuffer
 * object (which survives private storage views and is shared by EGL share
 * groups), and per 2D target or cube face and level.
 */
import type { GlBinding } from "./registry.js";
import type { GlImageAttachment } from "./image-references.js";
import { isDefaultFramebuffer } from "./framebuffer.js";
import { recordGlError } from "./errors.js";

type Size = readonly [number, number];
const TEXTURE_2D = 0x0de1, CUBE_MAP = 0x8513;
const CUBE_FACES = [0x8515, 0x8516, 0x8517, 0x8518, 0x8519, 0x851a];
const textureLevels = new WeakMap<WebGLTexture, Map<number, Map<number, Size>>>();
const renderbufferSizes = new WeakMap<WebGLRenderbuffer, Size>();

/** The logical object an image command addresses on the active unit. Texture
 * zero (null) cannot be attached to a framebuffer, so it is not tracked. */
function boundTexture(b: GlBinding, cube: boolean): WebGLTexture | null {
  return (cube ? b.shadow.cubeTextureUnits : b.shadow.textureUnits)[b.shadow.activeTexture] ?? null;
}

function levels(texture: WebGLTexture, face: number): Map<number, Size> {
  let faces = textureLevels.get(texture);
  if (!faces) { faces = new Map(); textureLevels.set(texture, faces); }
  let sizes = faces.get(face);
  if (!sizes) { sizes = new Map(); faces.set(face, sizes); }
  return sizes;
}

/** An accepted TexImage2D, CopyTexImage2D or CompressedTexImage2D. */
export function recordTextureImage(b: GlBinding, target: number, level: number, width: number, height: number): void {
  const texture = boundTexture(b, target !== TEXTURE_2D);
  if (texture) levels(texture, target).set(level, [width, height]);
}

/** An accepted GenerateMipmap derives levels base+1..q from each face's
 * level 0 (ES 2.0 section 3.7.11); higher existing levels are untouched. */
export function recordGeneratedMipmaps(b: GlBinding, target: number): void {
  const texture = boundTexture(b, target === CUBE_MAP);
  if (!texture) return;
  for (const face of target === CUBE_MAP ? CUBE_FACES : [TEXTURE_2D]) {
    const sizes = levels(texture, face), base = sizes.get(0);
    if (!base) continue;
    const q = Math.floor(Math.log2(Math.max(base[0], base[1], 1)));
    for (let level = 1; level <= q; level++)
      sizes.set(level, [Math.max(1, base[0] >> level), Math.max(1, base[1] >> level)]);
  }
}

/** EGLImage targets and foreign BO textures replace the whole texture with
 * one level-zero 2D image. */
export function recordTextureReplacement(texture: WebGLTexture, width: number, height: number): void {
  textureLevels.set(texture, new Map([[TEXTURE_2D, new Map([[0, [width, height] as Size]])]]));
}

export function recordRenderbufferSize(renderbuffer: WebGLRenderbuffer | null, width: number, height: number): void {
  if (renderbuffer) renderbufferSizes.set(renderbuffer, [width, height]);
}

function attachmentSize(image: GlImageAttachment): Size | undefined {
  return image.kind === "texture"
    ? textureLevels.get(image.object)?.get(image.target)?.get(image.level)
    : renderbufferSizes.get(image.object);
}

/** True when two attached images of a user framebuffer have different sizes.
 * An attachment without a recorded image is left to native completeness: a
 * missing image is FRAMEBUFFER_INCOMPLETE_ATTACHMENT, an earlier clause. */
export function framebufferDimensionsDiffer(b: GlBinding, framebuffer: WebGLFramebuffer | null): boolean {
  if (!framebuffer || isDefaultFramebuffer(b, framebuffer)) return false;
  let first: Size | undefined;
  for (const image of b.framebufferAttachments.get(framebuffer)?.values() ?? []) {
    const size = attachmentSize(image);
    if (!size) continue;
    if (!first) first = size;
    else if (size[0] !== first[0] || size[1] !== first[1]) return true;
  }
  return false;
}

/** Draw/clear (read = false) and ReadPixels/CopyTex* (read = true) preflight.
 * Records INVALID_FRAMEBUFFER_OPERATION before any native side effect. */
export function requireFramebufferDimensions(b: GlBinding, read = false): boolean {
  if (!framebufferDimensionsDiffer(b, read ? b.shadow.readFbo : b.shadow.fbo)) return true;
  recordGlError(b, 0x506);
  return false;
}

/** ES 2.0 completeness clauses in order: attachment completeness and missing
 * attachments come before dimensions, which come before UNSUPPORTED. */
export function glesFramebufferStatus(b: GlBinding, framebuffer: WebGLFramebuffer | null, nativeStatus: number): number {
  if ((nativeStatus === 0x8cd5 || nativeStatus === 0x8cdd) && framebufferDimensionsDiffer(b, framebuffer)) return 0x8cd9;
  return nativeStatus;
}
