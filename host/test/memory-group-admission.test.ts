import { encodeGroupMemoryChangeRequest, decodeGroupMemoryChangeDescription, encodeGroupMemoryLayout,
  encodeMemoryGroupReceipt, decodeGroupExecPreparation, MemoryGroupProtocolFault } from '../src/memory-group-protocol';
import { describe, expect, it, vi } from 'vitest';
import { createCentralizedKernelWorkerTestDouble, type CentralizedKernelCallbacks } from '../src/kernel-worker';
import { KernelEntryGate, createKernelEntryGatedInstance, KernelReentrantEntryError } from '../src/kernel-entry-gate';
import { allocateKernelScratchRegion } from '../src/kernel-scratch';
import { CH_TOTAL_SIZE, MEMORY_GROUP_PROTOCOL as P, PROCESS_STATE_RUNNING, PROCESS_STATE_EXITED, ABI_SYSCALLS as SYSCALLS,
  CH_STATUS, CH_SYSCALL, CH_ARGS, CH_ARG_SIZE, CH_RETURN, CH_ERRNO, CHANNEL_STATUS_PENDING, CHANNEL_STATUS_COMPLETE } from '../src/generated/abi';
import * as G from '../src/generated/program-extensions';
import { processDataView } from '../src/process-memory-views';
import { MemoryGroupPagePool } from '../src/memory-group-pool';
import { createKernelScratchTestInstance } from './support/kernel-scratch-instance';
import { writeForkContinuationAnchor } from '../src/fork-continuation';
import { FORK_SAVE_BUFFER_SIZE } from '../src/process-memory';
import { retryKernelEntryResult } from '../src/kernel-entry-retry';
import { HOST_INTERCEPTED_SYSCALLS, WPK_FORK_LINKED_FRAME_POINTER_WIDTHS } from '../src/generated/abi';
import { MockWorkerHandle } from '../src/worker-adapter';
import { DeferredWorkerHandle } from '../src/deferred-worker-handle';
import { ThreadPageAllocator } from '../src/thread-allocator';
import { emptyProcessTimerCleanup } from './kernel-worker-test-scratch';
const GENERATION = 0x8000000100000003n, SERIAL = 0xfffffffffffffff1n;
describe('copied future exec preparation records', () => {
  const expected = { group: 23, pid: 100, generation: GENERATION + 1n };
  function packet(initialPages = 149, maximumPages = 2048) {
    const bytes = new Uint8Array(P.exec_preparation.bytes);
    bytes.set(encodeMemoryGroupReceipt({ ...expected, tid: 100, serial: SERIAL }));
    const view = new DataView(bytes.buffer);
    view.setUint32(P.exec_preparation.fields.initialPages, initialPages, true);
    view.setUint32(P.exec_preparation.fields.maximumPages, maximumPages, true);
    return bytes;
  }
  it('preserves unsigned serial and future generation above the safe integer range', () => {
    const bytes = packet(), result = decodeGroupExecPreparation(bytes, expected);
    bytes.fill(0);
    expect(result).toEqual({ receipt: { ...expected, tid: 100, serial: SERIAL }, initialPages: 149, maximumPages: 2048 });
  });
  it('refuses a reservation for another group, process or image generation', () => {
    for (const wrong of [{ ...expected, group: 24 }, { ...expected, pid: 101 }, { ...expected, generation: GENERATION }]) {
      expect(() => decodeGroupExecPreparation(packet(), wrong)).toThrow(MemoryGroupProtocolFault);
    }
  });
  it('refuses truncated receipts and impossible virtual ceilings', () => {
    expect(() => decodeGroupExecPreparation(packet().subarray(0, 39), expected)).toThrow(MemoryGroupProtocolFault);
    for (const [initial, maximum] of [[149, 148], [0, 0], [149, 65537]]) {
      expect(() => decodeGroupExecPreparation(packet(initial, maximum), expected)).toThrow(MemoryGroupProtocolFault);
    }
    expect(() => encodeMemoryGroupReceipt({ ...expected, tid: 100, serial: 1n << 64n })).toThrow(MemoryGroupProtocolFault);
  });
});
const groupedOptions = { brkBase: 3 * 65536, brkLimit: 16 * 65536, mmapBase: 4 * 65536, controlBase: 0, controlEnd: 3 * 65536, maxAddr: 16 * 65536 };
function harness(pointerWidth: 4 | 8 = 4, callbacks: CentralizedKernelCallbacks = {}) {
  const layoutRecords: Uint8Array[] = [];
  const memory = new WebAssembly.Memory({ initial: 4, maximum: 8 }), gate = new KernelEntryGate();
  const implementations: Record<string, any> = {
    kernel_get_process_state: () => PROCESS_STATE_RUNNING,
    kernel_memory_group_protocol_version: () => P.version,
    kernel_memory_group_capabilities: () => P.capability_admission | P.mapping.capability | P.layout.capability,
    kernel_group_memory_layout_install: vi.fn((pointer: number | bigint, length: number) => { layoutRecords.push(new Uint8Array(memory.buffer, Number(pointer), length).slice()); return 0; }),
    kernel_group_memory_break: vi.fn(() => BigInt(3 * 65536)),
    kernel_group_memory_thread_control_reuse: vi.fn(() => -2n),
    kernel_group_memory_thread_control_release: vi.fn(() => 0),
    kernel_group_memory_fork: vi.fn(() => -95),
    kernel_clear_fork_child: vi.fn(() => 0),
    kernel_remove_process: vi.fn(() => 0),
    kernel_drain_wakeup_events: vi.fn(() => 0),
    kernel_drain_wait_completions: vi.fn(() => 0),
    kernel_wait_next_timeout_ns: vi.fn(() => -1n),
    kernel_group_memory_change_prepare: vi.fn(() => -95),
    kernel_group_memory_change_read: vi.fn(() => -95),
    kernel_group_memory_change_validate: vi.fn(() => -95),
    kernel_group_memory_change_commit: vi.fn(() => -95),
    kernel_group_memory_change_cancel: vi.fn(() => 0),
    kernel_set_current_tid: () => 0,
    kernel_take_process_timer_cleanup: emptyProcessTimerCleanup(memory),
    kernel_thread_exit: vi.fn(() => 0n),
    kernel_validate_task: vi.fn(() => 0),
    kernel_get_process_exit_signal: () => -1,
    kernel_mark_process_signaled: vi.fn(() => 0),
    kernel_dequeue_signal: vi.fn(() => 0),
    kernel_handle_guest_io: vi.fn(() => 0),
    kernel_handle_channel: vi.fn(() => 0),
    kernel_is_fd_nonblock: () => 0,
    kernel_get_socket_timeout_ms: () => -1n,
    kernel_rootfs_take_compaction_request: () => 0,
    kernel_blocking_retry_token: () => 701n,
    kernel_blocking_retry_release: vi.fn(() => 0),
    kernel_memory_group_configure: vi.fn(() => 0),
    kernel_memory_group_create: vi.fn(() => 23),
    kernel_memory_group_seal: vi.fn(() => 0),
    kernel_memory_group_remove: vi.fn(() => -16),
    kernel_memory_group_prepare_process: vi.fn(() => 0),
    kernel_memory_group_task_action: vi.fn((_pointer: number | bigint, _capacity: number, _action: number) => 0),
    kernel_memory_group_retire_image: vi.fn(() => 0),
    kernel_get_process_exec_generation: (pid: number, pointer: number | bigint, capacity: number) => {
      expect(pid).toBe(100); expect(capacity).toBe(8);
      new DataView(memory.buffer).setBigUint64(Number(pointer), GENERATION, true); return 8;
    },
    kernel_memory_group_task_receipt: (pid: number, tid: number, pointer: number | bigint, capacity: number) => {
      expect(capacity).toBe(P.receipt_bytes);
      const data = new DataView(memory.buffer, Number(pointer), capacity), f = P.receipt_fields;
      data.setUint32(f.group, 23, true); data.setUint32(f.pid, pid, true); data.setUint32(f.tid, tid, true);
      data.setUint32(f.reserved, 0, true); data.setBigUint64(f.serial, SERIAL, true); data.setBigUint64(f.generation, GENERATION, true);
      return capacity;
    },
    kernel_memory_group_snapshot: (group: number, pointer: number | bigint, capacity: number) => {
      expect(capacity).toBe(P.snapshot_bytes);
      const values = { group, maximumPages: 1024, maximumProcesses: 4, maximumTasks: 8,
        accepting: 1, processes: 1, tasks: 2, quarantinedTasks: 1, backings: 3, images: 2 };
      const view = new DataView(memory.buffer, Number(pointer), capacity);
      for (const [name, offset] of Object.entries(P.snapshot_fields)) view.setUint32(offset, values[name as keyof typeof values], true);
      return capacity;
    },
    kernel_set_max_addr: vi.fn(() => 0),
    kernel_set_process_pointer_width: vi.fn(() => 0),
    kernel_set_main_channel_addr: vi.fn(() => 0),
    kernel_vblank: () => 0,
  };
  const raw = createKernelScratchTestInstance(pointerWidth, memory, () => implementations,
    () => pointerWidth === 8 ? 4096n : 4096, 4, Object.keys(implementations));
  const instance = createKernelEntryGatedInstance(raw, gate);
  const scratch = allocateKernelScratchRegion(memory, instance.exports.kernel_alloc_scratch as (size: number) => number | bigint,
    CH_TOTAL_SIZE, pointerWidth, 'group admission test', instance);
  const worker = createCentralizedKernelWorkerTestDouble({ callbacks });
  worker.testAuthority.initializeKernelForTest({ instance, gate, mainScratch: scratch });
  return { worker, instance, implementations, memory, layoutRecords };
}
describe('kernel-Worker memory group admission', () => {
  it.each(['group', 'pid', 'tid', 'serial', 'generation'] as const)('refuses a terminal fence with the wrong %s', key => {
    const { worker, implementations } = harness();
    worker.createMemoryGroupBacking(23, 16);
    const receipt = worker.prepareMemoryGroupProcess(23, 100);
    if (typeof receipt === 'number') throw Error('missing admission');
    const handle = worker.prepareMemoryGroupImage(receipt, { initialVirtualPages: 4, maximumVirtualPages: 16, scratchBytes: 65536 });
    if (typeof handle === 'number') throw Error('missing image');
    worker.publishMemoryGroupReplica(handle);
    const concrete = new MockWorkerHandle();
    worker.observeMemoryGroupReplicaWorker(handle, concrete, { terminationProvesQuiescence: false });
    implementations.kernel_memory_group_task_action.mockClear();
    const forged = { ...receipt, [key]: typeof receipt[key] === 'bigint' ? receipt[key] as bigint ^ (1n << 32n) : Number(receipt[key]) + 1 };
    expect(() => concrete.simulateMessage({ type: 'memory_quiescent', pid: 100, memoryGroup: forged })).toThrow(/Wrong terminal/);
    expect(implementations.kernel_memory_group_task_action).not.toHaveBeenCalled();
  });
  it.each([true, false])('retires only its concrete Worker fence (Node join=%s), keeping physical pages charged', joins => {
    const { worker, implementations } = harness();
    worker.createMemoryGroupBacking(23, 16);
    const receipt = worker.prepareMemoryGroupProcess(23, 100);
    if (typeof receipt === 'number') throw Error('missing admission');
    const handle = worker.prepareMemoryGroupImage(receipt, { initialVirtualPages: 4, maximumVirtualPages: 16, scratchBytes: 65536 });
    if (typeof handle === 'number') throw Error('missing image');
    const concrete = new MockWorkerHandle(), other = new MockWorkerHandle();
    expect(() => worker.observeMemoryGroupReplicaWorker(handle, concrete, { terminationProvesQuiescence: joins })).toThrow(/published/);
    const launch = worker.publishMemoryGroupReplica(handle);
    if (typeof launch === 'number') throw Error('missing launch');
    worker.registerMemoryGroupProcess(handle, [65536], groupedOptions);
    const allocated = worker.inspectMemoryGroupBacking(23)!.allocatedPages;
    worker.observeMemoryGroupReplicaWorker(handle, concrete, { terminationProvesQuiescence: joins });
    expect(() => worker.observeMemoryGroupReplicaWorker(handle, other, { terminationProvesQuiescence: joins })).toThrow(/already/);
    implementations.kernel_memory_group_task_action.mockClear();
    const fence = { type: 'memory_quiescent', pid: 100, memoryGroup: receipt };
    other.simulateMessage(fence);
    concrete.simulateMessage({ type: 'exit', pid: 100, status: 23 });
    expect(implementations.kernel_memory_group_task_action).not.toHaveBeenCalled();
    concrete.simulateExit(0);
    if (!joins) expect(implementations.kernel_memory_group_task_action).not.toHaveBeenCalled();
    concrete.simulateMessage(fence);
    concrete.simulateMessage(fence); concrete.simulateExit(0);
    expect(implementations.kernel_memory_group_task_action.mock.calls.map((c: any[]) => c[2]))
      .toEqual([P.task_actions.beginRetirement, P.task_actions.retireQuiescent]);
    expect(implementations.kernel_drain_wait_completions).toHaveBeenCalledTimes(1);
    expect(worker.inspectMemoryGroupBacking(23)).toMatchObject({ allocatedPages: allocated, exposedReplicas: 0 });
    expect(() => launch.source.readBytes(0, 1)).toThrow();
    // The kernel image source survives to publish the final wait completion.
    expect((worker as any).processes.get(100).source.readBytes(0, 1)).toEqual(Uint8Array.of(0));
  });
  it('seals only the exact observed deferred Worker and retires its captured receipt once', async () => {
    const h = harness(); h.worker.createMemoryGroupBacking(23, 16);
    const receipt = h.worker.prepareMemoryGroupProcess(23, 100); if (typeof receipt === 'number') throw Error('receipt');
    const handle = h.worker.prepareMemoryGroupImage(receipt, { initialVirtualPages: 4, maximumVirtualPages: 16, scratchBytes: 65536 });
    if (typeof handle === 'number') throw Error('handle'); h.worker.publishMemoryGroupReplica(handle);
    const create = vi.fn(() => new MockWorkerHandle()), worker = new DeferredWorkerHandle(create), other = new DeferredWorkerHandle(create);
    h.worker.observeMemoryGroupReplicaWorker(handle, worker, { terminationProvesQuiescence: false });
    const charged = h.worker.inspectMemoryGroupBacking(23)!.allocatedPages; h.implementations.kernel_memory_group_task_action.mockClear();
    expect(h.worker.sealMemoryGroupReplicaWorkerAbsence(handle, other)).toBe(false);
    expect(other.start()).toBe(true);
    expect(h.worker.sealMemoryGroupReplicaWorkerAbsence({} as any, worker)).toBe(false);
    expect(h.worker.sealMemoryGroupReplicaWorkerAbsence(handle, worker)).toBe(true);
    await h.worker.waitForMemoryGroupReplicaQuiescence(handle);
    expect(worker.start()).toBe(false); expect(create).toHaveBeenCalledTimes(1);
    expect(h.worker.sealMemoryGroupReplicaWorkerAbsence(handle, worker)).toBe(false);
    expect(h.implementations.kernel_memory_group_task_action.mock.calls.map((c: any[]) => c[2])).toEqual([P.task_actions.beginRetirement, P.task_actions.retireQuiescent]);
    expect(h.worker.inspectMemoryGroupBacking(23)).toMatchObject({ allocatedPages: charged, replicas: 1, exposedReplicas: 0 });
  });
  it.each([true, false])('never treats an attempted constructor or no-backing terminate as absence (Node joins=%s)', async joins => {
    const h = harness(); h.worker.createMemoryGroupBacking(23, 16);
    const receipt = h.worker.prepareMemoryGroupProcess(23, 100); if (typeof receipt === 'number') throw Error('receipt');
    const handle = h.worker.prepareMemoryGroupImage(receipt, { initialVirtualPages: 4, maximumVirtualPages: 16, scratchBytes: 65536 });
    if (typeof handle === 'number') throw Error('handle'); h.worker.publishMemoryGroupReplica(handle);
    const worker = new DeferredWorkerHandle(() => { throw Error('uncertain constructor'); });
    h.worker.observeMemoryGroupReplicaWorker(handle, worker, { terminationProvesQuiescence: joins });
    const charged = h.worker.inspectMemoryGroupBacking(23)!.allocatedPages; h.implementations.kernel_memory_group_task_action.mockClear();
    expect(() => worker.start()).toThrow('uncertain constructor'); await worker.terminate();
    expect(h.worker.sealMemoryGroupReplicaWorkerAbsence(handle, worker)).toBe(false);
    expect(h.implementations.kernel_memory_group_task_action).not.toHaveBeenCalled();
    expect(h.worker.inspectMemoryGroupBacking(23)).toMatchObject({ allocatedPages: charged, exposedReplicas: 1 });
  });
  it('seals a stale deferred launch before accepting its old receipt solely for retirement', async () => {
    const h = harness(); h.worker.createMemoryGroupBacking(23, 16);
    const receipt = h.worker.prepareMemoryGroupProcess(23, 100); if (typeof receipt === 'number') throw Error('receipt');
    const handle = h.worker.prepareMemoryGroupImage(receipt, { initialVirtualPages: 4, maximumVirtualPages: 16, scratchBytes: 65536 });
    if (typeof handle === 'number') throw Error('handle'); h.worker.publishMemoryGroupReplica(handle);
    h.implementations.kernel_memory_group_task_receipt = () => -3;
    const create = vi.fn(() => new MockWorkerHandle()), worker = new DeferredWorkerHandle(create);
    h.worker.observeMemoryGroupReplicaWorker(handle, worker, { terminationProvesQuiescence: false });
    await h.worker.waitForMemoryGroupReplicaQuiescence(handle);
    expect(worker.start()).toBe(false); expect(create).not.toHaveBeenCalled();
    expect(h.worker.inspectMemoryGroupBacking(23)).toMatchObject({ exposedReplicas: 0, replicas: 1 });
  });
  it('allocates only a kernel-reserved backing and publishes after the exact start action', () => {
    const { worker, implementations, memory } = harness();
    expect(worker.createMemoryGroupBacking(23, 8)).toBe(0);
    expect(worker.createMemoryGroupBacking(23, 8)).toBe(-16);
    const receipt = worker.prepareMemoryGroupProcess(23, 100);
    if (typeof receipt === 'number') throw Error('missing admission');
    const layout = { initialVirtualPages: 2, maximumVirtualPages: 16, scratchBytes: 65536 };
    expect(worker.prepareMemoryGroupImage({ ...receipt, serial: receipt.serial - (1n << 32n) }, layout)).toBe(-3);
    expect(worker.inspectMemoryGroupBacking(23)?.images).toBe(0);
    const handle = worker.prepareMemoryGroupImage(receipt, layout);
    if (typeof handle === 'number') throw Error('missing allocation');
    expect(worker.inspectMemoryGroupBacking(23)).toMatchObject({ images: 1, replicas: 1, exposedReplicas: 0, maximumPages: 1024 });
    implementations.kernel_memory_group_task_action = vi.fn((pointer: number | bigint, capacity: number, action: number) => {
      const data = new DataView(memory.buffer, Number(pointer), capacity), f = P.receipt_fields;
      expect(capacity).toBe(P.receipt_bytes); expect(action).toBe(P.task_actions.start);
      expect(data.getBigUint64(f.serial, true)).toBe(SERIAL);
      expect(data.getBigUint64(f.generation, true)).toBe(GENERATION);
      expect(data.getUint32(f.reserved, true)).toBe(0);
      // The backing is not published before Rust accepts this action.
      expect(worker.inspectMemoryGroupBacking(23)?.exposedReplicas).toBe(0);
      return 0;
    });
    const launch = worker.publishMemoryGroupReplica(handle);
    if (typeof launch === 'number') throw Error('missing launch');
    expect(launch.source.byteLength).toBe(2 * 65536);
    expect(launch.envelope.descriptor).toMatchObject({ receipt, scratchBytes: 65536 });
    expect(worker.cancelUnexposedMemoryGroupReplica(handle)).toBe(-22);
    expect(worker.publishMemoryGroupReplica(handle)).toBe(-22);
    expect(worker.removeEmptyMemoryGroup(23)).toBe(-16);
    expect(implementations.kernel_memory_group_remove).not.toHaveBeenCalled();
  });
  it('cancels an unexposed allocation with exact Rust custody before returning its pages', () => {
    const { worker, implementations } = harness();
    expect(worker.createMemoryGroupBacking(23, 8)).toBe(0);
    const receipt = worker.prepareMemoryGroupProcess(23, 100);
    if (typeof receipt === 'number') throw Error('missing admission');
    const handle = worker.prepareMemoryGroupImage(receipt, { initialVirtualPages: 2, maximumVirtualPages: 16, scratchBytes: 65536 });
    if (typeof handle === 'number') throw Error('missing allocation');
    implementations.kernel_memory_group_task_action = vi.fn(() => {
      expect(worker.inspectMemoryGroupBacking(23)?.allocatedPages).toBe(6); return 0;
    });
    implementations.kernel_memory_group_retire_image = vi.fn((pid: number, low: number, high: number) => {
      expect(pid).toBe(100); expect(low >>> 0).toBe(3); expect(high >>> 0).toBe(0x80000001);
      expect(worker.inspectMemoryGroupBacking(23)?.allocatedPages).toBe(4); return 0;
    });
    expect(worker.cancelUnexposedMemoryGroupReplica(handle)).toBe(0);
    expect(worker.inspectMemoryGroupBacking(23)).toMatchObject({ allocatedPages: 1, images: 0, replicas: 0 });
    expect(worker.cancelUnexposedMemoryGroupReplica(handle)).toBe(-22);
  });
  it('preserves local allocations if start or rollback is refused by Rust', () => {
    const { worker, implementations } = harness(); worker.createMemoryGroupBacking(23, 8);
    const receipt = worker.prepareMemoryGroupProcess(23, 100);
    if (typeof receipt === 'number') throw Error('missing admission');
    const handle = worker.prepareMemoryGroupImage(receipt, { initialVirtualPages: 2, maximumVirtualPages: 16, scratchBytes: 65536 });
    if (typeof handle === 'number') throw Error('missing allocation');
    const before = worker.inspectMemoryGroupBacking(23);
    implementations.kernel_memory_group_task_action = vi.fn(() => -11);
    expect(worker.publishMemoryGroupReplica(handle)).toBe(-11);
    expect(worker.cancelUnexposedMemoryGroupReplica(handle)).toBe(-11);
    expect(worker.inspectMemoryGroupBacking(23)).toEqual(before);
  });
  it('revokes published access on a fatal generation without returning unfenced storage', () => {
    const { worker, implementations } = harness(); worker.createMemoryGroupBacking(23, 8);
    const receipt = worker.prepareMemoryGroupProcess(23, 100);
    if (typeof receipt === 'number') throw Error('missing admission');
    const handle = worker.prepareMemoryGroupImage(receipt, { initialVirtualPages: 2, maximumVirtualPages: 16, scratchBytes: 65536 });
    if (typeof handle === 'number') throw Error('missing allocation');
    // A refusal before publication leaves unconstructed rollback available.
    implementations.kernel_memory_group_task_action = vi.fn(() => -11);
    expect(worker.publishMemoryGroupReplica(handle)).toBe(-11);
    implementations.kernel_memory_group_task_action = vi.fn(() => 0);
    const launch = worker.publishMemoryGroupReplica(handle);
    if (typeof launch === 'number') throw Error('missing launch');
    worker.failPersistenceWriter(new Error('fixture fatal generation'));
    expect(() => launch.source.readBytes(0, 1)).toThrow();
    expect(worker.inspectMemoryGroupBacking(23)).toMatchObject({ allocatedPages: 6, quarantinedReplicas: 1 });
  });
  it('quarantines a real descriptor failure after Rust has accepted replica start', () => {
    const { worker, implementations, memory } = harness(); worker.createMemoryGroupBacking(23, 16);
    const original = implementations.kernel_memory_group_task_receipt;
    implementations.kernel_memory_group_task_receipt = (pid: number, tid: number, pointer: number | bigint, capacity: number) => {
      const size = original(pid, tid, pointer, capacity);
      new DataView(memory.buffer, Number(pointer), capacity).setBigUint64(P.receipt_fields.serial, SERIAL + BigInt(tid - pid), true);
      return size;
    };
    const receipt = worker.prepareMemoryGroupProcess(23, 100);
    if (typeof receipt === 'number') throw Error('missing admission');
    const main = worker.prepareMemoryGroupImage(receipt, { initialVirtualPages: 2, maximumVirtualPages: 16, scratchBytes: 65536 });
    if (typeof main === 'number') throw Error('missing allocation');
    const launch = worker.publishMemoryGroupReplica(main);
    if (typeof launch === 'number' || launch.envelope.descriptor.kind === 'linear') throw Error('missing grouped launch');
    const peerReceipt = worker.readMemoryGroupTaskReceipt(100, 101);
    if (typeof peerReceipt === 'number') throw Error('missing peer receipt');
    const peer = worker.prepareMemoryGroupThread(peerReceipt);
    if (typeof peer === 'number') throw Error('missing peer allocation');
    const before = worker.inspectMemoryGroupBacking(23)?.allocatedPages;
    // Trusted-group corruption is a real post-Start validation failure, not a
    // mocked thrown constructor. The kernel owner must retain its allocation.
    new Uint32Array(launch.envelope.memory.buffer, launch.envelope.descriptor.root, 3)[2] = 2 * 65536;
    let failure: unknown;
    try { worker.publishMemoryGroupReplica(peer); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ cause: { message: 'Replica root disagrees with its admitted virtual limits' } });
    // An exception escaping the serialized kernel entry poisons the whole
    // generation, so even the already published main accessor is revoked.
    expect(worker.inspectMemoryGroupBacking(23)).toMatchObject({ allocatedPages: before, quarantinedReplicas: 2, exposedReplicas: 0 });
    expect(implementations.kernel_memory_group_task_action.mock.calls.map((call: any[]) => call[2]))
      .toEqual([P.task_actions.start, P.task_actions.start, P.task_actions.beginRetirement, P.task_actions.quarantine]);
    expect(() => worker.cancelUnexposedMemoryGroupReplica(peer)).toThrow();
    expect(() => launch.source.readBytes(0, 1)).toThrow();
  });
  it('refuses in-place admission of an already registered native image', () => {
    const { worker, implementations } = harness();
    worker.testAuthority.replaceProcessRegistrationForLifecycleTest({ pid: 100,
      memory: new WebAssembly.Memory({ initial: 3, maximum: 3, shared: true }), channelOffsets: [] });
    expect(worker.prepareMemoryGroupProcess(23, 100)).toBe(-16);
    expect(implementations.kernel_memory_group_prepare_process).not.toHaveBeenCalled();
  });
  it('registers only the published main image and never creates a physical channel view', () => {
    const { worker, implementations } = harness();
    worker.createMemoryGroupBacking(23, 16);
    const receipt = worker.prepareMemoryGroupProcess(23, 100);
    if (typeof receipt === 'number') throw Error('missing admission');
    const handle = worker.prepareMemoryGroupImage(receipt,
      { initialVirtualPages: 4, maximumVirtualPages: 16, scratchBytes: 65536 });
    if (typeof handle === 'number') throw Error('missing image');
    expect(() => worker.registerMemoryGroupProcess(handle, [65536], groupedOptions)).toThrow(/published main/);
    const launch = worker.publishMemoryGroupReplica(handle);
    if (typeof launch === 'number') throw Error('missing launch');
    worker.registerMemoryGroupProcess(handle, [65536], { ...groupedOptions, maxAddr: 16 * 65536 });
    const registration = (worker as any).processes.get(100);
    expect(registration.source).not.toBe(launch.source);
    expect(registration.source).not.toBe(launch.envelope.memory);
    launch.source.writeBytes(77, Uint8Array.of(91));
    expect(registration.source.readBytes(77, 1)).toEqual(Uint8Array.of(91));
    expect(registration.channels[0]).toMatchObject({ source: registration.source, channelOffset: 65536 });
    expect(registration.channels[0].i32View).toBeUndefined();
    expect(registration.execGeneration).toBe(GENERATION);
    expect(implementations.kernel_set_main_channel_addr).not.toHaveBeenCalled();
    expect(implementations.kernel_group_memory_layout_install).toHaveBeenCalledTimes(1);
    expect(implementations.kernel_set_max_addr).not.toHaveBeenCalled();
    expect(() => worker.registerMemoryGroupProcess(handle, [65536], groupedOptions)).toThrow(/already installed/);
    // Withdrawal of a host record does not make a published task a new image.
    (worker as any).processes.delete(100);
    expect(() => worker.registerMemoryGroupProcess(handle, [65536], groupedOptions)).toThrow(/already installed/);
  });
  it.each(['serial', 'group', 'generation'] as const)('refuses a stale %s before publishing a grouped registration', field => {
    const { worker, implementations, memory } = harness();
    worker.createMemoryGroupBacking(23, 16);
    const receipt = worker.prepareMemoryGroupProcess(23, 100);
    if (typeof receipt === 'number') throw Error('missing admission');
    const handle = worker.prepareMemoryGroupImage(receipt,
      { initialVirtualPages: 4, maximumVirtualPages: 16, scratchBytes: 65536 });
    if (typeof handle === 'number') throw Error('missing image');
    worker.publishMemoryGroupReplica(handle);
    if (field === 'generation') {
      implementations.kernel_get_process_exec_generation = (_pid: number, pointer: number | bigint) => {
        new DataView(memory.buffer).setBigUint64(Number(pointer), GENERATION ^ (1n << 32n), true); return 8;
      };
    }
    const original = implementations.kernel_memory_group_task_receipt;
    implementations.kernel_memory_group_task_receipt = (...args: any[]) => {
      const result = original(...args), view = new DataView(memory.buffer, Number(args[2]), args[3]);
      if (field === 'group') view.setUint32(P.receipt_fields.group, 24, true);
      else view.setBigUint64(P.receipt_fields[field], (field === 'serial' ? SERIAL : GENERATION) ^ (1n << 32n), true);
      return result;
    };
    expect(() => worker.registerMemoryGroupProcess(handle, [65536], groupedOptions)).toThrow(/exact kernel task image/);
    expect(worker.configureMemoryGroups(2048, 2)).toBe(0);
    expect((worker as any).processes.has(100)).toBe(false);
    expect(implementations.kernel_set_main_channel_addr).not.toHaveBeenCalled();
  });
  it('checks the complete virtual channel and layout before Rust registration writes', () => {
    const { worker, implementations } = harness();
    worker.createMemoryGroupBacking(23, 16);
    const receipt = worker.prepareMemoryGroupProcess(23, 100);
    if (typeof receipt === 'number') throw Error('missing admission');
    const handle = worker.prepareMemoryGroupImage(receipt,
      { initialVirtualPages: 4, maximumVirtualPages: 16, scratchBytes: 65536 });
    if (typeof handle === 'number') throw Error('missing image');
    worker.publishMemoryGroupReplica(handle);
    expect(() => worker.registerMemoryGroupProcess({} as any, [65536], groupedOptions)).toThrow(/Unknown/);
    expect(() => worker.registerMemoryGroupProcess(handle, [4 * 65536 - CH_TOTAL_SIZE + 4], groupedOptions)).toThrow();
    expect(() => worker.registerMemoryGroupProcess(handle, [65537], groupedOptions)).toThrow(/aligned/);
    expect(() => worker.registerMemoryGroupProcess(handle, [65536], { ...groupedOptions, ptrWidth: 8 })).toThrow(/wasm32/);
    expect(() => worker.registerMemoryGroupProcess(handle, [65536], { ...groupedOptions, borrowedAddressSpace: true })).toThrow(/owned image/);
    expect(() => worker.registerMemoryGroupProcess(handle, [65536], { ...groupedOptions, maxAddr: 17 * 65536 })).toThrow(/virtual ceiling/);
    expect(implementations.kernel_set_main_channel_addr).not.toHaveBeenCalled();
    expect((worker as any).processes.has(100)).toBe(false);
  });
  it('refuses a native registration for an admitted grouped image', () => {
    const { worker } = harness();
    const memory = new WebAssembly.Memory({ initial: 3, maximum: 3, shared: true });
    expect(() => worker.registerProcess(100, memory, [65536])).toThrow('Grouped process requires explicit virtual-memory registration');
  });
  it.each([4, 8] as const)('uses scoped metadata and exact unsigned receipts at kernel width %s', width => {
    const { worker, implementations, memory } = harness(width);
    expect(worker.configureMemoryGroups(2048, 2)).toBe(0);
    expect(worker.createMemoryGroup(1024, 4, 8)).toBe(23);
    expect(implementations.kernel_memory_group_create).toHaveBeenCalledWith(1024, 4, 8);
    const main = worker.prepareMemoryGroupProcess(23, 100);
    expect(main).toEqual({ group: 23, pid: 100, tid: 100, serial: SERIAL, generation: GENERATION });
    const args = implementations.kernel_memory_group_prepare_process.mock.calls[0];
    expect(args.slice(0, 3)).toEqual([23, 100, 3]); expect(args[3] >>> 0).toBe(0x80000001);
    expect(worker.readMemoryGroupTaskReceipt(100, 101)).toEqual({ group: 23, pid: 100, tid: 101, serial: SERIAL, generation: GENERATION });
    const snapshot = worker.inspectMemoryGroup(23);
    expect(snapshot).toMatchObject({ group: 23, accepting: true, tasks: 2, quarantinedTasks: 1, backings: 3, images: 2 });
    new Uint8Array(memory.buffer, 4096, 128).fill(0);
    expect(main).toMatchObject({ group: 23, generation: GENERATION, serial: SERIAL });
    expect(snapshot).toMatchObject({ group: 23, tasks: 2 });
    expect(Object.isFrozen(main)).toBe(true); expect(Object.isFrozen(snapshot)).toBe(true);
    expect(worker.sealMemoryGroup(23)).toBe(0); expect(worker.removeEmptyMemoryGroup(23)).toBe(-16);
  });
  it('refuses busy result-bearing calls without retaining any later operation', () => {
    const { worker, instance, implementations } = harness();
    const snapshot = vi.spyOn(implementations, 'kernel_memory_group_snapshot');
    const calls = [() => worker.configureMemoryGroups(2048, 2), () => worker.createMemoryGroup(1024, 4, 8),
      () => worker.sealMemoryGroup(23), () => worker.removeEmptyMemoryGroup(23),
      () => worker.inspectMemoryGroup(23), () => worker.prepareMemoryGroupProcess(23, 100),
      () => worker.readMemoryGroupTaskReceipt(100, 101)];
    calls.push(() => worker.createMemoryGroupBacking(23, 8));
    calls.push(() => worker.prepareMemoryGroupImage({ group: 23, pid: 100, tid: 100, serial: SERIAL, generation: GENERATION },
      { initialVirtualPages: 2, maximumVirtualPages: 16, scratchBytes: 65536 }));
    calls.push(() => worker.publishMemoryGroupReplica({} as any));
    calls.push(() => worker.cancelUnexposedMemoryGroupReplica({} as any));
    calls.push(() => worker.registerMemoryGroupProcess({} as any, [65536], groupedOptions));
    implementations.kernel_vblank = () => { for (const call of calls) expect(call).toThrow(KernelReentrantEntryError); return 0; };
    (instance.exports.kernel_vblank as () => void)();
    expect(implementations.kernel_memory_group_configure).not.toHaveBeenCalled();
    expect(implementations.kernel_memory_group_create).not.toHaveBeenCalled();
    expect(implementations.kernel_memory_group_prepare_process).not.toHaveBeenCalled();
    expect(snapshot).not.toHaveBeenCalled();
  });
  it('rejects wide/fractional numeric values before Wasm can truncate them', () => {
    const { worker, implementations } = harness();
    for (const bad of [-1, 0x100000001, 1.5, NaN, Infinity]) {
      expect(worker.createMemoryGroup(bad, 1, 1)).toBe(-22);
      expect(worker.inspectMemoryGroup(bad)).toBe(-22);
      expect(worker.prepareMemoryGroupProcess(23, bad)).toBe(-22);
    }
    expect(implementations.kernel_memory_group_create).not.toHaveBeenCalled();
    expect(implementations.kernel_memory_group_prepare_process).not.toHaveBeenCalled();
  });
  it('leaves optional admission unavailable under an unknown protocol', () => {
    const { worker, implementations } = harness(); implementations.kernel_memory_group_protocol_version = () => P.version + 1;
    expect(worker.createMemoryGroup(1024, 4, 8)).toBe(-95);
    expect(worker.inspectMemoryGroup(23)).toBe(-95);
    expect(implementations.kernel_memory_group_create).not.toHaveBeenCalled();
  });
  it('preserves admission refusal without attempting to retrieve a receipt', () => {
    const { worker, implementations } = harness(); implementations.kernel_memory_group_prepare_process = vi.fn(() => -12);
    const receipt = vi.spyOn(implementations, 'kernel_memory_group_task_receipt');
    expect(worker.prepareMemoryGroupProcess(23, 100)).toBe(-12); expect(receipt).not.toHaveBeenCalled();
  });
  it.each(['length', 'generation', 'reserved'] as const)('contains an invalid %s receipt instead of publishing invented ownership', kind => {
    const { worker, implementations, memory } = harness(), original = implementations.kernel_memory_group_task_receipt;
    implementations.kernel_memory_group_task_receipt = (pid: number, tid: number, pointer: number | bigint, capacity: number) => {
      const count = original(pid, tid, pointer, capacity), view = new DataView(memory.buffer, Number(pointer), capacity);
      if (kind === 'generation') view.setBigUint64(P.receipt_fields.generation, 0n, true);
      if (kind === 'reserved') view.setUint32(P.receipt_fields.reserved, 1, true);
      return kind === 'length' ? count - 1 : count;
    };
    expect(() => worker.prepareMemoryGroupProcess(23, 100)).toThrow(/receipt/i);
    expect(() => worker.createMemoryGroup(1024, 4, 8)).toThrow();
  });
});


