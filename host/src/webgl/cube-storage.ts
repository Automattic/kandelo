/**
 * OpenGL ES 2.0 cube-map textures stored as six-layer 2D array textures.
 *
 * Why. ES 2.0 sections 3.7.5 and 3.7.7 sample a cube map one face at a time:
 * the major axis of the direction selects a face, and the face's (s, t) are
 * wrapped and filtered within that face alone. WebGL 2 follows ES 3.0
 * section 3.8.9.1 instead, where cube-map sampling is always seamless:
 * linear filtering near an edge mixes texels of the adjacent face, and no
 * WebGL state turns that off (reproduced without Kandelo code in Chromium,
 * Firefox and WebKit). Software written for ES 2.0, and dEQP-GLES2's
 * references, see different colours at every face edge. So a guest cube
 * map is a native TEXTURE_2D_ARRAY of six layers (layer i holds face
 * TEXTURE_CUBE_MAP_POSITIVE_X + i), each layer wrapped and filtered by
 * itself exactly as ES 2.0 samples a face, and shaders that sample a
 * samplerCube are compiled as ESSL 3.00 with the face selection of ES 2.0
 * table 3.21 and explicit gradients (essl3-translation.ts). Programs that
 * sample no cube map, and every texture that is not a cube map, are not
 * involved: they keep their native storage and pay nothing.
 *
 * Layout. A 2D array level has one size and format for all six layers,
 * while ES 2.0 lets each face of a level have its own (the cube is then
 * merely incomplete, and every face image stays an image that can be
 * attached, copied from or updated). Each cube therefore owns one or more
 * native arrays ("storages"); every specified face image lives in exactly
 * one of them at its own layer and level. Images of one size and format
 * gather in one storage, so a cube specified in the usual ways (six faces
 * per level, any order; GenerateMipmap; respecifying all faces at a new
 * size) has all its images in one storage. A face respecified to another
 * size or format while its siblings keep theirs moves to a second storage
 * instead of destroying their contents. When the faces again agree, the
 * images that make the cube complete are gathered into the storage that
 * holds the base level, by copying through a framebuffer only if they are
 * spread out (a format that cannot be attached to a framebuffer then fails
 * with OUT_OF_MEMORY, as orphaning a linked EGLImage source does).
 *
 * The storage a draw samples is the one holding all six base images, and
 * only while the cube is complete under ES 2.0 rules (texture-levels.ts):
 * an array allocates all six layers of a level at once, so its native
 * completeness alone would accept a cube whose faces are not all
 * specified. A draw of a program with samplerCube uniforms binds that
 * storage, or no texture for an incomplete cube, to the unit's
 * TEXTURE_2D_ARRAY (external-texture.ts, draw-state.ts) only when it differs
 * from the unit's guest binding, so a complete cube in its first storage
 * costs no native call per draw.
 */
import type { GlBinding } from "./registry.js";
import { checkedGlCall, recordGlError } from "./program-objects.js";
import { applyNativeChanges, nativeInverse, reserveNativeRetirement, retireNativeRetirement, rethrowNativeGlFault,
  type NativeChange } from "./native-recovery.js";
import { noteStorageWrite } from "./image-writes.js";
import { framebufferInputsChanged, framebufferInputsRevision } from "./framebuffer-revision.js";
import { recordTextureLevel, textureComplete, textureLevel, type GlTextureLevel } from "./texture-levels.js";

export const TEXTURE_2D_ARRAY = 0x8c1a;
export const TEXTURE_BINDING_2D_ARRAY = 0x8c1d;
const CUBE = 0x8513, FACE0 = 0x8515, DRAW = 0x8ca9, READ = 0x8ca8, COLOR0 = 0x8ce0;
const MIN_FILTER = 0x2801;

