/**
 * `DRM_IOCTL_WPK_BIND_FOREIGN_TEXTURE` upload path: (re)load a CPU-tier
 * bo's pixels into a `WebGLTexture` owned by the caller's GL binding.
 *
 * The bo's canonical pixel storage is the DRI registry's per-bo SAB, so
 * the upload happens entirely host-side — the guest never marshals
 * pixels through the 64 KB-capped cmdbuf TLV records. Callers refresh a
 * texture by re-invoking the ioctl after the producer commits; the
 * texture id is stable per (object group, bo) while its name is live.
 *
 * Bytes are DRM XRGB8888 (little-endian [B,G,R,X]) uploaded verbatim as
 * RGBA — consumers swizzle `.bgr` in their fragment shader, exactly like
 * the vblank pump's webgl2-scanout presenter.
 *
 * The caller selects the logical owner through the muxer. Upload utility
 * state (active unit, unit-0 TEXTURE_2D binding, unpack state) is saved and
 * restored so the upload does not become part of that owner's GL state.
 */
import { importImageStorage, registerImageSource, destroyTextureView } from "./image-storage.js";
import { checkedGlCall, recordGlError } from "./program-objects.js";
import type { GlBinding } from "./registry.js";

const GL_TEXTURE_2D = 0x0de1;
const GL_UNPACK_ROW_LENGTH = 0x0cf2;
const GL_UNPACK_ALIGNMENT = 0x0cf5;

/** Native numbers and pending C reservations are separate. Never overwrite a
 * realized GL name; C checks its reservations before adopting a candidate. */
function allocateForeignName(b: GlBinding, preferred = b.nextForeignTexId): number {
  let name = Math.max(preferred, b.nextForeignTexId);
  while (name <= 0x7fffffff && b.textures.has(name)) name++;
  if (name > 0x7fffffff) return -12;
  b.nextForeignTexId = name + 1;
  return name;
}

/** The BO owns canonical GPU pixels; its public names own distinct logical
 * views, so delete/reimport and respecification cannot recycle its identity. */
export function bindGpuForeignTexture(b: GlBinding, bo: number,
    gpu: {tex: WebGLTexture; texId: number; w: number; h: number}): number {
  if (!b.gl) return -5;
  let entry = b.foreignTextures.get(bo);
  if (entry && b.textures.get(entry.texId) !== entry.tex) {
    try { b.retiredTextures.set(entry.tex, entry.texId); }
    catch { return -12; }
    b.foreignTextures.delete(bo); entry = undefined;
  }
  const token = registerImageSource(b, bo, gpu.tex, gpu.w, gpu.h);
  if (token <= 0) return token;
  if (entry) {
    if (b.textureViews.get(entry.tex)?.source?.token === token) return entry.texId;
    return importImageStorage(b, 1, entry.texId, token) ? entry.texId : -5;
  }
  const name = allocateForeignName(b, gpu.texId);
  if (name <= 0) return name;
  let object: WebGLTexture | null = null;
  if (!checkedGlCall(b, () => { object = b.gl!.createTexture(); }) || !object) {
    if (object) b.gl.deleteTexture(object);
    recordGlError(b,0x505); return -5;
  }
  try {
    b.textures.set(name, object);
    b.foreignTextureBos.set(object, bo);
    b.foreignTextures.set(bo, {tex:object,texId:name,w:gpu.w,h:gpu.h,scratch:null});
  } catch {
    b.textures.delete(name); b.foreignTextureBos.delete(object); b.foreignTextures.delete(bo);
    b.gl.deleteTexture(object); return -12;
  }
  let previous: WebGLTexture|null = null, captured = false, initialized = false, restored = true;
  try {
    if (checkedGlCall(b, () => { previous = b.gl!.getParameter(0x8069); captured = true; }) &&
        checkedGlCall(b, () => b.gl!.bindTexture(0x0de1,object))) {
      initialized = true;
      for (const [pname,value] of [[0x2801,0x2601],[0x2800,0x2601],[0x2802,0x812f],[0x2803,0x812f]])
        if (!checkedGlCall(b, () => b.gl!.texParameteri(0x0de1,pname,value))) { initialized = false; break; }
    }
  } finally { if (captured) restored = checkedGlCall(b, () => b.gl!.bindTexture(0x0de1,previous)); }
  if (initialized && restored && importImageStorage(b,1,name,token)) return name;
  b.textures.delete(name); b.foreignTextures.delete(bo); destroyTextureView(b,object);
  return -5;
}

