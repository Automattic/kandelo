import { isKernelExportFailure } from "../kernel-entry-gate.js";
import type { GlContextExecutionLease } from "./registry.js";
import type { GlFenceLease } from "./fences.js";
import type { GlOperationStream, GlOperationTicket } from "./operation-stream.js";
import type { GlMuxer } from "./muxer.js";

const serverWaitMint=Symbol("retained server wait owner");

type Phase = "reserved" | "accepted" | "waiting" | "retiring" | "retired";
export type GlServerWaitOutcome = "pending" | "ordered" | "cancelled" | "failed";

/** One actual source fence and destination execution, independent of public
 * handles, result copyout and registry-slot reuse. Admission owns a stream
 * ticket; accepting the command transfers it to the queue on either result
 * disposition. Cancelling a result cannot erase an accepted server command. */
export class GlServerWaitCandidate {
  private phase: Phase = "reserved";
  private outcome: GlServerWaitOutcome = "pending";
  private started = false;
  private pollDue = true;
  private sourceRetired = false;
  private destinationRetired = false;
  private source: GlFenceLease | null;
  private destination: GlContextExecutionLease | null;
  readonly token: number;
  private constructor(private readonly queue: GlServerWaitQueue,
    source: GlFenceLease, destination: GlContextExecutionLease,
    readonly operations: GlOperationStream,
    private readonly ticket: GlOperationTicket) {
    this.source=source;this.destination=destination;this.token=source.token;
  }

  static prepare(queue: GlServerWaitQueue, source: GlFenceLease,
      destination: GlContextExecutionLease, operations: GlOperationStream, authority: typeof serverWaitMint): GlServerWaitCandidate | null {
    if(authority!==serverWaitMint)throw new Error("Server wait requires queue admission authority");
    try {if (!destination.context || destination.retired || destination.binding.operations !== operations) return null;}catch{return null;}
    const ticket = operations.reserve("server-wait");
    if (!ticket) return null;
    try { return new GlServerWaitCandidate(queue,source,destination,operations,ticket); }
    catch { ticket.cancel(); return null; }
  }
  get status(): GlServerWaitOutcome { return this.outcome; }
  get retired(): boolean { return this.phase === "retired"; }
  get runnable(): boolean {
    return this.phase === "accepted" ? this.ticket.ready
      : (this.phase === "waiting" || this.phase === "retiring") && this.pollDue;
  }
  get needsPoll(): boolean {
    return (this.phase === "waiting" || this.phase === "retiring") && !this.pollDue;
  }
  /** The adapter schedules one later host turn before calling this. Keeping
   * that policy outside the queue avoids a runnable busy loop on GPU fences. */
  pollAfterTurn(): void { if (this.needsPoll) this.pollDue = true; }
  writeReply(out: Uint8Array): number {
    if (out.length !== 16 || this.outcome === "cancelled" || this.outcome === "failed") return -22;
    const v=new DataView(out.buffer,out.byteOffset,out.length);
    v.setUint32(0,0,true);v.setUint32(4,this.token,true);v.setUint32(8,0,true);v.setUint32(12,0x47514c33,true);
    return 16;
  }
  accept(): boolean {
    if (this.phase === "reserved") this.phase = "accepted";
    return this.outcome !== "cancelled" && this.outcome !== "failed";
  }
  /** Only an unpublished, unexecuted command can be withdrawn. */
  cancel(): void {
    if (this.phase !== "reserved") return;
    this.ticket.cancel();this.outcome="cancelled";this.phase="retiring";this.pollDue=true;
  }
  retireDestination(operations: GlOperationStream): boolean {
    if (operations !== this.operations || (!this.destination?.retired && operations.immediateState() !== "closed")) return false;
    if (this.phase === "retired") return true;
    if (this.phase !== "retiring") {
      if (this.started) this.ticket.finish(); else this.ticket.cancel();
      this.outcome="cancelled";this.phase="retiring";
    }
    this.pollDue=true;return true;
  }
  advance(muxers: WeakMap<WebGL2RenderingContext,GlMuxer>): void {
    if (!this.runnable) return;
    this.pollDue=false;
    if (this.phase === "accepted") {
      if (!this.ticket.start()) return;
      this.started=true;this.phase="waiting";
    }
    if (this.phase === "waiting") {
      const sourceLease=this.source,destinationLease=this.destination;
      if(!sourceLease || !destinationLease)return;
      const source=sourceLease.context,destination=destinationLease.context;
      let result: boolean | null = null;
      try {
        const sourceMuxer=muxers.get(source),destinationMuxer=destination && muxers.get(destination);
        if (!sourceMuxer || !destinationMuxer || !destination) throw new Error("Server wait execution is unavailable");
        if (source === destination) {
          destinationMuxer.captureCurrentErrors();
          result=sourceLease.enqueueNativeWait(destination,null);
        } else {
          sourceMuxer.captureCurrentErrors();
          result=sourceLease.poll(null);
        }
      } catch(error) {if(isKernelExportFailure(error))throw error;result=null;}
      if (result === false) return;
      if (result === null) {
        // No signal or native wait was proved. Later work must not cross the
        // failed ordering dependency as if it completed successfully.
        this.outcome="failed";this.operations.close();
      } else this.outcome="ordered";
      this.ticket.finish();this.phase="retiring";
    }
    if (this.phase === "retiring") {
      try {
        if(this.source){
          muxers.get(this.source.context)?.captureCurrentErrors();
          if (!this.sourceRetired) this.sourceRetired=this.source.releaseRetirement();
        }
        if(this.destination){
          if (this.destination.context) muxers.get(this.destination.context)?.captureCurrentErrors();
          if (!this.destinationRetired) this.destinationRetired=this.destination.release();
        }
      } catch(error) {if(isKernelExportFailure(error))throw error;return;}
      if (this.sourceRetired && this.destinationRetired) {
        this.source=null;this.destination=null;this.phase="retired";this.queue.completed(this,serverWaitMint);
      }
    }
  }
}