/** Native storage shape of one face image: square, so one size. */
export type CubeImageShape = { size: number; internalFormat: number; format: number; type: number; compressed: boolean };
type Storage = { texture: WebGLTexture; levels: Map<number, CubeImageShape> };
type CubeStore = {
  /** The object's own native texture, which guest binds name on units. */
  own: WebGLTexture;
  /** storages[0] holds images never specified (for attachments) and is
   * `own` until an orphaned EGLImage takes `own` (orphanCubeStorage). */
  storages: Storage[];
  /** Where each specified face image lives, by cellKey(layer, level). */
  cells: Map<number, Storage>;
  /** Accepted TexParameter values, applied to every storage. */
  params: Map<number, number>;
  minFilter: number;
  revision: number;
  sampled?: { revision: number; inputs: number; texture: WebGLTexture | null };
};
const stores = new WeakMap<WebGLTexture, CubeStore>();
const cellKey = (layer: number, level: number) => level * 6 + layer;
const sameShape = (a: CubeImageShape | undefined, b: CubeImageShape) => !!a && a.size === b.size
  && a.internalFormat === b.internalFormat && a.format === b.format && a.type === b.type && a.compressed === b.compressed;

export function cubeFaceLayer(face: number): number {
  return face - FACE0;
}

/** The shape a recorded face image has natively. */
export function cubeShapeOf(level: GlTextureLevel): CubeImageShape {
  return { size: level.width, internalFormat: level.internalFormat, format: level.format, type: level.type, compressed: level.compressed };
}

/** A texture object becomes a cube map at its first accepted cube bind
 * (and a context's texture zero for TEXTURE_CUBE_MAP when it is made);
 * `native` is the 2D array texture that bind fixed. */
export function registerCubeTexture(object: WebGLTexture, native: WebGLTexture): void {
  if (!stores.has(object))
    stores.set(object, { own: native, storages: [{ texture: native, levels: new Map() }], cells: new Map(), params: new Map(),
      minFilter: 0x2702, revision: 0 });
}

export function isCubeTexture(object: WebGLTexture | null | undefined): boolean {
  return !!object && stores.has(object);
}

/** The native texture holding face `face` at `level`, or the cube's first
 * storage for an image that was never specified (an attachment of it is
 * incomplete, image-sizes.ts). Undefined for an object that is no cube. */
export function cubeImageTexture(object: WebGLTexture, face: number, level: number): WebGLTexture | undefined {
  const store = stores.get(object);
  return store && (store.cells.get(cellKey(cubeFaceLayer(face), level)) ?? store.storages[0]).texture;
}

/** The textures a cube owns besides its object's own native texture (which
 * its object's deletion retires). */
export function cubeExtraTextures(object: WebGLTexture): WebGLTexture[] {
  const store = stores.get(object);
  return store ? store.storages.filter(storage => storage.texture !== store.own).map(storage => storage.texture) : [];
}

export function forgetCubeTexture(object: WebGLTexture): void {
  stores.delete(object);
}

/** The cube texture an image command on the active unit addresses. */
function boundCube(b: GlBinding): { object: WebGLTexture; store: CubeStore } | null {
  const s = b.shadow, object = s.cubeTextureUnits[s.activeTexture] ?? s.defaultTextures.get(CUBE) ?? null;
  const store = object ? stores.get(object) : undefined;
  return object && store ? { object, store } : null;
}

/** The unit's guest cube binding as the native texture bound to its
 * TEXTURE_2D_ARRAY (texture-bindings.ts nativeTextureBinding). */
function guestArrayBinding(b: GlBinding, unit: number): WebGLTexture | null {
  const s = b.shadow, object = s.cubeTextureUnits[unit] ?? s.defaultTextures.get(CUBE) ?? null;
  return object ? b.textureViews.get(object)?.native ?? object : null;
}

/** Run `work` with `texture` bound to the active unit's TEXTURE_2D_ARRAY,
 * then restore the unit's guest binding. Native errors are the guest's. */
function withArray(b: GlBinding, texture: WebGLTexture, work: () => void): boolean {
  const gl = b.gl!, guest = guestArrayBinding(b, b.shadow.activeTexture);
  const accepted = checkedGlCall(b, () => { gl.bindTexture(TEXTURE_2D_ARRAY, texture); work(); });
  return checkedGlCall(b, () => gl.bindTexture(TEXTURE_2D_ARRAY, guest)) && accepted;
}

