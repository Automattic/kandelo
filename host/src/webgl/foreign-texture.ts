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
import { importImageStorage, registerImageSource } from "./image-storage.js";
import { checkedGlCall, recordGlError } from "./program-objects.js";
import { applyNativeChanges, nativeInverse, repairNativeState, reserveNativeRetirement, retireNativeRetirement, transferNativeRetirement } from "./native-recovery.js";
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
  if (!repairNativeState(b.gl)) return -5;
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
  const candidate = reserveNativeRetirement(b,[["deleteTexture",null]]);
  if (!candidate) return -12;
  let object: WebGLTexture | null = null, published = false;
  try {
    if (!checkedGlCall(b, () => { object = b.gl!.createTexture(); candidate.calls[0][1] = object; }) || !object) {
      recordGlError(b,0x505); return -5;
    }
    b.textures.set(name, object);
    b.foreignTextureBos.set(object, bo);
    b.foreignTextures.set(bo, {tex:object,texId:name,w:gpu.w,h:gpu.h,scratch:null});
    let previous: WebGLTexture|null = null, active = 0;
    if (!checkedGlCall(b, () => { active = Number(b.gl!.getParameter(0x84e0)); }) ||
        !checkedGlCall(b, () => { previous = b.gl!.getParameter(0x8069); })) return -5;
    const initialized = applyNativeChanges(b,[{apply: () => {
      if (!checkedGlCall(b, () => b.gl!.bindTexture(GL_TEXTURE_2D,object))) return false;
      for (const [pname,value] of [[0x2801,0x2601],[0x2800,0x2601],[0x2802,0x812f],[0x2803,0x812f]])
        if (!checkedGlCall(b, () => b.gl!.texParameteri(GL_TEXTURE_2D,pname,value))) return false;
      return true;
    },restore:nativeInverse(b)}], {shared:true,finalizer:nativeInverse(b,
      [["activeTexture",active],["bindTexture",GL_TEXTURE_2D,previous]])});
    if (!initialized || !importImageStorage(b,1,name,token)) return -5;
    transferNativeRetirement(candidate); published = true; return name;
  } catch { recordGlError(b,0x505); return -12; }
  finally {
    if (!published) {
      if (object && b.textures.get(name) === object) b.textures.delete(name);
      if (object) b.foreignTextureBos.delete(object);
      if (b.foreignTextures.get(bo)?.tex === object) b.foreignTextures.delete(bo);
      retireNativeRetirement(candidate);
    }
  }
}

/** Selecting unit zero is itself journaled before querying its binding. The
 * nested plan reserves all unpack/texture inverses before the first upload
 * mutation. Repairs contain only native handles/scalars, never BO bytes. */
