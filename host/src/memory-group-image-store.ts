import * as G from './generated/program-extensions';
import { MemoryGroupPagePool, type GroupPageExtent } from './memory-group-pool';
import { MemoryGroupProtocolFault, memoryGroupU32, type MemoryGroupTaskReceipt, type GroupMemoryChangeDescription } from './memory-group-protocol';
import { GroupProcessAddressSpace, ProcessAddressFault, NativeI32Observation } from './process-address-space';
import { encodeProcessMemoryDescriptor, type GroupReplicaMemoryExpectation,
  type ProcessMemoryEnvelope } from './process-memory-descriptor';
import { tryControlMemoryGroupReplicaWait, memoryGroupImageWaitsRetired, memoryGroupReplicaWaitsRetired, memoryGroupPinnedPages } from './memory-group-notification';

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
declare const preparedMapping: unique symbol;
export interface PreparedGroupMapping { readonly [preparedMapping]: true }
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
interface NativeObservationPin { readonly physicalAddress: number }
interface Image {
  readonly receipt: MemoryGroupTaskReceipt;
  readonly root: number;
  readonly layout: GroupImageLayout;
  readonly controls: GroupPageExtent;
  readonly payload?: GroupPageExtent;
  /** Exact unpublished private-fork custody, including fragmented pages. */
  readonly privatePayload?: Uint32Array;
  readonly replicas: Set<Replica>;
  /** Kernel image access outlives any one execution replica. */
  readonly sourceLive: { value: boolean };
  readonly nativeObservations: Set<NativeObservationPin>;
  source?: GroupProcessAddressSpace;
  exposed: boolean;
  pause?: ImagePause;
  replicaPreparationWaiters?: Set<() => void>;
  mapping?: Mapping;
  /** Removed PTE references stay charged until exact whole-image retirement. */
  retainedMappingPages?: RetainedMappingPages;
  /** Initial payload tuples describe allocation origin, not eternal custody. */
  returnedOriginalPages?: ReadonlySet<number>;
}
interface Replica {
  readonly handle: PreparedGroupReplica;
  readonly receipt: MemoryGroupTaskReceipt;
  readonly image: Image;
  readonly scratch: GroupPageExtent;
  readonly live: { value: boolean };
  state: 'prepared' | 'exposed' | 'quarantined' | 'cancelled' | 'stopped';
  source?: GroupProcessAddressSpace;
  pause?: Pause;
  pendingWaitDrain: boolean;
  stopWaiters?: Set<{ resolve: () => void; reject: (error: Error) => void }>;
}
interface Pause { replica?: Replica; readonly epoch: number }
interface ImagePause {
  image?: Image;
  members: { readonly replica: Replica; pause?: GroupExecutionPause }[];
}
interface RetainedMappingPages { readonly pages: Uint32Array; next?: RetainedMappingPages }
interface Mapping {
  image?: Image;
  readonly barrier: GroupImageExecutionPause;
  readonly description: GroupMemoryChangeDescription;
  readonly oldExtent: number;
  readonly newExtent: number;
  before?: Uint32Array;
  after?: Uint32Array;
  allocated?: Uint32Array;
  retained?: RetainedMappingPages;
  state: 'prepared' | 'publishing' | 'committed' | 'cancelled' | 'contained';
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
 * allocator. Published storage returns only after the kernel owner revokes
 * image access and every observed replica stops, all native observers settle,
 * and the queue contains no wait node owned by this image. A local token alone
 * supplies none of those retirement proofs.
 */
export class MemoryGroupImageStore {
  private readonly memory: WebAssembly.Memory;
  private readonly pool: MemoryGroupPagePool;
  private readonly images = new Map<string, Image>();
  private readonly replicas = new Map<bigint, Replica>();
  private readonly handles = new WeakMap<PreparedGroupReplica, Replica>();
  private readonly pauses = new WeakMap<GroupExecutionPause, Pause>();
  private readonly imagePauses = new WeakMap<GroupImageExecutionPause, ImagePause>();
  private readonly mappings = new WeakMap<PreparedGroupMapping, Mapping>();
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
        sourceLive: { value: true }, nativeObservations: new Set(), returnedOriginalPages: undefined, exposed: false };
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

  imageHasExecutionPause(handle: PreparedGroupReplica): boolean {
    return this.owned(handle).image.pause !== undefined;
  }
  /** Membership preparation waits on the existing image owner, without a
   * native futex observer or a timer masquerading as a retirement fence. */
  waitForImageExecutionPause(handle: PreparedGroupReplica): Promise<void> {
    const image = this.owned(handle).image;
    if (!image.pause) return Promise.resolve();
    return new Promise(resolve => {
      (image.replicaPreparationWaiters ??= new Set()).add(resolve);
    });
  }