describe('grouped mapping metadata transport', () => {
  const page = 65536;
  function description() {
    const receipt = { group: 23, pid: 100, tid: 101, serial: 0xfffffffffffffff1n, generation: 0x8000000100000003n };
    const bytes = new Uint8Array(P.mapping.description_bytes), view = new DataView(bytes.buffer);
    const r = P.receipt_fields, f = P.mapping.description_fields;
    for (const key of ['group', 'pid', 'tid'] as const) view.setUint32(r[key], receipt[key], true);
    view.setBigUint64(r.serial, receipt.serial, true); view.setBigUint64(r.generation, receipt.generation, true);
    view.setBigUint64(f.token, 0xfffffffffffffffdn, true); view.setUint32(f.kind, P.mapping.kinds.map, true);
    view.setUint32(f.prot, 3, true); view.setUint32(f.flags, 0x22, true);
    view.setBigUint64(f.address, BigInt(4 * page), true); view.setBigUint64(f.length, BigInt(page), true);
    view.setBigUint64(f.result, BigInt(4 * page), true);
    return { receipt, bytes, view, f };
  }
  it('bounds file population to the exact new map or remap tail', () => {
    const { receipt, bytes, view, f } = description();
    view.setBigUint64(f.populationAddress, BigInt(4 * page), true);
    view.setBigUint64(f.populationLength, BigInt(page), true);
    expect(decodeGroupMemoryChangeDescription(bytes, receipt)).toMatchObject({ populationAddress: 4 * page, populationLength: page });
    view.setBigUint64(f.populationLength, BigInt(2 * page), true);
    expect(() => decodeGroupMemoryChangeDescription(bytes, receipt)).toThrow(/effect/);
    view.setBigUint64(f.populationLength, 0n, true);
    expect(() => decodeGroupMemoryChangeDescription(bytes, receipt)).toThrow(/effect/);
    view.setUint32(f.kind, P.mapping.kinds.remap, true);
    view.setUint32(f.flags, 0, true);
    view.setBigUint64(f.oldAddress, BigInt(2 * page), true); view.setBigUint64(f.oldLength, BigInt(page), true);
    view.setBigUint64(f.length, BigInt(2 * page), true); view.setBigUint64(f.populationAddress, BigInt(5 * page), true);
    view.setBigUint64(f.populationLength, BigInt(page), true);
    expect(decodeGroupMemoryChangeDescription(bytes, receipt).kind).toBe('remap');
  });
  it('encodes every original signed channel bit without narrowing addresses or fd sentinels', () => {
    const args = [-1n, (1n << 63n) - 1n, -(1n << 63n), 0n, 4294967295n, 7n];
    const bytes = encodeGroupMemoryChangeRequest(123, args, 4), view = new DataView(bytes.buffer);
    expect(bytes.byteLength).toBe(P.mapping.request_bytes);
    expect(view.getUint32(P.mapping.request_fields.syscall, true)).toBe(123);
    expect(view.getUint32(P.mapping.request_fields.reserved, true)).toBe(0);
    expect(args.map((_, i) => view.getBigInt64(P.mapping.request_fields.args + 8 * i, true))).toEqual(args);
    expect(() => encodeGroupMemoryChangeRequest(1, args.slice(0, 5), 4)).toThrow();
    expect(() => encodeGroupMemoryChangeRequest(1, [1n << 63n, 0n, 0n, 0n, 0n, 0n], 4)).toThrow();
    expect(() => encodeGroupMemoryChangeRequest(0x100000001, args, 4)).toThrow();
  });
  it('keeps high receipt/token bits in independent frozen metadata', () => {
    const { receipt, bytes, view, f } = description();
    const decoded = decodeGroupMemoryChangeDescription(bytes, receipt, 0xfffffffffffffffdn);
    expect(decoded).toMatchObject({ receipt, kind: 'map', token: 0xfffffffffffffffdn,
      address: 4 * page, length: page, result: 4 * page, prot: 3, flags: 0x22 });
    expect(Object.isFrozen(decoded)).toBe(true); expect(Object.isFrozen(decoded.receipt)).toBe(true);
    view.setBigUint64(f.token, 1n, true); view.setBigUint64(P.receipt_fields.serial, 1n, true);
    expect(decoded.token).toBe(0xfffffffffffffffdn); expect(decoded.receipt.serial).toBe(receipt.serial);
  });
  it('refuses another operation or receipt including differences above bit32', () => {
    const { receipt, bytes } = description();
    expect(() => decodeGroupMemoryChangeDescription(bytes, receipt, 0xfffffffefffffffdn)).toThrow(/exact operation/);
    expect(() => decodeGroupMemoryChangeDescription(bytes, { ...receipt, serial: receipt.serial - (1n << 32n) })).toThrow();
    expect(() => decodeGroupMemoryChangeDescription(bytes, { ...receipt, generation: receipt.generation - (1n << 32n) })).toThrow();
    expect(() => decodeGroupMemoryChangeDescription(bytes.subarray(1), receipt)).toThrow();
  });
  it('refuses malformed reserved, kind, protection, extent and result values', () => {
    for (const corrupt of [(v: DataView, f: ReturnType<typeof description>['f']) => v.setUint32(f.reserved, 1, true),
      (v: DataView, f: ReturnType<typeof description>['f']) => v.setUint32(f.kind, 99, true),
      (v: DataView, f: ReturnType<typeof description>['f']) => v.setUint32(f.prot, 8, true),
      (v: DataView, f: ReturnType<typeof description>['f']) => v.setBigUint64(f.address, 7n, true),
      (v: DataView, f: ReturnType<typeof description>['f']) => v.setBigUint64(f.address, 1n << 40n, true),
      (v: DataView, f: ReturnType<typeof description>['f']) => v.setBigUint64(f.result, 0n, true)]) {
      const { receipt, bytes, view, f } = description(); corrupt(view, f);
      expect(() => decodeGroupMemoryChangeDescription(bytes, receipt)).toThrow();
    }
  });
  it('preserves unaligned byte breaks and zero-length aligned protection effects', () => {
    const { receipt, bytes, view, f } = description();
    view.setUint32(f.flags, 0, true); view.setUint32(f.kind, P.mapping.kinds.break, true);
    view.setBigUint64(f.address, BigInt(3 * page + 7), true); view.setBigUint64(f.result, BigInt(3 * page + 7), true);
    view.setBigUint64(f.length, 0n, true); view.setBigUint64(f.oldAddress, BigInt(2 * page + 3), true);
    expect(decodeGroupMemoryChangeDescription(bytes, receipt)).toMatchObject({ kind: 'break', address: 3 * page + 7, oldAddress: 2 * page + 3 });
    view.setUint32(f.kind, P.mapping.kinds.protect, true); view.setBigUint64(f.address, BigInt(3 * page), true);
    view.setBigUint64(f.result, 0n, true); view.setBigUint64(f.oldAddress, 0n, true);
    expect(decodeGroupMemoryChangeDescription(bytes, receipt)).toMatchObject({ kind: 'protect', length: 0 });
  });
});

