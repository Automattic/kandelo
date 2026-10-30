import { isKernelExportFailure } from "../kernel-entry-gate.js";
import { checkedGlCall, type CheckedGlOwner } from "./program-objects.js";
import { recordGlError } from "./errors.js";
import { captureNativeGlErrors, type GlErrorState } from "./errors.js";

/** Only native handles/scalars enter a persistent inverse, never guest data or
 * callbacks whose lexical environment could retain a whole binding. */
export type NativeCall =
  | ["clearVertexAttribute", NativeRetirement, number, number, number, boolean, number, number]
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
  | ["vertexAttribPointer", number, number, number, boolean, number, number];
export type NativeDeletion = ["deleteTexture", WebGLTexture | null] | ["deleteRenderbuffer", WebGLRenderbuffer | null]
  | ["deleteFramebuffer", WebGLFramebuffer | null] | ["deleteBuffer", WebGLBuffer | null]
  | ["deleteSync", WebGLSync | null] | ["deleteShader", WebGLShader | null]
  | ["deleteProgram", WebGLProgram | null] | ["deleteVertexArray", WebGLVertexArrayObject | null];
export type NativeRetirement = {owner: CheckedGlOwner; calls: NativeDeletion[]; pending: boolean; complete: boolean; references: number; dependencies: readonly NativeRetirement[]; ordered?: boolean; uninstallPrograms?: boolean};
const retirements = new WeakMap<WebGL2RenderingContext, Set<NativeRetirement>>();
export type NativeInverse = { owner: CheckedGlOwner; groups: NativeCall[][] };
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
};
const repairs = new WeakMap<WebGL2RenderingContext, Repair>();

export function invokeNativeCall(gl: WebGL2RenderingContext, call: NativeCall): boolean {
  if (call[0] === "clearVertexAttribute") {
    const [,retirement,index,size,type,normalized,stride,offset] = call;
    if (retirement.complete) { recordGlError(retirement.owner,0x502); return false; }
    if (!retirement.calls[0][1]) {
      if (!checkedGlCall(retirement.owner, () => {
        retirement.calls[0][1] = gl.createBuffer();
        if (retirement.calls[0][1]) retirement.pending = true;
      })) return false;
      if (!retirement.calls[0][1]) { recordGlError(retirement.owner,0x505); return false; }
    }
    return checkedGlCall(retirement.owner, () => gl.bindBuffer(0x8892,retirement.calls[0][1])) &&
      checkedGlCall(retirement.owner, () => gl.bufferData(0x8892,0,0x88e4)) &&
      checkedGlCall(retirement.owner, () => gl.vertexAttribPointer(index,size,type,normalized,stride,offset));
  }
  const [method, ...args] = call;
  Reflect.apply(gl[method], gl, args);
  return true;
}

/** A selector must accept before dependent calls run; independent groups
 * (such as read/draw restoration) are attempted even after another fails. */
function restoreInverse(inverse: NativeInverse): boolean {
  let accepted = true;
  for (const group of inverse.groups) for (const call of group) {
    const acceptedCall = call[0] === "clearVertexAttribute" ? invokeNativeCall(inverse.owner.gl!,call)
      : checkedGlCall(inverse.owner, () => { invokeNativeCall(inverse.owner.gl!,call); });
    if (acceptedCall) continue;
    accepted = false; break;
  }
  return accepted;
}

/** Reserve ownership before allocation/publication. Empty slots can be filled by
 * assignment inside native creation calls, without allocating after creation. */
