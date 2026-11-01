import type { GlObjectGroup } from "./object-group.js";
import { isKernelExportFailure } from "../kernel-entry-gate.js";
import { checkedGlCall, type CheckedGlOwner } from "./program-objects.js";
import { recordGlError } from "./errors.js";
import { captureNativeGlErrors, type GlErrorState } from "./errors.js";
import { releaseReversedDepthTwin } from "./reversed-depth.js";
import { rendererLossCount } from "./renderer-loss.js";

/**
 * A native GL operation the host's own bookkeeping depends on -- deleting a
 * retired object, or restoring native state after a failed change -- was
 * refused by a live renderer.
 *
 * WHY THIS IS FATAL. These operations act only on objects and state the host
 * itself created and still tracks, so a live WebGL renderer has no valid
 * reason to refuse them. A refusal means host state no longer matches the
 * renderer (or the renderer is broken), and a retry before later GL work is
 * not guaranteed to run or to succeed. A lost renderer is the exception: its
 * objects and state are gone with it, so cleanup completes without touching
 * it and the bindings that used it report the loss as a graphics reset
 * (renderer-loss.ts, ENODEV replies) at their next entry.
 */
export class NativeGlFault extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "NativeGlFault";
  }
}
let faultReporter: ((fault: Error) => void) | null = null;
/** The kernel installs its fatal host-fault callback here. One kernel owns
 * the renderers of a worker realm. */
export function setNativeGlFaultReporter(reporter: ((fault: Error) => void) | null): void {
  faultReporter = reporter;
}
/** Report a NativeGlFault, then throw it. Reporting first latches the fatal
 * shutdown even if a caller's catch swallows the exception. */
export function nativeGlFault(message: string, cause?: unknown): never {
  const fault = new NativeGlFault(message, cause);
  try { faultReporter?.(fault); }
  catch (error) { if (isKernelExportFailure(error)) throw error; }
  throw fault;
}
/** Rethrow what a catch must never convert into an error result: a
 * NativeGlFault (the fatal shutdown is already latched, and the operation
 * did not happen) or a kernel export failure. */
export function rethrowNativeGlFault(error: unknown): void {
  if (error instanceof NativeGlFault || isKernelExportFailure(error)) throw error;
}
/** True when the renderer is lost now or was lost at some point, so an
 * object created before that loss may already be gone. For a direct deletion
 * that has no recorded creation generation. */
export function rendererEverLost(gl: WebGL2RenderingContext): boolean {
  let lost = false;
  try { lost = gl.isContextLost?.() === true; } catch { lost = false; }
  return lost || rendererLossCount(gl) !== 0;
}
/** True when native objects of renderer generation `epoch` no longer exist:
 * the context is lost now, or was lost (and perhaps restored) since. */
function rendererGone(gl: WebGL2RenderingContext, epoch: number): boolean {
  let lost = false;
  try { lost = gl.isContextLost?.() === true; } catch { lost = false; }
  return lost || rendererLossCount(gl) !== epoch;
}

/** Only native handles/scalars enter a persistent inverse, never guest data or
 * callbacks whose lexical environment could retain a whole binding. */
export type NativeCall =
  | ["enable", number] | ["disable", number]
  | ["colorMask", boolean, boolean, boolean, boolean]
  | ["clearColor", number, number, number, number]
  | ["readBuffer", number]
  | ["activeTexture", number]
  | ["pixelStorei", number, number]
  | ["bindTexture", number, WebGLTexture | null]
  | ["bindFramebuffer", number, WebGLFramebuffer | null]
  | ["bindRenderbuffer", number, WebGLRenderbuffer | null]
  | ["bindBuffer", number, WebGLBuffer | null]
  | ["framebufferTexture2D", number, number, number, WebGLTexture | null, number]
  | ["framebufferRenderbuffer", number, number, number, WebGLRenderbuffer | null]
  | ["vertexAttribPointer", number, number, number, boolean, number, number]
  | ["vertexAttrib4f", number, number, number, number, number]
  | ["useProgram", WebGLProgram | null]
  | ["cullFace", number]
  | ["stencilFuncSeparate", number, number, number, number]
  | ["stencilMaskSeparate", number, number];
