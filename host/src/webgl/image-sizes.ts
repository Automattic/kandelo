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
import { framebufferInputsChanged, framebufferInputsRevision } from "./framebuffer-revision.js";

type Size = readonly [number, number];
/** Renderability under ES 2.0 plus the advertised extensions; undefined
 * fields (imported storage) leave that attachment to native completeness. */
type Image = { size: Size; colorRenderable?: boolean; depthRenderable?: boolean; stencilRenderable?: boolean };
const renderbufferImages = new WeakMap<WebGLRenderbuffer, Image & { internal?: number }>();

/** `internal` is the guest's requested format (for RENDERBUFFER_INTERNAL_FORMAT
 * when native storage differs); omitted for imported storage. */
export function recordRenderbufferSize(renderbuffer: WebGLRenderbuffer | null, width: number, height: number,
                                       internal?: number, renderable?: Omit<Image, "size">): void {
  if (!renderbuffer) return;
  renderbufferImages.set(renderbuffer, { size: [width, height], internal, ...renderable });
  framebufferInputsChanged();
}

/** The internal format the guest specified, when native storage differs. */
export function renderbufferLogicalFormat(renderbuffer: WebGLRenderbuffer | null): number | undefined {
  return renderbuffer ? renderbufferImages.get(renderbuffer)?.internal : undefined;
}

function attachmentImage(image: GlImageAttachment): Image | undefined {
  if (image.kind !== "texture") return renderbufferImages.get(image.object);
  const level = textureLevel(image.object, image.target, image.level);
  const gles = level?.gles;
  return level && { size: [level.width, level.height], colorRenderable: gles?.colorRenderable,
    depthRenderable: gles?.depth, stencilRenderable: gles?.stencil };
}

/** Section 4.4.5: an attachment of a user framebuffer is not color-, depth-
 * or stencil-renderable (by attachment point) under ES 2.0 plus the
 * advertised extensions. */
export function framebufferAttachmentUnrenderable(b: GlBinding, framebuffer: WebGLFramebuffer | null): boolean {
  if (!framebuffer || isDefaultFramebuffer(b, framebuffer)) return false;
  for (const [point, image] of b.framebufferAttachments.get(framebuffer) ?? []) {
    const recorded = attachmentImage(image);
    const renderable = point === 0x8d00 ? recorded?.depthRenderable
      : point === 0x8d20 ? recorded?.stencilRenderable : recorded?.colorRenderable;
    if (renderable === false) return true;
  }
  return false;
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

/** The ES 2.0 clauses WebGL 2 does not apply, in the order section 4.4.5
 * lists them: FRAMEBUFFER_INCOMPLETE_ATTACHMENT for an unrenderable
 * attachment, then FRAMEBUFFER_INCOMPLETE_DIMENSIONS; 0 when neither holds.
 * Draws, clears, reads and copies all ask, so the verdict is kept per
 * framebuffer and re-derived only after an attachment, an attached image or
 * a storage view changed (framebuffer-revision.ts). */
type Verdict = { revision: number; status: number };
const verdicts = new WeakMap<WebGLFramebuffer, Verdict>();

function glesIncompleteness(b: GlBinding, framebuffer: WebGLFramebuffer | null): number {
  if (!framebuffer) return 0;
  const revision = framebufferInputsRevision(), cached = verdicts.get(framebuffer);
  if (cached !== undefined && cached.revision === revision) return cached.status;
  const status = framebufferAttachmentUnrenderable(b, framebuffer) ? 0x8cd6
    : framebufferDimensionsDiffer(b, framebuffer) ? 0x8cd9 : 0;
  verdicts.set(framebuffer, { revision, status });
  return status;
}

/** Draw/clear (read = false) and ReadPixels/CopyTex* (read = true) preflight
 * for the ES 2.0 completeness rules WebGL 2 does not apply: attachment
 * color-renderability and equal dimensions. Records
 * INVALID_FRAMEBUFFER_OPERATION before any native side effect. */
export function requireGlesFramebufferComplete(b: GlBinding, read = false): boolean {
  if (glesIncompleteness(b, read ? b.shadow.readFbo : b.shadow.fbo) === 0) return true;
  recordGlError(b, 0x506);
  return false;
}

/** ES 2.0 completeness clauses in order: attachment completeness and missing
 * attachments come before dimensions, which come before UNSUPPORTED. */
export function glesFramebufferStatus(b: GlBinding, framebuffer: WebGLFramebuffer | null, nativeStatus: number): number {
  const passes = nativeStatus === 0x8cd5 || nativeStatus === 0x8cdd;
  const status = passes ? glesIncompleteness(b, framebuffer) : 0;
  return status || nativeStatus;
}
