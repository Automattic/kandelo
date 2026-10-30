import { isKernelExportFailure } from "../kernel-entry-gate.js";
import { GlOperationStream, type GlOperationTicket, queryOperationKind } from "./operation-stream.js";
import { GlUniformQueryCandidate } from "./uniform-query-candidate.js";
import { GlContextExecutionLease } from "./registry.js";
import type { GlErrorQueryCandidate } from "./error-query.js";
import type { GlSubmitExecution } from "./submit-execution.js";
import type { GlFenceCandidate, GlFenceLease } from "./fences.js";
import type { GlMuxer } from "./muxer.js";
import { QOP_FENCE_STATUS, QOP_RELEASE_FENCE } from "./ops.js";
import { captureNativeGlErrors } from "./errors.js";

const MAX_BYTES = 64 * 1024;
const apply = Reflect.apply;
const arrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const arrayBuffer = Object.getOwnPropertyDescriptor(arrayPrototype,"buffer")!.get!;
const arrayOffset = Object.getOwnPropertyDescriptor(arrayPrototype,"byteOffset")!.get!;
const arrayLength = Object.getOwnPropertyDescriptor(arrayPrototype,"byteLength")!.get!;
const setBytes = Uint8Array.prototype.set;
const MAX_TOKEN = 0x7fff_ffff_ffff_ffffn;
// Notifications identify a registration without carrying its object. Never
// recycle that scalar across native stores or replacement forward clients in
// one kernel realm; exact object/ledger checks still grant actual authority.
let ownerRegistrationSerial = 0;
export type GlResultLimits = Readonly<{ maxOwners: number; maxRequests: number; maxRetainedBytes: number }>;
export type GlResultMode = "commit" | "cancel";
export type GlResultPoll = { state: "unknown" | "pending" }
  | { state: "ready"; rc: number; bytes: Uint8Array }
  | { state: "retiring"; mode: GlResultMode }
  | { state: "retired"; mode: GlResultMode; accepted: boolean };

/** Only explicit kernel-owner registration grants a new generation. Controls
 * received later cannot create one. Copied identity and the exact session ledger
 * are immutable; numeric ids alone do not grant authority. */
export class GlResultOwner {
  constructor(readonly registration: number, readonly pid: number, readonly sessionId: number, readonly operations: GlOperationStream) { Object.freeze(this); }
}

const claimedExecutions = new WeakSet<GlSubmitExecution>();
const claimedCandidates = new WeakSet<GlFenceCandidate>();
const claimedErrorCandidates = new WeakSet<GlErrorQueryCandidate>();
const claimedUniformCandidates = new WeakSet<GlUniformQueryCandidate>();
type NativeRetirementResult = { complete: boolean; publicationAccepted: boolean };
/** Fixed typed custody, never an arbitrary cleanup/execute closure. Other
 * mutating query candidates require their own typed publication model before
 * they can be deferred; this class covers execution, fences, error consumption
 * and prepared uniform-location publication. */
