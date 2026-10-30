/** Optional host-only final render-node cleanup. No Rust release is enabled. */
import { isKernelExportFailure } from "../kernel-entry-gate.js";
import type { GbmBoRegistry } from "../dri/registry.js";
import type { GlContextRegistry, GlBoRetirement } from "./registry.js";
import { GlMuxer } from "./muxer.js";
import type { GlResultOwner } from "./owned-result.js";
import { GlForwardNativeRetirement } from "./forward-retirement.js";
import { captureNativeGlErrors } from "./errors.js";
import { glSubmitExecuting } from "./submit-drain.js";

export type GlFinalRenderNodeOwner=GlResultOwner;
export type GlFinalRenderNodeState="pending"|"rejecting"|"rejected"|"retired";
type Record={owner:GlFinalRenderNodeOwner;token:bigint;bytes:Uint8Array<ArrayBuffer>;sessions:GlForwardNativeRetirement[];
  bos:GlBoRetirement[];capabilities:number;prepared:boolean;started:boolean;waitingPrefix:boolean;dirty:boolean;notificationFault:boolean;state:GlFinalRenderNodeState;notify:()=>void;wake?:()=>void};
/** Each effect is two little-endian u32s: 1=unbind own exact session,
 * 2=destroy BO. No mapping pointers, foreign owner, Card/KMS or callback payload. */
