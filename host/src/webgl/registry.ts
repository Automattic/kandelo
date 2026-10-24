import type { GlSurfaceCreation } from "./surface-create.js";
/**
 * Tracks live `/dev/dri/renderD128` GLES sessions reported by the kernel.
 *
 * Each kernel GL session owns an independent binding within its process.
 * Process-only lookups refuse ambiguity instead of selecting another session.
 * Each binding owns:
 *
 *   - the cmdbuf region (a slice of the process's wasm Memory SAB),
 *   - a lazily-built `WebGL2RenderingContext` once a canvas is attached,
 *   - object-group maps for shareable GL names and uniform locations,
 *   - context-local state, errors, VAOs and framebuffer containers.
 *
 * The cmdbuf view is built lazily on the first `host_gl_submit` and
 * invalidated on `WebAssembly.Memory.grow()` via `rebindMemory(pid)`,
 * mirroring the framebuffer registry's pattern.
 *
 * Uniform-location indexing uses a monotonic `nextUniformLoc` counter
 * (never decremented) rather than `Map.size`. Map.size shrinks on delete
 * and would collide with prior indices that the C side may still hold.
 * Indices are int-keyed (not stringified) so the cmdbuf u32 round-trips
 * cleanly without `Map<string, ...>` / `Map<number, ...>` mismatches.
 */
import { defaultShadow, type GlShadowState } from "./shadow.js";
import type { GlDrawableBinding } from "./current.js";
import { replaceDefaultFramebuffer } from "./framebuffer.js";
import { createGlObjectGroup, exposeGlSharedObjects, type GlObjectGroup, type GlSharedObjects } from "./object-group.js";
import { finalizeProgram, releaseRetainedExecutable } from "./program-objects.js";
import { collectRetiredImages, type GlImageAttachment } from "./image-references.js";
import { destroyBufferStorage } from "./buffer-storage.js";
import { collectRetiredBuffers, defaultVertexArray, type GlVertexArray } from "./buffer-references.js";
import type { GlShaderSourceUpload } from "./shader-source.js";

import {
  createSurfaceResources, exposeSurfaceResources, releaseSurfaceResources, retireSurface,
  type GlSurfaceFields, type GlSurfaceResources,
} from "./surface-resources.js";

export type GlContextHandle = number;
export type GlSurfaceHandle = number;

export type GlBindingInput = {
  pid: number;
  /** Kernel-owned open-description session identity. Zero is the unscoped
   * embedder API's single-session identity; kernel sessions are nonzero. */
  sessionId?: number;
  /** Wasm-process address where the cmdbuf was mmap'd (set by the
   *  kernel's `host_gl_bind` call). */
  cmdbufAddr: number;
  /** Cmdbuf length in bytes (always `shared::gl::CMDBUF_LEN` = 1 MiB
   *  in v1). */
  cmdbufLen: number;
};

/** Bytes handed to `onSubmit` are non-shared — the caller copies them
 *  out of the SAB-backed cmdbuf so the channel may transfer the buffer. */
export type GlForwardChannel = {
  /** Zero acknowledges a live renderer; negative errno leaves no context. */
  onCreateContext(sessionId?: number): number;
  onDestroyContext(sessionId?: number): void;
  onCreateSurface?(surface: GlSurfaceCreation, sessionId?: number): {rc: number; width: number; height: number};
  onDestroySurface?(surfaceId: number, sessionId?: number): void;
  onUnbind?(sessionId: number): void;
  onMakeCurrent?(drawable: GlDrawableBinding, sessionId?: number): number;
  onPresent?(sessionId?: number): number;
  onSubmit(bytes: Uint8Array, sessionId?: number): void;
  onQuery?(op: number, input: Uint8Array, outLen: number, sessionId?: number): { rc: number; bytes: Uint8Array };
};

