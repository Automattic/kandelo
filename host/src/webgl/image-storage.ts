import { applyNativeChanges, invokeNativeCall, rethrowNativeGlFault, nativeInverse, reserveNativeRetirement, retireNativeRetirement, transferNativeRetirement, type NativeRetirement, type NativeChange, type NativeCall, type NativeDeletion } from "./native-recovery.js";
import type { GlBinding } from "./registry.js";
import type { GpuScanoutStorage } from "./kms-scanout.js";
import type { GlImageAttachment } from "./image-references.js";
import type { GlShadowState } from "./shadow.js";
import { checkedGlCall, recordGlError } from "./program-objects.js";
import { recordRenderbufferSize, renderbufferLogicalFormat } from "./image-sizes.js";
import { framebufferInputsChanged, framebufferInputsRevision } from "./framebuffer-revision.js";
import { noteStorageWrite, storageWrites } from "./image-writes.js";
import { effectiveInternalFormat } from "./es2-formats.js";
import { CUBE_FACES, isCubeFace, replaceTextureLevels, textureComplete, textureFaces, textureLevel } from "./texture-levels.js";
/** Private source handles never enter the public GLuint texture namespace. */
export const WPK_IMAGE_SOURCE_TARGET = 0x57504b49;
/** Size of shared::dri::WpkDrmExportImage, the EXPORT_IMAGE host record. */
export const GL_IMAGE_EXPORT_BYTES = 48;
/** Canonical EGLImage storage. BO images are level 0 of a private RGBA
 * texture. An exported GLES image (EGL 1.5 section 3.9) is the source
 * object's own image: a 2D level, a cube-map face level, or a renderbuffer,
 * with the format that object was given. */
export type GlImageSource = {
  token: number;
  key?: string;
  bo: number;
  texture: WebGLTexture | null;
  width: number;
  height: number;
} & GlImageStorage;
export type GlImageStorage = {
  /** Texture image target (GL_TEXTURE_2D or a cube face); default 2D. */
  target?: number;
  level?: number;
  renderbuffer?: WebGLRenderbuffer | null;
  /** texImage2D triple for sibling views; default RGBA8. */
  internalFormat?: number;
  format?: number;
  type?: number;
  /** Every bo the image is read from when more than `bo` (a YUV image's
   * planes); the source ends when any of them retires. */
  bos?: readonly number[];
};
export type GlTextureView = {
  native: WebGLTexture;
  source: GlImageSource | null;
  read: WebGLFramebuffer | null;
  candidate?: NativeRetirement;
  /** The canonical storage's write count (image-writes.ts) when this view
   * last copied it; the view is current while the count is unchanged. */
  synced?: number;
};
export type GlRenderbufferView = {
  native: WebGLRenderbuffer;
  source: GlImageSource | null;
};
const TEX = 0x0de1, CUBE = 0x8513, RBO = 0x8d41, DRAW = 0x8ca9, READ = 0x8ca8, COLOR = 0x8ce0, EXTERNAL = 0x8d65;
export function registerImageSource(b: GlBinding, bo: number, texture: WebGLTexture | null, width: number, height: number, key?: string, storage: GlImageStorage = {}): number {
  for (const source of b.imageSources.values())
    if (source.bo === bo && source.key === key)
      return source.token;
  if (b.nextImageSource > 0x7fffffff)
    return -12;
  const token = b.nextImageSource;
  try {
    b.imageSources.set(token, { token, bo, texture, width, height, key, ...storage });
  }
  catch (caught) { rethrowNativeGlFault(caught);
    return -12;
  }
  b.nextImageSource++;
  return token;
}
/** Attach canonical storage at `point` of the framebuffer bound to `target`. */
function sourceAttachment(source: GlImageSource, target: number, point: number, level = 0): NativeCall {
  if (source.renderbuffer) return ["framebufferRenderbuffer", target, point, RBO, source.renderbuffer];
  return ["framebufferTexture2D", target, point, source.target ?? TEX, source.texture, (source.level ?? 0) + level];
}
/** Sibling writes can bind the canonical texture as GL_TEXTURE_2D only when
 * it is level 0 of a 2D texture; any other storage is written through. */
function directSource(source: GlImageSource): boolean {
  return !source.renderbuffer && (source.target ?? TEX) === TEX && (source.level ?? 0) === 0;
}
export function textureNative(b: GlBinding, object: WebGLTexture): WebGLTexture {
  return b.textureViews.get(object)?.native ?? object;
}
export function renderbufferNative(b: { readonly renderbufferViews?: ReadonlyMap<WebGLRenderbuffer, GlRenderbufferView> }, object: WebGLRenderbuffer): WebGLRenderbuffer {
  return b.renderbufferViews?.get(object)?.native ?? object;
}
export function canonicalTexture(b: GlBinding, native: WebGLTexture): WebGLTexture {
  return b.textureViewOwners.get(native) ?? native;
}
export function canonicalRenderbuffer(b: GlBinding, native: WebGLRenderbuffer): WebGLRenderbuffer {
  return b.renderbufferViewOwners.get(native) ?? native;
}
/** All utility work restores actual native state, including distinct read and
 * draw defaults. The logical shadow continues to contain stable identities. */
