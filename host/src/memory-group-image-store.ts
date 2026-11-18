import * as G from './generated/program-extensions';
import { MemoryGroupPagePool, type GroupPageExtent } from './memory-group-pool';
import { MemoryGroupProtocolFault, memoryGroupU32, type MemoryGroupTaskReceipt } from './memory-group-protocol';
import { GroupProcessAddressSpace, ProcessAddressFault } from './process-address-space';
import { encodeProcessMemoryDescriptor, type GroupReplicaMemoryExpectation,
  type ProcessMemoryEnvelope } from './process-memory-descriptor';
import { tryControlMemoryGroupReplicaWait } from './memory-group-notification';

const PAGE = G.MEMORY_GROUP_PAGE_BYTES;
declare const preparedReplica: unique symbol;
/** Kernel-realm capability, never serialized. Numeric receipts alone cannot
 * retrieve, publish or cancel an allocation in this owner. */
export interface PreparedGroupReplica { readonly [preparedReplica]: true }
declare const executionPause: unique symbol;
/** A reversible guest-execution barrier, never a terminal retirement fence. */
export interface GroupExecutionPause { readonly [executionPause]: true }
declare const imageExecutionPause: unique symbol;
/** Every execution replica of one image, not a terminal retirement fence. */
export interface GroupImageExecutionPause { readonly [imageExecutionPause]: true }
export interface GroupImageLayout {
  readonly initialVirtualPages: number;
  readonly maximumVirtualPages: number;
  readonly scratchBytes: number;
}
export interface GroupReplicaLaunch {
  readonly envelope: ProcessMemoryEnvelope;
  readonly source: GroupProcessAddressSpace;
  readonly expectation: GroupReplicaMemoryExpectation;
}
interface Image {
  readonly receipt: MemoryGroupTaskReceipt;
  readonly root: number;
  readonly layout: GroupImageLayout;
  readonly controls: GroupPageExtent;
  readonly payload?: GroupPageExtent;
  readonly replicas: Set<Replica>;
  /** Kernel image access outlives any one execution replica. */
  readonly sourceLive: { value: boolean };
  readonly nativeObservations: Set<object>;
  source?: GroupProcessAddressSpace;
  exposed: boolean;
  pause?: ImagePause;
}
interface Replica {
  readonly handle: PreparedGroupReplica;
  readonly receipt: MemoryGroupTaskReceipt;
  readonly image: Image;
  readonly scratch: GroupPageExtent;
  readonly live: { value: boolean };
  state: 'prepared' | 'exposed' | 'quarantined' | 'cancelled';
  source?: GroupProcessAddressSpace;
  pause?: Pause;
  pendingWaitDrain: boolean;
}
interface Pause { replica?: Replica; readonly epoch: number }
interface ImagePause {
  image?: Image;
  members: { readonly replica: Replica; pause?: GroupExecutionPause }[];
}
function fault(message: string): never { throw new MemoryGroupProtocolFault(message); }
function pages(extent: GroupPageExtent | undefined): number[] {
  return extent ? Array.from({ length: extent.pages }, (_, i) => extent.first + i) : [];
}
function imageKey(receipt: MemoryGroupTaskReceipt): string { return `${receipt.pid}:${receipt.generation}`; }
function exact(a: MemoryGroupTaskReceipt, b: MemoryGroupTaskReceipt): boolean {
  return a.group === b.group && a.pid === b.pid && a.tid === b.tid
    && a.serial === b.serial && a.generation === b.generation;
}

/** Owned only by a disposable kernel Worker, after Rust reserves the group's
 * physical capacity. Admission is the caller's kernel operation, not this
 * allocator. Post-publication retirement is deliberately unavailable here:
 * no Worker fence or wait retirement can be inferred from a local token.
 */