export type NativeDeletion = ["deleteTexture", WebGLTexture | null] | ["deleteRenderbuffer", WebGLRenderbuffer | null]
  | ["deleteFramebuffer", WebGLFramebuffer | null] | ["deleteBuffer", WebGLBuffer | null]
  | ["deleteSync", WebGLSync | null] | ["deleteShader", WebGLShader | null]
  | ["deleteProgram", WebGLProgram | null] | ["deleteVertexArray", WebGLVertexArrayObject | null];
export type NativeRetirement = {owner: CheckedGlOwner; calls: NativeDeletion[]; pending: boolean; complete: boolean; references: number; dependencies: readonly NativeRetirement[]; ordered?: boolean; uninstallPrograms?: boolean; unusedProgramOwners?: WeakRef<GlObjectGroup>;
  /** Renderer generation (loss count) the objects were created in. */
  epoch: number};
const retirements = new WeakMap<WebGL2RenderingContext, Set<NativeRetirement>>();

export type NativeInverse = { owner: CheckedGlOwner; groups: NativeCall[][];
  /** Each group is checked once after its last call instead of after every
   * call: for calls that cannot fail on valid arguments, where one check
   * still detects a failed restoration (a NativeGlFault on a live renderer). */
  batched?: boolean };
export type NativeChange = { apply(): boolean; restore: NativeInverse };
export type NativeCompletion = {submitted: boolean; complete: boolean};
type Repair = {
  parent?: Repair;
  lifetime: object | null;
  finalizer?: NativeInverse;
  completion?: NativeCompletion;
  restores: NativeInverse[];
  attempted: number;
  pending: boolean;
  replaying: boolean;
  owner: CheckedGlOwner;
  epoch: number;
};
/** Repairs exist only while applyNativeChanges runs: a restoration either
 * completes, or faults (live renderer), or is dropped (lost renderer). */
const repairs = new WeakMap<WebGL2RenderingContext, Repair>();
/** Renderers whose retirement collection waited for an in-flight change. */
const deferredCollections = new WeakSet<WebGL2RenderingContext>();
function collectOrDefer(gl: WebGL2RenderingContext): void {
  if (repairs.has(gl)) deferredCollections.add(gl);
  else collectNativeRetirements(gl);
}

export function invokeNativeCall(gl: WebGL2RenderingContext, call: NativeCall): boolean {
  const [method, ...args] = call;
  Reflect.apply(gl[method], gl, args);
  return true;
}

/** A selector must accept before dependent calls run; independent groups
 * (such as read/draw restoration) are attempted even after another fails.
 * This native-only synchronous inverse has one error owner. A clean post-check
 * is the next call's clean entry; failure revokes it before the next group.
 * No clean-entry evidence survives this invocation. */
function restoreInverse(inverse: NativeInverse): boolean {
  if (inverse.batched) return restoreBatched(inverse);
  let accepted = true;
  // Evidence belongs only to this synchronous inverse and error owner.
  let cleanEntry = false;
  for (const group of inverse.groups) for (const call of group) {
    let acceptedCall = false;
    const gl = inverse.owner.gl;
    let cleared = cleanEntry;
    // A throw or rejected post-check cannot authorize the next group.
    cleanEntry = false;
    try {
      if (gl) {
        if (!cleared) for (let i = 0; i < 32; i++) {
          const error = gl.getError();
          if (error === 0) { cleared = true; break; }
          recordGlError(inverse.owner, error);
        }
        if (cleared) {
          invokeNativeCall(gl, call);
          const error = gl.getError();
          recordGlError(inverse.owner, error);
          acceptedCall = error === 0;
          cleanEntry = acceptedCall;
        }
      }
    } catch {
      recordGlError(inverse.owner, 0x502);
    }
    if (acceptedCall) continue;
    accepted = false; break;
  }
  return accepted;
}

/** Reserve ownership before allocation/publication. Empty slots can be filled by
 * assignment inside native creation calls, without allocating after creation. */