export type GlBinding = GlBindingInput & GlSharedObjects & GlSurfaceFields & {
  surface: GlSurfaceResources;
  drawSurface: GlSurfaceResources | null;
  readSurface: GlSurfaceResources | null;
  sessionId: number;
  currentDrawable: GlDrawableBinding | null;
  hasBeenCurrent: boolean;
  shaderUpload: GlShaderSourceUpload | null;
  shaderUploadSerial: number;
  /** No attachments: native framebuffer operations enforce surfaceless
   * incompleteness. This object never has a guest-visible name. */
  undefinedDefaultFbo: WebGLFramebuffer | null;
  /** Lazy view of `[cmdbufAddr, cmdbufAddr+cmdbufLen)` of the process's
   *  wasm Memory SAB. Built on the first submit and dropped to `null`
   *  by `rebindMemory` after a `Memory.grow()`. */
  cmdbufView: Uint8Array | null;

  /** Live WebGL2 context, lazily constructed at `host_gl_create_context`
   *  time once the embedder has attached a canvas. */
  gl: WebGL2RenderingContext | null;
  /** The canvas backing this binding's WebGL2 context. Set by
   *  `attachCanvas` before the program calls `eglCreateContext`. */
  canvas: HTMLCanvasElement | OffscreenCanvas | null;

  /** Kernel-issued EGL backend context identity. */
  contextId: GlContextHandle | null;

  objects: GlObjectGroup;
  errors: number[];
  vaos: Map<number, WebGLVertexArrayObject>;
  fbos: Map<number, WebGLFramebuffer>;
  framebufferAttachments: Map<WebGLFramebuffer, Map<number, GlImageAttachment>>;
  vertexArrayId: number;
  vertexArrays: Map<number, GlVertexArray>;

  /** CRTC whose scanout canvas this binding auto-claimed at context
   *  creation (`markKmsCanvasGlOwned`). Tracked so context destruction
   *  / session teardown can hand the canvas BACK to the vblank pump —
   *  a GPU compositor that degrades to its CPU path mid-run terminates
   *  EGL, and the pump presenter must resume or the canvas freezes on
   *  the last GL frame. */
  claimedKmsCrtc: number | null;

  /** Last `glUseProgram` target, kept for handlers that need the
   *  current program (e.g. uniform setters). */
  currentProgram: WebGLProgram | null;
  /** Logical name remains current when the latest link attempt failed and
   * currentProgram still holds an earlier installed native executable. */
  currentProgramId: number;


  shadow: GlShadowState;

  forward: GlForwardChannel | null;
};

export type GlChangeEvent = "bind" | "unbind";
export type GlChangeListener = (pid: number, ev: GlChangeEvent) => void;

/** A GPU-tier bo (`DRM_IOCTL_WPK_CREATE_GPU_BO`): a `WebGLTexture` +
 *  color-attachment FBO living on the shared multiplexer context (the
 *  DRM-master compositor's scanout context). Unlike CPU-tier bos there
 *  is no SAB backing — the pixels only ever exist on the GPU. The
 *  producer renders into `fbo`; a consumer that `WPK_BIND_FOREIGN_TEXTURE`s
 *  it samples `tex` zero-copy, so it MUST be on the same `gl`. */
export type GpuBo = {
  gl: WebGL2RenderingContext;
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
  depthStencil: WebGLRenderbuffer;
  texId: number;
  w: number;
  h: number;
};

export class GlContextRegistry {
  private bindings = new Map<string, GlBinding>();
  private listeners = new Set<GlChangeListener>();
  /** GPU-tier bos keyed by bo_id. Registry-scoped (NOT per-binding):
   *  the texture is owned by the bo and shared across every session that
   *  binds it, so it is freed only on bo destroy, never on `unbind()`. */
  private gpuBos = new Map<number, GpuBo>();
  /** Id allocator for GPU-bo textures. Distinct band from per-binding
   *  foreign textures (`0x4000_0000`) so a stray id never resolves to
   *  the wrong table when debugging. */
  private nextGpuBoTexId = 0x6000_0000;
  /** Channels installed before `bind()` fires; drained when it does, so
   *  the embedder can wire forwarding without racing `host_gl_bind`. */
  private pendingForwards = new Map<number, GlForwardChannel>();
  /** Canvases attached before `bind()` fires; drained on bind, mirroring
   *  pendingForwards. Without this, an embedder that calls
   *  `attachCanvas(pid, …)` synchronously after `spawn()` would race
   *  the program's own `eglInitialize → host_gl_bind` and silently
   *  drop the canvas, leaving every subsequent submit a no-op. */
  private pendingCanvases = new Map<number, HTMLCanvasElement | OffscreenCanvas>();

