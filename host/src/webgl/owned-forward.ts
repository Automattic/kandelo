/** Optional owned query transport. This composes the real renderer adapter;
 * it does not enable public pending syscalls or infer completion from timeouts. */
import { GlNativeQueryAdapter } from "./native-query-adapter.js";
import { GlOwnedResultStore, GlRemoteResultCustody, GlResultPeer,
  type GlResultOwner, type GlResultLimits, type GlResultPoll, type GlResultMode, type GlResultExecution } from "./owned-result.js";
import { decodeQueryRequest, encodeQueryRequest, decodeQueryReply, encodeQueryReply,
  type QueryBegin, type QueryControl, type QueryReceiptReply, type ExpectedQueryReply } from "./query-receipt-codec.js";
import type { GlOperationStream } from "./operation-stream.js";
import type { GlContextRegistry, GlBinding } from "./registry.js";
import type { GbmBoRegistry } from "../dri/registry.js";
import type { GlMuxer } from "./muxer.js";
import type { SubmitQueue } from "./submit-queue.js";
import { drainSubmitQueue, glSubmitQueueDisposition } from "./submit-drain.js";
import { decodeAndDispatch } from "./bridge.js";
import { recordGlError } from "./errors.js";

export interface GlOwnedForwardEndpoint {
  postMessage(message: unknown): void;
  addEventListener(type:"message", listener:(event:MessageEvent)=>void):void;
  removeEventListener(type:"message", listener:(event:MessageEvent)=>void):void;
}
type Route = {pid:number;sessionId:number;clientRegistration:number};
type Grant = Route & {epoch:number;registration:number};
type Wire = Route & {type:string;epoch?:number;registration?:number;bytes?:ArrayBuffer;control?:QueryControl;token?:bigint;error?:number};
const CAP = 65536;
let epochSerial = 0;
let clientRegistrationSerial = 0;
function positive(value:unknown):value is number {return Number.isSafeInteger(value) && (value as number)>0;}
function routeValid(message:Wire,pid:number):boolean {
  return message.pid===pid && positive(message.sessionId) && message.sessionId<=0xffff_ffff && positive(message.clientRegistration);
}
function independentBytes(value:unknown,max:number):Uint8Array|null {
  // A whole independent bounded ArrayBuffer is the reviewed wire contract.
  // SABs, views (including guest-memory views) and oversized buffers are refused.
  if (!(value instanceof ArrayBuffer) || value.byteLength>max) return null;
  try {return new Uint8Array(value.slice(0));} catch {return null;}
}
function buffer(bytes:Uint8Array):ArrayBuffer {const out=new Uint8Array(bytes.byteLength);out.set(bytes);return out.buffer;}
function expected(control:QueryControl,token:bigint,capacity:number,mode:GlResultMode|null):ExpectedQueryReply {
  return {control,token,capacity,...(mode && control!=="begin" ? {retirementMode:mode} : {})};
}

/** A bounded actual receiver holder, reserved before native admission. Failed
 * cleanup retains the controller, endpoint listener and native custody here.
 * It never claims a transferred/contained retirement acknowledgement. */
export class GlOwnedForwardRetirements {
  private controllers=new Set<GlOwnedMainForwardController>();
  private cursor=0;
  constructor(private maximum:number) {if(!Number.isSafeInteger(maximum)||maximum<0)throw new RangeError("invalid owned renderer budget");}
  retain(controller:GlOwnedMainForwardController):boolean {
    if(this.controllers.has(controller))return true;
    if(this.controllers.size>=this.maximum)return false;
    this.controllers.add(controller);return true;
  }
  release(controller:GlOwnedMainForwardController):void {if(controller.released)this.controllers.delete(controller);}
  drain(maxVisits:number):number {
    if(!Number.isSafeInteger(maxVisits)||maxVisits<0)return 0;
    let visits=0;const controllers=[...this.controllers];
    while(visits<Math.min(maxVisits,controllers.length)) {
      this.cursor%=controllers.length;controllers[this.cursor].drain(1);this.cursor=(this.cursor+1)%controllers.length;visits++;
    }
    return visits;
  }
  get retainedEndpoints():number {return this.controllers.size;}
}
export type GlOwnedMainForwardOptions={endpoint:GlOwnedForwardEndpoint;limits:GlResultLimits;retirements:GlOwnedForwardRetirements;
  bos:GbmBoRegistry;queueDrain?:(epoch:number)=>void};