function mappingDispatchHarness(width: 4 | 8 = 4) {
  const h = harness(width), kw = h.worker as any, page = 65536, token = (1n << 63n) + 0xfffffff1n;
  h.implementations.kernel_memory_group_capabilities = () => P.capability_admission | P.mapping.capability | P.layout.capability;
  h.worker.createMemoryGroupBacking(23, 16);
  const receipt = h.worker.prepareMemoryGroupProcess(23, 100);
  if (typeof receipt === 'number') throw Error('missing admitted task');
  const handle = h.worker.prepareMemoryGroupImage(receipt, { initialVirtualPages: 4, maximumVirtualPages: 16, scratchBytes: page });
  if (typeof handle === 'number') throw Error('missing image');
  const launch = h.worker.publishMemoryGroupReplica(handle);
  if (typeof launch === 'number') throw Error('missing published replica');
  h.worker.registerMemoryGroupProcess(handle, [page], { ...groupedOptions, maxAddr: 16 * page });
  const registration = kw.processes.get(100), channel = registration.channels[0], store = registration.grouped.store;
  const completions: { value: number; errno: number }[] = [];
  let complete!: (value: { value: number; errno: number }) => void;
  const completed = new Promise<{ value: number; errno: number }>(resolve => { complete = resolve; });
  const observeCompletion = (value: number, errno: number) => {
    const record = { value, errno }; completions.push(record);
    processDataView(channel.source, page).setUint32(CH_STATUS, CHANNEL_STATUS_COMPLETE, true); complete(record);
  };
  h.worker.testAuthority.configureScratchBoundaryHooksForTest({
    completeChannelRaw: (_channel, value, errno) => observeCompletion(value, errno),
    completeChannel: (_channel, _syscall, _args, _descs, value, errno) => observeCompletion(Number(value), errno),
  });
  const effect = { kind: 'map' as 'map' | 'protect' | 'unmap' | 'break', address: 8 * page, length: page, prot: 3, flags: 0x22, result: 8 * page, oldAddress: 0, oldLength: 0, populationAddress: 0, populationLength: 0 };
  const writeDescription = (pointer: number | bigint, capacity: number) => {
    expect(capacity).toBe(P.mapping.description_bytes);
    const data = new DataView(h.memory.buffer, Number(pointer), capacity), f = P.mapping.description_fields;
    new Uint8Array(h.memory.buffer, Number(pointer), capacity).fill(0);
    for (const [field, value] of Object.entries({ group: 23, pid: 100, tid: 100 })) data.setUint32(P.receipt_fields[field as 'group' | 'pid' | 'tid'], value, true);
    data.setBigUint64(P.receipt_fields.serial, SERIAL, true); data.setBigUint64(P.receipt_fields.generation, GENERATION, true);
    data.setBigUint64(f.token, token, true); data.setUint32(f.kind, P.mapping.kinds[effect.kind], true);
    data.setUint32(f.prot, effect.prot, true); data.setUint32(f.flags, effect.flags, true);
    for (const field of ['address', 'length', 'result', 'oldAddress', 'oldLength', 'populationAddress', 'populationLength'] as const) data.setBigUint64(f[field], BigInt(effect[field]), true);
    return capacity;
  };
  const captured: bigint[][] = [], observedPages: number[] = [];
  h.implementations.kernel_group_memory_change_prepare = vi.fn((_pid, _tid, request, size, output, capacity) => {
    expect(size).toBe(P.mapping.request_bytes);
    const view = new DataView(h.memory.buffer, Number(request), size);
    observedPages.push(view.getUint32(P.mapping.request_fields.observedPages, true));
    captured.push(Array.from({ length: 6 }, (_, at) => view.getBigInt64(P.mapping.request_fields.args + at * 8, true)));
    return writeDescription(output, capacity);
  });
  h.implementations.kernel_group_memory_change_validate = vi.fn((_pid, _tid, low, high, output, capacity) => {
    expect(low >>> 0).toBe(0xfffffff1); expect(high >>> 0).toBe(0x80000000); return writeDescription(output, capacity);
  });
  h.implementations.kernel_group_memory_change_commit = vi.fn(() => 0);
  h.implementations.kernel_group_memory_change_cancel = vi.fn(() => 0);
  const control = new Int32Array(launch.envelope.memory.buffer, launch.expectation.replica, G.MEMORY_GROUP_REPLICA_BYTES / 4);
  const acknowledge = () => {
    Atomics.store(control, G.MEMORY_GROUP_REPLICA_ACK / 4, Atomics.load(control, G.MEMORY_GROUP_REPLICA_REQUEST / 4));
    Atomics.notify(control, G.MEMORY_GROUP_REPLICA_ACK / 4);
  };
  const dispatch = (syscall = SYSCALLS.Mmap, args = [0n, BigInt(page), 3n, 0x22n, -1n, 0n]) => {
    const view = processDataView(channel.source, page); view.setUint32(CH_SYSCALL, syscall, true);
    args.forEach((value, at) => view.setBigInt64(CH_ARGS + at * CH_ARG_SIZE, value, true));
    view.setUint32(CH_STATUS, CHANNEL_STATUS_PENDING, true); kw.handleSyscall(channel);
    return kw.pendingGroupMappings.get(channel);
  };
  const close = async () => {
    const fork = kw.pendingGroupForks.get(channel);
    if (fork) { kw.retireChannelHostWaits(channel); await fork.finished; }
    const pending = kw.pendingGroupMappings.get(channel);
    if (pending) { kw.retireChannelHostWaits(channel); await pending.finished; }
    store.close();
  };
  return { ...h, kw, page, token, registration, channel, store, launch, captured, observedPages, effect, completed, completions, control, acknowledge, dispatch, close };
}