  bind(b: GlBindingInput): void {
    const forward = this.pendingForwards.get(b.pid)
      ?? this.list().find(value => value.pid === b.pid && value.forward)?.forward ?? null;
    this.pendingForwards.delete(b.pid);
    const canvas = this.getCanvas(b.pid);
    this.pendingCanvases.delete(b.pid);
    const sessionId = (b.sessionId ?? 0) >>> 0;
    if (this.get(b.pid, sessionId)) throw new Error("GL session is already bound");
    const binding: GlBinding = exposeSurfaceResources(exposeGlSharedObjects({
      surface: createSurfaceResources(b.pid), drawSurface: null, readSurface: null,
      objects: createGlObjectGroup(),
      ...b,
      sessionId,
      currentDrawable: null,
      hasBeenCurrent: false,
      undefinedDefaultFbo: null,
      cmdbufView: null,
      gl: null,
      canvas,
      contextId: null,
      errors: [],
      vaos: new Map(),
      fbos: new Map(),
      framebufferAttachments: new Map(),
      vertexArrayId: 0,
      vertexArrays: new Map([[0,defaultVertexArray()]]),
      claimedKmsCrtc: null,
      currentProgram: null,
      currentProgramId: 0,
      shadow: defaultShadow(),
      shaderUpload: null,
      shaderUploadSerial: 0,
      forward,
    }));
    binding.objects.members.add(binding);
    this.bindings.set(`${binding.pid}:${sessionId}`, binding);
    for (const l of this.listeners) l(b.pid, "bind");
  }

  unbind(pid: number, sessionId?: number): void {
    if (sessionId !== undefined) sessionId >>>= 0;
    let failure: unknown;
    for (const b of this.list()) {
      if (b.pid !== pid || (sessionId !== undefined && b.sessionId !== sessionId)) continue;
      b.cmdbufView = null;
      try {
        this.destroyContext(pid, b.sessionId);
        retireSurface(b.surface);
        b.forward?.onUnbind?.(b.sessionId);
      } catch (error) {
        failure ??= error;
      } finally {
        this.bindings.delete(`${pid}:${b.sessionId}`);
      }
      for (const l of this.listeners) l(pid, "unbind");
    }
    if (sessionId === undefined || !this.list().some(b => b.pid === pid)) {
      this.pendingForwards.delete(pid);
      this.pendingCanvases.delete(pid);
    }
    if (failure) throw failure;
  }

