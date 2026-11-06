import {GlWirePayload} from "./wire-payload.js";
import {GlInlineDraws} from "./owned-inline-draw.js";
import {combinedTextureUnits} from "./limits.js";
import type {OptionalCpuPreparation} from "./errors.js";
import {PreparedOwnedDraw} from "./prepared-owned-draw.js";
import {GlUniformCpuPreparation} from "./uniform-cpu-preparation.js";
import {prepareUniformWrites} from "./reversed-depth.js";
import {prepareSamplerWrites} from "./depth-sampling.js";
import {GlFramebufferSnapshots} from "./framebuffer-snapshots.js";
/** Pre-admitted logical program history. This is shared Node/browser device
 * state, not a guest wire entrypoint. The driver transport must publish each
 * committed shared intent before a peer changes its namespace. */
import type { GlBinding, GlContextExecutionLease } from "./registry.js";
import { GlProgramQueryPin, checkedGlCall, currentProgramName, finalizeProgram } from "./program-objects.js";
import { retainContextGlProgramCapture } from "./program-captures.js";
import { nativeGlFault, rethrowNativeGlFault } from "./native-recovery.js";
import { isKernelExportFailure } from "../kernel-entry-gate.js";
import { recordGlError } from "./errors.js";
import type { GlObjectGroup } from "./object-group.js";
import { uniformLayout } from "./uniform-layout.js";
import {GlBufferSnapshots,BUFFER_SNAPSHOT_CAPACITY} from "./buffer-snapshots.js";

type Generation = { token: number; pin: GlProgramQueryPin | null; cache: boolean; references: number };
type Slot = { phase: "free" | "published" | "executing" | "failed"; ticket: number;
  sequence: number; name: number; error: number; target: Generation | null;
  previous: Generation | null; checked: boolean; select: () => void };
type GroupOrder = { sequence: number; nextJournal: number; journals: Map<number,GlProgramJournal> };
const orders = new WeakMap<GlObjectGroup, GroupOrder>();
const MAX = Number.MAX_SAFE_INTEGER;

/** Native pins and every pending/result cell are reserved at cold admission.
 * Publishing a logical selection never clones a pin or allocates a result.
 * A successor retains its predecessor until the native switch completes: the
 * predecessor may already have lost its public name and cache owner. */