export class GlNativeResultCustody {
  private muxer: WeakRef<GlMuxer>;
  private mode: GlResultMode | null = null;
  private publicationAttempted = false;
  private errorCandidate: GlErrorQueryCandidate | null = null;
  private uniformCandidate: GlUniformQueryCandidate | null = null;
  private publicationAccepted: boolean;
  private claimed = false;
  private pid: number | null;
  private sessionId: number | null;
  private operations: GlOperationStream | null;
  constructor(private execution: GlSubmitExecution | null,
    private candidate: GlFenceCandidate | null, muxer: GlMuxer) {
    if ((execution && execution.context !== muxer.context) || (candidate && candidate.context !== muxer.context))
      throw new Error("GL result custody renderer mismatch");
    if ((execution && claimedExecutions.has(execution)) || (candidate && claimedCandidates.has(candidate)))
      throw new Error("GL native result capability already transferred");
    this.muxer = new WeakRef(muxer); this.publicationAccepted = candidate === null;
    this.pid = execution?.binding.pid ?? null; this.sessionId = execution?.binding.sessionId ?? null;
    this.operations = execution?.binding.operations ?? null;
    try {
      if (execution) claimedExecutions.add(execution);
      if (candidate) claimedCandidates.add(candidate);
    } catch (error) {
      if (execution) claimedExecutions.delete(execution);
      if (candidate) claimedCandidates.delete(candidate);
      throw error;
    }
  }
  matches(owner: GlResultOwner): boolean {
    return this.pid === owner.pid && this.sessionId === owner.sessionId && this.operations === owner.operations;
  }
  claim(): boolean { if (this.claimed) return false; this.claimed = true; return true; }
  adoptCandidate(candidate: GlFenceCandidate): boolean {
    if (this.mode || this.candidate || this.errorCandidate || this.uniformCandidate || this.publicationAttempted || claimedCandidates.has(candidate)
      || candidate.context !== this.execution?.context) return false;
    claimedCandidates.add(candidate); this.candidate = candidate; this.publicationAccepted = false;
    return true;
  }
  adoptErrorCandidate(candidate: GlErrorQueryCandidate): boolean {
    if (this.mode || this.candidate || this.errorCandidate || this.uniformCandidate || this.publicationAttempted
      || !this.execution || !candidate.owns(this.execution.binding.errors) || claimedErrorCandidates.has(candidate)) return false;
    claimedErrorCandidates.add(candidate);
    this.errorCandidate = candidate; this.publicationAccepted = false; return true;
  }
  adoptUniformCandidate(candidate: GlUniformQueryCandidate, source: GlContextExecutionLease): boolean {
    if (!(candidate instanceof GlUniformQueryCandidate) || !(source instanceof GlContextExecutionLease)
      || this.mode || this.candidate || this.errorCandidate || this.uniformCandidate || this.publicationAttempted
      || !this.execution || source.context !== this.execution.context || source.binding !== this.execution.binding
      || !candidate.awaitingPublication || !candidate.matchesExecution(source) || claimedUniformCandidates.has(candidate)) return false;
    claimedUniformCandidates.add(candidate);
    this.uniformCandidate = candidate; this.publicationAccepted = false; return true;
  }
  retire(mode: GlResultMode, publicationAllowed = true): NativeRetirementResult {
    if (this.mode && this.mode !== mode) return { complete:false,publicationAccepted:this.publicationAccepted };
    this.mode = mode;
    try {
      const gl = this.candidate?.context ?? this.execution?.context;
      const selected = this.muxer.deref();
      if (selected) selected.captureCurrentErrors();
      else if (gl) captureNativeGlErrors(gl,null);
      if (this.uniformCandidate) {
        if (mode === "commit" && !this.publicationAttempted) {
          this.publicationAttempted = true;
          this.publicationAccepted = publicationAllowed && this.uniformCandidate.publish();
        }
        // A denied Commit still needs a terminal decision before retirement.
        // Never leave an unpublished owner perpetually awaiting publication.
        if (mode === "cancel" || !this.publicationAccepted) this.uniformCandidate.cancel();
        if (!this.uniformCandidate.retire()) return {complete:false,publicationAccepted:this.publicationAccepted};
        this.uniformCandidate = null;
      }
      if (this.errorCandidate) {
        if (mode === "commit" && !this.publicationAttempted) {
          this.publicationAttempted = true;
          this.publicationAccepted = this.errorCandidate.publish();
        } else if (mode === "cancel") this.errorCandidate.cancel();
        this.errorCandidate = null;
      }
      if (this.candidate) {
        if (mode === "commit" && !this.publicationAttempted) {
          // Publication is a one-way transfer to the public fence owner. A
          // later execution-cleanup failure must never publish it a second time.
          this.publicationAttempted = true;
          this.publicationAccepted = publicationAllowed && this.candidate.publish();
        }
        if (this.publicationAccepted) this.candidate = null;
        else if (!this.candidate.cancelRetirement()) return {complete:false,publicationAccepted:false};
        else this.candidate = null;
      }
      if (this.execution && !this.execution.release()) return {complete:false,publicationAccepted:this.publicationAccepted};
      this.execution = null;
      return {complete:true,publicationAccepted:this.publicationAccepted};
    } catch (error) {
      if (isKernelExportFailure(error)) throw error;
      return {complete:false,publicationAccepted:this.publicationAccepted};
    }
  }
}