export function reserveNativeRetirement(b: CheckedGlOwner, calls: NativeDeletion[], dependencies: readonly NativeRetirement[] = [], options: {ordered?: boolean; uninstallPrograms?: boolean} = {}): NativeRetirement | null {
  if (!b.gl) return null;
  try {
    const retirement = {owner:nativeOwner(b),calls,pending:false,complete:false,references:0,dependencies,ordered:options.ordered,uninstallPrograms:options.uninstallPrograms};
    let owners = retirements.get(b.gl);
    if (!owners) { owners = new Set(); retirements.set(b.gl,owners); }
    owners.add(retirement);
    return retirement;
  } catch (error) {
    if (isKernelExportFailure(error)) throw error;
    recordGlError(b,0x505); return null;
  }
}
export function transferNativeRetirement(retirement: NativeRetirement): void {
  if (retirement.references !== 0) throw new Error("Cannot transfer retained native storage");
  retirements.get(retirement.owner.gl!)?.delete(retirement);
  retirement.complete = true;
}
function collectNativeRetirements(gl: WebGL2RenderingContext): boolean {
  let accepted = true;
  for (const retirement of retirements.get(gl) ?? []) {
    if (!retirement.pending || retainedRetirement(retirement)) continue;
    for (const call of retirement.calls) {
      const object = call[1];
      if (!object) continue;
      // A logical switch can orphan an executable still physically selected.
      // Unbind only that exact handle before deleting it; failed unbind keeps
      // the same receiver pending and cannot delete another owner's program.
      if (retirement.uninstallPrograms && call[0] === "deleteProgram" &&
          !checkedGlCall(retirement.owner, () => {
            if (gl.getParameter(0x8b8d) === object) gl.useProgram(null);
          })) {
        accepted = false;
        if (retirement.ordered) break;
        continue;
      }
      if (checkedGlCall(retirement.owner, () => Reflect.apply(gl[call[0]],gl,[object]))) {
        retireNativeObject(gl,object); call[1] = null;
      } else {
        accepted = false;
        // Canonical BO backing must survive a rejected container retirement.
        // Already accepted members remain null and never execute again.
        if (retirement.ordered) break;
      }
    }
    if (retirement.calls.every(call => call[1] === null) && retirement.dependencies.every(dependency => dependency.complete)) transferNativeRetirement(retirement);
    else accepted = false;
  }
  return accepted;
}
export function retireNativeRetirement(retirement: NativeRetirement): boolean {
  if (retirement.complete) return true;
  retirement.pending = true;
  const gl = retirement.owner.gl!;
  if (!repairs.has(gl)) collectNativeRetirements(gl);
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
  release(selectedErrors: GlErrorState | null): boolean {
    const retirement = this.#retirement;
    if (!retirement) return true;
    if (retirement.complete) { this.#retirement = null; return true; }
    const gl = retirement.owner.gl!;
    try { captureNativeGlErrors(gl,selectedErrors); }
    catch { return false; }
    if (!this.#released) { this.#released = true; retirement.references--; }
    if (!repairs.has(gl)) collectNativeRetirements(gl);
    if (retirement.pending && !retirement.complete && retirement.references === 0) return false;
    this.#retirement = null;
    return true;
  }
}

export function retainNativeRetirement(retirement: NativeRetirement): NativeRetirementLease | null {
  return NativeRetirementLease.acquire(retirement);
}

export function repairNativeState(gl: WebGL2RenderingContext): boolean {
  let repair = repairs.get(gl);
  while (repair) {
    if (!repair.pending || repair.replaying) return false;
    repair.replaying = true;
    let restored = true;
    try {
      if (gl.isContextLost?.()) return false;
      for (let i = repair.attempted - 1; i >= 0; i--) restored = restoreInverse(repair.restores[i]) && restored;
      if (repair.finalizer) restored = restoreInverse(repair.finalizer) && restored;
      if (!restored) return false;
      if (repair.completion) repair.completion.complete = true;
      if (repair.parent) repairs.set(gl,repair.parent); else repairs.delete(gl);
    } catch { recordGlError(repair.owner,0x502); return false; }
    finally { repair.replaying = false; }
    repair = repairs.get(gl);
  }
  return collectNativeRetirements(gl);
}

/** Reserve the repair record before native mutation. A failed inverse remains
 * reachable and fences the entire physical context until it can be replayed. */
export function applyNativeChanges(b: CheckedGlOwner & { shadow: object }, changes: NativeChange[], options: {shared?: boolean; finalizer?: NativeInverse; completion?: NativeCompletion} = {}): boolean {
  const gl = b.gl;
  if (!gl) return false;
  const parent = repairs.get(gl);
  if (parent?.pending) return false;
  let repair: Repair;
  try {
    repair = { parent, lifetime:options.shared ? null : b.shadow, finalizer:options.finalizer, completion:options.completion, restores:changes.map(change => change.restore),
      attempted:0, pending:false, replaying:false, owner:nativeOwner(b) };
    repairs.set(gl,repair);
    if (repair.completion) repair.completion.submitted = true;
  } catch { recordGlError(b,0x505); return false; }
  for (const change of changes) {
    repair.attempted++;
    let accepted = false;
    try { accepted = change.apply(); }
    catch { recordGlError(b,0x502); }
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
