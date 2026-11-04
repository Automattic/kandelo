/** Immutable executable captures for the guest driver. Context-owned handles
 * have optional query access; internal group captures remain private. Accepted
 * work clones custody separately before public cache ownership can end. */
import type { GlBinding, GlContextExecutionLease } from "./registry.js";
import type { GlObjectGroup } from "./object-group.js";
import { GlProgramQueryPin, useProgramIfAccepted } from "./program-objects.js";
import { recordGlError } from "./errors.js";
import { isKernelExportFailure } from "../kernel-entry-gate.js";
import { nativeGlFault, rethrowNativeGlFault } from "./native-recovery.js";

type CaptureAdmission = { pin: GlProgramQueryPin | null; owner: GlBinding | null };
type Captures = { next: number; closed: boolean; pins: Map<number, GlProgramQueryPin>; pending: CaptureAdmission | null;
  owners?: Map<number, GlBinding>; closedOwners?: WeakSet<GlBinding> };
const groups = new WeakMap<GlObjectGroup, Captures>();

export function captureGlProgram(execution: GlContextExecutionLease, name: number): number {
  return captureProgram(execution,name,false);
}

/** Guest caches belong to an exact public context. A peer acquires its own
 * owner rather than keeping a dead context's cache alive until group close. */
export function captureContextGlProgram(execution: GlContextExecutionLease, name: number): number {
  return captureProgram(execution,name,true);
}

function captureProgram(execution: GlContextExecutionLease, name: number, contextOwned: boolean): number {
  const b=execution.binding;
  let state=groups.get(b.objects);
  if(state?.closed || (contextOwned && state?.closedOwners?.has(b))) {recordGlError(b,0x502);return 0;}
  try {
    if(!state) {
      state={next:1,closed:false,pins:new Map(),pending:null};
      groups.set(b.objects,state);
    }
    if(contextOwned && !state.owners) {
      // Reserve both ownership indexes before acquiring native custody.
      const owners=new Map<number,GlBinding>(),closedOwners=new WeakSet<GlBinding>();
      state.owners=owners;state.closedOwners=closedOwners;
    }
  } catch(error) {rethrowNativeGlFault(error);if(isKernelExportFailure(error))throw error;
    recordGlError(b,0x505);return 0;
  }
  if(state.next>0xffff_ffff) {recordGlError(b,0x505);return 0;}
  if(state.pending) nativeGlFault("Unretired program capture admission prevents new ownership");
  // A failed map publication can itself fail native rollback. Reserve a
  // receiver before pin acquisition so containment never loses that owner.
  let admission: CaptureAdmission;
  try {admission={pin:null,owner:contextOwned?b:null};state.pending=admission;}
  catch(error) {rethrowNativeGlFault(error);if(isKernelExportFailure(error))throw error;
    recordGlError(b,0x505);return 0;
  }
  const pin=GlProgramQueryPin.acquire(execution,name);
  if(!pin) {state.pending=null;return 0;}
  admission.pin=pin;
  const handle=state.next;
  try {
    state.pins.set(handle,pin);state.next++;
    if(contextOwned) state.owners!.set(handle,b);
    state.pending=null;
    return handle;
  }
  catch(error) {rethrowNativeGlFault(error);if(isKernelExportFailure(error))throw error;
    retireCaptureAdmission(state);
    recordGlError(b,0x505);return 0;
  }
}

function retireCaptureAdmission(state: Captures, owner?: GlBinding): void {
  const admission=state.pending;
  if(!admission || (owner!==undefined && admission.owner!==owner)) return;
  try {
    if(admission.pin && !admission.pin.release()) nativeGlFault("Program capture admission cleanup refused native custody retirement");
    // Publication may have inserted a map entry before a later index failed.
    // Clear it only after the exact owner has retired successfully.
    for(const [handle,pin] of state.pins) if(pin===admission.pin) {
      state.pins.delete(handle);state.owners?.delete(handle);
    }
    state.pending=null;
  } catch(error) {rethrowNativeGlFault(error);if(isKernelExportFailure(error))throw error;
    nativeGlFault("Program capture admission cleanup threw",error);
  }
}

