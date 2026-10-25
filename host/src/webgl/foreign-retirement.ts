import type { GlBinding } from "./registry.js";
import { applyNativeChanges, nativeInverse, repairNativeState, type NativeChange, type NativeCall } from "./native-recovery.js";
import { imageAttachmentCall, textureNative } from "./image-storage.js";
import { collectRetiredImages } from "./image-references.js";
import { checkedGlCall, recordGlError } from "./program-objects.js";

/** BO ownership expires every raw view generation, including deleted names
 * retained by a peer. A replacement using the number has another identity. */
export function revokeForeignBo(b: GlBinding, bo: number): boolean {
  let objects: Set<WebGLTexture>;
  const cached = b.foreignTextures.get(bo);
  try {
    objects = new Set();
    for (const [object, owner] of b.foreignTextureBos) if (owner === bo) objects.add(object);
    if (cached) objects.add(cached.tex);
  } catch { recordGlError(b,0x505); return false; }
  // Storage redefinition can remove the last public view while its old
  // native container still awaits cleanup. That pending renderer repair
  // must finish before its canonical BO backing can retire too.
  if (b.gl && !repairNativeState(b.gl)) return false;
  if (!objects.size) {
    for (const [token,source] of b.imageSources) if (source.bo === bo) b.imageSources.delete(token);
    return true;
  }
  if (!b.gl) return false;
  const gl = b.gl;
  let retired: GlBinding["retiredTextures"];
  let changes: NativeChange[];
  let points: {owner: GlBinding; framebuffer: WebGLFramebuffer; point: number}[];
  let units: {bindings: (WebGLTexture|null)[]; unit: number}[];
  let captures: {unit: number; target: number; pname: number; previous: WebGLTexture|null}[];
  let natives: Set<WebGLTexture>;
  let hasFramebuffers = false;
  let active = 0, draw: WebGLFramebuffer|null = null, read: WebGLFramebuffer|null = null;
  try {
    retired = new Map(b.retiredTextures); points = []; units = []; changes = []; captures = [];
    natives = new Set([...objects].map(object => textureNative(b,object)));
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
        const before = imageAttachmentCall(b,0x8ca9,point,image);
        changes.push({apply: () => checkedGlCall(b, () => gl.bindFramebuffer(0x8ca9,framebuffer)) &&
            checkedGlCall(b, () => gl.framebufferTexture2D(0x8ca9,point,image.target,null,image.level)),
          restore:nativeInverse(b,[["bindFramebuffer",0x8ca9,framebuffer],before])});
      }
    }
    for (const unit of physicalUnits) for (const [target,pname] of [[0x0de1,0x8069],[0x8513,0x8514]])
      captures.push({unit,target,pname,previous:null});
  } catch { recordGlError(b,0x505); return false; }
  if (changes.length || captures.length) {
    if (!checkedGlCall(b, () => { active = Number(gl.getParameter(0x84e0)); })) return false;
    if (hasFramebuffers && (!checkedGlCall(b, () => { draw = gl.getParameter(0x8ca6); }) ||
        !checkedGlCall(b, () => { read = gl.getParameter(0x8caa); }))) return false;
    // Capturing a unit's native binding needs a selector mutation. Complete
    // that separate utility transaction before any attachment/binding detach,
    // so failure cannot discard already-accepted shared rollback actions.
    if (captures.length && !applyNativeChanges(b,[{apply: () => {
      for (const capture of captures) {
        if (!checkedGlCall(b, () => gl.activeTexture(0x84c0+capture.unit)) ||
            !checkedGlCall(b, () => { capture.previous = gl.getParameter(capture.pname); })) return false;
      }
      return true;
    },restore:nativeInverse(b)}],{shared:true,finalizer:nativeInverse(b,[["activeTexture",active]])})) return false;
    try {
      for (const {unit,target,previous} of captures) if (previous && natives.has(previous))
        changes.push({apply: () => checkedGlCall(b, () => gl.activeTexture(0x84c0+unit)) &&
            checkedGlCall(b, () => gl.bindTexture(target,null)),
          restore:nativeInverse(b,[["activeTexture",0x84c0+unit],["bindTexture",target,previous]])});
      const finalizer: NativeCall[][] = hasFramebuffers
        ? [[["bindFramebuffer",0x8ca9,draw]],[["bindFramebuffer",0x8ca8,read]]] : [];
      finalizer.push([["activeTexture",active]]);
      if (!applyNativeChanges(b,changes,{shared:true,finalizer:nativeInverse(b,...finalizer)})) return false;
    } catch { recordGlError(b,0x505); return false; }
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
