import type { GlBinding } from "./registry.js";
import type { GlImageAttachment } from "./image-references.js";
import { checkedGlCall, recordGlError } from "./program-objects.js";
/** Private source handles never enter the public GLuint texture namespace. */
export const WPK_IMAGE_SOURCE_TARGET = 0x57504b49;
export type GlImageSource = {
  token: number;
  bo: number;
  texture: WebGLTexture;
  width: number;
  height: number;
};
export type GlTextureView = {
  native: WebGLTexture;
  source: GlImageSource | null;
  read: WebGLFramebuffer | null;
};
export type GlRenderbufferView = {
  native: WebGLRenderbuffer;
  source: GlImageSource | null;
};
const TEX = 0x0de1, RBO = 0x8d41, DRAW = 0x8ca9, READ = 0x8ca8, COLOR = 0x8ce0;
export function registerImageSource(b: GlBinding, bo: number, texture: WebGLTexture, width: number, height: number): number {
  for (const source of b.imageSources.values())
    if (source.bo === bo)
      return source.token;
  if (b.nextImageSource > 0x7fffffff)
    return -12;
  const token = b.nextImageSource;
  try {
    b.imageSources.set(token, { token, bo, texture, width, height });
  }
  catch {
    return -12;
  }
  b.nextImageSource++;
  return token;
}
export function textureNative(b: GlBinding, object: WebGLTexture): WebGLTexture {
  return b.textureViews.get(object)?.native ?? object;
}
export function renderbufferNative(b: GlBinding, object: WebGLRenderbuffer): WebGLRenderbuffer {
  return b.renderbufferViews.get(object)?.native ?? object;
}
export function canonicalTexture(b: GlBinding, native: WebGLTexture): WebGLTexture {
  return b.textureViewOwners.get(native) ?? native;
}
export function canonicalRenderbuffer(b: GlBinding, native: WebGLRenderbuffer): WebGLRenderbuffer {
  return b.renderbufferViewOwners.get(native) ?? native;
}
/** All utility work restores actual native state, including distinct read and
 * draw defaults. The logical shadow continues to contain stable identities. */