function residents(store: CubeStore, storage: Storage, level: number, except = -1): number {
  let count = 0;
  for (let layer = 0; layer < 6; layer++)
    if (layer !== except && store.cells.get(cellKey(layer, level)) === storage) count++;
  return count;
}

function allocate(b: GlBinding, storage: Storage, level: number, shape: CubeImageShape, bytes?: number): boolean {
  const gl = b.gl!;
  const accepted = withArray(b, storage.texture, () => {
    if (shape.compressed)
      gl.compressedTexImage3D(TEXTURE_2D_ARRAY, level, shape.internalFormat, shape.size, shape.size, 6, 0, new Uint8Array((bytes ?? 0) * 6));
    else gl.texImage3D(TEXTURE_2D_ARRAY, level, shape.internalFormat, shape.size, shape.size, 6, 0, shape.format, shape.type, null);
  });
  if (accepted) storage.levels.set(level, shape);
  return accepted;
}

function createStorage(b: GlBinding, store: CubeStore): Storage | null {
  const gl = b.gl!;
  let texture: WebGLTexture | null = null;
  if (!checkedGlCall(b, () => { texture = gl.createTexture(); }) || !texture) {
    if (!texture) recordGlError(b, 0x505);
    return null;
  }
  const created = texture as WebGLTexture;
  // The same sampling state as the cube's other storages.
  if (!withArray(b, created, () => { for (const [pname, value] of store.params) gl.texParameteri(TEXTURE_2D_ARRAY, pname, value); })) {
    deleteTextures(b, [created]);
    return null;
  }
  const storage = { texture: created, levels: new Map<number, CubeImageShape>() };
  store.storages.push(storage);
  return storage;
}

function deleteTextures(b: GlBinding, textures: WebGLTexture[]): void {
  if (!textures.length) return;
  const retirement = reserveNativeRetirement(b, textures.map(texture => ["deleteTexture", texture] as ["deleteTexture", WebGLTexture]));
  if (retirement) retireNativeRetirement(retirement);
}

/**
 * The storage a face image of `shape` at `level` goes to, and whether that
 * level must be (re)allocated there. In order: where the image already is,
 * if that level has its shape; a storage whose level already has siblings
 * of this shape; a storage whose level is unallocated, of this shape, or
 * holds no other face image (preferring the one holding this face's other
 * levels, then the first); otherwise a new storage. A level that still
 * holds this face's previous image is reallocated in place only when
 * `inPlace` (an upload cannot fail once its storage accepted the format;
 * a copy can, and must then leave the old image as it was).
 */
function place(b: GlBinding, store: CubeStore, layer: number, level: number, shape: CubeImageShape,
  inPlace: boolean): { storage: Storage; allocate: boolean; created: boolean } | null {
  const current = store.cells.get(cellKey(layer, level));
  if (current && sameShape(current.levels.get(level), shape)) return { storage: current, allocate: false, created: false };
  const siblings = store.storages.filter(storage => sameShape(storage.levels.get(level), shape) && residents(store, storage, level, layer) > 0)
    .sort((x, y) => residents(store, y, level, layer) - residents(store, x, level, layer));
  if (siblings.length) return { storage: siblings[0], allocate: false, created: false };
  const usable = (storage: Storage) => {
    const at = storage.levels.get(level);
    if (!at || sameShape(at, shape)) return true;
    return residents(store, storage, level, layer) === 0 && (storage !== current || inPlace);
  };
  const ownsFace = (storage: Storage) => [...store.cells].some(([key, at]) => at === storage && key % 6 === layer);
  const ordered = [...store.storages.filter(ownsFace), ...store.storages];
  const chosen = ordered.find(usable);
  if (chosen) return { storage: chosen, allocate: !sameShape(chosen.levels.get(level), shape), created: false };
  const created = createStorage(b, store);
  return created ? { storage: created, allocate: true, created: true } : null;
}

/** Re-attach every framebuffer attachment of (object, face, level) to the
 * storage now holding it, in every context of the share group. */