export class GlProgramJournal {
  private execution: GlContextExecutionLease | null = null;
  private pending: Generation | null = null;
  private readonly generations = new Map<number, Generation>();
  private readonly slots: Slot[] = [];
  private current: Generation | null = null;
  private nextGeneration = 1;
  private published = 0;
  private executed = 0;
  private active = 0;
  private closed = false;
  private ready = false;
  private poisoned = false;
  private retiringName = 0;
  private previewActive = false;
  private previewTicket = 0;
  private bufferSnapshots:GlBufferSnapshots|null=null;
  readonly wirePayload=new GlWirePayload();
  private readonly ownedDrawCells=Array.from({length:16},()=>({token:0,proof:null as PreparedOwnedDraw|null,ready:false,family:0,target:0xffff_ffff,targetToken:0}));
  private inlineDraws:GlInlineDraws|null=null;
  inlineDrawWorkspace():GlInlineDraws|null{return this.ready&&!this.closed&&!this.poisoned?this.inlineDraws:null;}
  prepareOwnedDraw(index:number,token:number,family:number,target:number,targetToken:number):number|null {
    if(!this.ready||this.closed||this.poisoned||!this.execution||index>=16||family>1)return null;
    const cell=this.ownedDrawCells[index];
    if(!Number.isInteger(token)||token===0||cell.token===0xffff_ffff||token!==cell.token+1)return null;
    if(cell.proof&&!cell.proof.retire())nativeGlFault("Owned draw cold replacement could not retire its exact authority");
    cell.proof=null;cell.ready=false;cell.token=token;cell.family=family;cell.target=target;cell.targetToken=targetToken;
    if(family===1){
      // The selected inline family addresses the default target. An optional
      // offscreen request gets no proof; its original GL draw stays observed.
      if(target!==0xffff_ffff)return 0;
      // No VBO authority allocates this bank. Publish the receiver before
      // native stream initialization so refused admission retains its custody.
      if(!this.inlineDraws)this.inlineDraws=GlInlineDraws.reserve(this.binding);
      if(!this.inlineDraws?.initialize(this.execution))return 0;
    }
    const base=target===0xffff_ffff?(family===1?this.inlineDraws?.executionView(this.binding):this.bufferDrawExecutionView()):this.framebufferTargetChanges(target,targetToken)?.view;
    if(!base)return 0;
    const proof=PreparedOwnedDraw.prepare(this.execution,base,receiver=>{cell.proof=receiver;},target===0xffff_ffff);
    if(!proof){
      if(!retirePreparedOwned(cell.proof))nativeGlFault("Refused owned draw preparation retained unresolved custody");
      cell.proof=null;return 0;
    }
    cell.proof=proof;cell.ready=true;return 1;
  }
  ownedDraw(index:number,token:number,target:number,targetToken:number,family=0):PreparedOwnedDraw|null {
    const cell=this.ownedDrawCells[index];
    return this.ready&&!this.closed&&!this.poisoned&&cell?.ready&&cell.token===token&&cell.target===target&&cell.targetToken===targetToken&&cell.family===family&&cell.proof?.matches()?cell.proof:null;
  }
  private uniformCpu:GlUniformCpuPreparation|null=null;
  private uniformCpuAttempted=false;
  prepareUniformCpu():number {
    if(!this.ready||this.closed||this.poisoned)return 0;
    if(!this.uniformCpuAttempted){
      this.uniformCpuAttempted=true;
      try{
        // A first sampler setter must not allocate the immutable limit cache
        // after C used the guaranteed GLES minimum for local acceptance.
        combinedTextureUnits(this.binding.gl!);
        this.uniformCpu=GlUniformCpuPreparation.reserve();
        // Draw signatures may already be cached in the C driver. Reserve
        // every retained executable now; a cache hit after this receipt must
        // not require a second signature query to make its first setter safe.
        if(this.uniformCpu)for(const generation of this.generations.values())if(generation.pin){
          prepareUniformWrites(generation.pin.program);prepareSamplerWrites(generation.pin.program);
        }
      }catch(error){rethrowNativeGlFault(error);this.uniformCpu=null;}
    }
    return this.uniformCpu?.floats.length??0;
  }
  uniformCpuPreparation():GlUniformCpuPreparation|null {
    return this.ready&&!this.closed&&!this.poisoned?this.uniformCpu:null;
  }
  private framebufferSnapshots:GlFramebufferSnapshots|null=null;

  private readonly objects: GlObjectGroup;

  private constructor(readonly binding: GlBinding, readonly capacity: number, readonly id: number,
      private readonly order: GroupOrder, private readonly unsubmittedTransport: boolean) {
    this.objects=binding.objects;
    for (let i=0;i<capacity;i++) {
      const slot: Slot={phase:"free",ticket:0,sequence:0,name:0,error:0,
        target:null,previous:null,checked:false,select:()=>binding.gl!.useProgram(slot.target?.pin?.program ?? null)};
      this.slots.push(slot);
    }
  }

  static create(execution: GlContextExecutionLease, capacity: number,
      owner: "retained-execution" | "guest-metadata" = "retained-execution"): GlProgramJournal | null {
    const b=execution.binding;
    if(!Number.isSafeInteger(capacity) || capacity<1 || capacity>256 || execution.retired || !b.gl || b.contextId===null || b.programJournal) {
      recordGlError(b,0x502);return null;
    }
    let journal: GlProgramJournal | undefined;
    try {
      let order=orders.get(b.objects);
      if(!order) {order={sequence:0,nextJournal:1,journals:new Map()};orders.set(b.objects,order);}
      if(order.nextJournal>0xffff_ffff){recordGlError(b,0x505);return null;}
      journal=new GlProgramJournal(b,capacity,order.nextJournal++,order,owner==="guest-metadata");
      // Publish the rollback receiver BEFORE acquiring any private native pin.
      b.programJournal=journal;
      order.journals.set(journal.id,journal);
      journal.execution=execution.clone();
      if(!journal.execution) {recordGlError(b,0x505);journal.retire();return null;}
      if(b.currentProgram) {
        const root: Generation={token:0,pin:null,cache:false,references:1};
        journal.pending=root;
        root.pin=GlProgramQueryPin.acquireInstalled(execution);
        if(!root.pin) {journal.retire();return null;}
        journal.generations.set(0,root);journal.pending=null;journal.current=root;
      }
      b.logicalProgramCurrent={name:currentProgramName(b)};
      journal.ready=true;
      return journal;
    } catch(error) {
      rethrowNativeGlFault(error);if(isKernelExportFailure(error))throw error;
      if(journal)journal.retire();
      recordGlError(b,0x505);return null;
    }
  }