function withImageState(b: GlBinding, call: () => boolean): boolean {
  const gl = b.gl!;
  let active = 0, texture: WebGLTexture | null = null, draw: WebGLFramebuffer | null = null, read: WebGLFramebuffer | null = null, renderbuffer: WebGLRenderbuffer | null = null;
  if (!checkedGlCall(b, () => {
    active = Number(gl.getParameter(0x84e0));
    texture = gl.getParameter(0x8069) as WebGLTexture | null;
    draw = gl.getParameter(0x8ca6) as WebGLFramebuffer | null;
    read = gl.getParameter(0x8caa) as WebGLFramebuffer | null;
    renderbuffer = gl.getParameter(0x8ca7) as WebGLRenderbuffer | null;
  }))
    return false;
  let accepted = false, restored = false;
  try {
    accepted = call();
  }
  finally {
    restored = checkedGlCall(b, () => {
      gl.activeTexture(active);
      gl.bindTexture(TEX, texture);
      gl.bindRenderbuffer(RBO, renderbuffer);
      gl.bindFramebuffer(DRAW, draw);
      gl.bindFramebuffer(READ, read);
    });
  }
  return accepted && restored;
}
function copySource(b: GlBinding, view: GlTextureView): boolean {
  if (!view.source)
    return true;
  const gl = b.gl!, source = view.source;
  return withImageState(b, () => checkedGlCall(b, () => {
    gl.bindFramebuffer(READ, view.read);
    gl.bindTexture(TEX, view.native);
    gl.copyTexSubImage2D(TEX, 0, 0, 0, 0, 0, source.width, source.height);
  }));
}
function allocateTextureView(b: GlBinding, old: WebGLTexture, source: GlImageSource, preserveBase = true): GlTextureView | null {
  const gl = b.gl!;
  let native: WebGLTexture | null = null, read: WebGLFramebuffer | null = null;
  const accepted = withImageState(b, () => {
    const params: number[] = [];
    if (!checkedGlCall(b, () => {
      gl.bindTexture(TEX, old);
      for (const pname of [0x2800, 0x2801, 0x2802, 0x2803])
        params.push(Number(gl.getTexParameter(TEX, pname)));
      native = gl.createTexture();
      if (preserveBase)
        read = gl.createFramebuffer();
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
        gl.framebufferTexture2D(READ, COLOR, TEX, source.texture, 0);
        gl.texImage2D(TEX, 0, 0x8058, source.width, source.height, 0, 0x1908, 0x1401, null);
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
  if (!accepted) {
    if (native)
      gl.deleteTexture(native);
    if (read)
      gl.deleteFramebuffer(read);
    return null;
  }
  return { native: native!, source, read };
}
/** Resolve physical storage while retaining logical attachment query identity. */
export function attachImage(b: GlBinding, target: number, point: number, image: GlImageAttachment | null, override?: GlTextureView | GlRenderbufferView): void {
  const gl = b.gl!;
  if (!image) {
    gl.framebufferRenderbuffer(target, point, RBO, null);
    return;
  }
  const view = override ?? (image.kind === "texture" ? b.textureViews.get(image.object) : b.renderbufferViews.get(image.object));
  if (view?.source) {
    gl.framebufferTexture2D(target, point, image.kind === "texture" ? image.target : TEX, view.source.texture, image.kind === "texture" ? image.level : 0);
    return;
  }
  if (image.kind === "texture")
    gl.framebufferTexture2D(target, point, image.target, (view?.native as WebGLTexture | undefined) ?? image.object, image.level);
  else
    gl.framebufferRenderbuffer(target, point, RBO, (view?.native as WebGLRenderbuffer | undefined) ?? image.object);
}
/** Retarget all containers before publishing storage. Other contexts' bindings
 * remain logical and resolve the current view on their next muxer selection. */
function retarget(b: GlBinding, kind: number, object: WebGLTexture | WebGLRenderbuffer, old: GlTextureView | GlRenderbufferView, next: GlTextureView | GlRenderbufferView): boolean {
  const gl = b.gl!, attachments: Array<{
    fbo: WebGLFramebuffer;
    point: number;
    image: GlImageAttachment;
  }> = [];
  for (const member of b.objects.members)
    for (const [fbo, points] of member.framebufferAttachments)
      for (const [point, image] of points)
        if (image.kind === (kind === 1 ? "texture" : "renderbuffer") && image.object === object)
          attachments.push({ fbo, point, image });
  const units: number[] = [];
  if (kind === 1)
    for (let i = 0; i < b.shadow.textureUnits.length; i++)
      if (b.shadow.textureUnits[i] === object)
        units.push(i);
  let changed = 0;
  const accepted = withImageState(b, () => {
    for (const entry of attachments) {
      changed++;
      if (!checkedGlCall(b, () => { gl.bindFramebuffer(DRAW, entry.fbo); attachImage(b, DRAW, entry.point, entry.image, next); }))
        return false;
    }
    return true;
  });
  if (!accepted) {
    withImageState(b, () => {
      let restored = true;
      for (let index = 0; index < changed; index++) {
        const entry = attachments[index];
        restored = checkedGlCall(b, () => {
          gl.bindFramebuffer(DRAW, entry.fbo);
          attachImage(b, DRAW, entry.point, entry.image, old);
        }) && restored;
      }
      return restored;
    });
    return false;
  }
  // Restore utility state before updating the selected context's physical
  // bindings; those changes must survive until its next command.
  let applied = 0;
  const bound = checkedGlCall(b, () => {
    if (kind === 1) {
      try {
        for (const unit of units) {
          applied++;
          gl.activeTexture(0x84c0 + unit);
          gl.bindTexture(TEX, next.native as WebGLTexture);
        }
      }
      finally {
        gl.activeTexture(0x84c0 + b.shadow.activeTexture);
      }
    }
    else if (b.shadow.renderbuffer === object)
      gl.bindRenderbuffer(RBO, next.native as WebGLRenderbuffer);
  });
  if (bound)
    return true;
  checkedGlCall(b, () => {
    if (kind === 1) {
      try {
        for (let index = 0; index < applied; index++) {
          const unit = units[index];
          gl.activeTexture(0x84c0 + unit);
          gl.bindTexture(TEX, old.native as WebGLTexture);
        }
      }
      finally {
        gl.activeTexture(0x84c0 + b.shadow.activeTexture);
      }
    }
    else if (b.shadow.renderbuffer === object)
      gl.bindRenderbuffer(RBO, old.native as WebGLRenderbuffer);
  });
  withImageState(b, () => {
    let restored = true;
    for (const entry of attachments)
      restored = checkedGlCall(b, () => { gl.bindFramebuffer(DRAW, entry.fbo); attachImage(b, DRAW, entry.point, entry.image, old); }) && restored;
    return restored;
  });
  return false;
}
function replaceTextureView(b: GlBinding, object: WebGLTexture, next: GlTextureView): boolean {
  const old = b.textureViews.get(object) ?? { native: object, source: null, read: null };
  const had = b.textureViews.has(object);
  const previousRevision = b.imageRevisions.get(object) ?? 0;
  if (previousRevision === 0xffffffff) {
    recordGlError(b, 0x505);
    return false;
  }
  try {
    b.imageRevisions.set(object, previousRevision + 1);
  }
  catch {
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
  catch {
    if (had)
      b.textureViews.set(object, old);
    else
      b.textureViews.delete(object);
    restoreRevision();
    recordGlError(b, 0x505);
    return false;
  }
  let accepted = false;
  try {
    accepted = retarget(b, 1, object, old, next);
  }
  catch {
    recordGlError(b, 0x505);
  }
  if (!accepted) {
    if (had)
      b.textureViews.set(object, old);
    else
      b.textureViews.delete(object);
    b.textureViewOwners.delete(next.native);
    restoreRevision();
    return false;
  }
  b.textureViewOwners.delete(old.native);
  if (!b.externallyOwnedTextures.has(old.native))
    checkedGlCall(b, () => b.gl!.deleteTexture(old.native));
  if (old.read)
    checkedGlCall(b, () => b.gl!.deleteFramebuffer(old.read));
  return true;
}
function replaceRenderbufferView(b: GlBinding, object: WebGLRenderbuffer, next: GlRenderbufferView): boolean {
  const old = b.renderbufferViews.get(object) ?? { native: object, source: null };
  const had = b.renderbufferViews.has(object);
  const previousRevision = b.imageRevisions.get(object) ?? 0;
  if (previousRevision === 0xffffffff) {
    recordGlError(b, 0x505);
    return false;
  }
  try {
    b.imageRevisions.set(object, previousRevision + 1);
  }
  catch {
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
  catch {
    if (had)
      b.renderbufferViews.set(object, old);
    else
      b.renderbufferViews.delete(object);
    restoreRevision();
    recordGlError(b, 0x505);
    return false;
  }
  let accepted = false;
  try {
    accepted = retarget(b, 2, object, old, next);
  }
  catch {
    recordGlError(b, 0x505);
  }
  if (!accepted) {
    if (had)
      b.renderbufferViews.set(object, old);
    else
      b.renderbufferViews.delete(object);
    if (next.native !== old.native)
      b.renderbufferViewOwners.delete(next.native);
    restoreRevision();
    return false;
  }
  if (next.native !== old.native) {
    b.renderbufferViewOwners.delete(old.native);
    checkedGlCall(b, () => b.gl!.deleteRenderbuffer(old.native));
  }
  return true;
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
    if (replaceTextureView(b, object as WebGLTexture, view))
      return true;
    b.gl!.deleteTexture(view.native);
    if (view.read)
      b.gl!.deleteFramebuffer(view.read);
    return false;
  }
  return replaceRenderbufferView(b, object as WebGLRenderbuffer, { native: renderbufferNative(b, object as WebGLRenderbuffer), source });
}
export function imageSourceToken(b: GlBinding, kind: number, name: number): number | null {
  if (kind === 1) {
    const object = b.textures.get(name);
    return object ? (b.textureViews.get(object)?.source?.token ?? 0) : null;
  }
  if (kind === 2) {
    const object = b.rbos.get(name);
    return object ? (b.renderbufferViews.get(object)?.source?.token ?? 0) : null;
  }
  return null;
}
export type GlBoundImageState = {
  source: number;
  revision: number;
};
function boundImageObject(b: GlBinding, kind: number, target: number): WebGLTexture | WebGLRenderbuffer | null {
  if ((kind !== 1 && kind !== 2) || (kind === 1 ? target !== TEX : target !== RBO)) {
    recordGlError(b, 0x500);
    return null;
  }
  const object = kind === 1 ? b.shadow.textureUnits[b.shadow.activeTexture] : b.shadow.renderbuffer;
  if (!object)
    recordGlError(b, 0x502);
  return object ?? null;
}
/** Resolve the implicit binding, never a potentially reused public name. */
export function boundImageState(b: GlBinding, kind: number, target: number, source?: number): GlBoundImageState | null {
  const object = boundImageObject(b, kind, target);
  if (!object)
    return null;
  if (source !== undefined && !importImageObject(b, kind, object, source))
    return null;
  const view = kind === 1 ? b.textureViews.get(object) : b.renderbufferViews.get(object);
  return { source: view?.source?.token ?? 0, revision: b.imageRevisions.get(object) ?? 0 };
}
/** Each sampling view has independent parameters. Refresh its pixels from the
 * canonical image before every draw, including writes made through other APIs. */
export function prepareImageDraw(b: GlBinding): boolean {
  const seen = new Set<WebGLTexture>();
  for (const object of b.shadow.textureUnits) {
    if (!object || seen.has(object))
      continue;
    seen.add(object);
    const view = b.textureViews.get(object);
    if (view?.source && !copySource(b, view))
      return false;
  }
  return true;
}
export function boundImageTexture(b: GlBinding, target: number): GlTextureView | undefined {
  if (target !== TEX)
    return undefined;
  const object = b.shadow.textureUnits[b.shadow.activeTexture];
  return object ? b.textureViews.get(object) : undefined;
}
/** Pixel updates preserve shared storage; respecification allocates an owned
 * candidate and commits only after native validation and container retargeting. */
export function imageTextureOperation(b: GlBinding, target: number, respecify: boolean, call: () => void, preserveBase = true): boolean {
  const view = boundImageTexture(b, target);
  if (!view?.source)
    return checkedGlCall(b, call);
  if (!respecify)
    return withImageState(b, () => checkedGlCall(b, () => { b.gl!.bindTexture(TEX, view.source!.texture); call(); }));
  const object = b.shadow.textureUnits[b.shadow.activeTexture]!;
  // [RUNTIME-WORKAROUND: CHROMIUM-COPY-TEX-RESPEC] Do not copy a base
  // image that this command replaces; Chromium can retain those copied pixels.
  const candidate = allocateTextureView(b, view.native, view.source, preserveBase);
  if (!candidate)
    return false;
  const accepted = withImageState(b, () => checkedGlCall(b, () => { b.gl!.bindTexture(TEX, candidate.native); call(); }));
  if (accepted) {
    if (candidate.read)
      b.gl!.deleteFramebuffer(candidate.read);
    candidate.read = null;
    candidate.source = null;
    if (replaceTextureView(b, object, candidate))
      return true;
  }
  b.gl!.deleteTexture(candidate.native);
  if (candidate.read)
    b.gl!.deleteFramebuffer(candidate.read);
  return false;
}
export function imageRenderbufferStorage(b: GlBinding, call: () => void): boolean {
  const object = b.shadow.renderbuffer, view = object && b.renderbufferViews.get(object);
  if (!view?.source)
    return checkedGlCall(b, call);
  let native: WebGLRenderbuffer | null = null;
  const accepted = withImageState(b, () => {
    if (!checkedGlCall(b, () => { native = b.gl!.createRenderbuffer(); }))
      return false;
    if (!native) {
      recordGlError(b, 0x505);
      return false;
    }
    return checkedGlCall(b, () => { b.gl!.bindRenderbuffer(RBO, native); call(); });
  });
  if (accepted && native && replaceRenderbufferView(b, object!, { native, source: null }))
    return true;
  if (native)
    b.gl!.deleteRenderbuffer(native);
  return false;
}
export function destroyTextureView(b: GlBinding, object: WebGLTexture): boolean {
  const view = b.textureViews.get(object), native = view?.native ?? object;
  if (!b.externallyOwnedTextures.has(native) && !checkedGlCall(b, () => b.gl!.deleteTexture(native)))
    return false;
  if (view?.read)
    b.gl!.deleteFramebuffer(view.read);
  b.textureViewOwners.delete(native);
  b.textureViews.delete(object);
  b.imageRevisions.delete(object);
  b.foreignTextureBos.delete(object);
  return true;
}
export function destroyRenderbufferView(b: GlBinding, object: WebGLRenderbuffer): boolean {
  const native = renderbufferNative(b, object);
  if (!checkedGlCall(b, () => b.gl!.deleteRenderbuffer(native)))
    return false;
  b.renderbufferViewOwners.delete(native);
  b.renderbufferViews.delete(object);
  b.imageRevisions.delete(object);
  return true;
}