export function finalRenderNodeEffects(effects:readonly (readonly [1|2,number])[]):Uint8Array<ArrayBuffer> {
  const bytes=new Uint8Array(effects.length*8),view=new DataView(bytes.buffer);
  effects.forEach(([kind,source],i)=>{view.setUint32(i*8,kind,true);view.setUint32(i*8+4,source,true);});return bytes;
}
export class GlFinalRenderNodeReceiver {
  private records=new Map<string,Record>();
  private retained=0;
  private capabilities=0;
  private cursor=0;
  private floors=new WeakMap<GlFinalRenderNodeOwner,bigint>();
  private key(owner:GlFinalRenderNodeOwner,token:bigint):string {return `${owner.pid}/${owner.sessionId}/${owner.registration}/${token}`;}
  constructor(private registry:GlContextRegistry,private bos:GbmBoRegistry,private muxers:WeakMap<WebGL2RenderingContext,GlMuxer>,
    private maxRecords:number,private maxBytes:number,private maxCapabilities:number) {
    if(!Number.isSafeInteger(maxRecords)||maxRecords<0||!Number.isSafeInteger(maxBytes)||maxBytes<0||!Number.isSafeInteger(maxCapabilities)||maxCapabilities<0)throw new RangeError("invalid final-file budget");
  }
  /** Terminal refusal must revoke token admission even when no payload/record
   * budget is available. Existing accepted records always retain their authority.
   * One monotonic scalar per exact owner bounds rejection/replay metadata. */
  rejectUnaccepted(owner:GlFinalRenderNodeOwner,token:bigint):boolean {
    if(typeof token!=="bigint"||token<=0n||token>0x7fff_ffff_ffff_ffffn||this.records.has(this.key(owner,token)))return false;
    this.floors.set(owner,token>(this.floors.get(owner)??0n)?token:this.floors.get(owner)!);return true;
  }
  admissionRevoked(owner:GlFinalRenderNodeOwner,token:bigint):boolean {
    return token>0n && token<=(this.floors.get(owner)??0n) && !this.records.has(this.key(owner,token));
  }
  begin(owner:GlFinalRenderNodeOwner,token:bigint,input:Uint8Array):boolean {
    const previous=this.records.get(this.key(owner,token));
    if(previous)return previous.owner===owner && previous.bytes.length===input.length && previous.bytes.every((v,i)=>v===input[i]);
    if(typeof token!=="bigint"||token<=(this.floors.get(owner)??0n)||token<=0n||token>0x7fff_ffff_ffff_ffffn||this.records.size>=this.maxRecords
      ||input.length===0||input.length%8!==0||input.length>65536||input.length>this.maxBytes-this.retained)return false;
    const binding=this.registry.get(owner.pid,owner.sessionId);
    if(!Number.isSafeInteger(owner.registration)||owner.registration<=0||!binding||binding.operations!==owner.operations)return false;
    let bytes:Uint8Array<ArrayBuffer>;
    try {bytes=new Uint8Array(input);}catch{return false;}
    let capabilities=0,refuseCpuPrefix=false;
    const seen=new Set<string>(),view=new DataView(bytes.buffer);
    for(let i=0;i<input.length;i+=8) {
      const kind=view.getUint32(i,true),source=view.getUint32(i+4,true),key=`${kind}/${source}`;
      if((kind!==1&&kind!==2)||source===0||seen.has(key)||kind===1&&source!==owner.sessionId)return false;
      if(kind===2&&(!this.registry.canCaptureBoRetirement(source)||!this.registry.gpuBo(source)&&!this.bos.dims(source)))return false;
      // CPU mirror capture reserves its allocation scope. Refuse before capture
      // while an accepted prefix might still create/use a mirror; a later
      // numeric retry must not turn this rejection into final-device effects.
      if(kind===2 && !this.registry.gpuBo(source) && owner.operations.immediateState()==="busy")refuseCpuPrefix=true;
      capabilities+=kind===1?3+binding.fences.retirementCaptureCost+this.registry.executionRetirementCaptureCost(owner.pid,owner.sessionId):this.registry.retirementCaptureCost(source);
      seen.add(key);
    }
    if(refuseCpuPrefix)capabilities=0;
    if(capabilities>this.maxCapabilities-this.capabilities)return false;
    try {
      // Reserve/copy the entire record before taking the first capability.
      const weak=new WeakRef(this),notify=()=>weak.deref()?.progress(owner,token);
      const record:Record={owner,token,bytes,sessions:(refuseCpuPrefix?[]:[...seen]).filter(key=>key.startsWith("1/")).map(()=>new GlForwardNativeRetirement("session",0,owner.pid,owner.sessionId,owner.operations,true)),bos:[],capabilities,prepared:false,started:false,waitingPrefix:false,dirty:true,notificationFault:false,state:refuseCpuPrefix?"rejected":"rejecting",notify};
      this.records.set(this.key(owner,token),record);this.retained+=input.length;this.capabilities+=capabilities;
      for(const session of record.sessions)session.watch(record.notify);
      if(!refuseCpuPrefix)try {if(this.capture(record))record.state="pending";}catch(error){if(isKernelExportFailure(error))throw error;}
      return true;
    }catch(error){if(isKernelExportFailure(error))throw error;return false;}
  }
  private capture(record:Record):boolean {
    if(record.prepared)return true;
    const view=new DataView(record.bytes.buffer);
    let needed=0;for(let i=0;i<record.bytes.length;i+=8)needed+=view.getUint32(i,true)===1?3+(this.registry.get(record.owner.pid,record.owner.sessionId)?.fences.retirementCaptureCost??0)+this.registry.executionRetirementCaptureCost(record.owner.pid,record.owner.sessionId):this.registry.retirementCaptureCost(view.getUint32(i+4,true));
    if(needed>record.capabilities) {
      const extra=needed-record.capabilities;if(extra>this.maxCapabilities-this.capabilities)return false;
      this.capabilities+=extra;record.capabilities=needed;
    }
    // Initial capability capture runs once. Partial failure enters retained
    // rollback; it must never retry a numeric source against replacement state.
    // No effect revokes until EVERY actual cleanup receiver is reserved.
    let sessionIndex=0,boIndex=0;
    for(let i=0;i<record.bytes.length;i+=8) {
      const kind=view.getUint32(i,true),source=view.getUint32(i+4,true);
      if(kind===1) {
        const binding=this.registry.get(record.owner.pid,source);
        if(binding?.gl && !this.muxers.has(binding.gl))this.muxers.set(binding.gl,new GlMuxer(binding.gl));
        let receiver=record.sessions[sessionIndex++];
        if(!receiver)return false;
        if(!receiver.prepare(this.registry,this.muxers))return false;
      } else {
        let receiver=record.bos[boIndex++];
        if(!receiver){receiver=this.registry.captureBoRetirement(source,!!this.bos.dims(source))!;if(!receiver)return false;record.bos.push(receiver);receiver.watch(record.notify);}
      }
    }
    record.prepared=true;return true;
  }
  private progress(owner:GlFinalRenderNodeOwner,token:bigint):void {
    const record=this.records.get(this.key(owner,token));if(!record||record.owner!==owner)return;
    if(record.state==="retired"||record.state==="rejected")return;
    record.dirty=true;
    try {record.wake?.();}catch(error){if(isKernelExportFailure(error))throw error;}
  }
  watch(owner:GlFinalRenderNodeOwner,token:bigint,wake:()=>void):boolean {
    const record=this.records.get(this.key(owner,token));if(!record||record.owner!==owner)return false;
    record.wake=wake;if(record.dirty||record.state==="retired"||record.state==="rejected")wake();return true;
  }
  poll(owner:GlFinalRenderNodeOwner,token:bigint):GlFinalRenderNodeState|null {const record=this.records.get(this.key(owner,token));return record?.owner===owner?record.state:null;}
  retry(owner:GlFinalRenderNodeOwner,token:bigint):boolean {const record=this.records.get(this.key(owner,token));if(!record||record.owner!==owner)return false;record.dirty=true;return true;}
  drain(quota:number):number {
    if(!Number.isSafeInteger(quota)||quota<0)return 0;
    const records=[...this.records.values()];let visits=0;
    for(let i=0;i<records.length&&visits<quota;i++) {
      this.cursor%=records.length;const record=records[this.cursor];this.cursor=(this.cursor+1)%records.length;
      if(record.waitingPrefix && record.owner.operations.immediateState()==="idle")record.dirty=true;
      if(!record.dirty||record.state==="retired"||record.state==="rejected")continue;
      record.dirty=false;visits++;
      try {
        if(record.state==="rejecting") {
          let released=true;
          for(const session of record.sessions)released=session.abandonPreparation(this.muxers)&&released;
          if(!released)continue;
          for(const bo of record.bos)released=this.registry.abandonBoRetirement(bo)&&released;
          if(released){record.state="rejected";record.dirty=false;record.wake?.();}continue;
        }
        if(!record.prepared)continue;
        if(!record.started && record.owner.operations.immediateState()==="busy") {record.waitingPrefix=true;continue;}
        record.started=true;record.waitingPrefix=false;
        const contexts=new Set<WebGL2RenderingContext>();for(const bo of record.bos)for(const gl of bo.contexts())contexts.add(gl);
        if([...contexts].some(gl=>glSubmitExecuting(this.muxers.get(gl))))continue;
        for(const gl of contexts){const muxer=this.muxers.get(gl);if(muxer)muxer.captureCurrentErrors();else captureNativeGlErrors(gl,null);}
        let complete=true;
        for(const session of record.sessions)complete=(session.revoke(this.registry,this.muxers)&&session.retry(this.muxers))&&complete;
        for(const bo of record.bos)complete=this.registry.retireCapturedBo(bo)&&complete;
        if(complete) {
          // Native cleanup is proven before CPU metadata notification. A
          // throwing observer is never retried as though it were cleanup.
          for(const bo of record.bos)try {this.bos.destroy(record.owner.pid,bo.bo);}catch(error){if(isKernelExportFailure(error))throw error;record.notificationFault=true;}
          record.state="retired";record.dirty=false;record.wake?.();
        }
      }catch(error){if(isKernelExportFailure(error))throw error;record.dirty=false;}
    }
    return visits;
  }
  notificationFault(owner:GlFinalRenderNodeOwner,token:bigint):boolean {const record=this.records.get(this.key(owner,token));return record?.owner===owner && record.notificationFault;}
  forget(owner:GlFinalRenderNodeOwner,token:bigint):boolean {
    const record=this.records.get(this.key(owner,token));if(!record||record.owner!==owner||record.state!=="retired"&&record.state!=="rejected")return false;
    for(const session of record.sessions)session.forget();for(const bo of record.bos)if(record.state==="retired")this.registry.forgetBoRetirement(bo);
    this.floors.set(owner,token>(this.floors.get(owner)??0n)?token:this.floors.get(owner)!);this.retained-=record.bytes.length;this.capabilities-=record.capabilities;this.records.delete(this.key(owner,token));return true;
  }
  sessionReceiver(owner:GlFinalRenderNodeOwner):GlForwardNativeRetirement|null {
    for(const record of this.records.values())if(record.owner===owner && record.prepared && record.state!=="rejecting"&&record.state!=="rejected" && record.sessions.length)return record.sessions[0];return null;
  }
  retirementComplete(owner:GlFinalRenderNodeOwner):boolean {return [...this.records.values()].every(record=>record.owner!==owner||record.state==="retired"||record.state==="rejected");}
  forgetOwner(owner:GlFinalRenderNodeOwner):boolean {
    if(!this.retirementComplete(owner))return false;
    for(const record of [...this.records.values()])if(record.owner===owner)this.forget(owner,record.token);return true;
  }
  get retainedCapabilities():number {return this.capabilities;}
  get retainedBytes():number {return this.retained;}
  get pending():number {return this.records.size;}
  get runnable():boolean {return [...this.records.values()].some(record=>(record.dirty || record.waitingPrefix && record.owner.operations.immediateState()==="idle")&&record.state!=="retired"&&record.state!=="rejected");}
}