function forkDispatchHarness() {
  const h = mappingDispatchHarness(), generations = new Map([[100, GENERATION]]);
  const ordinary = vi.fn(), fatal = vi.fn();
  h.kw.callbacks.onFork = ordinary; h.kw.callbacks.onKernelFatal = fatal;
  h.implementations.kernel_get_process_exec_generation = (pid: number, pointer: number | bigint) => {
    const value = generations.get(pid); if (value === undefined) return -3;
    new DataView(h.memory.buffer).setBigUint64(Number(pointer), value, true); return 8;
  };
  const originalReceipt = h.implementations.kernel_memory_group_task_receipt;
  h.implementations.kernel_memory_group_task_receipt = (pid: number, tid: number, pointer: number | bigint, size: number) => {
    if (!generations.has(pid)) return -3;
    const count = originalReceipt(pid, tid, pointer, size), view = new DataView(h.memory.buffer, Number(pointer), size);
    if (pid !== 100) {
      view.setBigUint64(P.receipt_fields.serial, SERIAL - BigInt(pid), true);
      view.setBigUint64(P.receipt_fields.generation, generations.get(pid)!, true);
    }
    return count;
  };
  h.implementations.kernel_group_memory_fork = vi.fn((group, pid, tid, low, high, generationLow, generationHigh, extent) => {
    expect([group, pid, tid]).toEqual([23, 100, 100]);
    expect(BigInt(low >>> 0) | BigInt(high >>> 0) << 32n).toBe(SERIAL);
    expect(BigInt(generationLow >>> 0) | BigInt(generationHigh >>> 0) << 32n).toBe(GENERATION);
    expect(extent).toBe(4); // Physical storage is sixteen pages, not four.
    generations.set(101, 0n); return 101;
  });
  h.implementations.kernel_remove_process = vi.fn((pid: number) => generations.delete(pid) ? 0 : -3);
  const forkBufAddr = 3 * h.page + WPK_FORK_LINKED_FRAME_POINTER_WIDTHS[0].chunkHeaderSize;
  writeForkContinuationAnchor(h.registration.source, h.page - FORK_SAVE_BUFFER_SIZE, 4, forkBufAddr);
  const adopt = async (request: any) => {
    const child = await retryKernelEntryResult(() => h.worker.publishMemoryGroupReplica(request.childReplica));
    if (typeof child === 'number') throw Error(`Child publication ${child}`);
    child.source.fillBytes(h.page, CH_TOTAL_SIZE, 0);
    await retryKernelEntryResult(() => h.worker.registerMemoryGroupProcess(request.childReplica, [h.page], { ptrWidth: 4, maxAddr: 16 * h.page, preserveProcessState: true }));
    return child;
  };
  const dispatchFork = () => { h.dispatch(HOST_INTERCEPTED_SYSCALLS.SYS_FORK, [0n, 0n, 0n, 0n, 0n, 0n]); return h.kw.pendingGroupForks.get(h.channel); };
  return { ...h, generations, ordinary, fatal, forkBufAddr, adopt, dispatchFork };
}