function withImageState(b: GlBinding, call: () => boolean, cube = false): boolean {
  const gl = b.gl!;
  let active = 0, texture: WebGLTexture | null = null, draw: WebGLFramebuffer | null = null, read: WebGLFramebuffer | null = null, renderbuffer: WebGLRenderbuffer | null = null;
  let cubeTexture: WebGLTexture | null = null;
  for (const capture of [
    () => { active = Number(gl.getParameter(0x84e0)); },
    () => { texture = gl.getParameter(0x8069); },
    () => { draw = gl.getParameter(0x8ca6); },
    () => { read = gl.getParameter(0x8caa); },
    () => { renderbuffer = gl.getParameter(0x8ca7); },
    ...(cube ? [() => { cubeTexture = gl.getParameter(0x8514); }] : []),
  ]) if (!checkedGlCall(b,capture)) return false;
  return applyNativeChanges(b,[{apply:call,restore:nativeInverse(b)}],{finalizer:nativeInverse(b,
    [["activeTexture",active],["bindTexture",TEX,texture],...(cube ? [["bindTexture",CUBE,cubeTexture] as NativeCall] : [])],
    [["bindRenderbuffer",RBO,renderbuffer]],
    [["bindFramebuffer",DRAW,draw]], [["bindFramebuffer",READ,read]])});
}
/** The native storage an image source's siblings share. */
function sourceStorage(source: GlImageSource): object | null {
  return source.renderbuffer ?? source.texture;
}
function copySource(b: GlBinding, view: GlTextureView): boolean {
  if (!view.source)
    return true;
  const gl = b.gl!, source = view.source, storage = sourceStorage(source);
  // The count read before the copy: a write during it leaves the view stale.
  const count = storage ? storageWrites(storage).count : 0;
  const copied = withImageState(b, () => checkedGlCall(b, () => {
    gl.bindFramebuffer(READ, view.read);
    gl.bindTexture(TEX, view.native);
    gl.copyTexSubImage2D(TEX, 0, 0, 0, 0, 0, source.width, source.height);
  }));
  // The view's own storage was written. It is canonical storage for anyone
  // who reads it directly: a GLES image exported from this sibling texture
  // is presented from it (an exported image's native is the object's view).
  noteStorageWrite(view.native);
  if (copied) view.synced = count;
  return copied;
}
function allocateTextureView(b: GlBinding, old: WebGLTexture, source: GlImageSource, preserveBase = true): GlTextureView | null {
  const gl = b.gl!;
  const candidate = reserveNativeRetirement(b,[["deleteTexture",null],["deleteFramebuffer",null]]);
  if (!candidate) return null;
  let native: WebGLTexture | null = null, read: WebGLFramebuffer | null = null;
  let published = false;
  try {
    const accepted = withImageState(b, () => {
      const params: number[] = [];
      if (!checkedGlCall(b, () => {
        gl.bindTexture(TEX, old);
        for (const pname of [0x2800, 0x2801, 0x2802, 0x2803])
          params.push(Number(gl.getTexParameter(TEX, pname)));
        native = gl.createTexture(); candidate.calls[0][1] = native;
        if (preserveBase) { read = gl.createFramebuffer(); candidate.calls[1][1] = read; }
      }))
        return false;
      if (!native || (preserveBase && !read)) {
        recordGlError(b, 0x505);
        return false;
      }
      if (!checkedGlCall(b, () => {
        gl.bindTexture(TEX, native);
        [0x2800, 0x2801, 0x2802, 0x2803].forEach((pname, i) => gl.texParameteri(TEX, pname, params[i]));
        if (preserveBase) {
          gl.bindFramebuffer(READ, read);
          invokeNativeCall(gl, sourceAttachment(source, READ, COLOR));
          gl.texImage2D(TEX, 0, source.internalFormat ?? 0x8058, source.width, source.height, 0,
            source.format ?? 0x1908, source.type ?? 0x1401, null);
        }
      }))
        return false;
      if (!preserveBase)
        return true;
      let complete = false;
      if (!checkedGlCall(b, () => { complete = gl.checkFramebufferStatus(READ) === 0x8cd5; }))
        return false;
      if (!complete) {
        recordGlError(b, 0x502);
        return false;
      }
      return checkedGlCall(b, () => gl.copyTexSubImage2D(TEX, 0, 0, 0, 0, 0, source.width, source.height));
    });
    if (!accepted) return null;
    const storage = sourceStorage(source);
    // A preserved base is a copy of the source as of now.
    const view: GlTextureView = {native:native!,source,read,candidate,
      synced:preserveBase && storage ? storageWrites(storage).count : undefined};
    published = true; return view;
  } finally { if (!published) retireNativeRetirement(candidate); }
}
/** Resolve physical storage while retaining logical attachment query identity. */
export function attachImage(b: GlBinding, target: number, point: number, image: GlImageAttachment | null, override?: GlTextureView | GlRenderbufferView): void {
  invokeNativeCall(b.gl!, imageAttachmentCall(b, target, point, image, override));
}
/** A deferred inverse retains native storage identity without retaining guest
 * memory through a binding or consulting subsequently changed view metadata. */
export function imageAttachmentCall(b: GlBinding, target: number, point: number, image: GlImageAttachment | null, override?: GlTextureView | GlRenderbufferView): NativeCall {
  if (!image) {
    return ["framebufferRenderbuffer", target, point, RBO, null];
  }
  const view = override ?? (image.kind === "texture" ? b.textureViews.get(image.object) : b.renderbufferViews.get(image.object));
  if (view?.source)
    return sourceAttachment(view.source, target, point, image.kind === "texture" ? image.level : 0);
  if (image.kind === "texture") {
    const native = (view?.native as WebGLTexture | undefined) ?? image.object;
    const imageTarget = image.target, level = image.level;
    return ["framebufferTexture2D", target, point, imageTarget, native, level];
  }
  const native = (view?.native as WebGLRenderbuffer | undefined) ?? image.object;
  return ["framebufferRenderbuffer", target, point, RBO, native];
}
/** The native storage an attachment of `image` references: the canonical
 * EGLImage storage for a sibling view (what imageAttachmentCall attaches),
 * otherwise the object's own native storage. */
export function attachedNativeStorage(b: GlBinding, image: GlImageAttachment): object | null {
  const view = image.kind === "texture" ? b.textureViews.get(image.object) : b.renderbufferViews.get(image.object);
  if (view?.source) return view.source.renderbuffer ?? view.source.texture;
  return view?.native ?? image.object;
}
/** Retarget all containers before publishing storage. Other contexts' bindings
 * remain logical and resolve the current view on their next muxer selection. */
