import { MEMORY_GROUP_PROTOCOL as P, ERRNO } from './generated/abi';
import * as G from './generated/program-extensions';
import { encodeMemoryGroupReceipt, decodeMemoryGroupReceipt, MemoryGroupProtocolFault,
  type MemoryGroupTaskReceipt, type GroupMemoryChangeDescription } from './memory-group-protocol';
import { GroupProcessAddressSpace, ProcessAddressFault, NativeI32Observation } from './process-address-space';
import { encodeProcessMemoryDescriptor, type GroupReplicaMemoryExpectation, type ProcessMemoryEnvelope } from './process-memory-descriptor';
import type { KernelVoidIngressScope } from './kernel-entry-gate';
import { validateKernelScratchRegionOwnership, type KernelScratchRegion } from './kernel-scratch';

declare const replicaBrand: unique symbol;
export interface PreparedGroupReplica { readonly [replicaBrand]: true }
declare const pauseBrand: unique symbol;
export interface GroupImageExecutionPause { readonly [pauseBrand]: true }
export interface GroupImageLayout { readonly initialVirtualPages: number; readonly maximumVirtualPages: number; readonly scratchBytes: number }
export interface GroupReplicaLaunch { readonly envelope: ProcessMemoryEnvelope; readonly source: GroupProcessAddressSpace; readonly expectation: GroupReplicaMemoryExpectation }
export interface GroupMemoryEntry { readonly scope: KernelVoidIngressScope; readonly instance: WebAssembly.Instance }
export interface GroupMemoryTransportHost {
  readonly memory: (resource: bigint) => WebAssembly.Memory;
  /** Queue a fresh kernel entry after the actual native observation settles. */
  readonly settleNative: (receipt: MemoryGroupTaskReceipt, token: bigint) => void;
}
interface Descriptor {
  readonly receipt: MemoryGroupTaskReceipt; readonly resource: bigint;
  readonly root: number; readonly replica: number; readonly scratch: number;
  readonly maximumPhysicalPages: number; readonly maximumVirtualPages: number; readonly scratchBytes: number;
}
export class GroupMemoryStorageRefusal extends Error {
  constructor(readonly errno: number) { super(`Kernel group storage refused: errno ${errno}`); }
}
interface Replica {
  readonly descriptor: Descriptor;
  readonly live: { value: boolean };
  readonly quiescent: Promise<void>;
  readonly resolveQuiescent: () => void;
  source?: GroupProcessAddressSpace;
}
interface ImageTransport {
  readonly root: number;
  readonly live: { value: boolean };
  source?: GroupProcessAddressSpace;
  readonly resumed: Set<() => void>;
}
interface Pause { readonly handle: PreparedGroupReplica; readonly epoch: bigint }
export interface PreparedGroupMapping {
  readonly receipt: MemoryGroupTaskReceipt;
  readonly token: bigint;
  readonly driver?: { readonly token: number; readonly transaction: bigint };
}
export interface GroupMemoryBackingSnapshot {
  readonly group: number; readonly images: number; readonly replicas: number;
  readonly exposedReplicas: number; readonly quarantinedReplicas: number; readonly allocatedPages: number;
  readonly pendingWaitDrains: number; readonly nativeObservers: number; readonly mappingStagingBytes: number;
  readonly retainedMappingReferences: number; readonly sharedObjects: number; readonly sharedPages: number;
  readonly sharedImageReferences: number; readonly maximumPages: number; readonly highWaterPages: number; readonly physicalExtentPages: number;
  readonly pausedImages: number; readonly unacknowledgedReplicas: number; readonly waitQueueLock: number; readonly waitQueueNodes: number;
}

/** Disposable-kernel platform transport. Every allocation, PTE transaction,
 * barrier, status and release decision is made by ProcessTable's Rust owner.
 * These maps retain JS sources, envelopes and completion Promises only; they
 * contain no page pool, shared-object table or physical lifetime decisions. */
export class GroupMemoryTransport {
  readonly #replicas = new Map<PreparedGroupReplica, Replica>();
  readonly #images = new Map<number, ImageTransport>();
  readonly #pauses = new WeakMap<GroupImageExecutionPause, Pause>();
  readonly #scratch: KernelScratchRegion;
  #closed = false;
  constructor(readonly group: number, private readonly host: GroupMemoryTransportHost,
    scratch: KernelScratchRegion, instance: WebAssembly.Instance) {
    this.#scratch = validateKernelScratchRegionOwnership(scratch, instance, 'group physical transport').region;
  }