const claimedFenceLeases = new WeakSet<GlFenceLease>();
/** A status/release source outlives current context/display selection. This
 * custody owns only its actual native lease, immutable source and weak muxer. */
export class GlFenceResultCustody {
  private muxer: WeakRef<GlMuxer>;
  private mode: GlResultMode | null = null;
  private claimed = false;
  private publicationAttempted = false;
  private publicationAccepted = false;
  constructor(private owner: GlResultOwner, private lease: GlFenceLease,
    private kind: "status" | "release", muxer: GlMuxer) {
    if (!lease.matchesSource(owner)) throw new Error("GL fence result source mismatch or stale lease");
    if (lease.context !== muxer.context) throw new Error("GL fence result renderer mismatch");
    if (claimedFenceLeases.has(lease)) throw new Error("GL fence result lease already transferred");
    if (kind !== "status" && kind !== "release") throw new Error("invalid GL fence result kind");
    this.muxer = new WeakRef(muxer); claimedFenceLeases.add(lease);
  }
  matches(owner: GlResultOwner): boolean { return this.owner === owner && this.lease.matchesSource(owner); }
  matchesRequest(op: number, input: Uint8Array, capacity: number): boolean {
    return op === (this.kind === "status" ? QOP_FENCE_STATUS : QOP_RELEASE_FENCE)
      && input.byteLength === 4 && capacity === 16
      && new DataView(input.buffer,input.byteOffset,4).getUint32(0,true) === this.lease.token;
  }
  claim(): boolean { if (this.claimed) return false; this.claimed = true; return true; }
  private captureErrors(): void {
    const muxer = this.muxer.deref();
    if (muxer) muxer.captureCurrentErrors(); else captureNativeGlErrors(this.lease.context,null);
  }
  poll(): boolean | null {
    if (!this.claimed || this.kind !== "status" || this.mode) return null;
    try { this.captureErrors(); return this.lease.poll(null); } catch { return null; }
  }
  retire(mode: GlResultMode): NativeRetirementResult {
    if (this.mode && this.mode !== mode) return {complete:false,publicationAccepted:this.publicationAccepted};
    this.mode = mode;
    try {
      this.captureErrors();
      if (!this.publicationAttempted) {
        this.publicationAttempted = true;
        // EFAULT/Cancel must not destroy a published fence. Source authority,
        // not a later current-context lookup, owns this captured release.
        this.publicationAccepted = mode === "cancel" || this.kind === "status" || this.lease.publishRelease();
      }
      return {complete:this.lease.releaseRetirement(),publicationAccepted:this.publicationAccepted};
    } catch { return {complete:false,publicationAccepted:this.publicationAccepted}; }
  }
}

/** The transport adapter owns the realm/port outside this record. Only its
 * exact capability may acknowledge remote native retirement; ids are not enough. */