export function bindForeignTexture(
  b: GlBinding, bo_id: number, boBytes: Uint8Array,
  dims: { w: number; h: number; stride: number },
): number {
  const gl = b.gl;
  if (!gl) return -5;
  if (![dims.w, dims.h, dims.stride].every(Number.isSafeInteger)
    || dims.w <= 0 || dims.h <= 0 || dims.stride < dims.w * 4 || dims.stride % 4 !== 0) return -22;
  const need = (dims.h - 1) * dims.stride + dims.w * 4;
  if (!Number.isSafeInteger(need) || need > boBytes.byteLength) return -22;
  let entry = b.foreignTextures.get(bo_id);
  if (entry && b.textures.get(entry.texId) !== entry.tex) {
    try { b.retiredTextures.set(entry.tex, entry.texId); } catch { return -12; }
    b.foreignTextures.delete(bo_id); entry = undefined;
  }
  const isNew = !entry, realloc = !entry || entry.w !== dims.w || entry.h !== dims.h;
  let staged = false, accepted = false, restored = true;
  let prevActive = 0, prevTex: WebGLTexture | null = null;
  let prevRowLen = 0, prevAlignment = 0, prevSkipRows = 0, prevSkipPixels = 0;
  try {
    if (!entry) {
      const texId = allocateForeignName(b); if (texId <= 0) return texId;
      let tex: WebGLTexture | null = null;
      if (!checkedGlCall(b, () => { tex = gl.createTexture(); }) || !tex) { if (tex) gl.deleteTexture(tex); recordGlError(b,0x505); return -5; }
      entry = {tex,texId,w:dims.w,h:dims.h,scratch:null};
    }
    if (!entry.scratch || entry.scratch.byteLength !== need) entry.scratch = new Uint8Array(need);
    entry.scratch.set(boBytes.subarray(0,need));
    if (isNew) {
      b.textures.set(entry.texId,entry.tex); b.foreignTextureBos.set(entry.tex,bo_id); b.foreignTextures.set(bo_id,entry);
      staged = true;
    }
    if (!checkedGlCall(b, () => {
      prevActive = Number(gl.getParameter(gl.ACTIVE_TEXTURE));
      prevRowLen = Number(gl.getParameter(GL_UNPACK_ROW_LENGTH));
      prevAlignment = Number(gl.getParameter(GL_UNPACK_ALIGNMENT));
      prevSkipRows = Number(gl.getParameter(0x0cf3)); prevSkipPixels = Number(gl.getParameter(0x0cf4));
    })) return -5;
    if (!checkedGlCall(b, () => gl.activeTexture(gl.TEXTURE0))) return -5;
    try {
      if (!checkedGlCall(b, () => { prevTex = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null; })) return -5;
      try {
        for (const [pname,value] of [[GL_UNPACK_ROW_LENGTH,dims.stride/4],[GL_UNPACK_ALIGNMENT,4],[0x0cf3,0],[0x0cf4,0]])
          if (!checkedGlCall(b, () => gl.pixelStorei(pname,value))) return -5;
        if (!checkedGlCall(b, () => gl.bindTexture(GL_TEXTURE_2D,entry!.tex))) return -5;
        if (realloc) {
          for (const [pname,value] of [[gl.TEXTURE_MIN_FILTER,gl.LINEAR],[gl.TEXTURE_MAG_FILTER,gl.LINEAR],[gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE],[gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE]])
            if (!checkedGlCall(b, () => gl.texParameteri(GL_TEXTURE_2D,pname,value))) return -5;
          accepted = checkedGlCall(b, () => gl.texImage2D(GL_TEXTURE_2D,0,gl.RGBA,dims.w,dims.h,0,gl.RGBA,gl.UNSIGNED_BYTE,entry!.scratch!));
        } else accepted = checkedGlCall(b, () => gl.texSubImage2D(GL_TEXTURE_2D,0,0,0,dims.w,dims.h,gl.RGBA,gl.UNSIGNED_BYTE,entry!.scratch!));
      } finally {
        restored = checkedGlCall(b, () => gl.bindTexture(GL_TEXTURE_2D,prevTex));
        for (const [pname,value] of [[0x0cf3,prevSkipRows],[0x0cf4,prevSkipPixels],[GL_UNPACK_ROW_LENGTH,prevRowLen],[GL_UNPACK_ALIGNMENT,prevAlignment]])
          restored = checkedGlCall(b, () => gl.pixelStorei(pname,value)) && restored;
      }
    } finally { restored = checkedGlCall(b, () => gl.activeTexture(prevActive)) && restored; }
    if (!accepted || !restored) return -5;
    entry.w = dims.w; entry.h = dims.h; return entry.texId;
  } catch { recordGlError(b,0x505); return -5; }
  finally {
    if (isNew && entry && (!accepted || !restored)) {
      if (staged || b.textures.get(entry.texId) === entry.tex) b.textures.delete(entry.texId);
      if (b.foreignTextures.get(bo_id) === entry) b.foreignTextures.delete(bo_id);
      b.foreignTextureBos.delete(entry.tex); gl.deleteTexture(entry.tex);
    }
  }
}