type ServerReceipt = {capacity:number;entered:boolean;ready:boolean;rejected:number|null;mode:GlResultMode|null;terminal:QueryReceiptReply|null};
type ServerOwner = {grant:Grant;owner:GlResultOwner;closed:boolean;forgotten:boolean;floor:bigint;receipts:Map<bigint,ServerReceipt>};

/** Lives on the SAME endpoint as legacy forwarding, so an earlier submit is
 * admitted before Begin. Numeric message fields select existing authority;
 * only explicit Open against a known live binding grants a generation. */
export class GlOwnedMainForwardController {
  private adapter:GlNativeQueryAdapter;
  private epoch:number;
  private owners=new Map<number,ServerOwner>();
  private records=0;
  private retiredRegistrationFloor=0;
  private closing=false;
  private detached=false;
  private onMessage:(event:MessageEvent)=>void;
  constructor(private endpoint:GlOwnedForwardEndpoint,private pid:number,registry:GlContextRegistry,
    bos:GbmBoRegistry,private muxers:WeakMap<WebGL2RenderingContext,GlMuxer>,private limits:GlResultLimits,
    private retirements:GlOwnedForwardRetirements,private submits:SubmitQueue,private queueDrain?:(epoch:number)=>void) {
    if(epochSerial===Number.MAX_SAFE_INTEGER)throw new RangeError("owned renderer epoch exhausted");
    this.epoch=++epochSerial;
    this.limits=Object.freeze({maxOwners:limits.maxOwners,maxRequests:limits.maxRequests,maxRetainedBytes:limits.maxRetainedBytes});
    this.adapter=new GlNativeQueryAdapter(registry,bos,muxers,limits,(p,s,registration,token)=>{
      const owner=this.owners.get(s);
      if(owner && p===pid && owner.owner.registration===registration)
        this.send({...owner.grant,type:"gl_owned_notify",token});
    });
    this.onMessage=event=>this.receive(event.data);
    if(!retirements.retain(this))throw new RangeError("owned renderer retirement budget exhausted");
    try {endpoint.addEventListener("message",this.onMessage);} catch(error) {
      this.detached=true;retirements.release(this);throw error;
    }
  }
  private send(message:unknown):void {try {this.endpoint.postMessage(message);} catch {/* Lost ACK never drops native authority. */}}
  private receive(data:unknown):void {
    if(!data || typeof data!=="object")return;
    const message=data as Wire;
    if(!routeValid(message,this.pid))return;
    let owner=this.owners.get(message.sessionId);
    if(message.type==="gl_owned_open") {
      if(!owner) {
        if(this.closing || message.clientRegistration<=this.retiredRegistrationFloor
          || this.owners.size>=this.limits.maxOwners) {this.rejectOpen(message);return;}
        const native=this.adapter.register(this.pid,message.sessionId);if(!native)return;
        owner={owner:native,closed:false,forgotten:false,floor:0n,receipts:new Map(),grant:{pid:this.pid,sessionId:message.sessionId,
          clientRegistration:message.clientRegistration,epoch:this.epoch,registration:native.registration}};
        this.owners.set(message.sessionId,owner);
      }
      // A lost Open ACK must remain recoverable after admission closes. This
      // returns only the original grant; it never reopens native admission.
      if(owner.grant.clientRegistration===message.clientRegistration)
        this.send({...owner.grant,type:"gl_owned_opened"});
      else this.rejectOpen(message);
      return;
    }
    // Later controls never create or replace an owner, including Cancel.
    if(!owner || message.clientRegistration!==owner.grant.clientRegistration || message.epoch!==this.epoch
      || message.registration!==owner.grant.registration)return;
    if(message.type==="gl_owned_release_owner" && owner.forgotten) {
      this.retiredRegistrationFloor=Math.max(this.retiredRegistrationFloor,owner.grant.clientRegistration);
      this.owners.delete(message.sessionId);this.maybeRelease();return;
    }
    if(message.type==="gl_owned_forget_owner") {
      if(owner.forgotten) {this.send({...owner.grant,type:"gl_owned_owner_forgotten"});return;}
      if(!owner.closed) {owner.closed=true;this.adapter.retireOwner(owner.owner);}
      // Only clean scalar metadata can disappear. The authenticated client
      // requests this after observing every individual retirement ACK.
      for(const receipt of owner.receipts.values())if(receipt.terminal?.phase!=="retired")return;
      if(!this.adapter.forgetOwner(owner.owner))return;
      this.records-=owner.receipts.size;owner.receipts.clear();owner.forgotten=true;
      this.send({...owner.grant,type:"gl_owned_owner_forgotten"});this.maybeRelease();return;
    }
    if(owner.forgotten)return;
    if(message.type!=="gl_owned_control")return;
    const bytes=independentBytes(message.bytes,48+CAP);if(!bytes)return;
    let request;
    try {request=decodeQueryRequest(bytes);} catch {return;}
    // This scalar hook must enqueue a later renderer turn, never synchronously
    // drain from inside message admission. It is also retried for lost ACKs.
    try {this.queueDrain?.(this.epoch);} catch {/* Explicit bounded drain remains available. */}
    let receipt=owner.receipts.get(request.token);
    if(!receipt) {
      if(request.token<=owner.floor || this.records>=this.limits.maxRequests)return;
      if(request.control!=="begin" && request.control!=="cancel")return;
      if(request.control==="begin" && (this.closing || owner.closed))return;
      // Reserve metadata before invoking any native capture. After entered is
      // set, Unknown cannot prove that capture/admission never happened.
      receipt={capacity:request.begin?.capacity??0,entered:false,ready:false,rejected:null,mode:null,terminal:null};
      owner.receipts.set(request.token,receipt);owner.floor=request.token;this.records++;
      if(request.control==="cancel") {
        // This authenticated generation has never entered native Begin for
        // this token. The replay floor irrevocably refuses a late Begin.
        receipt.mode="cancel";receipt.terminal={phase:"retired",mode:"cancel",accepted:true};
      }
    }
    if(request.control==="begin" && receipt.terminal?.phase==="retired") {
      this.reply(owner,request.control,request.token,receipt,{phase:"retiring",mode:receipt.terminal.mode});return;
    }
    if(receipt.terminal?.phase==="retired") {
      if(request.control==="poll" && receipt.mode==="cancel") {
        // The preceding notice may have been lost. An unrequested-mode Poll
        // cannot authenticate a terminal ACK until the client enters Cancel.
        this.reply(owner,"poll",request.token,receipt,{phase:"retiring",mode:"cancel"});return;
      }
      if(request.control==="begin" || (request.control==="commit" && receipt.mode!=="commit")
        || (request.control==="cancel" && receipt.mode!=="cancel"))return;
      if(request.control==="forget" && receipt.entered && receipt.rejected===null) {
        const result=this.adapter.control(owner.owner,bytes);
        if("error" in result)return;
        try {decodeQueryReply(result.bytes,expected("forget",request.token,receipt.capacity,receipt.mode));}catch{return;}
      }
      this.reply(owner,request.control,request.token,receipt,receipt.terminal);
      if(request.control==="forget") {owner.receipts.delete(request.token);this.records--;}
      return;
    }
    if(request.control==="begin" && request.begin!.capacity!==receipt.capacity)return;
    if(receipt.rejected!==null) {
      if(request.control==="begin")this.reply(owner,"begin",request.token,receipt,{phase:"rejected",error:receipt.rejected});
      else if(request.control==="cancel") {
        receipt.mode="cancel";receipt.terminal={phase:"retired",mode:"cancel",accepted:true};
        this.reply(owner,"cancel",request.token,receipt,receipt.terminal);
      }
      return;
    }
    if(owner.closed && receipt.entered && !receipt.mode)receipt.mode="cancel";
    if(request.control==="begin" && receipt.mode==="cancel") {
      this.reply(owner,"begin",request.token,receipt,{phase:"retiring",mode:"cancel"});return;
    }
    if(request.control==="begin")receipt.entered=true;
    else if(!receipt.entered)return;
    if(request.control==="commit" || request.control==="cancel") {
      if(receipt.mode && receipt.mode!==request.control)return;
      // Commit can have effects, so reject a control with no proven successful
      // Ready before entering native code or committing to a retirement mode.
      if(request.control==="commit" && !receipt.ready && !receipt.mode)return;
      receipt.mode??=request.control;
    }
    const result=this.adapter.control(owner.owner,bytes);
    if("error" in result)return; // Uncertain capture/cleanup remains owned.
    let response:QueryReceiptReply;
    try {response=decodeQueryReply(result.bytes,expected(request.control,request.token,receipt.capacity,receipt.mode));}
    catch {return;}
    if(response.phase==="rejected")receipt.rejected=response.error;
    if(response.phase==="ready")receipt.ready=response.result>=0;
    if(response.phase==="retiring")receipt.mode??=response.mode;
    if(response.phase==="retired") {receipt.mode=response.mode;receipt.terminal=response;}
    if(response.phase==="retired" && request.control==="poll" && receipt.mode==="cancel") {
      // A client which has not yet learned owner retirement cannot decode a
      // terminal cancellation ACK as an unrequested-mode Poll. First tell it
      // to enter Cancel, then acknowledge that exact mode on its next control.
      this.reply(owner,"poll",request.token,receipt,{phase:"retiring",mode:"cancel"});
    } else this.send({...owner.grant,type:"gl_owned_reply",control:request.control,bytes:buffer(result.bytes)});
    if(request.control==="forget" && response.phase==="retired") {owner.receipts.delete(request.token);this.records--;}
  }
  private rejectOpen(message:Wire):void {
    this.send({type:"gl_owned_open_rejected",pid:this.pid,sessionId:message.sessionId,
      clientRegistration:message.clientRegistration,epoch:this.epoch,error:13});
  }
  private reply(owner:ServerOwner,control:QueryControl,token:bigint,receipt:ServerReceipt,response:QueryReceiptReply):void {
    try {this.send({...owner.grant,type:"gl_owned_reply",control,
      bytes:buffer(encodeQueryReply(response,expected(control,token,receipt.capacity,receipt.mode)))});} catch {/* No invented ACK for an incompatible mode. */}
  }
  /** A bounded round visits native records twice and dispatches at most N real
   * frames between them, so an accepted prefix can unblock its query in this
   * turn. Remaining native receipts are not evidence of runnable work: retry
   * on real controls/wakeups or explicit retirement attempts, never a timer. */
  drain(maxVisits:number):{nativeVisits:number;commandResult:number;commands:ReturnType<typeof glSubmitQueueDisposition>} {
    if(!Number.isSafeInteger(maxVisits)||maxVisits<0)return {nativeVisits:0,commandResult:-22,commands:"blocked"};
    let selected:GlBinding|null=null;
    const muxerFor=(binding:GlBinding)=>{selected=binding;return binding.gl ? this.muxers.get(binding.gl)??null : null;};
    let nativeVisits=this.adapter.drain(maxVisits);
    const commandResult=drainSubmitQueue(this.submits,muxerFor,(binding,offset,length)=>decodeAndDispatch(binding,offset,length),maxVisits);
    if(commandResult<0 && selected)recordGlError(selected,0x502);
    nativeVisits+=this.adapter.drain(maxVisits);
    return {nativeVisits,commandResult,commands:glSubmitQueueDisposition(this.submits,muxerFor)};
  }
  /** Session unbind closes admission but leaves exact retirement controls live. */
  retireSession(session:number):void {
    const owner=this.owners.get(session);if(!owner)return;
    owner.closed=true;this.adapter.retireOwner(owner.owner);
  }
  close():void {
    this.closing=true;for(const session of this.owners.keys())this.retireSession(session);this.maybeRelease();
  }
  private maybeRelease():void {
    if(!this.closing || this.owners.size || this.detached)return;
    this.endpoint.removeEventListener("message",this.onMessage);this.detached=true;this.retirements.release(this);
  }
  get released():boolean {return this.detached;}
  get retainedBytes():number {return this.adapter.retainedBytes;}
  get pendingRequests():number {return this.records;}
}