function retargetAttachments(b: GlBinding, object: WebGLTexture, face: number, level: number, from: WebGLTexture, to: WebGLTexture): boolean {
  if (from === to) return true;
  const gl = b.gl!, layer = cubeFaceLayer(face), changes: NativeChange[] = [];
  for (const member of b.objects.members) for (const [framebuffer, points] of member.framebufferAttachments)
    for (const [point, image] of points) {
      if (image.kind !== "texture" || image.object !== object || image.target !== face || image.level !== level) continue;
      changes.push({ apply: () => checkedGlCall(b, () => {
        gl.bindFramebuffer(DRAW, framebuffer); gl.framebufferTextureLayer(DRAW, point, to, level, layer);
      }), restore: nativeInverse(b, [["bindFramebuffer", DRAW, framebuffer], ["framebufferTextureLayer", DRAW, point, from, level, layer]]) });
    }
  framebufferInputsChanged();
  if (!changes.length) return true;
  let draw: WebGLFramebuffer | null = null;
  if (!checkedGlCall(b, () => { draw = gl.getParameter(0x8ca6); })) return false;
  return applyNativeChanges(b, changes, { shared: true, finalizer: nativeInverse(b, [["bindFramebuffer", DRAW, draw]]) });
}

/** Record that face `layer` at `level` now lives in `storage` (or, with
 * null, no longer exists), re-attaching its attachments. */
function settle(b: GlBinding, object: WebGLTexture, store: CubeStore, layer: number, level: number, storage: Storage | null): boolean {
  const key = cellKey(layer, level), before = (store.cells.get(key) ?? store.storages[0]).texture;
  if (storage) store.cells.set(key, storage); else store.cells.delete(key);
  store.revision++;
  framebufferInputsChanged();
  return retargetAttachments(b, object, FACE0 + layer, level, before, (storage ?? store.storages[0]).texture);
}

/** Copy one face image between storages through a private read
 * framebuffer. False (OUT_OF_MEMORY recorded) for a format that cannot be
 * attached to a framebuffer. */
function copyImage(b: GlBinding, from: Storage, to: Storage, layer: number, level: number, size: number): boolean {
  const gl = b.gl!, scratch = reserveNativeRetirement(b, [["deleteFramebuffer", null]]);
  if (!scratch) return false;
  let read: WebGLFramebuffer | null = null, complete = false;
  try {
    if (!checkedGlCall(b, () => { read = gl.getParameter(0x8caa); })) return false;
    const accepted = applyNativeChanges(b, [{ apply: () => withArray(b, to.texture, () => {
      const framebuffer = gl.createFramebuffer(); scratch.calls[0][1] = framebuffer;
      gl.bindFramebuffer(READ, framebuffer);
      gl.framebufferTextureLayer(READ, COLOR0, from.texture, level, layer);
      complete = gl.checkFramebufferStatus(READ) === 0x8cd5;
      if (complete) gl.copyTexSubImage3D(TEXTURE_2D_ARRAY, level, 0, 0, layer, 0, 0, size, size);
    }), restore: nativeInverse(b) }], { finalizer: nativeInverse(b, [["bindFramebuffer", READ, read]]) });
    if (accepted && !complete) recordGlError(b, 0x505);
    if (accepted && complete) noteStorageWrite(to.texture);
    return accepted && complete;
  } finally { retireNativeRetirement(scratch); }
}

/**
 * Gather into one storage the images that a complete cube samples: when
 * all six base images agree, every face image whose shape is the base's
 * shape at its level, and that lives elsewhere, is copied into the storage
 * holding (most of) the base images. Images of any other shape leave the
 * cube incomplete and stay where they are. False when a needed copy failed.
 */
