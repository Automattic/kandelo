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

  shadow: GlShadowState;

  forward: GlForwardChannel | null;
};

export type GlChangeEvent = "bind" | "unbind";
export type GlChangeListener = (pid: number, ev: GlChangeEvent) => void;

export class GlContextRegistry {
  private bindings = new Map<number, GlBinding>();
  private listeners = new Set<GlChangeListener>();
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
   *  `gbm_bo_destroy` hook when the bo refcount hits zero. */
  dropForeignTexturesForBo(bo_id: number): void {
    for (const b of this.bindings.values()) {
      const entry = b.foreignTextures.get(bo_id);
      if (!entry) continue;
      b.foreignTextures.delete(bo_id);
      b.textures.delete(entry.texId);
      b.gl?.deleteTexture(entry.tex);
    }
  }

  onChange(fn: GlChangeListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
}