export class MemoryGroupImageStore {
  private readonly memory: WebAssembly.Memory;
  private readonly pool: MemoryGroupPagePool;
  private readonly images = new Map<string, Image>();
  private readonly replicas = new Map<bigint, Replica>();
  private readonly handles = new WeakMap<PreparedGroupReplica, Replica>();
  private readonly pauses = new WeakMap<GroupExecutionPause, Pause>();
  private readonly imagePauses = new WeakMap<GroupImageExecutionPause, ImagePause>();
  private nextPauseEpoch = 1;
  private closed = false;

  constructor(readonly group: number, readonly maximumPhysicalPages: number, initialPhysicalPages = 1) {
    if (!memoryGroupU32(group, maximumPhysicalPages, initialPhysicalPages) || !group || group > 0x7fffffff
        || maximumPhysicalPages < 2 || maximumPhysicalPages > G.MEMORY_GROUP_MAXIMUM_PAGES
        || initialPhysicalPages < 1 || initialPhysicalPages > maximumPhysicalPages) {
      fault('Group storage exceeds its admitted versioned limits');
    }
    // The ceiling is the capacity already reserved by Rust, never an enlarged
    // fallback after construction/growth refusal. Fixed extent is explicit.
    this.memory = new WebAssembly.Memory({ initial: initialPhysicalPages, maximum: maximumPhysicalPages, shared: true });
    this.pool = MemoryGroupPagePool.initialize(this.memory, maximumPhysicalPages);
  }

  private check(receipt: MemoryGroupTaskReceipt): MemoryGroupTaskReceipt {
    if (this.closed) fault('Group image owner is closed');
    if (!memoryGroupU32(receipt.group, receipt.pid, receipt.tid) || receipt.group !== this.group
        || receipt.pid <= 1 || receipt.tid <= 1 || typeof receipt.serial !== 'bigint'
        || receipt.serial <= 0n || receipt.serial > 0xffffffffffffffffn
        || typeof receipt.generation !== 'bigint' || receipt.generation < 0n
        || receipt.generation > 0xffffffffffffffffn || this.replicas.has(receipt.serial)) {
      fault('Replica does not name a new exact admitted task');
    }
    return Object.freeze({ group: receipt.group, pid: receipt.pid, tid: receipt.tid,
      serial: receipt.serial, generation: receipt.generation });
  }
  private allocate(count: number, transaction: GroupPageExtent[]): GroupPageExtent {
    const extent = this.pool.allocateContiguous(count);
    if (!extent) throw new RangeError('Admitted group physical storage is exhausted');
    transaction.push(extent); return extent;
  }
  private replica(receipt: MemoryGroupTaskReceipt, image: Image, scratch: GroupPageExtent): PreparedGroupReplica {
    const control = new DataView(this.memory.buffer, scratch.first * PAGE, G.MEMORY_GROUP_REPLICA_BYTES);
    control.setUint32(G.MEMORY_GROUP_REPLICA_RUN, 1, true);
    control.setUint32(G.MEMORY_GROUP_REPLICA_ROOT, image.root, true);
    control.setUint32(G.MEMORY_GROUP_REPLICA_MAGIC_OFFSET, G.MEMORY_GROUP_REPLICA_MAGIC, true);
    control.setBigUint64(G.MEMORY_GROUP_REPLICA_SERIAL, receipt.serial, true);
    control.setBigUint64(G.MEMORY_GROUP_REPLICA_GENERATION, receipt.generation, true);
    control.setUint32(G.MEMORY_GROUP_REPLICA_PID, receipt.pid, true);
    control.setUint32(G.MEMORY_GROUP_REPLICA_TID, receipt.tid, true);
    control.setUint32(G.MEMORY_GROUP_REPLICA_GROUP, receipt.group, true);
    const handle = Object.freeze(Object.create(null)) as PreparedGroupReplica;
    const replica: Replica = { handle, receipt, image, scratch, live: { value: true }, state: 'prepared', pendingWaitDrain: false };
    this.handles.set(handle, replica); this.replicas.set(receipt.serial, replica); image.replicas.add(replica);
    return handle;
  }