function withForeignUploadState(b: GlBinding, call: () => boolean): boolean {
  const gl = b.gl!;
  let active = 0, rowLength = 0, alignment = 0, skipRows = 0, skipPixels = 0;
  for (const capture of [
    () => { active = Number(gl.getParameter(gl.ACTIVE_TEXTURE)); },
    () => { rowLength = Number(gl.getParameter(GL_UNPACK_ROW_LENGTH)); },
    () => { alignment = Number(gl.getParameter(GL_UNPACK_ALIGNMENT)); },
    () => { skipRows = Number(gl.getParameter(0x0cf3)); },
    () => { skipPixels = Number(gl.getParameter(0x0cf4)); },
  ]) if (!checkedGlCall(b,capture)) return false;
  // Unpack state is physical and not all of it is replayed by the muxer. It
  // must be repaired even if the submitting logical context has retired.
  return applyNativeChanges(b,[{apply: () => {
    if (!checkedGlCall(b, () => gl.activeTexture(gl.TEXTURE0))) return false;
    let texture: WebGLTexture|null = null;
    if (!checkedGlCall(b, () => { texture = gl.getParameter(gl.TEXTURE_BINDING_2D); })) return false;
    return applyNativeChanges(b,[{apply:call,restore:nativeInverse(b)}],{shared:true,finalizer:nativeInverse(b,
      [["activeTexture",gl.TEXTURE0],["bindTexture",GL_TEXTURE_2D,texture]],
      [["pixelStorei",0x0cf3,skipRows]], [["pixelStorei",0x0cf4,skipPixels]],
      [["pixelStorei",GL_UNPACK_ROW_LENGTH,rowLength]], [["pixelStorei",GL_UNPACK_ALIGNMENT,alignment]])});
  },restore:nativeInverse(b)}],{shared:true,finalizer:nativeInverse(b,[["activeTexture",active]])});
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
  if (!repairNativeState(gl)) return -5;
  let entry = b.foreignTextures.get(bo_id);
  if (entry && b.textures.get(entry.texId) !== entry.tex) {
    try { b.retiredTextures.set(entry.tex, entry.texId); } catch { return -12; }
    b.foreignTextures.delete(bo_id); entry = undefined;
  }
  const isNew = !entry, realloc = !entry || entry.w !== dims.w || entry.h !== dims.h;
  const candidate = isNew ? reserveNativeRetirement(b,[["deleteTexture",null]]) : null;
  if (isNew && !candidate) return -12;
  let published = false;
  try {
    if (!entry) {
      const texId = allocateForeignName(b); if (texId <= 0) return texId;
      let tex: WebGLTexture | null = null;
      if (!checkedGlCall(b, () => { tex = gl.createTexture(); candidate!.calls[0][1] = tex; }) || !tex) { recordGlError(b,0x505); return -5; }
      entry = {tex,texId,w:dims.w,h:dims.h,scratch:null};
    }
    if (!entry.scratch || entry.scratch.byteLength !== need) entry.scratch = new Uint8Array(need);
    entry.scratch.set(boBytes.subarray(0,need));
    if (isNew) {
      b.textures.set(entry.texId,entry.tex); b.foreignTextureBos.set(entry.tex,bo_id); b.foreignTextures.set(bo_id,entry);
    }
    const accepted = withForeignUploadState(b, () => {
        for (const [pname,value] of [[GL_UNPACK_ROW_LENGTH,dims.stride/4],[GL_UNPACK_ALIGNMENT,4],[0x0cf3,0],[0x0cf4,0]])
          if (!checkedGlCall(b, () => gl.pixelStorei(pname,value))) return false;
        if (!checkedGlCall(b, () => gl.bindTexture(GL_TEXTURE_2D,entry!.tex))) return false;
        if (realloc) {
          for (const [pname,value] of [[gl.TEXTURE_MIN_FILTER,gl.LINEAR],[gl.TEXTURE_MAG_FILTER,gl.LINEAR],[gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE],[gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE]])
            if (!checkedGlCall(b, () => gl.texParameteri(GL_TEXTURE_2D,pname,value))) return false;
          return checkedGlCall(b, () => gl.texImage2D(GL_TEXTURE_2D,0,gl.RGBA,dims.w,dims.h,0,gl.RGBA,gl.UNSIGNED_BYTE,entry!.scratch!));
        }
        return checkedGlCall(b, () => gl.texSubImage2D(GL_TEXTURE_2D,0,0,0,dims.w,dims.h,gl.RGBA,gl.UNSIGNED_BYTE,entry!.scratch!));
    });
    if (!accepted) return -5;
    if (candidate) transferNativeRetirement(candidate);
    published = true;
    entry.w = dims.w; entry.h = dims.h; return entry.texId;
  } catch { recordGlError(b,0x505); return -5; }
  finally {
    if (isNew && !published) {
      if (entry && b.textures.get(entry.texId) === entry.tex) b.textures.delete(entry.texId);
      if (b.foreignTextures.get(bo_id) === entry) b.foreignTextures.delete(bo_id);
      if (entry) b.foreignTextureBos.delete(entry.tex);
      retireNativeRetirement(candidate!);
    }
  }
}