function retarget(b: GlBinding, kind: number, object: WebGLTexture | WebGLRenderbuffer, old: GlTextureView | GlRenderbufferView, next: GlTextureView | GlRenderbufferView): boolean {
  const gl = b.gl!;
  let draw: WebGLFramebuffer|null = null, read: WebGLFramebuffer|null = null, active = 0;
  if (!checkedGlCall(b, () => { draw = gl.getParameter(0x8ca6); }) ||
      !checkedGlCall(b, () => { read = gl.getParameter(0x8caa); }) ||
      !checkedGlCall(b, () => { active = Number(gl.getParameter(0x84e0)); })) return false;
  const changes: NativeChange[] = [];
  for (const member of b.objects.members) for (const [fbo,points] of member.framebufferAttachments)
    for (const [point,image] of points) {
      if (image.kind !== (kind === 1 ? "texture" : "renderbuffer") || image.object !== object) continue;
      const after = imageAttachmentCall(b,DRAW,point,image,next), before = imageAttachmentCall(b,DRAW,point,image,old);
      changes.push({apply: () => checkedGlCall(b, () => gl.bindFramebuffer(DRAW,fbo)) && checkedGlCall(b, () => invokeNativeCall(gl,after)),
        restore:nativeInverse(b, [["bindFramebuffer",DRAW,fbo],before])});
    }
  if (kind === 1) {
    for (const [units, bindTarget] of [[b.shadow.textureUnits, TEX], [b.shadow.cubeTextureUnits, CUBE]] as const)
      for (let unit=0;unit<units.length;unit++) if (units[unit] === object) {
        changes.push({apply: () => checkedGlCall(b, () => gl.activeTexture(0x84c0+unit)) &&
            checkedGlCall(b, () => gl.bindTexture(bindTarget,next.native as WebGLTexture)),
          restore:nativeInverse(b, [["activeTexture",0x84c0+unit],["bindTexture",bindTarget,old.native as WebGLTexture]])});
      }
  } else if (b.shadow.renderbuffer === object) changes.push({apply: () => checkedGlCall(b, () => gl.bindRenderbuffer(RBO,next.native as WebGLRenderbuffer)),
    restore:nativeInverse(b, [["bindRenderbuffer",RBO,old.native as WebGLRenderbuffer]])});
  // Other contexts' containers participate, so retirement of this submitter
  // cannot discard the inverse. Its native targets are retired separately.
  return applyNativeChanges(b,changes,{shared:true,finalizer:nativeInverse(b,
    [["bindFramebuffer",DRAW,draw]],[["bindFramebuffer",READ,read]],[["activeTexture",active]])});
}
function transferCandidate(view: GlTextureView): void {
  const candidate = view.candidate;
  if (!candidate) return;
  delete view.candidate;
  if (view.source || !view.read) { transferNativeRetirement(candidate); return; }
  // Owned respecification transfers the texture but no longer needs the
  // private FBO that sampled the former canonical source.
  candidate.calls[0][1] = null; view.read = null;
  retireNativeRetirement(candidate);
}
function replaceTextureView(b: GlBinding, object: WebGLTexture, next: GlTextureView): boolean {
  const old = b.textureViews.get(object) ?? { native: object, source: null, read: null };
  const had = b.textureViews.has(object);
  const retired = reserveNativeRetirement(b,[
    ["deleteTexture",b.externallyOwnedTextures.has(old.native) || exportOwned(old.native) ? null : old.native], ["deleteFramebuffer",old.read]]);
  if (!retired) return false;
  let committed = false;
  try {
    const previousRevision = b.imageRevisions.get(object) ?? 0;
    if (previousRevision === 0xffffffff) {
      recordGlError(b, 0x505);
      return false;
    }
    try {
      b.imageRevisions.set(object, previousRevision + 1);
    }
    catch (caught) { rethrowNativeGlFault(caught);
      recordGlError(b, 0x505);
      return false;
    }
    const restoreRevision = () => {
      if (previousRevision) b.imageRevisions.set(object, previousRevision);
      else b.imageRevisions.delete(object);
    };
    try {
      b.textureViews.set(object, next);
      b.textureViewOwners.set(next.native, object);
    }
    catch (caught) {
      if (had)
        b.textureViews.set(object, old);
      else
        b.textureViews.delete(object);
      restoreRevision(); rethrowNativeGlFault(caught);
      recordGlError(b, 0x505);
      return false;
    }
    let accepted = false, fault: unknown;
    try {
      accepted = retarget(b, 1, object, old, next);
    }
    catch (caught) {
      try { rethrowNativeGlFault(caught); recordGlError(b, 0x505); }
      catch (fatal) { fault = fatal; }
    }
    if (!accepted) {
      if (had)
        b.textureViews.set(object, old);
      else
        b.textureViews.delete(object);
      b.textureViewOwners.delete(next.native);
      restoreRevision();
      // Roll back first; a fatal fault still propagates.
      if (fault !== undefined) throw fault;
      return false;
    }
    b.textureViewOwners.delete(old.native);
    unlinkSource(object, next.native);
    committed = true;
    retireNativeRetirement(retired);
    return true;
  } finally {
    // The object's native storage (and so what its attachments are) may have
    // changed, or been restored after a partial change.
    framebufferInputsChanged();
    if (!committed) transferNativeRetirement(retired);
  }
}
function replaceRenderbufferView(b: GlBinding, object: WebGLRenderbuffer, next: GlRenderbufferView): boolean {
  const old = b.renderbufferViews.get(object) ?? { native: object, source: null };
  const had = b.renderbufferViews.has(object);
  const retired = reserveNativeRetirement(b,[["deleteRenderbuffer",next.native === old.native || exportOwned(old.native) ? null : old.native]]);
  if (!retired) return false;
  let committed = false;
  try {
    const previousRevision = b.imageRevisions.get(object) ?? 0;
    if (previousRevision === 0xffffffff) {
      recordGlError(b, 0x505);
      return false;
    }
    try {
      b.imageRevisions.set(object, previousRevision + 1);
    }
    catch (caught) { rethrowNativeGlFault(caught);
      recordGlError(b, 0x505);
      return false;
    }
    const restoreRevision = () => {
      if (previousRevision) b.imageRevisions.set(object, previousRevision);
      else b.imageRevisions.delete(object);
    };
    try {
      b.renderbufferViews.set(object, next);
      b.renderbufferViewOwners.set(next.native, object);
    }
    catch (caught) {
      if (had)
        b.renderbufferViews.set(object, old);
      else
        b.renderbufferViews.delete(object);
      restoreRevision(); rethrowNativeGlFault(caught);
      recordGlError(b, 0x505);
      return false;
    }
    let accepted = false, fault: unknown;
    try {
      accepted = retarget(b, 2, object, old, next);
    }
    catch (caught) {
      try { rethrowNativeGlFault(caught); recordGlError(b, 0x505); }
      catch (fatal) { fault = fatal; }
    }
    if (!accepted) {
      if (had)
        b.renderbufferViews.set(object, old);
      else
        b.renderbufferViews.delete(object);
      if (next.native !== old.native)
        b.renderbufferViewOwners.delete(next.native);
      restoreRevision();
      // Roll back first; a fatal fault still propagates.
      if (fault !== undefined) throw fault;
      return false;
    }
    if (next.native !== old.native) {
      b.renderbufferViewOwners.delete(old.native);
    }
    unlinkSource(object, next.native);
    committed = true; retireNativeRetirement(retired);
    return true;
  } finally {
    // The object's native storage (and so what its attachments are) may have
    // changed, or been restored after a partial change.
    framebufferInputsChanged();
    if (!committed) transferNativeRetirement(retired);
  }
}
export function importImageStorage(b: GlBinding, kind: number, name: number, token: number): boolean {
  if (kind !== 1 && kind !== 2) {
    recordGlError(b, 0x500);
    return false;
  }
  const object = kind === 1 ? b.textures.get(name) : b.rbos.get(name);
  return importImageObject(b, kind, object ?? null, token);
}
function importImageObject(b: GlBinding, kind: number, object: WebGLTexture | WebGLRenderbuffer | null, token: number): boolean {
  const source = b.imageSources.get(token);
  if (!source || !object) {
    recordGlError(b, 0x502);
    return false;
  }
  if (kind === 1) {
    // A cube object cannot become a 2D EGLImage target.
    if (!withImageState(b, () => checkedGlCall(b, () => b.gl!.bindTexture(TEX, textureNative(b, object as WebGLTexture)))))
      return false;
    const view = allocateTextureView(b, textureNative(b, object as WebGLTexture), source);
    if (!view)
      return false;
    let installed = false;
    try {
      if (replaceTextureView(b, object as WebGLTexture, view)) {
        transferCandidate(view); installed = true;
        replaceTextureLevels(object as WebGLTexture, TEX, {width: source.width, height: source.height,
          internalFormat: source.internalFormat ?? 0x8058, format: source.format ?? 0x1908,
          type: source.type ?? 0x1401, compressed: false});
        return true;
      }
      return false;
    } finally {
      // A fault after replaceTextureView committed the view leaves it
      // installed: only a view that never became the object's may retire.
      if (!installed && view.candidate && b.textureViews.get(object as WebGLTexture) !== view)
        retireNativeRetirement(view.candidate);
    }
  }
  if (!replaceRenderbufferView(b, object as WebGLRenderbuffer, { native: renderbufferNative(b, object as WebGLRenderbuffer), source })) return false;
  recordRenderbufferSize(object as WebGLRenderbuffer, source.width, source.height);
  return true;
}
export function imageSourceToken(b: GlBinding, kind: number, name: number): number | null {
  if (kind === 1) {
    const object = b.textures.get(name);
    return object ? (b.textureViews.get(object)?.source?.token ?? linkedToken(b, object)) : null;
  }
  if (kind === 2) {
    const object = b.rbos.get(name);
    return object ? (b.renderbufferViews.get(object)?.source?.token ?? linkedToken(b, object)) : null;
  }
  return null;
}
export type GlBoundImageState = {
  source: number;
  revision: number;
};
function boundImageObject(b: GlBinding, kind: number, target: number, cube = false): WebGLTexture | WebGLRenderbuffer | null {
  if ((kind !== 1 && kind !== 2)
      || (kind === 1 ? target !== TEX && target !== EXTERNAL && !(cube && target === CUBE) : target !== RBO)) {
    recordGlError(b, 0x500);
    return null;
  }
  // OES_EGL_image_external: an external texture becomes a sibling the same
  // way a 2D texture does; its native storage is a 2D texture.
  const units = target === CUBE ? b.shadow.cubeTextureUnits
    : target === EXTERNAL ? b.shadow.externalTextureUnits : b.shadow.textureUnits;
  const object = kind === 1 ? units[b.shadow.activeTexture] : b.shadow.renderbuffer;
  if (!object)
    recordGlError(b, 0x502);
  return object ?? null;
}
/** Resolve the implicit binding, never a potentially reused public name. */
/** A cube-map binding can be read (an exported face keeps its source a
 * sibling) but never becomes an EGLImage target. */