  prepareImage(admission: MemoryGroupTaskReceipt, requested: GroupImageLayout): PreparedGroupReplica {
    const receipt = this.check(admission);
    const layout = Object.freeze({ initialVirtualPages: requested.initialVirtualPages,
      maximumVirtualPages: requested.maximumVirtualPages, scratchBytes: requested.scratchBytes });
    if (receipt.tid !== receipt.pid || this.images.has(imageKey(receipt))
        || !memoryGroupU32(layout.initialVirtualPages, layout.maximumVirtualPages, layout.scratchBytes)
        || layout.maximumVirtualPages < 1 || layout.maximumVirtualPages > 65536
        || layout.initialVirtualPages > layout.maximumVirtualPages
        || layout.scratchBytes < PAGE || layout.scratchBytes % PAGE
        || layout.scratchBytes / PAGE >= this.maximumPhysicalPages) {
      fault('Invalid or duplicate grouped image allocation');
    }
    const allocated: GroupPageExtent[] = [];
    try {
      const controls = this.allocate(Math.ceil((G.MEMORY_GROUP_ROOT_HEADER_BYTES + layout.maximumVirtualPages * 4) / PAGE), allocated);
      const scratch = this.allocate(Math.ceil((G.MEMORY_GROUP_REPLICA_BYTES + layout.scratchBytes) / PAGE), allocated);
      const payload = layout.initialVirtualPages ? this.allocate(layout.initialVirtualPages, allocated) : undefined;
      const root = controls.first * PAGE;
      const header = new Uint32Array(this.memory.buffer, root, G.MEMORY_GROUP_ROOT_HEADER_BYTES / 4);
      header[1] = layout.maximumVirtualPages; header[2] = layout.scratchBytes;
      header[G.MEMORY_GROUP_ROOT_RUN / 4] = 1;
      if (payload) {
        const ptes = new Uint32Array(this.memory.buffer, root + G.MEMORY_GROUP_ROOT_HEADER_BYTES, layout.maximumVirtualPages);
        for (let i = 0; i < payload.pages; i++) ptes[i] = (payload.first + i) * PAGE | 3;
      }
      Atomics.store(header, 0, layout.initialVirtualPages);
      const image: Image = { receipt, root, layout, controls, payload, replicas: new Set(),
        sourceLive: { value: true }, nativeObservations: new Set(), exposed: false };
      this.images.set(imageKey(receipt), image);
      return this.replica(receipt, image, scratch);
    } catch (error) {
      // No backing, view, source or descriptor has left this owner yet.
      this.pool.releaseRetiredPages(allocated.flatMap(pages)); throw error;
    }
  }

  prepareThread(admission: MemoryGroupTaskReceipt): PreparedGroupReplica {
    const receipt = this.check(admission), image = this.images.get(imageKey(receipt));
    if (!image || !image.sourceLive.value || receipt.tid === receipt.pid || image.receipt.group !== receipt.group) {
      fault('Thread has no exact owned image root');
    }
    if (image.pause) fault('Image execution barrier forbids new replica preparation');
    const allocated: GroupPageExtent[] = [];
    try { return this.replica(receipt, image,
      this.allocate(Math.ceil((G.MEMORY_GROUP_REPLICA_BYTES + image.layout.scratchBytes) / PAGE), allocated)); }
    catch (error) { this.pool.releaseRetiredPages(allocated.flatMap(pages)); throw error; }
  }

  private owned(handle: PreparedGroupReplica): Replica {
    const replica = this.handles.get(handle);
    if (!replica || replica.state === 'cancelled') fault('Unknown or cancelled group replica owner');
    return replica;
  }
  receipt(handle: PreparedGroupReplica): MemoryGroupTaskReceipt { return this.owned(handle).receipt; }
  isUnexposed(handle: PreparedGroupReplica): boolean { return this.owned(handle).state === 'prepared'; }

