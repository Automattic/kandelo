import { textureNative, renderbufferNative } from "./image-storage.js";
import type { GlBinding } from "./registry.js";
import { checkedGlCall, recordGlError } from "./program-objects.js";

/** The queued and acknowledged paths share realization and native acceptance.
 * Failed candidates are removed before return and never replace a shadow binding. */
export function bindImageObject(b: GlBinding, kind: number, target: number, name: number): boolean {
  const gl = b.gl;
  if (!gl) return false;
  if (kind === 1) {
    if (target !== 0x0de1 && target !== 0x8513) { recordGlError(b,0x500); return false; }
    let texture = name ? b.textures.get(name) ?? null : b.shadow.defaultTextures.get(target) ?? null;
    const allocate = name !== 0 && texture === null;
    if (allocate && (!checkedGlCall(b, () => { texture = gl.createTexture(); }) || !texture)) {
      if (texture) gl.deleteTexture(texture);
      recordGlError(b,0x505); return false;
    }
    // Reserve namespace bookkeeping before the native mutation. This call is
    // synchronous; a rejected bind removes the unpublished candidate again.
    if (allocate && texture) {
      try { b.textures.set(name,texture); }
      catch { gl.deleteTexture(texture); recordGlError(b,0x505); return false; }
    }
    if (!checkedGlCall(b, () => gl.bindTexture(target,texture ? textureNative(b,texture) : null))) {
      if (allocate && texture) { b.textures.delete(name); gl.deleteTexture(texture); }
      return false;
    }
    const units = target === 0x0de1 ? b.shadow.textureUnits : b.shadow.cubeTextureUnits;
    const unit = b.shadow.activeTexture;
    if (unit >= 0 && unit < units.length) units[unit] = name ? texture : null;
    return true;
  }
  if (kind === 2) {
    if (target !== 0x8d41) { recordGlError(b,0x500); return false; }
    let renderbuffer = b.rbos.get(name) ?? null;
    const allocate = name !== 0 && !renderbuffer;
    if (allocate && (!checkedGlCall(b, () => { renderbuffer = gl.createRenderbuffer(); }) || !renderbuffer)) {
      if (renderbuffer) gl.deleteRenderbuffer(renderbuffer);
      recordGlError(b,0x505); return false;
    }
    if (allocate && renderbuffer) {
      try { b.rbos.set(name,renderbuffer); }
      catch { gl.deleteRenderbuffer(renderbuffer); recordGlError(b,0x505); return false; }
    }
    if (!checkedGlCall(b, () => gl.bindRenderbuffer(target,renderbuffer ? renderbufferNative(b,renderbuffer) : null))) {
      if (allocate && renderbuffer) { b.rbos.delete(name); gl.deleteRenderbuffer(renderbuffer); }
      return false;
    }
    b.shadow.renderbuffer = renderbuffer;
    return true;
  }
  recordGlError(b,0x500);
  return false;
}