export function boundImageState(b: GlBinding, kind: number, target: number, source?: number): GlBoundImageState | null {
  const object = boundImageObject(b, kind, target, source === undefined);
  if (!object)
    return null;
  if (source !== undefined && !importImageObject(b, kind, object, source))
    return null;
  const view = kind === 1 ? b.textureViews.get(object) : b.renderbufferViews.get(object);
  return { source: view?.source?.token ?? linkedToken(b, object), revision: b.imageRevisions.get(object) ?? 0 };
}
/** Each sampling view has independent parameters. Before a draw, a view
 * bound to a 2D unit copies the canonical image if that storage was written
 * since its last copy, by any API or context (image-writes.ts). The units
 * holding views are tracked as bindings change (setTextureUnit), so a draw
 * that samples no view, or only current views, does no native work. */
export function prepareImageDraw(b: GlBinding): boolean {
  const s = b.shadow;
  if (s.sourcedUnits.revision !== framebufferInputsRevision()) recountSourcedUnits(b);
  for (const unit of s.sourcedUnits.units) {
    const object = s.textureUnits[unit], view = object ? b.textureViews.get(object) : undefined;
    if (!view?.source) continue;
    const storage = sourceStorage(view.source);
    if (storage && view.synced === storageWrites(storage).count) continue;
    if (!copySource(b, view))
      return false;
  }
  return true;
}
/** Copy the canonical image into `object`'s sibling view if its storage was
 * written since the view last copied it (an external texture's view before
 * a draw samples it). True when there is nothing to copy. */
