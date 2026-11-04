import { retireContextProgramCaptures, retireLastPublicProgramCaptures } from "./program-captures.js";
import { forgetRendererLoss, rendererObjectEpoch } from "./renderer-loss.js";
import { cubeExtraTextures } from "./cube-storage.js";
import type { GlObjectCapture } from "./object-capture.js";
import type { GlCompressedUpload } from "./compressed-upload.js";
import type { GlReadbackCapture } from "./readback-capture.js";
import { isKernelExportFailure } from "../kernel-entry-gate.js";
import { CpuImageStorage } from "./cpu-image-storage.js";
import type { GbmBoRegistry } from "../dri/registry.js";
import { allocateGpuStorage, type GlGpuAllocation } from "./gpu-allocation.js";
import { gpuStorageFormat } from "./gpu-storage-format.js";
import { clearStorageAlphaToOne, setOpaqueAlphaStorage } from "./opaque-alpha.js";
import { revokeForeignBo } from "./foreign-retirement.js";
import { GlOperationStream } from "./operation-stream.js";
import { GlFenceOwner } from "./fences.js";
import type { GlClientArrayFields } from "./client-array.js";
import { repairNativeState, retireNativeRepair, retireNativeObject, reserveNativeRetirement, retireNativeRetirement, nativeGlFault, NativeGlFault, type NativeRetirement, type NativeDeletion, rethrowNativeGlFault } from "./native-recovery.js";
import { checkedGlCall } from "./program-objects.js";
import { captureNativeGlErrors } from "./errors.js";
import { destroyTextureView, destroyRenderbufferView, retireExportedImage, type GlExportedImage } from "./image-storage.js";
import type { GlUniformUpload } from "./uniform-upload.js";
import { replaceUniformLookup, type GlUniformLookup } from "./uniform-queries.js";
/**
 * Tracks live `/dev/dri/renderD128` GLES sessions reported by the kernel.
 *
 * Each kernel GL session owns an independent binding within its process.
 * Process-only lookups refuse ambiguity instead of selecting another session.
 * Each binding owns:
 *
 *   - the cmdbuf region (a slice of the process's wasm Memory SAB),
 *   - a lazily-built `WebGL2RenderingContext` once a canvas is attached,
 *   - object-group maps for shareable GL names,
 *   - context-local state, errors, VAOs and framebuffer containers.
 *
 * The cmdbuf view is built lazily on the first `host_gl_submit` and
 * invalidated on `WebAssembly.Memory.grow()` via `rebindMemory(pid)`,
 * mirroring the framebuffer registry's pattern.
 *
 * Uniform locations belong to native executables, not to bindings or
 * groups: each program numbers its own uniforms (uniform-layout.ts).
 */