/** The queue owns accepted waits beyond the query result's Cancel/Forget.
 * The worker adapter drives bounded drains and off-turn polls, and retires
 * exact destination streams through the existing physical cleanup path. */
export class GlServerWaitQueue {
  private readonly waits=new Set<{wait:GlServerWaitCandidate|null}>();
  constructor(private readonly muxers: WeakMap<WebGL2RenderingContext,GlMuxer>,
    private readonly maxWaits=256) {
    if (!Number.isSafeInteger(maxWaits) || maxWaits<1) throw new Error("Invalid server wait budget");
  }
  prepare(source: GlFenceLease, destination: GlContextExecutionLease,
      operations: GlOperationStream): GlServerWaitCandidate | null {
    if (this.waits.size >= this.maxWaits) return null;
    // Reserve queue storage before taking ticket or lease custody. Failure
    // leaves both supplied leases with the caller's existing rollback owner.
    const slot:{wait:GlServerWaitCandidate|null}={wait:null};
    try {this.waits.add(slot);}catch{return null;}
    const candidate=GlServerWaitCandidate.prepare(this,source,destination,operations,serverWaitMint);
    if (!candidate) {this.waits.delete(slot);return null;}
    slot.wait=candidate;return candidate;
  }
  completed(candidate: GlServerWaitCandidate, authority: typeof serverWaitMint): void {
    if(authority!==serverWaitMint)throw new Error("Server wait completion requires actual retirement");
    for(const slot of this.waits)if(slot.wait===candidate){this.waits.delete(slot);return;}
  }
  get pending(): number {return this.waits.size;}
  get runnable(): boolean {for(const slot of this.waits)if(slot.wait?.runnable)return true;return false;}
  get needsPoll(): boolean {for(const slot of this.waits)if(slot.wait?.needsPoll)return true;return false;}
  pollAfterTurn(): void {for(const slot of this.waits)slot.wait?.pollAfterTurn();}
  drain(quota=32): number {
    if (!Number.isSafeInteger(quota) || quota<1) return 0;
    let count=0;
    for(const slot of this.waits){const wait=slot.wait;if(wait?.runnable){wait.advance(this.muxers);if(++count===quota)break;}}
    return count;
  }
  retireDestination(operations: GlOperationStream): boolean {
    let accepted=true;
    for(const slot of this.waits){const wait=slot.wait;if(wait?.operations===operations)accepted=wait.retireDestination(operations) && accepted;}
    return accepted;
  }
}