export function refreshTextureView(b: GlBinding, object: WebGLTexture): boolean {
  const view = b.textureViews.get(object);
  if (!view?.source) return true;
  const storage = sourceStorage(view.source);
  if (storage && view.synced === storageWrites(storage).count) return true;
  return copySource(b, view);
}
/** Views gain and lose sources only through view replacement and
 * destruction, which advance the framebuffer-inputs revision. */
function recountSourcedUnits(b: GlBinding): void {
  const units: number[] = [];
  b.shadow.textureUnits.forEach((object, unit) => { if (object && b.textureViews.get(object)?.source) units.push(unit); });
  b.shadow.sourcedUnits = { revision: framebufferInputsRevision(), units };
}
/** Every write of a 2D unit binding updates the tracked units (depth-sampling.ts). */
export function noteSourcedUnit(b: { shadow: GlShadowState; textureViews: ReadonlyMap<WebGLTexture, GlTextureView> },
    unit: number, object: WebGLTexture | null): void {
  const sourced = b.shadow.sourcedUnits;
  if (sourced.revision !== framebufferInputsRevision()) return;
  const at = sourced.units.indexOf(unit);
  if (at >= 0) sourced.units.splice(at, 1);
  if (object && b.textureViews.get(object)?.source) sourced.units.push(unit);
}
export function boundImageTexture(b: GlBinding, target: number): GlTextureView | undefined {
  if (target !== TEX)
    return undefined;
  const object = b.shadow.textureUnits[b.shadow.activeTexture];
  return object ? b.textureViews.get(object) : undefined;
}
/** Pixel updates preserve shared storage; respecification allocates an owned
 * candidate and commits only after native validation and container retargeting. */
export function imageTextureOperation(b: GlBinding, target: number, respecify: boolean, call: () => void, preserveBase = true, level?: number): boolean {
  // Whatever storage the command reaches (the object's own, a sibling's
  // canonical storage, or new storage) counts as written, accepted or not.
  const base = target === TEX ? TEX : isCubeFace(target) || target === CUBE ? CUBE : 0;
  const object = base ? (base === TEX ? b.shadow.textureUnits : b.shadow.cubeTextureUnits)[b.shadow.activeTexture]
    ?? b.shadow.defaultTextures.get(base) : undefined;
  const before = object ? textureNative(b, object) : null, source = object ? b.textureViews.get(object)?.source : null;
  try { return textureOperation(b, target, respecify, call, preserveBase, level); }
  finally {
    noteStorageWrite(before); noteStorageWrite(source && sourceStorage(source));
    if (object) noteStorageWrite(textureNative(b, object));
  }
}
function textureOperation(b: GlBinding, target: number, respecify: boolean, call: () => void, preserveBase: boolean, level?: number): boolean {
  const view = boundImageTexture(b, target);
  if (!view?.source) {
    const object = (target === TEX ? b.shadow.textureUnits : isCubeFace(target) || target === CUBE
      ? b.shadow.cubeTextureUnits : [])[b.shadow.activeTexture];
    if (respecify && object && linkedSource(object))
      return orphanLinkedTexture(b, object, target === TEX ? TEX : CUBE,
        level === undefined ? null : {face: target, level}, call);
    return checkedGlCall(b, call);
  }
  if (!respecify) {
    const source = view.source;
    if (directSource(source))
      return withImageState(b, () => checkedGlCall(b, () => { b.gl!.bindTexture(TEX, source.texture); call(); }));
    // Cube-face, nonzero-level or renderbuffer storage cannot be bound as
    // this 2D sibling: update the sibling's view, then copy it into the
    // canonical image so every sibling observes the write.
    return withImageState(b, () => checkedGlCall(b, () => { b.gl!.bindTexture(TEX, view.native); call(); })
      && writeThrough(b, view));
  }
  const object = b.shadow.textureUnits[b.shadow.activeTexture]!;
  // [RUNTIME-WORKAROUND: CHROMIUM-COPY-TEX-RESPEC] Do not copy a base
  // image that this command replaces; Chromium can retain those copied pixels.
  const candidate = allocateTextureView(b, view.native, view.source, preserveBase);
  if (!candidate)
    return false;
  let installed = false;
  try {
    const accepted = withImageState(b, () => checkedGlCall(b, () => { b.gl!.bindTexture(TEX, candidate.native); call(); }));
    if (accepted) {
      candidate.source = null;
      if (replaceTextureView(b, object, candidate)) { transferCandidate(candidate); installed = true; return true; }
    }
    return false;
  } finally { if (!installed && candidate.candidate) retireNativeRetirement(candidate.candidate); }
}
export function imageRenderbufferStorage(b: GlBinding, call: () => void): boolean {
  const object = b.shadow.renderbuffer, view = object ? b.renderbufferViews.get(object) : undefined;
  const before = object ? renderbufferNative(b, object) : null;
  try { return renderbufferStorageOperation(b, call); }
  finally {
    noteStorageWrite(before); noteStorageWrite(view?.source && sourceStorage(view.source));
    if (object) noteStorageWrite(renderbufferNative(b, object));
  }
}
function renderbufferStorageOperation(b: GlBinding, call: () => void): boolean {
  const object = b.shadow.renderbuffer, view = object && b.renderbufferViews.get(object);
  // Respecifying an exported renderbuffer orphans its image: the image
  // keeps the old storage and the object receives new storage.
  if (!view?.source && !(object && linkedSource(object)))
    return checkedGlCall(b, call);
  const candidate = reserveNativeRetirement(b,[["deleteRenderbuffer",null]]);
  if (!candidate) return false;
  let native: WebGLRenderbuffer | null = null;
  let installed = false;
  try {
    const accepted = withImageState(b, () => {
      if (!checkedGlCall(b, () => { native = b.gl!.createRenderbuffer(); candidate.calls[0][1] = native; }))
        return false;
      if (!native) {
        recordGlError(b, 0x505);
        return false;
      }
      return checkedGlCall(b, () => { b.gl!.bindRenderbuffer(RBO, native); call(); });
    });
    if (accepted && native && replaceRenderbufferView(b, object!, { native, source: null })) {
      transferNativeRetirement(candidate); installed = true; return true;
    }
    return false;
  } finally { if (!installed) retireNativeRetirement(candidate); }
}
/** A reserved receipt owns partial cleanup and suppresses duplicate native
 * deletes when final collection retries after one resource rejected. */
