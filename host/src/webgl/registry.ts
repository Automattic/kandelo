/**
 * Tracks live `/dev/dri/renderD128` GLES sessions reported by the kernel.
 *
 * One binding per process (single-owner enforced kernel-side via
 * `GL_DEVICE_OWNER`). Each binding owns:
 *
 *   - the cmdbuf region (a slice of the process's wasm Memory SAB),
 *   - a lazily-built `WebGL2RenderingContext` once a canvas is attached,
 *   - per-process handle maps that translate cmdbuf-side u32 names to
 *     real `WebGL*` objects (buffers, textures, shaders, programs, VAOs,
 *     framebuffers, renderbuffers, uniform locations).
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

export type GlContextHandle = number;
export type GlSurfaceHandle = number;

export type GlBindingInput = {
  pid: number;
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
  onCreateContext(): void;
  onDestroyContext(): void;
  onSubmit(bytes: Uint8Array): void;
};

export type GlBinding = GlBindingInput & {
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

  /** EGL context handle (opaque u32 the C side picks). */
  contextId: GlContextHandle | null;
  /** EGL surface handle (opaque u32 the C side picks). */
  surfaceId: GlSurfaceHandle | null;

  /** Cmdbuf-name (u32) → real GL object maps. */
  buffers: Map<number, WebGLBuffer>;
  textures: Map<number, WebGLTexture>;
  shaders: Map<number, WebGLShader>;
  programs: Map<number, WebGLProgram>;
  vaos: Map<number, WebGLVertexArrayObject>;
  fbos: Map<number, WebGLFramebuffer>;
  rbos: Map<number, WebGLRenderbuffer>;
  /** Number-keyed (NOT string-keyed) so the cmdbuf int round-trips
   *  cleanly. Indices are assigned by `++nextUniformLoc` and never
   *  reused so insert/delete cycles cannot collide. */
  uniformLocations: Map<number, WebGLUniformLocation>;
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

  /** GPU-tier producer render target (PR10 §7.1): the FBO whose color
   *  attachment IS a GPU bo's texture. Set when the client's EGL window
   *  surface targets a GPU bo (`GLIO_CREATE_SURFACE` with a target bo).
   *  Non-null redirects the client's "bind default framebuffer 0" (its
   *  window) into the bo's FBO, so its GL output lands in the bo the
   *  compositor samples zero-copy. Owned by the bo, NOT this binding —
   *  never deleted on unbind (destroyed via `destroyGpuBo` on bo
   *  destroy). Null for canvas-backed (master) and CPU-tier sessions. */
  renderTargetFbo: WebGLFramebuffer | null;

  /** Target GPU bo_id captured at `GLIO_CREATE_SURFACE` but not yet
   *  applied, because the client created its window surface BEFORE its
   *  GL context (SDL2's Wayland+GLES backend creates the wl_egl_window
   *  surface during `SDL_CreateWindow`, then the context during
   *  `SDL_GL_CreateContext`). The redirect needs both `b.gl` (set at
   *  context creation) and the resolved bo, so whichever of the two
   *  runs last applies it. 0 = no pending target. */
  pendingRenderTargetBoId: number;

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
  texId: number;
  w: number;
  h: number;
};

export class GlContextRegistry {
  private bindings = new Map<number, GlBinding>();
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
    const forward = this.pendingForwards.get(b.pid) ?? null;
    this.pendingForwards.delete(b.pid);
    const canvas = this.pendingCanvases.get(b.pid) ?? null;
    this.pendingCanvases.delete(b.pid);
    this.bindings.set(b.pid, {
      ...b,
      cmdbufView: null,
      gl: null,
      canvas,
      contextId: null,
      surfaceId: null,
      buffers: new Map(),
      textures: new Map(),
      shaders: new Map(),
      programs: new Map(),
      vaos: new Map(),
      fbos: new Map(),
      rbos: new Map(),
      uniformLocations: new Map(),
      nextUniformLoc: 0,
      foreignTextures: new Map(),
      nextForeignTexId: 0x4000_0000,
      claimedKmsCrtc: null,
      currentProgram: null,
      renderTargetFbo: null,
      pendingRenderTargetBoId: 0,
      shadow: defaultShadow(),
      forward,
    });
    for (const l of this.listeners) l(b.pid, "bind");
  }

  unbind(pid: number): void {
    this.pendingForwards.delete(pid);
    const b = this.bindings.get(pid);
    if (!b) return;
    // The GL context can outlive the binding (a KMS canvas context is
    // shared with the vblank pump), so free the binding's foreign
    // textures deterministically instead of leaving them to context GC.
    for (const entry of b.foreignTextures.values()) {
      b.gl?.deleteTexture(entry.tex);
    }
    this.bindings.delete(pid);
    for (const l of this.listeners) l(pid, "unbind");
  }

  get(pid: number): GlBinding | undefined {
    return this.bindings.get(pid);
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
    const b = this.bindings.get(pid);
    if (b) b.cmdbufView = null;
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
    const b = this.bindings.get(pid);
    if (b) {
      b.canvas = canvas;
      return;
    }
    this.pendingCanvases.set(pid, canvas);
  }

  detachCanvas(pid: number): void {
    this.pendingCanvases.delete(pid);
    const b = this.bindings.get(pid);
    if (b) {
      b.canvas = null;
      b.gl = null;
    }
  }

  /** Bound canvas, or staged `pendingCanvases` entry if `attachCanvas`
   *  ran before `bind()`. Used by the worker entries' fork hook to
   *  propagate the parent's canvas to the child. */
  getCanvas(pid: number): HTMLCanvasElement | OffscreenCanvas | null {
    const b = this.bindings.get(pid);
    if (b?.canvas) return b.canvas;
    return this.pendingCanvases.get(pid) ?? null;
  }

  attachMainForward(pid: number, channel: GlForwardChannel): void {
    const b = this.bindings.get(pid);
    if (b) {
      b.forward = channel;
    } else {
      this.pendingForwards.set(pid, channel);
    }
  }

  detachMainForward(pid: number): void {
    this.pendingForwards.delete(pid);
    const b = this.bindings.get(pid);
    if (b) b.forward = null;
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
    if (!tex || !fbo) {
      if (tex) gl.deleteTexture(tex);
      if (fbo) gl.deleteFramebuffer(fbo);
      return null;
    }
    const prevTex = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
    const prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
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
    gl.bindTexture(gl.TEXTURE_2D, prevTex);
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo);
    const texId = this.nextGpuBoTexId++;
    this.gpuBos.set(bo_id, { gl, tex, fbo, texId, w, h });
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
    b.shadow.fbo = gpu.fbo;
    b.shadow.viewport = [0, 0, gpu.w, gpu.h];
    return true;
  }

  /** Release a GPU-tier bo's FBO + texture from its shared context.
   *  Called from `gbm_bo_destroy` alongside `dropForeignTexturesForBo`. */
  destroyGpuBo(bo_id: number): void {
    const entry = this.gpuBos.get(bo_id);
    if (!entry) return;
    this.gpuBos.delete(bo_id);
    entry.gl.deleteFramebuffer(entry.fbo);
    entry.gl.deleteTexture(entry.tex);
  }

  onChange(fn: GlChangeListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
}
