/** Private kernel-control routing. Public ioctl parking is not enabled here. */
import { isKernelExportFailure } from "../kernel-entry-gate.js";
import { ERRNO as E } from "../generated/abi.js";
import type { GbmBoRegistry } from "../dri/registry.js";
import type { GlContextRegistry } from "./registry.js";
import { GlMuxer } from "./muxer.js";
import { GlNativeQueryAdapter } from "./native-query-adapter.js";
import { GlOwnedForwardClient } from "./owned-forward.js";
import type { GlResultLimits, GlResultOwner } from "./owned-result.js";
import { decodeQueryRequest, decodeQueryReply, encodeQueryReply, QUERY_RECEIPT_REPLY_HEADER,
  type QueryReceiptRequest, type QueryMode, type QueryReceiptReply } from "./query-receipt-codec.js";

type Reply={bytes:Uint8Array}|{error:number};
type Record={capacity:number;mode:QueryMode|null;phase:QueryReceiptReply["phase"]|null;result:number|null;admitted:boolean};
type Owner={owner:GlResultOwner;backend:GlNativeQueryAdapter|GlOwnedForwardClient;closed:boolean;forgotten:boolean;records:Map<bigint,Record>};

/** Owner and token metadata is reserved before native admission. Later Poll,
 * Commit and Cancel use this exact registration, even after public removal;
 * neither a reused numeric session nor a control can register a replacement. */
