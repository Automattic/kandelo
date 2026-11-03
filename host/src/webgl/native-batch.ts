/**
 * Host validation is authoritative on guest execution paths (D-48).
 * One synchronous batch owns the physical renderer until its native error
 * sample. Native failures reset that logical context, never become late API
 * errors on a different owner (D-49/D-50).
 */
import { isKernelExportFailure } from "../kernel-entry-gate.js";
import { glAuditOn } from "./native-audit.js";
import { NativeGlFault, nativeGlFault } from "./native-recovery.js";
import { reportGlDiagnostic } from "./diagnostics.js";
import { markRendererReset, rendererLost, RENDERER_LOST } from "./renderer-loss.js";

type Owner = { gl: WebGL2RenderingContext | null; errors: number[]; pid: number; sessionId: number };
type Batch = { owner: Owner; label: string; sequence: number; nativeWork: boolean };
let active: Batch | null = null;
let sequence = 0;

/** Internal unwind only; public host entries return ENODEV for this reset. */
export class NativeContextReset extends Error {}

export function nativeBatchActive(gl: WebGL2RenderingContext): boolean {
  return active?.owner.gl === gl;
}

/** Only the selected guest's checks are predictions. Private allocation and
 * cleanup owners retain exact native success checks for their bookkeeping. */
export function predictsNativeCalls(owner: { gl: WebGL2RenderingContext | null; errors: number[] }): boolean {
  return !!active && active.owner.gl === owner.gl && active.owner.errors === owner.errors;
}

/** A replay or utility can issue native calls without a checked wrapper. */
export function noteNativeBatchWork(gl: WebGL2RenderingContext): void {
  if (active?.owner.gl === gl) active.nativeWork = true;
}

export function predictedNativeCalls(calls: readonly (() => void)[]): boolean {
  if (active && calls.length) active.nativeWork = true;
  try { for (const call of calls) call(); return true; }
  catch (error) {
    if (error instanceof NativeContextReset || isKernelExportFailure(error)) throw error;
    // Fatal audit and kernel faults must retain their existing policy.
    if (error instanceof NativeGlFault) throw error;
    resetBatch(`native call threw ${String(error)}`);
  }
}

function resetBatch(detail: string, fatalInAudit = true): never {
  const batch = active;
  if (!batch) nativeGlFault(`Unowned native execution failure: ${detail}`);
  const { owner, label } = batch;
  const message = `GL context reset: ${detail}; pid ${owner.pid} session ${owner.sessionId} batch ${batch.sequence} (${label})`;
  markRendererReset(owner);
  reportGlDiagnostic(owner.pid, "gl-context-reset", message);
  if (glAuditOn && fatalInAudit) nativeGlFault(message);
  // A private exact check can discover a flag before the final sample.
  // Clear the physical queue before a peer acquires this shared renderer.
  for (let i = 0; i < 32; i++) {
    if (owner.gl!.getError() === 0) throw new NativeContextReset(message);
  }
  nativeGlFault(`${message}; native flags did not clear after reset`);
}

/** Exact host checks may run within a batch. They must route a pending
 * error to that batch's reset policy instead of consuming it privately. */
export function observeBatchNativeError(gl: WebGL2RenderingContext, error: number): void {
  if (!error || !nativeBatchActive(gl)) return;
  if (error === 0x9242) {
    markRendererReset(active!.owner);
    throw new NativeContextReset("Native WebGL renderer lost");
  }
  resetBatch(error === 0x505 ? "native OUT_OF_MEMORY (platform allocation boundary)"
    : `unpredicted native error 0x${error.toString(16)}`, error !== 0x505);
}

/** Nesting the dispatcher/query under its kernel entry shares one sample.
 * No native error check can be delayed past a logical context switch. */
export function withNativeBatch(owner: Owner, label: string, work: () => number | void, sampleWhenIdle = true): number {
  const gl = owner.gl;
  if (!gl) return work() ?? 0;
  if (rendererLost(owner)) return RENDERER_LOST;
  if (active) {
    if (active.owner.gl !== gl || active.owner.errors !== owner.errors)
      nativeGlFault("A native GL batch reentered a different logical context");
    return work() ?? 0;
  }
  active = { owner, label, sequence: ++sequence, nativeWork: false };
  try {
    const result = work() ?? 0;
    // A host-owned glGetError answer has no native batch of its own. A replay
    // or utility performed along that path still requires its boundary sample.
    if (!sampleWhenIdle && !active.nativeWork) return rendererLost(owner) ? RENDERER_LOST : result;
    // One sample on the common NO_ERROR path. Drain only after a failure,
    // before another logical context can acquire the shared renderer.
    let first = 0;
    for (let i = 0; i < 32; i++) {
      const error = gl.getError();
      if (!error) {
        if (first) observeBatchNativeError(gl, first);
        return rendererLost(owner) ? RENDERER_LOST : result;
      }
      if (!Number.isInteger(error) || error < 0 || error > 0xffff_ffff)
        nativeGlFault("Invalid native GL error result at batch completion");
      // OOM takes precedence over other flags: it is the explicit boundary.
      if (!first || error === 0x505) first = error;
    }
    resetBatch("native error flags did not clear");
  } catch (error) {
    if (error instanceof NativeContextReset) return RENDERER_LOST;
    throw error;
  } finally { active = null; }
}
