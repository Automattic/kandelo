/** Internal callable native receipt adapter. No production import dispatch,
 * channel retry, forwarding or public EGL wait is activated by this module. */
import { ERRNO as E } from "../generated/abi.js";
import type { GbmBoRegistry } from "../dri/registry.js";
import type { GlContextRegistry, GlBinding } from "./registry.js";
import type { GlMuxer } from "./muxer.js";
import type { GlSubmitExecution } from "./submit-execution.js";
import type { GlFenceCandidate, GlFenceLease } from "./fences.js";
import { GlOwnedResultStore, GlNativeResultCustody, GlFenceResultCustody,
  type GlResultOwner, type GlResultLimits, type GlResultMode } from "./owned-result.js";
import { decodeQueryRequest, encodeQueryReply, type QueryBegin, type QueryReceiptReply,
  type QueryReceiptRequest } from "./query-receipt-codec.js";
import { glSubmitExecuting, runGlRendererOperation } from "./submit-drain.js";
import { interruptUniformUpload } from "./uniform-upload.js";
import { runGlQuery } from "./query.js";
import { prepareGlErrorQuery } from "./error-query.js";
import { GL_CLIENT_ERROR_MASK, captureNativeGlErrors } from "./errors.js";
import { repairNativeState } from "./native-recovery.js";
import * as O from "./ops.js";

export type GlQueryPreentry = {state:"immediate"} | {state:"owned-required";reason:"busy"|"forward-only"}
  | {state:"terminal";error:number};
