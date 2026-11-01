/** Accepted texture image specifications, keyed by logical texture identity.
 *
 * WebGL 2 has no glGetTexLevelParameter, yet EGL image creation (EGL 1.5
 * section 3.9.1) must know whether a level exists, its extent and format,
 * and whether the texture is complete. The host records each image only
 * after the renderer accepted the call that specified it, so this is the
 * object's actual state rather than what a client asked for. */
export type GlTextureLevel = {
  width: number;
  height: number;
  internalFormat: number;
  format: number;
  type: number;
  compressed: boolean;
};

const TEX = 0x0de1, CUBE = 0x8513, FACE0 = 0x8515;
export const CUBE_FACES = [0x8515, 0x8516, 0x8517, 0x8518, 0x8519, 0x851a] as const;

type Faces = Map<number, Map<number, GlTextureLevel>>;
const levels = new WeakMap<WebGLTexture, Faces>();

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
  if (spec.width === 0 || spec.height === 0) face_levels.delete(level);
  else face_levels.set(level, spec);
}

/** Install the complete image set an object has after its storage changed
 * wholesale (becoming an EGLImage target defines exactly level 0). */
export function replaceTextureLevels(object: WebGLTexture, face: number, base: GlTextureLevel | null): void {
  const faces: Faces = new Map();
  if (base) faces.set(face, new Map([[0, base]]));
  levels.set(object, faces);
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