  private controls(replica: Replica): Int32Array {
    const control = new DataView(this.memory.buffer, replica.scratch.first * PAGE, G.MEMORY_GROUP_REPLICA_BYTES);
    const receipt = replica.receipt;
    if (control.getUint32(G.MEMORY_GROUP_REPLICA_MAGIC_OFFSET, true) !== G.MEMORY_GROUP_REPLICA_MAGIC
        || control.getUint32(G.MEMORY_GROUP_REPLICA_ROOT, true) !== replica.image.root
        || control.getBigUint64(G.MEMORY_GROUP_REPLICA_SERIAL, true) !== receipt.serial
        || control.getBigUint64(G.MEMORY_GROUP_REPLICA_GENERATION, true) !== receipt.generation
        || control.getUint32(G.MEMORY_GROUP_REPLICA_PID, true) !== receipt.pid
        || control.getUint32(G.MEMORY_GROUP_REPLICA_TID, true) !== receipt.tid
        || control.getUint32(G.MEMORY_GROUP_REPLICA_GROUP, true) !== receipt.group) {
      fault('Replica no longer owns its exact physical controls');
    }
    return new Int32Array(this.memory.buffer, replica.scratch.first * PAGE, G.MEMORY_GROUP_REPLICA_BYTES / 4);
  }
  beginExecutionPause(handle: PreparedGroupReplica): GroupExecutionPause {
    const replica = this.owned(handle);
    if (replica.image.pause) fault('Image execution barrier already owns this replica');
    return this.startExecutionPause(replica);
  }
  private startExecutionPause(replica: Replica): GroupExecutionPause {
    if (this.closed || replica.state !== 'exposed' || replica.pause || this.nextPauseEpoch > 0xffffffff) {
      fault('Replica cannot begin a new execution barrier');
    }
    const control = this.controls(replica);
    if (Atomics.load(control, G.MEMORY_GROUP_REPLICA_RUN / 4) !== 1) fault('Replica is already stopping');
    const pause: Pause = { replica, epoch: this.nextPauseEpoch++ };
    const token = Object.freeze(Object.create(null)) as GroupExecutionPause;
    this.pauses.set(token, pause); replica.pause = pause;
    Atomics.store(control, G.MEMORY_GROUP_REPLICA_REQUEST / 4, pause.epoch);
    // A source checkpoint will acknowledge, or the queue lock proves the
    // weaker pinned-wait barrier. Busy queue inspection is retried by owner.
    this.executionPauseAcknowledged(token);
    return token;
  }