  /** The native WebGL context is shared and survives guest EGL contexts.
   * Retire local state immediately and shared resources at the final owner. */
  destroyContext(pid: number, sessionId?: number): void {
    const b = this.get(pid, sessionId);
    if (!b) return;
    const gl = b.gl;
    b.shaderUpload = null;
    b.shaderUploadSerial = 0;
    const objects = b.objects;
    const installed = b.currentProgram;
    const installedName = b.currentProgramId;
    const retained = installed !== null && b.programs.get(installedName) !== installed;
    objects.members.delete(b);
    b.currentProgram = b.shadow.currentProgram = null;
    b.currentProgramId = 0;
    if (objects.members.size === 0) {
      const programs = new Set(b.programs.values());
      if (installed) programs.add(installed);
      if (gl && programs.size && programs.has(gl.getParameter(0x8b8d) as WebGLProgram)) gl.useProgram(null);
      const boTextures = new Set([...this.gpuBos.values()].map(bo => bo.tex));
      const textures = new Set([
        ...b.textures.values(), ...[...b.foreignTextures.values()].map(entry => entry.tex),
      ]);
      for (const texture of textures) if (!boTextures.has(texture)) gl?.deleteTexture(texture);
      for (const object of b.buffers.values()) if (gl) destroyBufferStorage(b,object);
      for (const object of b.shaders.values()) gl?.deleteShader(object);
      for (const object of programs) gl?.deleteProgram(object);
      for (const object of b.rbos.values()) gl?.deleteRenderbuffer(object);
      for (const map of [b.buffers,b.textures,b.shaders,b.programs,b.rbos,b.uniformLocations,
        b.uniformLocationPrograms,b.programShaders,b.programAttributeBindings,b.foreignTextures,b.shaderSources]) map.clear();
      b.shaderDeletePending.clear(); b.programDeletePending.clear();
    } else {
      if (installedName) finalizeProgram(b, installedName);
      if (retained) releaseRetainedExecutable(b, installed);
    }
    for (const object of b.vaos.values()) gl?.deleteVertexArray(object);
    for (const object of b.fbos.values()) gl?.deleteFramebuffer(object);
    b.vaos.clear(); b.fbos.clear();
    b.framebufferAttachments.clear();
    b.vertexArrays.clear();
    collectRetiredImages(b);
    collectRetiredBuffers(b);
    b.objects = createGlObjectGroup();
    b.objects.nextUniformLoc = objects.nextUniformLoc;
    b.objects.nextForeignTexId = objects.nextForeignTexId;
    b.objects.members.add(b);
    b.errors.length = 0;
    if (b.undefinedDefaultFbo) gl?.deleteFramebuffer(b.undefinedDefaultFbo);
    b.undefinedDefaultFbo = null;
    if (b.shadow.defaultVao) {
      b.gl?.deleteVertexArray(b.shadow.defaultVao);
      b.shadow.defaultVao = null;
    }
    for (const texture of b.shadow.defaultTextures.values()) gl?.deleteTexture(texture);
    b.shadow.defaultTextures.clear();
    releaseSurfaceResources(b);
    // An explicit surface outlives context destruction. An unpublished
    // staging target has no EGL owner and can be reclaimed immediately.
    if (b.surfaceId === null) {
      retireSurface(b.surface);
      b.surface = createSurfaceResources(b.pid);
    }
    b.currentProgram = null;
    b.currentProgramId = 0;
    b.currentDrawable = null;
    b.hasBeenCurrent = false;
    b.shadow = defaultShadow();
    b.vertexArrayId = 0;
    b.vertexArrays.set(0,defaultVertexArray());
    b.contextId = null;
    b.gl = null;
  }

  destroySurface(pid: number, sessionId?: number): void {
    const b = this.get(pid, sessionId);
    if (!b) return;
    const surface = b.surface;
    if (!b.drawSurface && b.shadow.fbo === surface.renderTargetFbo) b.shadow.fbo = null;
    if (!b.readSurface && b.shadow.readFbo === surface.renderTargetFbo) b.shadow.readFbo = null;
    retireSurface(surface);
    b.surface = createSurfaceResources(b.pid);
  }

  get(pid: number, sessionId?: number): GlBinding | undefined {
    if (sessionId !== undefined) return this.bindings.get(`${pid}:${sessionId >>> 0}`);
    const bindings = this.list().filter(b => b.pid === pid);
    return bindings.length === 1 ? bindings[0] : undefined;
  }

  /** Only live owner records grant new selection. Existing users retain a
   * retired record independently after its owner is destroyed or unbound. */
  getSurface(pid: number, surfaceId: number): GlSurfaceResources | undefined {
    return this.list().find(b => b.pid === pid && b.surfaceId === surfaceId && b.surface.ownerAlive)?.surface;
  }

  getContext(pid: number, contextId: number): GlBinding | undefined {
    return this.list().find(b => b.pid === pid && b.contextId === (contextId >>> 0));
  }

  /** Internal construction step, before the target context owns names or
   * state. Guest sharing additionally requires display/version authority and
   * complete shared deletion; the EGL facade does not expose this yet. */
  shareObjects(pid: number, targetSession: number, sourceSession: number): boolean {
    const target = this.get(pid,targetSession), source = this.get(pid,sourceSession);
    if (!target || !source || target === source || !target.gl || target.gl !== source.gl
        || target.contextId === null || source.contextId === null || target.hasBeenCurrent
        || target.objects.members.size !== 1) return false;
    const names = target.objects;
    if (names.buffers.size || names.bufferStores.size || names.textures.size || names.shaders.size || names.programs.size
        || names.rbos.size || names.uniformLocations.size || names.foreignTextures.size
        || names.retiredTextures.size || names.retiredBuffers.size || names.retiredRenderbuffers.size
        || names.shaderDeletePending.size || names.programDeletePending.size) return false;
    names.members.delete(target);
    target.objects = source.objects;
    source.objects.members.add(target);
    return true;
  }

