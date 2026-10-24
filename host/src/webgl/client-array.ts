import { applyNativeChanges, nativeInverse, type NativeCompletion } from "./native-recovery.js";
import { recordGlError, type GlErrorState } from "./errors.js";
import type { GlShadowState } from "./shadow.js";

export type GlClientArrayFields = {
  /** Undefined means no driver savepoint; null captures logical zero. */
  savedClientArrayBuffer?: WebGLBuffer | null;
  clientArrayEndRequested?: boolean;
  clientArrayRestore?: {saved: WebGLBuffer | null; completion: NativeCompletion};
};
type Owner = GlClientArrayFields & GlErrorState & {shadow: GlShadowState};

export function beginClientArray(b: Owner): void {
  if (b.savedClientArrayBuffer !== undefined) { recordGlError(b,0x502); return; }
  b.savedClientArrayBuffer = b.shadow.arrayBuffer;
}

/** Request before allocating a ticket. If reservation fails, the next admitted
 * operation can retry this idempotent private restoration, without another END. */
export function requestClientArrayRestore(b: GlClientArrayFields): void {
  if (b.savedClientArrayBuffer !== undefined) b.clientArrayEndRequested = true;
}

/** Only this owner publishes its completed logical state. The native journal
 * holds a scalar ticket, never a callback retaining the guest binding. */
export function reconcileClientArrayRestore(b: Owner, gl: WebGL2RenderingContext): boolean {
  if (!b.clientArrayEndRequested) return true;
  const saved = b.savedClientArrayBuffer;
  if (saved === undefined) { recordGlError(b,0x502); return false; }
  try {
    const ticket = b.clientArrayRestore ??= {saved,completion:{submitted:false,complete:false}};
    if (!ticket.completion.submitted) applyNativeChanges({gl,errors:b.errors,shadow:b.shadow},[],{
      finalizer:nativeInverse({gl,errors:b.errors},[["bindBuffer",0x8892,ticket.saved]]),completion:ticket.completion,
    });
    if (!ticket.completion.complete) return false;
    b.shadow.arrayBuffer = ticket.saved;
    b.savedClientArrayBuffer = undefined;
    b.clientArrayRestore = undefined;
    b.clientArrayEndRequested = false;
    return true;
  } catch { recordGlError(b,0x505); return false; }
}

export function endClientArray(b: Owner & {gl: WebGL2RenderingContext|null}): void {
  if (b.savedClientArrayBuffer === undefined || !b.gl) { recordGlError(b,0x502); return; }
  requestClientArrayRestore(b);
  reconcileClientArrayRestore(b,b.gl);
}
