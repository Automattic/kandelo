import { describe, expect, it, vi } from 'vitest';
import { createCentralizedKernelWorkerTestDouble } from '../src/kernel-worker';
import { KernelEntryGate, createKernelEntryGatedInstance, KernelReentrantEntryError } from '../src/kernel-entry-gate';
import { allocateKernelScratchRegion } from '../src/kernel-scratch';
import { CH_TOTAL_SIZE, MEMORY_GROUP_PROTOCOL as P, PROCESS_STATE_RUNNING } from '../src/generated/abi';
import { createKernelScratchTestInstance } from './support/kernel-scratch-instance';
const GENERATION = 0x8000000100000003n, SERIAL = 0xfffffffffffffff1n;
function harness(pointerWidth: 4 | 8 = 4) {
  const memory = new WebAssembly.Memory({ initial: 4, maximum: 8 }), gate = new KernelEntryGate();
  const implementations: Record<string, any> = {
    kernel_get_process_state: () => PROCESS_STATE_RUNNING,
    kernel_memory_group_protocol_version: () => P.version,
    kernel_memory_group_capabilities: () => P.capability_admission,
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
    128, pointerWidth, 'group admission test', instance);
  const worker = createCentralizedKernelWorkerTestDouble();
  worker.testAuthority.initializeKernelForTest({ instance, gate, mainScratch: scratch });
  return { worker, instance, implementations, memory };
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
    expect(() => worker.registerMemoryGroupProcess(handle, [65536])).toThrow(/published main/);
    const launch = worker.publishMemoryGroupReplica(handle);
    if (typeof launch === 'number') throw Error('missing launch');
    worker.registerMemoryGroupProcess(handle, [65536], { maxAddr: 16 * 65536 });
    const registration = (worker as any).processes.get(100);
    expect(registration.source).not.toBe(launch.source);
    expect(registration.source).not.toBe(launch.envelope.memory);
    launch.source.writeBytes(77, Uint8Array.of(91));
    expect(registration.source.readBytes(77, 1)).toEqual(Uint8Array.of(91));
    expect(registration.channels[0]).toMatchObject({ source: registration.source, channelOffset: 65536 });
    expect(registration.channels[0].i32View).toBeUndefined();
    expect(registration.execGeneration).toBe(GENERATION);
    expect(implementations.kernel_set_main_channel_addr).toHaveBeenCalledWith(100, 65536n);
    expect(implementations.kernel_set_max_addr).toHaveBeenCalledWith(100, 16 * 65536);
    expect(() => worker.registerMemoryGroupProcess(handle, [65536])).toThrow(/already installed/);
    // Withdrawal of a host record does not make a published task a new image.
    (worker as any).processes.delete(100);
    expect(() => worker.registerMemoryGroupProcess(handle, [65536])).toThrow(/already installed/);
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
    expect(() => worker.registerMemoryGroupProcess(handle, [65536])).toThrow(/exact kernel task image/);
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
    expect(() => worker.registerMemoryGroupProcess({} as any, [65536])).toThrow(/Unknown/);
    expect(() => worker.registerMemoryGroupProcess(handle, [4 * 65536 - CH_TOTAL_SIZE + 4])).toThrow();
    expect(() => worker.registerMemoryGroupProcess(handle, [65537])).toThrow(/aligned/);
    expect(() => worker.registerMemoryGroupProcess(handle, [65536], { ptrWidth: 8 })).toThrow(/wasm32/);
    expect(() => worker.registerMemoryGroupProcess(handle, [65536], { borrowedAddressSpace: true })).toThrow(/owned image/);
    expect(() => worker.registerMemoryGroupProcess(handle, [65536], { maxAddr: 17 * 65536 })).toThrow(/virtual ceiling/);
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
    calls.push(() => worker.registerMemoryGroupProcess({} as any, [65536]));
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