import { defaultShadow, type GlShadowState } from "./shadow.js";
import type { GlDrawableBinding } from "./current.js";
import { GlSubmitExecution, type GlExecutionDrawable } from "./submit-execution.js";
import type { GlMuxer } from "./muxer.js";
import { replaceDefaultFramebuffer } from "./framebuffer.js";
import { framebufferInputsChanged } from "./framebuffer-revision.js";
import { createGlObjectGroup, exposeGlSharedObjects, type GlObjectGroup, type GlSharedObjects } from "./object-group.js";
import { finalizeProgram, releaseRetainedExecutable, retireProgramNameOwner } from "./program-objects.js";
import { releaseReversedDepthTwin } from "./reversed-depth.js";
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
  uniformUpload: GlUniformUpload | null;
  uniformUploadSerial: number;
  uniformLookup: GlUniformLookup | null;
  uniformLookupSerial: number;
  compressedUpload: GlCompressedUpload | null;
  compressedUploadSerial: number;
  shaderUpload: GlShaderSourceUpload | null;
  shaderUploadSerial: number;
  objectCapture: GlObjectCapture | null;
  objectCaptureSerial: number;
  readbackCapture: GlReadbackCapture | null;
  readbackCaptureSerial: number;
  /** No attachments: native framebuffer operations enforce surfaceless
   * incompleteness. This object never has a guest-visible name. */
  undefinedDefaultFbo: WebGLFramebuffer | null;
  /** Private ARRAY_BUFFER that client-array draws upload into
   * (private-client-draw.ts); created on first use, deleted with the
   * context. Never a guest name. */
  clientArrayStream: WebGLBuffer | null;
  /** Lazy view of `[cmdbufAddr, cmdbufAddr+cmdbufLen)` of the process's
   *  wasm Memory SAB. Built on the first submit and dropped to `null`
   *  by `rebindMemory` after a `Memory.grow()`. */
  cmdbufView: Uint8Array | null;

  /** Live WebGL2 context, lazily constructed at `host_gl_create_context`
   *  time once the embedder has attached a canvas. */
  gl: WebGL2RenderingContext | null;
  /** Fence lifetime is independent of context-local state. */
  fences: GlFenceOwner;
  operations: GlOperationStream;
  /** The canvas backing this binding's WebGL2 context. Set by
   *  `attachCanvas` before the program calls `eglCreateContext`. */
  canvas: HTMLCanvasElement | OffscreenCanvas | null;

  /** Kernel-issued EGL backend context identity. */
  contextId: GlContextHandle | null;
  /** Created with EGL robust buffer access (robust-access.ts): every draw
   * keeps native vertex fetches in range instead of WebGL's error. */
  robustAccess: boolean;

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
    catch (caught) { rethrowNativeGlFault(caught); return null; }
  }
  get context(): WebGL2RenderingContext | null { return this.#record?.gl ?? null; }
  get retired(): boolean { return this.#record?.retired ?? false; }
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
    const releasedNow=!this.#released;
    if (releasedNow) { this.#released = true; record.references--; }
    if (record.retired && record.references === 0) collectExecution(record);
    else if (!record.retired && record.references === 0) {
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
  add(["deleteBuffer",b.clientArrayStream]);
  for (const object of b.shadow.defaultTextures.values()) {
    add(["deleteTexture",object]);
    // Texture zero of TEXTURE_CUBE_MAP may own more 2D array storage (cube-storage.ts).
    for (const storage of cubeExtraTextures(object)) add(["deleteTexture",storage]);
  }
  return reserveNativeRetirement({gl:record.gl,errors:[],nativeEpoch:rendererObjectEpoch(b)},calls);
}

/** Delete a retired context's native objects once its last accepted
 * execution ends. Each step completes or is a NativeGlFault: nothing retries
 * this later. A lost renderer's objects are dropped without native calls
 * (native-recovery.ts). */
function collectExecution(record: ExecutionRecord): void {
  if (!record.retired || record.references !== 0) return;
  try {
    const muxer = record.muxer.deref();
    if (muxer) {
      if (!muxer.prepareRetirement()) nativeGlFault("could not read the selected owner's error flags before retiring a context");
    } else captureNativeGlErrors(record.gl,null);
    const cleanup = reserveExecutionCleanup(record) ?? nativeGlFault("could not reserve a retired context's native cleanup");
    retireNativeRepair(record.gl,record.binding.shadow);
    if (!repairNativeState(record.gl)) nativeGlFault("a retired context's cleanup ran inside an in-flight native change");
    destroyContextResources(record.binding,record.gpuBos,cleanup);
    const installed = record.gl.getParameter(0x8b8d) as WebGLProgram | null;
    if (installed && cleanup.calls.some(call => call[0] === "deleteProgram" && call[1] === installed) &&
        !checkedGlCall(cleanup.owner,()=>record.gl.useProgram(null)) && !record.gl.isContextLost?.())
      nativeGlFault("the live renderer refused to uninstall a retired context's program");
    if (!retireNativeRetirement(cleanup)) nativeGlFault("a retired context's native objects were not deleted");
    record.records.delete(record); record.contexts.delete(record.binding);
  } catch(error) {
    if (error instanceof NativeGlFault || isKernelExportFailure(error)) throw error;
    nativeGlFault("retiring a context's native objects threw", error);
  }
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
  /** Canvases attached before `bind()` fires; drained on bind. Without this, an embedder that calls
   *  `attachCanvas(pid, …)` synchronously after `spawn()` would race
   *  the program's own `eglInitialize → host_gl_bind` and silently
   *  drop the canvas, leaving every subsequent submit a no-op. */
  private pendingCanvases = new Map<number, HTMLCanvasElement | OffscreenCanvas>();

  bind(b: GlBindingInput): void {
    const canvas = this.getCanvas(b.pid);
    this.pendingCanvases.delete(b.pid);
    const sessionId = (b.sessionId ?? 0) >>> 0;
    if (this.get(b.pid, sessionId)) throw new Error("GL session is already bound");
    const binding = this.newBinding(b,canvas);
    this.bindings.set(`${binding.pid}:${sessionId}`, binding);
    for (const l of this.listeners) l(b.pid, "bind");
  }

  private newBinding(b: GlBindingInput, canvas: GlBinding["canvas"]): GlBinding {
    const sessionId = (b.sessionId ?? 0) >>> 0;
    const operations = new GlOperationStream();
    const binding: GlBinding = exposeSurfaceResources(exposeGlSharedObjects({
      surface: createSurfaceResources(b.pid), drawSurface: null, readSurface: null,
      objects: createGlObjectGroup(),
      pid: b.pid, cmdbufAddr: b.cmdbufAddr, cmdbufLen: b.cmdbufLen,
      sessionId,
      displayFileId: b.displayFileId ?? null,
      currentDrawable: null,
      hasBeenCurrent: false,
      savedClientArrayBuffer: undefined,
      uniformUpload: null,
      uniformUploadSerial: 0,
      uniformLookup: null,
      uniformLookupSerial: 0,
      undefinedDefaultFbo: null,
      clientArrayStream: null,
      cmdbufView: null,
      gl: null,
      fences: new GlFenceOwner({pid:b.pid,sessionId,operations}),
      operations,
      canvas,
      contextId: null,
      robustAccess: false,
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
      compressedUpload: null,
      compressedUploadSerial: 0,
      shaderUpload: null,
      shaderUploadSerial: 0,
      objectCapture: null,
      objectCaptureSerial: 0,
      readbackCapture: null,
      readbackCaptureSerial: 0,
    }));
    binding.objects.members.add(binding);
    return binding;
  }

  /** Reserve the replacement public slot and retirement bookkeeping before a
   * caller acknowledges work that can outlive this public context. */
  retainContextExecution(pid: number, sessionId: number, muxer: GlExecutionRetirementGuard): GlContextExecutionLease | null {
    const b = this.get(pid,sessionId);
    if (!b?.gl || b.contextId === null || muxer.context !== b.gl) return null;
    let record = this.executions.get(b);
    try {
      if (!record) {
        const replacement = this.newBinding({pid:b.pid,sessionId:b.sessionId,cmdbufAddr:b.cmdbufAddr,
          cmdbufLen:b.cmdbufLen},b.canvas);
        record = {binding:b,replacement,key:`${b.pid}:${b.sessionId}`,gl:b.gl,canvas:b.canvas,muxer:new WeakRef(muxer),
          references:0,retired:false,records:this.executionRecords,
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
    } catch (caught) { rethrowNativeGlFault(caught); return null; }
  }

  retainSubmitExecution(binding: GlBinding, muxer: GlMuxer): GlSubmitExecution | null {
    if (this.get(binding.pid, binding.sessionId) !== binding) return null;
    return GlSubmitExecution.capture(this, binding, muxer);
  }

  /** Retire every matching session. Public lookup always ends. Returns
   * false when accepted execution still holds a retired context's native
   * objects, which that execution releases when it finishes; true when all
   * native state was released now. Throws the first native cleanup fault. */
  unbind(pid: number, sessionId?: number): boolean {
    if (sessionId !== undefined) sessionId >>>= 0;
    let failure: unknown;
    let released = true;
    for (const b of this.list()) {
      if (b.pid !== pid || (sessionId !== undefined && b.sessionId !== sessionId)) continue;
      b.cmdbufView = null;
      b.operations.close();
      try {
        if (!this.retireContextBinding(b,false)) released = false;
        retireSurface(b.surface);
      } catch (error) { rethrowNativeGlFault(error);
        failure ??= error;
      } finally {
        b.fences.close();
        this.bindings.delete(`${pid}:${b.sessionId}`);
      }
      for (const l of this.listeners) l(pid, "unbind");
    }
    if (sessionId === undefined || !this.list().some(b => b.pid === pid)) {
      this.pendingCanvases.delete(pid);
    }
    if (failure) throw failure;
    return released;
  }

  /** Public lookup ends immediately. Accepted work may retain old execution;
   * shared objects survive until their final execution/group owner retires. */
  destroyContext(pid: number, sessionId?: number): void {
    const b = this.get(pid, sessionId);
    if (!b) return;
    this.retireContextBinding(b,true);
  }

  /** True when native resources were destroyed now; false when an accepted
   * execution retains them and retires them when it completes. */
  private retireContextBinding(b: GlBinding, replace: boolean): boolean {
    retireContextProgramCaptures(b);
    retireLastPublicProgramCaptures(b,this.bindings.values());
    // Copied replies own no native execution; public context retirement revokes
    // their private transfer immediately, even while native work is retained.
    b.objectCapture = null; b.readbackCapture = null;
    b.compressedUpload = null;
    const record = this.executions.get(b);
    if (record && record.references > 0) {
      // An accepted execution retains native state, never a destroyed public
      // context's program-name reference. Keep its installed executable for
      // that execution while making delete-pending names disappear on time.
      retireProgramNameOwner(b);
      const next = record.replacement;
      next.canvas = b.canvas;
      if (b.surfaceId !== null) next.surface = b.surface;
      next.fences = b.fences;
      next.operations = b.operations;
      next.objects.nextForeignTexId = b.objects.nextForeignTexId;
      next.objects.nextImageSource = b.objects.nextImageSource;
      if (replace) this.bindings.set(record.key,next);
      // Pending compressed staging has no native effect and cannot survive
      // retirement into a replacement logical context, even while an earlier
      // accepted execution retains its native repair/retirement leases.
      b.compressedUpload = null;
      // The retired execution owns native/scalar state, never the session's
      // borrowed guest cache.
      b.cmdbufView = null; b.canvas = record.canvas;
      record.retired = true;
      return false;
    }
    destroyContextResources(b,this.gpuBos);
    return true;
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
        || target.compressedUpload !== null || target.uniformUpload !== null || target.uniformLookup !== null || target.objectCapture !== null || target.readbackCapture !== null || target.objects.members.size !== 1) return false;
    const names = target.objects;
    if (names.bufferRetirements.size || names.imageRetirements.size || names.buffers.size || names.bufferStores.size || names.textures.size || names.shaders.size || names.programs.size
        || names.rbos.size || names.programQueryPins.size || names.imageSources.size || names.textureViews.size || names.renderbufferViews.size || names.foreignTextures.size
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
    for (const b of this.list()) if (b.pid === pid) { b.objectCapture = null; b.readbackCapture = null; b.compressedUpload = null; b.canvas = null; b.gl = null; }
  }

  /** Bound canvas, or staged `pendingCanvases` entry if `attachCanvas`
   *  ran before `bind()`. Used by the worker entries' fork hook to
   *  propagate the parent's canvas to the child. */
  getCanvas(pid: number): HTMLCanvasElement | OffscreenCanvas | null {
    const b = this.list().find(b => b.pid === pid && b.canvas);
    if (b?.canvas) return b.canvas;
    return this.pendingCanvases.get(pid) ?? null;
  }

  /** Delete every binding's foreign texture for a destroyed bo (the bo
   *  is the texture's canonical owner — see shared's
   *  `DRM_IOCTL_WPK_BIND_FOREIGN_TEXTURE` doc). Called from the host's
   *  `gbm_bo_destroy` hook when the bo refcount hits zero.
   *
   *  This DELIBERATELY leaves `gpuBos` untouched: a GPU-tier bo's texture
   *  is owned by the bo itself (this registry), not by any binding, and
   *  is released only via `destroyGpuBo` on bo destroy. */
  /** Every object group that can hold a native view of a BO, including
   * groups whose public context is gone but whose accepted execution still
   * owns the native context. A cleanup-only view never enters command
   * dispatch or guest authority. */
  private foreignViewOwners(): GlBinding[] {
    const owners = new Map<GlObjectGroup, GlBinding>();
    const bindings = new Set([...this.bindings.values(),...Array.from(this.executionRecords,record=>record.binding)]);
    for (const b of bindings) if (b.gl && !owners.has(b.objects))
      owners.set(b.objects, exposeGlSharedObjects({objects:b.objects,gl:b.gl,errors:b.errors}) as GlBinding);
    return [...owners.values()];
  }
  /** Delete every native view and allocation of a destroyed bo: foreign
   * textures in every group, its GPU-tier storage, CPU-image mirrors and an
   * exported image. False when a native deletion was refused. */
  retireForeignBo(bo: number): boolean {
    return this.dropForeignTexturesForBo(bo) && this.destroyGpuBo(bo) && this.cpuImages.retire(bo) && this.retireExportedBo(bo);
  }
  /** Revoke every group's foreign texture views of `bo`. */
  dropForeignTexturesForBo(bo: number): boolean {
    let complete = true;
    for (const b of this.foreignViewOwners()) complete = revokeForeignBo(b,bo) && complete;
    return complete;
  }
  /** Exported GLES images keyed by their GPU-tier bo (EXPORT_IMAGE). The
   *  record owns the source object's storage once the object stops using
   *  it; bo retirement releases it. */
  private exportedImages = new Map<number, GlExportedImage>();
  publishExportedImage(record: GlExportedImage): void { this.exportedImages.set(record.bo, record); }
  exportedImage(bo: number): GlExportedImage | undefined {
    const record = this.exportedImages.get(bo);
    return record?.boLive ? record : undefined;
  }
  /** The GPU-tier storage KMS presents for `bo`: a GBM GPU bo or an
   *  exported GLES image (exportedImageScanout gives the latter's reader). */
  scanoutSource(bo: number): GpuBo | GlExportedImage | undefined {
    return this.gpuBo(bo) ?? this.exportedImage(bo);
  }
  private retireExportedBo(bo: number): boolean {
    const record = this.exportedImages.get(bo);
    if (!record) return true;
    if (!retireExportedImage(record)) return false;
    this.exportedImages.delete(bo);
    return true;
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
    format = 0x34324241,
  ): number | null {
    if (!Number.isInteger(bo_id) || bo_id <= 0 || bo_id > 0xffff_ffff ||
        !Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0 ||
        w > 0x7fff_ffff || h > 0x7fff_ffff || gl.isContextLost?.()) return null;
    if (!repairNativeState(gl)) return null;
    const existing = this.gpuBos.get(bo_id);
    if (existing) return !existing.retirement.pending && existing.gl === gl && existing.w === w && existing.h === h
      ? existing.texId : null;
    if (this.nextGpuBoTexId > 0x7fff_ffff) return null;
    // The kernel admits only formats with exact texture storage.
    const storage = gpuStorageFormat(format);
    if (!storage) throw new Error(`GPU BO ${bo_id} has no texture storage for format ${format}`);
    const texId = this.nextGpuBoTexId;
    if (!allocateGpuStorage(gl,w,h,texId,allocation=>{
      this.gpuBos.set(bo_id,allocation);
      this.nextGpuBoTexId++;
    },storage)) return null;
    // A format without alpha lives in storage with alpha: alpha starts at
    // 1.0 and is never written (opaque-alpha.ts).
    if (storage.opaque) {
      const allocation = this.gpuBos.get(bo_id)!;
      if (!checkedGlCall({gl,errors:[]},()=>clearStorageAlphaToOne(gl,
          target=>gl.framebufferTexture2D(target,0x8ce0,0x0de1,allocation.tex,0)))) {
        this.destroyGpuBo(bo_id); return null;
      }
      setOpaqueAlphaStorage(allocation.tex,true);
    }
    return texId;
  }

  /** The GPU-tier bo for `bo_id`, or undefined if it is CPU-tier /
   *  unknown or retiring. Foreign-texture binding uses its private canonical
   *  storage to construct a distinct logical view without a CPU upload. */
  gpuBo(bo_id: number): GpuBo | undefined {
    const entry = this.gpuBos.get(bo_id);
    return entry?.retirement.pending ? undefined : entry;
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
  b.uniformUpload = null;
  b.uniformUploadSerial = 0;
  replaceUniformLookup(b,null);
  b.uniformLookupSerial = 0;
  b.compressedUpload = null;
  b.compressedUploadSerial = 0;
  b.shaderUpload = null;
  b.shaderUploadSerial = 0;
  b.objectCapture = null; b.readbackCapture = null;
  b.objectCaptureSerial = 0;
  b.readbackCaptureSerial = 0;
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
    if (!cleanup) for (const object of programs) {
      gl?.deleteProgram(object);
      if (gl) releaseReversedDepthTwin({gl,errors:[]},object);
    }
    for (const object of new Set(b.rbos.values())) if (gl) {
      const accepted = destroyRenderbufferView(b,object);
      if (cleanup && !accepted) throw new Error("Renderbuffer retirement remains pending");
      if (cleanup) for (const [name,value] of b.rbos) if (value === object) b.rbos.delete(name);
    }
    for (const map of [b.buffers,b.textures,b.shaders,b.programs,b.rbos,b.programShaders,b.programAttributeBindings,b.foreignTextures,b.shaderSources]) map.clear();
    b.imageSources.clear();
    b.programQueryPins.clear();
    b.shaderDeletePending.clear(); b.programDeletePending.clear();
  } else {
    if (installedName) finalizeProgram(b, installedName);
    if (retained && !cleanup) releaseRetainedExecutable(b, installed);
  }
  if (!cleanup) for (const object of b.vaos.values()) gl?.deleteVertexArray(object);
  for (const object of b.fbos.values()) if (gl && !cleanup) { retireNativeObject(gl,object); gl.deleteFramebuffer(object); }
  b.vaos.clear(); b.fbos.clear();
  b.framebufferAttachments.clear();
  framebufferInputsChanged();
  b.vertexArrays.clear();
  collectRetiredImages(b);
  collectRetiredBuffers(b);
  b.objects = createGlObjectGroup();
  b.objects.nextForeignTexId = objects.nextForeignTexId;
  b.objects.nextImageSource = objects.nextImageSource;
  b.objects.members.add(b);
  // Late native cleanup still owns the retired error flags. A reused
  // session must receive a fresh owner rather than inheriting those errors.
  b.errors = [];
  if (gl && b.undefinedDefaultFbo && !cleanup) { retireNativeObject(gl,b.undefinedDefaultFbo); gl.deleteFramebuffer(b.undefinedDefaultFbo); }
  b.undefinedDefaultFbo = null;
  if (gl && b.clientArrayStream && !cleanup) { retireNativeObject(gl,b.clientArrayStream); gl.deleteBuffer(b.clientArrayStream); }
  b.clientArrayStream = null;
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
  b.robustAccess = false;
  forgetRendererLoss(b);
  b.gl = null;
}
