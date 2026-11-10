/**
 * Host validation is authoritative on guest execution paths (D-48).
 * One synchronous batch owns the physical renderer until its native error
 * sample. Native failures reset that logical context, never become late API
 * errors on a different owner (D-49/D-50).
 */
import { isKernelExportFailure } from "../kernel-entry-gate.js";
import { glAuditOn, registerGlAuditBatchHooks, reportGlAuditBatchError } from "./native-audit.js";
import { NativeGlFault, nativeGlFault } from "./native-recovery.js";
import { reportGlDiagnostic } from "./diagnostics.js";
import { markRendererReset, noteRendererLoss, rendererLost, RENDERER_LOST } from "./renderer-loss.js";

type Owner = { gl: WebGL2RenderingContext | null; errors: number[]; pid: number; sessionId: number };
type Batch = { owner: Owner; label: string; sequence: number; nativeWork: boolean; bookkeeping: number };
let active: Batch | null = null;
let sequence = 0;
let preparedUniformResetRecovery:((gl:WebGL2RenderingContext)=>void)|null=null;
/** Only a live owned-draw authority installs this exceptional recovery. It
 * adds no native queries, mirror copies or callbacks to ordinary batches. */
export function setPreparedUniformResetRecovery(recovery:((gl:WebGL2RenderingContext)=>void)|null):void {
  preparedUniformResetRecovery=recovery;
}

/** Internal unwind only; public host entries return ENODEV for this reset. */
export class NativeContextReset extends Error {}

export function nativeBatchActive(gl: WebGL2RenderingContext): boolean {
  return active?.owner.gl === gl;
}

/** Only the selected guest's checks are predictions. Private allocation and
 * cleanup owners retain exact native success checks for their bookkeeping. */
export function predictsNativeCalls(owner: { gl: WebGL2RenderingContext | null; errors: number[] }): boolean {
  return !!active && active.bookkeeping === 0 && active.owner.gl === owner.gl && active.owner.errors === owner.errors;
}

/** Private copies publish host storage/derived-data validity only after native
 * success. Their checks still attribute any native error to the active batch's
 * reset policy. Guest flags stay in the logical owner's independent queue. */
export function withNativeBookkeeping(work: () => boolean): boolean {
  const batch = active;
  if (!batch) return work();
  batch.bookkeeping++;
  try { return work(); } finally { batch.bookkeeping--; }
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
  if (owner.gl!.isContextLost()) noteRendererLoss(owner.gl!);
  markRendererReset(owner);
  reportGlDiagnostic(owner.pid, "gl-context-reset", message);
  if (glAuditOn && fatalInAudit) nativeGlFault(message);
  // A private exact check can discover a flag before the final sample.
  // Clear the physical queue before a peer acquires this shared renderer.
  for (let i = 0; i < 32; i++) {
    if (owner.gl!.getError() === 0){
      if(!owner.gl!.isContextLost())preparedUniformResetRecovery?.(owner.gl!);
      throw new NativeContextReset(message);
    }
  }
  nativeGlFault(`${message}; native flags did not clear after reset`);
}

/** Exact host checks may run within a batch. They must route a pending
 * error to that batch's reset policy instead of consuming it privately. */
export function observeBatchNativeError(gl: WebGL2RenderingContext, error: number, alreadyReported = false): void {
  if (!error || !nativeBatchActive(gl)) return;
  if(!alreadyReported)reportGlAuditBatchError({...active!.owner,gl},error,active!.label,active!.sequence);
  if (error === 0x9242) {
    noteRendererLoss(gl);
    markRendererReset(active!.owner);
    throw new NativeContextReset("Native WebGL renderer lost");
  }
  resetBatch(error === 0x505 ? "native OUT_OF_MEMORY (platform allocation boundary)"
    : `unpredicted native error 0x${error.toString(16)}`, error !== 0x505);
}

/** Nesting the dispatcher/query under its kernel entry shares one sample.
 * No native error check can be delayed past a logical context switch. */