  /** Own-context cold acquisition only; the opaque capture must not be a
   * private group handle or a cache owned by another context. */
  registerCapture(handle: number): number {
    // Tokens cross the optional transport as one u32; never publish a handle
    // that copyout would truncate into an older generation's authority.
    if(!this.ready || this.closed || this.pending || this.nextGeneration>0xffff_ffff) {recordGlError(this.binding,0x502);return 0;}
    const token=this.nextGeneration;
    try {
      const generation: Generation={token,pin:null,cache:true,references:0};
      this.pending=generation;
      generation.pin=retainContextGlProgramCapture(this.binding,handle);
      if(!generation.pin) {this.pending=null;return 0;}
      let linked=false;
      const observed=checkedGlCall(this.binding,()=>{linked=!!this.binding.gl!.getProgramParameter(generation.pin!.program,0x8b82);});
      if(!observed || !linked) {
        this.retirePending();if(observed && !linked)recordGlError(this.binding,0x502);return 0;
      }
      this.generations.set(token,generation);this.pending=null;this.nextGeneration++;
      return token;
    } catch(error) {
      rethrowNativeGlFault(error);if(isKernelExportFailure(error))throw error;
      this.retirePending();recordGlError(this.binding,0x505);return 0;
    }
  }

  /** Shared metadata authority is confined to the same process/object group.
   * It grants no native execution on the peer. Kernel transport still requires
   * the caller's ordinary current-thread authority for its outer request. */
  publish(authority: GlBinding,index: number,ticket: number,sequence: number,name: number,token: number): boolean {
    const slot=this.publicationSlot(authority,index,ticket,sequence,name,token,this.published+1,this.order.sequence+1);
    if(!slot)return false;
    const target=token===0?null:this.generations.get(token)!;
    const program=name===0?null:this.binding.programs.get(name);
    let error=0;
    if(program===undefined)error=this.binding.shaders.has(name)?0x502:0x501;
    else if(name!==0 && (!target || target.pin!.name!==name || target.pin!.program!==program))error=0x502;
    const previous=error?null:this.current;
    if((target && target.references>MAX-2) || (previous && previous.references>MAX-2))return false;
    // All following writes target cold, owned cells. Commit the complete result
    // before name finalization, whose private native cleanup can fail loudly.
    slot.ticket=ticket;slot.sequence=sequence;slot.name=name;slot.error=error;
    slot.target=name===0?null:target ?? null;slot.previous=previous;slot.phase="published";
    if(slot.target)slot.target.references++;
    if(previous)previous.references++;
    this.active++;this.published=ticket;this.order.sequence=sequence;
    if(!error) {
      const oldName=this.binding.logicalProgramCurrent!.name;
      if(this.current)this.current.references--;
      this.current=slot.target;
      if(this.current)this.current.references++;
      this.binding.logicalProgramCurrent!.name=name;
      // Namespace maps are shared, but pending physical errors belong to the
      // current metadata caller, never the peer whose logical name advances.
      if(oldName && oldName!==name)finalizeProgram(authority,oldName);
    }
    return true;
  }

  private publicationSlot(authority: GlBinding,index: number,ticket: number,sequence: number,
      name: number,token: number,expectedTicket: number,expectedSequence: number): Slot | null {
    if(!this.ready || this.closed || this.poisoned || authority.pid!==this.binding.pid ||
        authority.objects!==this.objects || this.binding.objects!==this.objects ||
        !authority.gl || !this.binding.gl || authority.contextId===null ||
        !Number.isInteger(name) || name<0 || name>0xffff_ffff ||
        !Number.isSafeInteger(ticket) || ticket!==expectedTicket ||
        !Number.isSafeInteger(sequence) || sequence!==expectedSequence ||
        ticket>MAX || sequence>MAX || !Number.isInteger(index) || index<0 || index>=this.capacity) return null;
    const slot=this.slots[index]!;
    if(slot.phase!=="free")return null;
    const target=token===0?null:this.generations.get(token);
    if(token!==0 && (!target || !target.cache || !target.pin))return null;
    return slot;
  }
  checkPublication(authority: GlBinding,index: number,ticket: number,sequence: number,
      name: number,token: number,expectedSequence: number): boolean {
    if(!this.previewActive){this.previewActive=true;this.previewTicket=this.published;}
    const slot=this.publicationSlot(authority,index,ticket,sequence,name,token,this.previewTicket+1,expectedSequence);
    if(!slot || slot.checked)return false;
    slot.checked=true;this.previewTicket=ticket;return true;
  }
  clearPublicationCheck(): void {
    if(!this.previewActive)return;
    this.previewActive=false;for(const slot of this.slots)slot.checked=false;
  }
  get publishedTicket(): number {return this.published;}
  get executedTicket(): number {return this.executed;}
  get flags(): number {return (this.ready&&!this.closed?1:0)|(this.closed?2:0)|(this.poisoned?4:0);}

