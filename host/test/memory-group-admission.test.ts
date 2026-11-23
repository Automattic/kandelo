import { describe, expect, it, vi } from 'vitest';
import { createCentralizedKernelWorkerTestDouble } from '../src/kernel-worker';
import { KernelEntryGate, createKernelEntryGatedInstance, KernelReentrantEntryError } from '../src/kernel-entry-gate';
import { allocateKernelScratchRegion } from '../src/kernel-scratch';
import { CH_TOTAL_SIZE, MEMORY_GROUP_PROTOCOL as P, PROCESS_STATE_RUNNING } from '../src/generated/abi';
import { createKernelScratchTestInstance } from './support/kernel-scratch-instance';

// Explicit wire replies only. Real ownership and Worker retirement are checked
// in group-memory-worker-boundary and the Rust/SDK suites.
const GENERATION = 0x8000000100000003n, SERIAL = 0xfffffffffffffff1n;
const groupedOptions = { brkBase: 3 * 65536, brkLimit: 16 * 65536, mmapBase: 4 * 65536, controlBase: 0, controlEnd: 3 * 65536, maxAddr: 16 * 65536 };
function harness(pointerWidth: 4 | 8 = 4) {
  const memory = new WebAssembly.Memory({ initial: 4, maximum: 8 }), gate = new KernelEntryGate();
  const implementations: Record<string, any> = {
    kernel_get_process_state: () => PROCESS_STATE_RUNNING,
    kernel_memory_group_protocol_version: () => P.version,
    kernel_memory_group_capabilities: () => P.capability_admission | P.mapping.capability | P.layout.capability,
    kernel_memory_group_configure: vi.fn(() => 0),
    kernel_memory_group_create: vi.fn(() => 23),
    kernel_memory_group_seal: vi.fn(() => 0),
    kernel_memory_group_remove: vi.fn(() => -16),
    kernel_memory_group_prepare_process: vi.fn(() => 0),
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
  return { worker, instance, implementations, memory };
}
describe('kernel-Worker memory group metadata transport', () => {
  it('refuses in-place admission of an already registered native image', () => {
    const { worker, implementations } = harness();
    worker.testAuthority.replaceProcessRegistrationForLifecycleTest({ pid: 100,
      memory: new WebAssembly.Memory({ initial: 3, maximum: 3, shared: true }), channelOffsets: [] });
    expect(worker.prepareMemoryGroupProcess(23, 100)).toBe(-16);
    expect(implementations.kernel_memory_group_prepare_process).not.toHaveBeenCalled();
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
      () => worker.inspectMemoryGroup(23), () => worker.inspectMemoryGroupUsage(23), () => worker.prepareMemoryGroupProcess(23, 100),
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