function imageRetirement(b: GlBinding, object: WebGLTexture|WebGLRenderbuffer, calls: Parameters<typeof reserveNativeRetirement>[1]): boolean {
  let retirement = b.imageRetirements.get(object);
  if (!retirement) {
    retirement = reserveNativeRetirement(b,calls) ?? undefined;
    if (!retirement) return false;
    try { b.imageRetirements.set(object,retirement); }
    catch (caught) { transferNativeRetirement(retirement); rethrowNativeGlFault(caught); recordGlError(b,0x505); return false; }
  }
  if (!retireNativeRetirement(retirement)) return false;
  b.imageRetirements.delete(object); return true;
}
export function destroyTextureView(b: GlBinding, object: WebGLTexture): boolean {
  const view = b.textureViews.get(object), native = view?.native ?? object;
  unlinkSource(object, null);
  if (!imageRetirement(b,object,[["deleteTexture",b.externallyOwnedTextures.has(native) || exportOwned(native) ? null : native],["deleteFramebuffer",view?.read ?? null]])) return false;
  b.textureViewOwners.delete(native);
  b.textureViews.delete(object);
  b.imageRevisions.delete(object);
  b.foreignTextureBos.delete(object);
  framebufferInputsChanged();
  return true;
}
export function destroyRenderbufferView(b: GlBinding, object: WebGLRenderbuffer): boolean {
  const native = renderbufferNative(b, object);
  unlinkSource(object, null);
  if (!imageRetirement(b,object,[["deleteRenderbuffer",exportOwned(native) ? null : native]])) return false;
  b.renderbufferViewOwners.delete(native);
  b.renderbufferViews.delete(object);
  b.imageRevisions.delete(object);
  framebufferInputsChanged();
  return true;
}

/* ----- GLES objects as EGLImage sources (EGL 1.5 section 3.9) ----------
 * An exported image IS the source object's image: no copy is made, so
 * writes through the source object and through every sibling target the
 * same storage. The GPU-tier BO owns that storage from export on. While the
 * source object still uses it ("linked"), the object stays an EGLImage
 * sibling; respecifying or deleting the object orphans the image, which
 * keeps the old storage (KHR_image_base, OES_EGL_image). */
export type GlExportedImage = {
  bo: number;
  gl: WebGL2RenderingContext;
  object: WebGLTexture | WebGLRenderbuffer;
  native: WebGLTexture | WebGLRenderbuffer;
  renderbuffer: boolean;
  width: number;
  height: number;
  storage: GlImageStorage;
  sourceUsing: boolean;
  boLive: boolean;
  /** Sized internal format (es2-formats effectiveInternalFormat). */
  format: number;
  /** Read framebuffer over the image for KMS scanout, made on first use. */
  scanout?: GpuScanoutStorage & { retirement: NativeRetirement };
};
/** `internalFormat` is the image's sized internal format, from which EGL
 * derives the DRM format a GBM import of the image reports. */
export type GlImageExport = { record: GlExportedImage; token: number; revision: number; internalFormat: number };
const exportedByNative = new WeakMap<object, GlExportedImage>();
const exportedBySource = new WeakMap<object, GlExportedImage>();

function exportOwned(native: object): boolean {
  return exportedByNative.get(native)?.boLive === true;
}
function linkedSource(object: object): GlExportedImage | undefined {
  const record = exportedBySource.get(object);
  return record?.sourceUsing ? record : undefined;
}
/** The object stopped using the exported storage (respecified, deleted or
 * given other storage); the image keeps it. */
function unlinkSource(object: object, next: object | null): void {
  const record = exportedBySource.get(object);
  if (!record || next === record.native) return;
  record.sourceUsing = false;
  exportedBySource.delete(object);
}
function linkedToken(b: GlBinding, object: object): number {
  const record = linkedSource(object);
  if (!record) return 0;
  for (const source of b.imageSources.values()) if (source.bo === record.bo) return source.token;
  return 0;
}

/** Copy a sibling's updated view into canonical storage that cannot be bound
 * as that 2D sibling. Blits ignore every fragment operation except the
 * scissor test, which is suspended for the copy. */
function writeThrough(b: GlBinding, view: GlTextureView): boolean {
  const gl = b.gl!, source = view.source!;
  if (!view.read) { recordGlError(b, 0x502); return false; }
  const scratch = reserveNativeRetirement(b,[["deleteFramebuffer",null]]);
  if (!scratch) return false;
  try {
    return checkedGlCall(b, () => {
      const fbo = gl.createFramebuffer(); scratch.calls[0][1] = fbo;
      gl.bindFramebuffer(READ, fbo);
      gl.framebufferTexture2D(READ, COLOR, TEX, view.native, 0);
      gl.bindFramebuffer(DRAW, view.read);
      const scissor = gl.isEnabled(0x0c11);
      if (scissor) gl.disable(0x0c11);
      try { gl.blitFramebuffer(0, 0, source.width, source.height, 0, 0, source.width, source.height, 0x4000, 0x2600); }
      finally { if (scissor) gl.enable(0x0c11); }
    });
  } finally { retireNativeRetirement(scratch); }
}