  /** Cold preparation is memoized, including partial native failure. Publish
   * the receiver before initialization so retirement can never lose a copy.
   * The mutation receipt owns partial admission and recovers it without
   * replaying native allocation after a lost reply. */
  prepareBufferSnapshots(capacity=BUFFER_SNAPSHOT_CAPACITY):number {
    if(!this.ready || this.closed || this.poisoned || !this.execution)return 0;
    if(this.bufferSnapshots && this.bufferSnapshots.capacity!==capacity)return 0;
    if(!this.bufferSnapshots)this.bufferSnapshots=GlBufferSnapshots.reserve(this.binding,capacity);
    return this.bufferSnapshots?.initialize(this.execution)?this.bufferSnapshots.capacity:0;
  }
  defineBufferSnapshot(index:number,token:number,target:number,data:number|Uint8Array<ArrayBuffer>,usage:number):boolean {
    if(!this.ready || this.closed || this.poisoned || !this.bufferSnapshots){recordGlError(this.binding,0x502);return false;}
    return this.bufferSnapshots.define(this.binding,index,token,target,data,usage);
  }
  captureBufferAttribute(index:number,token:number,attribute:number):number|null {
    if(!this.ready || this.closed || this.poisoned || !this.bufferSnapshots){recordGlError(this.binding,0x502);return null;}
    return this.bufferSnapshots.captureAttribute(this.binding,index,token,attribute);
  }
  defineBufferSnapshotFromWire(index:number,token:number,target:number,wire:DataView,offset:number,bytes:number,usage:number):boolean {
    if(!this.ready||this.closed||this.poisoned||!this.bufferSnapshots){recordGlError(this.binding,0x502);return false;}
    return this.bufferSnapshots.defineFromWire(this.binding,index,token,target,wire,offset,bytes,usage);
  }
  bufferDrawWorkspace(){
    return this.ready&&!this.closed&&!this.poisoned?this.bufferSnapshots?.drawWorkspace??null:null;
  }
  bufferDrawExecutionView():GlBinding|null {
    return this.ready&&!this.closed&&!this.poisoned?this.bufferSnapshots?.executionView(this.binding)??null:null;
  }
  resolveBufferSnapshot(index:number,token:number,object:WebGLBuffer,requiredBytes:number):WebGLBuffer|null {
    return this.ready&&!this.closed&&!this.poisoned?this.bufferSnapshots?.resolve(this.binding,index,token,object,requiredBytes)??null:null;
  }

  captureFramebuffer(index:number,token:number,name:number):number|null {
    if(!this.ready||this.closed||this.poisoned||!this.execution)return null;
    if(!this.framebufferSnapshots)this.framebufferSnapshots=GlFramebufferSnapshots.create(this.execution);
    return this.framebufferSnapshots?.capture(index,token,name)??null;
  }
  framebufferTargetChanges(index:number,token:number){
    if(!this.ready||this.closed||this.poisoned)return null;
    const capture=this.framebufferSnapshots?.resolve(index,token);
    return capture?this.framebufferSnapshots!.targetChanges(capture):null;
  }
  framebufferDrawChanges(index:number,token:number){
    if(!this.ready||this.closed||this.poisoned)return null;
    const capture=this.framebufferSnapshots?.resolve(index,token);
    return capture?this.framebufferSnapshots!.changes(capture):null;
  }