function gather(b: GlBinding, object: WebGLTexture, store: CubeStore): boolean {
  const first = textureLevel(object, FACE0, 0);
  if (!first) return true;
  const shape0 = cubeShapeOf(first), counts = new Map<Storage, number>();
  for (let layer = 0; layer < 6; layer++) {
    const image = textureLevel(object, FACE0 + layer, 0), storage = store.cells.get(cellKey(layer, 0));
    if (!image || !storage || !sameShape(cubeShapeOf(image), shape0)) return true;
    counts.set(storage, (counts.get(storage) ?? 0) + 1);
  }
  if (counts.size === 1 && store.cells.size <= 6) return true;
  const base = [...counts].sort((x, y) => y[1] - x[1] || store.storages.indexOf(x[0]) - store.storages.indexOf(y[0]))[0][0];
  let gathered = true;
  for (const [key, storage] of [...store.cells]) {
    if (storage === base) continue;
    const layer = key % 6, level = (key - layer) / 6;
    const image = textureLevel(object, FACE0 + layer, level);
    const expected = { ...shape0, size: Math.max(1, shape0.size >> level) };
    if (!image || !sameShape(cubeShapeOf(image), expected)) continue;
    const at = base.levels.get(level);
    if (at && !sameShape(at, expected) && residents(store, base, level) > 0) continue;
    if (!sameShape(at, expected) && !allocate(b, base, level, expected)) { gathered = false; continue; }
    if (!copyImage(b, storage, base, layer, level, expected.size) || !settle(b, object, store, layer, level, base)) gathered = false;
  }
  return gathered;
}

/** Delete storages no face image lives in and release unused levels of the
 * first storage (it stays: it is the object's own texture). */
function release(b: GlBinding, store: CubeStore): void {
  const gl = b.gl!, used = new Set(store.cells.values()), retired: WebGLTexture[] = [];
  store.storages = store.storages.filter((storage, index) => {
    if (index === 0 || used.has(storage)) return true;
    retired.push(storage.texture); return false;
  });
  deleteTextures(b, retired);
  for (const storage of store.storages) for (const level of [...storage.levels.keys()]) {
    if (residents(store, storage, level) > 0) continue;
    // A zero-sized image frees the level's six layers.
    if (withArray(b, storage.texture, () => gl.texImage3D(TEXTURE_2D_ARRAY, level, 0x1908, 0, 0, 0, 0, 0x1908, 0x1401, null)))
      storage.levels.delete(level);
  }
}

/**
 * TexImage2D, CopyTexImage2D or CompressedTexImage2D of cube face `face`
 * (already validated as ES 2.0 requires, including the square size): give
 * the image storage of `shape`, then `write(layer)` fills its layer with
 * the storage bound to the active unit's TEXTURE_2D_ARRAY. A zero size
 * specifies no image. `compressedBytes` is one face's compressed size.
 */
export function cubeSpecifyImage(b: GlBinding, face: number, level: number, shape: CubeImageShape,
  write: ((layer: number) => void) | null, options: { inPlace: boolean; compressedBytes?: number }): boolean {
  const bound = boundCube(b);
  if (!bound) { recordGlError(b, 0x502); return false; }
  const { object, store } = bound, layer = cubeFaceLayer(face);
  if (shape.size === 0) {
    const settled = settle(b, object, store, layer, level, null);
    release(b, store);
    return settled;
  }
  const placed = place(b, store, layer, level, shape, options.inPlace);
  if (!placed) return false;
  const { storage } = placed;
  const previous = store.cells.get(cellKey(layer, level));
  if (placed.allocate && !allocate(b, storage, level, shape, options.compressedBytes)) {
    if (placed.created) release(b, store);
    return false;
  }
  if (write && !withArray(b, storage.texture, () => write(layer))) {
    noteStorageWrite(storage.texture);
    // Reallocated in place, the previous image is gone with the failure:
    // the face has no image now, and its record says so.
    if (placed.allocate && previous === storage) {
      settle(b, object, store, layer, level, null);
      recordTextureLevel(object, face, level, { width: 0, height: 0, internalFormat: 0, format: 0, type: 0, compressed: false });
    }
    release(b, store);
    return false;
  }
  noteStorageWrite(storage.texture);
  return settle(b, object, store, layer, level, storage);
}

/** After a cube image command's level record changed (texture-levels.ts):
 * gather the images a complete cube samples and free what is unused. */
export function cubeImagesChanged(b: GlBinding): boolean {
  const bound = boundCube(b);
  if (!bound) return true;
  const gathered = gather(b, bound.object, bound.store);
  release(b, bound.store);
  bound.store.revision++;
  return gathered;
}