  list(): GlBinding[] {
    return [...this.bindings.values()];
  }

  /**
   * Drop the cached cmdbuf view for `pid`. Callers (the host's
   * memory-replaced flow) invoke this after `WebAssembly.Memory.grow()`
   * invalidates the prior buffer reference. The next `host_gl_submit`
   * rebuilds the view from the new SAB.
   */
  rebindMemory(pid: number): void {
    for (const b of this.list()) if (b.pid === pid) b.cmdbufView = null;
  }

  /**
   * Wire a canvas to this binding. Must happen before the program
   * calls `eglCreateContext` (which triggers `host_gl_create_context`).
   * Embedders that haven't seen `host_gl_bind` yet (e.g. attaching
   * synchronously after `spawn()`) are queued in `pendingCanvases`
   * and drained when bind arrives. The WebGL2 context itself is
   * built lazily at create-context time.
   */
  attachCanvas(
    pid: number,
    canvas: HTMLCanvasElement | OffscreenCanvas,
  ): void {
    const bindings = this.list().filter(b => b.pid === pid);
    if (bindings.length === 0) this.pendingCanvases.set(pid, canvas);
    for (const b of bindings) b.canvas = canvas;
  }

  detachCanvas(pid: number): void {
    this.pendingCanvases.delete(pid);
    for (const b of this.list()) if (b.pid === pid) { b.canvas = null; b.gl = null; }
  }

  /** Bound canvas, or staged `pendingCanvases` entry if `attachCanvas`
   *  ran before `bind()`. Used by the worker entries' fork hook to
   *  propagate the parent's canvas to the child. */
  getCanvas(pid: number): HTMLCanvasElement | OffscreenCanvas | null {
    const b = this.list().find(b => b.pid === pid && b.canvas);
    if (b?.canvas) return b.canvas;
    return this.pendingCanvases.get(pid) ?? null;
  }

  attachMainForward(pid: number, channel: GlForwardChannel): void {
    const bindings = this.list().filter(b => b.pid === pid);
    if (bindings.length === 0) this.pendingForwards.set(pid, channel);
    for (const b of bindings) b.forward = channel;
  }

  detachMainForward(pid: number): void {
    this.pendingForwards.delete(pid);
    for (const b of this.list()) if (b.pid === pid) b.forward = null;
  }

  /** Delete every binding's foreign texture for a destroyed bo (the bo
   *  is the texture's canonical owner — see shared's
   *  `DRM_IOCTL_WPK_BIND_FOREIGN_TEXTURE` doc). Called from the host's
   *  `gbm_bo_destroy` hook when the bo refcount hits zero.
   *
   *  This DELIBERATELY leaves `gpuBos` untouched: a GPU-tier bo's texture
   *  is owned by the bo itself (this registry), not by any binding, and
   *  is released only via `destroyGpuBo` on bo destroy. */
  dropForeignTexturesForBo(bo_id: number): void {
    for (const b of this.bindings.values()) {
      const entry = b.foreignTextures.get(bo_id);
      if (!entry) continue;
      b.foreignTextures.delete(bo_id);
      b.textures.delete(entry.texId);
      b.gl?.deleteTexture(entry.tex);
    }
  }