/** Respecification of a linked source texture: give the object new storage
 * holding every image except the one being respecified, apply the call
 * there, and leave the exported image's storage untouched. Retaining an
 * image copies it through a framebuffer, so a compressed or non-color-
 * renderable retained image fails with GL_OUT_OF_MEMORY instead of being
 * silently dropped. */
function orphanLinkedTexture(b: GlBinding, object: WebGLTexture, bindTarget: number,
  skip: {face: number; level: number} | null, call: () => void): boolean {
  const gl = b.gl!, old = textureNative(b, object);
  const candidate = reserveNativeRetirement(b,[["deleteTexture",null]]);
  const scratch = candidate && reserveNativeRetirement(b,[["deleteFramebuffer",null]]);
  if (!candidate || !scratch) { if (candidate) retireNativeRetirement(candidate); return false; }
  let fresh: WebGLTexture | null = null, installed = false;
  try {
    const pnames = [0x2800, 0x2801, 0x2802, 0x2803];
    const accepted = withImageState(b, () => {
      const params: number[] = [];
      let callerRead: WebGLFramebuffer | null = null;
      if (!checkedGlCall(b, () => {
        callerRead = gl.getParameter(0x8caa);
        gl.bindTexture(bindTarget, old);
        for (const pname of pnames) params.push(Number(gl.getTexParameter(bindTarget, pname)));
        fresh = gl.createTexture(); candidate.calls[0][1] = fresh;
        scratch.calls[0][1] = gl.createFramebuffer();
      })) return false;
      if (!fresh || !scratch.calls[0][1]) { recordGlError(b, 0x505); return false; }
      if (!checkedGlCall(b, () => {
        gl.bindTexture(bindTarget, fresh);
        pnames.forEach((pname, i) => gl.texParameteri(bindTarget, pname, params[i]));
        gl.bindFramebuffer(READ, scratch.calls[0][1] as WebGLFramebuffer);
      })) return false;
      for (const [face, images] of textureFaces(object)) for (const [level, image] of images) {
        if (skip && skip.face === face && skip.level === level) continue;
        if (image.compressed) { recordGlError(b, 0x505); return false; }
        let complete = false;
        if (!checkedGlCall(b, () => {
          gl.texImage2D(face, level, image.internalFormat, image.width, image.height, 0, image.format, image.type, null);
          gl.framebufferTexture2D(READ, COLOR, face, old, level);
          complete = gl.checkFramebufferStatus(READ) === 0x8cd5;
        })) return false;
        if (!complete) { recordGlError(b, 0x505); return false; }
        if (!checkedGlCall(b, () => gl.copyTexSubImage2D(face, level, 0, 0, 0, 0, image.width, image.height))) return false;
      }
      // The scratch framebuffer only carried the retained images. The call
      // itself (glCopyTexImage2D) reads the caller's read framebuffer.
      return checkedGlCall(b, () => { gl.bindFramebuffer(READ, callerRead); gl.bindTexture(bindTarget, fresh); call(); });
    }, bindTarget === CUBE);
    if (!accepted || !fresh) return false;
    if (!replaceTextureView(b, object, { native: fresh, source: null, read: null })) return false;
    transferNativeRetirement(candidate); installed = true;
    return true;
  } finally {
    retireNativeRetirement(scratch);
    if (!installed) retireNativeRetirement(candidate);
  }
}

/** Validate and publish level `level` of texture `name` (GL_TEXTURE_2D or a
 * cube face) or renderbuffer `name` as the storage of GPU-tier `bo`.
 * Returns a negative errno: ENOENT (no object), EINVAL (wrong object type,
 * incomplete texture without the required level 0, renderbuffer without
 * single-sample storage), ERANGE (not a valid mipmap level), EBUSY (already
 * an EGLImage sibling), ENOMEM or EIO. Errors match KHR_gl_texture_2D_image,
 * KHR_gl_texture_cubemap_image and KHR_gl_renderbuffer_image. */