type Reply = {bytes:Uint8Array} | {error:number};
type Custody = GlNativeResultCustody | GlFenceResultCustody;
type Receipt = {
  owner:GlResultOwner; token:bigint; op:number; capacity:number;
  hasCurrent:boolean; context:number|null; draw:number; read:number;
  state:"queued"|"executed"|"rollback"|"retired"; mode:GlResultMode|null; stored:boolean;
  work:GlSubmitExecution|null; lease:GlFenceLease|null; custody:Custody|null;
  candidate:GlFenceCandidate|null; gl:WebGL2RenderingContext|null;
  announced:string|null;
};
type Owner = {owner:GlResultOwner;closed:boolean;highWater:bigint;receipts:Map<bigint,Receipt>};
const readOps = new Set([
  O.QOP_GET_STRING,O.QOP_GET_INTEGERV,O.QOP_GET_FLOATV,O.QOP_GET_ATTRIB_LOC,
  O.QOP_GET_SHADERIV,O.QOP_GET_SHADER_INFO_LOG,O.QOP_GET_PROGRAMIV,O.QOP_GET_PROGRAM_INFO_LOG,
  O.QOP_READ_PIXELS,O.QOP_CHECK_FB_STATUS,O.QOP_GET_SHADER_PRECISION_FORMAT,O.QOP_FINISH,O.QOP_FLUSH,
  O.QOP_GET_ACTIVE_UNIFORM,O.QOP_GET_UNIFORMFV,O.QOP_GET_UNIFORMIV,O.QOP_GET_BUFFER_PARAMETER,
  O.QOP_GET_VERTEX_ATTRIBIV,O.QOP_GET_VERTEX_ATTRIBFV,O.QOP_IS_OBJECT,O.QOP_IS_ENABLED,O.QOP_GET_INDEX_USAGE,
  O.QOP_GET_ACTIVE_ATTRIB,O.QOP_GET_ATTACHED_SHADERS,O.QOP_GET_SHADER_SOURCE,O.QOP_GET_FB_ATTACHMENT,
  O.QOP_GET_RENDERBUFFER_PARAMETER,O.QOP_GET_TEX_PARAMETER,O.QOP_GET_UNIFORM_VALUES,O.QOP_GET_ACTIVE_UNIFORM_INFO,
]);
function sourceFence(op:number):boolean { return op===O.QOP_FENCE_STATUS || op===O.QOP_RELEASE_FENCE; }
function validShape(b:QueryBegin):number {
  if (!Number.isInteger(b.op) || b.op<0 || b.op>0xffff_ffff || !Number.isSafeInteger(b.capacity)
    || b.capacity<0 || b.capacity>65536 || b.input.byteLength>65536) return E.EINVAL;
  if (b.op===O.QOP_GET_ERROR) {
    if (b.capacity!==4 || (b.input.byteLength!==0 && b.input.byteLength!==4)) return E.EINVAL;
    return b.input.byteLength && (new DataView(b.input.buffer,b.input.byteOffset,4).getUint32(0,true)&~GL_CLIENT_ERROR_MASK) ? E.EINVAL : 0;
  }
  if (sourceFence(b.op) || b.op===O.QOP_CREATE_FENCE)
    return b.input.byteLength===4 && b.capacity===16 && new DataView(b.input.buffer,b.input.byteOffset,4).getUint32(0,true)!==0 ? 0 : E.EINVAL;
  if (b.op===O.QOP_FINISH || b.op===O.QOP_FLUSH) return b.input.byteLength===0 && b.capacity===0 ? 0 : E.EINVAL;
  // Allocation/mutation query families need their own typed publication
  // candidates. They are ordinary unimplemented adapter work, never a boundary.
  if (!readOps.has(b.op)) return E.ENOSYS;
  const n=b.input.byteLength, out=b.capacity;
  const minimum=(input:number,output:number)=>n>=input && out>=output ? 0 : E.EINVAL;
  switch(b.op) {
    case O.QOP_GET_ATTRIB_LOC:
      return n>=8 && new DataView(b.input.buffer,b.input.byteOffset,n).getUint32(4,true)<=n-8 && out>=4 ? 0 : E.EINVAL;
    case O.QOP_GET_SHADERIV: case O.QOP_GET_PROGRAMIV: case O.QOP_GET_UNIFORMFV: case O.QOP_GET_UNIFORMIV:return minimum(8,4);
    case O.QOP_READ_PIXELS:return minimum(24,0);
    case O.QOP_GET_SHADER_PRECISION_FORMAT:return minimum(8,12);
    case O.QOP_GET_ACTIVE_UNIFORM:return minimum(12,12);
    case O.QOP_GET_UNIFORM_VALUES:return n===12 && out>=76 ? 0 : E.EINVAL;
    case O.QOP_GET_BUFFER_PARAMETER:case O.QOP_IS_OBJECT:case O.QOP_GET_RENDERBUFFER_PARAMETER:case O.QOP_GET_TEX_PARAMETER:
      return n===8 && out>=12 ? 0 : E.EINVAL;
    case O.QOP_GET_VERTEX_ATTRIBIV:case O.QOP_GET_VERTEX_ATTRIBFV:
      return n===8 && out>=(new DataView(b.input.buffer,b.input.byteOffset,n).getUint32(4,true)===0x8626?24:12) ? 0 : E.EINVAL;
    case O.QOP_IS_ENABLED:return n===4 && out>=12 ? 0 : E.EINVAL;
    case O.QOP_GET_INDEX_USAGE:return n===12 && out>=8204 ? 0 : E.EINVAL;
    case O.QOP_GET_FB_ATTACHMENT:return n===8 && out>=24 ? 0 : E.EINVAL;
    case O.QOP_GET_ACTIVE_UNIFORM_INFO:case O.QOP_GET_ACTIVE_ATTRIB:
    case O.QOP_GET_ATTACHED_SHADERS:case O.QOP_GET_SHADER_SOURCE: {
      const active=b.op===O.QOP_GET_ACTIVE_UNIFORM_INFO || b.op===O.QOP_GET_ACTIVE_ATTRIB;
      const input=active?16:12, header=active?12:4, unit=b.op===O.QOP_GET_ATTACHED_SHADERS?4:1;
      if(n!==input)return E.EINVAL;
      const capacity=new DataView(b.input.buffer,b.input.byteOffset,n).getUint32(n-4,true);
      return capacity<=Math.floor((65536-8-header)/unit) && out>=header+capacity*unit+8 ? 0 : E.EINVAL;
    }
    default:return minimum(4,4);
  }
}