describe('normal grouped fork dispatch ownership', () => {
  it('waits for the image barrier, snapshots logical pages once and adopts a private child through an explicit backend', async () => {
    const h = forkDispatchHarness(); let child: Awaited<ReturnType<typeof h.adopt>> | undefined;
    h.kw.callbacks.onGroupedFork = vi.fn(async request => {
      expect(request.continuation).toEqual({ kind: 'main', forkBufAddr: h.forkBufAddr });
      expect(request.parentSource).toBe(h.registration.source);
      child = await h.adopt(request); return [h.page];
    });
    try {
      h.registration.source.writeBytes(3 * h.page + 100, Uint8Array.of(0xa5));
      const pending = h.dispatchFork();
      expect(h.implementations.kernel_group_memory_fork).not.toHaveBeenCalled();
      h.acknowledge(); expect(await h.completed).toEqual({ value: 101, errno: 0 }); await pending.finished;
      expect(h.implementations.kernel_group_memory_fork).toHaveBeenCalledTimes(1);
      expect(child!.source.readBytes(3 * h.page + 100, 1)).toEqual(Uint8Array.of(0xa5));
      child!.source.writeBytes(3 * h.page + 100, Uint8Array.of(0x19));
      expect(h.registration.source.readBytes(3 * h.page + 100, 1)).toEqual(Uint8Array.of(0xa5));
      expect(h.kw.pendingGroupImageOperations.size).toBe(0);
      expect(h.ordinary).not.toHaveBeenCalled(); expect(h.fatal).not.toHaveBeenCalled();
    } finally { await h.close(); }
  });
  it('preserves a Rust refusal and releases the parent barrier without allocating child storage', async () => {
    const h = forkDispatchHarness(), charged = h.store.snapshot().allocatedPages;
    h.kw.callbacks.onGroupedFork = vi.fn(); h.implementations.kernel_group_memory_fork = vi.fn(() => -11);
    try {
      h.dispatchFork(); h.acknowledge(); expect(await h.completed).toEqual({ value: -1, errno: 11 });
      expect(h.kw.callbacks.onGroupedFork).not.toHaveBeenCalled(); expect(h.store.snapshot().allocatedPages).toBe(charged);
      expect(Atomics.load(h.control, G.MEMORY_GROUP_REPLICA_REQUEST / 4)).toBe(0);
      expect(h.fatal).not.toHaveBeenCalled();
    } finally { await h.close(); }
  });
  it('never falls back to ordinary fork when the grouped backend is absent', async () => {
    const h = forkDispatchHarness();
    try {
      h.dispatchFork(); expect(await h.completed).toEqual({ value: -1, errno: 95 });
      expect(h.ordinary).not.toHaveBeenCalled(); expect(h.implementations.kernel_group_memory_fork).not.toHaveBeenCalled();
      expect(Atomics.load(h.control, G.MEMORY_GROUP_REPLICA_REQUEST / 4)).toBe(0);
    } finally { await h.close(); }
  });
  it('cancels a retired caller before allocating any child and suppresses its completion', async () => {
    const h = forkDispatchHarness(); h.kw.callbacks.onGroupedFork = vi.fn();
    try {
      const pending = h.dispatchFork(); h.kw.retireChannelHostWaits(h.channel); await pending.finished;
      expect(h.implementations.kernel_group_memory_fork).not.toHaveBeenCalled(); expect(h.completions).toEqual([]);
      expect(h.kw.pendingGroupImageOperations.size).toBe(0); expect(h.fatal).not.toHaveBeenCalled();
    } finally { await h.close(); }
  });
  it('retains one Rust child across a busy physical pool and retries before launch', async () => {
    const h = forkDispatchHarness(), prepare = h.store.preparePrivateFork.bind(h.store);
    let retry!: () => void; const firstAttempt = new Promise<void>(resolve => { retry = resolve; });
    const spy = vi.spyOn(h.store, 'preparePrivateFork').mockImplementationOnce(() => { retry(); return 'busy'; }).mockImplementation(prepare);
    h.kw.callbacks.onGroupedFork = vi.fn(async request => { await h.adopt(request); return [h.page]; });
    try {
      h.dispatchFork(); h.acknowledge(); await firstAttempt;
      expect(await h.completed).toEqual({ value: 101, errno: 0 });
      expect(h.implementations.kernel_group_memory_fork).toHaveBeenCalledTimes(1); expect(spy).toHaveBeenCalledTimes(2);
      expect(h.fatal).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); await h.close(); }
  });
  it('rolls back exact never-published child pages and Rust admission after launch rejection', async () => {
    const h = forkDispatchHarness(), charged = h.store.snapshot().allocatedPages;
    h.kw.callbacks.onGroupedFork = vi.fn(async () => { throw Error('injected pre-publication launch failure'); });
    try {
      h.dispatchFork(); h.acknowledge(); expect(await h.completed).toEqual({ value: -1, errno: 12 });
      expect(h.store.snapshot()).toMatchObject({ images: 1, replicas: 1, allocatedPages: charged });
      expect(h.generations.has(101)).toBe(false); expect(h.implementations.kernel_memory_group_retire_image).toHaveBeenCalledWith(101, 0, 0);
      expect(h.fatal).not.toHaveBeenCalled();
    } finally { await h.close(); }
  });
  it('refuses a bad virtual continuation anchor before asking Rust to allocate a child', async () => {
    const h = forkDispatchHarness(); h.kw.callbacks.onGroupedFork = vi.fn();
    try {
      writeForkContinuationAnchor(h.registration.source, h.page - FORK_SAVE_BUFFER_SIZE, 4, 0);
      h.dispatchFork(); h.acknowledge(); expect(await h.completed).toEqual({ value: -1, errno: 14 });
      expect(h.implementations.kernel_group_memory_fork).not.toHaveBeenCalled(); expect(h.fatal).not.toHaveBeenCalled();
    } finally { await h.close(); }
  });
  it('queues fork behind a mapping owner before starting its image barrier', async () => {
    const h = forkDispatchHarness(); let finish!: () => void, started!: () => void;
    const predecessor = { kind: 'mapping', registration: h.registration, done: false, finished: new Promise<void>(resolve => { finish = resolve; }) };
    const key = {}; h.kw.pendingGroupImageOperations.set(key, predecessor);
    const barrierStarted = new Promise<void>(resolve => { started = resolve; });
    const original = h.store.beginImageExecutionPause.bind(h.store);
    const spy = vi.spyOn(h.store, 'beginImageExecutionPause').mockImplementation((...args: any[]) => { const value = original(...args); started(); return value; });
    h.kw.callbacks.onGroupedFork = vi.fn(async request => { await h.adopt(request); return [h.page]; });
    try {
      h.dispatchFork(); expect(spy).not.toHaveBeenCalled(); expect(h.implementations.kernel_group_memory_fork).not.toHaveBeenCalled();
      predecessor.done = true; h.kw.pendingGroupImageOperations.delete(key); finish(); await barrierStarted;
      h.acknowledge(); expect(await h.completed).toEqual({ value: 101, errno: 0 }); expect(h.fatal).not.toHaveBeenCalled();
    } finally { predecessor.done = true; h.kw.pendingGroupImageOperations.delete(key); finish(); spy.mockRestore(); await h.close(); }
  });
  it('quarantines published child storage on failed launch without returning its pages', async () => {
    const h = forkDispatchHarness(), charged = h.store.snapshot().allocatedPages;
    h.kw.callbacks.onGroupedFork = vi.fn(async request => {
      const published = await retryKernelEntryResult(() => h.worker.publishMemoryGroupReplica(request.childReplica));
      if (typeof published === 'number') throw Error('publication refused');
      throw Error('injected failure after backing publication');
    });
    try {
      h.dispatchFork(); h.acknowledge(); expect(await h.completed).toEqual({ value: -1, errno: 12 });
      expect(h.store.snapshot()).toMatchObject({ images: 2, replicas: 2, allocatedPages: charged + 7, quarantinedReplicas: 1 });
      const actions = h.implementations.kernel_memory_group_task_action.mock.calls.map((call: any[]) => call[2]);
      expect(actions.slice(-2)).toEqual([P.task_actions.beginRetirement, P.task_actions.quarantine]);
      expect(h.implementations.kernel_memory_group_retire_image).not.toHaveBeenCalled(); expect(h.fatal).not.toHaveBeenCalled();
    } finally { await h.close(); }
  });
  it('preserves an adopted child when the caller retires during asynchronous launch', async () => {
    const h = forkDispatchHarness(); let adopted!: () => void, release!: () => void;
    const adoption = new Promise<void>(resolve => { adopted = resolve; }), launched = new Promise<number[]>(resolve => { release = () => resolve([h.page]); });
    h.kw.callbacks.onGroupedFork = vi.fn(async request => { await h.adopt(request); adopted(); return launched; });
    try {
      const pending = h.dispatchFork(); h.acknowledge(); await adoption;
      processDataView(h.channel.source, h.page).setUint32(CH_STATUS, CHANNEL_STATUS_COMPLETE, true);
      h.kw.retireChannelHostWaits(h.channel); expect(pending.done).toBe(false);
      release(); await pending.finished;
      expect(h.kw.processes.has(101)).toBe(true); expect(h.implementations.kernel_remove_process).not.toHaveBeenCalled();
      expect(h.completions).toEqual([]); expect(h.fatal).not.toHaveBeenCalled();
    } finally { release(); await h.close(); }
  });
  it('contains a callback that resolves without publishing the child image', async () => {
    const h = forkDispatchHarness(); let failed!: (error: Error) => void;
    const failure = new Promise<Error>(resolve => { failed = resolve; });
    h.kw.callbacks.onKernelFatal = (error: Error) => { h.fatal(error); failed(error); };
    h.kw.callbacks.onGroupedFork = vi.fn(async () => []);
    try {
      h.dispatchFork(); h.acknowledge(); expect((await failure).message).toContain('without child image adoption');
      expect(h.completions).toEqual([]); expect(h.store.snapshot().allocatedPages).toBeGreaterThan(8);
      expect(() => h.worker.configureMemoryGroups(2048, 2)).toThrow();
    } finally { h.store.close(); }
  });
});

describe('normal grouped generic output preparation', () => {
  it('refuses a protected pipe result before allocating kernel descriptors', async () => {
    const h = mappingDispatchHarness();
    try {
      const output = 3 * h.page;
      const descriptor = h.launch.envelope.descriptor;
      if (descriptor.kind === 'linear') throw Error('missing grouped descriptor');
      new Uint32Array(h.launch.envelope.memory.buffer, descriptor.root + G.MEMORY_GROUP_ROOT_HEADER_BYTES)[3] &= ~2;
      h.implementations.kernel_handle_channel = vi.fn((pointer: number | bigint) => {
        const view = new DataView(h.memory.buffer, Number(pointer));
        view.setBigInt64(CH_RETURN, 0n, true); view.setUint32(CH_ERRNO, 0, true); return 0;
      });
      h.dispatch(SYSCALLS.Pipe, [BigInt(output), 0n, 0n, 0n, 0n, 0n]); await h.completed;
      expect(h.implementations.kernel_handle_channel).not.toHaveBeenCalled();
      expect(h.completions).toEqual([{ value: -1, errno: 14 }]);
    } finally { await h.close(); }
  });
  it.each(['input', 'length'] as const)('reports an unreadable generic %s as EFAULT before kernel effects', async kind => {
    const h = mappingDispatchHarness();
    try {
      const address = 3 * h.page, descriptor = h.launch.envelope.descriptor;
      if (descriptor.kind === 'linear') throw Error('missing grouped descriptor');
      processDataView(h.registration.source, address).setUint32(0, 4, true);
      new Uint32Array(h.launch.envelope.memory.buffer, descriptor.root + G.MEMORY_GROUP_ROOT_HEADER_BYTES)[3] &= ~1;
      const syscall = kind === 'input' ? SYSCALLS.Bind : SYSCALLS.Getsockopt;
      const args = kind === 'input' ? [7n, BigInt(address), 16n, 0n, 0n, 0n]
        : [7n, 1n, 1n, BigInt(2 * h.page), BigInt(address), 0n];
      h.dispatch(syscall, args); await h.completed;
      expect(h.implementations.kernel_handle_channel).not.toHaveBeenCalled();
      expect(h.completions).toEqual([{ value: -1, errno: 14 }]);
    } finally { await h.close(); }
  });
  it('rechecks a frozen receive output before retry and releases its exact kernel binding', async () => {
    const h = mappingDispatchHarness();
    try {
      const output = 3 * h.page;
      h.worker.testAuthority.configureScratchBoundaryHooksForTest({ handleBlockingRetry: () => {} });
      h.implementations.kernel_handle_channel = vi.fn((pointer: number | bigint) => {
        const view = new DataView(h.memory.buffer, Number(pointer));
        view.setBigInt64(CH_RETURN, -1n, true); view.setUint32(CH_ERRNO, 11, true); return 0;
      });
      h.dispatch(SYSCALLS.Recvfrom, [7n, BigInt(output), 4n, 0n, 0n, 0n]);
      expect(h.completions).toEqual([]); expect(h.kw.blockingRetrySnapshots.get(h.channel).kind).toBe('generic-channel');
      const descriptor = h.launch.envelope.descriptor;
      if (descriptor.kind === 'linear') throw Error('missing grouped descriptor');
      new Uint32Array(h.launch.envelope.memory.buffer, descriptor.root + G.MEMORY_GROUP_ROOT_HEADER_BYTES)[3] &= ~2;
      h.kw.retrySyscall(h.channel); await h.completed;
      expect(h.implementations.kernel_handle_channel).toHaveBeenCalledTimes(1);
      expect(h.completions).toEqual([{ value: -1, errno: 14 }]);
      expect(h.kw.blockingRetrySnapshots.has(h.channel)).toBe(false);
      expect(h.implementations.kernel_blocking_retry_release).toHaveBeenCalledExactlyOnceWith(100, 100, 701n);
    } finally { await h.close(); }
  });
  it.each([0, 3])('preserves affinity task-lookup precedence with a protected output (kernel errno %i)', async errno => {
    const h = mappingDispatchHarness();
    try {
      const output = 3 * h.page, descriptor = h.launch.envelope.descriptor;
      if (descriptor.kind === 'linear') throw Error('missing grouped descriptor');
      new Uint32Array(h.launch.envelope.memory.buffer, descriptor.root + G.MEMORY_GROUP_ROOT_HEADER_BYTES)[3] &= ~2;
      h.implementations.kernel_handle_channel = vi.fn((pointer: number | bigint) => {
        const view = new DataView(h.memory.buffer, Number(pointer));
        view.setBigInt64(CH_RETURN, errno === 0 ? 4n : -1n, true); view.setUint32(CH_ERRNO, errno, true); return 0;
      });
      h.dispatch(SYSCALLS.SchedGetaffinity, [999n, 4n, BigInt(output), 0n, 0n, 0n]); await h.completed;
      expect(h.implementations.kernel_handle_channel).toHaveBeenCalledTimes(1);
      expect(h.completions).toEqual([{ value: -1, errno: errno || 14 }]);
    } finally { await h.close(); }
  });
});

describe('normal grouped scalar I/O routing', () => {
  it.each([SYSCALLS.Read, SYSCALLS.Write, SYSCALLS.Pread, SYSCALLS.Pwrite, SYSCALLS.Getrandom])('sends syscall %i through Rust guest-address I/O even for a small buffer', async syscall => {
    const h = mappingDispatchHarness();
    try {
      const args = syscall === SYSCALLS.Getrandom ? [17n, 4n, 0n, 0n, 0n, 0n] : [9n, 17n, 4n, 23n, 0n, 0n];
      h.implementations.kernel_handle_guest_io = vi.fn((pointer: number | bigint, capacity: number, pid: number, retry: bigint) => {
        expect(capacity).toBe(CH_TOTAL_SIZE); expect(pid).toBe(100); expect(retry).toBe(0n);
        const view = new DataView(h.memory.buffer, Number(pointer), capacity);
        expect(view.getUint32(CH_SYSCALL, true)).toBe(syscall);
        args.forEach((value, at) => expect(view.getBigInt64(CH_ARGS + at * CH_ARG_SIZE, true)).toBe(value));
        view.setBigInt64(CH_RETURN, 4n, true); view.setUint32(CH_ERRNO, 0, true); return 0;
      });
      h.dispatch(syscall, args); await h.completed;
      expect(h.implementations.kernel_handle_guest_io).toHaveBeenCalledTimes(1);
      expect(h.completions).toEqual([{ value: 4, errno: 0 }]);
    } finally { await h.close(); }
  });
});

