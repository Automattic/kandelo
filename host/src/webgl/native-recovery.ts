import { NativeContextReset, predictsNativeCalls, predictedNativeCalls, observeBatchNativeError, withNativeBookkeeping } from "./native-batch.js";
import type { GlObjectGroup } from "./object-group.js";
import { isKernelExportFailure } from "../kernel-entry-gate.js";
import { checkedGlCall, type CheckedGlOwner } from "./program-objects.js";
import { recordGlError, recordCpuGlOutOfMemory } from "./errors.js";
import { captureNativeGlErrors, type GlErrorState } from "./errors.js";
import { releaseReversedDepthTwin } from "./reversed-depth.js";
import { rendererLossCount, rendererObjectEpoch } from "./renderer-loss.js";

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
let reportedFault: Error | null = null;
/** The kernel installs its fatal host-fault callback here. One kernel owns
 * the renderers of a worker realm. */
export function setNativeGlFaultReporter(reporter: ((fault: Error) => void) | null): void {
  faultReporter = reporter;
  reportedFault = null;
}
/** Report a NativeGlFault, then throw it. Reporting first latches the fatal
 * shutdown even if a caller's catch swallows the exception. */
export function nativeGlFault(message: string, cause?: unknown): never {
  if (reportedFault) throw reportedFault;
  const fault = new NativeGlFault(message, cause);
  // Shutdown and finally cleanup can reenter this path. The kernel owns one
  // fatal transition; latch its exact cause before invoking its reporter.
  if (faultReporter) reportedFault = fault;
  try { faultReporter?.(fault); }
  catch (error) {
    if (isKernelExportFailure(error)) {
      reportedFault = error;
      throw error;
    }
  }
  throw fault;
}
/** Rethrow what a catch must never convert into an error result: a
 * NativeGlFault (the fatal shutdown is already latched, and the operation
 * did not happen) or a kernel export failure. */
export function rethrowNativeGlFault(error: unknown): void {
  if (error instanceof NativeContextReset || error instanceof NativeGlFault || isKernelExportFailure(error)) throw error;
}
/** The owner's native generation is gone; a previous loss does not excuse
 * refused cleanup of objects created after restoration. */