export function exportImageStorage(b: GlBinding, bo: number, target: number, name: number, level: number): GlImageExport | number {
  const gl = b.gl;
  if (!gl) return -5;
  const renderbuffer = target === RBO;
  const object = renderbuffer ? b.rbos.get(name) : b.textures.get(name);
  if (!object) return -2;
  const view = renderbuffer ? b.renderbufferViews.get(object) : b.textureViews.get(object as WebGLTexture);
  if (view?.source || linkedSource(object)) return -16;
  let native: WebGLTexture | WebGLRenderbuffer, width = 0, height = 0, storage: GlImageStorage, effective = 0;
  if (renderbuffer) {
    native = renderbufferNative(b, object);
    let internalFormat = 0, samples = 0;
    if (!withImageState(b, () => checkedGlCall(b, () => {
      gl.bindRenderbuffer(RBO, native);
      width = Number(gl.getRenderbufferParameter(RBO, 0x8d42));
      height = Number(gl.getRenderbufferParameter(RBO, 0x8d43));
      internalFormat = Number(gl.getRenderbufferParameter(RBO, 0x8d44));
      samples = Number(gl.getRenderbufferParameter(RBO, 0x8cab));
    }))) return -5;
    if (!(width > 0) || !(height > 0) || samples) return -22;
    storage = { renderbuffer: native, internalFormat };
    // The guest's format, not its native stand-in (BGRA on RGBA8 storage).
    const logical = renderbufferLogicalFormat(object as WebGLRenderbuffer) ?? internalFormat;
    effective = effectiveInternalFormat(logical, logical, 0x1401, internalFormat);
  } else {
    const cube = target !== TEX, faces = textureFaces(object);
    if (cube ? faces.has(TEX) : CUBE_FACES.some(face => faces.has(face))) return -22;
    if (level > 31) return -34;
    native = textureNative(b, object);
    let minFilter = 0;
    if (!withImageState(b, () => checkedGlCall(b, () => {
      gl.bindTexture(cube ? CUBE : TEX, native);
      minFilter = Number(gl.getTexParameter(cube ? CUBE : TEX, 0x2801));
    }), cube)) return -5;
    if (!textureComplete(object, cube, minFilter)) {
      if (level !== 0) return -22;
      if (cube ? CUBE_FACES.some(face => !textureLevel(object, face, 0)) : !textureLevel(object, TEX, 0)) return -22;
    }
    const image = textureLevel(object, target, level);
    if (!image) return -34;
    width = image.width; height = image.height;
    storage = { target, level, internalFormat: image.internalFormat, format: image.format, type: image.type };
    const gles = image.gles;
    effective = gles ? effectiveInternalFormat(gles.internalFormat, gles.format, gles.type, image.internalFormat)
      : image.internalFormat;
  }
  const previous = b.imageRevisions.get(object) ?? 0;
  if (previous === 0xffffffff) return -12;
  const record: GlExportedImage = { bo, gl, object, native, renderbuffer, width, height, storage,
    sourceUsing: true, boLive: true, format: effective };
  const token = registerImageSource(b, bo, renderbuffer ? null : native as WebGLTexture, width, height, undefined, storage);
  if (token < 0) return token;
  try {
    b.imageRevisions.set(object, previous + 1);
    exportedByNative.set(native, record);
    exportedBySource.set(object, record);
  } catch (caught) {
    b.imageSources.delete(token);
    if (previous) b.imageRevisions.set(object, previous); else b.imageRevisions.delete(object);
    exportedByNative.delete(native); exportedBySource.delete(object); rethrowNativeGlFault(caught);
    return -12;
  }
  return { record, token, revision: previous + 1, internalFormat: effective };
}

/** Register an exported image as a source in another share group. */
export function registerExportedSource(b: GlBinding, record: GlExportedImage): number {
  if (!record.boLive) return -2;
  return registerImageSource(b, record.bo, record.renderbuffer ? null : record.native as WebGLTexture,
    record.width, record.height, undefined, record.storage);
}

/** Color formats KMS can scan out: normalized fixed-point formats, read and
 * blitted as RGBA bytes as KMS scanout of a GPU-tier bo does, and RGB10_A2
 * and RGBA16F, which KMS reduces to 8 bits per channel (kms-scanout.ts). */
const SCANOUT_FORMATS = new Set([0x8058, 0x8051, 0x93a1, 0x8d62, 0x8056, 0x8057, 0x8229, 0x822b, 0x8059, 0x881a]);

/** KMS scanout storage for an exported image's bo. DRM_IOCTL_MODE_ADDFB2
 * accepts any GPU-tier bo, so the presenter reads this image's own storage
 * every vblank exactly as it reads a GBM GPU bo (no copy: rendering into the
 * image shows without a flip). The framebuffer is made on first scanout and
 * deleted with the bo. Null when the image's format cannot be read as color
 * bytes or the renderer refuses the framebuffer. */
export function exportedImageScanout(record: GlExportedImage): GpuScanoutStorage | null {
  if (!record.boLive || !SCANOUT_FORMATS.has(record.format)) return null;
  if (record.scanout) return record.scanout;
  const gl = record.gl, owner = { gl, errors: [] as number[] };
  let read: WebGLFramebuffer | null = null;
  if (!checkedGlCall(owner, () => { read = gl.getParameter(0x8caa); })) return null;
  const retirement = reserveNativeRetirement(owner, [["deleteFramebuffer", null]], [], { ordered: true });
  if (!retirement) return null;
  let fbo: WebGLFramebuffer | null = null, published = false;
  try {
    const restore = nativeInverse(owner, [["bindFramebuffer", 0x8ca8, read]]);
    const { target = TEX, level = 0 } = record.storage;
    if (!applyNativeChanges({ ...owner, shadow: {} }, [{ restore, apply: () => {
      if (!checkedGlCall(owner, () => { retirement.calls[0][1] = fbo = gl.createFramebuffer(); }) || !fbo) return false;
      let status = 0;
      return checkedGlCall(owner, () => gl.bindFramebuffer(0x8ca8, fbo))
        && checkedGlCall(owner, () => record.renderbuffer
          ? gl.framebufferRenderbuffer(0x8ca8, 0x8ce0, RBO, record.native as WebGLRenderbuffer)
          : gl.framebufferTexture2D(0x8ca8, 0x8ce0, target, record.native as WebGLTexture, level))
        && checkedGlCall(owner, () => { status = gl.checkFramebufferStatus(0x8ca8); }) && status === 0x8cd5;
    } }], { shared: true, finalizer: restore })) return null;
    record.scanout = { gl, fbo: fbo!, w: record.width, h: record.height, retirement, internalFormat: record.format };
    published = true;
    return record.scanout;
  } catch (caught) { rethrowNativeGlFault(caught); return null; }
  finally { if (!published) retireNativeRetirement(retirement); }
}

/** The bo's last reference ended. The image's storage is deleted unless the
 * source object still uses it, in which case the object owns it again. */
export function retireExportedImage(record: GlExportedImage): boolean {
  record.boLive = false;
  if (record.scanout) {
    if (!retireNativeRetirement(record.scanout.retirement)) return false;
    record.scanout = undefined;
  }
  if (record.sourceUsing) {
    exportedBySource.delete(record.object);
    exportedByNative.delete(record.native);
    record.sourceUsing = false;
    return true;
  }
  exportedByNative.delete(record.native);
  const retirement = reserveNativeRetirement({ gl: record.gl, errors: [] },
    [[record.renderbuffer ? "deleteRenderbuffer" : "deleteTexture", record.native] as NativeDeletion]);
  return !!retirement && retireNativeRetirement(retirement);
}