export function reserveNativeRetirement(b: CheckedGlOwner, calls: NativeDeletion[], dependencies: readonly NativeRetirement[] = [], options: {ordered?: boolean; uninstallPrograms?: boolean; unusedProgramOwners?: GlObjectGroup} = {}): NativeRetirement | null {
  if (!b.gl) return null;
  try {
    const retirement = {owner:nativeOwner(b),calls,pending:false,complete:false,references:0,dependencies,ordered:options.ordered,uninstallPrograms:options.uninstallPrograms,
      unusedProgramOwners:options.unusedProgramOwners ? new WeakRef(options.unusedProgramOwners) : undefined,
      epoch:rendererLossCount(b.gl)};
    let owners = retirements.get(b.gl);
    if (!owners) { owners = new Set(); retirements.set(b.gl,owners); }
    owners.add(retirement);
    return retirement;
  } catch (error) {
    if (isKernelExportFailure(error)) throw error;
    recordGlError(b,0x505); return null;
  }
}
function finishNativeRetirement(retirement: NativeRetirement): void {
  if (retirement.complete) return;
  if (retirement.references !== 0) throw new Error("Cannot transfer retained native storage");
  retirements.get(retirement.owner.gl!)?.delete(retirement);
  retirement.complete = true;
}
export function transferNativeRetirement(retirement: NativeRetirement): void {
  finishNativeRetirement(retirement);
}
function programStillOwned(group: GlObjectGroup, program: WebGLProgram): boolean {
  if (group.programQueryPins.has(program)) return true;
  for (const member of group.members) if (member.currentProgram === program) return true;
  for (const named of group.programs.values()) if (named === program) return true;
  return false;
}
/** Delete every requested, unretained retirement's objects. A retirement
 * waits only for storage an accepted execution still holds or for a
 * dependency not yet requested; false reports such a wait. A refusal by a
 * live renderer is a NativeGlFault; objects of a lost renderer generation are
 * already gone and are dropped without a native call. Passes repeat so a
 * retirement completes in the same call as the dependency it waited for. */
function collectNativeRetirements(gl: WebGL2RenderingContext): boolean {
  const owned = retirements.get(gl);
  if (!owned) return true;
  let progress = true, waiting = false;
  while (progress) {
    progress = false; waiting = false;
    for (const retirement of owned) {
      if (!retirement.pending || retainedRetirement(retirement)) continue;
      for (const call of retirement.calls) {
        const object = call[1];
        if (!object) continue;
        if (rendererGone(gl, retirement.epoch)) { call[1] = null; continue; }
        if (call[0] === "deleteProgram" && retirement.unusedProgramOwners) {
          let stillOwned: boolean;
          try {
            const group = retirement.unusedProgramOwners.deref();
            stillOwned = !!group && programStillOwned(group, object);
          } catch (error) {
            if (isKernelExportFailure(error)) throw error;
            nativeGlFault("could not decide whether a retired program is still owned", error);
          }
          if (stillOwned) { call[1] = null; continue; }
        }
        // A logical switch can orphan an executable still physically selected.
        // Unbind only that exact handle before deleting it.
        if (retirement.uninstallPrograms && call[0] === "deleteProgram" &&
            !checkedGlCall(retirement.owner, () => {
              if (gl.getParameter(0x8b8d) === object) gl.useProgram(null);
            })) {
          if (rendererGone(gl, retirement.epoch)) { call[1] = null; continue; }
          nativeGlFault("the live renderer refused to uninstall a retired program before deleting it");
        }
        if (!checkedGlCall(retirement.owner, () => Reflect.apply(gl[call[0]],gl,[object]))) {
          if (rendererGone(gl, retirement.epoch)) { call[1] = null; continue; }
          nativeGlFault(`the live renderer refused ${call[0]} of an object the host retired`);
        }
        if (call[0] === "deleteProgram") releaseReversedDepthTwin(retirement.owner,object);
        retireNativeObject(gl,object); call[1] = null;
      }
      if (retirement.dependencies.every(dependency => dependency.complete)) { finishNativeRetirement(retirement); progress = true; }
      else waiting = true;
    }
  }
  return !waiting;
}
export function retireNativeRetirement(retirement: NativeRetirement): boolean {
  if (retirement.complete) return true;
  retirement.pending = true;
  collectOrDefer(retirement.owner.gl!);
  return retirement.complete;
}
export function hasNativeRepair(gl: WebGL2RenderingContext): boolean {
  for (let repair = repairs.get(gl); repair; repair = repair.parent) if (repair.pending) return true;
  for (const retirement of retirements.get(gl) ?? []) if (retirement.pending && !retainedRetirement(retirement)) return true;
  return false;
}

/** Waiting for an explicit storage owner is not a failed native inverse.
 * Admission must stay usable so the retained work can execute and release. */