  /** Freeze membership before requesting every replica's cooperative barrier.
   * Mapping publication must wait for all acknowledgments and independently
   * revalidate its Rust metadata/source. Parked waits remain physically pinned;
   * this barrier never authorizes releasing their pages or recycling storage.
   */
  beginImageExecutionPause(handle: PreparedGroupReplica): GroupImageExecutionPause {
    const image = this.owned(handle).image;
    if (this.closed || !image.exposed || !image.sourceLive.value || image.pause) {
      fault('Image cannot begin an execution barrier');
    }
    const members = Array.from(image.replicas, replica => ({ replica, pause: undefined as GroupExecutionPause | undefined }));
    if (!members.length || this.nextPauseEpoch + members.length - 1 > 0xffffffff) {
      fault('Image execution barrier has no fresh replica epochs');
    }
    // Refuse prepared, stopping, quarantined or independently paused members
    // before changing any request word. Membership cannot grow under the latch.
    for (const { replica } of members) {
      if (replica.state !== 'exposed' || !replica.live.value || replica.pause
          || Atomics.load(this.controls(replica), G.MEMORY_GROUP_REPLICA_RUN / 4) !== 1) {
        fault('Image execution barrier requires live unpaused replicas');
      }
    }
    const pause: ImagePause = { image, members };
    const token = Object.freeze(Object.create(null)) as GroupImageExecutionPause;
    this.imagePauses.set(token, pause); image.pause = pause;
    try {
      for (const member of members) member.pause = this.startExecutionPause(member.replica);
      return token;
    } catch (error) {
      // A malformed queue or partial request failure cannot become a false
      // all-replica acknowledgment. Contain every member and retain charges.
      for (const { replica } of members) {
        try { this.quarantine(replica.handle); } catch { /* original fault remains authoritative */ }
      }
      image.pause = undefined; pause.image = undefined; pause.members = [];
      throw error;
    }
  }
  imageExecutionPauseAcknowledged(token: GroupImageExecutionPause): boolean {
    const pause = this.imagePauses.get(token);
    if (!pause) fault('Unknown image execution-barrier capability');
    const image = pause.image;
    if (!image) return false;
    if (this.closed || !image.sourceLive.value || image.pause !== pause
        || image.replicas.size !== pause.members.length) return false;
    let acknowledged = true;
    for (const { replica, pause: member } of pause.members) {
      if (!image.replicas.has(replica) || replica.state !== 'exposed'
          || !replica.live.value || !member) return false;
      // Try every queued waiter even when another member is still running.
      const current = this.executionPauseAcknowledged(member);
      acknowledged = current && acknowledged;
    }
    return acknowledged;
  }
  resumeImageExecutionPause(token: GroupImageExecutionPause): boolean {
    const pause = this.imagePauses.get(token);
    if (!pause) fault('Unknown image execution-barrier capability');
    const image = pause.image;
    if (!image) return false;
    if (image.pause !== pause) fault('Image lost its exact execution barrier');
    let resumed = true;
    for (const member of pause.members) {
      const current = member.pause ? this.resumeExecutionPause(member.pause) : false;
      resumed = current && resumed;
    }
    image.pause = undefined; pause.image = undefined; pause.members = [];
    return resumed;
  }
  executionPauseAcknowledged(token: GroupExecutionPause): boolean {
    const pause = this.pauses.get(token);
    if (!pause) fault('Unknown execution-barrier capability');
    const replica = pause.replica;
    if (!replica) return false;
    const control = this.controls(replica);
    if (!replica.live.value || Atomics.load(control, G.MEMORY_GROUP_REPLICA_RUN / 4) !== 1) return false;
    if ((Atomics.load(control, G.MEMORY_GROUP_REPLICA_REQUEST / 4) >>> 0) !== pause.epoch) {
      fault('Execution barrier lost its exact requested epoch');
    }
    tryControlMemoryGroupReplicaWait(this.memory, replica.image.root, replica.scratch.first * PAGE, 'pause', pause.epoch);
    return (Atomics.load(control, G.MEMORY_GROUP_REPLICA_ACK / 4) >>> 0) === pause.epoch;
  }
  resumeExecutionPause(token: GroupExecutionPause): boolean {
    const pause = this.pauses.get(token);
    if (!pause) fault('Unknown execution-barrier capability');
    const replica = pause.replica;
    if (!replica) return false;
    const control = this.controls(replica);
    if ((Atomics.load(control, G.MEMORY_GROUP_REPLICA_REQUEST / 4) >>> 0) !== pause.epoch) {
      fault('Stale barrier cannot resume a newer epoch');
    }
    Atomics.store(control, G.MEMORY_GROUP_REPLICA_REQUEST / 4, 0);
    Atomics.notify(control, G.MEMORY_GROUP_REPLICA_REQUEST / 4);
    pause.replica = undefined; replica.pause = undefined;
    return true;
  }
  requestReplicaStop(handle: PreparedGroupReplica): boolean {
    const replica = this.owned(handle);
    try {
      this.controls(replica);
      replica.pendingWaitDrain = !tryControlMemoryGroupReplicaWait(this.memory, replica.image.root,
        replica.scratch.first * PAGE, 'stop');
    } catch (error) {
      replica.pendingWaitDrain = true;
      throw error;
    } finally {
      if (replica.pause) { replica.pause.replica = undefined; replica.pause = undefined; }
    }
    return !replica.pendingWaitDrain;
  }

