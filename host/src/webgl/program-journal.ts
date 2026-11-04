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
  previous: Generation | null; select: () => void };
type GroupOrder = { sequence: number };
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

  private readonly objects: GlObjectGroup;

  private constructor(readonly binding: GlBinding, readonly capacity: number,
      private readonly order: GroupOrder) {
    this.objects=binding.objects;
    for (let i=0;i<capacity;i++) {
      const slot: Slot={phase:"free",ticket:0,sequence:0,name:0,error:0,
        target:null,previous:null,select:()=>binding.gl!.useProgram(slot.target?.pin?.program ?? null)};
      this.slots.push(slot);
    }
  }

  static create(execution: GlContextExecutionLease, capacity: number): GlProgramJournal | null {
    const b=execution.binding;
    if(!Number.isSafeInteger(capacity) || capacity<1 || capacity>256 || execution.retired || !b.gl || b.contextId===null || b.programJournal) {
      recordGlError(b,0x502);return null;
    }
    let journal: GlProgramJournal | undefined;
    try {
      let order=orders.get(b.objects);
      if(!order) {order={sequence:0};orders.set(b.objects,order);}
      journal=new GlProgramJournal(b,capacity,order);
      // Publish the rollback receiver BEFORE acquiring any private native pin.
      b.programJournal=journal;
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
    if(!this.ready || this.closed || this.pending || this.nextGeneration>MAX) {recordGlError(this.binding,0x502);return 0;}
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
    if(!this.ready || this.closed || this.poisoned || authority.pid!==this.binding.pid ||
        authority.objects!==this.objects || this.binding.objects!==this.objects ||
        !authority.gl || !this.binding.gl || authority.contextId===null ||
        !Number.isInteger(name) || name<0 || name>0xffff_ffff ||
        !Number.isSafeInteger(ticket) || ticket!==this.published+1 ||
        !Number.isSafeInteger(sequence) || sequence!==this.order.sequence+1 ||
        ticket>MAX || sequence>MAX || !Number.isInteger(index) || index<0 || index>=this.capacity) return false;
    const slot=this.slots[index]!;
    if(slot.phase!=="free")return false;
    const target=token===0?null:this.generations.get(token);
    if(token!==0 && (!target || !target.cache || !target.pin))return false;
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
  }
}

export function retireProgramJournal(binding: GlBinding): void {binding.programJournal?.retire();}