  /** Cold driver proof for this journal's immutable executable, never the
   * public name's latest link. Pending/current references keep evicted tokens
   * alive. Reflection neither selects it nor resolves deferred long names. */
  uniformSignature(token: number, location: number, words: Uint32Array, guestType=false): boolean {
    if(!this.ready || this.closed || this.poisoned)return false;
    const pin=this.generations.get(token)?.pin;
    if(!pin)return false;
    const layout=uniformLayout(this.binding,pin.program);
    if(!layout || !layout.current)return false;
    // The signature grants local prediction only after its executable's
    // write counters exist. An ordinary checked setter may create them;
    // an admitted one must only increment cold mutable cells.
    if(this.uniformCpu)try{prepareUniformWrites(pin.program);prepareSamplerWrites(pin.program);}
    catch(error){rethrowNativeGlFault(error);return false;}
    const meta=location>=0?layout.slots[location]:undefined;
    if(meta){
      const native=layout.resolvedNative(location);
      words[6]=meta.type;words[7]=meta.location+meta.size-location;
      words[8]=(meta.array?1:0)|(native===undefined?0:native===null?4:2);
      if(guestType)words[9]=meta.guestType;
    }
    return true;
  }

  /** Execute at the original command/error-observation position, inside the
   * caller's ordinary muxer/native-batch scope. Errors computed during logical
   * publication are deliberately not inserted into the runtime queue early. */
  execute(index: number,ticket: number): boolean {
    const slot=this.slot(index,ticket);
    if(!slot || slot.phase!=="published" || this.poisoned || ticket!==this.executed+1)return false;
    slot.phase="executing";
    try {
      if(slot.error)recordGlError(this.binding,slot.error);
      else {
        if(!checkedGlCall(this.binding,slot.select)) {slot.phase="failed";this.poisoned=true;return false;}
        this.binding.currentProgram=this.binding.shadow.currentProgram=slot.target?.pin?.program ?? null;
        this.binding.currentProgramId=slot.name;
      }
      this.executed=ticket;
      this.complete(slot);
      return true;
    } catch(error) {
      // Entry is consumed, not replayable. Keep both native-generation receivers
      // until explicit fault retirement completes their exact cleanup.
      if(slot.phase==="executing") {slot.phase="failed";this.poisoned=true;}
      throw error;
    }
  }

  /** Release failed/abandoned accepted work only when its owner has decided
   * it will not execute. This never replays an entered selector. */
  discard(index: number,ticket: number): boolean {
    const slot=this.slot(index,ticket);
    if(!this.closed || !slot || (slot.phase!=="published" && slot.phase!=="failed"))return false;
    this.poisoned=true;this.complete(slot);return true;
  }

  releaseCapture(token: number): boolean {
    const generation=this.generations.get(token);
    if(!generation || token===0 || !generation.cache)return false;
    generation.cache=false;this.collect(generation);return true;
  }

  /** A drained driver can leave journal mode before an ordinary synchronous
   * program mutation. No name ownership or accepted execution is discarded. */
  disable(): boolean {
    if(this.active || this.closed)return false;
    this.binding.logicalProgramCurrent=undefined;
    this.close();return true;
  }

  /** Context cache closure breaks the journal/lease cycle. Accepted cells and
   * predecessor edges remain independent owners until execution/discard. */
  retire(): void {
    if(!this.closed) {
      this.retiringName=this.binding.logicalProgramCurrent?.name ?? 0;
      if(this.binding.logicalProgramCurrent)this.binding.logicalProgramCurrent.name=0;
    }
    this.close();
    if(this.retiringName) {
      finalizeProgram(this.binding,this.retiringName);
      this.retiringName=0;
    }
    this.finish();
  }

  retirePublic(): void {
    this.retire();
    // Stage B submits synchronously: a wire receipt owns logical metadata,
    // not an admitted host job. After public retirement no caller can submit
    // these abandoned selectors. Keeping their pins would leak the context.
    // An asynchronous queue must transfer exact slot custody before admission;
    // retained host executions already have a separate retirement contract.
    if(this.unsubmittedTransport)for(let i=0;i<this.slots.length;i++) {
      const slot=this.slots[i]!;
      if(slot.phase==="published" || slot.phase==="failed")this.discard(i,slot.ticket);
    }
  }