  /** Allocate a GPU-tier bo (`DRM_IOCTL_WPK_CREATE_GPU_BO`): an empty
   *  `w×h` RGBA texture plus a color-attachment FBO on `gl` (the shared
   *  multiplexer context). Idempotent — a second call for a live `bo_id`
   *  returns the existing texId without reallocating. Returns the guest-
   *  visible texture id, or `null` if the context could not allocate the
   *  objects (the kernel then rolls back and the guest falls back to a
   *  CPU-tier dumb bo).
   *
   *  Runs OUTSIDE the submit-drain/muxer path, so the prior
   *  TEXTURE_BINDING_2D and FRAMEBUFFER_BINDING are saved and restored —
   *  the shared context may be mid-frame for another session. */
  createGpuBo(
    bo_id: number,
    gl: WebGL2RenderingContext,
    w: number,
    h: number,
  ): number | null {
    const existing = this.gpuBos.get(bo_id);
    if (existing) return existing.texId;
    const tex = gl.createTexture();
    const fbo = gl.createFramebuffer();
    const depthStencil = gl.createRenderbuffer();
    if (!tex || !fbo || !depthStencil) {
      if (tex) gl.deleteTexture(tex);
      if (fbo) gl.deleteFramebuffer(fbo);
      if (depthStencil) gl.deleteRenderbuffer(depthStencil);
      return null;
    }
    const prevTex = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
    const prevDraw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    const prevRead = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    const prevRbo = gl.getParameter(gl.RENDERBUFFER_BINDING) as WebGLRenderbuffer | null;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    // `null` data → allocate storage without an upload; the producer
    // fills it by rendering into the FBO.
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0,
      gl.RGBA, gl.UNSIGNED_BYTE, null,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0,
    );
    // A Wayland EGL window is a default framebuffer just like scanout.
    // Color-only storage made stencil clipping silently draw unmasked.
    gl.bindRenderbuffer(gl.RENDERBUFFER, depthStencil);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, w, h);
    gl.framebufferRenderbuffer(
      gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, depthStencil,
    );
    const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindTexture(gl.TEXTURE_2D, prevTex);
    gl.bindRenderbuffer(gl.RENDERBUFFER, prevRbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, prevDraw);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, prevRead);
    if (!complete) {
      gl.deleteRenderbuffer(depthStencil);
      gl.deleteFramebuffer(fbo);
      gl.deleteTexture(tex);
      return null;
    }
    const texId = this.nextGpuBoTexId++;
    this.gpuBos.set(bo_id, { gl, tex, fbo, depthStencil, texId, w, h });
    return texId;
  }

  /** The GPU-tier bo for `bo_id`, or undefined if it is CPU-tier /
   *  unknown. Used by the foreign-texture bind path to short-circuit to a
   *  zero-copy texture-id return. */
  gpuBo(bo_id: number): GpuBo | undefined {
    return this.gpuBos.get(bo_id);
  }

  /** Apply the GPU-tier producer render-target redirect for `b` if both
   *  halves are now known: `b.gl` (set at context creation) and a pending
   *  target GPU bo (captured at surface creation). Redirects the client's
   *  default framebuffer (name 0) into the bo's FBO and seeds the viewport
   *  to the bo dims, so its GL output lands in the bo the compositor
   *  samples zero-copy. Idempotent; a no-op until both halves exist and
   *  the bo lives on the SAME context as `b.gl` (WebGL FBOs aren't
   *  shareable). Called from BOTH `gl_create_surface` and
   *  `gl_create_context` because SDL2's Wayland+GLES backend creates the
   *  window surface (during `SDL_CreateWindow`) BEFORE the context (during
   *  `SDL_GL_CreateContext`) — whichever runs last wins. Returns true when
   *  the redirect was applied. */
  applyRenderTarget(b: GlBinding): boolean {
    if (b.renderTargetFbo || !b.gl || b.pendingRenderTargetBoId === 0) {
      return false;
    }
    const gpu = this.gpuBos.get(b.pendingRenderTargetBoId);
    if (!gpu || b.gl !== gpu.gl) return false;
    b.renderTargetFbo = gpu.fbo;
    replaceDefaultFramebuffer(b, null);
    if (!b.hasBeenCurrent) b.shadow.viewport = [0, 0, gpu.w, gpu.h];
    return true;
  }

  /** Release a GPU-tier bo's FBO + texture from its shared context.
   *  Called from `gbm_bo_destroy` alongside `dropForeignTexturesForBo`. */
  destroyGpuBo(bo_id: number): void {
    const entry = this.gpuBos.get(bo_id);
    if (!entry) return;
    this.gpuBos.delete(bo_id);
    entry.gl.deleteFramebuffer(entry.fbo);
    entry.gl.deleteRenderbuffer(entry.depthStencil);
    entry.gl.deleteTexture(entry.tex);
  }

  onChange(fn: GlChangeListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
}
