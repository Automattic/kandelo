import { MEMORY_GROUP_PROTOCOL as P, ERRNO } from './generated/abi';
import * as G from './generated/program-extensions';
import { encodeMemoryGroupReceipt, decodeMemoryGroupReceipt, MemoryGroupProtocolFault,
  type MemoryGroupTaskReceipt } from './memory-group-protocol';
import { GroupProcessAddressSpace, ProcessAddressFault, NativeI32Observation } from './process-address-space';
import { encodeProcessMemoryDescriptor, type GroupReplicaMemoryExpectation, type ProcessMemoryEnvelope } from './process-memory-descriptor';
import type { KernelVoidIngressScope } from './kernel-entry-gate';
import { validateKernelScratchRegionOwnership, type KernelScratchRegion } from './kernel-scratch';

declare const replicaBrand: unique symbol;
export interface PreparedGroupReplica { readonly [replicaBrand]: true }
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
}
export type GroupMemoryBackingSnapshot = Readonly<Record<typeof P.storage.snapshot_fields[number], number>>;

export interface GroupOperationRequest {
  readonly kind: number; readonly syscall: number; readonly args: readonly bigint[];
  readonly payload?: Uint8Array;
}
export interface GroupExecControlEffect extends GroupOperationEffect { readonly receipt: MemoryGroupTaskReceipt }
export interface GroupCompletionRequest {
  readonly channel?: number; readonly token?: bigint; readonly observation?: bigint;
  readonly value?: bigint; readonly errno?: number; readonly argument?: number;
}
export interface GroupCompletionEffect {
  readonly receipt: MemoryGroupTaskReceipt; readonly effect: number; readonly flags: number;
  readonly token: bigint; readonly value: bigint; readonly errno: number; readonly channel: number;
  readonly resource: bigint; readonly observation: bigint; readonly address: number;
  readonly expected: number; readonly syscall: number; readonly requestFlags: number; readonly delay: number;
}
export interface GroupOperationEffect {
  readonly effect: number; readonly flags: number; readonly operation: bigint;
  readonly value: number; readonly errno: number; readonly length: number; readonly delay: number;
  readonly waitToken: bigint; readonly payload: Uint8Array;
  readonly storage: Uint8Array;
  readonly progress?: () => Promise<void>;
}

/** Disposable-kernel platform transport. Every allocation, PTE transaction,
 * barrier, status and release decision is made by ProcessTable's Rust owner.
 * These maps retain JS sources, envelopes and completion Promises only; they
 * contain no page pool, shared-object table or physical lifetime decisions. */
export class GroupMemoryTransport {
  readonly #replicas = new Map<PreparedGroupReplica, Replica>();
  readonly #images = new Map<number, ImageTransport>();
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
    if (!this.#images.has(descriptor.root)) this.#images.set(descriptor.root, { root: descriptor.root, live: { value: true } });
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

  operation(receipt: MemoryGroupTaskReceipt, command: number, token: bigint, argument: number,
    entry: GroupMemoryEntry, request?: GroupOperationRequest): GroupOperationEffect | undefined {
    const protocol = P.driver, begin = command === protocol.commands.begin;
    if (begin && this.#closed) this.#fault('Grouped platform transport is closed');
    const wire = new Uint8Array(begin ? protocol.request_bytes : 0);
    if (begin) {
      if (!request) this.#fault('Missing operation request');
      const view = new DataView(wire.buffer), fields = protocol.request_fields;
      view.setUint32(fields.kind, request.kind, true); view.setUint32(fields.syscall, request.syscall, true);
      for (let at = 0; at < 6; at++) view.setBigUint64(fields.args + at * 8, BigInt.asUintN(64, request.args[at] ?? 0n), true);
      if (request.payload) {
        if (request.payload.length !== protocol.payload_bytes) this.#fault('Invalid operation payload extent');
        wire.set(request.payload, fields.payload);
      }
    }
    const bytes = this.#scratch.withLease(lease => {
      lease.copyFrom(encodeMemoryGroupReceipt(receipt)); if (begin) lease.copyFrom(wire, P.receipt_bytes);
      const output = P.receipt_bytes + protocol.request_bytes;
      const count = lease.invokeKernelExportScoped(entry.scope, 'kernel_group_operation', [
        lease.exportPointer(0, P.receipt_bytes), P.receipt_bytes, command, token, argument,
        lease.exportPointer(P.receipt_bytes, wire.length), wire.length,
        lease.exportPointer(output, protocol.reply_bytes), protocol.reply_bytes,
      ]);
      if (count < 0) throw new GroupMemoryStorageRefusal(-count);
      if (command === protocol.commands.ack && count === 0) return undefined;
      if (count !== protocol.reply_bytes) this.#fault('Invalid operation reply extent');
      return lease.copyOut(output, count);
    });
    if (!bytes) return undefined;
    return this.#operationReply(bytes, receipt, begin ? undefined : token, command >= protocol.commands.forkNativePoll ? 'nativeLaunch' : 'operation');
  }

