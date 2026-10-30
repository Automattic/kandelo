/** Optional owned query transport. This composes the real renderer adapter;
 * it does not enable public pending syscalls or infer completion from timeouts. */
import { GlFinalRenderNodeReceiver, type GlFinalRenderNodeState } from "./final-render-node.js";
import { isKernelExportFailure } from "../kernel-entry-gate.js";
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
import { GlForwardNativeRetirement,type GlForwardRetirementKind } from "./forward-retirement.js";

export interface GlOwnedForwardEndpoint {
  postMessage(message: unknown): void;
  addEventListener(type:"message", listener:(event:MessageEvent)=>void):void;
  removeEventListener(type:"message", listener:(event:MessageEvent)=>void):void;
}
type Route = {pid:number;sessionId:number;clientRegistration:number};
type Grant = Route & {epoch:number;registration:number};
type Wire = Route & {type:string;epoch?:number;registration?:number;bytes?:ArrayBuffer;control?:QueryControl;token?:bigint;error?:number;
  retirement?:GlForwardRetirementKind;sequence?:number;source?:number;complete?:boolean;endpointRegistration?:number;tokenLow?:number;tokenHigh?:number;finalState?:GlFinalRenderNodeState|"rejected"};
const CAP = 65536;
function finalToken(message:Wire):bigint|null {
  const lo=message.tokenLow,hi=message.tokenHigh;
  if(!Number.isInteger(lo)||!Number.isInteger(hi)||lo!<0||lo!>0xffff_ffff||hi!<0||hi!>0x7fff_ffff)return null;
  const token=(BigInt(hi!)<<32n)|BigInt(lo!);return token>0n?token:null;
}
function finalWords(token:bigint):{tokenLow:number;tokenHigh:number} {return {tokenLow:Number(token&0xffff_ffffn),tokenHigh:Number(token>>32n)};}

const apply=Reflect.apply;
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
  private requested=new Set<GlOwnedMainForwardController>();
  private task:ReturnType<typeof setTimeout>|null=null;
  private running=false;
  private readonly scheduler=globalThis;
  private readonly schedule=setTimeout;
  private readonly cancel=clearTimeout;
  constructor(private maximum:number) {if(!Number.isSafeInteger(maximum)||maximum<0)throw new RangeError("invalid owned renderer budget");}
  retain(controller:GlOwnedMainForwardController):boolean {
    if(this.controllers.has(controller))return true;
    if(this.controllers.size>=this.maximum)return false;
    this.controllers.add(controller);return true;
  }
  release(controller:GlOwnedMainForwardController):void {
    if(!controller.released)return;
    this.controllers.delete(controller);this.requested.delete(controller);
    if(!this.requested.size && this.task!==null) {
      apply(this.cancel,this.scheduler,[this.task]);this.task=null;
    }
  }
  /** Exact issued epoch selects an already retained actual receiver. A task is
   * only a later-turn work hint; neither its firing nor cancellation is ACK. */
  requestDrain(epoch:number):boolean {
    for(const controller of this.controllers)if(controller.matchesDrainEpoch(epoch)) {
      this.requested.add(controller);this.scheduleTurn();return true;
    }
    return false;
  }
  private scheduleTurn():void {
    if(this.task!==null || this.running || !this.requested.size)return;
    // Capture both timer intrinsics at holder construction. This one-shot
    // macrotask is shared Node/browser policy, never a cleanup polling timer.
    this.task=apply(this.schedule,this.scheduler,[()=>this.runTurn(),0]);
  }
  private runTurn():void {
    this.task=null;this.running=true;
    let completed=false;
    try {
      // A bounded FIFO of actual controllers gives newly requested peers a
      // turn before a quota-runnable controller goes around again.
      const ready=[...this.requested].slice(0,32);
      for(const controller of ready) {
        this.requested.delete(controller);
        if(!this.controllers.has(controller) || controller.released)continue;
        const result=controller.drain(1);
        if(!controller.released && (result.nativeRunnable || result.commands==="runnable"))this.requested.add(controller);
      }
      completed=true;
    } finally {
      this.running=false;
      // Unexpected allocation/driver failure remains visible and retains real
      // receiver custody, but must not manufacture an automatic retry loop.
      if(completed)this.scheduleTurn();
    }
  }
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
  bos:GbmBoRegistry;/** Explicit external scheduler override; throws remain visible. */queueDrain?:(epoch:number)=>void};
type ServerReceipt = {capacity:number;entered:boolean;ready:boolean;rejected:number|null;mode:GlResultMode|null;terminal:QueryReceiptReply|null};
type ServerRetirement={sequence:number;source:number;receiver:GlForwardNativeRetirement|null};
type RetirementSlots<T>={context:T;surface:T;session:T};
const retirementKind=(kind:unknown):kind is GlForwardRetirementKind=>kind==="context"||kind==="surface"||kind==="session";
type ServerOwner = {grant:Grant;owner:GlResultOwner;closed:boolean;forgotten:boolean;floor:bigint;receipts:Map<bigint,ServerReceipt>;
  retirements:RetirementSlots<ServerRetirement>};

/** Lives on the SAME endpoint as legacy forwarding, so an earlier submit is
 * admitted before Begin. Numeric message fields select existing authority;
 * only explicit Open against a known live binding grants a generation. */