/** TexSubImage2D, CopyTexSubImage2D or CompressedTexSubImage2D of a face:
 * `write(layer)` runs with the image's storage bound to the active unit's
 * TEXTURE_2D_ARRAY. An image never specified is INVALID_OPERATION (ES 2.0
 * section 3.7.2), as the native call reports for an undefined level. */
export function cubeUpdateImage(b: GlBinding, face: number, level: number, write: (layer: number) => void): boolean {
  const bound = boundCube(b);
  const storage = bound?.store.cells.get(cellKey(cubeFaceLayer(face), level));
  if (!storage) { recordGlError(b, 0x502); return false; }
  const accepted = withArray(b, storage.texture, () => write(cubeFaceLayer(face)));
  noteStorageWrite(storage.texture);
  return accepted;
}

/**
 * GenerateMipmap(TEXTURE_CUBE_MAP). ES 2.0 section 3.7.11 requires a cube
 * complete base (six equal square images of one format), else
 * INVALID_OPERATION; the native call then derives every level of each layer
 * from that layer's base image, which is ES 2.0's per-face derivation.
 */
export function cubeGenerateMipmap(b: GlBinding): boolean {
  const bound = boundCube(b);
  if (!bound) { recordGlError(b, 0x502); return false; }
  const { object, store } = bound, first = textureLevel(object, FACE0, 0);
  const base = store.cells.get(cellKey(0, 0));
  const shape0 = first && cubeShapeOf(first);
  for (let layer = 0; layer < 6; layer++) {
    const image = textureLevel(object, FACE0 + layer, 0);
    if (!shape0 || !image || first!.width !== first!.height || !sameShape(cubeShapeOf(image), shape0)
        || store.cells.get(cellKey(layer, 0)) !== base) { recordGlError(b, 0x502); return false; }
  }
  if (!base || !shape0 || !withArray(b, base.texture, () => b.gl!.generateMipmap(TEXTURE_2D_ARRAY))) return false;
  noteStorageWrite(base.texture);
  let accepted = true;
  for (let level = 1, size = shape0.size; size > 1; level++) {
    size = Math.max(1, size >> 1);
    base.levels.set(level, { ...shape0, size });
    for (let layer = 0; layer < 6; layer++) accepted = settle(b, object, store, layer, level, base) && accepted;
  }
  release(b, store);
  return accepted;
}

/** TexParameter(TEXTURE_CUBE_MAP): `apply(target)` sets it on the first
 * storage (whose native answer is the guest's), then the accepted value is
 * set on every other storage. */
export function cubeTexParameter(b: GlBinding, pname: number, apply: (target: number) => void): boolean {
  const bound = boundCube(b);
  if (!bound) { recordGlError(b, 0x502); return false; }
  const { store } = bound, gl = b.gl!;
  let value = 0;
  if (!withArray(b, store.storages[0].texture, () => {
    apply(TEXTURE_2D_ARRAY);
    value = Number(gl.getTexParameter(TEXTURE_2D_ARRAY, pname));
  })) return false;
  try { store.params.set(pname, value); }
  catch (caught) { rethrowNativeGlFault(caught); recordGlError(b, 0x505); return false; }
  if (pname === MIN_FILTER) store.minFilter = value;
  store.revision++;
  let accepted = true;
  for (const storage of store.storages.slice(1))
    accepted = withArray(b, storage.texture, () => gl.texParameteri(TEXTURE_2D_ARRAY, pname, value)) && accepted;
  return accepted;
}

/** The cube's accepted TEXTURE_MIN_FILTER (for EGLImage completeness). */
export function cubeMinFilter(object: WebGLTexture): number {
  return stores.get(object)?.minFilter ?? 0x2702;
}

/** GetTexParameter(TEXTURE_CUBE_MAP, pname); null when the query failed. */
export function cubeTexParameterValue(b: GlBinding, pname: number): number | null {
  const bound = boundCube(b);
  if (!bound) { recordGlError(b, 0x502); return null; }
  let value = 0;
  return withArray(b, bound.store.storages[0].texture, () => { value = Number(b.gl!.getTexParameter(TEXTURE_2D_ARRAY, pname)); })
    ? value : null;
}

