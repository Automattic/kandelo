import { attachImage, destroyTextureView, destroyRenderbufferView, textureNative, renderbufferNative } from "./image-storage.js";
import type { GlBinding } from "./registry.js";
import { checkedGlCall, recordGlError } from "./program-objects.js";
import { boundFramebuffer, defaultFramebuffer, isDefaultFramebuffer, validFramebufferTarget } from "./framebuffer.js";
export type GlImageAttachment = {
  kind: "texture";
  object: WebGLTexture;
  target: number;
  level: number;
} | {
  kind: "renderbuffer";
  object: WebGLRenderbuffer;
};
/** Stage the complete container change before native publication. Both queued
 * and checked attachment paths use this transaction and its retained identity. */
export function attachImageObject(b: GlBinding, kind: number, target: number, point: number, objectTarget: number, name: number, level: number): boolean {
  if ((kind !== 1 && kind !== 2) || !validFramebufferTarget(target)
    || (kind === 2 && objectTarget !== 0x8d41)) {
    recordGlError(b, 0x500);
    return false;
  }
  const framebuffer = boundFramebuffer(b, target);
  if (isDefaultFramebuffer(b, framebuffer)) {
    recordGlError(b, 0x502);
    return false;
  }
  const object = kind === 1 ? b.textures.get(name) : b.rbos.get(name);
  if (name && !object) {
    recordGlError(b, 0x502);
    return false;
  }
  if (kind === 2 && level !== 0) {
    recordGlError(b, 0x501);
    return false;
  }
  const image: GlImageAttachment | null = object ? (kind === 1 ?
    { kind: "texture", object: object as WebGLTexture, target: objectTarget, level } :
    { kind: "renderbuffer", object: object as WebGLRenderbuffer }) : null;
  let containers: GlBinding["framebufferAttachments"];
  try {
    containers = new Map(b.framebufferAttachments);
    const points = new Map(containers.get(framebuffer!));
    for (const attachment of point === 0x821a ? [0x8d00, 0x8d20] : [point]) {
      if (image)
        points.set(attachment, image);
      else
        points.delete(attachment);
    }
    if (points.size)
      containers.set(framebuffer!, points);
    else
      containers.delete(framebuffer!);
  }
  catch {
    recordGlError(b, 0x505);
    return false;
  }
  if (!checkedGlCall(b, () => {
    if (image)
      attachImage(b, target, point, image);
    else if (kind === 1)
      b.gl!.framebufferTexture2D(target, point, objectTarget, null, level);
    else
      b.gl!.framebufferRenderbuffer(target, point, objectTarget, null);
  }))
    return false;
  b.framebufferAttachments = containers;
  return true;
}
type NativeChange = {
  apply: () => boolean;
  restore: () => boolean;
};
/** Driver errors leave logical ownership intact. Reverse already attempted
 * native steps as well, including the failing step. Context loss or a second
 * error during restoration remains observable through the host error flags. */
function applyImageChanges(b: GlBinding, changes: NativeChange[]): boolean {
  let attempted = 0;
  for (const change of changes) {
    attempted++;
    if (change.apply())
      continue;
    for (let i = attempted - 1; i >= 0; i--)
      changes[i].restore();
    return false;
  }
  return true;
}
function boundAttachmentChanges(b: GlBinding, kind: GlImageAttachment["kind"], object: object): {
  changes: NativeChange[];
  points: Array<{
    framebuffer: WebGLFramebuffer;
    point: number;
  }>;
} {
  const changes: NativeChange[] = [], points: Array<{
    framebuffer: WebGLFramebuffer;
    point: number;
  }> = [];
  const visited = new Set<WebGLFramebuffer>();
  for (const [target, framebuffer] of [[0x8ca9, b.shadow.fbo], [0x8ca8, b.shadow.readFbo]] as const) {
    if (!framebuffer || visited.has(framebuffer))
      continue;
    visited.add(framebuffer);
    for (const [point, image] of b.framebufferAttachments.get(framebuffer) ?? []) {
      if (image.kind !== kind || image.object !== object)
        continue;
      changes.push({ apply: () => checkedGlCall(b, () => attachImage(b, target, point, null)), restore: () => checkedGlCall(b, () => attachImage(b, target, point, image)) });
      points.push({ framebuffer, point });
    }
  }
  return { changes, points };
}
function commitAttachmentDeletion(b: GlBinding, points: Array<{
  framebuffer: WebGLFramebuffer;
  point: number;
}>): void {
  for (const { framebuffer, point } of points) {
    const attachments = b.framebufferAttachments.get(framebuffer)!;
    attachments.delete(point);
    if (!attachments.size)
      b.framebufferAttachments.delete(framebuffer);
  }
}
/** Delete a public name while retaining the object for other context and
 * container references. Only the calling context's bindings are reset.
 * Retired-map capacity and all rollback actions precede native mutation. */
