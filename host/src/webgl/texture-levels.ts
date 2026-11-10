/** Accepted texture image specifications, keyed by logical texture identity.
 *
 * WebGL 2 has no glGetTexLevelParameter, yet EGL image creation (EGL 1.5
 * section 3.9.1) must know whether a level exists, its extent and format,
 * and whether the texture is complete. The host records each image only
 * after the renderer accepted the call that specified it, so this is the
 * object's actual state rather than what a client asked for. */
import type { GlBinding } from "./registry.js";
import { framebufferInputsChanged } from "./framebuffer-revision.js";

export type GlTextureLevel = {
  width: number;
  height: number;
  /** Native WebGL 2 storage triple. */
  internalFormat: number;
  format: number;
  type: number;
  compressed: boolean;
  /** The guest's GLES 2 specification. Absent for storage the guest did not
   * specify (an imported EGLImage or foreign buffer), whose format the native
   * renderer alone describes. */
  gles?: GlesLevelFormat;
};

/** GLES 2 view of a level. `type` uses WebGL's HALF_FLOAT for
 * HALF_FLOAT_OES. `expanded` marks a LUMINANCE/ALPHA float level stored as
 * RGBA (luminance-float.ts); `colorRenderable` is section 4.4.5 under the
 * advertised extensions (es2-formats.ts), which WebGL 2 does not apply.
 * `depth` and `stencil` mark DEPTH_COMPONENT (OES_depth_texture) and
 * DEPTH_STENCIL_OES (OES_packed_depth_stencil) levels, which are exactly the
 * depth-renderable and stencil-renderable texture levels; their sampling
 * as (d,d,d,1) is not yet emulated (WebGL 2 returns (d,0,0,1)). */
export type GlesLevelFormat = {
  internalFormat: number;
  format: number;
  type: number;
  expanded: boolean;
  /** undefined: the extension leaves renderability to the renderer. */
  colorRenderable: boolean | undefined;
  depth: boolean;
  stencil: boolean;
};

const TEX = 0x0de1, CUBE = 0x8513, FACE0 = 0x8515;
// GLES DEPTH_COMPONENT and DEPTH_STENCIL_OES, plus the sized forms a native
// level may carry when the guest did not specify it.
const DEPTH_FORMATS = new Set([0x1902, 0x84f9, 0x81a5, 0x81a6, 0x81a7, 0x8cac, 0x88f0, 0x8cad]);

/** A level that samples as depth (OES_depth_texture, OES_packed_depth_stencil). */
export function levelSamplesDepth(level: GlTextureLevel | undefined): boolean {
  return level !== undefined && DEPTH_FORMATS.has(level.gles?.internalFormat ?? level.internalFormat);
}

/** Depth sampling (depth-sampling.ts) depends on whether level 0 of a 2D
 * texture, or of a cube map's first face, is a depth image, and ES 2.0's
 * switch-over point (lod-switchover.ts) on a texture's filters. This
 * revision advances whenever either changes for any texture (or a context
 * gains a texture zero), so the per-context counts of units holding such
 * textures stay exact without rescanning units on every draw. */
let depthRevision = 0;
export function depthLevelRevision(): number {
  return depthRevision;
}
export function samplingTraitsChanged(): void {
  depthRevision++;
}
function samplesDepthAt(faces: Faces | undefined, face: number): boolean {
  return levelSamplesDepth(faces?.get(face)?.get(0));
}
export const CUBE_FACES = [0x8515, 0x8516, 0x8517, 0x8518, 0x8519, 0x851a] as const;

type Faces = Map<number, Map<number, GlTextureLevel>>;
const levels = new WeakMap<WebGLTexture, Faces>();

/** The logical texture an image call addresses on the active unit: the
 * bound object, or the context's texture zero for that target. */
export function boundTextureObject(b: GlBinding, target: number): WebGLTexture | null {
  const base = target === TEX ? TEX : target === CUBE || isCubeFace(target) ? CUBE : 0;
  if (!base) return null;
  const units = base === TEX ? b.shadow.textureUnits : b.shadow.cubeTextureUnits;
  return units[b.shadow.activeTexture] ?? b.shadow.defaultTextures.get(base) ?? null;
}