function runNativeBatch(owner: Owner, label: string, work: () => number | void, sampleWhenIdle = true): number {
  const gl = owner.gl;
  if (!gl) return work() ?? 0;
  if (rendererLost(owner)) return RENDERER_LOST;
  if (active) {
    if (active.owner.gl !== gl || active.owner.errors !== owner.errors)
      nativeGlFault("A native GL batch reentered a different logical context");
    return work() ?? 0;
  }
  active = { owner, label, sequence: ++sequence, nativeWork: false, bookkeeping: 0 };
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


// Internal live dispatcher: use an ESM import or retain the module namespace,
// never copy/destructure the callable. Browser test consumers are guarded by
// the lifetime contract. Configure-time adaptation keeps unused audit work off
// the production batch path; the original body above remains unchanged.
export let withNativeBatch = runNativeBatch;
// Only the empty token may survive in an oracle-held flag. Retaining this
// submission/owner there would keep a retired guest binding and memory alive.
type FatalAuditSubmission = {owner:Owner; sampling:boolean;deferred:boolean;token:object};
let fatalAuditSubmission:FatalAuditSubmission|null=null;
function runFatalAuditBatch(owner:Owner,label:string,work:()=>number|void,sampleWhenIdle=true):number {
  // Accepted nesting shares the physical submission and its token. Creating
  // an inner token loses exact-oracle flags when the unsampled inner call
  // returns; marking the outer scope sampling here would also end it early.
  // The original dispatcher still rejects a different logical owner.
  if(active)return runNativeBatch(owner,label,work,sampleWhenIdle);
  const previous=fatalAuditSubmission;
  const submission:FatalAuditSubmission={owner,sampling:false,deferred:false,token:{}};
  fatalAuditSubmission=submission;
  try {
    return runNativeBatch(owner,label,()=>{
      try {return work();}
      finally {submission.sampling=true;}
    },sampleWhenIdle);
  } finally {fatalAuditSubmission=previous;}
}
registerGlAuditBatchHooks({
  configure(mode) {withNativeBatch=mode==="fatal"?runFatalAuditBatch:runNativeBatch;},
  phase(gl) {
    if(!active||active.owner.gl!==gl||!fatalAuditSubmission||
        fatalAuditSubmission.owner.errors!==active.owner.errors)return undefined;
    if(active.bookkeeping)return "exact";
    return fatalAuditSubmission.sampling?"sample":"predicted";
  },
  identity(gl) {
    return active&&active.owner.gl===gl&&fatalAuditSubmission?.owner.errors===active.owner.errors?fatalAuditSubmission.token:undefined;
  },
  nativeCall(gl,deferred) {
    if(!active||active.owner.gl!==gl||!fatalAuditSubmission)return;
    active.nativeWork=true;
    if(deferred)fatalAuditSubmission.deferred=true;
  },
  takeDeferred(gl) {
    if(!active||active.owner.gl!==gl||!fatalAuditSubmission)return false;
    const deferred=fatalAuditSubmission.deferred;fatalAuditSubmission.deferred=false;return deferred;
  },
  fail(gl,detail):never {
    if(!active||active.owner.gl!==gl)nativeGlFault("A native audit failure outlived its owner");
    resetBatch(detail);
  },
  readError(gl,error,next,reported=false):never {
    if(!active||active.owner.gl!==gl)nativeGlFault("A native audit error outlived its submitted owner");
    let selected=error;
    // A private drain must not consume a deferred error. Collect actual flags
    // with the same OOM precedence/bound as the normal completion sample, then
    // route the original owner's reset policy before any peer can execute.
    for(let i=1;i<32;i++) {
      const following=next();
      if(!following){observeBatchNativeError(gl as WebGL2RenderingContext,selected,reported);nativeGlFault("A native batch error escaped its reset policy");}
      if(!Number.isInteger(following)||following<0||following>0xffff_ffff)
        nativeGlFault("Invalid native GL error result in an exact batch drain");
      if(following===0x505)selected=following;
    }
    resetBatch("native error flags did not clear in an exact batch drain");
  },
});