export function rendererOwnerGone(owner: CheckedGlOwner): boolean {
  return !!owner.gl && rendererGone(owner.gl, rendererObjectEpoch(owner));
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
  | ["depthRange",number,number]
  | ["blendFuncSeparate",number,number,number,number]
  | ["readBuffer", number]
  | ["activeTexture", number]
  | ["pixelStorei", number, number]
  | ["bindTexture", number, WebGLTexture | null]
  | ["bindFramebuffer", number, WebGLFramebuffer | null]
  | ["bindRenderbuffer", number, WebGLRenderbuffer | null]
  | ["bindBuffer", number, WebGLBuffer | null]
  | ["framebufferTexture2D", number, number, number, WebGLTexture | null, number]
  // target, attachment, texture, level, layer (cube faces, cube-storage.ts)
  | ["framebufferTextureLayer", number, number, WebGLTexture | null, number, number]
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
export type NativeRetirement = {owner: CheckedGlOwner; calls: NativeDeletion[]; pending: boolean; complete: boolean; collecting:boolean; references: number; dependencies: readonly NativeRetirement[]; ordered?: boolean; uninstallPrograms?: boolean; unusedProgramOwners?: WeakRef<GlObjectGroup>;
  /** Renderer generation (loss count) the objects were created in. */
  epoch: number};
const retirements = new WeakMap<WebGL2RenderingContext, Set<NativeRetirement>>();

export type NativeInverse = { owner: CheckedGlOwner; groups: NativeCall[][];
  /** Each group is checked once after its last call instead of after every
   * call: for calls that cannot fail on valid arguments, where one check
   * still detects a failed restoration (a NativeGlFault on a live renderer). */
  batched?: boolean;
  /** A private savepoint must be restored before publishing completion. */
  bookkeeping?: boolean;
  prepared?: {groups:PreparedNativeCall[][];predicted:readonly (()=>void)[]} };
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
type RepairSlot={top:Repair|undefined};
const repairs = new WeakMap<WebGL2RenderingContext, RepairSlot>();
const repairTop=(gl:WebGL2RenderingContext):Repair|undefined=>repairs.get(gl)?.top;
function repairSlot(gl:WebGL2RenderingContext):RepairSlot {
  let slot=repairs.get(gl);
  if(!slot){slot={top:undefined};repairs.set(gl,slot);}
  return slot;
}
function setRepairTop(gl:WebGL2RenderingContext,top:Repair|undefined):void {repairSlot(gl).top=top;}
/** Renderers whose retirement collection waited for an in-flight change. */
const deferredCollections = new WeakSet<WebGL2RenderingContext>();
function collectOrDefer(gl: WebGL2RenderingContext): void {
  if (repairTop(gl)) deferredCollections.add(gl);
  else collectNativeRetirements(gl);
}

export type PreparedNativeCall={call:NativeCall;enabled:boolean;invoke:()=>void;predicted:readonly (()=>void)[]};
export function prepareNativeCall(gl:WebGL2RenderingContext,call:NativeCall):PreparedNativeCall {
  const args:unknown[]=call.slice(1);
  const prepared:PreparedNativeCall={call,enabled:true,invoke:()=>{},predicted:[]};
  prepared.invoke=()=>{
    if(!prepared.enabled)return;
    for(let i=0;i<args.length;i++)args[i]=prepared.call[i+1];
    Reflect.apply(gl[prepared.call[0]],gl,args);
  };
  prepared.predicted=[prepared.invoke];return prepared;
}
export function checkedPreparedNativeCall(owner:CheckedGlOwner,call:PreparedNativeCall):boolean {
  if(!call.enabled)return true;
  return predictsNativeCalls(owner)?predictedNativeCalls(call.predicted):checkedGlCall(owner,call.invoke);
}
export type PreparedNativeInverse=NativeInverse&{prepared:NonNullable<NativeInverse["prepared"]>};
export function prepareNativeInverse(owner:CheckedGlOwner,...groups:NativeCall[][]):PreparedNativeInverse|null {
  if(!owner.gl)return null;
  try{
    const prepared=groups.map(group=>group.map(call=>prepareNativeCall(owner.gl!,call)));
    return {owner:nativeOwner(owner),groups,prepared:{groups:prepared,predicted:prepared.flatMap(group=>group.map(call=>call.invoke))}};
  }catch(error){rethrowNativeGlFault(error);recordCpuGlOutOfMemory(owner);return null;}
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
  if (inverse.bookkeeping && predictsNativeCalls(inverse.owner))
    return withNativeBookkeeping(() => restoreInverse(inverse));
  if (predictsNativeCalls(inverse.owner)) {
    return predictedNativeCalls(inverse.prepared?.predicted??inverse.groups.flatMap(group => group.map(call => () => { invokeNativeCall(inverse.owner.gl!, call); })));
  }
  if (inverse.batched) return restoreBatched(inverse);
  let accepted = true;
  // Evidence belongs only to this synchronous inverse and error owner.
  let cleanEntry = false;
  for (let groupIndex=0;groupIndex<inverse.groups.length;groupIndex++) for(let callIndex=0;callIndex<inverse.groups[groupIndex].length;callIndex++) {
    const call=inverse.groups[groupIndex][callIndex],prepared=inverse.prepared?.groups[groupIndex]?.[callIndex];
    if(prepared&&!prepared.enabled)continue;
    let acceptedCall = false;
    const gl = inverse.owner.gl;
    let cleared = cleanEntry;
    // A throw or rejected post-check cannot authorize the next group.
    cleanEntry = false;
    try {
      if (gl) {
        if (!cleared) for (let i = 0; i < 32; i++) {
          const error = gl.getError();
          observeBatchNativeError(gl, error);
          if (error === 0) { cleared = true; break; }
          recordGlError(inverse.owner, error);
        }
        if (cleared) {
          if(prepared)prepared.invoke();else invokeNativeCall(gl,call);
          const error = gl.getError();
          observeBatchNativeError(gl, error);
          recordGlError(inverse.owner, error);
          acceptedCall = error === 0;
          cleanEntry = acceptedCall;
        }
      }
    } catch (error) {
      rethrowNativeGlFault(error);
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
    const retirement = {owner:nativeOwner(b),calls,pending:false,complete:false,collecting:false,references:0,dependencies,ordered:options.ordered,uninstallPrograms:options.uninstallPrograms,
      unusedProgramOwners:options.unusedProgramOwners ? new WeakRef(options.unusedProgramOwners) : undefined,
      epoch:rendererObjectEpoch(b)};
    let owners = retirements.get(b.gl);
    if (!owners) { owners = new Set(); retirements.set(b.gl,owners); }
    owners.add(retirement);
    return retirement;
  } catch (error) {
    if (isKernelExportFailure(error)) throw error;
    recordCpuGlOutOfMemory(b); return null;
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
      if (!retirement.pending || retainedRetirement(retirement) || retirement.collecting) continue;
      // Deleting a guest executable retires its private variant receipts.
      // Nested collection must skip this in-flight receipt until its native
      // delete is acknowledged; otherwise it deletes the parent twice. The
      // flag is reserved cold and untouched when no retirement is pending.
      retirement.collecting=true;
      try {
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
            !checkedGlCall({gl, errors:[]}, () => {
              if (gl.getParameter(0x8b8d) === object) gl.useProgram(null);
            }, "cleanup")) {
          if (rendererGone(gl, retirement.epoch)) { call[1] = null; continue; }
          nativeGlFault("the live renderer refused to uninstall a retired program before deleting it");
        }
        if (!checkedGlCall({gl, errors:[]}, () => Reflect.apply(gl[call[0]],gl,[object]), "cleanup")) {
          if (rendererGone(gl, retirement.epoch)) { call[1] = null; continue; }
          nativeGlFault(`the live renderer refused ${call[0]} of an object the host retired`);
        }
        if (call[0] === "deleteProgram") releaseReversedDepthTwin(retirement.owner,object);
        retireNativeObject(gl,object); call[1] = null;
      }
      if (retirement.dependencies.every(dependency => dependency.complete)) { finishNativeRetirement(retirement); progress = true; }
      else waiting = true;
      }finally{retirement.collecting=false;}
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
  for (let repair = repairTop(gl); repair; repair = repair.parent) if (repair.pending) return true;
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
  let repair = repairTop(gl);
  while (repair) {
    if (!repair.pending || repair.replaying) return false;
    repair.replaying = true;
    try {
      if (!rendererGone(gl, repair.epoch)) {
        let restored = true;
        try {
          // The change is already rejected. Its inverse is host-owned
          // recovery, even when its error owner is the active guest batch.
          // Predicting that recovery could release a live shared renderer
          // whose native state was never actually restored.
          const inverseRepair = repair;
          withNativeBookkeeping(() => {
            for (let i = inverseRepair.attempted - 1; i >= 0; i--) restored = restoreInverse(inverseRepair.restores[i]) && restored;
            if (inverseRepair.finalizer) restored = restoreInverse(inverseRepair.finalizer) && restored;
            return restored;
          });
        } catch (error) {
          // A reset discovered while restoring is not permission to leave a
          // live shared renderer corrupted. Physical loss drops its objects.
          if (!(error instanceof NativeContextReset)) throw error;
          restored = false;
        }
        if (!restored && !rendererGone(gl, repair.epoch))
          nativeGlFault("the live renderer refused to restore native state after a rejected change");
      }
      if (repair.completion) repair.completion.complete = true;
      setRepairTop(gl,repair.parent);
    } finally { repair.replaying = false; }
    repair = repairTop(gl);
  }
  deferredCollections.delete(gl);
  return collectNativeRetirements(gl);
}

/** Reserve the repair record before native mutation. A rejected change is
 * undone before this returns (see repairNativeState). */
export function applyNativeChanges(b: CheckedGlOwner & { shadow: object }, changes: NativeChange[], options: {shared?: boolean; finalizer?: NativeInverse; completion?: NativeCompletion} = {}): boolean {
  const gl = b.gl;
  if (!gl) return false;
  const parent = repairTop(gl);
  if (parent?.pending) return false;
  let repair: Repair;
  try {
    repair = { parent, lifetime:options.shared ? null : b.shadow, finalizer:options.finalizer, completion:options.completion, restores:changes.map(change => change.restore),
      attempted:0, pending:false, replaying:false, owner:nativeOwner(b), epoch:rendererLossCount(gl) };
    setRepairTop(gl,repair);
    if (repair.completion) repair.completion.submitted = true;
  } catch(error) {rethrowNativeGlFault(error);recordCpuGlOutOfMemory(b);return false;}
  return applyNativeChangeRecord(gl,changes,repair,parent);
}

function applyNativeChangeRecord(gl:WebGL2RenderingContext,changes:NativeChange[],repair:Repair,parent:Repair|undefined):boolean {
  try {
    for (const change of changes) {
      repair.attempted++;
      let accepted = false;
      try { accepted = change.apply(); }
      catch (error) {
        if (error instanceof NativeContextReset || error instanceof NativeGlFault || isKernelExportFailure(error)) throw error;
        recordGlError(repair.owner,0x502);
      }
      if (accepted) continue;
      repair.pending = true;
      repairNativeState(gl);
      return false;
    }
    if (repairTop(gl) !== repair || (repair.finalizer && !restoreInverse(repair.finalizer))) {
      repair.pending = true;
      repairNativeState(gl);
      return false;
    }
    setRepairTop(gl,parent);
    if (repair.completion) repair.completion.complete = true;
    if (!parent && deferredCollections.has(gl)) { deferredCollections.delete(gl); collectNativeRetirements(gl); }
    return true;
  } catch (error) {
    if (error instanceof NativeContextReset) {
      // A logical reset leaves the shared native renderer alive. Unwind
      // private selectors before a healthy peer acquires it; nested repairs
      // finish first and stop at their still-running parent.
      repair.pending = true;
      withNativeBookkeeping(() => repairNativeState(gl));
    }
    throw error;
  }
}

/** A reusable native change reserves its recovery receiver before API local
 * acceptance. Keep the renderer's stack cell even while idle: deleting and
 * reinserting a WeakMap key would rediscover allocation failure during a
 * warmed draw. Idle cells retain no binding or native handle. */
export class PreparedNativeChanges {
  private busy=false;
  private constructor(private readonly binding:CheckedGlOwner&{shadow:object},private readonly gl:WebGL2RenderingContext,
    private readonly changes:NativeChange[],private readonly repair:Repair,private readonly slot:RepairSlot){}
  static reserve(b:CheckedGlOwner&{shadow:object},changes:NativeChange[],options:{shared?:boolean;finalizer?:NativeInverse;completion?:NativeCompletion}={}):PreparedNativeChanges|null {
    if(!b.gl)return null;
    try{
      const slot=repairSlot(b.gl),repair:Repair={lifetime:options.shared?null:b.shadow,finalizer:options.finalizer,
        completion:options.completion,restores:changes.map(change=>change.restore),attempted:0,pending:false,replaying:false,
        owner:nativeOwner(b),epoch:rendererLossCount(b.gl)};
      return new PreparedNativeChanges(b,b.gl,changes,repair,slot);
    }catch(error){rethrowNativeGlFault(error);recordCpuGlOutOfMemory(b);return null;}
  }
  apply():boolean {
    const b=this.binding,repair=this.repair;
    if(this.busy)nativeGlFault("a prepared native change was reentered while its receiver is borrowed");
    if(b.gl!==this.gl||rendererLossCount(this.gl)!==repair.epoch)return false;
    const parent=this.slot.top;if(parent?.pending)return false;
    // Cold query admission temporarily redirects b.errors to receipt flags.
    // Refresh the preallocated owner pointers at each ordinary batch so the
    // same context's predictions/reset policy remain authoritative.
    repair.owner.errors=b.errors;
    for(const inverse of repair.restores)inverse.owner.errors=b.errors;
    if(repair.finalizer)repair.finalizer.owner.errors=b.errors;
    repair.parent=parent;repair.attempted=0;repair.pending=false;repair.replaying=false;
    if(repair.completion){repair.completion.submitted=true;repair.completion.complete=false;}
    this.slot.top=repair;this.busy=true;
    try{return applyNativeChangeRecord(this.gl,this.changes,repair,parent);}
    finally{this.busy=false;if(this.slot.top!==repair&&!repair.pending)repair.parent=undefined;}
  }
}

/** Shared repair may outlive its submitter, but cannot reattach a container
 * that its owner has since retired. Scalar selector inverses become zero. */
export function retireNativeObject(gl: WebGL2RenderingContext, object: object): void {
  for (let repair = repairTop(gl); repair; repair = repair.parent) {
    for (const inverse of repair.restores) retireInverseObject(inverse,object);
    if (repair.finalizer) retireInverseObject(repair.finalizer,object);
  }
}
function retireInverseObject(inverse: NativeInverse, object: object): void {
  for (let i=inverse.groups.length-1;i>=0;i--) {
    const group = inverse.groups[i];
    if (group.some(call => call[0] === "bindFramebuffer" && call[2] === object)
        && group.some(call => call[0] === "framebufferTexture2D" || call[0] === "framebufferTextureLayer" || call[0] === "framebufferRenderbuffer")) {
      if(inverse.prepared){for(const call of inverse.prepared.groups[i])call.enabled=false;inverse.prepared.groups.splice(i,1);}
      inverse.groups.copyWithin(i,i+1); inverse.groups.length--; continue;
    }
    for (const call of group) {
      if ((call[0] === "bindFramebuffer" || call[0] === "bindTexture" || call[0] === "bindRenderbuffer" || call[0] === "bindBuffer") && call[2] === object) call[2] = null;
      if (call[0] === "useProgram" && call[1] === object) call[1] = null;
      if ((call[0] === "framebufferTexture2D" || call[0] === "framebufferRenderbuffer") && call[4] === object) call[4] = null;
      if (call[0] === "framebufferTextureLayer" && call[3] === object) call[3] = null;
    }
  }
}

/** These inverses concern retiring context-local selectors/containers, not
 * shared storage contents. Teardown deletes the containers; they must never
 * be revived by a later owner's repair. Muxer retirement precedes this call. */
export function retireNativeRepair(gl: WebGL2RenderingContext, lifetime: object): void {
  let top = repairTop(gl);
  while (top?.lifetime === lifetime) top = top.parent;
  if (!top) { setRepairTop(gl,undefined); return; }
  setRepairTop(gl,top);
  for (let repair: Repair|undefined = top; repair; repair = repair.parent)
    while (repair.parent?.lifetime === lifetime) repair.parent = repair.parent.parent;
}

export function nativeOwner(b: CheckedGlOwner): CheckedGlOwner {
  return {gl:b.gl, errors:b.errors, nativeEpoch:rendererObjectEpoch(b)};
}
export function nativeInverse(owner: CheckedGlOwner, ...groups: NativeCall[][]): NativeInverse {
  return {owner:nativeOwner(owner),groups};
}
/** A temporary host selector/savepoint is not guest API acceptance. Check
 * its restoration before publishing completion, including inside a predicted
 * guest batch; a late sample cannot recover a discarded inverse. */
export function bookkeepingNativeInverse(owner: CheckedGlOwner, ...groups: NativeCall[][]): NativeInverse {
  return {owner:nativeOwner(owner),groups,batched:true,bookkeeping:true};
}
/** An inverse whose groups are each checked once (NativeInverse.batched). */
export function batchedNativeInverse(owner: CheckedGlOwner, ...groups: NativeCall[][]): NativeInverse {
  return {owner:nativeOwner(owner),groups,batched:true};
}
function restoreBatched(inverse: NativeInverse): boolean {
  let accepted = true;
  for (let groupIndex=0;groupIndex<inverse.groups.length;groupIndex++) {
    const group=inverse.groups[groupIndex],prepared=inverse.prepared?.groups[groupIndex];
    const gl = inverse.owner.gl;
    let restored = false;
    try {
      if (gl) {
        let cleared = false;
        for (let i = 0; i < 32; i++) {
          const error = gl.getError();
          observeBatchNativeError(gl, error);
          if (error === 0) { cleared = true; break; }
          recordGlError(inverse.owner, error);
        }
        if (cleared) {
          for(let i=0;i<group.length;i++)if(!prepared||prepared[i].enabled){if(prepared)prepared[i].invoke();else invokeNativeCall(gl,group[i]);}
          const error = gl.getError();
          observeBatchNativeError(gl, error);
          recordGlError(inverse.owner, error);
          restored = error === 0;
        }
      }
    } catch (error) {
      rethrowNativeGlFault(error);
      recordGlError(inverse.owner, 0x502);
    }
    accepted = restored && accepted;
  }
  return accepted;
}