export class GlResultPeer {
  constructor(readonly registration: number) {
    if (!Number.isSafeInteger(registration) || registration < 1) throw new RangeError("invalid GL result peer");
    Object.freeze(this);
  }
}
export class GlRemoteResultCustody {
  private acknowledged: {mode:GlResultMode;accepted:boolean} | null = null;
  private requested: GlResultMode | null = null;
  private claimed = false;
  private attempted = true;
  private revokedUnsent = false;
  constructor(private authority: GlResultPeer, private owner: GlResultOwner, private token: bigint) {}
  /** Copied transport intent has no native authority before its first post.
   * Mark before postMessage, including a call which might throw after enqueue. */
  static unposted(authority: GlResultPeer, owner: GlResultOwner, token: bigint): GlRemoteResultCustody {
    const custody = new GlRemoteResultCustody(authority,owner,token);
    custody.attempted = false; return custody;
  }
  markSendAttempt(authority: GlResultPeer, owner: GlResultOwner, token: bigint): boolean {
    if (!this.accepts(authority,owner,token) || this.revokedUnsent || this.requested) return false;
    this.attempted = true; return true;
  }
  claim(): boolean { if (this.claimed) return false; this.claimed = true; return true; }
  matches(owner: GlResultOwner, token: bigint): boolean { return owner === this.owner && token === this.token; }
  accepts(authority: GlResultPeer, owner: GlResultOwner, token: bigint): boolean {
    return authority === this.authority && this.matches(owner,token);
  }
  request(mode: GlResultMode): void {
    this.requested ??= mode;
    if (this.requested === "cancel" && !this.attempted) this.revokedUnsent = true;
  }
  acknowledge(authority: GlResultPeer, owner: GlResultOwner, token: bigint, mode: GlResultMode, accepted: boolean): boolean {
    if (!this.accepts(authority,owner,token) || this.requested !== mode || typeof accepted !== "boolean"
      || (mode === "cancel" && !accepted) || (this.acknowledged &&
      (this.acknowledged.mode !== mode || this.acknowledged.accepted !== accepted))) return false;
    this.acknowledged = {mode,accepted}; return true;
  }
  complete(mode: GlResultMode): boolean { return (mode === "cancel" && this.revokedUnsent) || this.acknowledged?.mode === mode; }
  get accepted(): boolean { return this.revokedUnsent || (this.acknowledged?.accepted ?? false); }
}

type RecordState = "queued" | "running" | "ready" | "retiring" | "retired";
type ResultRecord = {
  owner: GlResultOwner; token: bigint; op: number; capacity: number; charge: number;
  input: Uint8Array | null; workspace: Uint8Array | null; result: Uint8Array | null;
  order: GlOperationTicket | null; orderStarted: boolean;
  accepted: boolean;
  state: RecordState; mode: GlResultMode | null; rc: number;
  execution: GlResultExecution | null; executing: boolean;
  custody: GlNativeResultCustody | GlFenceResultCustody | GlRemoteResultCustody | null;
};
type OwnerRecord = { owner: GlResultOwner; closed: boolean; highWater: bigint; requests: Map<bigint,ResultRecord> };

/** This capability grants one native execution, not a new admission. Views
 * refer only to bounded independent host bytes; getters revoke on cancellation.
 * A cancelled running operation must still report its eventual quiescence. */
export class GlResultExecution {
  constructor(private store: GlOwnedResultStore | null, private record: ResultRecord | null) {}
  get input(): Uint8Array { if (!this.record || this.record.state !== "running") throw new Error("GL result execution is revoked"); return this.record.input!; }
  get output(): Uint8Array { if (!this.record || this.record.state !== "running") throw new Error("GL result execution is revoked"); return this.record.workspace!; }
  get op(): number { if (!this.record) throw new Error("GL result execution is revoked"); return this.record.op; }
  complete(rc: number): boolean { return !!this.record && !!this.store && this.store.complete(this,this.record,rc); }
  releaseRecord(record: ResultRecord): void { if (this.record === record) { this.record = null; this.store = null; } }
}

/** Internal shared native/forwarded receipt foundation. No pending production
 * branch uses it yet. Limits count active owner registrations, request records
 * (including scalar terminal ACK tombstones until Forget), and retained copied
 * bytes (input + output workspace + saved result capacity).
 * No Wasm/SharedArrayBuffer memory ceiling or callback is retained here. */
