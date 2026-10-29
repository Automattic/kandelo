import { CpuImageStorage } from "./cpu-image-storage.js";
import { allocateGpuStorage, type GlGpuAllocation } from "./gpu-allocation.js";
import { revokeForeignBo } from "./foreign-retirement.js";
import { GlFenceOwner } from "./fences.js";
import type { GlClientArrayFields } from "./client-array.js";
import { repairNativeState, retireNativeRepair, retireNativeObject, reserveNativeRetirement, retireNativeRetirement, type NativeRetirement, type NativeDeletion } from "./native-recovery.js";
import { checkedGlCall } from "./program-objects.js";
import { captureNativeGlErrors } from "./errors.js";
import { destroyTextureView, destroyRenderbufferView } from "./image-storage.js";
import type { GlUniformLookup } from "./uniform-queries.js";
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
import { GlSubmitExecution, type GlExecutionDrawable } from "./submit-execution.js";
import type { GlMuxer } from "./muxer.js";
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
  /** Root EGL display's exact kernel DRM description, scoped to this kernel.
   * Omission is an independent embedder context with no DRM master rights. */
  displayFileId?: bigint | null;
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
  onCreateContext(sessionId?: number, shareSessionId?: number): number;
  onDestroyContext(sessionId?: number): void;
  onCreateSurface?(surface: GlSurfaceCreation, sessionId?: number): {rc: number; width: number; height: number};
  onDestroySurface?(surfaceId: number, sessionId?: number): void;
  onUnbind?(sessionId: number): void;
  onMakeCurrent?(drawable: GlDrawableBinding, sessionId?: number): number;
  onPresent?(sessionId?: number): number;
  onSubmit(bytes: Uint8Array, sessionId?: number): void;
  onQuery?(op: number, input: Uint8Array, outLen: number, sessionId?: number): { rc: number; bytes: Uint8Array };
};

