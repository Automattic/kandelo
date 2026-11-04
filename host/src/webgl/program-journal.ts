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
export type GlProgramJournalControl={receipt:Uint32Array;bytes:Uint8Array;snapshot:Uint32Array;snapshotBytes:Uint8Array;errors:number[]};
export function createProgramJournalControl(): GlProgramJournalControl {
  const receipt=new Uint32Array(12),snapshot=new Uint32Array(12);
  receipt[11]=snapshot[11]=0x47514c33;
  return {receipt,bytes:new Uint8Array(receipt.buffer),snapshot,snapshotBytes:new Uint8Array(snapshot.buffer),errors:[]};
}
