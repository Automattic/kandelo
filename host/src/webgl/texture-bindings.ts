import type { GlTextureView } from "./image-storage.js";
import type { GlBinding } from "./registry.js";
import type { GlShadowState } from "./shadow.js";
import { checkedGlCall, recordGlError } from "./program-objects.js";
import { combinedTextureUnits } from "./limits.js";

export function validGlesTextureParameter(pname: number): boolean {
  return pname >= 0x2800 && pname <= 0x2803;
}

/** Null in the logical binding table means GLES's context-owned texture
 * zero. Its native stand-in must never enter the shared name namespace. */
export function nativeTextureBinding(s: GlShadowState, target: number, unit: number, views?:Map<WebGLTexture,GlTextureView>): WebGLTexture | null {
  const units = target === 0x0de1 ? s.textureUnits : s.cubeTextureUnits;
  const object=units[unit] ?? s.defaultTextures.get(target) ?? null;
  return object ? views?.get(object)?.native ?? object : null;
}

/** Materialize a default object only when its storage/parameters are used.
 * A default texture is shared by all units of this context, including units
 * the guest has never selected; it is not shared by EGL share-group peers. */
function createDefaultTexture(b: GlBinding, target: number): boolean {
  const gl = b.gl!, s = b.shadow;
  if (s.defaultTextures.has(target)) return true;
  let texture: WebGLTexture | null = null, count = 0;
  if (!checkedGlCall(b, () => { count = combinedTextureUnits(gl); texture = gl.createTexture(); })) {
    if (texture) gl.deleteTexture(texture); return false;
  }
  if (!texture || count <= 0) {
    if (texture) gl.deleteTexture(texture);
    recordGlError(b,texture ? 0x502 : 0x505); return false;
  }
  const units = target === 0x0de1 ? s.textureUnits : s.cubeTextureUnits;
  const changed: number[] = [];
  let accepted = false;
  try {
    for (let unit=0; unit<count; unit++) {
      if (units[unit]) continue;
      if (!checkedGlCall(b, () => gl.activeTexture(0x84c0+unit))) return false;
      changed.push(unit);
      if (!checkedGlCall(b, () => gl.bindTexture(target,texture))) return false;
    }
    if (!checkedGlCall(b, () => gl.activeTexture(0x84c0+s.activeTexture))) return false;
    s.defaultTextures.set(target,texture);
    accepted = true; return true;
  } finally {
    if (!accepted) {
      for (const unit of changed) {
        if (checkedGlCall(b, () => gl.activeTexture(0x84c0+unit))) checkedGlCall(b, () => gl.bindTexture(target,null));
      }
      checkedGlCall(b, () => gl.activeTexture(0x84c0+s.activeTexture));
      gl.deleteTexture(texture);
    }
  }
}

/** Image operations address a 2D target or a cube face; sampler operations
 * address a 2D or cube target. Reject other APIs before materializing zero. */
export function prepareTextureOperation(b: GlBinding, target: number, image = false): boolean {
  const base = target === 0x0de1 ? target
    : image ? (target >= 0x8515 && target <= 0x851a ? 0x8513 : 0)
    : target === 0x8513 ? target : 0;
  if (!base) { recordGlError(b,0x500); return false; }
  const units = base === 0x0de1 ? b.shadow.textureUnits : b.shadow.cubeTextureUnits;
  return !!units[b.shadow.activeTexture] || createDefaultTexture(b,base);
}