  /** Caller must first transition this exact Rust receipt out of Prepared.
   * Returning even one backing reference ends the rollback privilege, whether
   * or not a later postMessage/Worker constructor succeeds. */
  publish(handle: PreparedGroupReplica, admission: MemoryGroupTaskReceipt): GroupReplicaLaunch {
    const replica = this.owned(handle);
    if (this.closed || !replica.image.sourceLive.value || replica.image.pause
        || replica.state !== 'prepared' || !exact(replica.receipt, admission)) {
      fault('Replica launch is stale, repeated or not its exact admission');
    }
    const { image, live } = replica;
    // Capture only a metadata liveness cell. A retained accessor/expectation
    // must not retain this store, its other images, or its physical Memory.
    const assertLive = () => { if (!live.value) throw new ProcessAddressFault('retired'); };
    const expectation = Object.freeze({ receipt: replica.receipt, root: image.root,
      replica: replica.scratch.first * PAGE, scratch: replica.scratch.first * PAGE + G.MEMORY_GROUP_REPLICA_BYTES,
      maximumPhysicalPages: this.maximumPhysicalPages,
      maximumVirtualPages: image.layout.maximumVirtualPages, scratchBytes: image.layout.scratchBytes, assertLive });
    const descriptor = { kind: G.MEMORY_GROUP_MODULE, receipt: replica.receipt, root: image.root,
      replica: expectation.replica,
      scratch: expectation.scratch, maximumVirtualPages: expectation.maximumVirtualPages,
      scratchBytes: expectation.scratchBytes } as const;
    const envelope = encodeProcessMemoryDescriptor(this.memory, descriptor, { ...expectation, memory: this.memory });
    const source = new GroupProcessAddressSpace({ memory: this.memory, root: image.root,
      maximumPages: expectation.maximumVirtualPages, assertLive });
    replica.source = source; replica.state = 'exposed'; image.exposed = true;
    return Object.freeze({ envelope, source, expectation });
  }

  /** Kernel-realm image source, shared by every replica of this exact root.
   * Publishing a replica already ended rollback; this neither authorizes a new
   * task nor proves execution stopped. Keep registration's source here rather
   * than borrowing the leader's execution accessor, which ends at leader exit.
   */
  imageSource(handle: PreparedGroupReplica): GroupProcessAddressSpace {
    const { image } = this.owned(handle);
    if (this.closed || !image.exposed || !image.sourceLive.value) {
      throw new ProcessAddressFault('retired');
    }
    if (!image.source) {
      const live = image.sourceLive, observations = image.nativeObservations;
      // Retained sources capture no store/image/replica or sibling images.
      const assertLive = () => { if (!live.value) throw new ProcessAddressFault('retired'); };
      const retainNativeObservation = () => {
        assertLive();
        const token = Object.freeze({}); observations.add(token);
        return () => { observations.delete(token); };
      };
      image.source = new GroupProcessAddressSpace({ memory: this.memory, root: image.root,
        maximumPages: image.layout.maximumVirtualPages, assertLive, retainNativeObservation });
    }
    return image.source;
  }

  /** Exact kernel-realm registration input. Only the already-published main
   * replica may install an image; a thread or quarantined launch cannot rebind
   * a PID. Rust identity/generation is revalidated by the registration entry.
   */
  processRegistration(handle: PreparedGroupReplica): {
    readonly receipt: MemoryGroupTaskReceipt;
    readonly memory: WebAssembly.Memory;
    readonly source: GroupProcessAddressSpace;
    readonly maximumVirtualPages: number;
  } {
    const replica = this.owned(handle);
    if (this.closed || replica.state !== 'exposed' || !replica.live.value
        || replica.receipt.tid !== replica.receipt.pid) {
      fault('Process registration requires an exact published main replica');
    }
    return Object.freeze({ receipt: replica.receipt, memory: this.memory,
      source: this.imageSource(handle), maximumVirtualPages: replica.image.layout.maximumVirtualPages });
  }