export class GlOwnedResultStore {
  private owners = new Map<number,OwnerRecord>();
  private count = 0;
  private bytes = 0;
  private limits: GlResultLimits;
  constructor(limits: GlResultLimits) {
    for (const value of [limits.maxOwners,limits.maxRequests,limits.maxRetainedBytes])
      if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("invalid GL result budget");
    this.limits = Object.freeze({maxOwners:limits.maxOwners,maxRequests:limits.maxRequests,maxRetainedBytes:limits.maxRetainedBytes});
  }
  openOwner(pid: number, sessionId: number, operations: GlOperationStream): GlResultOwner | null {
    for (const entry of this.owners.values()) if (entry.owner.pid === pid && entry.owner.sessionId === sessionId)
      return entry.closed || entry.owner.operations !== operations ? null : entry.owner;
    if (!(operations instanceof GlOperationStream) || !Number.isInteger(pid) || pid < 1 || pid > 0x7fff_ffff || !Number.isInteger(sessionId)
      || sessionId < 1 || sessionId > 0xffff_ffff || this.owners.size >= this.limits.maxOwners
      || ownerRegistrationSerial === Number.MAX_SAFE_INTEGER) return null;
    try {
      const owner = new GlResultOwner(++ownerRegistrationSerial,pid,sessionId,operations);
      this.owners.set(owner.registration,{owner,closed:false,highWater:0n,requests:new Map()});
      return owner;
    } catch { return null; }
  }
  private owner(owner: GlResultOwner): OwnerRecord | undefined {
    const entry = this.owners.get(owner.registration);
    return entry?.owner === owner ? entry : undefined;
  }
  private record(owner: GlResultOwner, token: bigint): ResultRecord | undefined {
    return this.owner(owner)?.requests.get(token);
  }
  /** A Begin retry proves the exact admitted first bytes. The existing charged
   * copy is the authority; do not retain another payload or revive bytes after
   * physical retirement. Getters and views are checked with captured intrinsics
   * so a detached or forged caller view cannot authenticate a replacement. */
  matchesRequest(owner: GlResultOwner, token: bigint, op: number, input: Uint8Array, capacity: number): boolean {
    const record=this.record(owner,token), retained=record?.input;
    if (!record || !retained || record.op!==op || record.capacity!==capacity) return false;
    try {
      const size=apply(arrayLength,input,[]) as number;
      if (size!==retained.byteLength) return false;
      const source=new Uint8Array(apply(arrayBuffer,input,[]) as ArrayBufferLike,
        apply(arrayOffset,input,[]) as number,size);
      for(let index=0;index<size;index++)if(source[index]!==retained[index])return false;
      return true;
    } catch { return false; }
  }
  /** Custody is captured before admission, so queued work cannot select a
   * later context/drawable. Explicit null is for copied-byte-only operations;
   * rejection leaves any supplied native/remote custody with the caller. */
  begin(owner: GlResultOwner, token: bigint, op: number, input: Uint8Array, capacity: number,
    custody: GlNativeResultCustody | GlFenceResultCustody | GlRemoteResultCustody | null): "admitted" | "existing" | "rejected" {
    const entry = this.owner(owner);
    if (!entry || entry.closed || typeof token !== "bigint" || token < 1n || token > MAX_TOKEN) return "rejected";
    // Retry can observe an existing receipt, but can never replace its input,
    // result capacity or operation using a changed request header.
    const existing = entry.requests.get(token);
    if (existing) return this.matchesRequest(owner,token,op,input,capacity)
      && (custody === null || custody === existing.custody) ? "existing" : "rejected";
    if (custody === undefined || (custody instanceof GlRemoteResultCustody ? !custody.matches(owner,token)
      : custody !== null && !custody.matches(owner))) return "rejected";
    if (token <= entry.highWater || !Number.isInteger(op) || op < 0 || op > 0xffff_ffff
      || !Number.isSafeInteger(capacity) || capacity < 0 || capacity > MAX_BYTES) return "rejected";
    let inputLength: number;
    try { inputLength = apply(arrayLength,input,[]) as number; } catch { return "rejected"; }
    if (inputLength > MAX_BYTES || !Number.isSafeInteger(inputLength)) return "rejected";
    const charge = inputLength + 2 * capacity;
    if (!Number.isSafeInteger(charge) || this.count >= this.limits.maxRequests
      || charge > this.limits.maxRetainedBytes - this.bytes) return "rejected";
    let order: GlOperationTicket | null = null;
    try {
      const copied = new Uint8Array(inputLength);
      const source = new Uint8Array(apply(arrayBuffer,input,[]) as ArrayBufferLike,
        apply(arrayOffset,input,[]) as number,inputLength);
      apply(setBytes,copied,[source]);
      if (custody instanceof GlFenceResultCustody && !custody.matchesRequest(op,copied,capacity)) return "rejected";
      const workspace = new Uint8Array(capacity), result = new Uint8Array(capacity);
      order = owner.operations.reserve(queryOperationKind(op));
      if (!order) return "rejected";
      const record: ResultRecord = {owner,token,op,capacity,charge,input:copied,
        workspace,result,order,orderStarted:false,accepted:false,
        state:"queued",mode:null,rc:0,execution:null,executing:false,custody};
      entry.requests.set(token,record);
      if (custody && !custody.claim()) { entry.requests.delete(token); order.cancel(); return "rejected"; }
      entry.highWater = token;
      this.count++; this.bytes += charge;
      return "admitted";
    } catch { entry.requests.delete(token); order?.cancel(); return "rejected"; }
  }
  /** Scalar readiness only; this neither starts work nor captures replacement state. */
  canTake(owner: GlResultOwner, token: bigint): boolean {
    const record=this.record(owner,token);
    return record?.state==="queued" && record.order?.ready===true;
  }
  take(owner: GlResultOwner, token: bigint): GlResultExecution | null {
    const record = this.record(owner,token);
    if (!record || record.state !== "queued") return null;
    try {
      const execution = new GlResultExecution(this,record);
      if (!record.order!.start()) return null;
      record.orderStarted = true;
      record.execution = execution; record.executing = true; record.state = "running";
      return execution;
    } catch { return null; }
  }
  complete(execution: GlResultExecution, record: ResultRecord, rc: number): boolean {
    if (this.record(record.owner,record.token) !== record || record.execution !== execution || !record.executing) return false;
    record.executing = false;
    if (record.state === "retiring") return false;
    if (record.state !== "running") return false;
    record.rc = Number.isSafeInteger(rc) && rc >= -0x8000_0000 && rc <= record.capacity ? rc : -5;
    try {
      if (record.rc > 0) {
        const source = new Uint8Array(apply(arrayBuffer,record.workspace,[]) as ArrayBufferLike,
          apply(arrayOffset,record.workspace,[]) as number,record.rc);
        apply(setBytes,record.result,[source]);
      }
    } catch { record.rc = -5; }
    record.state = "ready";
    return true;
  }
  completeRemote(authority: GlResultPeer, owner: GlResultOwner, token: bigint, rc: number, bytes: Uint8Array): boolean {
    const record = this.record(owner,token);
    if (!record || !record.execution || !(record.custody instanceof GlRemoteResultCustody)
      || !record.custody.accepts(authority,owner,token) || !record.executing) return false;
    if (record.state === "retiring") return record.execution.complete(rc);
    let size = -1;
    try { size = apply(arrayLength,bytes,[]) as number; } catch { /* failed transport result */ }
    if (!Number.isSafeInteger(rc) || rc < -0x8000_0000 || rc > record.capacity
      || size < Math.max(0,rc) || size > record.capacity) return record.execution.complete(-5);
    if (rc > 0) {
      const source = new Uint8Array(apply(arrayBuffer,bytes,[]) as ArrayBufferLike,
        apply(arrayOffset,bytes,[]) as number,rc);
      apply(setBytes,record.workspace,[source]);
    }
    return record.execution.complete(rc);
  }
  poll(owner: GlResultOwner, token: bigint): GlResultPoll {
    const record = this.record(owner,token);
    if (!record) return {state:"unknown"};
    if (record.state === "retiring") return {state:"retiring",mode:record.mode!};
    if (record.state === "retired") return {state:"retired",mode:record.mode!,accepted:record.accepted};
    if (record.state !== "ready") return {state:"pending"};
    return {state:"ready",rc:record.rc,bytes:record.result!.slice(0,Math.max(0,record.rc))};
  }
  private retire(owner: GlResultOwner, token: bigint, mode: GlResultMode): boolean {
    const record = this.record(owner,token);
    if (!record) return false;
    if (record.state === "retiring" || record.state === "retired") return record.mode === mode;
    if (mode === "commit" && (record.state !== "ready" || record.rc < 0)) return false;
    record.mode = mode; record.state = "retiring";
    if (record.custody instanceof GlRemoteResultCustody) record.custody.request(mode);
    return true;
  }
  commit(owner: GlResultOwner, token: bigint): boolean { return this.retire(owner,token,"commit"); }
  cancel(owner: GlResultOwner, token: bigint): boolean { return this.retire(owner,token,"cancel"); }
  retireOwner(owner: GlResultOwner): boolean {
    const entry = this.owner(owner); if (!entry) return false;
    entry.closed = true;
    for (const record of entry.requests.values()) if (record.state !== "retiring" && record.state !== "retired") this.cancel(owner,record.token);
    if (!entry.requests.size) this.owners.delete(owner.registration);
    return true;
  }
  acknowledgeRetired(owner: GlResultOwner, token: bigint): {state:"unknown" | "pending"}
    | {state:"retired";mode:GlResultMode;accepted:boolean} {
    const record = this.record(owner,token), entry = this.owner(owner);
    if (!record || !entry) return {state:"unknown"};
    if (record.state === "retired") return {state:"retired",mode:record.mode!,accepted:record.accepted};
    if (record.state !== "retiring" || record.executing) return {state:"pending"};
    let accepted = true;
    if (record.custody instanceof GlRemoteResultCustody) {
      if (!record.custody.complete(record.mode!)) return {state:"pending"};
      accepted = record.custody.accepted;
    } else if (record.custody) {
      const retirement = record.custody instanceof GlNativeResultCustody
        ? record.custody.retire(record.mode!,!entry.closed) : record.custody.retire(record.mode!);
      if (!retirement.complete) return {state:"pending"};
      accepted = record.mode === "cancel" || retirement.publicationAccepted;
    }
    // A stale execution capability must not retain the input/work/result
    // buffers after the owning receipt has acknowledged retirement.
    record.execution?.releaseRecord(record); record.execution = null;
    if (record.orderStarted) record.order!.finish(); else record.order!.cancel();
    this.bytes -= record.charge; record.charge = 0;
    record.input = null; record.workspace = null; record.result = null;
    record.order = null; record.custody = null;
    record.accepted = accepted; record.state = "retired";
    // A lost response must still be retryable. Keep scalar identity/ACK charged
    // against the record budget until the kernel explicitly observes and forgets it.
    return {state:"retired",mode:record.mode!,accepted};
  }
  forget(owner: GlResultOwner, token: bigint): boolean {
    const entry = this.owner(owner), record = entry?.requests.get(token);
    if (!entry || record?.state !== "retired") return false;
    entry.requests.delete(token); this.count--;
    if (entry.closed && !entry.requests.size) this.owners.delete(owner.registration);
    return true;
  }
  /** Owner teardown may release proven-clean scalar metadata, never actual
   * unresolved native/transport custody. Unknown is never a cleanup ACK. */
  forgetOwner(owner: GlResultOwner): boolean {
    const entry = this.owner(owner);
    if (!entry || !entry.closed) return false;
    for (const record of entry.requests.values()) if (record.state !== "retired") return false;
    this.count -= entry.requests.size;
    this.owners.delete(owner.registration);
    return true;
  }
  get retainedBytes(): number { return this.bytes; }
  get pendingRequests(): number { return this.count; }
}
