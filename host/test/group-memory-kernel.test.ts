import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { WasmPosixKernel, getWasmPosixKernelRuntimeAccess } from '../src/kernel';
import { createKernelEntryScopedInstance, type KernelVoidIngressScope } from '../src/kernel-entry-gate';
import { allocateKernelScratchRegion } from '../src/kernel-scratch';
import { MEMORY_GROUP_PROTOCOL as P, ERRNO } from '../src/generated/abi';
import { decodeMemoryGroupReceipt, encodeMemoryGroupReceipt, type MemoryGroupTaskReceipt } from '../src/memory-group-protocol';
import { resolveBinary } from '../src/binary-resolver';
import { VirtualPlatformIO } from '../src/vfs/vfs';
import { NodeTimeProvider } from '../src/vfs/time';
import { FixedTreeBackend } from './support/fixed-tree-backend';
import { MEMORY_GROUP_CONTROL } from '../src/generated/program-extensions';

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
    const prepared = enter(scope => scratch.withLease(lease => {
      lease.copyFrom(encodeMemoryGroupReceipt(receipt));
      expect(lease.invokeKernelExportScoped(scope, 'kernel_memory_group_storage_prepare', [
        lease.exportPointer(0, P.receipt_bytes), P.receipt_bytes, 2, 32, 65536,
        lease.exportPointer(32, P.storage.reply_bytes), P.storage.reply_bytes,
      ])).toBe(P.storage.reply_bytes);
      return lease.copyOut(32, P.storage.reply_bytes);
    }));
    const view = new DataView(prepared.buffer, prepared.byteOffset, prepared.byteLength), f = P.storage.reply_fields;
    const resource = view.getBigUint64(f.resource, true), root = view.getUint32(f.root, true), replica = view.getUint32(f.replica, true);
    const memory = access.groupMemory(resource);
    expect(Atomics.load(new Uint32Array(memory.buffer), root / 4)).toBe(2);
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
    expect(storage(receipt, P.storage.actions.releaseStoppedImage).value).toBe(5n);
    expect(task(receipt, P.task_actions.beginRetirement)).toBe(0);
    expect(task(receipt, P.task_actions.retireQuiescent)).toBe(0);
    expect(scalar('kernel_memory_group_retire_image', pid, 0, 0)).toBe(0);
    expect(scalar('kernel_memory_group_storage_drop', group)).toBe(0);
    expect(() => access.groupMemory(resource)).toThrow();
    expect(scalar('kernel_memory_group_seal', group)).toBe(0);
    expect(scalar('kernel_memory_group_remove', group)).toBe(0);
    expect(scalar('kernel_remove_process', pid)).toBe(0);
  } finally { scratch.revoke(); }
}, 30_000);
