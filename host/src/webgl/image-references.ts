import type { GlBinding } from "./registry.js";
import { checkedGlCall } from "./program-objects.js";

export type GlImageAttachment =
  | { kind: "texture"; object: WebGLTexture; target: number; level: number }
  | { kind: "renderbuffer"; object: WebGLRenderbuffer };

export function setImageAttachment(b: GlBinding, framebuffer: WebGLFramebuffer, attachment: number,
    image: GlImageAttachment | null): void {
  let points = b.framebufferAttachments.get(framebuffer);
  if (!points) { points = new Map(); b.framebufferAttachments.set(framebuffer, points); }
  // Packed depth/stencil is two attachment references. Replacing just depth
  // must leave the independent stencil reference alive.
  for (const point of attachment === 0x821a ? [0x8d00,0x8d20] : [attachment]) {
    if (image) points.set(point,image); else points.delete(point);
  }
  if (!points.size) b.framebufferAttachments.delete(framebuffer);
}

function detachBoundImages(b: GlBinding, kind: GlImageAttachment["kind"], object: object): boolean {
  const gl = b.gl!;
  const bindings = [[0x8ca9,b.shadow.fbo],[0x8ca8,b.shadow.readFbo]] as const;
  const visited = new Set<WebGLFramebuffer>();
  for (const [target,framebuffer] of bindings) {
    if (!framebuffer || visited.has(framebuffer)) continue;
    visited.add(framebuffer);
    const points = b.framebufferAttachments.get(framebuffer);
    if (!points) continue;
    for (const [point,image] of points) {
      if (image.kind !== kind || image.object !== object) continue;
      const accepted = checkedGlCall(b, () => {
        if (image.kind === "texture") gl.framebufferTexture2D(target,point,image.target,null,0);
        else gl.framebufferRenderbuffer(target,point,0x8d41,null);
      });
      if (!accepted) return false;
      points.delete(point);
    }
    if (!points.size) b.framebufferAttachments.delete(framebuffer);
  }
  return true;
}

/** Delete a public name while retaining the object for other context and
 * container references. Only the calling context's bindings are reset. */
export function deleteTextureName(b: GlBinding, name: number): void {
  const texture = b.textures.get(name);
  if (!texture || !b.gl) return;
  const gl = b.gl;
  const tables = [[0x0de1,b.shadow.textureUnits],[0x8513,b.shadow.cubeTextureUnits]] as const;
  const accepted = checkedGlCall(b, () => {
    try {
      for (const [target,units] of tables) for (let unit=0; unit<units.length; unit++) {
        if (units[unit] === texture) { gl.activeTexture(0x84c0+unit); gl.bindTexture(target,null); }
      }
    } finally { gl.activeTexture(0x84c0+b.shadow.activeTexture); }
  });
  if (!accepted) return;
  for (const [,units] of tables) for (let i=0; i<units.length; i++) if (units[i] === texture) units[i] = null;
  if (!detachBoundImages(b,"texture",texture)) return;
  b.textures.delete(name);
  for (const [bo,entry] of b.foreignTextures) if (entry.tex === texture) b.foreignTextures.delete(bo);
  b.retiredTextures.set(texture,name);
}

export function deleteRenderbufferName(b: GlBinding, name: number): void {
  const renderbuffer = b.rbos.get(name);
  if (!renderbuffer || !b.gl) return;
  if (b.shadow.renderbuffer === renderbuffer) {
    if (!checkedGlCall(b, () => b.gl!.bindRenderbuffer(0x8d41,null))) return;
    b.shadow.renderbuffer = null;
  }
  if (!detachBoundImages(b,"renderbuffer",renderbuffer)) return;
  b.rbos.delete(name);
  b.retiredRenderbuffers.set(renderbuffer,name);
}

function imageReferenced(b: GlBinding, kind: GlImageAttachment["kind"], object: object): boolean {
  for (const member of b.objects.members) {
    if (kind === "texture" && (member.shadow.textureUnits.includes(object as WebGLTexture)
        || member.shadow.cubeTextureUnits.includes(object as WebGLTexture))) return true;
    if (kind === "renderbuffer" && member.shadow.renderbuffer === object) return true;
    for (const points of member.framebufferAttachments.values()) {
      for (const image of points.values()) if (image.kind === kind && image.object === object) return true;
    }
  }
  return false;
}

export function collectRetiredImages(b: GlBinding): void {
  if (!b.gl) return;
  for (const [texture] of b.retiredTextures) {
    if (imageReferenced(b,"texture",texture)) continue;
    if (!b.externallyOwnedTextures.has(texture) && !checkedGlCall(b, () => b.gl!.deleteTexture(texture))) continue;
    b.retiredTextures.delete(texture);
  }
  for (const [renderbuffer] of b.retiredRenderbuffers) {
    if (imageReferenced(b,"renderbuffer",renderbuffer)) continue;
    if (checkedGlCall(b, () => b.gl!.deleteRenderbuffer(renderbuffer))) b.retiredRenderbuffers.delete(renderbuffer);
  }
}