function retainedRetirement(retirement: NativeRetirement): boolean {
  return retirement.references !== 0 || retirement.dependencies.some(value => !value.complete && retainedRetirement(value));
}

/** A native-only reference, independent of a surface, binding or guest view.
 * A failed error capture keeps the reference; a failed final deletion keeps
 * this retry token and the existing native receipt. Neither failure loses
 * ownership or transfers private cleanup errors to the selected GL owner. */
export class NativeRetirementLease {
  #retirement: NativeRetirement | null;
  #released = false;
  private constructor(retirement: NativeRetirement) { this.#retirement = retirement; }
  static acquire(retirement: NativeRetirement): NativeRetirementLease | null {
    return NativeRetirementLease.take(retirement,false);
  }
  private static take(retirement: NativeRetirement, existing: boolean): NativeRetirementLease | null {
    if (retirement.complete || (retirement.pending && (!existing || retirement.references === 0)) ||
        retirement.references >= Number.MAX_SAFE_INTEGER) return null;
    try {
      const lease = new NativeRetirementLease(retirement);
      retirement.references++;
      return lease;
    } catch { return null; }
  }
  get context(): WebGL2RenderingContext | null { return this.#retirement?.owner.gl ?? null; }
  get active(): boolean { return this.#retirement !== null && !this.#released; }
  clone(): NativeRetirementLease | null {
    return this.active ? NativeRetirementLease.take(this.#retirement!,true) : null;
  }
  /** Drop this reference. The last one deletes the storage now (or at the
   * end of an in-flight native change); a refusal is a NativeGlFault. */
  release(selectedErrors: GlErrorState | null): boolean {
    const retirement = this.#retirement;
    if (!retirement) return true;
    if (retirement.complete) { this.#retirement = null; return true; }
    const gl = retirement.owner.gl!;
    try { captureNativeGlErrors(gl,selectedErrors); }
    catch (error) {
      if (isKernelExportFailure(error)) throw error;
      nativeGlFault("could not read the renderer's error flags before releasing retained storage", error);
    }
    if (!this.#released) { this.#released = true; retirement.references--; }
    collectOrDefer(gl);
    this.#retirement = null;
    return true;
  }
}

export function retainNativeRetirement(retirement: NativeRetirement): NativeRetirementLease | null {
  return NativeRetirementLease.acquire(retirement);
}

/** Replay a failed change's inverse. False only for a repair still on the
 * caller's stack (an in-flight change). A live renderer that refuses the
 * restoration is a NativeGlFault; a lost renderer has no state left to
 * restore, so its repair is dropped and its bindings report the loss. */
export function repairNativeState(gl: WebGL2RenderingContext): boolean {
  let repair = repairs.get(gl);
  while (repair) {
    if (!repair.pending || repair.replaying) return false;
    repair.replaying = true;
    try {
      if (!rendererGone(gl, repair.epoch)) {
        let restored = true;
        for (let i = repair.attempted - 1; i >= 0; i--) restored = restoreInverse(repair.restores[i]) && restored;
        if (repair.finalizer) restored = restoreInverse(repair.finalizer) && restored;
        if (!restored && !rendererGone(gl, repair.epoch))
          nativeGlFault("the live renderer refused to restore native state after a rejected change");
      }
      if (repair.completion) repair.completion.complete = true;
      if (repair.parent) repairs.set(gl,repair.parent); else repairs.delete(gl);
    } finally { repair.replaying = false; }
    repair = repairs.get(gl);
  }
  deferredCollections.delete(gl);
  return collectNativeRetirements(gl);
}

/** Reserve the repair record before native mutation. A rejected change is
 * undone before this returns (see repairNativeState). */
export function applyNativeChanges(b: CheckedGlOwner & { shadow: object }, changes: NativeChange[], options: {shared?: boolean; finalizer?: NativeInverse; completion?: NativeCompletion} = {}): boolean {
  const gl = b.gl;
  if (!gl) return false;
  const parent = repairs.get(gl);
  if (parent?.pending) return false;
  let repair: Repair;
  try {
    repair = { parent, lifetime:options.shared ? null : b.shadow, finalizer:options.finalizer, completion:options.completion, restores:changes.map(change => change.restore),
      attempted:0, pending:false, replaying:false, owner:nativeOwner(b), epoch:rendererLossCount(gl) };
    repairs.set(gl,repair);
    if (repair.completion) repair.completion.submitted = true;
  } catch { recordGlError(b,0x505); return false; }
  for (const change of changes) {
    repair.attempted++;
    let accepted = false;
    try { accepted = change.apply(); }
    catch (error) {
      if (error instanceof NativeGlFault || isKernelExportFailure(error)) throw error;
      recordGlError(b,0x502);
    }
    if (accepted) continue;
    repair.pending = true;
    repairNativeState(gl);
    return false;
  }
  if (repairs.get(gl) !== repair || (repair.finalizer && !restoreInverse(repair.finalizer))) {
    repair.pending = true;
    repairNativeState(gl);
    return false;
  }
  if (parent) repairs.set(gl,parent); else repairs.delete(gl);
  if (repair.completion) repair.completion.complete = true;
  if (!parent && deferredCollections.has(gl)) { deferredCollections.delete(gl); collectNativeRetirements(gl); }
  return true;
}

/** Shared repair may outlive its submitter, but cannot reattach a container
 * that its owner has since retired. Scalar selector inverses become zero. */
export function retireNativeObject(gl: WebGL2RenderingContext, object: object): void {
  for (let repair = repairs.get(gl); repair; repair = repair.parent) {
    for (const inverse of repair.restores) retireInverseObject(inverse,object);
    if (repair.finalizer) retireInverseObject(repair.finalizer,object);
  }
}
function retireInverseObject(inverse: NativeInverse, object: object): void {
  for (let i=inverse.groups.length-1;i>=0;i--) {
    const group = inverse.groups[i];
    if (group.some(call => call[0] === "bindFramebuffer" && call[2] === object)
        && group.some(call => call[0] === "framebufferTexture2D" || call[0] === "framebufferRenderbuffer")) {
      inverse.groups.copyWithin(i,i+1); inverse.groups.length--; continue;
    }
    for (const call of group) {
      if ((call[0] === "bindFramebuffer" || call[0] === "bindTexture" || call[0] === "bindRenderbuffer" || call[0] === "bindBuffer") && call[2] === object) call[2] = null;
      if (call[0] === "useProgram" && call[1] === object) call[1] = null;
      if ((call[0] === "framebufferTexture2D" || call[0] === "framebufferRenderbuffer") && call[4] === object) call[4] = null;
    }
  }
}

/** These inverses concern retiring context-local selectors/containers, not
 * shared storage contents. Teardown deletes the containers; they must never
 * be revived by a later owner's repair. Muxer retirement precedes this call. */
export function retireNativeRepair(gl: WebGL2RenderingContext, lifetime: object): void {
  let top = repairs.get(gl);
  while (top?.lifetime === lifetime) top = top.parent;
  if (!top) { repairs.delete(gl); return; }
  repairs.set(gl,top);
  for (let repair: Repair|undefined = top; repair; repair = repair.parent)
    while (repair.parent?.lifetime === lifetime) repair.parent = repair.parent.parent;
}

export function nativeOwner(b: CheckedGlOwner): CheckedGlOwner {
  return {gl:b.gl, errors:b.errors};
}
export function nativeInverse(owner: CheckedGlOwner, ...groups: NativeCall[][]): NativeInverse {
  return {owner:nativeOwner(owner),groups};
}
/** An inverse whose groups are each checked once (NativeInverse.batched). */
export function batchedNativeInverse(owner: CheckedGlOwner, ...groups: NativeCall[][]): NativeInverse {
  return {owner:nativeOwner(owner),groups,batched:true};
}
function restoreBatched(inverse: NativeInverse): boolean {
  let accepted = true;
  for (const group of inverse.groups) {
    const gl = inverse.owner.gl;
    let restored = false;
    try {
      if (gl) {
        let cleared = false;
        for (let i = 0; i < 32; i++) {
          const error = gl.getError();
          if (error === 0) { cleared = true; break; }
          recordGlError(inverse.owner, error);
        }
        if (cleared) {
          for (const call of group) invokeNativeCall(gl, call);
          const error = gl.getError();
          recordGlError(inverse.owner, error);
          restored = error === 0;
        }
      }
    } catch {
      recordGlError(inverse.owner, 0x502);
    }
    accepted = restored && accepted;
  }
  return accepted;
}
