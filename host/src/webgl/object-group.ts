import type { NativeRetirement } from "./native-recovery.js";
import type { GlImageSource, GlTextureView, GlRenderbufferView } from "./image-storage.js";
import type { GlBufferStore } from "./buffer-storage.js";
import type { GlBinding } from "./registry.js";

/** Immutable reflection for one accepted native executable. The public numeric
 * program can name a later failed/successful link while an older one is current. */
export type GlUniformMetadata = Readonly<{ executable: WebGLProgram; type: number; array: boolean; remaining: number }>;

/** One authoritative location identity. Reserved entries are never usable by
 * a setter or a value query; publication changes this existing record only. */
export type GlUniformLocationRecord = {
  program: number; canonical: string; native: WebGLUniformLocation;
  metadata: GlUniformMetadata;
  state: "reserved" | "published" | "invalid";
  references: number;
};
export function publishedUniformLocation(owner: Pick<GlSharedObjects,"uniformLocationRecords">, index: number): GlUniformLocationRecord | undefined {
  const record = owner.uniformLocationRecords.get(index);
  return record?.state === "published" ? record : undefined;
}

/** Shareable object names and metadata. Bindings, FBOs, VAOs and errors
 * belong to individual contexts even when these objects are shared. */
export type GlSharedObjects = {
  /** Cmdbuf-name (u32) → real GL object maps. */
  /** Buffer map values are stable identities; native views live in bufferStores. */
  buffers: Map<number, WebGLBuffer>;
  bufferStores: Map<WebGLBuffer, GlBufferStore>;
  bufferViewOwners: Map<WebGLBuffer, WebGLBuffer>;
  textures: Map<number, WebGLTexture>;
  imageSources: Map<number, GlImageSource>;
  nextImageSource: number;
  /** Monotonic accepted image-association changes, keyed by retained identity. */
  bufferRetirements: Map<WebGLBuffer, NativeRetirement>;
  imageRetirements: Map<WebGLTexture | WebGLRenderbuffer, NativeRetirement>;
  imageRevisions: Map<WebGLTexture | WebGLRenderbuffer, number>;
  textureViews: Map<WebGLTexture, GlTextureView>;
  textureViewOwners: Map<WebGLTexture, WebGLTexture>;
  renderbufferViews: Map<WebGLRenderbuffer, GlRenderbufferView>;
  renderbufferViewOwners: Map<WebGLRenderbuffer, WebGLRenderbuffer>;
  shaders: Map<number, WebGLShader>;
  /** Original submitted bytes; native decoding must not change source queries. */
  shaderSources: Map<WebGLShader, Uint8Array>;
  programs: Map<number, WebGLProgram>;
  shaderDeletePending: Set<number>;
  programDeletePending: Set<number>;
  programShaders: Map<number, Set<number>>;
  programAttributeBindings: Map<number, Map<string, number>>;
  rbos: Map<number, WebGLRenderbuffer>;
  /** Positive public IDs are never reused after publication. */
  uniformLocationRecords: Map<number, GlUniformLocationRecord>;
  /** Highest index ever published; reservations may lie above it. */
  nextUniformLoc: number;

  /** Foreign textures bound from DRI bos (`WPK_BIND_FOREIGN_TEXTURE`),
   *  keyed by bo_id. Each entry mirrors into `textures` under `texId`
   *  so cmdbuf `OP_BIND_TEXTURE` resolves it like any guest-generated
   *  name. `scratch` caches the non-shared upload staging buffer
   *  (WebGL rejects SAB-backed views). */
  foreignTextures: Map<
    number,
    { tex: WebGLTexture; texId: number; w: number; h: number; scratch: Uint8Array | null }
  >;
  /** Positive-i32 native result band. Allocation must still skip realized
   * names; checked C adoption separately protects unrealized reservations. */
  nextForeignTexId: number;
  /** Raw BO view ownership follows identity, including deleted retained names. */
  foreignTextureBos: Map<WebGLTexture, number>;
  retiredTextures: Map<WebGLTexture, number>;
  retiredBuffers: Map<WebGLBuffer, number>;
  retiredRenderbuffers: Map<WebGLRenderbuffer, number>;
  /** Ownership tag only: BO retirement remains the kernel's explicit fence. */
  externallyOwnedTextures: WeakSet<WebGLTexture>;
};

export type GlObjectGroup = GlSharedObjects & { members: Set<GlBinding> };

export function createGlObjectGroup(): GlObjectGroup {
  return {
    bufferRetirements:new Map(),imageRetirements:new Map(),imageSources:new Map(),nextImageSource:1,imageRevisions:new Map(),textureViews:new Map(),textureViewOwners:new Map(),renderbufferViews:new Map(),renderbufferViewOwners:new Map(),
    members: new Set(), buffers: new Map(), bufferStores: new Map(), bufferViewOwners: new Map(), textures: new Map(), shaders: new Map(), programs: new Map(),
    rbos: new Map(), shaderSources: new Map(), shaderDeletePending: new Set(), programDeletePending: new Set(),
    programShaders: new Map(), programAttributeBindings: new Map(),
    uniformLocationRecords: new Map(), nextUniformLoc: 0,
    foreignTextures: new Map(), nextForeignTexId: 0x4000_0000, foreignTextureBos: new Map(),
    retiredTextures: new Map(), retiredBuffers: new Map(), retiredRenderbuffers: new Map(), externallyOwnedTextures: new WeakSet(),
  };
}

/** Keep existing decoder access through the current group. Joining another
 * group changes ownership, rather than copying maps or allocator counters. */
export function exposeGlSharedObjects<T extends { objects: GlObjectGroup }>(binding: T): T & GlSharedObjects {
  for (const name of Object.keys(binding.objects)) {
    if (name === "members") continue;
    Object.defineProperty(binding, name, {
      enumerable: true,
      get: () => Reflect.get(binding.objects, name),
      set: value => { Reflect.set(binding.objects, name, value); },
    });
  }
  return binding as T & GlSharedObjects;
}