export class GlOwnedMainForwardController {
  private adapter:GlNativeQueryAdapter;
  private finals:GlFinalRenderNodeReceiver;
  private epoch:number;
  private owners=new Map<number,ServerOwner>();
  private records=0;
  private retiredRegistrationFloor=0;
  private closing=false;
  private endpointRegistration=0;
  private closingAcknowledged=false;
  private endpointFloor=0;
  private endpointRelease=0;
  private endpointReleased=0;
  private endpointReleaseAcknowledged=true;
  private scalarCursor=0;
  private legacyCursor=0;
  private legacy=new Map<number,{operations:GlOperationStream;receiver:GlForwardNativeRetirement;retiring:boolean}>();
  private detached=false;
  private onMessage:(event:MessageEvent)=>void;
  private requesting=0;
  private draining=false;
  constructor(private endpoint:GlOwnedForwardEndpoint,private pid:number,private registry:GlContextRegistry,
    bos:GbmBoRegistry,private muxers:WeakMap<WebGL2RenderingContext,GlMuxer>,private limits:GlResultLimits,
    private retirements:GlOwnedForwardRetirements,private submits:SubmitQueue,private queueDrain?:(epoch:number)=>void) {
    if(epochSerial===Number.MAX_SAFE_INTEGER)throw new RangeError("owned renderer epoch exhausted");
    this.epoch=++epochSerial;
    this.limits=Object.freeze({maxOwners:limits.maxOwners,maxRequests:limits.maxRequests,maxRetainedBytes:limits.maxRetainedBytes});
    this.finals=new GlFinalRenderNodeReceiver(registry,bos,muxers,limits.maxRequests,limits.maxRetainedBytes,limits.maxRequests*32);
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
  matchesDrainEpoch(epoch:number):boolean {return !this.detached && this.epoch===epoch;}
  private requestWork():void {
    this.requesting++;
    try {this.queueDrain?.(this.epoch);}
    finally {this.requesting--;}
  }
  private send(message:unknown):void {try {this.endpoint.postMessage(message);} catch {/* Lost ACK never drops native authority. */}}
  private rejectFinal(owner:ServerOwner,token:bigint):void {
    // Record the exact owner's admission floor BEFORE a fallible terminal ACK.
    // Capacity/validation refusal cannot leave the same token free to execute.
    if(this.finals.rejectUnaccepted(owner.owner,token))
      this.send({...owner.grant,...finalWords(token),type:"gl_owned_final_reply",finalState:"rejected"});
  }
  private receive(data:unknown):void {
    if(!data || typeof data!=="object")return;
    const message=data as Wire;
    // Endpoint admission has its own scalar generation. It grants no native
    // owner/source authority; it keeps the actual legacy receiver alive until
    // this client has closed admission on the same ordered endpoint.
    if(message.pid===this.pid && positive(message.endpointRegistration)) {
      if(message.type==="gl_owned_endpoint_open") {
        if(!this.endpointRegistration && !this.closing && message.endpointRegistration>this.endpointFloor)this.endpointRegistration=message.endpointRegistration;
        else if(message.endpointRegistration>this.endpointRegistration && !this.closing && !this.owners.size)
          this.endpointRegistration=message.endpointRegistration;
        if(message.endpointRegistration===this.endpointRegistration) {
          this.send({type:"gl_owned_endpoint_opened",pid:this.pid,epoch:this.epoch,endpointRegistration:this.endpointRegistration});
          if(this.closing)this.noticeClosing();
        }
        return;
      }
      if(message.type==="gl_owned_endpoint_release_received" && message.epoch===this.epoch
        && message.endpointRegistration===this.endpointReleased) {
        this.endpointReleaseAcknowledged=true;this.maybeRelease();return;
      }
      if(message.type==="gl_owned_endpoint_release" && message.epoch===this.epoch) {
        if(message.endpointRegistration===this.endpointReleased) {
          this.send({type:"gl_owned_endpoint_released",pid:this.pid,epoch:this.epoch,endpointRegistration:this.endpointReleased});return;
        }
        if(message.endpointRegistration!==this.endpointRegistration || this.owners.size)return;
        this.endpointRelease=message.endpointRegistration;
        for(const session of this.legacy.keys())this.retireLegacy(session);
        this.finishEndpointRelease();this.requestWork();return;
      }
      if(message.type==="gl_owned_endpoint_closed" && this.closing && message.epoch===this.epoch
        && message.endpointRegistration===this.endpointRegistration) {
        this.finishClosing();this.requestWork();return;
      }
    }
    if(!routeValid(message,this.pid))return;
    let owner=this.owners.get(message.sessionId);
    if(message.type==="gl_owned_open") {
      if(!owner) {
        if(this.closing || message.clientRegistration<=this.retiredRegistrationFloor
          || this.owners.size>=this.limits.maxOwners) {this.rejectOpen(message);return;}
        const native=this.adapter.register(this.pid,message.sessionId);if(!native)return;
        owner={owner:native,closed:false,forgotten:false,floor:0n,receipts:new Map(),
          retirements:{context:{sequence:0,source:0,receiver:null},surface:{sequence:0,source:0,receiver:null},session:{sequence:0,source:0,receiver:null}},
          grant:{pid:this.pid,sessionId:message.sessionId,
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
    if(message.type.startsWith("gl_owned_final_")) {
      const token=finalToken(message);if(token===null||owner.forgotten)return;
      if(message.type==="gl_owned_final_begin") {
        const old=this.finals.poll(owner.owner,token);
        if(old===null && this.finals.admissionRevoked(owner.owner,token)){this.rejectFinal(owner,token);return;}
        const bytes=independentBytes(message.bytes,CAP);if(!bytes)return;
        if(old===null) {
          if(owner.closed || this.records+this.finals.pending>=this.limits.maxRequests
            ||bytes.length>this.limits.maxRetainedBytes-this.adapter.retainedBytes-this.finals.retainedBytes
            ||[...owner.receipts.values()].some(receipt=>receipt.terminal?.phase!=="retired")) {
            this.rejectFinal(owner,token);return;
          }
        }
        if(!this.finals.begin(owner.owner,token,bytes)) {
          if(old===null)this.rejectFinal(owner,token);return;
        }
        const sessionReceiver=this.finals.sessionReceiver(owner.owner);
        if(sessionReceiver) {
          owner.closed=true;this.adapter.retireOwner(owner.owner);
          const legacy=this.legacy.get(owner.owner.sessionId);
          if(legacy)legacy.receiver=sessionReceiver;
          owner.retirements.session.receiver=sessionReceiver;
        }
        if(old===null) {
          const weak=new WeakRef(this),grant=Object.freeze({...owner.grant});
          this.finals.watch(owner.owner,token,()=>{
            const controller=weak.deref();if(!controller)return;
            controller.send({...grant,...finalWords(token),type:"gl_owned_final_notify"});controller.requestWork();
          });
        }
      } else if(message.type==="gl_owned_final_poll") {
        if(!this.finals.retry(owner.owner,token)){if(this.finals.admissionRevoked(owner.owner,token))this.rejectFinal(owner,token);return;}
      } else if(message.type==="gl_owned_final_forget") {
        if(!this.finals.forget(owner.owner,token)&&!this.finals.admissionRevoked(owner.owner,token))return;this.maybeRelease();return;
      } else return;
      const state=this.finals.poll(owner.owner,token);
      if(state)this.send({...owner.grant,...finalWords(token),type:"gl_owned_final_reply",finalState:state});
      this.requestWork();return;
    }
    if(message.type==="gl_owned_release_owner" && owner.forgotten) {
      this.retiredRegistrationFloor=Math.max(this.retiredRegistrationFloor,owner.grant.clientRegistration);
      this.owners.delete(message.sessionId);this.maybeRelease();return;
    }
    if(message.type==="gl_owned_forget_owner") {
      let failure:unknown;
      try {
      if(owner.forgotten) {this.send({...owner.grant,type:"gl_owned_owner_forgotten"});return;}
      if(!owner.closed) {owner.closed=true;this.adapter.retireOwner(owner.owner);}
      // Only clean scalar metadata can disappear. The authenticated client
      // requests this after observing every individual retirement ACK.
      for(const receipt of owner.receipts.values())if(receipt.terminal?.phase!=="retired")return;
      if(!this.finals.retirementComplete(owner.owner))return;
      for(const retirement of Object.values(owner.retirements))if(retirement.receiver && !retirement.receiver.complete
        && !(retirement.receiver.revoke(this.registry,this.muxers) && retirement.receiver.retry(this.muxers)))return;
      if(!this.finals.forgetOwner(owner.owner)||!this.adapter.forgetOwner(owner.owner))return;
      this.records-=owner.receipts.size;owner.receipts.clear();owner.forgotten=true;
      this.send({...owner.grant,type:"gl_owned_owner_forgotten"});this.maybeRelease();return;
      } catch(error) {failure=error;throw error;}
      finally {if(!isKernelExportFailure(failure))this.requestWork();}
    }
    if(owner.forgotten)return;
    if(message.type==="gl_owned_retire") {
      if(!retirementKind(message.retirement) || !positive(message.sequence) || !Number.isInteger(message.source)
        || message.source!<0 || message.source!>0xffff_ffff || (message.retirement==="session" ? message.source!==0 : message.source===0))return;
      const slot=owner.retirements[message.retirement];
      if(message.sequence<slot.sequence || (message.sequence===slot.sequence && message.source!==slot.source))return;
      if(message.sequence>slot.sequence) {
        if(slot.receiver && !slot.receiver.complete && !(owner.closed && slot.sequence===0
          && slot.receiver.covers(message.retirement,message.source!)))return;
        // The real receiver is reserved before the first native reference.
        const shutdown=owner.retirements.session.receiver;
        const covered=owner.closed && shutdown?.covers(message.retirement,message.source!);
        const binding=this.registry.get(this.pid,owner.owner.sessionId);
        // Refuse a foreign/stale source BEFORE it can occupy the one reserved
        // kind slot. An actual capture failure keeps its already-owned receiver.
        if(!covered && (!binding || binding.operations!==owner.owner.operations
          || (message.retirement==="context" && binding.contextId!==message.source)
          || (message.retirement==="surface" && binding.surfaceId!==message.source)))return;
        const legacy=message.retirement==="session" ? this.legacy.get(owner.owner.sessionId) : undefined;
        if(legacy)legacy.retiring=true;
        slot.receiver=covered ? shutdown! : legacy?.receiver
          ??new GlForwardNativeRetirement(message.retirement,message.source!,this.pid,owner.owner.sessionId,owner.owner.operations);
        slot.source=message.source!;slot.sequence=message.sequence;
      }
      this.retireScalar(owner,message.retirement,slot);this.requestWork();return;
    }
    if(message.type!=="gl_owned_control")return;
    const bytes=independentBytes(message.bytes,48+CAP);if(!bytes)return;
    let request;
    try {request=decodeQueryRequest(bytes);} catch {return;}
    let failure:unknown;
    try {
    let receipt=owner.receipts.get(request.token);
    if(!receipt) {
      if(request.token<=owner.floor || this.records+this.finals.pending>=this.limits.maxRequests)return;
      if(request.control!=="begin" && request.control!=="cancel")return;
      // Reserve metadata before invoking any native capture. After entered is
      // set, Unknown cannot prove that capture/admission never happened.
      receipt={capacity:request.begin?.capacity??0,entered:false,ready:false,rejected:null,mode:null,terminal:null};
      owner.receipts.set(request.token,receipt);owner.floor=request.token;this.records++;
      if(request.control==="begin" && (this.closing || owner.closed))receipt.rejected=13;
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
    } catch(error) {failure=error;throw error;}
    finally {
      // An uncertain native response still owns admitted custody. Schedule only
      // after admission, never drain reentrantly; override failures propagate.
      // A branded fatal must remain fatal and must not restart the renderer.
      if(!isKernelExportFailure(failure))this.requestWork();
    }
  }
  private rejectOpen(message:Wire):void {
    this.send({type:"gl_owned_open_rejected",pid:this.pid,sessionId:message.sessionId,
      clientRegistration:message.clientRegistration,epoch:this.epoch,error:13});
  }
  private retireScalar(owner:ServerOwner,kind:GlForwardRetirementKind,slot:ServerRetirement):void {
    const receiver=slot.receiver;if(!receiver||!this.finals.retirementComplete(owner.owner))return;
    // A scalar request never releases outstanding query custody. Its sender
    // waits for individual query ACKs; verify that proof at this receiver too.
    for(const receipt of owner.receipts.values())if(receipt.terminal?.phase!=="retired")return;
    if(kind==="session") {owner.closed=true;this.adapter.retireOwner(owner.owner);}
    const complete=receiver.revoke(this.registry,this.muxers) && receiver.retry(this.muxers);
    this.send({...owner.grant,type:"gl_owned_retired",retirement:kind,sequence:slot.sequence,source:slot.source,complete});
  }
  private reply(owner:ServerOwner,control:QueryControl,token:bigint,receipt:ServerReceipt,response:QueryReceiptReply):void {
    try {this.send({...owner.grant,type:"gl_owned_reply",control,
      bytes:buffer(encodeQueryReply(response,expected(control,token,receipt.capacity,receipt.mode)))});} catch {/* No invented ACK for an incompatible mode. */}
  }
  /** A bounded round visits native records twice and dispatches at most N real
   * frames between them, so an accepted prefix can unblock its query in this
   * turn. Remaining native receipts are not evidence of runnable work: retry
   * on real controls/wakeups or explicit retirement attempts, never elapsed time. */
  drain(maxVisits:number):{nativeVisits:number;nativeRunnable:boolean;commandResult:number;commands:ReturnType<typeof glSubmitQueueDisposition>} {
    if(!Number.isSafeInteger(maxVisits)||maxVisits<0)return {nativeVisits:0,nativeRunnable:false,commandResult:-22,commands:"blocked"};
    if(this.requesting || this.draining)throw new Error("Owned renderer drain requires a later non-reentrant turn");
    this.draining=true;
    try {
    let selected:GlBinding|null=null;
    const muxerFor=(binding:GlBinding)=>{selected=binding;return binding.gl ? this.muxers.get(binding.gl)??null : null;};
    let nativeVisits=this.adapter.drain(maxVisits);
    const commandResult=drainSubmitQueue(this.submits,muxerFor,(binding,offset,length)=>decodeAndDispatch(binding,offset,length),maxVisits);
    if(commandResult<0 && selected)recordGlError(selected,0x502);
    nativeVisits+=this.adapter.drain(maxVisits);
    nativeVisits+=this.finals.drain(maxVisits);
    const scalars:Array<[ServerOwner,GlForwardRetirementKind,ServerRetirement]>=[];
    for(const owner of this.owners.values())for(const kind of ["context","surface","session"] as const) {
      const slot=owner.retirements[kind];if(slot.receiver && !slot.receiver.complete)scalars.push([owner,kind,slot]);
    }
    for(let i=0;i<Math.min(maxVisits,scalars.length);i++) {
      this.scalarCursor%=scalars.length;
      const [owner,kind,slot]=scalars[this.scalarCursor];this.scalarCursor=(this.scalarCursor+1)%scalars.length;
      this.retireScalar(owner,kind,slot);
    }
    const legacy=[...this.legacy.values()].filter(entry=>entry.retiring && !entry.receiver.complete
      && [...this.owners.values()].every(owner=>owner.owner.operations!==entry.operations||this.finals.retirementComplete(owner.owner)));
    for(let i=0;i<Math.min(maxVisits,legacy.length);i++) {
      this.legacyCursor%=legacy.length;const entry=legacy[this.legacyCursor];this.legacyCursor=(this.legacyCursor+1)%legacy.length;
      entry.receiver.revoke(this.registry,this.muxers) && entry.receiver.retry(this.muxers);
    }
    if(this.closing && !this.closingAcknowledged)this.noticeClosing();
    this.finishEndpointRelease();
    if(this.endpointReleased && !this.endpointReleaseAcknowledged)this.send({type:"gl_owned_endpoint_released",pid:this.pid,
      epoch:this.epoch,endpointRegistration:this.endpointReleased});
    this.maybeRelease();
    return {nativeVisits,nativeRunnable:this.adapter.runnableAfterDrain||this.finals.runnable,commandResult,commands:glSubmitQueueDisposition(this.submits,muxerFor)};
    } finally {this.draining=false;}
  }
  /** Session unbind closes admission but leaves exact retirement controls live. */
  retireSession(session:number,roots=false):void {
    const owner=this.owners.get(session);if(!owner)return;
    let receiver:GlForwardNativeRetirement|null=null;
    if(roots) {
      const slot=owner.retirements.session;
      const legacy=this.legacy.get(session);if(legacy)legacy.retiring=true;
      slot.receiver??=legacy?.receiver??new GlForwardNativeRetirement("session",0,this.pid,session,owner.owner.operations);
      receiver=slot.receiver;receiver.prepare(this.registry,this.muxers);
    }
    owner.closed=true;this.adapter.retireOwner(owner.owner);
    this.send({...owner.grant,type:"gl_owned_closing"});
    if(receiver && this.finals.retirementComplete(owner.owner)) {
      this.submits.removeSession(this.pid,session);
      receiver.revoke(this.registry,this.muxers);receiver.retry(this.muxers);
    }
    this.requestWork();
  }
  hasSession(session:number):boolean {return this.owners.has(session);}
  /** Reserve real scalar custody before legacy native source creation. The
   * receiver captures final source identities only when admission is revoked. */
  reserveLegacy(binding:GlBinding):boolean {
    const old=this.legacy.get(binding.sessionId);
    if(old?.operations===binding.operations)return !old.retiring;
    if(this.closing || (old && !old.receiver.complete) || (!old && this.legacy.size>=this.limits.maxOwners))return false;
    try {
      this.legacy.set(binding.sessionId,{operations:binding.operations,retiring:false,
        receiver:new GlForwardNativeRetirement("session",0,this.pid,binding.sessionId,binding.operations)});
      return true;
    }catch{return false;}
  }
  retireLegacy(session:number):boolean {
    const entry=this.legacy.get(session);if(!entry)return false;
    entry.retiring=true;this.submits.removeSession(this.pid,session);
    entry.receiver.revoke(this.registry,this.muxers);entry.receiver.retry(this.muxers);this.requestWork();return true;
  }
  close():void {
    this.closing=true;
    if(this.endpointRegistration)this.noticeClosing();
    else this.finishClosing(); // No associated client ever acquired admission.
    this.requestWork();
  }
  private finishEndpointRelease():void {
    if(!this.endpointRelease)return;
    for(const entry of this.legacy.values())if(!entry.receiver.complete)return;
    this.endpointReleased=this.endpointRelease;this.endpointFloor=Math.max(this.endpointFloor,this.endpointRelease);
    this.endpointRelease=0;this.endpointRegistration=0;this.endpointReleaseAcknowledged=false;
    this.send({type:"gl_owned_endpoint_released",pid:this.pid,epoch:this.epoch,endpointRegistration:this.endpointReleased});
    if(this.closing)this.finishClosing();
  }
  private noticeClosing():void {
    this.send({type:"gl_owned_endpoint_closing",pid:this.pid,epoch:this.epoch,endpointRegistration:this.endpointRegistration});
  }
  private finishClosing():void {
    if(this.closingAcknowledged)return;
    // The ACK is ordered after all legacy posts accepted before the client
    // closed admission. Only now may public roots and the legacy receiver go.
    for(const owner of this.owners.values())this.retireSession(owner.owner.sessionId,true);
    for(const session of this.legacy.keys())if(!this.owners.has(session))this.retireLegacy(session);
    this.closingAcknowledged=true;this.maybeRelease();
  }
  get legacyClosed():boolean {return this.closingAcknowledged;}
  private maybeRelease():void {
    if(!this.closingAcknowledged || this.owners.size || this.endpointRegistration || !this.endpointReleaseAcknowledged || this.detached)return;
    for(const entry of this.legacy.values())if(entry.retiring && !entry.receiver.complete)return;
    this.legacy.clear();this.endpoint.removeEventListener("message",this.onMessage);this.detached=true;this.retirements.release(this);
  }
  get released():boolean {return this.detached;}
  get retainedBytes():number {return this.adapter.retainedBytes+this.finals.retainedBytes;}
  get pendingRequests():number {return this.records+this.finals.pending;}
}

type ClientReceipt={token:bigint;begin:Omit<QueryBegin,"input">;custody:GlRemoteResultCustody;
  execution:GlResultExecution|null;admission:"unsent"|"awaiting-native-admission"|"native-admitted";
  mode:GlResultMode|null;rejected:boolean;announced?:string};
type ClientRetirement={sequence:number;source:number;state:"empty"|"queued"|"pending"|"complete"};
type ClientFinal={bytes:Uint8Array<ArrayBuffer>;state:"unsent"|"awaiting-native-admission"|"pending"|"rejecting"|"retired"|"rejected";closesSession:boolean;dirty:boolean;wake?:()=>void};
type ClientOwner={owner:GlResultOwner;clientRegistration:number;grant:Grant|null;openRejected:boolean;closed:boolean;forgetting:boolean;receipts:Map<bigint,ClientReceipt>;finals:Map<bigint,ClientFinal>;
  serial:number;retirements:RetirementSlots<ClientRetirement>;ownerWake:((pid:number,session:number,registration:number)=>void)|undefined;workWake?:((pid:number,session:number,registration:number)=>void)};
/** Kernel-side paired endpoint. Until the actual renderer Begin ACK this owns
 * copied ordered intent and endpoint cleanup responsibility, not native storage.
 * No timeout, timer, Atomics.wait, guest view or native cleanup closure exists.
 * queueWakeup must schedule a later worker turn rather than reentering Rust. */
export class GlOwnedForwardClient {
  private store:GlOwnedResultStore;
  private finalBytes=0;
  private finalCount=0;
  private finalFloors=new WeakMap<GlResultOwner,bigint>();
  private peer=new GlResultPeer(1);
  private owners=new Map<GlResultOwner,ClientOwner>();
  private onMessage:(event:MessageEvent)=>void;
  private cursor=0;
  private scalarCursor=0;
  private continueDrain=false;
  private forgotten=new WeakSet<GlResultOwner>();
  private endpointRegistration:number;
  private endpointEpoch:number|null=null;
  private endpointClosed=false;
  private endpointReleasing=false;
  private endpointReleased=false;
  constructor(private endpoint:GlOwnedForwardEndpoint,private pid:number,private limits:GlResultLimits,
    private queueWakeup:(pid:number,session:number,registration:number,token:bigint)=>void) {
    if(clientRegistrationSerial===Number.MAX_SAFE_INTEGER)throw new RangeError("owned endpoint registration exhausted");
    this.endpointRegistration=++clientRegistrationSerial;
    this.limits=Object.freeze({...limits});this.store=new GlOwnedResultStore(this.limits);
    this.onMessage=event=>this.receive(event.data);endpoint.addEventListener("message",this.onMessage);
    this.legacyReady();
  }
  /** Zero-effect refusal until the actual receiver grants this endpoint.
   * A closing notice irrevocably closes all associated legacy admission. */
  legacyReady():boolean {
    if(this.endpointClosed)return false;
    if(this.endpointEpoch===null)this.post({type:"gl_owned_endpoint_open",pid:this.pid,endpointRegistration:this.endpointRegistration});
    return this.endpointEpoch!==null;
  }
  register(session:number,operations:GlOperationStream):GlResultOwner|null {
    if(this.endpointClosed || clientRegistrationSerial===Number.MAX_SAFE_INTEGER)return null;
    const owner=this.store.openOwner(this.pid,session,operations);if(!owner)return null;
    if(!this.owners.has(owner))this.owners.set(owner,{owner,clientRegistration:++clientRegistrationSerial,
      grant:null,openRejected:false,closed:false,forgetting:false,receipts:new Map(),finals:new Map(),serial:0,ownerWake:undefined,
      retirements:{context:{sequence:0,source:0,state:"empty"},surface:{sequence:0,source:0,state:"empty"},session:{sequence:0,source:0,state:"empty"}}});
    this.open(this.owners.get(owner)!);return owner;
  }
  private route(owner:GlResultOwner):Route {
    return {pid:this.pid,sessionId:owner.sessionId,clientRegistration:this.owners.get(owner)!.clientRegistration};
  }
  private post(message:unknown):void {try {this.endpoint.postMessage(message);} catch {/* Any attempted post can have been enqueued. */}}
  private open(owner:ClientOwner):void {if(!owner.grant)this.post({...this.route(owner.owner),type:"gl_owned_open"});}
  beginFinal(owner:GlResultOwner,token:bigint,input:Uint8Array):boolean {
    const entry=this.owners.get(owner),old=entry?.finals.get(token);
    if(old)return old.bytes.length===input.length&&old.bytes.every((v,i)=>v===input[i]);
    if(!entry||entry.closed||typeof token!=="bigint"||token<=(this.finalFloors.get(owner)??0n)||token>0x7fff_ffff_ffff_ffffn||!input.length||input.length%8||input.length>CAP
      ||this.pendingRequests>=this.limits.maxRequests||input.length>this.limits.maxRetainedBytes-this.retainedBytes
      ||[...entry.receipts.values()].some(receipt=>this.store.poll(owner,receipt.token).state!=="retired")
      ||owner.operations.immediateState()!=="idle")return false;
    try {
      const bytes=new Uint8Array(input),view=new DataView(bytes.buffer);let closesSession=false;
      for(let i=0;i<bytes.length;i+=8)if(view.getUint32(i,true)===1)closesSession=true;
      entry.finals.set(token,{bytes,state:"unsent",closesSession,dirty:true});
    }
    catch{return false;}
    this.finalBytes+=input.length;this.finalCount++;this.continueDrain=true;this.notifyWork(entry);return true;
  }
  pollFinal(owner:GlResultOwner,token:bigint):ClientFinal["state"]|null {return this.owners.get(owner)?.finals.get(token)?.state??null;}
  watchFinal(owner:GlResultOwner,token:bigint,wake:()=>void):boolean {
    const receipt=this.owners.get(owner)?.finals.get(token);if(!receipt)return false;
    receipt.wake=wake;if(receipt.dirty||receipt.state==="retired"||receipt.state==="rejected")wake();return true;
  }
  retryFinal(owner:GlResultOwner,token:bigint):boolean {
    const entry=this.owners.get(owner),receipt=entry?.finals.get(token);if(!entry||!receipt)return false;
    receipt.dirty=true;this.continueDrain=true;this.notifyWork(entry);return true;
  }
  forgetFinal(owner:GlResultOwner,token:bigint):boolean {
    const entry=this.owners.get(owner),receipt=entry?.finals.get(token);
    if(!entry||!receipt||(receipt.state!=="retired"&&receipt.state!=="rejected"))return false;
    if(entry.grant)this.post({...entry.grant,...finalWords(token),type:"gl_owned_final_forget"});
    this.finalBytes-=receipt.bytes.length;this.finalCount--;entry.finals.delete(token);this.finalFloors.set(owner,token>(this.finalFloors.get(owner)??0n)?token:this.finalFloors.get(owner)!);return true;
  }
  begin(owner:GlResultOwner,token:bigint,begin:QueryBegin):boolean {
    const entry=this.owners.get(owner);if(!entry || entry.closed)return false;
    const existing=entry.receipts.get(token);
    if(existing)return existing.begin.op===begin.op && existing.begin.capacity===begin.capacity
      && existing.begin.hasCurrent===begin.hasCurrent && existing.begin.context===begin.context
      && existing.begin.draw===begin.draw && existing.begin.read===begin.read
      && this.store.matchesRequest(owner,token,begin.op,begin.input,begin.capacity);
    if(this.finalBytes+this.store.retainedBytes+begin.input.length+begin.capacity>this.limits.maxRetainedBytes || this.pendingRequests>=this.limits.maxRequests)return false;
    // Validate before reserving/copying. The store owns the frozen first input;
    // retries cannot replace it even if their caller buffer changes.
    try {encodeQueryRequest({control:"begin",token,begin});} catch {return false;}
    const custody=GlRemoteResultCustody.unposted(this.peer,owner,token);
    const metadata:ClientReceipt={token,begin:{op:begin.op,capacity:begin.capacity,hasCurrent:begin.hasCurrent,
      context:begin.context,draw:begin.draw,read:begin.read},custody,execution:null,admission:"unsent",mode:null,rejected:false};
    entry.receipts.set(token,metadata);
    if(this.store.begin(owner,token,begin.op,begin.input,begin.capacity,custody)!=="admitted") {entry.receipts.delete(token);return false;}
    this.continueDrain=true;return true;
  }
  control(owner:GlResultOwner,token:bigint,mode:GlResultMode):boolean {
    const receipt=this.owners.get(owner)?.receipts.get(token);if(!receipt || !this.store[mode](owner,token))return false;
    receipt.mode??=mode;return true;
  }
  poll(owner:GlResultOwner,token:bigint):GlResultPoll {return this.store.poll(owner,token);}
  admission(owner:GlResultOwner,token:bigint):ClientReceipt["admission"]|null {return this.owners.get(owner)?.receipts.get(token)?.admission??null;}
  matchesEndpoint(endpoint:object,pid:number):boolean {return endpoint===this.endpoint && pid===this.pid;}
  private session(session:number):ClientOwner|undefined {for(const owner of this.owners.values())if(owner.owner.sessionId===session)return owner;return undefined;}
  hasSession(session:number):boolean {return !!this.session(session);}
  hasBarrier(session:number):boolean {
    if(!this.legacyReady())return true;
    const owner=this.session(session);if(!owner)return false;
    if(owner.finals.size)return true;
    for(const receipt of owner.receipts.values())if(this.store.poll(owner.owner,receipt.token).state!=="retired")return true;
    for(const slot of Object.values(owner.retirements))if(slot.state!=="empty" && slot.state!=="complete")return true;
    return owner.closed;
  }
  hasCreationBarrier():boolean {
    if(!this.legacyReady())return true;
    for(const entry of this.owners.values())if(this.hasBarrier(entry.owner.sessionId))return true;
    return false;
  }
  /** Three scalar slots are reserved before accepting any query. New source
   * creation is refused while a barrier is active; distinct ids never coalesce. */
  queueRetirement(session:number,kind:GlForwardRetirementKind,source:number):boolean {
    const entry=this.session(session);if(!entry || !retirementKind(kind) || !Number.isInteger(source) || source<0 || source>0xffff_ffff
      || (kind==="session" ? source!==0 : source===0))return false;
    const slot=entry.retirements[kind];
    if(slot.state!=="empty" && slot.state!=="complete") {
      if(slot.source!==source)return false;
      this.notifyWork(entry);return true; // Explicit renewed same-source retry.
    }
    // Closed admission cannot create a replacement native source. Keep its
    // exact completed retirement proof rather than manufacture another intent.
    if(entry.closed && slot.state==="complete" && slot.source===source)return true;
    if(entry.serial===Number.MAX_SAFE_INTEGER)return false;
    slot.sequence=++entry.serial;slot.source=source;slot.state="queued";
    if(kind==="session")this.retireOwner(entry.owner);
    this.notifyWork(entry);return true;
  }
  retirementComplete(owner:GlResultOwner):boolean {
    const entry=this.owners.get(owner);if(!entry?.closed)return false;
    if(entry.finals.size)return false;
    for(const receipt of entry.receipts.values())if(this.store.poll(owner,receipt.token).state!=="retired")return false;
    for(const slot of Object.values(entry.retirements))if(slot.state!=="empty" && slot.state!=="complete")return false;
    return true;
  }
  ownerForgotten(owner:GlResultOwner):boolean {return this.forgotten.has(owner);}
  /** Notification only: caller schedules a later worker turn, not a Rust
   * entry on a message/import stack. Late registration inspects durable state. */
  watchOwner(owner:GlResultOwner,wake:ClientOwner["ownerWake"]):boolean {
    const entry=this.owners.get(owner);
    if(!entry) {
      if(!this.forgotten.has(owner))return false;
      try {wake?.(owner.pid,owner.sessionId,owner.registration);}catch {/* Proof remains durable. */}
      return true;
    }
    entry.ownerWake=wake;
    if(entry.closed || entry.openRejected || this.retirementComplete(owner)
      || Object.values(entry.retirements).some(slot=>slot.state==="complete"))this.notifyOwner(entry);
    return true;
  }
  /** Durable admission/progress hints only. Pending replies are deduplicated;
   * they must not create a Poll/reply scheduling loop. No guest view crosses. */
  watchWork(owner:GlResultOwner,wake:ClientOwner["workWake"]):boolean {
    const entry=this.owners.get(owner);if(!entry)return false;
    entry.workWake=wake;
    if(entry.grant || entry.openRejected || entry.closed)this.notifyWork(entry);
    return true;
  }
  private notifyWork(entry:ClientOwner):void {
    try {entry.workWake?.(entry.owner.pid,entry.owner.sessionId,entry.owner.registration);}catch {/* Durable state remains available. */}
  }
  private notifyOwner(entry:ClientOwner):void {
    try {entry.ownerWake?.(entry.owner.pid,entry.owner.sessionId,entry.owner.registration);}catch {/* Durable state is inspected on registration/retry. */}
  }
  private receive(data:unknown):void {
    if(!data || typeof data!=="object")return;
    const message=data as Wire;
    if(message.pid===this.pid && message.endpointRegistration===this.endpointRegistration && positive(message.epoch)) {
      if(message.type==="gl_owned_endpoint_opened") {
        if(this.endpointEpoch===null)this.endpointEpoch=message.epoch;
        return;
      }
      if(message.type==="gl_owned_endpoint_released" && message.epoch===this.endpointEpoch && this.endpointReleasing) {
        this.endpointReleased=true;
        this.post({type:"gl_owned_endpoint_release_received",pid:this.pid,epoch:this.endpointEpoch,
          endpointRegistration:this.endpointRegistration});return;
      }
      if(message.type==="gl_owned_endpoint_closing" && message.epoch===this.endpointEpoch) {
        const changed=!this.endpointClosed;
        this.endpointClosed=true;
        // Reserve actual cleanup intent before acknowledging admission closure.
        // This is not a native cleanup ACK: each session still waits for its
        // actual receiver and all accepted query retirement acknowledgements.
        if(changed)for(const entry of this.owners.values()) {
          this.queueRetirement(entry.owner.sessionId,"session",0);
          this.notifyOwner(entry);
        }
        // Retransmit the closing ACK, but duplicate notices must neither
        // manufacture a new scalar intent nor wake unchanged failed cleanup.
        this.post({type:"gl_owned_endpoint_closed",pid:this.pid,epoch:this.endpointEpoch,
          endpointRegistration:this.endpointRegistration});
        if(!this.owners.size) {this.endpointReleasing=true;this.releaseEndpoint();}
        return;
      }
    }
    if(!routeValid(message,this.pid))return;
    let entry:ClientOwner|undefined;
    for(const candidate of this.owners.values())if(candidate.owner.sessionId===message.sessionId
      && candidate.clientRegistration===message.clientRegistration) {entry=candidate;break;}
    if(!entry)return;
    if(message.type==="gl_owned_open_rejected") {
      // Without a grant this client could never send a native query. This
      // exact endpoint may refuse old/unregistered intent without pretending
      // that an attempted native request has retired.
      if(entry.grant || this.endpointEpoch===null || message.epoch!==this.endpointEpoch || message.error!==13)return;
      entry.openRejected=true;entry.closed=true;this.store.retireOwner(entry.owner);
      for(const receipt of entry.receipts.values()) {
        receipt.mode??="cancel";this.wake(entry.owner,receipt.token);
      }
      this.notifyOwner(entry);
      return;
    }
    if(message.type==="gl_owned_opened") {
      if(entry.openRejected)return;
      if(this.endpointEpoch===null || message.epoch!==this.endpointEpoch || !positive(message.registration))return;
      if(entry.grant && (entry.grant.epoch!==message.epoch || entry.grant.registration!==message.registration))return;
      const changed=!entry.grant;
      if(changed)for(const receipt of entry.finals.values())receipt.dirty=true;
      entry.grant={...this.route(entry.owner),epoch:message.epoch,registration:message.registration};
      if(changed)this.notifyWork(entry);return;
    }
    if(!entry.grant || message.epoch!==entry.grant.epoch || message.registration!==entry.grant.registration)return;
    if(message.type==="gl_owned_closing") {
      const changed=!entry.closed;
      this.retireOwner(entry.owner);
      if(changed)this.notifyOwner(entry);
      return;
    }
    if(message.type==="gl_owned_owner_forgotten") {
      if(!entry.forgetting || !entry.closed)return;
      // The server may retain only clean scalar owner metadata if this final
      // release is lost. It never loses unresolved native cleanup authority.
      if(!entry.receipts.size || this.store.forgetOwner(entry.owner)) {
        this.post({...entry.grant,type:"gl_owned_release_owner"});this.forgotten.add(entry.owner);this.notifyOwner(entry);this.owners.delete(entry.owner);
        if(this.endpointClosed && !this.owners.size) {this.endpointReleasing=true;this.releaseEndpoint();}
      }
      return;
    }
    if(message.type==="gl_owned_retired") {
      if(!retirementKind(message.retirement) || typeof message.complete!=="boolean")return;
      const slot=entry.retirements[message.retirement];
      if(slot.state!=="pending" || slot.sequence!==message.sequence || slot.source!==message.source)return;
      if(message.complete) {slot.state="complete";this.notifyOwner(entry);}
      return;
    }
    if(message.type==="gl_owned_final_notify"||message.type==="gl_owned_final_reply") {
      const token=finalToken(message),receipt=token===null?undefined:entry.finals.get(token);if(!receipt)return;
      if(message.type==="gl_owned_final_notify") {
        if(receipt.state==="retired"||receipt.state==="rejected")return;
        receipt.dirty=true;this.continueDrain=true;this.notifyWork(entry);receipt.wake?.();return;
      }
      const state=message.finalState;if(state!=="pending"&&state!=="rejecting"&&state!=="retired"&&state!=="rejected")return;
      if(receipt.state==="retired"||receipt.state==="rejected")return;
      const changed=receipt.state!==state;receipt.state=state;
      if(receipt.closesSession && (state==="pending"||state==="retired"))this.retireOwner(entry.owner);
      if(changed){receipt.wake?.();this.notifyWork(entry);}return;
    }
    if(message.type==="gl_owned_notify") {
      if(typeof message.token==="bigint" && entry.receipts.has(message.token)) {
        this.wake(entry.owner,message.token);this.notifyWork(entry);
      }
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
    const progress=reply.phase+(reply.phase==="retired"?`/${reply.mode}/${reply.accepted}`:"");
    if(receipt.announced!==progress) {
      receipt.announced=progress;this.notifyWork(entry);this.wake(entry.owner,token);
    }
  }
  private wake(owner:GlResultOwner,token:bigint):void {
    try {this.queueWakeup(this.pid,owner.sessionId,owner.registration,token);} catch {/* Durable phase can be polled later. */}
  }
  drain(maxVisits:number):number {
    if(!Number.isSafeInteger(maxVisits)||maxVisits<0)return 0;
    this.continueDrain=false;
    if(!this.endpointClosed)this.legacyReady();
    if(this.endpointReleasing && !this.endpointReleased && maxVisits>0)this.releaseEndpoint();
    const records:Array<[ClientOwner,ClientReceipt]>=[];
    for(const entry of this.owners.values())for(const receipt of entry.receipts.values())records.push([entry,receipt]);
    const visits=Math.min(maxVisits,records.length),visited=new Set<ClientReceipt>();
    for(let i=0;i<visits;i++) {
      this.cursor%=records.length;
      const [entry,receipt]=records[this.cursor];this.cursor=(this.cursor+1)%records.length;visited.add(receipt);
      if(this.store.poll(entry.owner,receipt.token).state==="retired")continue;
      if(receipt.mode && receipt.admission==="unsent") {
        // A failed encoding/allocation can leave a started local ticket which
        // provably never attempted a post. Report that synchronous quiescence.
        receipt.execution?.complete(-5);
        if(this.store.acknowledgeRetired(entry.owner,receipt.token))this.wake(entry.owner,receipt.token);
        continue;
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
    const scalarOwners=[...this.owners.values()];
    for(let i=0;i<Math.min(maxVisits,scalarOwners.length);i++) {
      this.scalarCursor%=scalarOwners.length;
      const entry=scalarOwners[this.scalarCursor];this.scalarCursor=(this.scalarCursor+1)%scalarOwners.length;
      let retired=[...entry.finals.values()].every(receipt=>receipt.state==="retired"||receipt.state==="rejected");
      for(const receipt of entry.receipts.values())if(this.store.poll(entry.owner,receipt.token).state!=="retired")retired=false;
      if(!retired)continue;
      let selected:GlForwardRetirementKind|null=null;
      for(const kind of ["context","surface","session"] as const) {
        const slot=entry.retirements[kind];
        if((slot.state==="queued" || slot.state==="pending") && (!selected || slot.sequence<entry.retirements[selected].sequence))selected=kind;
      }
      if(!selected)continue;
      if(!entry.grant) {this.open(entry);continue;}
      const slot=entry.retirements[selected];slot.state="pending";
      this.post({...entry.grant,type:"gl_owned_retire",retirement:selected,sequence:slot.sequence,source:slot.source});
    }
    let finalVisits=0;
    for(const entry of this.owners.values())for(const [token,receipt] of entry.finals) {
      if(finalVisits>=maxVisits) {if(receipt.dirty)this.continueDrain=true;continue;}
      if(!receipt.dirty||receipt.state==="retired"||receipt.state==="rejected")continue;
      receipt.dirty=false;finalVisits++;
      if(!entry.grant){this.open(entry);continue;}
      const first=receipt.state==="unsent"||receipt.state==="awaiting-native-admission";
      // Freeze uncertain admission BEFORE any fallible post.
      if(first)receipt.state="awaiting-native-admission";
      this.post({...entry.grant,...finalWords(token),type:first?"gl_owned_final_begin":"gl_owned_final_poll",
        ...(first?{bytes:buffer(receipt.bytes)}:{})});
    }
    for(const entry of this.owners.values())if(entry.forgetting && this.retirementComplete(entry.owner))this.forgetOwner(entry.owner);
    this.continueDrain ||=records.some(([entry,receipt])=>!visited.has(receipt) && !!entry.grant
      && receipt.admission==="unsent" && this.store.canTake(entry.owner,receipt.token));
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
    if(!this.retirementComplete(owner))return false;
    entry.forgetting=true;
    if(!entry.grant) {
      if(entry.openRejected) {
        if(entry.receipts.size && !this.store.forgetOwner(owner))return false;
        this.forgotten.add(owner);this.notifyOwner(entry);this.owners.delete(owner);return true;
      }
      // Open itself may have been delivered despite a lost response. Recover
      // its exact generation and retire the real server registration too.
      this.open(entry);if(!entry.grant)return false;
    }
    entry.forgetting=true;this.post({...entry.grant,type:"gl_owned_forget_owner"});return true;
  }
  /** Refuse listener removal while it still owns uncertain/native cleanup. */
  private releaseEndpoint():void {
    if(this.endpointEpoch!==null)this.post({type:"gl_owned_endpoint_release",pid:this.pid,epoch:this.endpointEpoch,
      endpointRegistration:this.endpointRegistration});
    else {
      // Open may have been delivered despite a lost grant. Recover that exact
      // endpoint authority before listener removal, even without query owners.
      this.post({type:"gl_owned_endpoint_open",pid:this.pid,endpointRegistration:this.endpointRegistration});
    }
  }
  dispose():boolean {
    if(this.owners.size)return false;
    this.endpointClosed=true;this.endpointReleasing=true;
    if(!this.endpointReleased)this.releaseEndpoint();
    if(!this.endpointReleased)return false;
    this.endpoint.removeEventListener("message",this.onMessage);return true;
  }
  get runnableAfterDrain():boolean {return this.continueDrain;}
  get retainedBytes():number {return this.store.retainedBytes+this.finalBytes;}
  get pendingRequests():number {return this.store.pendingRequests+this.finalCount;}
  get idle():boolean {return this.owners.size===0;}
}