type ClientReceipt={token:bigint;begin:Omit<QueryBegin,"input">;custody:GlRemoteResultCustody;
  execution:GlResultExecution|null;admission:"unsent"|"awaiting-native-admission"|"native-admitted";
  mode:GlResultMode|null;rejected:boolean};
type ClientOwner={owner:GlResultOwner;clientRegistration:number;grant:Grant|null;openRejected:boolean;closed:boolean;forgetting:boolean;receipts:Map<bigint,ClientReceipt>};
/** Kernel-side paired endpoint. Until the actual renderer Begin ACK this owns
 * copied ordered intent and endpoint cleanup responsibility, not native storage.
 * No timeout, timer, Atomics.wait, guest view or native cleanup closure exists.
 * queueWakeup must schedule a later worker turn rather than reentering Rust. */
export class GlOwnedForwardClient {
  private store:GlOwnedResultStore;
  private peer=new GlResultPeer(1);
  private owners=new Map<GlResultOwner,ClientOwner>();
  private onMessage:(event:MessageEvent)=>void;
  private cursor=0;
  constructor(private endpoint:GlOwnedForwardEndpoint,private pid:number,limits:GlResultLimits,
    private queueWakeup:(pid:number,session:number,registration:number,token:bigint)=>void) {
    this.store=new GlOwnedResultStore(limits);
    this.onMessage=event=>this.receive(event.data);endpoint.addEventListener("message",this.onMessage);
  }
  register(session:number,operations:GlOperationStream):GlResultOwner|null {
    if(clientRegistrationSerial===Number.MAX_SAFE_INTEGER)return null;
    const owner=this.store.openOwner(this.pid,session,operations);if(!owner)return null;
    if(!this.owners.has(owner))this.owners.set(owner,{owner,clientRegistration:++clientRegistrationSerial,
      grant:null,openRejected:false,closed:false,forgetting:false,receipts:new Map()});
    this.open(this.owners.get(owner)!);return owner;
  }
  private route(owner:GlResultOwner):Route {
    return {pid:this.pid,sessionId:owner.sessionId,clientRegistration:this.owners.get(owner)!.clientRegistration};
  }
  private post(message:unknown):void {try {this.endpoint.postMessage(message);} catch {/* Any attempted post can have been enqueued. */}}
  private open(owner:ClientOwner):void {if(!owner.grant)this.post({...this.route(owner.owner),type:"gl_owned_open"});}
  begin(owner:GlResultOwner,token:bigint,begin:QueryBegin):boolean {
    const entry=this.owners.get(owner);if(!entry || entry.closed)return false;
    const existing=entry.receipts.get(token);
    if(existing)return existing.begin.op===begin.op && existing.begin.capacity===begin.capacity
      && existing.begin.hasCurrent===begin.hasCurrent && existing.begin.context===begin.context
      && existing.begin.draw===begin.draw && existing.begin.read===begin.read;
    // Validate before reserving/copying. The store owns the frozen first input;
    // retries cannot replace it even if their caller buffer changes.
    try {encodeQueryRequest({control:"begin",token,begin});} catch {return false;}
    const custody=GlRemoteResultCustody.unposted(this.peer,owner,token);
    const metadata:ClientReceipt={token,begin:{op:begin.op,capacity:begin.capacity,hasCurrent:begin.hasCurrent,
      context:begin.context,draw:begin.draw,read:begin.read},custody,execution:null,admission:"unsent",mode:null,rejected:false};
    entry.receipts.set(token,metadata);
    if(this.store.begin(owner,token,begin.op,begin.input,begin.capacity,custody)!=="admitted") {entry.receipts.delete(token);return false;}
    return true;
  }
  control(owner:GlResultOwner,token:bigint,mode:GlResultMode):boolean {
    const receipt=this.owners.get(owner)?.receipts.get(token);if(!receipt || !this.store[mode](owner,token))return false;
    receipt.mode??=mode;return true;
  }
  poll(owner:GlResultOwner,token:bigint):GlResultPoll {return this.store.poll(owner,token);}
  admission(owner:GlResultOwner,token:bigint):ClientReceipt["admission"]|null {return this.owners.get(owner)?.receipts.get(token)?.admission??null;}
  private receive(data:unknown):void {
    if(!data || typeof data!=="object")return;
    const message=data as Wire;if(!routeValid(message,this.pid))return;
    let entry:ClientOwner|undefined;
    for(const candidate of this.owners.values())if(candidate.owner.sessionId===message.sessionId
      && candidate.clientRegistration===message.clientRegistration) {entry=candidate;break;}
    if(!entry)return;
    if(message.type==="gl_owned_open_rejected") {
      // Without a grant this client could never send a native query. This
      // exact endpoint may refuse old/unregistered intent without pretending
      // that an attempted native request has retired.
      if(entry.grant || !positive(message.epoch) || message.error!==13)return;
      entry.openRejected=true;entry.closed=true;this.store.retireOwner(entry.owner);
      for(const receipt of entry.receipts.values()) {
        receipt.mode??="cancel";this.wake(entry.owner,receipt.token);
      }
      return;
    }
    if(message.type==="gl_owned_opened") {
      if(entry.openRejected)return;
      if(!positive(message.epoch) || !positive(message.registration))return;
      if(entry.grant && (entry.grant.epoch!==message.epoch || entry.grant.registration!==message.registration))return;
      entry.grant={...this.route(entry.owner),epoch:message.epoch,registration:message.registration};return;
    }
    if(!entry.grant || message.epoch!==entry.grant.epoch || message.registration!==entry.grant.registration)return;
    if(message.type==="gl_owned_owner_forgotten") {
      if(!entry.forgetting || !entry.closed)return;
      // The server may retain only clean scalar owner metadata if this final
      // release is lost. It never loses unresolved native cleanup authority.
      if(!entry.receipts.size || this.store.forgetOwner(entry.owner)) {
        this.post({...entry.grant,type:"gl_owned_release_owner"});this.owners.delete(entry.owner);
      }
      return;
    }
    if(message.type==="gl_owned_notify") {
      if(typeof message.token==="bigint" && entry.receipts.has(message.token))
        this.wake(entry.owner,message.token);
      return;
    }
    if(message.type!=="gl_owned_reply" || !["begin","poll","commit","cancel","forget"].includes(message.control??""))return;
    const bytes=independentBytes(message.bytes,32+CAP);if(!bytes || bytes.byteLength<16)return;
    const view=new DataView(bytes.buffer),token=BigInt(view.getUint32(8,true))|(BigInt(view.getUint32(12,true))<<32n);
    const receipt=entry.receipts.get(token);if(!receipt || receipt.admission==="unsent")return;
    const control=message.control!;
    let reply:QueryReceiptReply;
    try {reply=decodeQueryReply(bytes,expected(control,token,receipt.begin.capacity,receipt.mode));} catch {return;}
    if(reply.phase==="ready") {
      receipt.admission="native-admitted";
      this.store.completeRemote(this.peer,entry.owner,token,reply.result,reply.bytes);
    } else if(reply.phase==="pending")receipt.admission="native-admitted";
    else if(reply.phase==="rejected") {
      // This real Begin rejection proves zero native work, but it is kept as a
      // server replay tombstone until authenticated cancellation/Forget.
      receipt.rejected=true;this.store.completeRemote(this.peer,entry.owner,token,-reply.error,new Uint8Array());
    } else if(reply.phase==="retiring") {
      receipt.admission="native-admitted";
      if(!receipt.mode && reply.mode==="cancel") {this.store.cancel(entry.owner,token);receipt.mode="cancel";}
    } else if(reply.phase==="retired" && receipt.mode===reply.mode) {
      // Even cancellation of a running remote operation needs quiescence.
      receipt.execution?.complete(-5);
      if(receipt.custody.acknowledge(this.peer,entry.owner,token,reply.mode,reply.accepted))
        this.store.acknowledgeRetired(entry.owner,token);
    }
    this.wake(entry.owner,token);
  }
  private wake(owner:GlResultOwner,token:bigint):void {
    try {this.queueWakeup(this.pid,owner.sessionId,owner.registration,token);} catch {/* Durable phase can be polled later. */}
  }
  drain(maxVisits:number):number {
    if(!Number.isSafeInteger(maxVisits)||maxVisits<0)return 0;
    const records:Array<[ClientOwner,ClientReceipt]>=[];
    for(const entry of this.owners.values())for(const receipt of entry.receipts.values())records.push([entry,receipt]);
    const visits=Math.min(maxVisits,records.length);
    for(let i=0;i<visits;i++) {
      this.cursor%=records.length;
      const [entry,receipt]=records[this.cursor];this.cursor=(this.cursor+1)%records.length;
      if(this.store.poll(entry.owner,receipt.token).state==="retired")continue;
      if(receipt.mode && receipt.admission==="unsent") {
        // A failed encoding/allocation can leave a started local ticket which
        // provably never attempted a post. Report that synchronous quiescence.
        receipt.execution?.complete(-5);
        this.store.acknowledgeRetired(entry.owner,receipt.token);continue;
      }
      if(!entry.grant) {this.open(entry);continue;}
      if(!receipt.execution) {
        receipt.execution=this.store.take(entry.owner,receipt.token);if(!receipt.execution)continue;
      }
      let request;
      if(receipt.mode)request={control:receipt.mode,token:receipt.token};
      else if(receipt.admission!=="native-admitted" && !receipt.rejected) {
        request={control:"begin" as const,token:receipt.token,begin:{...receipt.begin,input:receipt.execution.input}};
      } else request={control:"poll" as const,token:receipt.token};
      let bytes:Uint8Array;
      try {bytes=encodeQueryRequest(request);} catch {continue;}
      if(receipt.admission==="unsent") {
        if(!receipt.custody.markSendAttempt(this.peer,entry.owner,receipt.token))continue;
        receipt.admission="awaiting-native-admission";
      }
      this.post({...entry.grant,type:"gl_owned_control",bytes:buffer(bytes)});
    }
    return visits;
  }
  forget(owner:GlResultOwner,token:bigint):boolean {
    const entry=this.owners.get(owner),receipt=entry?.receipts.get(token);
    if(!entry || !receipt || this.store.poll(owner,token).state!=="retired")return false;
    if(receipt.admission!=="unsent" && entry.grant)this.post({...entry.grant,type:"gl_owned_control",bytes:buffer(encodeQueryRequest({control:"forget",token}))});
    if(!this.store.forget(owner,token))return false;entry.receipts.delete(token);return true;
  }
  retireOwner(owner:GlResultOwner):boolean {
    const entry=this.owners.get(owner);if(!entry || !this.store.retireOwner(owner))return false;
    entry.closed=true;for(const receipt of entry.receipts.values())receipt.mode??="cancel";return true;
  }
  forgetOwner(owner:GlResultOwner):boolean {
    const entry=this.owners.get(owner);if(!entry?.closed)return false;
    for(const receipt of entry.receipts.values())if(this.store.poll(owner,receipt.token).state!=="retired")return false;
    if(!entry.grant) {
      if(entry.openRejected) {
        if(entry.receipts.size && !this.store.forgetOwner(owner))return false;
        this.owners.delete(owner);return true;
      }
      // Open itself may have been delivered despite a lost response. Recover
      // its exact generation and retire the real server registration too.
      this.open(entry);if(!entry.grant)return false;
    }
    entry.forgetting=true;this.post({...entry.grant,type:"gl_owned_forget_owner"});return true;
  }
  /** Refuse listener removal while it still owns uncertain/native cleanup. */
  dispose():boolean {
    if(this.owners.size)return false;this.endpoint.removeEventListener("message",this.onMessage);return true;
  }
  get retainedBytes():number {return this.store.retainedBytes;}
  get pendingRequests():number {return this.store.pendingRequests;}
}