  #fault(message: string): never { throw new MemoryGroupProtocolFault(message); }
  #replica(handle: PreparedGroupReplica): Replica { return this.#replicas.get(handle) ?? this.#fault('Unknown grouped platform handle'); }
  receipt(handle: PreparedGroupReplica): MemoryGroupTaskReceipt { return this.#replica(handle).descriptor.receipt; }
  #reply(bytes: Uint8Array, receipt: MemoryGroupTaskReceipt): Descriptor {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), fields = P.storage.reply_fields;
    return Object.freeze({ receipt: decodeMemoryGroupReceipt(bytes.slice(0, P.receipt_bytes), receipt),
      resource: view.getBigUint64(fields.resource, true), root: view.getUint32(fields.root, true),
      replica: view.getUint32(fields.replica, true), scratch: view.getUint32(fields.scratch, true),
      maximumPhysicalPages: view.getUint32(fields.maximumPhysicalPages, true),
      maximumVirtualPages: view.getUint32(fields.maximumVirtualPages, true), scratchBytes: view.getUint32(fields.scratchBytes, true) });
  }
  #adopt(descriptor: Descriptor): PreparedGroupReplica {
    if (this.#closed) this.#fault('Grouped platform transport is closed');
    const handle = Object.freeze(Object.create(null)) as PreparedGroupReplica;
    let resolveQuiescent!: () => void;
    const quiescent = new Promise<void>(resolve => { resolveQuiescent = resolve; });
    this.#replicas.set(handle, { descriptor, live: { value: true }, quiescent, resolveQuiescent });
    if (!this.#images.has(descriptor.root)) this.#images.set(descriptor.root, { root: descriptor.root, live: { value: true }, resumed: new Set() });
    return handle;
  }
  action(receipt: MemoryGroupTaskReceipt, action: number, entry: GroupMemoryEntry, token = 0n, argument = 0):
    { readonly status: number; readonly value: bigint; readonly bytes: Uint8Array } {
    return this.#scratch.withLease(lease => {
      lease.copyFrom(encodeMemoryGroupReceipt(receipt));
      const status = lease.invokeKernelExportScoped(entry.scope, 'kernel_memory_group_storage_action', [
        lease.exportPointer(0, P.receipt_bytes), P.receipt_bytes, action, token, argument,
        lease.exportPointer(P.receipt_bytes, P.storage.reply_bytes), P.storage.reply_bytes,
      ]);
      if (status < 0) return { status, value: 0n, bytes: new Uint8Array() };
      if (status !== P.storage.reply_bytes) this.#fault('Invalid kernel storage reply');
      const bytes = lease.copyOut(P.receipt_bytes, status);
      return { status: 0, bytes, value: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(P.storage.reply_fields.value, true) };
    });
  }
  #checked(handle: PreparedGroupReplica, action: number, entry: GroupMemoryEntry, token = 0n, argument = 0): bigint {
    const result = this.action(this.receipt(handle), action, entry, token, argument);
    if (result.status !== 0) this.#fault(`Kernel storage action ${action} refused: errno ${-result.status}`);
    return result.value;
  }
  #status(handle: PreparedGroupReplica, entry: GroupMemoryEntry): number { return Number(this.#checked(handle, P.storage.actions.status, entry)); }
  prepareImage(receipt: MemoryGroupTaskReceipt, layout: GroupImageLayout, entry: GroupMemoryEntry): PreparedGroupReplica {
    return this.#prepare(receipt, entry, layout);
  }
  prepareThread(receipt: MemoryGroupTaskReceipt, entry: GroupMemoryEntry): PreparedGroupReplica { return this.#prepare(receipt, entry); }
  #prepare(receipt: MemoryGroupTaskReceipt, entry: GroupMemoryEntry, layout?: GroupImageLayout): PreparedGroupReplica {
    if (this.#closed) this.#fault('Grouped platform transport is closed');
    const result = this.#scratch.withLease(lease => {
      lease.copyFrom(encodeMemoryGroupReceipt(receipt));
      const count = lease.invokeKernelExportScoped(entry.scope, 'kernel_memory_group_storage_prepare', [
        lease.exportPointer(0, P.receipt_bytes), P.receipt_bytes, layout?.initialVirtualPages ?? 0,
        layout?.maximumVirtualPages ?? 0, layout?.scratchBytes ?? 0,
        lease.exportPointer(P.receipt_bytes, P.storage.reply_bytes), P.storage.reply_bytes,
      ]);
      if (count === -ERRNO.ENOMEM) throw new RangeError('Admitted group memory is exhausted');
      if (count === -ERRNO.EAGAIN) throw new GroupMemoryStorageRefusal(ERRNO.EAGAIN);
      if (count !== P.storage.reply_bytes) this.#fault(`Kernel storage preparation refused: ${count}`);
      return this.#reply(lease.copyOut(P.receipt_bytes, count), receipt);
    });
    return this.#adopt(result);
  }
  preparePrivateFork(token: GroupImageExecutionPause, child: MemoryGroupTaskReceipt, entry: GroupMemoryEntry): PreparedGroupReplica | 'waiting' | 'busy' | 'exhausted' {
    if (this.#closed) this.#fault('Grouped platform transport is closed');
    const pause = this.#pause(token);
    return this.#scratch.withLease(lease => {
      lease.copyFrom(encodeMemoryGroupReceipt(this.receipt(pause.handle)));
      lease.copyFrom(encodeMemoryGroupReceipt(child), P.receipt_bytes);
      const count = lease.invokeKernelExportScoped(entry.scope, 'kernel_memory_group_storage_fork', [
        lease.exportPointer(0, P.receipt_bytes), P.receipt_bytes,
        lease.exportPointer(P.receipt_bytes, P.receipt_bytes), P.receipt_bytes, Number(pause.epoch),
        lease.exportPointer(P.receipt_bytes * 2, P.storage.reply_bytes), P.storage.reply_bytes,
      ]);
      if (count === -ERRNO.EAGAIN) return 'busy';
      if (count === -ERRNO.ENOMEM) return 'exhausted';
      if (count !== P.storage.reply_bytes) this.#fault(`Kernel physical fork refused: ${count}`);
      return this.#adopt(this.#reply(lease.copyOut(P.receipt_bytes * 2, count), child));
    });
  }
  #mapping(mapping: PreparedGroupMapping, command: number, entry: GroupMemoryEntry, argument = 0): number {
    return this.#scratch.withLease(lease => {
      lease.copyFrom(encodeMemoryGroupReceipt(mapping.receipt));
      return lease.invokeKernelExportScoped(entry.scope, 'kernel_memory_group_storage_mapping', [
        lease.exportPointer(0, P.receipt_bytes), P.receipt_bytes, command, mapping.token,
        mapping.driver?.token ?? 0, mapping.driver?.transaction ?? 0n, argument,
      ]);
    });
  }
  prepareImageMapping(token: GroupImageExecutionPause, description: GroupMemoryChangeDescription,
    entry: GroupMemoryEntry, driver?: PreparedGroupMapping['driver']): PreparedGroupMapping | 'waiting' | 'busy' | 'exhausted' {
    const pause = this.#pause(token);
    const mapping = Object.freeze({ receipt: description.receipt, token: description.token, driver });
    const status = this.#mapping(mapping, P.storage.mapping.stage, entry, Number(pause.epoch));
    if (status === -ERRNO.EAGAIN) return 'busy';
    if (status === -ERRNO.ENOMEM) return 'exhausted';
    if (status !== 0) this.#fault(`Kernel physical mapping preparation refused: ${status}`);
    return mapping;
  }
  advanceImageMapping(mapping: PreparedGroupMapping, entry: GroupMemoryEntry): number {
    return this.#mapping(mapping, P.storage.mapping.populate, entry);
  }
  commitImageMapping(mapping: PreparedGroupMapping, entry: GroupMemoryEntry): 'committed' | 'busy' | number {
    const status = this.#mapping(mapping, P.storage.mapping.commit, entry);
    return status === -ERRNO.EAGAIN ? 'busy' : status === 0 ? 'committed' : status;
  }
  cancelImageMapping(mapping: PreparedGroupMapping, entry: GroupMemoryEntry, errno = ERRNO.EIO): 'cancelled' | 'busy' {
    const status = this.#mapping(mapping, P.storage.mapping.cancel, entry, errno);
    if (status === -ERRNO.EAGAIN) return 'busy';
    if (status !== 0 && status !== -ERRNO.ESRCH) this.#fault(`Kernel mapping cancellation refused: ${status}`);
    return 'cancelled';
  }
  isUnexposed(handle: PreparedGroupReplica, entry: GroupMemoryEntry): boolean { return !!(this.#status(handle, entry) & P.storage.status.prepared); }
  imageHasExecutionPause(handle: PreparedGroupReplica, entry: GroupMemoryEntry): boolean { return !!(this.#status(handle, entry) & P.storage.status.paused); }
  imageStopRequested(handle: PreparedGroupReplica, entry: GroupMemoryEntry): boolean { return !!(this.#status(handle, entry) & P.storage.status.stopping); }
  replicaExecutionStopped(handle: PreparedGroupReplica, entry: GroupMemoryEntry): boolean { return !!(this.#status(handle, entry) & P.storage.status.stopped); }
  imageExecutionStopped(handle: PreparedGroupReplica, entry: GroupMemoryEntry): boolean { return !!(this.#status(handle, entry) & P.storage.status.imageStopped); }
  beginImageExecutionPause(handle: PreparedGroupReplica, entry: GroupMemoryEntry): GroupImageExecutionPause {
    const epoch = this.#checked(handle, P.storage.actions.beginImagePause, entry);
    const pause = Object.freeze(Object.create(null)) as GroupImageExecutionPause;
    this.#pauses.set(pause, { handle, epoch }); return pause;
  }
  #pause(token: GroupImageExecutionPause): Pause { return this.#pauses.get(token) ?? this.#fault('Unknown barrier transport token'); }
  imageExecutionPauseAcknowledged(token: GroupImageExecutionPause, entry: GroupMemoryEntry): boolean {
    const pause = this.#pause(token);
    return this.#checked(pause.handle, P.storage.actions.imagePauseAcknowledged, entry, pause.epoch) === 1n;
  }
  virtualExtentAtBarrier(token: GroupImageExecutionPause, entry: GroupMemoryEntry): number | 'waiting' | 'busy' {
    const pause = this.#pause(token), result = this.action(this.receipt(pause.handle), P.storage.actions.pausedExtent, entry, pause.epoch);
    if (result.status === -ERRNO.EAGAIN) return 'busy';
    if (result.status !== 0) this.#fault(`Kernel paused extent refused: ${result.status}`);
    return Number(result.value);
  }
  resumeImageExecutionPause(token: GroupImageExecutionPause, entry: GroupMemoryEntry): boolean {
    const pause = this.#pause(token), result = this.action(this.receipt(pause.handle), P.storage.actions.resumeImage, entry, pause.epoch);
    if (result.status === -ERRNO.ESRCH) return false;
    if (result.status !== 0) this.#fault(`Kernel barrier resume refused: ${result.status}`);
    this.#pauses.delete(token); this.#resumeWaiters(pause.handle); return true;
  }
  #resumeWaiters(handle: PreparedGroupReplica): void {
    const image = this.#images.get(this.#replica(handle).descriptor.root);
    for (const resolve of image?.resumed ?? []) resolve(); image?.resumed.clear();
  }
  waitForImageExecutionPause(handle: PreparedGroupReplica): Promise<void> {
    const image = this.#images.get(this.#replica(handle).descriptor.root)!;
    return new Promise(resolve => { image.resumed.add(resolve); });
  }
  publish(handle: PreparedGroupReplica, receipt: MemoryGroupTaskReceipt, entry: GroupMemoryEntry): GroupReplicaLaunch {
    const replica = this.#replica(handle), response = this.action(receipt, P.storage.actions.publish, entry);
    if (response.status !== 0) this.#fault(`Kernel storage publication refused: ${response.status}`);
    const descriptor = this.#reply(response.bytes, replica.descriptor.receipt), memory = this.host.memory(descriptor.resource), live = replica.live;
    const assertLive = () => { if (!live.value) throw new ProcessAddressFault('retired'); };
    const { resource: _resource, ...identity } = descriptor;
    const expectation = Object.freeze({ ...identity, assertLive });
    const envelope = encodeProcessMemoryDescriptor(memory, { kind: G.MEMORY_GROUP_MODULE,
      receipt: descriptor.receipt, root: descriptor.root, replica: descriptor.replica, scratch: descriptor.scratch,
      maximumVirtualPages: descriptor.maximumVirtualPages, scratchBytes: descriptor.scratchBytes }, { ...expectation, memory });
    const source = new GroupProcessAddressSpace({ memory, root: descriptor.root, maximumPages: descriptor.maximumVirtualPages, assertLive });
    replica.source = source;
    return Object.freeze({ envelope, source, expectation });
  }
  imageSource(handle: PreparedGroupReplica): GroupProcessAddressSpace {
    const replica = this.#replica(handle), descriptor = replica.descriptor, image = this.#images.get(descriptor.root)!;
    if (this.#closed || !image.live.value) throw new ProcessAddressFault('retired');
    if (!image.source) {
      const live = image.live;
      image.source = new GroupProcessAddressSpace({ memory: this.host.memory(descriptor.resource), root: descriptor.root,
        maximumPages: descriptor.maximumVirtualPages, assertLive: () => { if (!live.value) throw new ProcessAddressFault('retired'); } });
    }
    return image.source;
  }
  processRegistration(handle: PreparedGroupReplica): { readonly receipt: MemoryGroupTaskReceipt; readonly memory: WebAssembly.Memory; readonly source: GroupProcessAddressSpace; readonly maximumVirtualPages: number } {
    const descriptor = this.#replica(handle).descriptor;
    return Object.freeze({ receipt: descriptor.receipt, memory: this.host.memory(descriptor.resource), source: this.imageSource(handle), maximumVirtualPages: descriptor.maximumVirtualPages });
  }
  noteReplicaQuiescent(handle: PreparedGroupReplica, entry: GroupMemoryEntry): void {
    this.#checked(handle, P.storage.actions.noteQuiescent, entry);
    const replica = this.#replica(handle); replica.live.value = false; replica.source?.detachHostAccess(); replica.source = undefined; replica.resolveQuiescent();
  }
  waitForReplicaQuiescence(handle: PreparedGroupReplica): Promise<void> { return this.#replica(handle).quiescent; }
  waitForImageQuiescence(handle: PreparedGroupReplica): Promise<void> {
    const root = this.#replica(handle).descriptor.root;
    return Promise.all([...this.#replicas.values()].filter(replica => replica.descriptor.root === root).map(replica => replica.quiescent)).then(() => undefined);
  }
  requestReplicaStop(handle: PreparedGroupReplica, entry: GroupMemoryEntry): boolean {
    const result = this.action(this.receipt(handle), P.storage.actions.stopReplica, entry);
    if (result.status === -ERRNO.EAGAIN) return false;
    if (result.status !== 0) this.#fault(`Kernel replica stop refused: ${result.status}`);
    return true;
  }
  requestImageStop(handle: PreparedGroupReplica, entry: GroupMemoryEntry, naturalExitTid = 0): boolean {
    const result = this.action(this.receipt(handle), P.storage.actions.stopImage, entry, 0n, naturalExitTid);
    this.#resumeWaiters(handle);
    if (result.status === -ERRNO.EAGAIN) return false;
    if (result.status !== 0) this.#fault(`Kernel image stop refused: ${result.status}`);
    return true;
  }
  revokeImageAccess(handle: PreparedGroupReplica, entry: GroupMemoryEntry): void {
    this.#checked(handle, P.storage.actions.revokeSource, entry); this.#detachImage(handle);
  }
  #detachImage(handle: PreparedGroupReplica): void {
    const image = this.#images.get(this.#replica(handle).descriptor.root)!;
    image.live.value = false; image.source?.detachHostAccess(); image.source = undefined; this.#resumeWaiters(handle);
  }
  quarantine(handle: PreparedGroupReplica, entry: GroupMemoryEntry): void {
    const result = this.action(this.receipt(handle), P.storage.actions.quarantine, entry);
    const replica = this.#replica(handle); replica.live.value = false; replica.source?.detachHostAccess(); replica.source = undefined;
    if (result.status !== 0 && result.status !== -ERRNO.EAGAIN) this.#fault(`Kernel quarantine refused: ${result.status}`);
  }
  forgetCancelledReplica(handle: PreparedGroupReplica, entry: GroupMemoryEntry): void {
    // Rust cancelled both physical custody and admission in one operation.
    // This acknowledgement releases platform references only.
    const result = this.action(this.receipt(handle), P.storage.actions.status, entry);
    if (result.status !== -ERRNO.ESRCH) this.#fault(`Kernel cancellation acknowledgement refused: ${result.status}`);
    const replica = this.#replica(handle), receipt = replica.descriptor.receipt;
    replica.live.value = false; replica.source?.detachHostAccess(); replica.resolveQuiescent();
    if (receipt.pid === receipt.tid) {
      this.#detachImage(handle); this.#images.delete(replica.descriptor.root);
    }
    this.#replicas.delete(handle);
  }
  canReleaseUnexposedImage(receipt: MemoryGroupTaskReceipt, entry: GroupMemoryEntry): boolean {
    if (receipt.pid !== receipt.tid) return false;
    return this.action(receipt, P.storage.actions.status, entry).status === -ERRNO.ESRCH;
  }
  releaseUnexposedImage(receipt: MemoryGroupTaskReceipt): void {
    for (const [handle, replica] of this.#replicas) if (replica.descriptor.receipt.pid === receipt.pid && replica.descriptor.receipt.generation === receipt.generation) {
      replica.live.value = false; replica.source?.detachHostAccess(); this.#replicas.delete(handle); this.#images.delete(replica.descriptor.root);
    }
  }
  tryReclaimRemovedPages(handle: PreparedGroupReplica, entry: GroupMemoryEntry): { releasedPages: number; retainedPages: number } | 'busy' {
    const result = this.action(this.receipt(handle), P.storage.actions.reclaimRemoved, entry);
    if (result.status === -ERRNO.EAGAIN) return 'busy';
    if (result.status !== 0) this.#fault(`Kernel page reclamation refused: ${result.status}`);
    return { releasedPages: Number(result.value & 0xffffffffn), retainedPages: Number(result.value >> 32n) };
  }
  tryReleaseStoppedImage(handle: PreparedGroupReplica, entry: GroupMemoryEntry): { readonly replicas: readonly PreparedGroupReplica[]; readonly pages: number } | 'busy' {
    const result = this.action(this.receipt(handle), P.storage.actions.releaseStoppedImage, entry);
    if (result.status === -ERRNO.EAGAIN) return 'busy';
    if (result.status !== 0) this.#fault(`Kernel image retirement refused: ${result.status}`);
    const root = this.#replica(handle).descriptor.root, replicas: PreparedGroupReplica[] = [];
    for (const [key, replica] of this.#replicas) if (replica.descriptor.root === root) { replicas.push(key); this.#replicas.delete(key); }
    this.#images.delete(root); return { replicas, pages: Number(result.value) };
  }
  prepareChannelObservation(handle: PreparedGroupReplica, address: number, queue: boolean, entry: GroupMemoryEntry): NativeI32Observation {
    const result = this.action(this.receipt(handle), queue ? P.storage.actions.pinQueue : P.storage.actions.pinChannel, entry, 0n, address);
    if (result.status !== 0) this.#fault(`Kernel channel observation refused: ${result.status}`);
    return this.#nativeObservation(handle, result);
  }
  #nativeObservation(handle: PreparedGroupReplica, result: { bytes: Uint8Array; value: bigint }): NativeI32Observation {
    const receipt = this.receipt(handle), view = new DataView(result.bytes.buffer, result.bytes.byteOffset, result.bytes.byteLength);
    const address = view.getUint32(P.storage.reply_fields.waitAddress, true);
    const memory = this.host.memory(this.#replica(handle).descriptor.resource);
    return new NativeI32Observation(new Int32Array(memory.buffer, address, 1), () => { this.host.settleNative(receipt, result.value); });
  }
  prepareProgress(handle: PreparedGroupReplica, entry: GroupMemoryEntry, target: 'barrier' | 'locks' | 'pool', epoch = 0n): () => Promise<void> {
    const actions = P.storage.actions, receipt = this.receipt(handle);
    const result = this.action(receipt, target === 'barrier' ? actions.progressBarrier : target === 'locks' ? actions.progressLocks : actions.progressPool, entry, epoch);
    if (result.status !== 0) this.#fault(`Kernel progress observation refused: ${result.status}`);
    if (result.value === 0n) return () => Promise.resolve();
    const view = new DataView(result.bytes.buffer, result.bytes.byteOffset, result.bytes.byteLength);
    const expected = view.getUint32(P.storage.reply_fields.waitExpected, true);
    const observation = this.#nativeObservation(handle, result);
    return () => { const wait = observation.arm(expected, 10); return wait.async ? wait.value.then(() => undefined) : Promise.resolve(); };
  }
  prepareMappingProgress(token: GroupImageExecutionPause, entry: GroupMemoryEntry, target: 'barrier' | 'locks' | 'pool'): () => Promise<void> {
    const pause = this.#pause(token); return this.prepareProgress(pause.handle, entry, target, pause.epoch);
  }
  #releaseControl(receipt: MemoryGroupTaskReceipt, entry: GroupMemoryEntry): 'released' | 'busy' {
    const release = entry.instance.exports.kernel_group_memory_thread_control_release;
    if (typeof release !== 'function') this.#fault('Missing physical thread control release export');
    const result = Number(release(receipt.group, receipt.pid, receipt.tid, Number(receipt.serial & 0xffffffffn), Number(receipt.serial >> 32n),
      Number(receipt.generation & 0xffffffffn), Number(receipt.generation >> 32n)));
    if (result === -ERRNO.EAGAIN || result === -ERRNO.EBUSY) return 'busy';
    if (result !== 0) this.#fault(`Kernel thread control retirement refused: ${result}`);
    return 'released';
  }
  tryReleaseStoppedThread(handle: PreparedGroupReplica, entry: GroupMemoryEntry): 'released' | 'busy' {
    const result = this.#releaseControl(this.receipt(handle), entry);
    if (result === 'released') this.#replicas.delete(handle);
    return result;
  }
  containImage(handle: PreparedGroupReplica, entry: GroupMemoryEntry): void {
    const result = this.action(this.receipt(handle), P.storage.actions.containImage, entry);
    if (result.status !== 0 && result.status !== -ERRNO.EAGAIN) this.#fault(`Kernel image containment refused: ${result.status}`);
  }
  tryReleaseUnconstructedThreadControl(receipt: MemoryGroupTaskReceipt, entry: GroupMemoryEntry): 'released' | 'busy' { return this.#releaseControl(receipt, entry); }
  inspectReplicaWait(handle: PreparedGroupReplica, entry: GroupMemoryEntry): 'none' | 'waiting' | 'returning' | 'busy' {
    const result = this.action(this.receipt(handle), P.storage.actions.inspectWait, entry);
    if (result.status === -ERRNO.EAGAIN) return 'busy';
    if (result.status !== 0 || result.value > 2n) this.#fault(`Kernel replica wait inspection refused: ${result.status}`);
    return result.value === 0n ? 'none' : result.value === 1n ? 'waiting' : 'returning';
  }
  sweepFileObjects(entry: GroupMemoryEntry): void {
    const sweep = entry.instance.exports.kernel_memory_group_storage_sweep;
    if (typeof sweep !== 'function') this.#fault('Missing group object sweep export');
    const result = Number(sweep(this.group));
    if (result !== 0 && result !== -ERRNO.EAGAIN) this.#fault(`Kernel group object sweep refused: ${result}`);
  }
  trySnapshot(entry: GroupMemoryEntry): GroupMemoryBackingSnapshot | 'busy' {
    return this.#scratch.withLease(lease => {
      const count = lease.invokeKernelExportScoped(entry.scope, 'kernel_memory_group_storage_snapshot', [this.group,
        lease.exportPointer(0, P.storage.snapshot_bytes), P.storage.snapshot_bytes]);
      if (count === -ERRNO.EAGAIN) return 'busy';
      if (count !== P.storage.snapshot_bytes) this.#fault(`Kernel group storage snapshot refused: ${count}`);
      const bytes = lease.copyOut(0, count), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      return Object.freeze(Object.fromEntries(P.storage.snapshot_fields.map((field, at) => [field, view.getUint32(at * 4, true)]))) as unknown as GroupMemoryBackingSnapshot;
    });
  }
  snapshot(entry: GroupMemoryEntry): GroupMemoryBackingSnapshot {
    const result = this.trySnapshot(entry);
    if (result === 'busy') this.#fault('Group allocator snapshot is busy');
    return result;
  }
  close(): void {
    this.#closed = true;
    // Emergency JS detachment proves no physical release. The Rust group
    // and all of its uncertain Worker/native-wait charges remain retained.
    for (const image of this.#images.values()) { image.live.value = false; image.source?.detachHostAccess(); image.source = undefined; }
    for (const replica of this.#replicas.values()) { replica.live.value = false; replica.source?.detachHostAccess(); replica.source = undefined; }
  }
}