describe('normal grouped mapping syscall coordination', () => {
  it('retries temporary file unavailability at the same cursor before publication', async () => {
    const h = mappingDispatchHarness();
    let firstRead!: () => void;
    const unavailable = new Promise<void>(resolve => { firstRead = resolve; });
    try {
      Object.assign(h.effect, { flags: 2, populationAddress: 8 * h.page, populationLength: h.page });
      let reads = 0;
      h.implementations.kernel_group_memory_change_read = vi.fn((_pid, _tid, _low, _high, offset, _offsetHigh, out) => {
        reads++;
        if (reads === 1) { expect(offset).toBe(0); firstRead(); return -11; }
        if (reads === 2) { expect(offset).toBe(0); new Uint8Array(h.memory.buffer, Number(out), 2).set([7, 8]); return 2; }
        expect(offset).toBe(2); return 0;
      });
      const pending = h.dispatch(); h.acknowledge(); await unavailable;
      expect(h.implementations.kernel_group_memory_change_commit).not.toHaveBeenCalled();
      expect(() => h.registration.source.readBytes(8 * h.page, 1)).toThrow();
      await h.completed; await pending.finished;
      expect(reads).toBe(3);
      expect(h.registration.source.readBytes(8 * h.page, 4)).toEqual(Uint8Array.of(7, 8, 0, 0));
      expect(h.implementations.kernel_group_memory_change_commit).toHaveBeenCalledTimes(1);
    } finally { await h.close(); }
  });
  it('cancels a file replacement on read failure without changing published bytes', async () => {
    const h = mappingDispatchHarness();
    try {
      h.registration.source.fillBytes(0, h.page, 0xa5);
      const charged = h.store.snapshot().allocatedPages;
      Object.assign(h.effect, { address: 0, result: 0, length: 2 * h.page, flags: 0x12, prot: 1,
        populationAddress: 0, populationLength: 2 * h.page });
      let reads = 0;
      h.implementations.kernel_group_memory_change_read = vi.fn((_pid, _tid, low, high, offset, _offsetHigh, out, capacity) => {
        expect(low >>> 0).toBe(0xfffffff1); expect(high >>> 0).toBe(0x80000000);
        expect(offset).toBe(reads === 0 ? 0 : h.page);
        if (reads++ !== 0) return -5;
        new Uint8Array(h.memory.buffer, Number(out), capacity).fill(0x5a); return capacity;
      });
      h.dispatch(); h.acknowledge(); await h.completed;
      expect(reads).toBe(2);
      expect(h.completions).toEqual([{ value: -1, errno: 5 }]);
      expect(h.implementations.kernel_group_memory_change_commit).not.toHaveBeenCalled();
      expect(h.implementations.kernel_group_memory_change_cancel).toHaveBeenCalledTimes(1);
      expect(h.registration.source.readBytes(0, h.page).every((byte: number) => byte === 0xa5)).toBe(true);
      expect(h.store.snapshot().allocatedPages).toBe(charged);
    } finally { await h.close(); }
  });
  it('continues a short private read to EOF and publishes a zero-filled tail', async () => {
    const h = mappingDispatchHarness();
    try {
      Object.assign(h.effect, { flags: 2, prot: 1, populationAddress: 8 * h.page, populationLength: h.page });
      let reads = 0;
      h.implementations.kernel_group_memory_change_read = vi.fn((_pid, _tid, _low, _high, offset, _offsetHigh, out) => {
        if (reads++ !== 0) { expect(offset).toBe(3); return 0; }
        expect(offset).toBe(0); new Uint8Array(h.memory.buffer, Number(out), 3).set([1, 2, 3]); return 3;
      });
      h.dispatch(); h.acknowledge(); await h.completed;
      expect(reads).toBe(2);
      expect(h.completions).toEqual([{ value: 8 * h.page, errno: 0 }]);
      expect(h.registration.source.readBytes(8 * h.page, 6)).toEqual(Uint8Array.of(1, 2, 3, 0, 0, 0));
      expect(h.implementations.kernel_group_memory_change_commit).toHaveBeenCalledTimes(1);
    } finally { await h.close(); }
  });
  it('delivers pending signals through the normal dequeue path before completing a heap query', async () => {
    const h = mappingDispatchHarness();
    try {
      h.implementations.kernel_dequeue_signal = vi.fn(() => { expect(h.completions).toEqual([]); return 0; });
      h.dispatch(SYSCALLS.Brk, [0n, 0n, 0n, 0n, 0n, 0n]); await h.completed;
      expect(h.implementations.kernel_dequeue_signal).toHaveBeenCalledTimes(1);
    } finally { await h.close(); }
  });
  it('keeps a cancelled middle queue owner from bypassing an earlier live image owner', async () => {
    const h = mappingDispatchHarness(); let finishA!: () => void, finishB!: () => void, waitingA!: () => void, started!: () => void;
    const aDone = new Promise<void>(resolve => { finishA = resolve; }), bDone = new Promise<void>(resolve => { finishB = resolve; });
    const waiting = new Promise<'waiting'>(resolve => { waitingA = () => resolve('waiting'); });
    const barrierStarted = new Promise<'barrier'>(resolve => { started = () => resolve('barrier'); });
    const a = { registration: h.registration, done: false, get finished() { waitingA(); return aDone; } };
    const b = { registration: h.registration, done: false, finished: bDone, predecessor: a };
    const keyA = {}, keyB = {}; h.kw.pendingGroupImageOperations.set(keyA, a); h.kw.pendingGroupImageOperations.set(keyB, b);
    const original = h.store.beginImageExecutionPause.bind(h.store);
    const spy = vi.spyOn(h.store, 'beginImageExecutionPause').mockImplementation((...args: any[]) => { const value = original(...args); started(); return value; });
    try {
      const pending = h.dispatch(); b.done = true; h.kw.pendingGroupImageOperations.delete(keyB); finishB();
      expect(await Promise.race([waiting, barrierStarted])).toBe('waiting'); expect(spy).not.toHaveBeenCalled();
      a.done = true; h.kw.pendingGroupImageOperations.delete(keyA); finishA(); await barrierStarted;
      h.acknowledge(); await h.completed; await pending.finished;
      expect(h.implementations.kernel_group_memory_change_prepare).toHaveBeenCalledTimes(1);
    } finally { a.done = true; b.done = true; h.kw.pendingGroupImageOperations.delete(keyA); h.kw.pendingGroupImageOperations.delete(keyB); finishA(); finishB(); spy.mockRestore(); await h.close(); }
  });
  it('observes appended virtual pages after the barrier rather than the physical group extent', async () => {
    const h = mappingDispatchHarness();
    try {
      const pending = h.dispatch(); expect(h.captured).toEqual([]);
      // Emulate the shared C grow transaction using its real bitmap and lock
      // order. This is a mechanism fixture, not compiled C execution.
      const memory = h.launch.envelope.memory, root = h.launch.expectation.root;
      const lock = new Int32Array(memory.buffer, root + G.MEMORY_GROUP_ROOT_GROW_LOCK, 1);
      Atomics.store(lock, 0, 1);
      try {
        const pool = MemoryGroupPagePool.attach(memory, 1024), extent = pool.allocateContiguous(1)!;
        new Uint8Array(memory.buffer, extent.first * h.page, h.page).fill(0x42);
        new Uint32Array(memory.buffer, root + G.MEMORY_GROUP_ROOT_HEADER_BYTES, 16)[4] = extent.first * h.page | 3;
        Atomics.store(new Uint32Array(memory.buffer, root, 1), 0, 5);
      } finally { Atomics.store(lock, 0, 0); Atomics.notify(lock, 0); }
      h.acknowledge(); await h.completed; await pending.finished;
      expect(h.observedPages).toEqual([5]); expect(memory.buffer.byteLength / h.page).not.toBe(5);
      expect(h.launch.source.readBytes(4 * h.page, h.page).every(byte => byte === 0x42)).toBe(true);
    } finally { await h.close(); }
  });
  it.each([false, true])('queues behind the exact image owner and can retire before handoff=%s', async retire => {
    const h = mappingDispatchHarness(); let finish!: () => void;
    const predecessor = { registration: h.registration, done: false, finished: new Promise<void>(resolve => { finish = resolve; }) };
    const key = {};
    h.kw.pendingGroupImageOperations.set(key, predecessor);
    let started!: () => void; const barrierStarted = new Promise<void>(resolve => { started = resolve; });
    const original = h.store.beginImageExecutionPause.bind(h.store);
    const spy = vi.spyOn(h.store, 'beginImageExecutionPause').mockImplementation((...args: any[]) => {
      const barrier = original(...args); started(); return barrier;
    });
    try {
      const pending = h.dispatch(); expect(h.implementations.kernel_group_memory_change_prepare).not.toHaveBeenCalled();
      expect(spy).not.toHaveBeenCalled();
      if (retire) { h.kw.retireChannelHostWaits(h.channel); await pending.finished; }
      predecessor.done = true; h.kw.pendingGroupImageOperations.delete(key); finish();
      if (!retire) { await barrierStarted; h.acknowledge(); await h.completed; await pending.finished; }
      expect(h.implementations.kernel_group_memory_change_prepare).toHaveBeenCalledTimes(retire ? 0 : 1);
      expect(h.completions.length).toBe(retire ? 0 : 1);
    } finally { h.kw.pendingGroupImageOperations.delete(key); predecessor.done = true; finish(); spy.mockRestore(); await h.close(); }
  });
  it('materializes heap growth through the prepared break and preserves initial bytes', async () => {
    const h = mappingDispatchHarness();
    try {
      h.launch.source.fillBytes(3 * h.page, h.page, 0x27);
      Object.assign(h.effect, { kind: 'break', oldAddress: 3 * h.page, address: 5 * h.page + 7, result: 5 * h.page + 7, length: 0, prot: 3, flags: 0 });
      const pending = h.dispatch(SYSCALLS.Brk, [BigInt(h.effect.address), 0n, 0n, 0n, 0n, 0n]);
      h.acknowledge(); expect(await h.completed).toEqual({ value: h.effect.address, errno: 0 }); await pending.finished;
      expect(h.launch.source.readBytes(3 * h.page, h.page).every(byte => byte === 0x27)).toBe(true);
      expect(h.launch.source.readBytes(4 * h.page, 2 * h.page).every(byte => byte === 0)).toBe(true);
      expect(h.launch.source.byteLength).toBe(6 * h.page);
    } finally { await h.close(); }
  });
  it('reports the unchanged break when metadata admission refuses heap growth', async () => {
    const h = mappingDispatchHarness();
    try {
      h.implementations.kernel_group_memory_change_prepare = vi.fn(() => -12);
      const pending = h.dispatch(SYSCALLS.Brk, [BigInt(5 * h.page), 0n, 0n, 0n, 0n, 0n]);
      h.acknowledge(); expect(await h.completed).toEqual({ value: 3 * h.page, errno: 0 }); await pending.finished;
      expect(h.implementations.kernel_group_memory_change_cancel).not.toHaveBeenCalled();
      expect(h.launch.source.byteLength).toBe(4 * h.page);
    } finally { await h.close(); }
  });
  it.each([4, 8] as const)('publishes Rust-selected virtual addresses with independent scratch records at kernel width %s', async width => {
    const h = mappingDispatchHarness(width);
    try {
      const pending = h.dispatch(); expect(pending).toBeDefined(); expect(h.completions).toEqual([]);
      expect(h.captured).toEqual([]);
      new Uint8Array(h.memory.buffer, 4096, 128).fill(0x91);
      h.acknowledge(); expect(await h.completed).toEqual({ value: 8 * h.page, errno: 0 }); await pending.finished;
      expect(h.captured).toEqual([[0n, BigInt(h.page), 3n, 0x22n, -1n, 0n]]);
      expect(h.launch.source.readBytes(8 * h.page, h.page).every(byte => byte === 0)).toBe(true);
      expect(h.implementations.kernel_group_memory_change_commit).toHaveBeenCalledTimes(1);
      expect(h.implementations.kernel_group_memory_change_cancel).not.toHaveBeenCalled();
      expect(h.kw.pendingGroupMappings.size).toBe(0); expect(Atomics.load(h.control, G.MEMORY_GROUP_REPLICA_REQUEST / 4)).toBe(0);
    } finally { await h.close(); }
  });
  it('deduplicates notifications and retains the first copied arguments while waiting for execution ACK', async () => {
    const h = mappingDispatchHarness();
    try {
      const pending = h.dispatch(); processDataView(h.channel.source, h.page).setBigInt64(CH_ARGS, 123n, true);
      h.kw.handleSyscall(h.channel); expect(h.implementations.kernel_group_memory_change_prepare).not.toHaveBeenCalled();
      h.acknowledge(); expect(await h.completed).toEqual({ value: 8 * h.page, errno: 0 }); await pending.finished;
      expect(h.captured[0][0]).toBe(0n);
    } finally { await h.close(); }
  });
  it.each(['generation', 'request', 'registration'] as const)('cancels a stale %s without completing its successor', async replacement => {
    const h = mappingDispatchHarness();
    try {
      const pending = h.dispatch();
      if (replacement === 'generation') h.implementations.kernel_get_process_exec_generation = (_pid: number, pointer: number | bigint) => {
        new DataView(h.memory.buffer).setBigUint64(Number(pointer), GENERATION + 1n, true); return 8;
      };
      else if (replacement === 'request') h.kw.activeChannelRequests.set(h.channel, Object.freeze({ ...h.kw.activeChannelRequests.get(h.channel) }));
      else h.kw.processes.set(100, { ...h.registration });
      const successor = h.kw.processes.get(100), request = h.kw.activeChannelRequests.get(h.channel);
      h.acknowledge(); await pending.finished;
      expect(h.completions).toEqual([]); expect(h.implementations.kernel_group_memory_change_commit).not.toHaveBeenCalled();
      expect(h.implementations.kernel_group_memory_change_cancel).not.toHaveBeenCalled();
      expect(h.kw.processes.get(100)).toBe(successor); expect(h.kw.activeChannelRequests.get(h.channel)).toBe(request);
      expect(h.launch.source.byteLength).toBe(4 * h.page);
    } finally { await h.close(); }
  });
  it('does not run ordinary zero/grow postprocessing over a protected result', async () => {
    const h = mappingDispatchHarness();
    try {
      h.effect.prot = 0; h.dispatch(SYSCALLS.Mmap, [0n, BigInt(h.page), 0n, 0x22n, -1n, 0n]);
      h.acknowledge(); expect(await h.completed).toEqual({ value: 8 * h.page, errno: 0 });
      expect(() => h.launch.source.readBytes(8 * h.page, 1)).toThrow();
    } finally { await h.close(); }
  });
  it('releases staged physical pages if generation changes at final validation', async () => {
    const h = mappingDispatchHarness(), charged = h.store.snapshot().allocatedPages;
    try {
      const validate = h.implementations.kernel_group_memory_change_validate; let changed = false;
      h.implementations.kernel_group_memory_change_validate = (...args: any[]) => {
        const result = validate(...args);
        if (!changed && h.store.snapshot().allocatedPages > charged) {
          changed = true;
          h.implementations.kernel_get_process_exec_generation = (_pid: number, pointer: number | bigint) => {
            new DataView(h.memory.buffer).setBigUint64(Number(pointer), GENERATION + 1n, true); return 8;
          };
        }
        return result;
      };
      const pending = h.dispatch(); h.acknowledge(); await pending.finished;
      expect(changed).toBe(true); expect(h.implementations.kernel_group_memory_change_commit).not.toHaveBeenCalled();
      expect(h.implementations.kernel_group_memory_change_cancel).toHaveBeenCalledTimes(1);
      expect(h.completions).toEqual([]); expect(h.store.snapshot().allocatedPages).toBe(charged);
      expect(h.launch.source.byteLength).toBe(4 * h.page);
    } finally { await h.close(); }
  });
  it('refuses an old image before binding or preparing a successor task', async () => {
    const h = mappingDispatchHarness();
    try {
      h.implementations.kernel_get_process_exec_generation = (_pid: number, pointer: number | bigint) => {
        new DataView(h.memory.buffer).setBigUint64(Number(pointer), GENERATION + 1n, true); return 8;
      };
      h.implementations.kernel_set_current_tid = vi.fn(() => 0); h.dispatch();
      expect(h.implementations.kernel_set_current_tid).not.toHaveBeenCalled();
      expect(h.implementations.kernel_group_memory_change_prepare).not.toHaveBeenCalled(); expect(h.completions).toEqual([]);
    } finally { await h.close(); }
  });
  it('keeps a failed unpublished allocation owned through busy-pool channel retirement', async () => {
    const h = mappingDispatchHarness(), charged = h.store.snapshot().allocatedPages;
    const poolLock = new Int32Array(h.launch.envelope.memory.buffer, G.MEMORY_GROUP_CONTROL, 1);
    let reached!: () => void; const committed = new Promise<void>(resolve => { reached = resolve; });
    try {
      h.implementations.kernel_group_memory_change_commit = vi.fn(() => { Atomics.store(poolLock, 0, 1); reached(); return -12; });
      const pending = h.dispatch(); h.acknowledge(); await committed;
      expect(pending.rustCancelled).toBe(true); expect(pending.done).toBe(false); expect(h.kw.retiringGroupMappings.has(pending)).toBe(true);
      h.kw.retireChannelHostWaits(h.channel);
      expect(h.implementations.kernel_group_memory_change_cancel).toHaveBeenCalledTimes(1);
      Atomics.store(poolLock, 0, 0); Atomics.notify(poolLock, 0); await pending.finished;
      expect(h.completions).toEqual([]); expect(h.store.snapshot().allocatedPages).toBe(charged);
      expect(h.kw.retiringGroupMappings.size).toBe(0); expect(h.kw.pendingGroupMappings.size).toBe(0);
    } finally { Atomics.store(poolLock, 0, 0); Atomics.notify(poolLock, 0); await h.close(); }
  });
  it('queries the kernel-owned break without a barrier or Rust preparation', async () => {
    const h = mappingDispatchHarness();
    try {
      h.dispatch(SYSCALLS.Brk, [0n, 0n, 0n, 0n, 0n, 0n]); expect(await h.completed).toEqual({ value: 3 * h.page, errno: 0 });
      expect(h.implementations.kernel_group_memory_change_prepare).not.toHaveBeenCalled();
    } finally { await h.close(); }
  });
});