  execControl(receipt: MemoryGroupTaskReceipt, command: number, entry: GroupMemoryEntry, target = 0): GroupExecControlEffect {
    const bytes = this.#scratch.withLease(lease => {
      lease.copyFrom(encodeMemoryGroupReceipt(receipt));
      const count = lease.invokeKernelExportScoped(entry.scope, 'kernel_group_exec_control', [
        lease.exportPointer(0, P.receipt_bytes), P.receipt_bytes, command, target,
        lease.exportPointer(P.receipt_bytes, P.driver.reply_bytes), P.driver.reply_bytes,
      ]);
      if (count < 0) throw new GroupMemoryStorageRefusal(-count);
      if (count !== P.driver.reply_bytes) this.#fault('Invalid exec control reply extent');
      return lease.copyOut(P.receipt_bytes, count);
    });
    const at = P.driver.reply_fields.receipt;
    const future = decodeMemoryGroupReceipt(bytes.slice(at, at + P.receipt_bytes), command === P.exec_control.commands.begin
      ? { group: receipt.group, pid: receipt.pid, tid: receipt.pid, generation: receipt.generation + 1n } : receipt);
    return Object.freeze({ ...this.#operationReply(bytes, future, future.serial, 'exec'), receipt: future });
  }

  rootControl(pid: number, command: number, entry: GroupMemoryEntry, receipt?: MemoryGroupTaskReceipt,
    ceiling = 0, defaultSlots = 0): GroupExecControlEffect {
    const bytes = this.#scratch.withLease(lease => {
      lease.copyFrom(receipt ? encodeMemoryGroupReceipt(receipt) : new Uint8Array(P.receipt_bytes));
      const count = lease.invokeKernelExportScoped(entry.scope, 'kernel_group_root_control', [
        this.group, pid, lease.exportPointer(0, P.receipt_bytes), P.receipt_bytes, command, ceiling, defaultSlots,
        lease.exportPointer(P.receipt_bytes, P.driver.reply_bytes), P.driver.reply_bytes,
      ]);
      if (count < 0) throw new GroupMemoryStorageRefusal(-count);
      if (count !== P.driver.reply_bytes) this.#fault('Invalid root control reply extent');
      return lease.copyOut(P.receipt_bytes, count);
    });
    const at = P.driver.reply_fields.receipt;
    const identity = decodeMemoryGroupReceipt(bytes.slice(at, at + P.receipt_bytes), receipt ?? { group: this.group, pid, tid: pid });
    return Object.freeze({ ...this.#operationReply(bytes, identity, identity.serial, 'root'), receipt: identity });
  }

  retirementControl(receipt: MemoryGroupTaskReceipt, command: number, entry: GroupMemoryEntry, argument = 0): GroupOperationEffect {
    const bytes = this.#scratch.withLease(lease => {
      lease.copyFrom(encodeMemoryGroupReceipt(receipt));
      const count = lease.invokeKernelExportScoped(entry.scope, 'kernel_group_retirement_control', [
        lease.exportPointer(0, P.receipt_bytes), P.receipt_bytes, command, argument,
        lease.exportPointer(P.receipt_bytes, P.driver.reply_bytes), P.driver.reply_bytes,
      ]);
      if (count < 0) throw new GroupMemoryStorageRefusal(-count);
      if (count !== P.driver.reply_bytes) this.#fault('Invalid retirement control reply extent');
      return lease.copyOut(P.receipt_bytes, count);
    });
    return this.#operationReply(bytes, receipt, receipt.serial, 'retirement');
  }

  /** The actual kernel selects completion progression. This adapter copies the
   * versioned frame and preserves i64 results without a Number conversion. */
  completion(receipt: MemoryGroupTaskReceipt, command: number, entry: GroupMemoryEntry,
    request: GroupCompletionRequest = {}): GroupCompletionEffect {
    // Representation checks only. Rust validates commands, task identity and
    // every permitted field combination before changing transaction state.
    if ([command, request.channel ?? 0, request.errno ?? 0, request.argument ?? 0]
        .some(value => !Number.isSafeInteger(value) || value < 0 || value > 0xffffffff)
        || [request.token ?? 0n, request.observation ?? 0n]
          .some(value => typeof value !== 'bigint' || value < 0n || value > 0xffffffffffffffffn)
        || typeof (request.value ?? 0n) !== 'bigint'
        || (request.value ?? 0n) < -(1n << 63n) || (request.value ?? 0n) >= 1n << 63n) {
      this.#fault('Unrepresentable completion frame scalar');
    }
    const protocol = P.completion, fields = protocol.request_fields;
    const wire = new Uint8Array(protocol.request_bytes), input = new DataView(wire.buffer);
    wire.set(encodeMemoryGroupReceipt(receipt), fields.receipt);
    input.setUint32(fields.command, command, true);
    input.setUint32(fields.channel, request.channel ?? 0, true);
    input.setBigUint64(fields.token, request.token ?? 0n, true);
    input.setBigUint64(fields.observation, request.observation ?? 0n, true);
    input.setBigInt64(fields.value, request.value ?? 0n, true);
    input.setUint32(fields.errno, request.errno ?? 0, true);
    input.setUint32(fields.argument, request.argument ?? 0, true);
    const bytes = this.#scratch.withLease(lease => {
      lease.copyFrom(wire);
      const count = lease.invokeKernelExportScoped(entry.scope, 'kernel_group_completion', [
        lease.exportPointer(0, wire.length), wire.length,
        lease.exportPointer(wire.length, protocol.reply_bytes), protocol.reply_bytes,
      ]);
      if (count < 0) throw new GroupMemoryStorageRefusal(-count);
      if (count !== protocol.reply_bytes) this.#fault('Invalid completion reply extent');
      return lease.copyOut(wire.length, count);
    });
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), out = protocol.reply_fields;
    const effect = view.getUint32(out.effect, true);
    if (!Object.values(protocol.effects).includes(effect as any)) this.#fault('Invalid completion effect');
    // A whole-process signal barrier can select another exact thread's native
    // blocker. The kernel returns that task's receipt, not the caller's TID.
    const selected = decodeMemoryGroupReceipt(bytes.slice(out.receipt, out.receipt + P.receipt_bytes),
      effect === protocol.effects.interrupt
        ? { group: receipt.group, pid: receipt.pid, generation: receipt.generation,
          tid: view.getUint32(out.receipt + P.receipt_fields.tid, true) } : receipt);
    const token = view.getBigUint64(out.token, true);
    if (effect !== protocol.effects.interrupt && request.token !== undefined && request.token !== 0n
        && token !== request.token) this.#fault('Wrong completion reply token');
    return Object.freeze({ receipt: selected, effect, flags: view.getUint32(out.flags, true), token,
      value: view.getBigInt64(out.value, true), errno: view.getUint32(out.errno, true),
      channel: view.getUint32(out.channel, true), resource: view.getBigUint64(out.resource, true),
      observation: view.getBigUint64(out.observation, true), address: view.getUint32(out.address, true),
      expected: view.getUint32(out.expected, true), syscall: view.getUint32(out.syscall, true),
      requestFlags: view.getUint32(out.requestFlags, true), delay: view.getUint32(out.delay, true) });
  }

  /** Bind the actual engine observation to the Rust-selected physical word.
   * Its settlement callback reports a fact; only Rust can release its pin or
   * authorize a result. Repeated poll replies must reuse the same observation. */
  completionObservation(effect: GroupCompletionEffect, settled: () => void): NativeI32Observation {
    if (effect.effect !== P.completion.effects.observe || effect.observation === 0n) {
      this.#fault('Missing kernel completion observation');
    }
    const memory = this.host.memory(effect.resource);
    return new NativeI32Observation(new Int32Array(memory.buffer, effect.address, 1), settled);
  }
  detachRetiringImage(handle: PreparedGroupReplica): void { this.#detachImage(handle); }
  forgetRetiredExecution(handle: PreparedGroupReplica, image: boolean): readonly PreparedGroupReplica[] {
    const root = this.#replica(handle).descriptor.root, removed: PreparedGroupReplica[] = [];
    for (const [key, replica] of this.#replicas) if (key === handle || image && replica.descriptor.root === root) {
      replica.live.value = false; replica.source?.detachHostAccess(); replica.source = undefined;
      removed.push(key); this.#replicas.delete(key);
    }
    if (image) this.#images.delete(root);
    return removed;
  }

  #operationReply(bytes: Uint8Array, receipt: MemoryGroupTaskReceipt, token?: bigint, control: 'operation' | 'exec' | 'retirement' | 'root' | 'nativeLaunch' = 'operation'): GroupOperationEffect {
    const protocol = P.driver;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), fields = protocol.reply_fields;
    decodeMemoryGroupReceipt(bytes.slice(fields.receipt, fields.receipt + P.receipt_bytes), receipt);
    const operation = view.getBigUint64(fields.operation, true);
    if (operation === 0n || token !== undefined && operation !== token) this.#fault('Wrong operation reply token');
    const effect = view.getUint32(fields.effect, true), payloadBytes = view.getUint32(fields.payloadBytes, true);
    if ((!Object.values(protocol.effects).includes(effect as any) && !(control === 'exec' && Object.values(P.exec_control.effects).includes(effect as any))
        && !(control === 'root' && Object.values(P.root_control.effects).includes(effect as any))
        && !(control === 'retirement' && (effect === P.retirement_control.detach_platform || effect === P.retirement_control.detach_references || effect === P.retirement_control.cancel_exec_transport || effect === P.retirement_control.wait_workers
          || effect === P.retirement_control.contain_worker || effect === P.retirement_control.wait_thread_retirement || effect === P.retirement_control.join_image_retirement)))
        || payloadBytes !== 0 && payloadBytes !== protocol.payload_bytes) this.#fault('Invalid operation effect');
    const value = Number(view.getBigInt64(fields.value, true)), delay = view.getUint32(fields.delay, true);
    if (!Number.isSafeInteger(value) || delay > (control === 'nativeLaunch' ? 30000 : 1000)) this.#fault('Invalid operation result');
    const waitToken = view.getBigUint64(fields.waitToken, true);
    let progress: (() => Promise<void>) | undefined;
    if (effect === protocol.effects.native) {
      const observer = decodeMemoryGroupReceipt(bytes.slice(fields.storage, fields.storage + P.receipt_bytes),
        { group: receipt.group, pid: receipt.pid, tid: receipt.pid, generation: control === 'exec' ? undefined : receipt.generation });
      const resource = view.getBigUint64(fields.storage + P.storage.reply_fields.resource, true);
      const address = view.getUint32(fields.waitAddress, true), expected = view.getUint32(fields.waitExpected, true);
      const memory = this.host.memory(resource);
      const observation = new NativeI32Observation(new Int32Array(memory.buffer, address, 1),
        () => this.host.settleNative(observer, waitToken));
      progress = () => {
        const wait = observation.arm(expected, delay);
        return wait.async ? wait.value.then(() => undefined) : Promise.resolve();
      };
    }
    return Object.freeze({ effect, operation, flags: view.getUint32(fields.flags, true), value,
      errno: view.getUint32(fields.errno, true), length: view.getUint32(fields.length, true),
      delay, waitToken, progress, storage: bytes.slice(fields.storage, fields.storage + P.storage.reply_bytes),
      payload: bytes.slice(fields.payload, fields.payload + payloadBytes) });
  }
  #checked(handle: PreparedGroupReplica, action: number, entry: GroupMemoryEntry, token = 0n, argument = 0): bigint {
    const result = this.action(this.receipt(handle), action, entry, token, argument);
    if (result.status !== 0) this.#fault(`Kernel storage action ${action} refused: errno ${-result.status}`);
    return result.value;
  }
  #status(handle: PreparedGroupReplica, entry: GroupMemoryEntry): number { return Number(this.#checked(handle, P.storage.actions.status, entry)); }
  prepareImage(receipt: MemoryGroupTaskReceipt, layout: GroupImageLayout, entry: GroupMemoryEntry): PreparedGroupReplica {
    if (this.#closed) this.#fault('Grouped platform transport is closed');
    const result = this.#scratch.withLease(lease => {
      lease.copyFrom(encodeMemoryGroupReceipt(receipt));
      const count = lease.invokeKernelExportScoped(entry.scope, 'kernel_memory_group_storage_prepare', [
        lease.exportPointer(0, P.receipt_bytes), P.receipt_bytes, layout.initialVirtualPages,
        layout.maximumVirtualPages, layout.scratchBytes,
        lease.exportPointer(P.receipt_bytes, P.storage.reply_bytes), P.storage.reply_bytes,
      ]);
      if (count === -ERRNO.ENOMEM) throw new RangeError('Admitted group memory is exhausted');
      if (count === -ERRNO.EAGAIN) throw new GroupMemoryStorageRefusal(ERRNO.EAGAIN);
      if (count !== P.storage.reply_bytes) this.#fault(`Kernel storage preparation refused: ${count}`);
      return this.#reply(lease.copyOut(P.receipt_bytes, count), receipt);
    });
    return this.#adopt(result);
  }
  isUnexposed(handle: PreparedGroupReplica, entry: GroupMemoryEntry): boolean { return !!(this.#status(handle, entry) & P.storage.status.prepared); }
  replicaExecutionStopped(handle: PreparedGroupReplica, entry: GroupMemoryEntry): boolean { return !!(this.#status(handle, entry) & P.storage.status.stopped); }
  imageExecutionStopped(handle: PreparedGroupReplica, entry: GroupMemoryEntry): boolean { return !!(this.#status(handle, entry) & P.storage.status.imageStopped); }
  publish(handle: PreparedGroupReplica, receipt: MemoryGroupTaskReceipt, entry: GroupMemoryEntry): GroupReplicaLaunch {
    const response = this.action(receipt, P.storage.actions.publish, entry);
    if (response.status !== 0) this.#fault(`Kernel storage publication refused: ${response.status}`);
    return this.bindPublishedExecution(handle, response.bytes);
  }
  adoptExecution(bytes: Uint8Array, receipt: MemoryGroupTaskReceipt): PreparedGroupReplica {
    return this.#adopt(this.#reply(bytes, receipt));
  }
  bindPublishedExecution(handle: PreparedGroupReplica, bytes: Uint8Array): GroupReplicaLaunch {
    const replica = this.#replica(handle);
    const descriptor = this.#reply(bytes, replica.descriptor.receipt), memory = this.host.memory(descriptor.resource), live = replica.live;
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
  acceptReplicaStop(handle: PreparedGroupReplica): void {
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
    if (result.status === -ERRNO.EAGAIN) return false;
    if (result.status !== 0) this.#fault(`Kernel image stop refused: ${result.status}`);
    return true;
  }
  revokeImageAccess(handle: PreparedGroupReplica, entry: GroupMemoryEntry): void {
    this.#checked(handle, P.storage.actions.revokeSource, entry); this.#detachImage(handle);
  }
  #detachImage(handle: PreparedGroupReplica): void {
    const image = this.#images.get(this.#replica(handle).descriptor.root)!;
    image.live.value = false; image.source?.detachHostAccess(); image.source = undefined;
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
  prepareChannelObservation(handle: PreparedGroupReplica, receipt: MemoryGroupTaskReceipt, address: number, entry: GroupMemoryEntry): NativeI32Observation {
    const result = this.action(receipt, P.storage.actions.pinChannel, entry, 0n, address);
    if (result.status !== 0) this.#fault(`Kernel channel observation refused: ${result.status}`);
    // The handle identifies the actual backing object; the exact task receipt
    // identifies whose Rust pin must survive until native settlement.
    return this.#nativeObservation(handle, result, receipt);
  }
  #nativeObservation(handle: PreparedGroupReplica, result: { bytes: Uint8Array; value: bigint }, receipt = this.receipt(handle)): NativeI32Observation {
    const view = new DataView(result.bytes.buffer, result.bytes.byteOffset, result.bytes.byteLength);
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
  close(): void {
    this.#closed = true;
    // Emergency JS detachment proves no physical release. The Rust group
    // and all of its uncertain Worker/native-wait charges remain retained.
    for (const image of this.#images.values()) { image.live.value = false; image.source?.detachHostAccess(); image.source = undefined; }
    for (const replica of this.#replicas.values()) { replica.live.value = false; replica.source?.detachHostAccess(); replica.source = undefined; }
  }
}