export function deleteTextureName(b: GlBinding, name: number): boolean {
  const texture = b.textures.get(name);
  if (!name || !texture)
    return true;
  if (!b.gl)
    return false;
  const gl = b.gl;
  let changes: NativeChange[], points: Array<{
    framebuffer: WebGLFramebuffer;
    point: number;
  }>, units: Array<{
    bindings: Array<WebGLTexture | null>;
    unit: number;
  }>;
  const previous = b.retiredTextures.get(texture);
  try {
    ({ changes, points } = boundAttachmentChanges(b, "texture", texture));
    units = [];
    for (const [target, bindings] of [[0x0de1, b.shadow.textureUnits], [0x8513, b.shadow.cubeTextureUnits]] as const) {
      for (let unit = 0; unit < bindings.length; unit++)
        if (bindings[unit] === texture) {
          const bind = (native: WebGLTexture | null) => {
            if (!checkedGlCall(b, () => gl.activeTexture(0x84c0 + unit)))
              return false;
            const accepted = checkedGlCall(b, () => gl.bindTexture(target, native));
            const restored = checkedGlCall(b, () => gl.activeTexture(0x84c0 + b.shadow.activeTexture));
            return accepted && restored;
          };
          changes.push({ apply: () => bind(b.shadow.defaultTextures.get(target) ?? null), restore: () => bind(textureNative(b, texture)) });
          units.push({ bindings, unit });
        }
    }
    b.retiredTextures.set(texture, name);
  }
  catch {
    recordGlError(b, 0x505);
    return false;
  }
  if (!applyImageChanges(b, changes)) {
    if (previous === undefined)
      b.retiredTextures.delete(texture);
    else
      b.retiredTextures.set(texture, previous);
    return false;
  }
  for (const { bindings, unit } of units)
    bindings[unit] = null;
  commitAttachmentDeletion(b, points);
  b.textures.delete(name);
  for (const [bo, entry] of b.foreignTextures)
    if (entry.tex === texture)
      b.foreignTextures.delete(bo);
  return true;
}
export function deleteRenderbufferName(b: GlBinding, name: number): boolean {
  const object = b.rbos.get(name);
  if (!name || !object)
    return true;
  if (!b.gl)
    return false;
  let changes: NativeChange[], points: Array<{
    framebuffer: WebGLFramebuffer;
    point: number;
  }>;
  const previous = b.retiredRenderbuffers.get(object);
  try {
    ({ changes, points } = boundAttachmentChanges(b, "renderbuffer", object));
    if (b.shadow.renderbuffer === object)
      changes.push({
        apply: () => checkedGlCall(b, () => b.gl!.bindRenderbuffer(0x8d41, null)), restore: () => checkedGlCall(b, () => b.gl!.bindRenderbuffer(0x8d41, renderbufferNative(b, object)))
      });
    b.retiredRenderbuffers.set(object, name);
  }
  catch {
    recordGlError(b, 0x505);
    return false;
  }
  if (!applyImageChanges(b, changes)) {
    if (previous === undefined)
      b.retiredRenderbuffers.delete(object);
    else
      b.retiredRenderbuffers.set(object, previous);
    return false;
  }
  if (b.shadow.renderbuffer === object)
    b.shadow.renderbuffer = null;
  commitAttachmentDeletion(b, points);
  b.rbos.delete(name);
  return true;
}
export function deleteFramebufferName(b: GlBinding, name: number): boolean {
  const object = b.fbos.get(name);
  if (!name || !object)
    return true;
  const gl = b.gl;
  if (!gl)
    return false;
  const changes: NativeChange[] = [];
  const draw = defaultFramebuffer(b), read = defaultFramebuffer(b, true);
  if (b.shadow.fbo === object)
    changes.push({ apply: () => checkedGlCall(b, () => gl.bindFramebuffer(0x8ca9, draw)), restore: () => checkedGlCall(b, () => gl.bindFramebuffer(0x8ca9, object)) });
  if (b.shadow.readFbo === object)
    changes.push({ apply: () => checkedGlCall(b, () => gl.bindFramebuffer(0x8ca8, read)), restore: () => checkedGlCall(b, () => gl.bindFramebuffer(0x8ca8, object)) });
  if (!applyImageChanges(b, changes))
    return false;
  if (!checkedGlCall(b, () => gl.deleteFramebuffer(object))) {
    for (let i = changes.length - 1; i >= 0; i--)
      changes[i].restore();
    return false;
  }
  if (b.shadow.fbo === object)
    b.shadow.fbo = draw;
  if (b.shadow.readFbo === object)
    b.shadow.readFbo = read;
  b.fbos.delete(name);
  b.framebufferAttachments.delete(object);
  return true;
}
export function deleteImageObject(b: GlBinding, kind: number, name: number): boolean {
  if (kind === 1)
    return deleteTextureName(b, name);
  if (kind === 2)
    return deleteRenderbufferName(b, name);
  if (kind === 3)
    return deleteFramebufferName(b, name);
  recordGlError(b, 0x500);
  return false;
}
function imageReferenced(b: GlBinding, kind: GlImageAttachment["kind"], object: object): boolean {
  for (const member of b.objects.members) {
    if (kind === "texture" && (member.shadow.textureUnits.includes(object as WebGLTexture)
      || member.shadow.cubeTextureUnits.includes(object as WebGLTexture)))
      return true;
    if (kind === "renderbuffer" && member.shadow.renderbuffer === object)
      return true;
    for (const points of member.framebufferAttachments.values()) {
      for (const image of points.values())
        if (image.kind === kind && image.object === object)
          return true;
    }
  }
  return false;
}
export function collectRetiredImages(b: GlBinding): void {
  if (!b.gl)
    return;
  for (const [texture] of b.retiredTextures) {
    if (imageReferenced(b, "texture", texture))
      continue;
    if (!destroyTextureView(b, texture))
      continue;
    b.retiredTextures.delete(texture);
  }
  for (const [renderbuffer] of b.retiredRenderbuffers) {
    if (imageReferenced(b, "renderbuffer", renderbuffer))
      continue;
    if (destroyRenderbufferView(b, renderbuffer))
      b.retiredRenderbuffers.delete(renderbuffer);
  }
}
