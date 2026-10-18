/**
 * `DRM_IOCTL_WPK_BIND_FOREIGN_TEXTURE` upload path: (re)load a CPU-tier
 * bo's pixels into a `WebGLTexture` owned by the caller's GL binding.
 *
 * The bo's canonical pixel storage is the DRI registry's per-bo SAB, so
 * the upload happens entirely host-side — the guest never marshals
 * pixels through the 64 KB-capped cmdbuf TLV records. Callers refresh a
 * texture by re-invoking the ioctl after the producer commits; the
 * texture id is stable per (binding, bo).
 *
 * Bytes are DRM XRGB8888 (little-endian [B,G,R,X]) uploaded verbatim as
 * RGBA — consumers swizzle `.bgr` in their fragment shader, exactly like
 * the vblank pump's webgl2-scanout presenter.
 *
 * This runs OUTSIDE the submit-drain/muxer path, so everything it
 * touches on the shared context (active unit, unit-0 TEXTURE_2D binding,
 * unpack state) is saved and restored around the upload.
 */
import type { GlBinding } from "./registry.js";

const GL_TEXTURE_2D = 0x0de1;
const GL_UNPACK_ROW_LENGTH = 0x0cf2;
const GL_UNPACK_ALIGNMENT = 0x0cf5;

export function bindForeignTexture(
  b: GlBinding,
  bo_id: number,
  boBytes: Uint8Array,
  dims: { w: number; h: number; stride: number },
): number {
  const gl = b.gl;
  if (!gl) return -5; // EIO — no WebGL backing (headless host)
  if (dims.w <= 0 || dims.h <= 0 || dims.stride < dims.w * 4) return -22;

  let entry = b.foreignTextures.get(bo_id);
  const realloc = !entry || entry.w !== dims.w || entry.h !== dims.h;
  if (!entry) {
    const tex = gl.createTexture();
    if (!tex) return -5;
    entry = { tex, texId: b.nextForeignTexId++, w: dims.w, h: dims.h, scratch: null };
    b.foreignTextures.set(bo_id, entry);
    b.textures.set(entry.texId, entry.tex);
  }
  entry.w = dims.w;
  entry.h = dims.h;

  // Stage into a non-shared buffer — WebGL rejects SAB-backed views.
  // Upload rows at the bo stride via UNPACK_ROW_LENGTH instead of
  // repacking. WebGL2 needs ((h-1)*rowLength + w) * 4 bytes, which
  // stride*h always covers.
  const need = Math.min(dims.stride * dims.h, boBytes.byteLength);
  if (!entry.scratch || entry.scratch.byteLength !== need) {
    entry.scratch = new Uint8Array(need);
  }
  entry.scratch.set(boBytes.subarray(0, need));

  const prevActive = gl.getParameter(gl.ACTIVE_TEXTURE) as number;
  gl.activeTexture(gl.TEXTURE0);
  const prevTex = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
  // Row length isn't shadow-tracked (the muxer forwards OP_PIXEL_STOREI
  // raw), so query the live value to restore instead of assuming 0.
  const prevRowLen = gl.getParameter(GL_UNPACK_ROW_LENGTH) as number;
  gl.pixelStorei(GL_UNPACK_ROW_LENGTH, dims.stride >> 2);
  gl.pixelStorei(GL_UNPACK_ALIGNMENT, 4);
  gl.bindTexture(GL_TEXTURE_2D, entry.tex);
  if (realloc) {
    // Window-sized surfaces are drawn ~1:1 by the compositor; plain
    // bilinear, no mip chain.
    gl.texParameteri(GL_TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(GL_TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(GL_TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(GL_TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      GL_TEXTURE_2D, 0, gl.RGBA, dims.w, dims.h, 0,
      gl.RGBA, gl.UNSIGNED_BYTE, entry.scratch,
    );
  } else {
    gl.texSubImage2D(
      GL_TEXTURE_2D, 0, 0, 0, dims.w, dims.h,
      gl.RGBA, gl.UNSIGNED_BYTE, entry.scratch,
    );
  }
  gl.bindTexture(GL_TEXTURE_2D, prevTex);
  gl.pixelStorei(GL_UNPACK_ROW_LENGTH, prevRowLen);
  gl.pixelStorei(GL_UNPACK_ALIGNMENT, b.shadow.unpackAlignment);
  gl.activeTexture(prevActive);
  return entry.texId;
}
