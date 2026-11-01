/**
 * Logical image sizes for ES 2.0 framebuffer completeness (section 4.4.5).
 *
 * ES 2.0 requires every attached image to have the same width and height,
 * else FRAMEBUFFER_INCOMPLETE_DIMENSIONS, and draw/clear/read/copy on an
 * incomplete framebuffer raise INVALID_FRAMEBUFFER_OPERATION. WebGL 2 follows
 * ES 3.0, which dropped that rule (mismatched attachments are complete and
 * render to their intersection), and it has no GetTexLevelParameter to ask
 * the size of a texture level. Texture levels are read from the single
 * per-level record (texture-levels.ts); renderbuffer images are recorded
 * here, keyed by the logical renderbuffer object (which survives private
 * storage views and is shared by EGL share groups).
 *
 * Each record also carries whether the image is color-renderable under
 * ES 2.0 plus the advertised extensions (es2-formats.ts). WebGL 2 may render
 * to formats a GLES 2 context must report FRAMEBUFFER_INCOMPLETE_ATTACHMENT
 * for (RGBA32F/RGBA16F stand-ins, with EXT_color_buffer_float enabled for
 * the host's own targets). `undefined` (imported EGLImage or foreign
 * storage) leaves the decision to native completeness.
 */
import type { GlBinding } from "./registry.js";
import type { GlImageAttachment } from "./image-references.js";
import { isDefaultFramebuffer } from "./framebuffer.js";
import { recordGlError } from "./errors.js";
import { textureLevel } from "./texture-levels.js";

type Size = readonly [number, number];
type Image = { size: Size; colorRenderable?: boolean };
const renderbufferImages = new WeakMap<WebGLRenderbuffer, Image & { internal?: number }>();

/** `internal` is the guest's requested format (for RENDERBUFFER_INTERNAL_FORMAT
 * when native storage differs); omitted for imported storage. */
export function recordRenderbufferSize(renderbuffer: WebGLRenderbuffer | null, width: number, height: number,
                                       internal?: number, colorRenderable?: boolean): void {
  if (renderbuffer) renderbufferImages.set(renderbuffer, { size: [width, height], internal, colorRenderable });
}

/** The internal format the guest specified, when native storage differs. */
export function renderbufferLogicalFormat(renderbuffer: WebGLRenderbuffer | null): number | undefined {
  return renderbuffer ? renderbufferImages.get(renderbuffer)?.internal : undefined;
}

function attachmentImage(image: GlImageAttachment): Image | undefined {
  if (image.kind !== "texture") return renderbufferImages.get(image.object);
  const level = textureLevel(image.object, image.target, image.level);
  return level && { size: [level.width, level.height], colorRenderable: level.gles?.colorRenderable };
}

/** Section 4.4.5: the color attachment of a user framebuffer is not
 * color-renderable under ES 2.0 plus the advertised extensions. */
export function framebufferColorUnrenderable(b: GlBinding, framebuffer: WebGLFramebuffer | null): boolean {
  if (!framebuffer || isDefaultFramebuffer(b, framebuffer)) return false;
  const image = b.framebufferAttachments.get(framebuffer)?.get(0x8ce0);
  return !!image && attachmentImage(image)?.colorRenderable === false;
}

/** True when two attached images of a user framebuffer have different sizes.
 * An attachment without a recorded image is left to native completeness: a
 * missing image is FRAMEBUFFER_INCOMPLETE_ATTACHMENT, an earlier clause. */
export function framebufferDimensionsDiffer(b: GlBinding, framebuffer: WebGLFramebuffer | null): boolean {
  if (!framebuffer || isDefaultFramebuffer(b, framebuffer)) return false;
  let first: Size | undefined;
  for (const image of b.framebufferAttachments.get(framebuffer)?.values() ?? []) {
    const size = attachmentImage(image)?.size;
    if (!size) continue;
    if (!first) first = size;
    else if (size[0] !== first[0] || size[1] !== first[1]) return true;
  }
  return false;
}

/** Draw/clear (read = false) and ReadPixels/CopyTex* (read = true) preflight
 * for the ES 2.0 completeness rules WebGL 2 does not apply: attachment
 * color-renderability and equal dimensions. Records
 * INVALID_FRAMEBUFFER_OPERATION before any native side effect. */
export function requireGlesFramebufferComplete(b: GlBinding, read = false): boolean {
  const framebuffer = read ? b.shadow.readFbo : b.shadow.fbo;
  if (!framebufferColorUnrenderable(b, framebuffer) && !framebufferDimensionsDiffer(b, framebuffer)) return true;
  recordGlError(b, 0x506);
  return false;
}

/** ES 2.0 completeness clauses in order: attachment completeness and missing
 * attachments come before dimensions, which come before UNSUPPORTED. */
export function glesFramebufferStatus(b: GlBinding, framebuffer: WebGLFramebuffer | null, nativeStatus: number): number {
  const passes = nativeStatus === 0x8cd5 || nativeStatus === 0x8cdd;
  if (passes && framebufferColorUnrenderable(b, framebuffer)) return 0x8cd6;
  if (passes && framebufferDimensionsDiffer(b, framebuffer)) return 0x8cd9;
  return nativeStatus;
}