/**
 * The native texture a draw samples for cube object `object`: the storage
 * holding all six base images while the cube is complete under ES 2.0
 * (texture-levels.ts) and holds every image a complete cube samples, else
 * null, which samples (0, 0, 0, 1) as an incomplete texture does. Cached
 * until the cube or any recorded image changes.
 */
export function cubeSamplingTexture(object: WebGLTexture | null): WebGLTexture | null {
  const store = object ? stores.get(object) : undefined;
  if (!object || !store) return null;
  const inputs = framebufferInputsRevision(), cached = store.sampled;
  if (cached && cached.revision === store.revision && cached.inputs === inputs) return cached.texture;
  let texture: WebGLTexture | null = null;
  const base = store.cells.get(cellKey(0, 0));
  if (base && textureComplete(object, true, store.minFilter)) {
    const mipmapped = store.minFilter !== 0x2600 && store.minFilter !== 0x2601;
    const levels = mipmapped ? Math.floor(Math.log2(textureLevel(object, FACE0, 0)!.width)) + 1 : 1;
    let gathered = true;
    for (let level = 0; level < levels && gathered; level++)
      for (let layer = 0; layer < 6 && gathered; layer++) gathered = store.cells.get(cellKey(layer, level)) === base;
    if (gathered) texture = base.texture;
  }
  store.sampled = { revision: store.revision, inputs, texture };
  return texture;
}

/** The storage of an exported face image (EGL 1.5 section 3.9): the image
 * is that storage's layer at that level. Null for an image never specified. */
export function cubeImageLocation(object: WebGLTexture, face: number, level: number): { texture: WebGLTexture; layer: number } | null {
  const storage = stores.get(object)?.cells.get(cellKey(cubeFaceLayer(face), level));
  return storage ? { texture: storage.texture, layer: cubeFaceLayer(face) } : null;
}

/**
 * Orphaning (EGL 1.5 section 3.9, KHR_image_base): an exported face image's
 * storage `texture` becomes the image's alone. Every other image of the
 * cube living there is copied to a new storage, which takes its place.
 * Copies use a framebuffer, so an image whose format cannot be attached
 * fails with OUT_OF_MEMORY and the cube keeps sharing the storage.
 */
export function orphanCubeStorage(b: GlBinding, object: WebGLTexture, texture: WebGLTexture): boolean {
  const store = stores.get(object);
  const index = store?.storages.findIndex(storage => storage.texture === texture) ?? -1;
  if (!store || index < 0) return true;
  const shared = store.storages[index];
  const moving = [...store.cells].filter(([, storage]) => storage === shared);
  const fresh = createStorage(b, store);
  if (!fresh) return false;
  for (const [key] of moving) {
    const layer = key % 6, level = (key - layer) / 6, shape = shared.levels.get(level)!;
    if ((!sameShape(fresh.levels.get(level), shape) && !allocate(b, fresh, level, shape))
        || !copyImage(b, shared, fresh, layer, level, shape.size)) {
      store.storages = store.storages.filter(storage => storage !== fresh);
      deleteTextures(b, [fresh.texture]);
      return false;
    }
  }
  // The new storage takes the shared one's place (first, if it was first).
  store.storages = store.storages.filter(storage => storage !== fresh);
  store.storages[index] = fresh;
  let accepted = true;
  for (const [key] of moving) accepted = settle(b, object, store, key % 6, (key - key % 6) / 6, fresh) && accepted;
  if (index === 0) {
    // Images never specified were attached to the old first storage.
    for (const member of b.objects.members) for (const points of member.framebufferAttachments.values())
      for (const image of points.values()) {
        if (image.kind !== "texture" || image.object !== object || store.cells.has(cellKey(cubeFaceLayer(image.target), image.level))) continue;
        accepted = retargetAttachments(b, object, image.target, image.level, shared.texture, fresh.texture) && accepted;
      }
  }
  store.revision++;
  return accepted;
}
