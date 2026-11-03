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
import { isCubeFace, textureLevel } from "./texture-levels.js";
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

/** The width and height the guest last specified for this renderbuffer's
 * storage; undefined before any storage was specified.
 * [RUNTIME-WORKAROUND: FIREFOX-RENDERBUFFER-EMPTY-SIZE] RENDERBUFFER_WIDTH and
 * RENDERBUFFER_HEIGHT are answered from this record (object-query.ts),
 * because Firefox reports 0 for both after storage with a zero width or
 * height. */
export function renderbufferRecordedSize(renderbuffer: WebGLRenderbuffer | null): Size | undefined {
  return renderbuffer ? renderbufferImages.get(renderbuffer)?.size : undefined;
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
 * advertised extensions, or is a cube-map face image that was never
 * specified. A cube face is a layer of 2D array storage that allocates all
 * six layers of a level (cube-storage.ts), so native completeness would
 * accept it; every cube face image is the guest's, so its record is the
 * whole truth. */
export function framebufferAttachmentUnrenderable(b: GlBinding, framebuffer: WebGLFramebuffer | null): boolean {
  if (!framebuffer || isDefaultFramebuffer(b, framebuffer)) return false;
  for (const [point, image] of b.framebufferAttachments.get(framebuffer) ?? []) {
    if (image.kind === "texture" && isCubeFace(image.target) && !textureLevel(image.object, image.target, image.level)) return true;
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

/** The renderer's own completeness of a guest framebuffer (missing or
 * incomplete attachments, unsupported combinations), cached against the same
 * revision as the ES 2.0 verdict. With it the host predicts the
 * INVALID_FRAMEBUFFER_OPERATION a draw, clear, read or copy raises instead of
 * learning it from getError after the native call (Stage A2, D-48): one
 * status query when a framebuffer's inputs change replaces an error round
 * trip on every such command. Host-owned default framebuffers are complete
 * by construction. The framebuffer is the one bound to the target, as the
 * muxer has selected the executing owner's state. */
type NativeVerdict = { revision: number; complete: boolean };
const nativeVerdicts = new WeakMap<WebGLFramebuffer, NativeVerdict>();

function nativeIncomplete(b: GlBinding, framebuffer: WebGLFramebuffer | null, read: boolean): boolean {
  const gl = b.gl;
  if (!gl || !framebuffer || isDefaultFramebuffer(b, framebuffer)) return false;
  const revision = framebufferInputsRevision(), cached = nativeVerdicts.get(framebuffer);
  if (cached !== undefined && cached.revision === revision) return !cached.complete;
  const status = gl.checkFramebufferStatus(read ? 0x8ca8 : 0x8ca9);
  // A lost renderer answers 0; its loss is reported at the next entry.
  if (status === 0) return false;
  nativeVerdicts.set(framebuffer, { revision, complete: status === 0x8cd5 });
  return status !== 0x8cd5;
}

/** Draw/clear (read = false) and ReadPixels/CopyTex* (read = true) preflight:
 * the ES 2.0 completeness rules WebGL 2 does not apply (attachment
 * color-renderability and equal dimensions), then the renderer's own
 * completeness. Records INVALID_FRAMEBUFFER_OPERATION before any native
 * side effect. */
export function requireGlesFramebufferComplete(b: GlBinding, read = false): boolean {
  const framebuffer = read ? b.shadow.readFbo : b.shadow.fbo;
  if (glesIncompleteness(b, framebuffer) === 0 && !nativeIncomplete(b, framebuffer, read)) return true;
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
