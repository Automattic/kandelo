import { encodeGroupMemoryChangeRequest, decodeGroupMemoryChangeDescription, encodeGroupMemoryLayout } from '../src/memory-group-protocol';
import { describe, expect, it, vi } from 'vitest';
import { createCentralizedKernelWorkerTestDouble } from '../src/kernel-worker';
import { KernelEntryGate, createKernelEntryGatedInstance, KernelReentrantEntryError } from '../src/kernel-entry-gate';
import { allocateKernelScratchRegion } from '../src/kernel-scratch';
import { CH_TOTAL_SIZE, MEMORY_GROUP_PROTOCOL as P, PROCESS_STATE_RUNNING, ABI_SYSCALLS as SYSCALLS,
  CH_STATUS, CH_SYSCALL, CH_ARGS, CH_ARG_SIZE, CH_RETURN, CH_ERRNO, CHANNEL_STATUS_PENDING, CHANNEL_STATUS_COMPLETE } from '../src/generated/abi';
import * as G from '../src/generated/program-extensions';
import { processDataView } from '../src/process-memory-views';
import { MemoryGroupPagePool } from '../src/memory-group-pool';
import { createKernelScratchTestInstance } from './support/kernel-scratch-instance';
const GENERATION = 0x8000000100000003n, SERIAL = 0xfffffffffffffff1n;
const groupedOptions = { brkBase: 3 * 65536, brkLimit: 16 * 65536, mmapBase: 4 * 65536, controlBase: 0, controlEnd: 3 * 65536, maxAddr: 16 * 65536 };
function harness(pointerWidth: 4 | 8 = 4) {
  const layoutRecords: Uint8Array[] = [];
  const memory = new WebAssembly.Memory({ initial: 4, maximum: 8 }), gate = new KernelEntryGate();
  const implementations: Record<string, any> = {
    kernel_get_process_state: () => PROCESS_STATE_RUNNING,
    kernel_memory_group_protocol_version: () => P.version,
    kernel_memory_group_capabilities: () => P.capability_admission | P.mapping.capability | P.layout.capability,
    kernel_group_memory_layout_install: vi.fn((pointer: number | bigint, length: number) => { layoutRecords.push(new Uint8Array(memory.buffer, Number(pointer), length).slice()); return 0; }),
    kernel_group_memory_break: vi.fn(() => BigInt(3 * 65536)),
    kernel_group_memory_change_prepare: vi.fn(() => -95),
    kernel_group_memory_change_validate: vi.fn(() => -95),
    kernel_group_memory_change_commit: vi.fn(() => -95),
    kernel_group_memory_change_cancel: vi.fn(() => 0),
    kernel_set_current_tid: () => 0,
    kernel_get_process_exit_signal: () => -1,
    kernel_dequeue_signal: vi.fn(() => 0),
    kernel_handle_guest_io: vi.fn(() => 0),
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
  const worker = createCentralizedKernelWorkerTestDouble();
  worker.testAuthority.initializeKernelForTest({ instance, gate, mainScratch: scratch });
  return { worker, instance, implementations, memory, layoutRecords };
}
describe('kernel-Worker memory group admission', () => {
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
      .toEqual([P.task_actions.start, P.task_actions.start, P.task_actions.quarantine]);
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
  const effect = { kind: 'map' as 'map' | 'protect' | 'unmap' | 'break', address: 8 * page, length: page, prot: 3, flags: 0x22, result: 8 * page, oldAddress: 0, oldLength: 0 };
  const writeDescription = (pointer: number | bigint, capacity: number) => {
    expect(capacity).toBe(P.mapping.description_bytes);
    const data = new DataView(h.memory.buffer, Number(pointer), capacity), f = P.mapping.description_fields;
    new Uint8Array(h.memory.buffer, Number(pointer), capacity).fill(0);
    for (const [field, value] of Object.entries({ group: 23, pid: 100, tid: 100 })) data.setUint32(P.receipt_fields[field as 'group' | 'pid' | 'tid'], value, true);
    data.setBigUint64(P.receipt_fields.serial, SERIAL, true); data.setBigUint64(P.receipt_fields.generation, GENERATION, true);
    data.setBigUint64(f.token, token, true); data.setUint32(f.kind, P.mapping.kinds[effect.kind], true);
    data.setUint32(f.prot, effect.prot, true); data.setUint32(f.flags, effect.flags, true);
    for (const field of ['address', 'length', 'result', 'oldAddress', 'oldLength'] as const) data.setBigUint64(f[field], BigInt(effect[field]), true);
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
    const pending = kw.pendingGroupMappings.get(channel);
    if (pending) { kw.retireChannelHostWaits(channel); await pending.finished; }
    store.close();
  };
  return { ...h, kw, page, token, registration, channel, store, launch, captured, observedPages, effect, completed, completions, control, acknowledge, dispatch, close };
}

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
    const keyA = {}, keyB = {}; h.kw.pendingGroupMappings.set(keyA, a); h.kw.pendingGroupMappings.set(keyB, b);
    const original = h.store.beginImageExecutionPause.bind(h.store);
    const spy = vi.spyOn(h.store, 'beginImageExecutionPause').mockImplementation((...args: any[]) => { const value = original(...args); started(); return value; });
    try {
      const pending = h.dispatch(); b.done = true; h.kw.pendingGroupMappings.delete(keyB); finishB();
      expect(await Promise.race([waiting, barrierStarted])).toBe('waiting'); expect(spy).not.toHaveBeenCalled();
      a.done = true; h.kw.pendingGroupMappings.delete(keyA); finishA(); await barrierStarted;
      h.acknowledge(); await h.completed; await pending.finished;
      expect(h.implementations.kernel_group_memory_change_prepare).toHaveBeenCalledTimes(1);
    } finally { a.done = true; b.done = true; h.kw.pendingGroupMappings.delete(keyA); h.kw.pendingGroupMappings.delete(keyB); finishA(); finishB(); spy.mockRestore(); await h.close(); }
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
    h.kw.pendingGroupMappings.set(key, predecessor);
    let started!: () => void; const barrierStarted = new Promise<void>(resolve => { started = resolve; });
    const original = h.store.beginImageExecutionPause.bind(h.store);
    const spy = vi.spyOn(h.store, 'beginImageExecutionPause').mockImplementation((...args: any[]) => {
      const barrier = original(...args); started(); return barrier;
    });
    try {
      const pending = h.dispatch(); expect(h.implementations.kernel_group_memory_change_prepare).not.toHaveBeenCalled();
      expect(spy).not.toHaveBeenCalled();
      if (retire) { h.kw.retireChannelHostWaits(h.channel); await pending.finished; }
      predecessor.done = true; h.kw.pendingGroupMappings.delete(key); finish();
      if (!retire) { await barrierStarted; h.acknowledge(); await h.completed; await pending.finished; }
      expect(h.implementations.kernel_group_memory_change_prepare).toHaveBeenCalledTimes(retire ? 0 : 1);
      expect(h.completions.length).toBe(retire ? 0 : 1);
    } finally { h.kw.pendingGroupMappings.delete(key); predecessor.done = true; finish(); spy.mockRestore(); await h.close(); }
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