  /** Physical private-page inheritance only. The coordinator must freeze and
   * synchronize Rust's parent MM before allocating its child, then revalidate
   * both identities before publishing this prepared replica. This operation
   * neither allocates a PID nor implements MAP_SHARED inheritance.
   */
  preparePrivateFork(barrier: GroupImageExecutionPause, admission: MemoryGroupTaskReceipt):
      PreparedGroupReplica | 'waiting' | 'busy' | 'exhausted' {
    const receipt = this.check(admission), pause = this.imagePauses.get(barrier), parent = pause?.image;
    if (!parent || parent.pause !== pause || parent.mapping || receipt.tid !== receipt.pid
        || receipt.pid === parent.receipt.pid || this.images.has(imageKey(receipt))) {
      fault('Private fork has no exact paused parent and new child image');
    }
    if (!this.imageExecutionPauseAcknowledged(barrier)) return 'waiting';
    const lock = new Int32Array(this.memory.buffer, parent.root + G.MEMORY_GROUP_ROOT_GROW_LOCK, 1);
    if (Atomics.compareExchange(lock, 0, 0, 1) !== 0) return 'busy';
    try {
      if (!this.imageExecutionPauseAcknowledged(barrier)) return 'waiting';
      const header = new Uint32Array(this.memory.buffer, parent.root, G.MEMORY_GROUP_ROOT_HEADER_BYTES / 4);
      const extent = Atomics.load(header, 0), maximum = parent.layout.maximumVirtualPages;
      if (extent > maximum || header[1] !== maximum || header[2] !== parent.layout.scratchBytes) {
        fault('Invalid paused fork root');
      }
      const entries = new Uint32Array(maximum);
      entries.set(new Uint32Array(this.memory.buffer, parent.root + G.MEMORY_GROUP_ROOT_HEADER_BYTES, maximum));
      const copies = new Map<number, number>();
      for (let at = 0; at < maximum; at++) {
        const entry = entries[at], physical = entry >>> 16;
        if ((entry & 0xfffc) || (entry && !physical) || physical >= this.memory.buffer.byteLength / PAGE
            || (at >= extent && entry)) fault('Invalid private fork PTE');
        if (physical && !copies.has(physical)) copies.set(physical, copies.size);
      }
      const privatePayload = new Uint32Array(copies.size);
      const allocated = this.pool.tryAllocateImage(
        Math.ceil((G.MEMORY_GROUP_ROOT_HEADER_BYTES + maximum * 4) / PAGE),
        Math.ceil((G.MEMORY_GROUP_REPLICA_BYTES + parent.layout.scratchBytes) / PAGE), privatePayload);
      if (typeof allocated === 'string') return allocated;
      let image: Image | undefined;
      try {
        // Pool growth replaces bounded buffers. Refresh after reservation, and
        // copy physical storage even when guest permissions are PROT_NONE.
        const bytes = new Uint8Array(this.memory.buffer);
        for (const [physical, index] of copies) {
          bytes.set(bytes.subarray(physical * PAGE, (physical + 1) * PAGE), privatePayload[index] * PAGE);
        }
        const root = allocated.controls.first * PAGE;
        const childHeader = new Uint32Array(this.memory.buffer, root, G.MEMORY_GROUP_ROOT_HEADER_BYTES / 4);
        childHeader[1] = maximum; childHeader[2] = parent.layout.scratchBytes;
        childHeader[G.MEMORY_GROUP_ROOT_RUN / 4] = 1;
        // Initialization stays zero: normal isForkChild binds in mode 0,
        // claiming this new root while dropping rather than replaying data.
        const ptes = new Uint32Array(this.memory.buffer, root + G.MEMORY_GROUP_ROOT_HEADER_BYTES, maximum);
        for (let at = 0; at < extent; at++) {
          const entry = entries[at], physical = entry >>> 16;
          if (physical) ptes[at] = (privatePayload[copies.get(physical)!] * PAGE | (entry & 3)) >>> 0;
        }
        Atomics.store(childHeader, 0, extent);
        image = { receipt, root, layout: Object.freeze({ ...parent.layout, initialVirtualPages: extent }),
          controls: allocated.controls, privatePayload, replicas: new Set(),
          sourceLive: { value: true }, nativeObservations: new Set(), returnedOriginalPages: undefined, exposed: false };
        this.images.set(imageKey(receipt), image);
        return this.replica(receipt, image, allocated.scratch);
      } catch (error) {
        if (image) this.images.delete(imageKey(receipt));
        this.pool.releaseRetiredPages([...pages(allocated.controls), ...pages(allocated.scratch), ...privatePayload]);
        throw error;
      }
    } finally { Atomics.store(lock, 0, 0); Atomics.notify(lock, 0, 1); }
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
  virtualExtentAtBarrier(token: GroupImageExecutionPause): number | 'waiting' | 'busy' {
    const pause = this.imagePauses.get(token), image = pause?.image;
    if (!image || image.pause !== pause) fault('Virtual extent has no exact image barrier');
    if (!this.imageExecutionPauseAcknowledged(token)) return 'waiting';
    const lock = new Int32Array(this.memory.buffer, image.root + G.MEMORY_GROUP_ROOT_GROW_LOCK, 1);
    if (Atomics.compareExchange(lock, 0, 0, 1) !== 0) return 'busy';
    try {
      if (!this.imageExecutionPauseAcknowledged(token)) return 'waiting';
      const header = new Uint32Array(this.memory.buffer, image.root, G.MEMORY_GROUP_ROOT_HEADER_BYTES / 4);
      const pages = Atomics.load(header, 0);
      if (header[1] !== image.layout.maximumVirtualPages || pages > image.layout.maximumVirtualPages) fault('Invalid paused virtual extent');
      return pages;
    } finally { Atomics.store(lock, 0, 0); Atomics.notify(lock, 0, 1); }
  }
  /** Observe an exact physical progress word after leaving kernel entry. The
   * timeout only schedules revalidation (including a busy wait-queue lock),
   * never establishes quiescence. Keep its image pin until engine settlement.
   */
  waitForMappingProgress(token: GroupImageExecutionPause, target: 'barrier' | 'locks' | 'pool'): Promise<void> {
    const pause = this.imagePauses.get(token), image = pause?.image;
    if (!image || image.pause !== pause) fault('Progress wait has no exact image barrier');
    let address = target === 'pool' ? G.MEMORY_GROUP_CONTROL : image.root + G.MEMORY_GROUP_ROOT_GROW_LOCK;
    let expected = 1;
    if (target === 'locks' && Atomics.load(new Int32Array(this.memory.buffer, address, 1), 0) === 0) address = G.MEMORY_GROUP_CONTROL;
    if (target === 'barrier') {
      const member = pause.members.find(({ replica, pause: handle }) => {
        const epoch = handle && this.pauses.get(handle)?.epoch;
        return epoch !== undefined && (Atomics.load(this.controls(replica), G.MEMORY_GROUP_REPLICA_ACK / 4) >>> 0) !== epoch;
      });
      if (!member) return Promise.resolve();
      address = member.replica.scratch.first * PAGE + G.MEMORY_GROUP_REPLICA_ACK;
      expected = Atomics.load(new Int32Array(this.memory.buffer, address, 1), 0);
    }
    const pin = Object.freeze({ physicalAddress: address }); image.nativeObservations.add(pin);
    const observation = new NativeI32Observation(new Int32Array(this.memory.buffer, address, 1),
      () => { image.nativeObservations.delete(pin); });
    // A finite engine wait also bounds a lost notification during forced stop.
    // Its promise must still settle before the pin is removed.
    const result = observation.arm(expected, 10);
    return result.async ? result.value.then(() => undefined) : Promise.resolve();
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
    for (const resolve of image.replicaPreparationWaiters ?? []) resolve();
    image.replicaPreparationWaiters = undefined;
    return resumed;
  }

  /** Internal physical half of a kernel-prepared mmap/munmap/mprotect/mremap.
   * Receipts do not authorize a syscall: the coordinator must separately
   * validate the Rust token and pending request before publication. No backing
   * or PTE leaves this owner. Rust owns initial-image/brk metadata separately.
   */
  prepareImageMapping(barrier: GroupImageExecutionPause, input: GroupMemoryChangeDescription):
      PreparedGroupMapping | 'waiting' | 'busy' | 'exhausted' {
    const pause = this.imagePauses.get(barrier), image = pause?.image;
    if (!image || image.pause !== pause || image.mapping) fault('Mapping has no free exact image barrier');
    if (!pause.members.some(({ replica }) => exact(replica.receipt, input.receipt))) fault('Mapping receipt does not belong to this image barrier');
    if (!this.imageExecutionPauseAcknowledged(barrier)) return 'waiting';
    const maximum = image.layout.maximumVirtualPages;
    const aligned = (address: number, length: number) => Number.isSafeInteger(address)
      && Number.isSafeInteger(length) && address >= 0 && length >= 0
      && address % PAGE === 0 && length % PAGE === 0 && address + length <= maximum * PAGE;
    const byteAddress = (address: number) => Number.isSafeInteger(address) && address >= 0 && address <= maximum * PAGE;
    const isBreak = input.kind === 'break';
    if ((isBreak ? !byteAddress(input.address) || !byteAddress(input.oldAddress) || input.length !== 0 || input.oldLength !== 0
          || input.prot !== 3 || input.result !== input.address : !aligned(input.address, input.length))
        || (input.kind === 'remap' && !aligned(input.oldAddress, input.oldLength))
        || !Number.isSafeInteger(input.prot) || input.prot < 0 || input.prot > 7 || input.token <= 0n
        || !['map', 'unmap', 'protect', 'remap', 'break'].includes(input.kind)) fault('Invalid kernel-prepared physical mapping');
    const description = Object.freeze({ ...input, receipt: Object.freeze({ ...input.receipt }) });
    // Independent undo/staging storage is bounded by this image's admitted
    // virtual capacity and discarded after commit/cancel. No snapshots of bytes.
    const before = new Uint32Array(maximum), after = new Uint32Array(maximum);
    if ((input.kind === 'map' || input.kind === 'remap') && !input.length) fault('Mapping requires a nonempty target');
    const token = Object.freeze(Object.create(null)) as PreparedGroupMapping;
    const lock = new Int32Array(this.memory.buffer, image.root + G.MEMORY_GROUP_ROOT_GROW_LOCK, 1);
    if (Atomics.compareExchange(lock, 0, 0, 1) !== 0) return 'busy';
    try {
      if (!this.imageExecutionPauseAcknowledged(barrier)) return 'waiting';
      const header = new Uint32Array(this.memory.buffer, image.root, G.MEMORY_GROUP_ROOT_HEADER_BYTES / 4);
      const oldExtent = Atomics.load(header, 0);
      if (oldExtent > maximum || header[1] !== maximum) fault('Mapping root capacity changed');
      before.set(new Uint32Array(this.memory.buffer, image.root + G.MEMORY_GROUP_ROOT_HEADER_BYTES, maximum)); after.set(before);
      for (let at = 0; at < maximum; at++) {
        const entry = before[at], physical = entry >>> 16;
        if ((entry & 0xfffc) || (entry && !physical) || physical >= this.memory.buffer.byteLength / PAGE
            || (at >= oldExtent && entry)) fault('Invalid physical mapping baseline');
      }
      const start = input.address / PAGE, count = input.length / PAGE, rights = input.prot & 3;
      let newExtent = oldExtent;
      // A sentinel outside the physical layout lets us finish all fallible
      // undo/retention allocations before reserving actual replacement pages.
      const fresh = 0xffff0000;
      if (isBreak) {
        if (input.oldAddress > oldExtent * PAGE) fault('Old break exceeds its materialized virtual extent');
        const low = Math.ceil(Math.min(input.address, input.oldAddress) / PAGE), high = Math.ceil(Math.max(input.address, input.oldAddress) / PAGE);
        if (input.address < input.oldAddress) after.fill(0, low, high);
        else for (let at = low; at < high; at++) if (!(after[at] >>> 16)) after[at] = (fresh | 3) >>> 0;
        newExtent = Math.max(oldExtent, Math.ceil(input.address / PAGE));
      }
      else if (input.kind === 'map') { after.fill((fresh | rights) >>> 0, start, start + count); newExtent = Math.max(oldExtent, start + count); }
      else if (input.kind === 'unmap') after.fill(0, start, start + count);
      else if (input.kind === 'protect') {
        for (let at = start; at < start + count; at++) {
          if (at >= oldExtent || !(before[at] >>> 16)) fault('Protection cannot create a mapping in a hole');
          after[at] = ((before[at] & 0xffff0000) | rights) >>> 0;
        }
      } else {
        const oldStart = input.oldAddress / PAGE, oldCount = input.oldLength / PAGE;
        if (!oldCount || oldStart + oldCount > oldExtent) fault('Remap source is outside its virtual extent');
        for (let at = oldStart; at < oldStart + oldCount; at++) if (!(before[at] >>> 16)) fault('Remap source contains a hole');
        after.fill(0, oldStart, oldStart + oldCount);
        for (let at = 0; at < count; at++) after[start + at] = at < oldCount ? before[oldStart + at] : (fresh | rights) >>> 0;
        newExtent = Math.max(oldExtent, start + count);
      }
      let removed = 0, freshCount = 0;
      for (let at = 0; at < maximum; at++) if ((before[at] >>> 16) && (before[at] >>> 16) !== (after[at] >>> 16)) removed++;
      for (let at = 0; at < maximum; at++) if ((after[at] >>> 16) === 0xffff) freshCount++;
      if (freshCount >= this.maximumPhysicalPages) return 'exhausted';
      const allocated = new Uint32Array(freshCount);
      const retained: RetainedMappingPages = { pages: new Uint32Array(removed) };
      for (let at = 0, out = 0; at < maximum; at++) if ((before[at] >>> 16) && (before[at] >>> 16) !== (after[at] >>> 16)) retained.pages[out++] = before[at] >>> 16;
      const mapping: Mapping = { image, barrier, description, oldExtent, newExtent, before, after, allocated, retained, state: 'prepared' };
      // Register custody before acquiring physical pages, so allocation failure
      // cannot strand an unrecorded successful reservation.
      this.mappings.set(token, mapping); image.mapping = mapping;
      let status: 'allocated' | 'busy' | 'exhausted';
      try { status = allocated.length ? this.pool.tryAllocatePages(allocated) : 'allocated'; }
      catch (error) { image.mapping = undefined; mapping.image = undefined; mapping.state = 'cancelled'; throw error; }
      if (status !== 'allocated') { image.mapping = undefined; mapping.image = undefined; mapping.state = 'cancelled'; return status; }
      for (let at = 0, next = 0; at < maximum; at++) if ((after[at] >>> 16) === 0xffff) after[at] = (allocated[next++] * PAGE | rights) >>> 0;
      return token;
    } finally { Atomics.store(lock, 0, 0); Atomics.notify(lock, 0, 1); }
  }

  /** Populate only fresh unpublished pages selected by the exact Rust plan.
   * Existing payload/aliases and the live PTE table are never write targets.
   */
  populateImageMapping(token: PreparedGroupMapping, offset: number, bytes: Uint8Array): void {
    const mapping = this.mappings.get(token), image = mapping?.image;
    if (!mapping || !image || mapping.state !== 'prepared' || image.mapping !== mapping
        || !this.imageExecutionPauseAcknowledged(mapping.barrier)) fault('Population has no paused unpublished mapping');
    const { populationAddress, populationLength } = mapping.description;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > populationLength || bytes.length > populationLength - offset) {
      fault('Population exceeds its kernel-selected interval');
    }
    let copied = 0;
    while (copied < bytes.length) {
      const address = populationAddress + offset + copied, page = Math.floor(address / PAGE);
      const physical = mapping.after![page] >>> 16, within = address % PAGE;
      if (!physical || !mapping.allocated!.includes(physical)) fault('Population attempted to overwrite published storage');
      const count = Math.min(PAGE - within, bytes.length - copied);
      new Uint8Array(this.memory.buffer, physical * PAGE + within, count).set(bytes.subarray(copied, copied + count));
      copied += count;
    }
  }