describe('grouped image layout transport', () => {
  const receipt = { group: 23, pid: 100, tid: 100, serial: SERIAL, generation: GENERATION };
  it('copies exact identities, admitted bounds and control ranges into one owned record', () => {
    const input = { mode: 'fresh' as const, initialPages: 4, maximumPages: 16, channel: 65536, ...groupedOptions };
    const bytes = encodeGroupMemoryLayout(receipt, input), view = new DataView(bytes.buffer), f = P.layout.fields;
    input.controlEnd = 0;
    expect(bytes.length).toBe(P.layout.bytes); expect(view.getBigUint64(P.receipt_fields.serial, true)).toBe(SERIAL);
    expect(view.getBigUint64(P.receipt_fields.generation, true)).toBe(GENERATION);
    expect(view.getBigUint64(f.controlEnd, true)).toBe(3n * 65536n); expect(view.getBigUint64(f.channel, true)).toBe(65536n);
    expect(view.getUint32(f.maximumPages, true)).toBe(16); expect(view.getUint32(f.reserved, true)).toBe(0);
  });
  it('keeps inherited layout values absent and refuses hidden resets or malformed bounds', () => {
    const input = { mode: 'inherited' as const, initialPages: 4, maximumPages: 16, channel: 65536 };
    const bytes = encodeGroupMemoryLayout(receipt, input), view = new DataView(bytes.buffer);
    expect(view.getUint32(P.layout.fields.mode, true)).toBe(P.layout.modes.inherited);
    expect([...bytes.subarray(40, 80)].every(byte => byte === 0)).toBe(true);
    expect(() => encodeGroupMemoryLayout(receipt, { ...input, brkBase: 65536 })).toThrow();
    expect(() => encodeGroupMemoryLayout(receipt, { ...input, initialPages: 17 })).toThrow();
    expect(() => encodeGroupMemoryLayout(receipt, { ...input, mode: 'fresh' })).toThrow();
    expect(() => encodeGroupMemoryLayout({ ...receipt, serial: 0n }, input)).toThrow();
  });
});


function stoppedImageHarness(callbacks: CentralizedKernelCallbacks = {}) {
  const h = harness(4, callbacks);
  h.worker.createMemoryGroupBacking(23, 16);
  const receipt = h.worker.prepareMemoryGroupProcess(23, 100);
  if (typeof receipt === 'number') throw Error('missing receipt');
  const handle = h.worker.prepareMemoryGroupImage(receipt, { initialVirtualPages: 8, maximumVirtualPages: 16, scratchBytes: 65536 });
  if (typeof handle === 'number') throw Error('missing image');
  const launch = h.worker.publishMemoryGroupReplica(handle);
  if (typeof launch === 'number') throw Error('missing launch');
  h.worker.registerMemoryGroupProcess(handle, [65536], groupedOptions);
  const concrete = new MockWorkerHandle();
  h.worker.observeMemoryGroupReplicaWorker(handle, concrete, { terminationProvesQuiescence: false });
  const stop = () => concrete.simulateMessage({ type: 'memory_quiescent', pid: 100, memoryGroup: receipt });
  return { ...h, receipt, handle, launch, concrete, stop };
}

describe('published clone failure retirement', () => {
  it('joins an already requested stopped-thread retirement without waiting on its own full clone cleanup', async () => {
    let entered!: () => void, published!: () => void, rejectLaunch!: (error: Error) => void;
    const hasEntered = new Promise<void>(resolve => { entered = resolve; });
    const hasPublished = new Promise<void>(resolve => { published = resolve; });
    const held = new Promise<void>((_resolve, reject) => { rejectLaunch = reject; });
    const allocator = new ThreadPageAllocator({ firstSlotStartPage: 4, maxPageExclusive: 16, reservedSlots: 3, ptrWidth: 4 });
    const concrete = new MockWorkerHandle(), close = vi.fn(() => true);
    let plan: any;
    const h = stoppedImageHarness({ onGroupedClone: async attachment => {
      expect(await retryKernelEntryResult(() => { const pending = h.worker.reserveMemoryGroupThreadControl(attachment); entered(); return pending; })).toBe(4 * 65536);
      plan = await retryKernelEntryResult(() => h.worker.prepareMemoryGroupThreadLaunch(attachment, allocator));
      if (typeof plan === 'number' || plan.status !== 'ready') throw Error('thread not ready');
      h.worker.observeMemoryGroupReplicaWorker(plan.handle, concrete, { terminationProvesQuiescence: false, retireHostReferences: close });
      published(); await held;
    } });
    h.implementations.kernel_group_memory_thread_control_reuse.mockReturnValue(4n * 65536n);
    const receipt = h.implementations.kernel_memory_group_task_receipt;
    h.implementations.kernel_memory_group_task_receipt = (pid: number, tid: number, pointer: number | bigint, capacity: number) => {
      const result = receipt(pid, tid, pointer, capacity);
      if (tid === 101) new DataView(h.memory.buffer).setBigUint64(Number(pointer) + P.receipt_fields.serial, SERIAL + 1n, true);
      return result;
    };
    h.implementations.kernel_handle_channel = (pointer: number | bigint) => {
      const view = new DataView(h.memory.buffer, Number(pointer)); view.setBigInt64(CH_RETURN, 101n, true); view.setUint32(CH_ERRNO, 0, true); return 0;
    };
    const main = (h.worker as any).processes.get(100).channels[0], view = processDataView(main.source, 65536);
    let completed!: (result: { value: number; errno: number }) => void;
    const completion = new Promise<{ value: number; errno: number }>(resolve => { completed = resolve; });
    h.worker.testAuthority.configureScratchBoundaryHooksForTest({ completeChannel: (channel, _syscall, _args, _descs, value, errno) => {
      if (channel !== main) throw Error('Wrong clone completion');
      view.setUint32(CH_STATUS, CHANNEL_STATUS_COMPLETE, true); completed({ value: Number(value), errno });
    } });
    view.setUint32(CH_SYSCALL, SYSCALLS.Clone, true);
    [0x10100, 5 * 65536, 0, 0, 0, 0].forEach((value, at) => view.setBigInt64(CH_ARGS + at * CH_ARG_SIZE, BigInt(value), true));
    view.setUint32(CH_STATUS, CHANNEL_STATUS_PENDING, true);
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      (h.worker as any).handleSyscall(main); await hasEntered;
      const controls = new Int32Array(h.launch.envelope.memory.buffer, h.launch.expectation.replica, G.MEMORY_GROUP_REPLICA_BYTES / 4);
      Atomics.store(controls, G.MEMORY_GROUP_REPLICA_ACK / 4, Atomics.load(controls, G.MEMORY_GROUP_REPLICA_REQUEST / 4)); Atomics.notify(controls, G.MEMORY_GROUP_REPLICA_ACK / 4);
      await hasPublished;
      concrete.simulateMessage({ type: 'memory_quiescent', pid: 100, tid: 101, memoryGroup: plan.launch.expectation.receipt });
      await h.worker.waitForMemoryGroupReplicaQuiescence(plan.handle);
      h.worker.notifyThreadExit(100, 101); h.worker.removeChannel(100, plan.allocation.channelOffset);
      const retirement = h.worker.retireMemoryGroupThread(plan.handle, close);
      expect(close).not.toHaveBeenCalled();
      rejectLaunch(Error('late callback refusal after actual stop'));
      expect(await completion).toEqual({ value: -1, errno: 12 });
      expect(await retirement).toBe(0); expect(close).toHaveBeenCalledTimes(1);
      expect(h.implementations.kernel_group_memory_thread_control_release).toHaveBeenCalledTimes(1);
      expect(h.worker.inspectMemoryGroupBacking(23)).toMatchObject({ replicas: 1, quarantinedReplicas: 0 });
    } finally { diagnostic.mockRestore(); }
  });
});

describe('unconstructed clone control retirement', () => {
  it('joins exact control cleanup before releasing a revoked image, without completing its retired creator', async () => {
    let entered!: () => void, reserved!: () => void, rolledBack!: () => void;
    const hasEntered = new Promise<void>(resolve => { entered = resolve; });
    const hasReservation = new Promise<void>(resolve => { reserved = resolve; });
    const hasRollback = new Promise<void>(resolve => { rolledBack = resolve; });
    let observation!: ReturnType<typeof h.launch.source.prepareNativeObservationI32>;
    let wait!: ReturnType<typeof observation.arm>;
    const h = stoppedImageHarness({ onGroupedClone: async attachment => {
      expect(await retryKernelEntryResult(() => {
        const pending = h.worker.reserveMemoryGroupThreadControl(attachment); entered(); return pending;
      })).toBe(4 * 65536);
      observation = (h.worker as any).processes.get(100).source.prepareNativeObservationI32(4 * 65536); wait = observation.arm(0, 1000);
      reserved(); throw Error('launch refused after exact reservation');
    } });
    h.implementations.kernel_group_memory_thread_control_reuse.mockReturnValue(4n * 65536n);
    h.implementations.kernel_thread_exit.mockImplementation(() => { rolledBack(); return 0n; });
    h.implementations.kernel_handle_channel = (pointer: number | bigint) => {
      const view = new DataView(h.memory.buffer, Number(pointer));
      view.setBigInt64(CH_RETURN, 101n, true); view.setUint32(CH_ERRNO, 0, true); return 0;
    };
    const channel = (h.worker as any).processes.get(100).channels[0];
    const view = processDataView(channel.source, 65536);
    view.setUint32(CH_SYSCALL, SYSCALLS.Clone, true);
    [0x10100, 5 * 65536, 0, 0, 0, 0].forEach((value, at) => view.setBigInt64(CH_ARGS + at * CH_ARG_SIZE, BigInt(value), true));
    view.setUint32(CH_STATUS, CHANNEL_STATUS_PENDING, true);
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      (h.worker as any).handleSyscall(channel);
      await hasEntered;
      const controls = new Int32Array(h.launch.envelope.memory.buffer, h.launch.expectation.replica, G.MEMORY_GROUP_REPLICA_BYTES / 4);
      Atomics.store(controls, G.MEMORY_GROUP_REPLICA_ACK / 4, Atomics.load(controls, G.MEMORY_GROUP_REPLICA_REQUEST / 4));
      Atomics.notify(controls, G.MEMORY_GROUP_REPLICA_ACK / 4);
      await hasReservation; await hasRollback;
      expect(h.implementations.kernel_group_memory_thread_control_release).not.toHaveBeenCalled();
      expect(view.getUint32(CH_STATUS, true)).toBe(CHANNEL_STATUS_PENDING);
      h.stop(); h.implementations.kernel_get_process_state = () => PROCESS_STATE_EXITED;
      let closed!: () => void; const referencesClosed = new Promise<void>(resolve => { closed = resolve; });
      const charged = h.worker.inspectMemoryGroupBacking(23)!.allocatedPages;
      const retirement = h.worker.retireMemoryGroupImage(h.handle, closed);
      await referencesClosed;
      expect(h.worker.inspectMemoryGroupBacking(23)!.allocatedPages).toBe(charged);
      observation.wake(); if (wait.async) await wait.value;
      expect(await retirement).toBe(0);
      expect(h.implementations.kernel_group_memory_thread_control_release).toHaveBeenCalledWith(23, 100, 101,
        Number(SERIAL & 0xffffffffn) | 0, Number(SERIAL >> 32n) | 0, Number(GENERATION & 0xffffffffn) | 0, Number(GENERATION >> 32n) | 0);
      expect(h.worker.inspectMemoryGroupBacking(23)!.allocatedPages).toBe(1);
    } finally { observation?.wake(); diagnostic.mockRestore(); }
  });
});

