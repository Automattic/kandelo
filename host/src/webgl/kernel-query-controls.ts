/** Private kernel-control routing. Public ioctl parking is not enabled here. */
import { isKernelExportFailure } from "../kernel-entry-gate.js";
import { ERRNO as E } from "../generated/abi.js";
import type { GbmBoRegistry } from "../dri/registry.js";
import type { GlContextRegistry } from "./registry.js";
import { GlMuxer } from "./muxer.js";
import { GlNativeQueryAdapter } from "./native-query-adapter.js";
import type { GlResultLimits, GlResultOwner } from "./owned-result.js";
import { decodeQueryRequest, decodeQueryReply, encodeQueryReply, QUERY_RECEIPT_REPLY_HEADER,
  type QueryReceiptRequest, type QueryMode, type QueryReceiptReply } from "./query-receipt-codec.js";

type Reply={bytes:Uint8Array}|{error:number};
type Record={capacity:number;mode:QueryMode|null;phase:QueryReceiptReply["phase"]|null;result:number|null};
type Owner={owner:GlResultOwner;closed:boolean;forgotten:boolean;records:Map<bigint,Record>};

/** Owner and token metadata is reserved before native admission. Later Poll,
 * Commit and Cancel use this exact registration, even after public removal;
 * neither a reused numeric session nor a control can register a replacement. */
