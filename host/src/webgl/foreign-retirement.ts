import type { GlBinding } from "./registry.js";
import { attachImage, textureNative } from "./image-storage.js";
import { collectRetiredImages } from "./image-references.js";
import { checkedGlCall, recordGlError } from "./program-objects.js";

/** BO ownership expires every raw view generation, including deleted names
 * retained by a peer. A replacement using the number has another identity. */
export function revokeForeignBo(b: GlBinding, bo: number): boolean {
  const objects = new Set<WebGLTexture>();
  for (const [object, owner] of b.foreignTextureBos) if (owner === bo) objects.add(object);
  const cached = b.foreignTextures.get(bo); if (cached) objects.add(cached.tex);
  if (!objects.size) {
    for (const [token,source] of b.imageSources) if (source.bo === bo) b.imageSources.delete(token);
    return true;
  }
  if (!b.gl) return false;
  const gl = b.gl;
  let retired: GlBinding["retiredTextures"];
  let changes: {apply: () => boolean; restore: () => boolean}[];
  let points: {owner: GlBinding; framebuffer: WebGLFramebuffer; point: number}[];
  let units: {bindings: (WebGLTexture|null)[]; unit: number}[];
  let hasFramebuffers = false;
  let active = 0, draw: WebGLFramebuffer|null = null, read: WebGLFramebuffer|null = null;
  try {
    retired = new Map(b.retiredTextures); points = []; units = []; changes = [];
    const natives = new Set([...objects].map(object => textureNative(b,object)));
    const physicalUnits = new Set<number>();
    for (const object of objects) {
      let name = retired.get(object) ?? 0;
      for (const [number,texture] of b.textures) if (texture === object) { name = number; break; }
      retired.set(object,name);
    }
    for (const owner of b.objects.members) {
      for (const bindings of [owner.shadow.textureUnits,owner.shadow.cubeTextureUnits])
        for (let unit=0; unit<bindings.length; unit++) if (bindings[unit] && objects.has(bindings[unit]!)) {
          units.push({bindings,unit}); physicalUnits.add(unit);
        }
      for (const [framebuffer, attachments] of owner.framebufferAttachments) for (const [point,image] of attachments) {
        if (image.kind !== "texture" || !objects.has(image.object)) continue;
        hasFramebuffers = true; points.push({owner,framebuffer,point});
        changes.push({apply: () => checkedGlCall(b, () => gl.bindFramebuffer(0x8ca9,framebuffer)) &&
            checkedGlCall(b, () => gl.framebufferTexture2D(0x8ca9,point,image.target,null,image.level)),
          restore: () => checkedGlCall(b, () => gl.bindFramebuffer(0x8ca9,framebuffer)) &&
            checkedGlCall(b, () => attachImage(b,0x8ca9,point,image))});
      }
    }
    for (const unit of physicalUnits) for (const [target,pname] of [[0x0de1,0x8069],[0x8513,0x8514]]) {
      let previous: WebGLTexture|null = null, captured = false;
      changes.push({apply: () => {
        if (!checkedGlCall(b, () => gl.activeTexture(0x84c0+unit))) return false;
        if (!checkedGlCall(b, () => { previous = gl.getParameter(pname) as WebGLTexture|null; })) return false;
        captured = true;
        return !previous || !natives.has(previous) || checkedGlCall(b, () => gl.bindTexture(target,null));
      }, restore: () => !captured || !previous || !natives.has(previous) ||
        (checkedGlCall(b, () => gl.activeTexture(0x84c0+unit)) && checkedGlCall(b, () => gl.bindTexture(target,previous)))});
    }
  } catch { recordGlError(b,0x505); return false; }
  const restoreUtility = () => {
    let restored = true;
    if (hasFramebuffers) {
      restored = checkedGlCall(b, () => gl.bindFramebuffer(0x8ca9,draw));
      restored = checkedGlCall(b, () => gl.bindFramebuffer(0x8ca8,read)) && restored;
    }
    if (changes.length) restored = checkedGlCall(b, () => gl.activeTexture(active)) && restored;
    return restored;
  };
  if (changes.length && !checkedGlCall(b, () => {
    active = Number(gl.getParameter(0x84e0));
    if (hasFramebuffers) { draw = gl.getParameter(0x8ca6); read = gl.getParameter(0x8caa); }
  })) return false;
  let attempted = 0, accepted = true;
  for (const change of changes) { attempted++; if (!change.apply()) { accepted = false; break; } }
  if (!restoreUtility()) accepted = false;
  if (!accepted) {
    for (let i=attempted-1;i>=0;i--) changes[i].restore();
    restoreUtility(); return false;
  }
  for (const {bindings,unit} of units) bindings[unit] = null;
  for (const {owner,framebuffer,point} of points) {
    const attachments = owner.framebufferAttachments.get(framebuffer)!; attachments.delete(point);
    if (!attachments.size) owner.framebufferAttachments.delete(framebuffer);
  }
  for (const [name,object] of b.textures) if (objects.has(object)) b.textures.delete(name);
  if (cached && objects.has(cached.tex)) b.foreignTextures.delete(bo);
  for (const [token,source] of b.imageSources) if (source.bo === bo) b.imageSources.delete(token);
  b.retiredTextures = retired;
  collectRetiredImages(b);
  for (const object of objects) if (b.foreignTextureBos.has(object)) return false;
  return true;
}
