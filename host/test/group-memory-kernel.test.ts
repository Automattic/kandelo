import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { WasmPosixKernel, getWasmPosixKernelRuntimeAccess } from '../src/kernel';
import { createKernelEntryScopedInstance, type KernelVoidIngressScope } from '../src/kernel-entry-gate';
import { allocateKernelScratchRegion } from '../src/kernel-scratch';
import { ABI_SYSCALLS, HOST_INTERCEPTED_SYSCALLS, MEMORY_GROUP_PROTOCOL as P, ERRNO } from '../src/generated/abi';
import { decodeMemoryGroupReceipt, encodeMemoryGroupReceipt, encodeGroupMemoryLayout, type MemoryGroupTaskReceipt } from '../src/memory-group-protocol';
import { resolveBinary } from '../src/binary-resolver';
import { VirtualPlatformIO } from '../src/vfs/vfs';
import { NodeTimeProvider } from '../src/vfs/time';
import { FixedTreeBackend } from './support/fixed-tree-backend';
import { MEMORY_GROUP_CONTROL, MEMORY_GROUP_REPLICA_REQUEST, MEMORY_GROUP_REPLICA_ACK, MEMORY_GROUP_ROOT_HEADER_BYTES } from '../src/generated/program-extensions';

it('uses the real Rust kernel for storage preparation, exposure and exact pinned retirement', async () => {
  const io = new VirtualPlatformIO([{ mountPoint: '/', backend: new FixedTreeBackend({ '/': { mode: 0o040755, ino: 1 } }) }], new NodeTimeProvider());
  const kernel = new WasmPosixKernel({ maxWorkers: 1, dataBufferSize: 65536, useSharedMemory: true }, io);
  await kernel.init(Uint8Array.from(readFileSync(resolveBinary('kernel.wasm'))));
  const access = getWasmPosixKernelRuntimeAccess(kernel);
  const instance = access.instance()!;
  const scratch = allocateKernelScratchRegion(access.memory()!, instance.exports.kernel_alloc_scratch as (size: number) => number,
    4096, 4, 'real kernel group storage test', instance);
  function enter<T>(work: (scope: KernelVoidIngressScope) => T): T {
    let result: T;
    access.gate.runImmediateVoidIngress('real kernel storage operation', scope => { result = work(scope); return undefined; });
    return result!;
  }
  function scalar(name: string, ...args: (number | bigint)[]): number {
    return enter(scope => {
      const fn = createKernelEntryScopedInstance(instance, scope).exports[name];
      if (typeof fn !== 'function') throw Error(`Missing kernel export ${name}`);
      return Number(fn(...args));
    });
  }
  function task(receipt: MemoryGroupTaskReceipt, action: number): number {
    return enter(scope => scratch.withLease(lease => {
      lease.copyFrom(encodeMemoryGroupReceipt(receipt));
      return lease.invokeKernelExportScoped(scope, 'kernel_memory_group_task_action', [lease.exportPointer(0, P.receipt_bytes), P.receipt_bytes, action]);
    }));
  }
  function storage(receipt: MemoryGroupTaskReceipt, action: number, token = 0n, argument = 0): { status: number; bytes: Uint8Array; value: bigint } {
    return enter(scope => scratch.withLease(lease => {
      lease.copyFrom(encodeMemoryGroupReceipt(receipt));
      const status = lease.invokeKernelExportScoped(scope, 'kernel_memory_group_storage_action', [
        lease.exportPointer(0, P.receipt_bytes), P.receipt_bytes, action, token, argument,
        lease.exportPointer(32, P.storage.reply_bytes), P.storage.reply_bytes,
      ]);
      const bytes = status < 0 ? new Uint8Array(P.storage.reply_bytes) : lease.copyOut(32, P.storage.reply_bytes);
      return { status, bytes, value: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(P.storage.reply_fields.value, true) };
    }));
  }
  try {
    expect(scalar('kernel_memory_group_configure', 32, 1)).toBe(0);
    const group = scalar('kernel_memory_group_create', 32, 8, 16); expect(group).toBeGreaterThan(0);
    expect(scalar('kernel_memory_group_storage_create', group, 1)).toBe(0);
    const pid = scalar('kernel_create_process'); expect(pid).toBeGreaterThan(1);
    expect(scalar('kernel_memory_group_prepare_process', group, pid, 0, 0)).toBe(0);
    const receipt = enter(scope => scratch.withLease(lease => {
      expect(lease.invokeKernelExportScoped(scope, 'kernel_memory_group_task_receipt', [pid, pid, lease.exportPointer(0, P.receipt_bytes), P.receipt_bytes])).toBe(P.receipt_bytes);
      return decodeMemoryGroupReceipt(lease.copyOut(0, P.receipt_bytes), { group, pid, tid: pid, generation: 0n });
    }));
    const retire = (command: number, identity = receipt, argument = 0) => enter(scope => scratch.withLease(lease => {
      lease.copyFrom(encodeMemoryGroupReceipt(identity));
      const status = lease.invokeKernelExportScoped(scope, 'kernel_group_retirement_control', [
        lease.exportPointer(0, P.receipt_bytes), P.receipt_bytes, command, argument,
        lease.exportPointer(32, P.driver.reply_bytes), P.driver.reply_bytes,
      ]);
      const bytes = status < 0 ? new Uint8Array(P.driver.reply_bytes) : lease.copyOut(32, status);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      return { status, effect: view.getUint32(P.driver.reply_fields.effect, true),
        flags: view.getUint32(P.driver.reply_fields.flags, true),
        value: Number(view.getBigInt64(P.driver.reply_fields.value, true)),
        parent: view.getUint32(P.driver.reply_fields.length, true),
        pin: view.getBigUint64(P.driver.reply_fields.waitToken, true),
        resource: view.getBigUint64(P.driver.reply_fields.storage + P.storage.reply_fields.resource, true),
        root: view.getUint32(P.driver.reply_fields.storage + P.storage.reply_fields.root, true) };
    }));
    const prepared = enter(scope => scratch.withLease(lease => {
      lease.copyFrom(encodeMemoryGroupReceipt(receipt));
      expect(lease.invokeKernelExportScoped(scope, 'kernel_memory_group_storage_prepare', [
        lease.exportPointer(0, P.receipt_bytes), P.receipt_bytes, 3, 32, 65536,
        lease.exportPointer(32, P.storage.reply_bytes), P.storage.reply_bytes,
      ])).toBe(P.storage.reply_bytes);
      return lease.copyOut(32, P.storage.reply_bytes);
    }));
    const view = new DataView(prepared.buffer, prepared.byteOffset, prepared.byteLength), f = P.storage.reply_fields;
    const resource = view.getBigUint64(f.resource, true), root = view.getUint32(f.root, true), replica = view.getUint32(f.replica, true);
    const memory = access.groupMemory(resource);
    expect(Atomics.load(new Uint32Array(memory.buffer), root / 4)).toBe(3);
    expect(view.getUint32(f.maximumPhysicalPages, true)).toBe(32);
    expect(scalar('kernel_memory_group_storage_drop', group)).toBe(-ERRNO.EBUSY);
    const lock = new Int32Array(memory.buffer, MEMORY_GROUP_CONTROL, 1);
    expect(Atomics.compareExchange(lock, 0, 0, 1)).toBe(0);
    try {
      expect(task(receipt, P.task_actions.cancelUnconstructed)).toBe(-ERRNO.EAGAIN);
      expect(storage(receipt, P.storage.actions.describe).status).toBe(P.storage.reply_bytes);
    } finally { Atomics.store(lock, 0, 0); Atomics.notify(lock, 0); }
    // There is no host-callable physical-only cancellation path anymore.
    expect(storage(receipt, 3).status).toBe(-ERRNO.EINVAL);
    expect(task(receipt, P.task_actions.start)).toBe(0);
    expect(storage(receipt, P.storage.actions.publish).status).toBe(P.storage.reply_bytes);
    expect(retire(P.retirement_control.commands.bindReferences).status).toBe(P.driver.reply_bytes);
    expect(retire(P.retirement_control.commands.bindReferences).status).toBe(-ERRNO.EBUSY);
    expect(retire(P.retirement_control.commands.beginReferences).status).toBe(-ERRNO.EBUSY);
    expect(retire(P.retirement_control.commands.referencesDetached).status).toBe(-ERRNO.EBUSY);
    // Drive the real ProcessTable continuation without a second host VM model.
    // This fixture explicitly acknowledges its sole, non-executing replica.
    enter(scope => scratch.withLease(lease => {
      const layout = encodeGroupMemoryLayout(receipt, { initialPages: 3, maximumPages: 32, channel: 65536, mode: 'fresh',
        brkBase: 196608, mmapBase: 196608, brkLimit: 32 * 65536, controlBase: 0, controlEnd: 196608 });
      lease.copyFrom(layout);
      expect(lease.invokeKernelExportScoped(scope, 'kernel_group_memory_layout_install',
        [lease.exportPointer(0, layout.length), layout.length])).toBe(0);
    }));
    const driver = (command: number, token = 0n, syscall = ABI_SYSCALLS.Mmap, args: readonly bigint[] = [], argument = 0,
      identity = receipt, requestKind: number = P.driver.kinds.mapping) => enter(scope => scratch.withLease(lease => {
      const WIRE_PAYLOAD = P.driver.payload_bytes;
      const protocol = P.driver, wire = new Uint8Array(protocol.request_bytes), request = new DataView(wire.buffer);
      request.setUint32(protocol.request_fields.kind, requestKind, true);
      request.setUint32(protocol.request_fields.syscall, syscall, true);
      args.forEach((value, at) => request.setBigUint64(protocol.request_fields.args + at * 8, value, true));
      const begin = command === protocol.commands.begin, length = begin ? wire.length : 0, output = 416;
      lease.copyFrom(encodeMemoryGroupReceipt(identity)); if (begin) lease.copyFrom(wire, 32);
      const status = lease.invokeKernelExportScoped(scope, 'kernel_group_operation', [
        lease.exportPointer(0, 32), 32, command, token, argument,
        lease.exportPointer(32, length), length, lease.exportPointer(output, protocol.reply_bytes), protocol.reply_bytes,
      ]);
      const bytes = status === protocol.reply_bytes ? lease.copyOut(output, status) : new Uint8Array(protocol.reply_bytes);
      const view = new DataView(bytes.buffer), fields = protocol.reply_fields;
      return { status, effect: view.getUint32(fields.effect, true), errno: view.getUint32(fields.errno, true),
        token: view.getBigUint64(fields.operation, true), pin: view.getBigUint64(fields.waitToken, true),
        value: Number(view.getBigInt64(fields.value, true)), payload: bytes.slice(fields.payload, fields.payload + WIRE_PAYLOAD) };
    }));
    const finish = (initial: ReturnType<typeof driver>) => {
      let result = initial;
      for (let turn = 0; turn < 8 && result.effect !== P.driver.effects.complete; turn++) {
        expect(result.status).toBe(P.driver.reply_bytes);
        if (result.effect === P.driver.effects.native) {
          expect(result.pin).toBeGreaterThan(0n);
          // No engine observer was armed: report its actual unarmed release.
          expect(storage(receipt, P.storage.actions.settleNative, result.pin).status).toBe(P.storage.reply_bytes);
          const request = Atomics.load(new Int32Array(memory.buffer, replica + MEMORY_GROUP_REPLICA_REQUEST, 1), 0);
          Atomics.store(new Int32Array(memory.buffer, replica + MEMORY_GROUP_REPLICA_ACK, 1), 0, request);
        }
        result = driver(P.driver.commands.poll, initial.token);
      }
      expect(result.effect).toBe(P.driver.effects.complete);
      expect(driver(P.driver.commands.ack, result.token).status).toBe(0);
      expect(driver(P.driver.commands.poll, result.token).status).toBe(-ERRNO.ESRCH);
      return result;
    };
    // The canonical clone entry owns identity and the parent-TID transaction
    // before preparation. This fixture constructs no native Worker and reports
    // only the real release of its unarmed progress observation.
    const virtualWord = (address: number) => {
      const pte = Atomics.load(new Uint32Array(memory.buffer), (root + MEMORY_GROUP_ROOT_HEADER_BYTES + Math.floor(address / 65536) * 4) / 4);
      return new Uint32Array(memory.buffer, (pte & 0xffff0000) + address % 65536, 1);
    };
    Atomics.store(virtualWord(0x4000), 0, 0x1234);
    Atomics.store(virtualWord(0x4004), 0, 0x5678);
    const cloneArgs = [0x390100n, 0x17000n, 0x4000n, 0x13000n, 0x4004n, 0n];
    const clone = driver(P.driver.commands.begin, 0n, ABI_SYSCALLS.Clone, cloneArgs, 0, receipt, P.driver.kinds.clone);
    expect(clone.status).toBe(P.driver.reply_bytes);
    const cloneOffset = P.driver.thread_receipt_offset;
    const cloneBytes = clone.payload.slice(cloneOffset, cloneOffset + P.receipt_bytes);
    const cloneTid = new DataView(cloneBytes.buffer, cloneBytes.byteOffset, cloneBytes.byteLength).getUint32(P.receipt_fields.tid, true);
    const cloneTask = decodeMemoryGroupReceipt(cloneBytes, { group, pid, tid: cloneTid, generation: receipt.generation });
    expect(cloneTask.tid).toBeGreaterThan(pid);
    expect(Atomics.load(virtualWord(0x4000), 0)).toBe(cloneTask.tid);
    expect(scalar('kernel_validate_task', pid, cloneTask.tid)).toBe(0);
    expect(task(cloneTask, P.task_actions.start)).toBe(-ERRNO.EBUSY);
    expect(driver(P.driver.commands.ack, clone.token).status).toBe(-ERRNO.EBUSY);
    if (clone.effect === P.driver.effects.native) {
      expect(storage(receipt, P.storage.actions.settleNative, clone.pin).status).toBe(P.storage.reply_bytes);
    }
    // The actual Wasm export performs its kernel-owned thread-exit effect;
    // failed construction must not run the guest clear_child_tid side effect.
    const cloneFailure = driver(P.driver.commands.cancel, clone.token, ABI_SYSCALLS.Clone, [], ERRNO.EIO);
    expect(cloneFailure.status).toBe(P.driver.reply_bytes);
    expect(cloneFailure.effect).toBe(P.driver.effects.complete);
    expect(cloneFailure.errno).toBe(ERRNO.EIO);
    expect(Atomics.load(virtualWord(0x4000), 0)).toBe(0x1234);
    expect(Atomics.load(virtualWord(0x4004), 0)).toBe(0x5678);
    expect(scalar('kernel_validate_task', pid, cloneTask.tid)).toBe(-ERRNO.ESRCH);
    expect(task(cloneTask, P.task_actions.start)).toBe(-ERRNO.ESRCH);
    expect(driver(P.driver.commands.ack, clone.token).status).toBe(0);
    const mapping = driver(P.driver.commands.begin, 0n, ABI_SYSCALLS.Mmap, [0n, 65536n, 3n, 0x22n]);
    expect(driver(P.driver.commands.ack, mapping.token).status).toBe(-ERRNO.EBUSY);
    expect(driver(P.driver.commands.poll, mapping.token, ABI_SYSCALLS.Mmap, [], 0,
      { ...receipt, tid: receipt.tid + 1 }).status).toBe(-ERRNO.ESRCH);
    const mapped = finish(mapping); expect(mapped.errno).toBe(0); expect(mapped.value).toBeGreaterThanOrEqual(196608);
    const unmapped = finish(driver(P.driver.commands.begin, 0n, ABI_SYSCALLS.Munmap, [BigInt(mapped.value), 65536n]));
    expect(unmapped.errno).toBe(0);
    const cancelled = driver(P.driver.commands.begin, 0n, ABI_SYSCALLS.Mmap, [0n, 65536n, 3n, 0x22n]);
    expect(cancelled.effect).toBe(P.driver.effects.native);
    const refusal = driver(P.driver.commands.cancel, cancelled.token, ABI_SYSCALLS.Mmap, [], ERRNO.EINTR);
    expect(refusal.effect).toBe(P.driver.effects.complete); expect(refusal.errno).toBe(ERRNO.EINTR);
    expect(driver(P.driver.commands.ack, cancelled.token).status).toBe(0);
    expect(storage(receipt, P.storage.actions.settleNative, cancelled.pin).status).toBe(P.storage.reply_bytes);
    expect(storage(receipt, P.storage.actions.settleNative, cancelled.pin).status).toBe(-ERRNO.ESRCH);
    // A fork cannot consume its allocation or report a host launch before
    // the barrier. Cancellation retains the child until exact transport detach.
    // Seed the real linked-continuation anchor geometry in this nonexecuting
    // storage fixture; the SDK probes validate actual frame replay.
    const parentPte = Atomics.load(new Uint32Array(memory.buffer), (root + 64) / 4);
    Atomics.store(new Uint32Array(memory.buffer), ((parentPte & 0xffff0000) + 4096) / 4, 65536 + 32);
    let fork = driver(P.driver.commands.begin, 0n, HOST_INTERCEPTED_SYSCALLS.SYS_FORK, [], 0, receipt, P.driver.kinds.fork);
    expect(fork.effect).toBe(P.driver.effects.native);
    expect(driver(P.driver.commands.forkLaunched, fork.token).status).toBe(-ERRNO.EIO);
    expect(storage(receipt, P.storage.actions.settleNative, fork.pin).status).toBe(P.storage.reply_bytes);
    Atomics.store(new Int32Array(memory.buffer, replica + MEMORY_GROUP_REPLICA_ACK, 1), 0,
      Atomics.load(new Int32Array(memory.buffer, replica + MEMORY_GROUP_REPLICA_REQUEST, 1), 0));
    fork = driver(P.driver.commands.poll, fork.token);
    expect(fork.effect).toBe(P.driver.effects.forkLaunch);
    const childPid = new DataView(fork.payload.buffer, fork.payload.byteOffset, fork.payload.byteLength).getUint32(P.receipt_fields.pid, true);
    expect(childPid).toBeGreaterThan(pid);
    expect(scalar('kernel_get_process_state', childPid)).toBeGreaterThanOrEqual(0);
    const rollback = driver(P.driver.commands.cancel, fork.token, ABI_SYSCALLS.Mmap, [], ERRNO.ENOMEM);
    expect(rollback.effect).toBe(P.driver.effects.forkRemoveTransport);
    expect(scalar('kernel_get_process_state', childPid)).toBeGreaterThanOrEqual(0);
    expect(driver(P.driver.commands.ack, fork.token).status).toBe(-ERRNO.EBUSY);
    expect(driver(P.driver.commands.forkDetached, fork.token, ABI_SYSCALLS.Mmap, [], 0,
      { ...receipt, tid: receipt.tid + 1 }).status).toBe(-ERRNO.ESRCH);
    const removed = driver(P.driver.commands.forkDetached, fork.token);
    expect(removed.effect).toBe(P.driver.effects.complete); expect(removed.errno).toBe(ERRNO.ENOMEM);
    expect(scalar('kernel_get_process_state', childPid)).toBe(-ERRNO.ESRCH);
    expect(driver(P.driver.commands.ack, fork.token).status).toBe(0);
    const first = storage(receipt, P.storage.actions.beginImageOperation).value;
    const middle = storage(receipt, P.storage.actions.beginImageOperation).value;
    const last = storage(receipt, P.storage.actions.beginImageOperation).value;
    expect(first).toBeGreaterThan(0n);
    expect(storage(receipt, P.storage.actions.imageOperationReady, first).value).toBe(1n);
    expect(storage(receipt, P.storage.actions.finishImageOperation, middle).status).toBe(P.storage.reply_bytes);
    expect(storage(receipt, P.storage.actions.imageOperationReady, last).value).toBe(0n);
    expect(storage(receipt, P.storage.actions.beginImagePause).status).toBe(-ERRNO.EBUSY);
    expect(storage(receipt, P.storage.actions.beginImagePause, last).status).toBe(-ERRNO.EAGAIN);
    expect(storage(receipt, P.storage.actions.finishImageOperation, first).status).toBe(P.storage.reply_bytes);
    expect(storage(receipt, P.storage.actions.imageOperationReady, last).value).toBe(1n);
    expect(storage(receipt, P.storage.actions.finishImageOperation, first).status).toBe(-ERRNO.ESRCH);
    expect(task(receipt, P.task_actions.cancelUnconstructed)).toBe(-ERRNO.EBUSY);
    const pin = storage(receipt, P.storage.actions.pinNative, 0n, replica + 8); expect(pin.value).toBeGreaterThan(0n);
    expect(storage(receipt, P.storage.actions.stopImage).status).toBe(P.storage.reply_bytes);
    expect(storage(receipt, P.storage.actions.noteQuiescent).status).toBe(P.storage.reply_bytes);
    expect(storage(receipt, P.storage.actions.revokeSource).status).toBe(P.storage.reply_bytes);
    expect(storage(receipt, P.storage.actions.releaseStoppedImage).status).toBe(-ERRNO.EAGAIN);
    expect(storage(receipt, P.storage.actions.settleNative, pin.value).status).toBe(P.storage.reply_bytes);
    expect(storage(receipt, P.storage.actions.settleNative, pin.value).status).toBe(-ERRNO.ESRCH);
    expect(storage(receipt, P.storage.actions.releaseStoppedImage).status).toBe(-ERRNO.EAGAIN);
    expect(storage(receipt, P.storage.actions.finishImageOperation, last).status).toBe(P.storage.reply_bytes);
    // Native process state remains live: stopped physical backings alone do
    // not authorize discarding this process. Report the actual no-Worker fact.
    const commands = P.retirement_control.commands;
    expect(retire(commands.beginImage).status).toBe(-ERRNO.EBUSY);
    expect(retire(commands.noteWorkerAbsence).status).toBe(P.driver.reply_bytes);
    expect(storage(receipt, P.storage.actions.describe).status).toBe(-ERRNO.EIO);
    const admittedRetirement = retire(commands.beginImage);
    // The logical execution is still owned; Rust waits rather than releasing.
    expect(admittedRetirement.effect).toBe(P.driver.effects.native);
    expect(admittedRetirement.pin).toBeGreaterThan(0n);
    expect(admittedRetirement.resource).toBe(resource);
    expect(admittedRetirement.root).toBe(0);
    expect(retire(commands.ack).status).toBe(-ERRNO.EBUSY);
    expect(storage(receipt, P.storage.actions.releaseStoppedImage).status).toBe(-ERRNO.EAGAIN);
    expect(task(receipt, P.task_actions.beginRetirement)).toBe(0);
    expect(task(receipt, P.task_actions.retireQuiescent)).toBe(0);
    expect(storage(receipt, P.storage.actions.settleNative, admittedRetirement.pin).status).toBe(P.storage.reply_bytes);
    expect(retire(commands.poll).effect).toBe(P.retirement_control.detach_platform);
    expect(retire(commands.platformDetached).effect).toBe(P.retirement_control.detach_references);
    expect(retire(commands.platformDetached).status).toBe(-ERRNO.EBUSY);
    expect(retire(commands.referencesDetached, { ...receipt, serial: receipt.serial + 1n }).status).toBe(-ERRNO.ESRCH);
    expect(retire(commands.beginReferences).effect).toBe(P.retirement_control.detach_platform);
    expect(retire(commands.referencesDetached).effect).toBe(P.driver.effects.complete);
    expect(retire(commands.referencesDetached).status).toBe(-ERRNO.EBUSY);
    expect(retire(commands.ack).status).toBe(-ERRNO.EBUSY);
    expect(retire(commands.poll, { ...receipt, generation: 1n }).status).toBe(-ERRNO.ESRCH);
    // Even with all execution and native pins gone, the controller still
    // requires actual host detachment. The low-level release cannot bypass it.
    expect(storage(receipt, P.storage.actions.releaseStoppedImage).status).toBe(-ERRNO.EAGAIN);
    expect(storage(receipt, P.storage.actions.status).status).toBe(P.storage.reply_bytes);
    expect(retire(commands.poll).effect).toBe(P.driver.effects.complete);
    expect(storage(receipt, P.storage.actions.status).status).toBe(-ERRNO.ESRCH);
    expect(retire(commands.ack).status).toBe(P.driver.reply_bytes);
    expect(retire(commands.ack).status).toBe(-ERRNO.ESRCH);
    expect(scalar('kernel_memory_group_storage_drop', group)).toBe(0);
    expect(() => access.groupMemory(resource)).toThrow();
    expect(scalar('kernel_memory_group_seal', group)).toBe(0);
    expect(scalar('kernel_memory_group_remove', group)).toBe(0);
    expect(scalar('kernel_remove_process', pid)).toBe(0);

    // A stop continuation owns its exit event independently of the native
    // process. A real parent may reap before the host can publish onExit.
    const nextGroup = scalar('kernel_memory_group_create', 32, 8, 16);
    expect(nextGroup).toBeGreaterThan(group);
    expect(scalar('kernel_memory_group_storage_create', nextGroup, 1)).toBe(0);
    const nextPid = scalar('kernel_create_process');
    expect(scalar('kernel_memory_group_prepare_process', nextGroup, nextPid, 0, 0)).toBe(0);
    const nextReceipt = enter(scope => scratch.withLease(lease => {
      expect(lease.invokeKernelExportScoped(scope, 'kernel_memory_group_task_receipt',
        [nextPid, nextPid, lease.exportPointer(0, P.receipt_bytes), P.receipt_bytes])).toBe(P.receipt_bytes);
      return decodeMemoryGroupReceipt(lease.copyOut(0, P.receipt_bytes), { group: nextGroup, pid: nextPid, tid: nextPid, generation: 0n });
    }));
    enter(scope => scratch.withLease(lease => {
      lease.copyFrom(encodeMemoryGroupReceipt(nextReceipt));
      expect(lease.invokeKernelExportScoped(scope, 'kernel_memory_group_storage_prepare', [
        lease.exportPointer(0, P.receipt_bytes), P.receipt_bytes, 3, 32, 65536,
        lease.exportPointer(32, P.storage.reply_bytes), P.storage.reply_bytes,
      ])).toBe(P.storage.reply_bytes);
    }));
    expect(task(nextReceipt, P.task_actions.start)).toBe(0);
    expect(storage(nextReceipt, P.storage.actions.publish).status).toBe(P.storage.reply_bytes);
    expect(retire(commands.beginStop, nextReceipt).status).toBe(-ERRNO.EBUSY);
    const parent = scalar('kernel_get_parent_pid', nextPid);
    expect(scalar('kernel_set_current_tid', nextPid, nextPid)).toBe(0);
    expect(scalar('kernel_commit_process_exit', 37)).toBe(37);
    expect(retire(commands.beginStop, nextReceipt, nextPid + 10000).status).toBe(-ERRNO.ESRCH);
    expect(retire(commands.beginStop, nextReceipt).effect).toBe(P.retirement_control.wait_workers);
    expect(retire(commands.workersStopped, nextReceipt).status).toBe(-ERRNO.EBUSY);
    expect(retire(commands.ackStop, nextReceipt).status).toBe(-ERRNO.EBUSY);
    expect(storage(nextReceipt, P.storage.actions.noteQuiescent).status).toBe(P.storage.reply_bytes);
    expect(task(nextReceipt, P.task_actions.beginRetirement)).toBe(0);
    expect(task(nextReceipt, P.task_actions.retireQuiescent)).toBe(0);
    expect(scalar('kernel_reap_process', nextPid)).toBe(0);
    expect(scalar('kernel_get_process_state', nextPid)).toBe(-ERRNO.ESRCH);
    const stopped = retire(commands.workersStopped, nextReceipt);
    expect(stopped.effect).toBe(P.driver.effects.complete);
    expect(stopped.flags & P.retirement_control.publish_exit).toBe(P.retirement_control.publish_exit);
    expect(stopped.value).toBe(37); expect(stopped.parent).toBe(parent);
    expect(retire(commands.beginImage, nextReceipt).status).toBe(-ERRNO.EBUSY);
    expect(retire(commands.ackStop, nextReceipt).status).toBe(P.driver.reply_bytes);
    expect(retire(commands.ackStop, nextReceipt).status).toBe(-ERRNO.ESRCH);
    expect(retire(commands.beginImage, nextReceipt).effect).toBe(P.retirement_control.detach_platform);
    expect(retire(commands.platformDetached, nextReceipt).effect).toBe(P.driver.effects.complete);
    expect(retire(commands.ack, nextReceipt).status).toBe(P.driver.reply_bytes);
    expect(scalar('kernel_memory_group_storage_drop', nextGroup)).toBe(0);
    expect(scalar('kernel_memory_group_seal', nextGroup)).toBe(0);
    expect(scalar('kernel_memory_group_remove', nextGroup)).toBe(0);
  } finally { scratch.revoke(); }
}, 30_000);