/** Dependencies are existing device registries, not request cleanup closures.
 * queueWakeup receives scalars only; integration MUST queue a later worker
 * turn, not reenter Rust on an import stack. No guest views are retained. */
export class GlNativeQueryAdapter {
  private store:GlOwnedResultStore;
  private owners=new Map<GlResultOwner,Owner>();
  private count=0;
  private draining=false;
  private cursor=0;
  private limits:GlResultLimits;
  constructor(private registry:GlContextRegistry,private bos:GbmBoRegistry,
    private muxers:WeakMap<WebGL2RenderingContext,GlMuxer>,limits:GlResultLimits,
    private queueWakeup:(pid:number,session:number,registration:number,token:bigint)=>void) {
    this.store=new GlOwnedResultStore(limits); this.limits=Object.freeze({...limits});
  }
  register(pid:number,session:number):GlResultOwner|null {
    const binding=this.registry.get(pid,session);
    if (!binding || binding.operations.immediateState()==="closed") return null;
    const owner=this.store.openOwner(pid,session,binding.operations);
    if (!owner) return null;
    if (!this.owners.has(owner)) {
      try { this.owners.set(owner,{owner,closed:false,highWater:0n,receipts:new Map()}); }
      catch { this.store.retireOwner(owner); return null; }
    }
    return owner;
  }
  preentry(owner:GlResultOwner,b:QueryBegin):GlQueryPreentry {
    const authority=this.owners.get(owner), binding=this.registry.get(owner.pid,owner.sessionId);
    if (!authority || authority.closed || !binding || binding.operations!==owner.operations) return {state:"terminal",error:E.EIO};
    const error=validShape(b); if (error) return {state:"terminal",error};
    const state=binding.operations.immediateState();
    if (state==="closed" || state==="exhausted") return {state:"terminal",error:E.EIO};
    if (!sourceFence(b.op) && (!b.hasCurrent || b.context!==binding.contextId || !binding.currentDrawable
      || b.draw!==binding.currentDrawable.drawSurfaceId || b.read!==binding.currentDrawable.readSurfaceId)) return {state:"terminal",error:E.EACCES};
    // Existing fences use the exact source lease, independently of an old
    // informational context id or current/display retirement.
    if (binding.forward) return {state:"owned-required",reason:"forward-only"};
    const gl=sourceFence(b.op)
      ? binding.fences.contextFor(new DataView(b.input.buffer,b.input.byteOffset,4).getUint32(0,true)) : binding.gl;
    if (sourceFence(b.op) && (!gl || !this.muxers.has(gl))) return {state:"terminal",error:E.EINVAL};
    if (gl && glSubmitExecuting(this.muxers.get(gl))) return {state:"terminal",error:E.EIO};
    if (!sourceFence(b.op) && (!gl || !this.muxers.has(gl))) return {state:"terminal",error:E.ENODEV};
    return state==="busy" ? {state:"owned-required",reason:"busy"} : {state:"immediate"};
  }
  control(owner:GlResultOwner,bytes:Uint8Array):Reply {
    const authority=this.owners.get(owner); if (!authority) return {error:E.EACCES};
    let request:QueryReceiptRequest;
    try { request=decodeQueryRequest(bytes); } catch { return {error:E.EINVAL}; }
    let receipt=authority.receipts.get(request.token);
    if (request.control==="begin") {
      const b=request.begin!;
      if (receipt) {
        if (receipt.op!==b.op || receipt.capacity!==b.capacity || receipt.hasCurrent!==b.hasCurrent
          || receipt.context!==b.context || receipt.draw!==b.draw || receipt.read!==b.read) return {error:E.EINVAL};
      } else {
        const preentry=this.preentry(owner,b);
        if (preentry.state==="terminal") return this.rejected(request,preentry.error);
        if (preentry.state==="owned-required" && preentry.reason==="forward-only") return this.rejected(request,E.ENOSYS);
        if (request.token<=authority.highWater || this.count>=this.limits.maxRequests) return this.rejected(request,E.ENOMEM);
        // Reserve the bounded rollback receiver before the first native lease.
        // Even failed Begin cleanup owns actual custody, not a numeric promise.
        try {
          receipt={owner,token:request.token,op:b.op,capacity:b.capacity,hasCurrent:b.hasCurrent,
            context:b.context,draw:b.draw,read:b.read,state:"rollback",mode:"cancel",stored:false,work:null,lease:null,custody:null,candidate:null,gl:null,announced:null};
          authority.receipts.set(request.token,receipt); authority.highWater=request.token; this.count++;
        } catch { return this.rejected(request,E.ENOMEM); }
        try {
          const binding=this.registry.get(owner.pid,owner.sessionId)!;
          if (sourceFence(b.op)) {
            receipt.lease=binding.fences.acquire(new DataView(b.input.buffer,b.input.byteOffset,4).getUint32(0,true));
            if (!receipt.lease) throw new Error("Source fence is unavailable");
            receipt.gl=receipt.lease.context;
            const muxer=this.muxers.get(receipt.gl); if (!muxer || glSubmitExecuting(muxer)) throw new Error("Source renderer is unavailable");
            receipt.custody=new GlFenceResultCustody(owner,receipt.lease,b.op===O.QOP_FENCE_STATUS?"status":"release",muxer);
          } else {
            receipt.gl=binding.gl;
            const muxer=receipt.gl && this.muxers.get(receipt.gl); if (!muxer) throw new Error("Renderer is unavailable");
            receipt.work=this.registry.retainSubmitExecution(binding,muxer);
            if (!receipt.work) throw new Error("Context lease is unavailable");
            receipt.custody=new GlNativeResultCustody(receipt.work,null,muxer);
            if (!receipt.work.admitted) throw new Error("Drawable lease is unavailable");
          }
          if (this.store.begin(owner,request.token,b.op,b.input,b.capacity,receipt.custody)!=="admitted") throw new Error("Result storage admission failed");
          receipt.stored=true;receipt.state="queued";receipt.mode=null;
        } catch { /* The preallocated receiver retains every captured resource. */ }
      }
    } else if (!receipt) return {error:E.ENOENT};
    if (!receipt) return {error:E.EIO};
    if (request.control==="commit" || request.control==="cancel") {
      const mode=request.control;
      if (!receipt.stored) { if (mode!=="cancel") return {error:E.EIO}; }
      else if (!this.store[mode](owner,receipt.token)) return {error:E.EIO};
      receipt.mode??=mode;
    }
    if (receipt.mode) this.retire(receipt);
    let phase=this.phase(receipt); if (!phase) return {error:E.EIO};
    if (request.control==="begin" && phase.phase==="retired") {
      if (receipt.stored) return {error:E.EIO};
      phase={phase:"retiring",mode:"cancel"};
    }
    let reply:Uint8Array;
    try { reply=encodeQueryReply(phase,{control:request.control,token:request.token,capacity:receipt.capacity,
      ...(request.control!=="begin" && receipt.mode ? {retirementMode:receipt.mode} : {})}); }
    catch { return {error:E.EIO}; }
    if (request.control==="forget") {
      if (phase.phase!=="retired") return {error:E.EIO};
      if (receipt.stored && !this.store.forget(owner,receipt.token)) return {error:E.EIO};
      authority.receipts.delete(receipt.token);this.count--;
    }
    return {bytes:reply};
  }
  private rejected(request:QueryReceiptRequest,error:number):Reply {
    return {bytes:encodeQueryReply({phase:"rejected",error},{control:"begin",token:request.token,capacity:request.begin!.capacity})};
  }
  private phase(r:Receipt):QueryReceiptReply|null {
    if (r.state==="rollback") return {phase:"retiring",mode:"cancel"};
    if (r.state==="retired" && !r.stored) return {phase:"retired",mode:"cancel",accepted:true};
    const state=this.store.poll(r.owner,r.token);
    switch(state.state) {
      case "pending": return {phase:"pending"};
      case "ready": return {phase:"ready",result:state.rc,bytes:state.bytes};
      case "retiring": return {phase:"retiring",mode:state.mode};
      case "retired": return {phase:"retired",mode:state.mode,accepted:state.accepted};
      default:return null;
    }
  }
  private clearCustody(r:Receipt):void { r.work=null;r.lease=null;r.custody=null;r.candidate=null;r.gl=null;r.state="retired"; }
  private retire(r:Receipt):void {
    if (r.state==="retired" || !r.mode) return;
    const muxer=r.gl && this.muxers.get(r.gl);
    if (r.gl && !muxer) return;
    if (muxer) {runGlRendererOperation(muxer,()=>this.retireNative(r,muxer));return;}
    this.retireNative(r,null);
  }
  private retireNative(r:Receipt,muxer:GlMuxer|null):void {
    try {
      muxer?.captureCurrentErrors();
      if (r.candidate && !r.candidate.cancelRetirement()) return;
      r.candidate=null;
      if (r.state==="rollback") {
        if (r.custody) { if (!r.custody.retire("cancel").complete) return; }
        else if (r.lease) { if (!r.lease.releaseRetirement()) return; }
        else if (r.work && !r.work.release()) return;
        this.clearCustody(r);
      } else if (this.store.acknowledgeRetired(r.owner,r.token).state==="retired") this.clearCustody(r);
    } catch { /* Actual custody remains in this bounded receiver for retry. */ }
  }
  private prepare(binding:GlBinding):boolean {
    const gl=binding.gl; if (!gl) return false;
    if (!this.registry.retryExecutionRetirements(gl)) return false;
    this.muxers.get(gl)?.captureCurrentErrors(); if (!repairNativeState(gl)) return false;
    if (this.registry.hasForeignRetirements()) {
      for (const context of this.registry.foreignRetirementContexts()) this.muxers.get(context)?.invalidateCurrent();
      this.registry.retryForeignRetirements();
      if (this.registry.groupHasForeignRetirement(binding)) return false;
    }
    return true;
  }
  /** Explicit bounded turns: blocked heads do not stop runnable peer sessions.
   * Root integration schedules turns/wakeups; this adapter owns no timers. */
  drain(maxVisits:number):number {
    if (!Number.isSafeInteger(maxVisits) || maxVisits<1 || this.draining) return 0;
    this.draining=true;let visited=0;
    try {
      // The metadata inventory is bounded by maxRequests, including rollback
      // receivers and terminal ACKs. Rotate visits so a large blocked owner
      // cannot starve a runnable peer beyond one turn's visit budget.
      const records:Receipt[]=[];
      for (const authority of this.owners.values()) for (const receipt of authority.receipts.values()) records.push(receipt);
      const visits=Math.min(maxVisits,records.length), start=this.cursor;
      for (;visited<visits;visited++) {
        const r=records[(start+visited)%records.length];
        this.cursor=(start+visited+1)%records.length;
        if (r.mode) this.retire(r);
        else if (r.state==="queued" && r.gl) {
          const muxer=this.muxers.get(r.gl);if (!muxer) continue;
          runGlRendererOperation(muxer,()=>{
            const execution=this.store.take(r.owner,r.token);if (!execution) return;
            r.state="executed";let result=-E.EIO;
            try {
              if (r.custody instanceof GlFenceResultCustody) {
                const status=r.op===O.QOP_FENCE_STATUS?r.custody.poll():false;
                if (status===null) throw new Error("Fence status failed");
                const out=new DataView(execution.output.buffer,execution.output.byteOffset,16);
                out.setUint32(0,0,true);out.setUint32(4,new DataView(execution.input.buffer,execution.input.byteOffset,4).getUint32(0,true),true);
                out.setUint32(8,status?1:0,true);out.setUint32(12,0x47514c33,true);result=16;
              } else if (r.work && r.custody instanceof GlNativeResultCustody) {
                const custody=r.custody;
                result=r.work.run(()=>{
                  const binding=r.work!.binding;
                  const interrupted=interruptUniformUpload(binding);
                  if (interrupted && r.op!==O.QOP_GET_ERROR) return -E.EIO;
                  if (!this.prepare(binding)) return -E.EIO;
                  muxer.switchTo(binding);
                  if (r.op===O.QOP_CREATE_FENCE) {
                    const token=new DataView(execution.input.buffer,execution.input.byteOffset,4).getUint32(0,true);
                    if (!binding.fences.has(token)) {
                      const prepared=binding.fences.prepareRetained(binding,token);r.candidate=prepared.candidate;
                      if (prepared.candidate) { if (!custody.adoptCandidate(prepared.candidate)) throw new Error("Candidate transfer failed");r.candidate=null; }
                      if (!prepared.accepted) return -E.EIO;
                    }
                    const out=new DataView(execution.output.buffer,execution.output.byteOffset,16);
                    out.setUint32(0,0,true);out.setUint32(4,token,true);out.setUint32(8,0,true);out.setUint32(12,0x47514c33,true);return 16;
                  }
                  const capture=(gl:WebGL2RenderingContext)=>this.muxers.get(gl)?.captureCurrentErrors();
                  if (!this.registry.cpuImages.prepare(binding,this.bos,capture)) return -E.EIO;
                  this.registry.cpuImages.begin(binding);
                  let rc:number;
                  try {
                    if (r.op===O.QOP_GET_ERROR) {
                      captureNativeGlErrors(binding.gl!,binding);
                      const candidate=prepareGlErrorQuery(binding,execution.input);
                      if (!candidate || !custody.adoptErrorCandidate(candidate)) {candidate?.cancel();return -E.EIO;}
                      new DataView(execution.output.buffer,execution.output.byteOffset,4).setUint32(0,candidate.value,true);rc=4;
                    } else rc=runGlQuery(binding,r.op,execution.input,execution.output);
                  } finally { if (!this.registry.cpuImages.publish(binding,this.bos,capture)) return -E.EIO; }
                  return rc;
                });
              }
            } catch { result=-E.EIO; }
            execution.complete(result);
          });
        }
        const phase=this.phase(r)?.phase;
        if (phase && phase!=="pending" && phase!==r.announced) {
          try { this.queueWakeup(r.owner.pid,r.owner.sessionId,r.owner.registration,r.token);r.announced=phase; }
          catch { /* The durable phase can be notified again on a later turn. */ }
        }
      }
      return Math.min(visited,maxVisits);
    } finally {this.draining=false;}
  }
  retireOwner(owner:GlResultOwner):boolean {
    const authority=this.owners.get(owner);if (!authority) return false;
    authority.closed=true;this.store.retireOwner(owner);
    for (const r of authority.receipts.values()) {r.mode??="cancel";this.retire(r);}
    return true;
  }
  forgetOwner(owner:GlResultOwner):boolean {
    const authority=this.owners.get(owner);if (!authority?.closed) return false;
    for (const r of authority.receipts.values()) if (r.state!=="retired") return false;
    this.store.forgetOwner(owner);this.count-=authority.receipts.size;this.owners.delete(owner);return true;
  }
  retirementComplete(owner:GlResultOwner):boolean {
    const authority=this.owners.get(owner);if (!authority?.closed) return false;
    for (const r of authority.receipts.values()) if (r.state!=="retired") return false;
    return true;
  }
  get retainedBytes():number {return this.store.retainedBytes;}
  get pendingRequests():number {return this.count;}
}