  private close(): void {
    if(!this.closed) {
      this.closed=true;this.ready=false;
      if(this.current) {this.current.references--;this.current=null;}
      for(const generation of this.generations.values())generation.cache=false;
    }
    for(const cell of this.ownedDrawCells){
      if(cell.proof&&!cell.proof.retire())nativeGlFault("Owned draw authority retirement remains unacknowledged");
      cell.proof=null;cell.ready=false;
    }
    if(this.inlineDraws){if(!this.inlineDraws.retire())nativeGlFault("Owned inline stream retirement remains unacknowledged");this.inlineDraws=null;}
    this.retirePending();
    for(const generation of this.generations.values())this.collect(generation);
    this.finish();
  }
  private slot(index: number,ticket: number): Slot | null {
    if(!Number.isInteger(index) || index<0 || index>=this.capacity)return null;
    const slot=this.slots[index]!;return slot.ticket===ticket?slot:null;
  }
  private complete(slot: Slot): void {
    const target=slot.target,previous=slot.previous;
    // Drop counters once, before any fallible native cleanup. Failed cleanup
    // stays in generations/pending with its exact pin for a containment retry.
    slot.phase="free";slot.target=null;slot.previous=null;this.active--;
    if(target)target.references--;
    if(previous)previous.references--;
    if(target)this.collect(target);
    if(previous && previous!==target)this.collect(previous);
    this.finish();
  }
  private collect(generation: Generation): void {
    if(generation.cache || generation.references || !generation.pin)return;
    this.releasePin(generation.pin,"Program journal could not retire an exact generation owner");
    generation.pin=null;this.generations.delete(generation.token);
  }
  private retirePending(): void {
    const pending=this.pending;
    if(!pending)return;
    if(pending.pin)this.releasePin(pending.pin,"Program journal admission could not retire its native pin");
    if(this.generations.get(pending.token)===pending)this.generations.delete(pending.token);
    pending.pin=null;pending.references=0;pending.cache=false;this.pending=null;
  }
  private releasePin(pin: GlProgramQueryPin,message: string): void {
    try {if(!pin.release())nativeGlFault(message);}
    catch(error) {rethrowNativeGlFault(error);if(isKernelExportFailure(error))throw error;nativeGlFault(message,error);}
  }
  private finish(): void {
    if(!this.closed || this.active || this.generations.size || this.pending || this.retiringName)return;
    // The bank's own execution lease and native deletion receiver survive a
    // refused close. Do not sever the journal or its context lease first.
    if(this.framebufferSnapshots){
      if(!this.framebufferSnapshots.retire())nativeGlFault("Program journal framebuffer generation retirement remains unacknowledged");
      this.framebufferSnapshots=null;
    }
    if(this.bufferSnapshots){
      if(!this.bufferSnapshots.retire())nativeGlFault("Program journal buffer snapshot retirement remains unacknowledged");
      this.bufferSnapshots=null;
    }
    try {if(this.execution && !this.execution.release())nativeGlFault("Program journal execution retirement failed");}
    catch(error) {rethrowNativeGlFault(error);if(isKernelExportFailure(error))throw error;
      nativeGlFault("Program journal execution retirement threw",error);}
    this.execution=null;
    if(this.binding.programJournal===this)this.binding.programJournal=undefined;
    if(this.order.journals.get(this.id)===this)this.order.journals.delete(this.id);
  }
}

export function retireProgramJournal(binding: GlBinding): void {binding.programJournal?.retirePublic();}

/** Handles are group-scoped, monotonic and never reused after disable/recreate.
 * Read-only lookup may inspect a closed owner; it grants no new publication. */
export function lookupProgramJournal(authority: GlBinding,id: number): GlProgramJournal | null {
  const journal=orders.get(authority.objects)?.journals.get(id);
  return journal && journal.binding.pid===authority.pid && journal.binding.objects===authority.objects ? journal : null;
}
export function programJournalSequence(binding: GlBinding): number {return orders.get(binding.objects)?.sequence ?? 0;}
export type GlProgramJournalControl={receipt:Uint32Array;bytes:Uint8Array;snapshot:Uint32Array;snapshotBytes:Uint8Array;errors:number[];cpuPreparation:OptionalCpuPreparation};
export function createProgramJournalControl(): GlProgramJournalControl {
  const receipt=new Uint32Array(12),snapshot=new Uint32Array(12);
  receipt[11]=snapshot[11]=0x47514c33;
  const errors:number[]=[],cpuPreparation:OptionalCpuPreparation={errors,previous:null,active:false,refused:false};
  return {receipt,bytes:new Uint8Array(receipt.buffer),snapshot,snapshotBytes:new Uint8Array(snapshot.buffer),errors,cpuPreparation};
}

function retirePreparedOwned(proof:PreparedOwnedDraw|null):boolean {return proof?.retire()??true;}