export function isCubeFace(target: number): boolean {
  return target >= FACE0 && target <= FACE0 + 5;
}

export function textureLevel(object: WebGLTexture, face: number, level: number): GlTextureLevel | undefined {
  return levels.get(object)?.get(face)?.get(level);
}

export function textureFaces(object: WebGLTexture): ReadonlyMap<number, ReadonlyMap<number, GlTextureLevel>> {
  return levels.get(object) ?? new Map();
}

/** A zero-sized image specifies no image (ES 2.0 section 3.7.1). */
export function recordTextureLevel(object: WebGLTexture | null | undefined, face: number, level: number,
  spec: GlTextureLevel): void {
  if (!object || level < 0) return;
  let faces = levels.get(object);
  if (!faces) levels.set(object, faces = new Map());
  let face_levels = faces.get(face);
  if (!face_levels) faces.set(face, face_levels = new Map());
  const depthBefore = level === 0 && levelSamplesDepth(face_levels.get(0));
  if (spec.width === 0 || spec.height === 0) face_levels.delete(level);
  else face_levels.set(level, spec);
  if (level === 0 && depthBefore !== levelSamplesDepth(face_levels.get(0))) depthRevision++;
  framebufferInputsChanged();
}

/** Install the complete image set an object has after its storage changed
 * wholesale (becoming an EGLImage target defines exactly level 0). */
export function replaceTextureLevels(object: WebGLTexture, face: number, base: GlTextureLevel | null): void {
  const faces: Faces = new Map(), old = levels.get(object);
  if (base) faces.set(face, new Map([[0, base]]));
  levels.set(object, faces);
  if (samplesDepthAt(old, TEX) !== samplesDepthAt(faces, TEX) || samplesDepthAt(old, FACE0) !== samplesDepthAt(faces, FACE0))
    depthRevision++;
  framebufferInputsChanged();
}

/** glGenerateMipmap derives every level below the base from the base image. */
export function recordGeneratedMipmaps(object: WebGLTexture | null | undefined, target: number): void {
  if (!object) return;
  for (const face of target === CUBE ? CUBE_FACES : target === TEX ? [TEX] : []) {
    const base = textureLevel(object, face, 0);
    if (!base || base.compressed) continue;
    let width = base.width, height = base.height;
    for (let level = 1; width > 1 || height > 1; level++) {
      width = Math.max(1, width >> 1); height = Math.max(1, height >> 1);
      recordTextureLevel(object, face, level, {...base, width, height});
    }
  }
}

function sameFormat(a: GlTextureLevel, b: GlTextureLevel): boolean {
  return a.internalFormat === b.internalFormat && a.format === b.format && a.type === b.type
    && a.compressed === b.compressed;
}

/** Mipmap completeness for one face (ES 2.0 section 3.7.10), given the
 * face's base image and whether minification uses mipmaps. */
function faceComplete(face: ReadonlyMap<number, GlTextureLevel> | undefined, mipmapped: boolean): boolean {
  const base = face?.get(0);
  if (!base) return false;
  if (!mipmapped) return true;
  let width = base.width, height = base.height;
  for (let level = 1; width > 1 || height > 1; level++) {
    width = Math.max(1, width >> 1); height = Math.max(1, height >> 1);
    const image = face!.get(level);
    if (!image || image.width !== width || image.height !== height || !sameFormat(image, base)) return false;
  }
  return true;
}

/** Texture completeness for a 2D or cube-map texture. `minFilter` is the
 * texture's TEXTURE_MIN_FILTER; NEAREST (0x2600) and LINEAR (0x2601) use
 * only the base level. Cube maps also need six equal square base images. */
export function textureComplete(object: WebGLTexture, cube: boolean, minFilter: number): boolean {
  const mipmapped = minFilter !== 0x2600 && minFilter !== 0x2601;
  const faces = levels.get(object);
  if (!cube) return faceComplete(faces?.get(TEX), mipmapped);
  const first = faces?.get(CUBE_FACES[0])?.get(0);
  if (!first || first.width !== first.height) return false;
  return CUBE_FACES.every(face => {
    const base = faces?.get(face)?.get(0);
    return !!base && base.width === first.width && base.height === first.height && sameFormat(base, first)
      && faceComplete(faces?.get(face), mipmapped);
  });
}
