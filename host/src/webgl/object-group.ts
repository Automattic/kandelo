import type { GlBinding } from "./registry.js";

/** Shareable object names and metadata. Bindings, FBOs, VAOs and errors
 * belong to individual contexts even when these objects are shared. */
export type GlSharedObjects = {
  /** Cmdbuf-name (u32) → real GL object maps. */
  buffers: Map<number, WebGLBuffer>;
  textures: Map<number, WebGLTexture>;
  shaders: Map<number, WebGLShader>;
  programs: Map<number, WebGLProgram>;
  shaderDeletePending: Set<number>;
  programDeletePending: Set<number>;
  programShaders: Map<number, Set<number>>;
  programAttributeBindings: Map<number, Map<string, number>>;
  rbos: Map<number, WebGLRenderbuffer>;
  /** Number-keyed (NOT string-keyed) so the cmdbuf int round-trips
   *  cleanly. Indices are assigned by `++nextUniformLoc` and never
   *  reused so insert/delete cycles cannot collide. */
  uniformLocations: Map<number, WebGLUniformLocation>;
  uniformLocationPrograms: Map<number, number>;
  /** Monotonic counter for `uniformLocations`; never decremented. */
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
  /** Id allocator for foreign textures. Starts far above any name the
   *  guest-side monotonic counters (libglesv2_stub.c, from 1) can
   *  reach, so host- and guest-assigned ids share `textures` without
   *  collision. */
  nextForeignTexId: number;
  retiredTextures: Map<WebGLTexture, number>;
  retiredBuffers: Map<WebGLBuffer, number>;
  retiredRenderbuffers: Map<WebGLRenderbuffer, number>;
  /** Ownership tag only: BO retirement remains the kernel's explicit fence. */
  externallyOwnedTextures: WeakSet<WebGLTexture>;
};

export type GlObjectGroup = GlSharedObjects & { members: Set<GlBinding> };

export function createGlObjectGroup(): GlObjectGroup {
  return {
    members: new Set(), buffers: new Map(), textures: new Map(), shaders: new Map(), programs: new Map(),
    rbos: new Map(), shaderDeletePending: new Set(), programDeletePending: new Set(),
    programShaders: new Map(), programAttributeBindings: new Map(),
    uniformLocations: new Map(), uniformLocationPrograms: new Map(), nextUniformLoc: 0,
    foreignTextures: new Map(), nextForeignTexId: 0x4000_0000,
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
