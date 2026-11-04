/** Prepared shared executable captures for the guest driver. No command or
 * query exposes these handles yet. A cache owns native/context custody;
 * accepted work clones it separately before public ownership can end. */
import type { GlBinding, GlContextExecutionLease } from "./registry.js";
import type { GlObjectGroup } from "./object-group.js";
import { GlProgramQueryPin } from "./program-objects.js";
import { recordGlError } from "./errors.js";
import { isKernelExportFailure } from "../kernel-entry-gate.js";
import { nativeGlFault, rethrowNativeGlFault } from "./native-recovery.js";

type Captures = { next: number; closed: boolean; pins: Map<number, GlProgramQueryPin> };
const groups = new WeakMap<GlObjectGroup, Captures>();

export function captureGlProgram(execution: GlContextExecutionLease, name: number): number {
  const b=execution.binding;
  let state=groups.get(b.objects);
  if(state?.closed) {recordGlError(b,0x502);return 0;}
  try {
    if(!state) {
      state={next:1,closed:false,pins:new Map()};
      groups.set(b.objects,state);
    }
  } catch(error) {rethrowNativeGlFault(error);if(isKernelExportFailure(error))throw error;
    recordGlError(b,0x505);return 0;
  }
  if(state.next>0xffff_ffff) {recordGlError(b,0x505);return 0;}
  const pin=GlProgramQueryPin.acquire(execution,name);
  if(!pin) return 0;
  const handle=state.next;
  try {state.pins.set(handle,pin);state.next++;return handle;}
  catch(error) {rethrowNativeGlFault(error);if(isKernelExportFailure(error))throw error;
    pin.release();recordGlError(b,0x505);return 0;
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
  return true;
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
  for(const [handle,pin] of state.pins) {
    try {
      if(!pin.release()) nativeGlFault("Last public context could not release its program capture cache");
    } catch(error) {rethrowNativeGlFault(error);if(isKernelExportFailure(error))throw error;
      nativeGlFault("Last public context program capture cleanup threw",error);
    }
    state.pins.delete(handle);
  }
}