  /** End kernel access to this image without stopping execution replicas or
   * freeing any pages. Exact writer/Worker fences still belong to lifecycle.
   * Irreversible even if no accessor has been requested yet.
   */
  revokeImageAccess(handle: PreparedGroupReplica): void {
    this.revokeSource(this.owned(handle).image);
  }
  private revokeSource(image: Image): void {
    image.sourceLive.value = false;
    image.source?.detachHostAccess(); image.source = undefined;
  }

  /** Only after Rust accepts cancelUnconstructed for this exact receipt. This
   * releases replica scratch, never a root still retained by Rust/image peers. */
  cancelUnexposed(handle: PreparedGroupReplica): void {
    const replica = this.owned(handle);
    if (replica.state !== 'prepared') fault('Published replica cannot use unconstructed rollback');
    this.pool.releaseRetiredPages(pages(replica.scratch));
    replica.live.value = false; replica.state = 'cancelled';
    replica.image.replicas.delete(replica); this.replicas.delete(replica.receipt.serial);
  }
  canReleaseUnexposedImage(receipt: MemoryGroupTaskReceipt): boolean {
    const image = this.images.get(imageKey(receipt));
    return !!image && image.receipt.group === receipt.group && !image.exposed && image.replicas.size === 0;
  }
  /** Call only after Rust releases the exact unpublished image custody. */
  releaseUnexposedImage(receipt: MemoryGroupTaskReceipt): void {
    const key = imageKey(receipt), image = this.images.get(key);
    if (!image || image.receipt.group !== receipt.group || image.exposed || image.replicas.size) {
      fault('Image still has publication or replica custody');
    }
    this.revokeSource(image);
    this.pool.releaseRetiredPages([...pages(image.controls), ...pages(image.payload)]); this.images.delete(key);
  }

  quarantine(handle: PreparedGroupReplica): void {
    const replica = this.owned(handle);
    try { this.requestReplicaStop(handle); }
    finally {
      replica.live.value = false; replica.source?.detachHostAccess(); replica.source = undefined;
      replica.state = 'quarantined';
    }
  }
  close(): void {
    this.closed = true;
    for (const image of this.images.values()) this.revokeSource(image);
    for (const replica of this.replicas.values()) {
      // Emergency containment cannot wait forever on an interrupted queue.
      // Keep failed/busy drains charged and visible for exact owner cleanup.
      try {
        this.controls(replica);
        replica.pendingWaitDrain = !tryControlMemoryGroupReplicaWait(this.memory, replica.image.root,
          replica.scratch.first * PAGE, 'stop');
      } catch { replica.pendingWaitDrain = true; }
      if (replica.pause) { replica.pause.replica = undefined; replica.pause = undefined; }
      replica.live.value = false; replica.source?.detachHostAccess(); replica.source = undefined;
      replica.state = 'quarantined';
    }
    // No pool bits are returned: closing this owner is not a Worker fence.
  }
  snapshot(): { readonly group: number; readonly images: number; readonly replicas: number;
    readonly exposedReplicas: number; readonly quarantinedReplicas: number; readonly allocatedPages: number;
    readonly pendingWaitDrains: number; readonly nativeObservers: number;
    readonly maximumPages: number; readonly highWaterPages: number; readonly physicalExtentPages: number } {
    return Object.freeze({ group: this.group, images: this.images.size, replicas: this.replicas.size,
      exposedReplicas: [...this.replicas.values()].filter(r => r.state === 'exposed').length,
      quarantinedReplicas: [...this.replicas.values()].filter(r => r.state === 'quarantined').length,
      pendingWaitDrains: [...this.replicas.values()].filter(r => r.pendingWaitDrain).length,
      nativeObservers: [...this.images.values()].reduce((sum, image) => sum + image.nativeObservations.size, 0),
      ...this.pool.snapshot() });
  }
}