/** Acquire only within the caller's share group. The returned owner is not
 * in the cache, so cache retirement cannot revoke already accepted work. */
export function retainGlProgramCapture(b: GlBinding, handle: number): GlProgramQueryPin | null {
  const state=groups.get(b.objects), pin=state?.closed ? undefined : state?.pins.get(handle);
  if(!pin) {recordGlError(b,0x501);return null;}
  return pin.clone(b);
}

export function releaseGlProgramCapture(b: GlBinding, handle: number): boolean {
  const state=groups.get(b.objects),pin=state?.pins.get(handle);
  if(!pin) {recordGlError(b,0x501);return false;}
  if(!pin.release()) return false;
  state!.pins.delete(handle);
  state!.owners?.delete(handle);
  return true;
}

/** Synchronous selection requires this context's capture of the latest named
 * executable. A retained older executable cannot make a failed relink usable.
 * Future accepted batches retain their own immutable custody separately. */
export function useContextGlProgramCapture(b: GlBinding, name: number, handle: number): boolean {
  const state=groups.get(b.objects),pin=state?.pins.get(handle);
  if(state?.closed || state?.closedOwners?.has(b) || state?.owners?.get(handle)!==b ||
      !pin || pin.name!==name || b.programs.get(name)!==pin.program) {
    recordGlError(b,0x502);return false;
  }
  return useProgramIfAccepted(b,name);
}

export function isContextGlProgramCapture(b: GlBinding, handle: number): boolean {
  const state=groups.get(b.objects);
  return !!state?.pins.has(handle) && !!state.owners?.has(handle);
}

/** Release exact public-context cache owners before retiring that execution.
 * Accepted clones remain independent. Keep failed entries for containment. */
export function retireContextProgramCaptures(b: GlBinding): void {
  const state=groups.get(b.objects);
  if(!state?.owners) return;
  try {state.closedOwners!.add(b);}
  catch(error) {rethrowNativeGlFault(error);if(isKernelExportFailure(error))throw error;
    nativeGlFault("Could not close a retiring context's program capture cache",error);
  }
  retireCaptureAdmission(state,b);
  for(const [handle,owner] of state.owners) if(owner===b) {
    try {
      if(!releaseGlProgramCapture(b,handle)) nativeGlFault("Context program capture cleanup refused native custody retirement");
    } catch(error) {rethrowNativeGlFault(error);if(isKernelExportFailure(error))throw error;
      nativeGlFault("Context program capture cleanup threw",error);
    }
  }
}

/** A group cache may retain an old context's execution lease. Release cached
 * owners BEFORE the last public context retires; otherwise group -> pin ->
 * execution -> binding -> group would keep the group alive forever. Pending
 * work owns separate clones and still retires through the normal ledger. */
export function retireLastPublicProgramCaptures(b: GlBinding, publicBindings: Iterable<GlBinding>): void {
  const state=groups.get(b.objects);
  if(!state) return;
  if(!state.closed) for(const other of publicBindings)
    if(other!==b && other.contextId!==null && other.objects===b.objects) return;
  // Closed forbids new work, but an earlier cleanup fault may leave custody
  // to retire. A later containment pass must not silently skip that owner.
  state.closed=true;
  retireCaptureAdmission(state);
  for(const [handle,pin] of state.pins) {
    try {
      if(!pin.release()) nativeGlFault("Last public context could not release its program capture cache");
    } catch(error) {rethrowNativeGlFault(error);if(isKernelExportFailure(error))throw error;
      nativeGlFault("Last public context program capture cleanup threw",error);
    }
    state.pins.delete(handle);
    state.owners?.delete(handle);
  }
}