export class GlKernelQueryControls {
  private native:GlNativeQueryAdapter;
  private owners=new Map<string,Owner>();
  private count=0;
  private clients=new Set<GlOwnedForwardClient>();
  private cursor=0;
  constructor(private registry:GlContextRegistry,bos:GbmBoRegistry,
    private muxers:WeakMap<WebGL2RenderingContext,GlMuxer>,private limits:GlResultLimits,
    wake:(pid:number,session:number,registration:number,token:bigint)=>void,
    private ownerWake?:(pid:number,session:number,registration:number)=>void,
    private workWake?:(pid:number,session:number,registration:number)=>void) {
    this.limits=Object.freeze({...limits});
    this.native=new GlNativeQueryAdapter(registry,bos,muxers,this.limits,wake);
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
      const binding=this.registry.get(pid,session);
      if (!binding||authority?.closed||authority&&authority.owner.operations!==binding.operations) return reject(E.EACCES);
      const backend=binding.forward ? binding.forward.ownedQueries : this.native;
      if(!backend)return reject(E.ENOSYS);
      if(authority && authority.backend!==backend)return reject(E.EACCES);
      // Queued outbound command admission is deliberately not enabled in this
      // private increment. Refuse a new forwarded query before effects while
      // any earlier local operation/scalar retirement barrier is outstanding.
      if(backend instanceof GlOwnedForwardClient && (binding.operations.immediateState()!=="idle"
        || backend.hasBarrier(session)))return reject(E.EBUSY);
      if (this.count>=this.limits.maxRequests) return reject(E.ENOMEM);
      try {
        if (binding.gl&&!this.muxers.has(binding.gl)) this.muxers.set(binding.gl,new GlMuxer(binding.gl));
      }catch{return reject(E.ENOMEM);}
      if (!authority) {
        if(this.owners.size>=this.limits.maxOwners)return reject(E.ENOMEM);
        if(backend instanceof GlOwnedForwardClient) {
          if(!this.clients.has(backend) && this.clients.size>=this.limits.maxOwners)return reject(E.ENOMEM);
          // Retain the actual endpoint driver before registration can send an
          // Open. Even failed central metadata allocation must not orphan it.
          try {this.clients.add(backend);}catch{return reject(E.ENOMEM);}
        }
        const owner=backend instanceof GlOwnedForwardClient ? backend.register(session,binding.operations) : backend.register(pid,session);
        if (!owner) return reject(E.ENOMEM);
        if(backend instanceof GlOwnedForwardClient) {
          backend.watchOwner(owner,(pid,session,registration)=>{
            this.ownerWake?.(pid,session,registration);this.workWake?.(pid,session,registration);
          });
          backend.watchWork(owner,this.workWake);
        }
        try {
          authority={owner,backend,closed:false,forgotten:false,records:new Map()};this.owners.set(key,authority);
        }catch{
          backend.retireOwner(owner);backend.forgetOwner(owner);return reject(E.ENOMEM);
        }
      }
      try {
        record={capacity,mode:null,phase:null,result:null,admitted:false};authority.records.set(request.token,record);this.count++;
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
    try {result=authority.backend instanceof GlOwnedForwardClient
      ? this.forward(authority.backend,authority.owner,request,record)
      : authority.backend.control(authority.owner,bytes);}catch(error){if(isKernelExportFailure(error))throw error;return {error:E.EIO};}
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
  private forward(client:GlOwnedForwardClient,owner:GlResultOwner,request:QueryReceiptRequest,record:Record):Reply {
    if(request.control==="begin") {
      if(!client.begin(owner,request.token,request.begin!))return record.admitted ? {error:E.EINVAL} : {bytes:encodeQueryReply(
        {phase:"rejected",error:E.EACCES},{control:"begin",token:request.token,capacity:record.capacity})};
      record.admitted=true;
    }
    if((request.control==="commit" || request.control==="cancel") && !client.control(owner,request.token,request.control))return {error:E.EIO};
    const state=client.poll(owner,request.token);let reply:QueryReceiptReply;
    switch(state.state) {
      case "pending":reply={phase:"pending"};break;
      case "ready":reply={phase:"ready",result:state.rc,bytes:state.bytes};break;
      case "retiring":reply={phase:"retiring",mode:state.mode};break;
      case "retired":reply={phase:"retired",mode:state.mode,accepted:state.accepted};break;
      default:return {error:E.EIO};
    }
    const bytes=encodeQueryReply(reply,{control:request.control,token:request.token,capacity:record.capacity,
      ...(request.control!=="begin" && record.mode ? {retirementMode:record.mode} : {})});
    if(request.control==="forget" && (reply.phase!=="retired" || !client.forget(owner,request.token)))return {error:E.EIO};
    return {bytes};
  }
  drain(maxVisits:number):number {
    if(!Number.isSafeInteger(maxVisits)||maxVisits<0)return 0;
    const backends=[this.native,...this.clients],count=Math.min(maxVisits,backends.length);let visits=0;
    for(let index=0;index<count;index++) {
      const quota=Math.floor((maxVisits-visits)/(count-index));
      this.cursor%=backends.length;backends[this.cursor].drain(quota);this.cursor=(this.cursor+1)%backends.length;visits+=quota;
    }
    for(const client of this.clients)if(client.idle)this.clients.delete(client);
    return visits;
  }
  drainNative(maxVisits:number):number {return this.native.drain(maxVisits);}
  get runnableAfterDrain():boolean {return this.native.runnableAfterDrain || [...this.clients].some(client=>client.runnableAfterDrain);}
  private retirementComplete(authority:Owner):boolean {
    if(authority.backend instanceof GlOwnedForwardClient && authority.backend.ownerForgotten(authority.owner))authority.forgotten=true;
    return authority.forgotten || authority.backend.retirementComplete(authority.owner);
  }
  /** Call before a destructive lifecycle transition. This reports actual
   * native cleanup, and retains every ACK until Rust consumes its receipt. */
  prepareTeardown(pid:number):boolean {
    let complete=true;
    for (const authority of this.owners.values()) if (authority.owner.pid===pid) {
      authority.closed=true;
      if(authority.forgotten)continue;
      for (const record of authority.records.values()) record.mode??="cancel";
      authority.backend.retireOwner(authority.owner);
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
      if(authority.backend instanceof GlOwnedForwardClient) {
        if(!authority.backend.ownerForgotten(authority.owner))authority.backend.forgetOwner(authority.owner);
        authority.forgotten=authority.backend.ownerForgotten(authority.owner);
      }else authority.forgotten=authority.backend.forgetOwner(authority.owner);
      if(!authority.forgotten)return false;
    }
    for (const [key,authority] of this.owners)if(authority.owner.pid===pid) {this.count-=authority.records.size;this.owners.delete(key);}
    return true;
  }
}