export type GlBinding = GlBindingInput & GlSharedObjects & GlSurfaceFields & GlClientArrayFields & {
  surface: GlSurfaceResources;
  drawSurface: GlSurfaceResources | null;
  readSurface: GlSurfaceResources | null;
  sessionId: number;
  displayFileId: bigint | null;
  currentDrawable: GlDrawableBinding | null;
  /** Present only while an accepted work item selects its retained storage. */
  executionDrawable?: GlExecutionDrawable;
  hasBeenCurrent: boolean;
  /** Undefined means no driver savepoint; null captures the zero binding.
   * This pin survives submit boundaries and is never a public object name. */
  savedClientArrayBuffer: WebGLBuffer | null | undefined;
  uniformLookup: GlUniformLookup | null;
  uniformLookupSerial: number;
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
  /** Fence lifetime is independent of context-local state. */
  fences: GlFenceOwner;
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
export type GpuBo = GlGpuAllocation;

export type GlExecutionRetirementGuard = {
  readonly context: WebGL2RenderingContext;
  prepareRetirement(): boolean;
};

type ExecutionRecord = {
  binding: GlBinding;
  replacement: GlBinding;
  key: string;
  gl: WebGL2RenderingContext;
  canvas: GlBinding["canvas"];
  muxer: WeakRef<GlExecutionRetirementGuard>;
  references: number;
  retired: boolean;
  cleaned: boolean;
  cleanup: NativeRetirement | null;
  gpuBos: ReadonlyMap<number,GpuBo>;
  records: Set<ExecutionRecord>;
  contexts: WeakMap<GlBinding,ExecutionRecord>;
};

/** A public slot can be revoked/reused while accepted work owns its old
 * execution. No strong registry, kernel callback or retired guest view is
 * retained. Drawable allocation holds are separate per-work ownership. */
export class GlContextExecutionLease {
  #record: ExecutionRecord | null;
  #released = false;
  private constructor(record: ExecutionRecord) { this.#record = record; }
  static acquire(record: ExecutionRecord): GlContextExecutionLease | null {
    if (record.references >= Number.MAX_SAFE_INTEGER) return null;
    try { const lease = new GlContextExecutionLease(record); record.references++; return lease; }
    catch { return null; }
  }
  get context(): WebGL2RenderingContext | null { return this.#record?.gl ?? null; }
  get binding(): GlBinding {
    if (!this.#record || this.#released) throw new Error("Context execution lease is released");
    return this.#record.binding;
  }
  clone(): GlContextExecutionLease | null {
    return this.#record && !this.#released ? GlContextExecutionLease.acquire(this.#record) : null;
  }
  release(): boolean {
    const record = this.#record;
    if (!record) return true;
    if (!this.#released) { this.#released = true; record.references--; }
    if (record.retired && record.references === 0) {
      if (!collectExecution(record)) return false;
    } else if (!record.retired && record.references === 0) {
      record.records.delete(record); record.contexts.delete(record.binding);
    }
    this.#record = null;
    return true;
  }
}

function reserveExecutionCleanup(record: ExecutionRecord): NativeRetirement | null {
  const b = record.binding, calls: NativeDeletion[] = [];
  const seen = new Set<object>();
  const add = (call: NativeDeletion) => { if (call[1] && !seen.has(call[1])) { seen.add(call[1]); calls.push(call); } };
  const finalGroup = b.objects.members.size === 0 || (b.objects.members.size === 1 && b.objects.members.has(b));
  if (finalGroup) {
    for (const object of b.shaders.values()) add(["deleteShader",object]);
    for (const object of b.programs.values()) add(["deleteProgram",object]);
    add(["deleteProgram",b.currentProgram]);
  } else if (b.currentProgram && ![...b.programs.values()].includes(b.currentProgram) &&
      ![...b.objects.members].some(member => member !== b && member.currentProgram === b.currentProgram)) {
    add(["deleteProgram",b.currentProgram]);
  }
  for (const object of b.vaos.values()) add(["deleteVertexArray",object]);
  add(["deleteVertexArray",b.shadow.defaultVao]);
  for (const object of b.fbos.values()) add(["deleteFramebuffer",object]);
  add(["deleteFramebuffer",b.undefinedDefaultFbo]);
  for (const object of b.shadow.defaultTextures.values()) add(["deleteTexture",object]);
  return reserveNativeRetirement({gl:record.gl,errors:[]},calls);
}

function collectExecution(record: ExecutionRecord): boolean {
  if (!record.retired || record.references !== 0) return true;
  // A registry retry may already have completed this lease's cleanup.
  // Releasing its old token must not recapture or invalidate a new owner.
  if (record.cleaned && record.cleanup?.complete) {
    record.records.delete(record); record.contexts.delete(record.binding);
    return true;
  }
  try {
    const muxer = record.muxer.deref();
    if (muxer) { if (!muxer.prepareRetirement()) return false; }
    else captureNativeGlErrors(record.gl,null);
    if (!record.cleaned) {
      record.cleanup ??= reserveExecutionCleanup(record);
      if (!record.cleanup) return false;
      retireNativeRepair(record.gl,record.binding.shadow);
      if (!repairNativeState(record.gl)) return false;
      destroyContextResources(record.binding,record.gpuBos,record.cleanup);
      record.cleaned = true;
    }
    const cleanup = record.cleanup!;
    const installed = record.gl.getParameter(0x8b8d) as WebGLProgram | null;
    if (installed && cleanup.calls.some(call => call[0] === "deleteProgram" && call[1] === installed) &&
        !checkedGlCall(cleanup.owner,()=>record.gl.useProgram(null))) return false;
    if (!cleanup.pending) {
      if (!retireNativeRetirement(cleanup)) return false;
    } else if (!repairNativeState(record.gl) || !cleanup.complete) return false;
    record.records.delete(record); record.contexts.delete(record.binding);
    return true;
  } catch { return false; }
}

export class GlContextRegistry {
  private bindings = new Map<string, GlBinding>();
  private executions = new WeakMap<GlBinding, ExecutionRecord>();
  private executionRecords = new Set<ExecutionRecord>();
  private listeners = new Set<GlChangeListener>();
  /** GPU-tier bos keyed by bo_id. Registry-scoped (NOT per-binding):
   *  the texture is owned by the bo and shared across every session that
   *  binds it, so it is freed only on bo destroy, never on `unbind()`. */
  private gpuBos = new Map<number, GpuBo>();
  readonly cpuImages = new CpuImageStorage();
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
    const binding = this.newBinding(b,canvas,forward);
    this.bindings.set(`${binding.pid}:${sessionId}`, binding);
    for (const l of this.listeners) l(b.pid, "bind");
  }

  private newBinding(b: GlBindingInput, canvas: GlBinding["canvas"], forward: GlForwardChannel | null): GlBinding {
    const sessionId = (b.sessionId ?? 0) >>> 0;
    const binding: GlBinding = exposeSurfaceResources(exposeGlSharedObjects({
      surface: createSurfaceResources(b.pid), drawSurface: null, readSurface: null,
      objects: createGlObjectGroup(),
      pid: b.pid, cmdbufAddr: b.cmdbufAddr, cmdbufLen: b.cmdbufLen,
      sessionId,
      displayFileId: b.displayFileId ?? null,
      currentDrawable: null,
      hasBeenCurrent: false,
      savedClientArrayBuffer: undefined,
      uniformLookup: null,
      uniformLookupSerial: 0,
      undefinedDefaultFbo: null,
      cmdbufView: null,
      gl: null,
      fences: new GlFenceOwner(),
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
    return binding;
  }

  /** Reserve the replacement public slot and retirement bookkeeping before a
   * caller acknowledges work that can outlive this public context. */
  retainContextExecution(pid: number, sessionId: number, muxer: GlExecutionRetirementGuard): GlContextExecutionLease | null {
    const b = this.get(pid,sessionId);
    if (!b?.gl || b.contextId === null || b.forward || muxer.context !== b.gl) return null;
    let record = this.executions.get(b);
    try {
      if (!record) {
        const replacement = this.newBinding({pid:b.pid,sessionId:b.sessionId,cmdbufAddr:b.cmdbufAddr,
          cmdbufLen:b.cmdbufLen},b.canvas,b.forward);
        record = {binding:b,replacement,key:`${b.pid}:${b.sessionId}`,gl:b.gl,canvas:b.canvas,muxer:new WeakRef(muxer),
          references:0,retired:false,cleaned:false,cleanup:null,records:this.executionRecords,
          contexts:this.executions,gpuBos:this.gpuBos};
        this.executionRecords.add(record);
        try { this.executions.set(b,record); }
        catch (error) { this.executionRecords.delete(record); throw error; }
      } else if (record.retired || record.muxer.deref() !== muxer) return null;
      const lease = GlContextExecutionLease.acquire(record);
      if (!lease && record.references === 0) {
        this.executionRecords.delete(record); this.executions.delete(b);
      }
      return lease;
    } catch { return null; }
  }

  retainSubmitExecution(binding: GlBinding, muxer: GlMuxer): GlSubmitExecution | null {
    if (this.get(binding.pid, binding.sessionId) !== binding) return null;
    return GlSubmitExecution.capture(this, binding, muxer);
  }

  /** Only failed, unreferenced retirement blocks admission on its physical
   * context. Retained execution is deliberate ownership, not a repair error. */
  retryExecutionRetirements(gl?: WebGL2RenderingContext): boolean {
    let complete = true;
    for (const record of this.executionRecords) if (record.retired && record.references === 0 && (!gl || record.gl === gl))
      complete = collectExecution(record) && complete;
    return complete;
  }

  unbind(pid: number, sessionId?: number): void {
    if (sessionId !== undefined) sessionId >>>= 0;
    let failure: unknown;
    for (const b of this.list()) {
      if (b.pid !== pid || (sessionId !== undefined && b.sessionId !== sessionId)) continue;
      b.cmdbufView = null;
      const forward = b.forward;
      try {
        this.retireContextBinding(b,false);
        retireSurface(b.surface);
        forward?.onUnbind?.(b.sessionId);
      } catch (error) {
        failure ??= error;
      } finally {
        b.fences.close();
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

  /** Public lookup ends immediately. Accepted work may retain old execution;
   * shared objects survive until their final execution/group owner retires. */
  destroyContext(pid: number, sessionId?: number): void {
    const b = this.get(pid, sessionId);
    if (!b) return;
    this.retireContextBinding(b,true);
  }

  private retireContextBinding(b: GlBinding, replace: boolean): void {
    const record = this.executions.get(b);
    if (record && record.references > 0) {
      const next = record.replacement;
      next.canvas = b.canvas;
      next.forward = b.forward;
      if (b.surfaceId !== null) next.surface = b.surface;
      next.fences = b.fences;
      next.objects.nextUniformLoc = b.objects.nextUniformLoc;
      next.objects.nextForeignTexId = b.objects.nextForeignTexId;
      next.objects.nextImageSource = b.objects.nextImageSource;
      if (replace) this.bindings.set(record.key,next);
      // The retired execution owns native/scalar state, never the session's
      // borrowed guest cache or its forwarding transport.
      b.cmdbufView = null; b.forward = null; b.canvas = record.canvas;
      record.retired = true;
      return;
    }
    destroyContextResources(b,this.gpuBos);
    this.retryForeignRetirements();
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

  /** Construction only: the kernel validates process/display authority.
   * Bindings, containers and errors remain local to each group member. */
  shareObjects(pid: number, targetSession: number, sourceSession: number): boolean {
    const target = this.get(pid,targetSession), source = this.get(pid,sourceSession);
    if (!target || !source || target === source || !target.gl || target.gl !== source.gl
        || target.contextId === null || source.contextId === null || target.hasBeenCurrent || target.savedClientArrayBuffer !== undefined
        || target.uniformLookup !== null || target.objects.members.size !== 1) return false;
    const names = target.objects;
    if (names.bufferRetirements.size || names.imageRetirements.size || names.buffers.size || names.bufferStores.size || names.textures.size || names.shaders.size || names.programs.size
        || names.rbos.size || names.imageSources.size || names.textureViews.size || names.renderbufferViews.size || names.uniformMetadata.size || names.uniformLocationNames.size || names.uniformLocations.size || names.foreignTextures.size
        || names.retiredTextures.size || names.retiredBuffers.size || names.retiredRenderbuffers.size
        || names.shaderDeletePending.size || names.programDeletePending.size) return false;
    // Reserve membership before removing the old owner; allocation failure
    // must not strand the target between groups.
    source.objects.members.add(target);
    names.members.delete(target);
    target.objects = source.objects;
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
  private foreignRetirements = new Map<number, Map<GlObjectGroup, GlBinding>>();

  /** A cleanup-only view retains the original group/native context across
   * member retirement. It never enters command dispatch or guest authority. */
  private foreignRetirementOwners(bo: number): Map<GlObjectGroup, GlBinding> {
    let owners = this.foreignRetirements.get(bo);
    if (!owners) { owners = new Map(); this.foreignRetirements.set(bo,owners); }
    const bindings = new Set([...this.bindings.values(),...Array.from(this.executionRecords,record=>record.binding)]);
    for (const b of bindings) if (b.gl && !owners.has(b.objects)) {
      const cleanup = exposeGlSharedObjects({objects:b.objects,gl:b.gl,errors:b.errors});
      owners.set(b.objects,cleanup as GlBinding);
    }
    return owners;
  }
  dropForeignTexturesForBo(bo: number): boolean {
    const pending = this.foreignRetirements.has(bo);
    let accepted = true;
    for (const b of this.foreignRetirementOwners(bo).values()) accepted = revokeForeignBo(b,bo) && accepted;
    if (accepted && !pending) this.foreignRetirements.delete(bo);
    return accepted;
  }
  retireForeignBo(bo: number): void {
    this.foreignRetirementOwners(bo);
    if (this.dropForeignTexturesForBo(bo) && this.destroyGpuBo(bo) && this.cpuImages.retire(bo)) this.foreignRetirements.delete(bo);
  }
  retryForeignRetirements(): void {
    for (const bo of this.foreignRetirements.keys()) this.retireForeignBo(bo);
  }
  hasForeignRetirements(): boolean { return this.foreignRetirements.size !== 0; }
  *foreignRetirementContexts(): Iterable<WebGL2RenderingContext> {
    for (const owners of this.foreignRetirements.values()) for (const b of owners.values()) if (b.gl) yield b.gl;
  }
  groupHasForeignRetirement(b: GlBinding): boolean {
    for (const bo of b.foreignTextureBos.values()) if (this.foreignRetirements.has(bo)) return true;
    for (const source of b.imageSources.values()) if (this.foreignRetirements.has(source.bo)) return true;
    return false;
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
    if (!Number.isInteger(bo_id) || bo_id <= 0 || bo_id > 0xffff_ffff ||
        !Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0 ||
        w > 0x7fff_ffff || h > 0x7fff_ffff || gl.isContextLost?.() ||
        this.foreignRetirements.has(bo_id)) return null;
    if (!this.retryExecutionRetirements(gl) || !repairNativeState(gl)) return null;
    const existing = this.gpuBos.get(bo_id);
    if (existing) return !existing.retirement.pending && existing.gl === gl && existing.w === w && existing.h === h
      ? existing.texId : null;
    if (this.nextGpuBoTexId > 0x7fff_ffff) return null;
    const texId = this.nextGpuBoTexId;
    return allocateGpuStorage(gl,w,h,texId,allocation=>{
      this.gpuBos.set(bo_id,allocation);
      this.nextGpuBoTexId++;
    }) ? texId : null;
  }

  /** The GPU-tier bo for `bo_id`, or undefined if it is CPU-tier /
   *  unknown or retiring. Foreign-texture binding uses its private canonical
   *  storage to construct a distinct logical view without a CPU upload. */
  gpuBo(bo_id: number): GpuBo | undefined {
    const entry = this.gpuBos.get(bo_id);
    return this.foreignRetirements.has(bo_id) || entry?.retirement.pending ? undefined : entry;
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
    const gpu = this.gpuBo(b.pendingRenderTargetBoId);
    if (!gpu || b.gl !== gpu.gl) return false;
    b.surface.borrowedTarget = {gl:gpu.gl,fbo:gpu.fbo,w:gpu.w,h:gpu.h,retirement:gpu.retirement};
    b.renderTargetFbo = gpu.fbo;
    replaceDefaultFramebuffer(b, null);
    if (!b.hasBeenCurrent) b.shadow.viewport = [0, 0, gpu.w, gpu.h];
    return true;
  }

  /** Release a GPU-tier bo's FBO + texture from its shared context.
   *  Called from `gbm_bo_destroy` alongside `dropForeignTexturesForBo`. */
  destroyGpuBo(bo_id: number): boolean {
    const entry = this.gpuBos.get(bo_id);
    if (!entry) return true;
    const complete = retireNativeRetirement(entry.retirement);
    // Public BO ownership can end while accepted work retains its allocation.
    // A rejected unheld deletion stays addressable only for cleanup retries.
    if (complete || entry.retirement.references !== 0) {
      this.gpuBos.delete(bo_id);
      return true;
    }
    return false;
  }

  onChange(fn: GlChangeListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
}

function destroyContextResources(b: GlBinding, gpuBos: ReadonlyMap<number,GpuBo>, cleanup?: NativeRetirement): void {
  const gl = b.gl;
  if (gl) retireNativeRepair(gl, b.shadow);
  b.uniformLookup = null;
  b.uniformLookupSerial = 0;
  b.shaderUpload = null;
  b.shaderUploadSerial = 0;
  b.savedClientArrayBuffer = undefined;
  b.clientArrayRestore = undefined;
  b.clientArrayEndRequested = false;
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
    const boTextures = new Set([...gpuBos.values()].map(bo => bo.tex));
    const textures = new Set([
      ...b.textures.values(), ...[...b.foreignTextures.values()].map(entry => entry.tex),
    ]);
    for (const texture of textures) {
      if (gl && (!boTextures.has(texture)||b.textureViews.has(texture))) {
        const accepted = destroyTextureView(b,texture);
        if (cleanup && !accepted) throw new Error("Texture retirement remains pending");
      }
      if (cleanup) {
        for (const [name,value] of b.textures) if (value === texture) b.textures.delete(name);
        for (const [name,value] of b.foreignTextures) if (value.tex === texture) b.foreignTextures.delete(name);
      }
    }
    for (const object of new Set(b.buffers.values())) if (gl) {
      const accepted = destroyBufferStorage(b,object);
      if (cleanup && !accepted) throw new Error("Buffer retirement remains pending");
      if (cleanup) for (const [name,value] of b.buffers) if (value === object) b.buffers.delete(name);
    }
    if (!cleanup) for (const object of b.shaders.values()) gl?.deleteShader(object);
    if (!cleanup) for (const object of programs) gl?.deleteProgram(object);
    for (const object of new Set(b.rbos.values())) if (gl) {
      const accepted = destroyRenderbufferView(b,object);
      if (cleanup && !accepted) throw new Error("Renderbuffer retirement remains pending");
      if (cleanup) for (const [name,value] of b.rbos) if (value === object) b.rbos.delete(name);
    }
    for (const map of [b.buffers,b.textures,b.shaders,b.programs,b.rbos,b.uniformLocations,
      b.uniformLocationPrograms,b.uniformLocationNames,b.uniformMetadata,b.programShaders,b.programAttributeBindings,b.foreignTextures,b.shaderSources]) map.clear();
    b.imageSources.clear();
    b.shaderDeletePending.clear(); b.programDeletePending.clear();
  } else {
    if (installedName) finalizeProgram(b, installedName);
    if (retained && !cleanup) releaseRetainedExecutable(b, installed);
  }
  if (!cleanup) for (const object of b.vaos.values()) gl?.deleteVertexArray(object);
  for (const object of b.fbos.values()) if (gl && !cleanup) { retireNativeObject(gl,object); gl.deleteFramebuffer(object); }
  b.vaos.clear(); b.fbos.clear();
  b.framebufferAttachments.clear();
  b.vertexArrays.clear();
  collectRetiredImages(b);
  collectRetiredBuffers(b);
  b.objects = createGlObjectGroup();
  b.objects.nextUniformLoc = objects.nextUniformLoc;
  b.objects.nextForeignTexId = objects.nextForeignTexId;
  b.objects.nextImageSource = objects.nextImageSource;
  b.objects.members.add(b);
  // Late native cleanup still owns the retired error flags. A reused
  // session must receive a fresh owner rather than inheriting those errors.
  b.errors = [];
  if (gl && b.undefinedDefaultFbo && !cleanup) { retireNativeObject(gl,b.undefinedDefaultFbo); gl.deleteFramebuffer(b.undefinedDefaultFbo); }
  b.undefinedDefaultFbo = null;
  if (b.shadow.defaultVao) {
    if (!cleanup) b.gl?.deleteVertexArray(b.shadow.defaultVao);
    b.shadow.defaultVao = null;
  }
  if (!cleanup) for (const texture of b.shadow.defaultTextures.values()) gl?.deleteTexture(texture);
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