describe('grouped late rollback failure containment', () => {
  it('reports a late old-image rollback error without signaling the replacement PID', async () => {
    let started!: () => void, rejectLaunch!: (error: Error) => void, failed!: (error: Error) => void;
    const launched = new Promise<void>(resolve => { started = resolve; });
    const held = new Promise<void>((_resolve, reject) => { rejectLaunch = reject; });
    const fatal = new Promise<Error>(resolve => { failed = resolve; });
    const h = stoppedImageHarness({ onGroupedClone: async () => { started(); await held; }, onKernelFatal: failed });
    h.implementations.kernel_handle_channel = (pointer: number | bigint) => {
      const view = new DataView(h.memory.buffer, Number(pointer)); view.setBigInt64(CH_RETURN, 101n, true); view.setUint32(CH_ERRNO, 0, true); return 0;
    };
    const main = (h.worker as any).processes.get(100).channels[0], view = processDataView(main.source, 65536);
    view.setUint32(CH_SYSCALL, SYSCALLS.Clone, true);
    [0x10100, 5 * 65536, 0, 0, 0, 0].forEach((value, at) => view.setBigInt64(CH_ARGS + at * CH_ARG_SIZE, BigInt(value), true));
    view.setUint32(CH_STATUS, CHANNEL_STATUS_PENDING, true); (h.worker as any).handleSyscall(main); await launched;
    const replacement = new WebAssembly.Memory({ initial: 3, maximum: 3, shared: true });
    h.worker.testAuthority.replaceProcessRegistrationForLifecycleTest({ pid: 100, memory: replacement, channelOffsets: [] });
    h.implementations.kernel_thread_exit.mockReturnValue(-5n);
    rejectLaunch(Error('late setup failure'));
    expect((await fatal).message).toContain('could not roll back allocated tid 101');
    expect(h.implementations.kernel_mark_process_signaled).not.toHaveBeenCalled();
    expect((h.worker as any).processes.get(100).memory).toBe(replacement);
    expect(h.worker.inspectMemoryGroupBacking(23)!.allocatedPages).toBeGreaterThan(1);
  });
});

describe('exact grouped crash authority', () => {
  it('refuses an invented image and old source before signaling a replacement PID', () => {
    const h = stoppedImageHarness();
    expect(h.worker.recordMemoryGroupCrash({} as any)).toBe(-3);
    expect(h.worker.recordMemoryGroupCrash(h.handle, 0)).toBe(-22);
    h.worker.testAuthority.replaceProcessRegistrationForLifecycleTest({ pid: 100,
      memory: new WebAssembly.Memory({ initial: 3, maximum: 3, shared: true }), channelOffsets: [] });
    expect(h.worker.recordMemoryGroupCrash(h.handle)).toBe(-3);
  });
});

describe('bounded exact image inspection', () => {
  it('returns only a scalar from the exact image and refuses a retired or invented capability', async () => {
    const h = stoppedImageHarness(), source = (h.worker as any).processes.get(100).source;
    source.atomicStoreI32(4, 0xf1234567 | 0);
    expect(h.worker.inspectMemoryGroupWord(h.handle, 4)).toBe(0xf1234567);
    expect(h.worker.inspectMemoryGroupWord({} as any, 4)).toBe(-3);
    expect(h.worker.inspectMemoryGroupReplicaWait({} as any)).toBe(-3);
    expect(h.worker.inspectMemoryGroupReplicaWait(h.handle)).toBe('none');
    expect(h.worker.inspectMemoryGroupWord(h.handle, 3)).toBe(-22);
    expect(h.worker.inspectMemoryGroupWord(h.handle, 15 * 65536)).toBe(-14);
    h.stop(); h.implementations.kernel_get_process_state = () => PROCESS_STATE_EXITED;
    expect(await h.worker.retireMemoryGroupImage(h.handle, () => {})).toBe(0);
    expect(h.worker.inspectMemoryGroupWord(h.handle, 4)).toBe(-3);
    expect(h.worker.inspectMemoryGroupReplicaWait(h.handle)).toBe(-3);
  });
});

describe('exact registered image retirement', () => {
  it('joins an asynchronous reference closer once before releasing old pages', async () => {
    const h = stoppedImageHarness(); h.stop();
    h.implementations.kernel_get_process_state = () => PROCESS_STATE_EXITED;
    let entered!: () => void, finish!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { finish = resolve; });
    const close = vi.fn(async () => { entered(); await held; });
    const allocated = h.worker.inspectMemoryGroupBacking(23)!.allocatedPages;
    const first = h.worker.retireMemoryGroupImage(h.handle, close);
    await started;
    const second = h.worker.retireMemoryGroupImage(h.handle, close);
    expect(h.worker.inspectMemoryGroupBacking(23)!.allocatedPages).toBe(allocated);
    expect(h.worker.getProcessMemory(100)).toBeUndefined();
    expect(close).toHaveBeenCalledTimes(1);
    finish();
    expect(await Promise.all([first, second])).toEqual([0, 0]);
    expect(h.worker.inspectMemoryGroupBacking(23)).toMatchObject({ images: 0, allocatedPages: 1 });
  });
  it('keeps pages charged after an asynchronous reference closer rejects', async () => {
    const h = stoppedImageHarness(); h.stop();
    h.implementations.kernel_get_process_state = () => PROCESS_STATE_EXITED;
    let entered!: () => void, fail!: (cause: Error) => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>((_resolve, reject) => { fail = reject; });
    const close = vi.fn(async () => { entered(); await held; });
    const allocated = h.worker.inspectMemoryGroupBacking(23)!.allocatedPages;
    const retirement = h.worker.retireMemoryGroupImage(h.handle, close);
    const rejected = expect(retirement).rejects.toThrow('async reference owner refused');
    await started;
    fail(Error('async reference owner refused'));
    await rejected;
    await expect(h.worker.retireMemoryGroupImage(h.handle, close)).rejects.toThrow('async reference owner refused');
    expect(close).toHaveBeenCalledTimes(1);
    expect(h.worker.inspectMemoryGroupBacking(23)!.allocatedPages).toBe(allocated);
  });
  it('requires both a concrete Worker stop and Rust exit before closing references or freeing pages', async () => {
    const h = stoppedImageHarness(), close = vi.fn();
    const allocated = h.worker.inspectMemoryGroupBacking(23)!.allocatedPages;
    expect(await h.worker.retireMemoryGroupImage(h.handle, close)).toBe(-16);
    expect(close).not.toHaveBeenCalled();
    h.stop();
    expect(await h.worker.retireMemoryGroupImage(h.handle, close)).toBe(-16);
    h.implementations.kernel_get_process_state = () => PROCESS_STATE_EXITED;
    close.mockImplementation(() => expect(h.worker.inspectMemoryGroupBacking(23)!.allocatedPages).toBe(allocated));
    expect(await h.worker.retireMemoryGroupImage(h.handle, close)).toBe(0);
    expect(close).toHaveBeenCalledTimes(1);
    expect(h.worker.inspectMemoryGroupBacking(23)).toMatchObject({ images: 0, replicas: 0, allocatedPages: 1, nativeObservers: 0 });
    expect(await h.worker.retireMemoryGroupImage(h.handle, close)).toBe(0);
    expect(close).toHaveBeenCalledTimes(1);
  });
  it('does not revoke registration or close references when Rust refuses retirement', async () => {
    const h = stoppedImageHarness(), close = vi.fn(); h.stop();
    h.implementations.kernel_get_process_state = () => PROCESS_STATE_EXITED;
    h.implementations.kernel_memory_group_retire_image.mockReturnValue(-16);
    const allocated = h.worker.inspectMemoryGroupBacking(23)!.allocatedPages;
    expect(await h.worker.retireMemoryGroupImage(h.handle, close)).toBe(-16);
    expect(close).not.toHaveBeenCalled();
    expect(h.worker.getProcessMemory(100)).toBeDefined();
    expect(h.worker.inspectMemoryGroupBacking(23)!.allocatedPages).toBe(allocated);
    h.implementations.kernel_memory_group_retire_image.mockReturnValue(0);
    expect(await h.worker.retireMemoryGroupImage(h.handle, close)).toBe(0);
  });
  it('retains charged storage if ending host references fails, without rerunning that callback', async () => {
    const h = stoppedImageHarness(); h.stop();
    h.implementations.kernel_get_process_state = () => PROCESS_STATE_EXITED;
    const close = vi.fn(() => { throw Error('reference owner refused'); });
    const allocated = h.worker.inspectMemoryGroupBacking(23)!.allocatedPages;
    await expect(h.worker.retireMemoryGroupImage(h.handle, close)).rejects.toThrow('reference owner refused');
    await expect(h.worker.retireMemoryGroupImage(h.handle, close)).rejects.toThrow('reference owner refused');
    expect(close).toHaveBeenCalledTimes(1);
    expect(h.worker.inspectMemoryGroupBacking(23)!.allocatedPages).toBe(allocated);
  });
  it('leaves a replacement with the same PID and shared Memory intact, including on a repeated old capability', async () => {
    const h = stoppedImageHarness(); h.stop();
    expect(h.worker.deactivateMemoryGroupProcess(h.handle)).toBe(true);
    const replacement = { ...h.receipt, serial: SERIAL - 1n, generation: GENERATION + 1n };
    h.implementations.kernel_get_process_exec_generation = (_pid: number, pointer: number | bigint) => {
      new DataView(h.memory.buffer).setBigUint64(Number(pointer), replacement.generation, true); return 8;
    };
    h.implementations.kernel_memory_group_task_receipt = (_pid: number, _tid: number, pointer: number | bigint) => {
      const view = new DataView(h.memory.buffer, Number(pointer), P.receipt_bytes), f = P.receipt_fields;
      for (const key of ['group', 'pid', 'tid'] as const) view.setUint32(f[key], replacement[key], true);
      view.setBigUint64(f.serial, replacement.serial, true); view.setBigUint64(f.generation, replacement.generation, true);
      return P.receipt_bytes;
    };
    const receipt = h.worker.prepareMemoryGroupProcess(23, 100);
    if (typeof receipt === 'number') throw Error('missing replacement receipt');
    const handle = h.worker.prepareMemoryGroupImage(receipt, { initialVirtualPages: 4, maximumVirtualPages: 16, scratchBytes: 65536 });
    if (typeof handle === 'number') throw Error('missing replacement image');
    const launch = h.worker.publishMemoryGroupReplica(handle);
    if (typeof launch === 'number') throw Error('missing replacement launch');
    h.worker.registerMemoryGroupProcess(handle, [65536], groupedOptions);
    const concrete = new MockWorkerHandle();
    h.worker.observeMemoryGroupReplicaWorker(handle, concrete, { terminationProvesQuiescence: false });
    processDataView(launch.source, 7, 1).setUint8(0, 0x97);
    expect(await h.worker.retireMemoryGroupImage(h.handle, () => {})).toBe(0);
    const allocated = h.worker.inspectMemoryGroupBacking(23)!.allocatedPages;
    expect(allocated).toBeGreaterThan(1);
    expect(h.worker.deactivateMemoryGroupProcess(h.handle)).toBe(false);
    const closeAgain = vi.fn();
    expect(await h.worker.retireMemoryGroupImage(h.handle, closeAgain)).toBe(0);
    expect(closeAgain).not.toHaveBeenCalled();
    expect(h.worker.inspectMemoryGroupBacking(23)!.allocatedPages).toBe(allocated);
    expect(processDataView(launch.source, 7, 1).getUint8(0)).toBe(0x97);
    concrete.simulateMessage({ type: 'memory_quiescent', pid: 100, memoryGroup: receipt });
    h.implementations.kernel_get_process_state = () => PROCESS_STATE_EXITED;
    expect(await h.worker.retireMemoryGroupImage(handle, () => {})).toBe(0);
  });
  it('keeps pages until an old grouped clone callback settles, even when Rust already reaped the image', async () => {
    let rejectClone!: (error: Error) => void, started!: () => void;
    const launched = new Promise<void>(resolve => { started = resolve; });
    const held = new Promise<void>((_resolve, reject) => { rejectClone = reject; });
    const h = stoppedImageHarness({ onGroupedClone: async () => { started(); await held; } });
    h.implementations.kernel_handle_channel = (pointer: number | bigint) => {
      const view = new DataView(h.memory.buffer, Number(pointer));
      view.setBigInt64(CH_RETURN, 101n, true); view.setUint32(CH_ERRNO, 0, true); return 0;
    };
    const channel = (h.worker as any).processes.get(100).channels[0];
    const view = processDataView(channel.source, 65536);
    view.setUint32(CH_SYSCALL, SYSCALLS.Clone, true);
    [0x10100, 5 * 65536, 0, 0, 0, 0].forEach((value, at) => view.setBigInt64(CH_ARGS + at * CH_ARG_SIZE, BigInt(value), true));
    view.setUint32(CH_STATUS, CHANNEL_STATUS_PENDING, true);
    (h.worker as any).handleSyscall(channel);
    await launched;
    h.stop();
    h.implementations.kernel_get_process_exec_generation = () => -3;
    h.implementations.kernel_memory_group_retire_image.mockReturnValue(-2);
    h.implementations.kernel_thread_exit.mockReturnValue(-3n);
    const allocated = h.worker.inspectMemoryGroupBacking(23)!.allocatedPages;
    let closed!: () => void;
    const referencesClosed = new Promise<void>(resolve => { closed = resolve; });
    const retirement = h.worker.retireMemoryGroupImage(h.handle, closed);
    await referencesClosed;
    expect(h.worker.inspectMemoryGroupBacking(23)!.allocatedPages).toBe(allocated);
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      rejectClone(Error('late construction failure'));
      expect(await retirement).toBe(0);
      expect(h.implementations.kernel_thread_exit).toHaveBeenCalledWith(100, 101, 0);
      expect(h.worker.inspectMemoryGroupBacking(23)!.allocatedPages).toBe(1);
    } finally { diagnostic.mockRestore(); }
  });
});