export class GlKernelQueryControls {
  private native:GlNativeQueryAdapter;
  private owners=new Map<string,Owner>();
  private count=0;
  constructor(private registry:GlContextRegistry,bos:GbmBoRegistry,
    private muxers:WeakMap<WebGL2RenderingContext,GlMuxer>,private limits:GlResultLimits,
    wake:(pid:number,session:number,registration:number,token:bigint)=>void,
    private workWake?:(pid:number,session:number,registration:number)=>void) {
    this.limits=Object.freeze({...limits});
    this.native=new GlNativeQueryAdapter(registry,bos,muxers,this.limits,wake);
  }
  /** Freeze the actual endpoint/native owner before the first possibly
   * uncertain Begin. Only a known live exact binding may mint this authority;
   * later controls and wakes use the same object, never a latest-owner lookup. */
  prepareOwner(pid:number,session:number):{owner:GlResultOwner}|{error:number} {
    if (!Number.isInteger(pid)||pid<1||pid>0x7fff_ffff||!Number.isInteger(session)||session<1||session>0xffff_ffff) return {error:E.EINVAL};
    const result=this.ensureOwner(pid,session);
    return "error" in result?result:{owner:result.owner};
  }
  owns(owner:GlResultOwner):boolean {return this.owners.get(`${owner.pid}/${owner.sessionId}`)?.owner===owner;}
  private ensureOwner(pid:number,session:number):Owner|{error:number} {
    const key=`${pid}/${session}`;
    let authority=this.owners.get(key);
    const binding=this.registry.get(pid,session);
    if (!binding||authority?.closed||authority&&authority.owner.operations!==binding.operations) return {error:E.EACCES};
    try {
      if (binding.gl&&!this.muxers.has(binding.gl)) this.muxers.set(binding.gl,new GlMuxer(binding.gl));
    }catch{return {error:E.ENOMEM};}
    if (!authority) {
      if(this.owners.size>=this.limits.maxOwners)return {error:E.ENOMEM};
      const owner=this.native.register(pid,session);
      if (!owner) return {error:E.ENOMEM};
      try {
        authority={owner,closed:false,forgotten:false,records:new Map()};this.owners.set(key,authority);
      }catch{
        this.native.retireOwner(owner);this.native.forgetOwner(owner);return {error:E.ENOMEM};
      }
    }
    return authority!;
  }
  control(pid:number,session:number,bytes:Uint8Array,replyCapacity:number):Reply {
    if (!Number.isInteger(pid)||pid<1||pid>0x7fff_ffff||!Number.isInteger(session)||session<1||session>0xffff_ffff)
      return {error:E.EINVAL};
    let request:QueryReceiptRequest;
    try {request=decodeQueryRequest(bytes);}catch{return {error:E.EINVAL};}
    const key=`${pid}/${session}`;
    let authority=this.owners.get(key),record=authority?.records.get(request.token);
    const capacity=record?.capacity??request.begin?.capacity;
    if (capacity===undefined) return {error:E.ENOENT};
    // The Rust engine reserves the original full reply capacity on every
    // control. Reject undersized scratch before registration or native effects.
    if (!Number.isSafeInteger(replyCapacity)||replyCapacity<QUERY_RECEIPT_REPLY_HEADER+capacity||replyCapacity>QUERY_RECEIPT_REPLY_HEADER+65536)
      return {error:E.EINVAL};
    const reject=(error:number):Reply=>({bytes:encodeQueryReply({phase:"rejected",error},
      {control:"begin",token:request.token,capacity})});
    if (request.control==="begin"&&!record) {
      if (this.count>=this.limits.maxRequests) return reject(E.ENOMEM);
      const prepared=this.ensureOwner(pid,session);
      if ("error" in prepared) return reject(prepared.error);
      authority=prepared;
      try {
        record={capacity,mode:null,phase:null,result:null};authority.records.set(request.token,record);this.count++;
      }catch{return reject(E.ENOMEM);}
    }
    if (!authority||!record) return {error:E.ENOENT};
    if (request.control==="commit"||request.control==="cancel") {
      if (record.mode&&record.mode!==request.control) return {error:E.EINVAL};
      if (request.control==="commit"&&!record.mode&&(record.phase!=="ready"||record.result===null||record.result<0)) return {error:E.EINVAL};
      // Preserve an uncertain retirement request if the native call loses its
      // response. A later Poll must authenticate this same retirement mode.
      record.mode=request.control;
    }
    if (request.control==="forget"&&(!record.mode||record.phase!=="retired")) return {error:E.EINVAL};
    let result:Reply;
    try {result=this.native.control(authority.owner,bytes);}catch(error){if(isKernelExportFailure(error))throw error;return {error:E.EIO};}
    finally {
      // Metadata was reserved before this attempt. Even a lost/malformed
      // backend response cannot strand possibly admitted work. The callback
      // queues a later turn, so admission finishes before execution can start.
      if(request.control!=="forget")this.notifyWork(authority);
    }
    if ("error" in result) return result;
    let reply:QueryReceiptReply;
    try {
      reply=decodeQueryReply(result.bytes,{control:request.control,token:request.token,capacity,
        ...(request.control!=="begin"&&record.mode?{retirementMode:record.mode}:{})});
    }catch{return {error:E.EIO};}
    record.phase=reply.phase;
    if (reply.phase==="ready") record.result=reply.result;
    if (reply.phase==="retiring"||reply.phase==="retired") record.mode=reply.mode;
    if (reply.phase==="rejected"||request.control==="forget") {
      authority.records.delete(request.token);this.count--;
    }
    return result;
  }
  private notifyWork(authority:Owner):void {
    try {this.workWake?.(authority.owner.pid,authority.owner.sessionId,authority.owner.registration);}
    catch(error) {if(isKernelExportFailure(error))throw error; /* Actual custody stays durable. */}
  }
  drain(maxVisits:number):number {
    if(!Number.isSafeInteger(maxVisits)||maxVisits<0)return 0;
    this.native.drain(maxVisits);
    return maxVisits;
  }
  drainNative(maxVisits:number):number {return this.native.drain(maxVisits);}
  get runnableAfterDrain():boolean {return this.native.runnableAfterDrain;}
  private retirementComplete(authority:Owner):boolean {
    return authority.forgotten || this.native.retirementComplete(authority.owner);
  }
  /** Call before a destructive lifecycle transition. This reports actual
   * native cleanup, and retains every ACK until Rust consumes its receipt. */
  prepareTeardown(pid:number):boolean {
    let complete=true;
    for (const authority of this.owners.values()) if (authority.owner.pid===pid) {
      authority.closed=true;
      if(authority.forgotten)continue;
      for (const record of authority.records.values()) record.mode??="cancel";
      this.native.retireOwner(authority.owner);
      if (!this.retirementComplete(authority)) complete=false;
    }
    return complete;
  }
  /** Only an independently completed Rust lifecycle transition permits
   * forgetting terminal metadata. Ready bytes alone are never that proof. */
  forgetAfterKernelLifecycle(pid:number):boolean {
    for (const authority of this.owners.values()) if (authority.owner.pid===pid
      && !this.retirementComplete(authority)) return false;
    for (const authority of this.owners.values()) if (authority.owner.pid===pid) {
      if(authority.forgotten)continue;
      authority.forgotten=this.native.forgetOwner(authority.owner);
      if(!authority.forgotten)return false;
    }
    for (const [key,authority] of this.owners)if(authority.owner.pid===pid) {this.count-=authority.records.size;this.owners.delete(key);}
    return true;
  }
}