  /** Invoke only synchronously within the coordinator's exact kernel entry.
   * Refused Rust commit rolls PTEs back while all replicas remain paused. A
   * thrown/invalid result has uncertain publication and contains the image.
   */
  commitImageMapping(token: PreparedGroupMapping, validate: (description: GroupMemoryChangeDescription) => boolean,
      commit: (description: GroupMemoryChangeDescription) => number):
      'committed' | 'busy' | 'stale' | number {
    const mapping = this.mappings.get(token), image = mapping?.image;
    if (!mapping || !image || mapping.state !== 'prepared' || image.mapping !== mapping) fault('Mapping preparation was consumed or is unknown');
    if (!this.imageExecutionPauseAcknowledged(mapping.barrier)) return 'stale';
    const lock = new Int32Array(this.memory.buffer, image.root + G.MEMORY_GROUP_ROOT_GROW_LOCK, 1);
    if (Atomics.compareExchange(lock, 0, 0, 1) !== 0) return 'busy';
    try {
      if (validate(mapping.description) !== true || mapping.state !== 'prepared' || image.mapping !== mapping
          || !this.imageExecutionPauseAcknowledged(mapping.barrier)) return 'stale';
      const header = new Uint32Array(this.memory.buffer, image.root, G.MEMORY_GROUP_ROOT_HEADER_BYTES / 4);
      const table = new Uint32Array(this.memory.buffer, image.root + G.MEMORY_GROUP_ROOT_HEADER_BYTES, image.layout.maximumVirtualPages);
      const before = mapping.before!, after = mapping.after!;
      if (Atomics.load(header, 0) !== mapping.oldExtent || header[1] !== image.layout.maximumVirtualPages) return 'stale';
      for (let at = 0; at < before.length; at++) if (table[at] !== before[at]) return 'stale';
      mapping.state = 'publishing';
      table.set(after); Atomics.store(header, 0, mapping.newExtent);
      let result: number;
      try {
        result = commit(mapping.description);
        if (!Number.isSafeInteger(result) || result > 0 || result < -4095) fault('Invalid Rust mapping commit result');
      } catch (error) {
        mapping.state = 'contained';
        for (const replica of image.replicas) try { this.quarantine(replica.handle); } catch { /* retain original commit fault */ }
        this.revokeSource(image); throw error;
      }
      if (result < 0) { table.set(before); Atomics.store(header, 0, mapping.oldExtent); mapping.state = 'prepared'; return result; }
      if (mapping.retained!.pages.length) { mapping.retained!.next = image.retainedMappingPages; image.retainedMappingPages = mapping.retained; }
      mapping.state = 'committed'; image.mapping = undefined; mapping.image = undefined;
      mapping.before = undefined; mapping.after = undefined; mapping.allocated = undefined; mapping.retained = undefined;
      return 'committed';
    } finally { Atomics.store(lock, 0, 0); Atomics.notify(lock, 0, 1); }
  }

  cancelImageMapping(token: PreparedGroupMapping): 'cancelled' | 'busy' {
    const mapping = this.mappings.get(token), image = mapping?.image;
    if (!mapping || !image || mapping.state !== 'prepared' || image.mapping !== mapping) fault('Mapping cannot use unpublished rollback');
    if (mapping.allocated!.length && this.pool.tryReleaseUnpublishedPages(mapping.allocated!) === 'busy') return 'busy';
    image.mapping = undefined; mapping.image = undefined; mapping.state = 'cancelled';
    mapping.before = undefined; mapping.after = undefined; mapping.allocated = undefined; mapping.retained = undefined;
    return 'cancelled';
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
      const retainNativeObservation = (physicalAddress: number) => {
        assertLive();
        const token = Object.freeze({ physicalAddress }); observations.add(token);
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
    for (const resolve of image.replicaPreparationWaiters ?? []) resolve();
    image.replicaPreparationWaiters = undefined;
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
    this.pool.releaseRetiredPages([...pages(image.controls), ...pages(image.payload), ...(image.privatePayload ?? [])]); this.images.delete(key);
  }

  /** Execution proof is owned by KernelWorker's exact Worker observer. End
   * replica access and barrier membership, retaining every physical charge.
   * The kernel's distinct image source still serves exit/wait publication. */
  noteReplicaQuiescent(handle: PreparedGroupReplica): void {
    const replica = this.owned(handle);
    if (replica.state !== 'exposed' && replica.state !== 'quarantined') fault('Replica has no published execution custody');
    replica.live.value = false;
    replica.source?.detachHostAccess(); replica.source = undefined;
    replica.state = 'stopped';
    for (const waiter of replica.stopWaiters ?? []) waiter.resolve();
    replica.stopWaiters = undefined;
    const barrier = replica.image.pause;
    if (barrier) barrier.members = barrier.members.filter(member => member.replica !== replica);
    if (replica.pause) {
      replica.pause.replica = undefined;
      replica.pause = undefined;
    }
    replica.image.replicas.delete(replica);
    // An engine observer may still be waiting for this exact member's ACK.
    // Wake it to revalidate membership; never invent an execution ACK or free
    // its control pages before that observer has actually settled.
    Atomics.notify(this.controls(replica), G.MEMORY_GROUP_REPLICA_ACK / 4);
  }

  waitForReplicaQuiescence(handle: PreparedGroupReplica): Promise<void> {
    const replica = this.owned(handle);
    if (replica.state === 'stopped') return Promise.resolve();
    if (this.closed) return Promise.reject(new ProcessAddressFault('retired'));
    return new Promise<void>((resolve, reject) => { (replica.stopWaiters ??= new Set()).add({ resolve, reject }); });
  }

  /** A committed unmap/remap ends PTE custody, but not physical waiter pins.
   * Under the root lock, release only pages absent from every current alias,
   * control and replica owner. Normalize historical references before return
   * so allocator reuse cannot make an old tuple claim another image's page. */
  tryReclaimRemovedPages(handle: PreparedGroupReplica): { releasedPages: number; retainedPages: number } | 'busy' {
    const image = this.owned(handle).image;
    if (this.closed || !image.sourceLive.value || image.mapping) return 'busy';
    if (!image.retainedMappingPages) return { releasedPages: 0, retainedPages: 0 };
    const lock = new Int32Array(this.memory.buffer, image.root + G.MEMORY_GROUP_ROOT_GROW_LOCK, 1);
    if (Atomics.compareExchange(lock, 0, 0, 1) !== 0) return 'busy';
    try {
      const references = new Set<number>();
      for (let retired: RetainedMappingPages | undefined = image.retainedMappingPages; retired; retired = retired.next) for (const page of retired.pages) references.add(page);
      const current = new Set(pages(image.controls));
      for (const replica of this.replicas.values()) if (replica.image === image) for (const page of pages(replica.scratch)) current.add(page);
      const table = new Uint32Array(this.memory.buffer, image.root + G.MEMORY_GROUP_ROOT_HEADER_BYTES, image.layout.maximumVirtualPages);
      for (let at = 0; at < table.length; at++) {
        const entry = Atomics.load(table, at), page = entry >>> 16;
        if ((entry & 0xfffc) || (entry && !page) || page >= this.memory.buffer.byteLength / PAGE) fault('Invalid reclaim PTE');
        if (page) current.add(page);
      }
      const pinned = memoryGroupPinnedPages(this.memory, image.root);
      if (pinned === 'busy') return 'busy';
      for (const pin of image.nativeObservations) pinned.add(Math.floor(pin.physicalAddress / PAGE));
      const candidates = [...references].filter(page => !current.has(page) && !pinned.has(page));
      const released = new Set(candidates);
      for (const peer of this.images.values()) if (peer !== image) {
        for (const page of this.imageOwnedPages(peer, false)) if (released.has(page)) fault('Removed mapping overlaps another image');
      }
      const allocation = Uint32Array.from(candidates.sort((a, b) => a - b));
      const remaining = Uint32Array.from([...references].filter(page => !current.has(page) && !released.has(page)));
      const retained = remaining.length ? { pages: remaining } : undefined;
      const original = new Set(image.returnedOriginalPages);
      for (const page of candidates) {
        if (image.payload && page >= image.payload.first && page < image.payload.first + image.payload.pages
            || image.privatePayload?.includes(page)) original.add(page);
      }
      const result = { releasedPages: allocation.length, retainedPages: remaining.length };
      if (allocation.length && this.pool.tryReleaseRetiredPages(allocation) === 'busy') return 'busy';
      image.returnedOriginalPages = original.size ? original : undefined;
      image.retainedMappingPages = retained;
      return result;
    } finally { Atomics.store(lock, 0, 0); Atomics.notify(lock, 0, 1); }
  }

  replicaExecutionStopped(handle: PreparedGroupReplica): boolean { return this.owned(handle).state === 'stopped'; }

  /** Control pages stay mapped in the kernel's bounded cache. Return only the
   * retired replica's private scratch after proving both ranges have no wait
   * or host observation. Rust rebind authority is consumed under the pool lock
   * before any bit is freed; refusal leaves all storage with this owner. */
  tryReleaseStoppedThread(handle: PreparedGroupReplica, controlAddress: number, controlLength: number,
    releaseControl: () => boolean): 'released' | 'busy' {
    const replica = this.owned(handle), image = replica.image;
    if (this.closed || replica.receipt.pid === replica.receipt.tid || replica.state !== 'stopped'
        || replica.pendingWaitDrain) return 'busy';
    if (!memoryGroupU32(controlAddress, controlLength) || !controlLength || controlAddress % PAGE || controlLength % PAGE
        || controlAddress + controlLength > image.layout.maximumVirtualPages * PAGE) fault('Invalid exact thread control interval');
    const ranges = [{ start: replica.scratch.first * PAGE, end: (replica.scratch.first + replica.scratch.pages) * PAGE }];
    const table = new Uint32Array(this.memory.buffer, image.root + G.MEMORY_GROUP_ROOT_HEADER_BYTES, image.layout.maximumVirtualPages);
    for (let page = controlAddress / PAGE; page < (controlAddress + controlLength) / PAGE; page++) {
      const entry = Atomics.load(table, page), start = (entry >>> 16) * PAGE;
      if (!start || (entry & 0xffff) !== 3 || start + PAGE > this.memory.buffer.byteLength) fault('Invalid retired control PTE');
      ranges.push({ start, end: start + PAGE });
    }
    if ([...image.nativeObservations].some(pin => ranges.some(range => pin.physicalAddress >= range.start && pin.physicalAddress < range.end))) return 'busy';
    if (Atomics.load(this.controls(replica), G.MEMORY_GROUP_REPLICA_WAIT_NODE / 4) !== 0
        || memoryGroupReplicaWaitsRetired(this.memory, image.root, replica.scratch.first * PAGE, ranges) !== true) return 'busy';
    const allocation = Uint32Array.from(pages(replica.scratch));
    const result = this.pool.tryReleaseRetiredPages(allocation, releaseControl);
    if (result === 'busy') return result;
    this.handles.delete(handle); this.replicas.delete(replica.receipt.serial);
    return 'released';
  }

  /** Retry scheduling only. The bounded engine wait must actually settle and
   * the next entry must prove retirement again; elapsed time grants no reuse. */
  waitForThreadRetirementProgress(handle: PreparedGroupReplica): Promise<void> {
    const image = this.owned(handle).image, address = G.MEMORY_GROUP_CONTROL;
    const word = new Int32Array(this.memory.buffer, address, 1), expected = Atomics.load(word, 0);
    const pin = Object.freeze({ physicalAddress: address }); image.nativeObservations.add(pin);
    const observation = new NativeI32Observation(word, () => image.nativeObservations.delete(pin));
    const result = observation.arm(expected, 10);
    return result.async ? result.value.then(() => undefined) : Promise.resolve();
  }

  imageExecutionStopped(handle: PreparedGroupReplica): boolean {
    const image = this.owned(handle).image;
    return image.exposed && [...this.replicas.values()].filter(replica => replica.image === image)
      .every(replica => replica.state === 'stopped');
  }

  /** Whole-image release only. Live peers and within-image aliases must not
   * lose storage. Bitmap ownership has no per-PTE reference counts: collect
   * each physical allocation once, including removed mappings and native grow.
   * This does not implement per-thread/control or shared-object release. */
  tryReleaseStoppedImage(handle: PreparedGroupReplica): { readonly replicas: readonly PreparedGroupReplica[]; readonly pages: number } | 'busy' {
    const image = this.owned(handle).image;
    if (this.closed || image.sourceLive.value || !this.imageExecutionStopped(handle)
        || image.pause || image.mapping || image.nativeObservations.size) return 'busy';
    const replicas = [...this.replicas.values()].filter(replica => replica.image === image);
    for (const replica of replicas) {
      const control = this.controls(replica);
      if (Atomics.load(control, G.MEMORY_GROUP_REPLICA_WAIT_NODE / 4) !== 0) return 'busy';
    }
    if (memoryGroupImageWaitsRetired(this.memory, image.root) !== true) return 'busy';
    const key = imageKey(image.receipt);
    const lock = new Int32Array(this.memory.buffer, image.root + G.MEMORY_GROUP_ROOT_GROW_LOCK, 1);
    if (Atomics.compareExchange(lock, 0, 0, 1) !== 0) return 'busy';
    try {
      const owned = this.imageOwnedPages(image);
      for (const peer of this.images.values()) if (peer !== image) {
        for (const page of this.imageOwnedPages(peer, false)) if (owned.has(page)) fault('Retirement overlaps another image');
      }
      const allocation = Uint32Array.from([...owned].sort((a, b) => a - b));
      const result = Object.freeze({ replicas: Object.freeze(replicas.map(replica => replica.handle)), pages: allocation.length });
      // No actor of this image can run or create an observer after revocation.
      // Unlock its root before pool publication; a later allocator may zero and
      // reuse that same control page, so never write its lock after release.
      Atomics.store(lock, 0, 0); Atomics.notify(lock, 0, 1);
      if (this.pool.tryReleaseRetiredPages(allocation) === 'busy') return 'busy';
      this.images.delete(key);
      for (const replica of replicas) {
        this.handles.delete(replica.handle); this.replicas.delete(replica.receipt.serial);
      }
      image.retainedMappingPages = undefined;
      return result;
    } finally {
      // On success the root is no longer ours. Only an unreleased image may
      // receive this lock cleanup, including exceptions before pool mutation.
      if (this.images.get(key) === image) { Atomics.store(lock, 0, 0); Atomics.notify(lock, 0, 1); }
    }
  }

  private imageOwnedPages(image: Image, stable = true): Set<number> {
    const owned = new Set([...pages(image.controls),
      ...[...pages(image.payload), ...(image.privatePayload ?? [])].filter(page => !image.returnedOriginalPages?.has(page))]);
    const table = new Uint32Array(this.memory.buffer, image.root + G.MEMORY_GROUP_ROOT_HEADER_BYTES, image.layout.maximumVirtualPages);
    const extent = Atomics.load(new Uint32Array(this.memory.buffer, image.root, 1), 0);
    if (extent > image.layout.maximumVirtualPages) fault('Retiring image has invalid extent');
    for (let at = 0; at < table.length; at++) {
      const entry = Atomics.load(table, at), physical = entry >>> 16;
      if ((entry & 0xfffc) || (entry && !physical) || physical >= this.memory.buffer.byteLength / PAGE || (stable && at >= extent && entry)) {
        fault('Retiring image has invalid page custody');
      }
      if (physical) owned.add(physical);
    }
    for (let retired = image.retainedMappingPages; retired; retired = retired.next) for (const page of retired.pages) owned.add(page);
    for (const replica of this.replicas.values()) if (replica.image === image) for (const page of pages(replica.scratch)) owned.add(page);
    // An unpublished mapping may also own pages absent from both PTE versions.
    for (const page of image.mapping?.allocated ?? []) owned.add(page);
    return owned;
  }

  quarantine(handle: PreparedGroupReplica): void {
    const replica = this.owned(handle);
    if (replica.state === 'stopped') return;
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
      for (const waiter of replica.stopWaiters ?? []) waiter.reject(new ProcessAddressFault('retired'));
      replica.stopWaiters = undefined;
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
    readonly mappingStagingBytes: number; readonly retainedMappingReferences: number;
    readonly maximumPages: number; readonly highWaterPages: number; readonly physicalExtentPages: number } {
    let mappingStagingBytes = 0, retainedMappingReferences = 0;
    for (const image of this.images.values()) {
      const pending = image.mapping;
      mappingStagingBytes += (pending?.before?.byteLength ?? 0) + (pending?.after?.byteLength ?? 0)
        + (pending?.allocated?.byteLength ?? 0) + (pending?.retained?.pages.byteLength ?? 0);
      for (let retired = image.retainedMappingPages; retired; retired = retired.next) retainedMappingReferences += retired.pages.length;
    }
    return Object.freeze({ group: this.group, images: this.images.size, replicas: this.replicas.size,
      exposedReplicas: [...this.replicas.values()].filter(r => r.state === 'exposed').length,
      quarantinedReplicas: [...this.replicas.values()].filter(r => r.state === 'quarantined').length,
      pendingWaitDrains: [...this.replicas.values()].filter(r => r.pendingWaitDrain).length,
      nativeObservers: [...this.images.values()].reduce((sum, image) => sum + image.nativeObservations.size, 0),
      mappingStagingBytes, retainedMappingReferences,
      ...this.pool.snapshot() });
  }
}
