import { describe, expect, it, vi } from 'vitest';
import { GroupMemoryTransport, GroupMemoryStorageRefusal, type GroupMemoryEntry } from '../src/group-memory-transport';
import { MEMORY_GROUP_PROTOCOL as P, ERRNO } from '../src/generated/abi';
import { encodeMemoryGroupReceipt, MemoryGroupProtocolFault } from '../src/memory-group-protocol';
import { KernelEntryGate, createKernelEntryGatedInstance, createKernelEntryScopedInstance } from '../src/kernel-entry-gate';
import { allocateKernelScratchRegion } from '../src/kernel-scratch';
import { createKernelScratchTestInstance } from './support/kernel-scratch-instance';
import { groupMemoryLayout } from './support/group-memory-layout';

// These are wire and platform-reference tests. Replies are explicit fixtures;
// real allocation, mapping and retirement rules are tested in Rust and SDK runs.
function harness(width: 4 | 8) {
  const receipt = { group: 7, pid: 100, tid: 100, serial: (1n << 63n) + 3n, generation: (1n << 55n) + 1n };
  const fixture = groupMemoryLayout({ receipt });
  const memory = new WebAssembly.Memory({ initial: 2 }), gate = new KernelEntryGate();
  const packet = new Uint8Array(P.storage.reply_bytes), view = new DataView(packet.buffer), fields = P.storage.reply_fields;
  packet.set(encodeMemoryGroupReceipt(receipt));
  view.setBigUint64(fields.resource, (1n << 63n) + 17n, true);
  for (const key of ['root', 'replica', 'scratch', 'maximumPhysicalPages', 'maximumVirtualPages', 'scratchBytes'] as const) {
    view.setUint32(fields[key], fixture.launch.expectation[key], true);
  }
  let prepareStatus = P.storage.reply_bytes, actionStatus = P.storage.reply_bytes, mappingStatus = 0;
  const write = (pointer: number | bigint, capacity: number) => {
    expect(capacity).toBe(packet.length);
    new Uint8Array(memory.buffer, Number(pointer), packet.length).set(packet);
  };
  const implementations = {
    kernel_memory_group_storage_prepare: vi.fn((_input: number | bigint, _length: number, _initial: number, _maximum: number,
      _scratch: number, output: number | bigint, capacity: number) => { write(output, capacity); return prepareStatus; }),
    kernel_memory_group_storage_action: vi.fn((_input: number | bigint, _length: number, _action: number, _token: bigint,
      _argument: number, output: number | bigint, capacity: number) => { write(output, capacity); return actionStatus; }),
    kernel_memory_group_storage_mapping: vi.fn(() => mappingStatus),
  };
  const raw = createKernelScratchTestInstance(width, memory, () => implementations,
    () => width === 8 ? 4096n : 4096, 4, Object.keys(implementations));
  const instance = createKernelEntryGatedInstance(raw, gate);
  const scratch = allocateKernelScratchRegion(memory, instance.exports.kernel_alloc_scratch as (size: number) => number | bigint,
    4096, width, 'group transport wire test', instance);
  const settleNative = vi.fn();
  const resources = vi.fn((id: bigint) => { expect(id).toBe((1n << 63n) + 17n); return fixture.memory; });
  const store = new GroupMemoryTransport(7, { memory: resources, settleNative }, scratch, instance);
  function enter<T>(work: (entry: GroupMemoryEntry) => T): T {
    let result!: T;
    let failed = false, failure: unknown;
    gate.runImmediateVoidIngress('group transport wire test', scope => {
      // Like a result-bearing API wrapper, carry expected refusals out of the
      // entry without treating this test callback's assertion as a gate fault.
      try { result = work({ scope, instance: createKernelEntryScopedInstance(instance, scope) }); }
      catch (cause) { failed = true; failure = cause; }
      return undefined;
    });
    if (failed) throw failure;
    return result;
  }
  const prepare = () => enter(entry => store.prepareImage(receipt,
    { initialVirtualPages: 2, maximumVirtualPages: 16, scratchBytes: 65536 }, entry));
  return { receipt, fixture, memory, packet, view, fields, implementations, store, enter, prepare, resources, settleNative,
    prepareStatus: (value: number) => { prepareStatus = value; }, actionStatus: (value: number) => { actionStatus = value; },
    mappingStatus: (value: number) => { mappingStatus = value; } };
}

describe.each([4, 8] as const)('Rust group storage transport at kernel pointer width %s', width => {
  it('copies exact unsigned identities and keeps the resource lease private when publishing', () => {
    const h = harness(width), handle = h.prepare();
    const launch = h.enter(entry => h.store.publish(handle, h.receipt, entry));
    expect(launch.expectation.receipt).toEqual(h.receipt);
    expect(launch.envelope.memory).toBe(h.fixture.memory);
    expect(launch.expectation).not.toHaveProperty('resource');
    expect(launch.envelope.descriptor).not.toHaveProperty('resource');
    h.packet.fill(0);
    expect(h.store.receipt(handle)).toEqual(h.receipt);
    expect(launch.source.readBytes(0, 4)).toEqual(new Uint8Array(4));
    h.store.close();
    expect(() => launch.source.readBytes(0, 1)).toThrow('retired');
  });

  it.each([ERRNO.ENOMEM, ERRNO.EAGAIN])('preserves Rust preparation refusal %s without resolving a platform resource', errno => {
    const h = harness(width); h.prepareStatus(-errno);
    expect(h.prepare).toThrow(errno === ERRNO.ENOMEM ? RangeError : GroupMemoryStorageRefusal);
    expect(h.resources).not.toHaveBeenCalled();
  });

  it.each(['serial', 'generation'] as const)('rejects a malformed or foreign %s preparation reply', field => {
    const short = harness(width); short.prepareStatus(P.storage.reply_bytes - 1);
    expect(short.prepare).toThrow(MemoryGroupProtocolFault);
    const foreign = harness(width); foreign.view.setBigUint64(P.receipt_fields[field], foreign.receipt[field] ^ (1n << 40n), true);
    expect(foreign.prepare).toThrow(MemoryGroupProtocolFault);
  });

  it('refuses new preparation before calling Rust after platform closure', () => {
    const h = harness(width); h.store.close();
    expect(h.prepare).toThrow('transport is closed');
    expect(h.implementations.kernel_memory_group_storage_prepare).not.toHaveBeenCalled();
  });

  it('retains platform references on a Rust publication refusal', () => {
    const h = harness(width), handle = h.prepare(); h.actionStatus(-ERRNO.EBUSY);
    expect(() => h.enter(entry => h.store.publish(handle, h.receipt, entry))).toThrow('publication refused');
    expect(h.store.receipt(handle)).toEqual(h.receipt);
    expect(h.resources).not.toHaveBeenCalled();
  });

  it('settles a cancelled never-exposed replica Promise only after the Rust acknowledgement', async () => {
    const h = harness(width), handle = h.prepare(), stopped = h.store.waitForReplicaQuiescence(handle);
    h.actionStatus(-ERRNO.EAGAIN);
    expect(() => h.enter(entry => h.store.forgetCancelledReplica(handle, entry))).toThrow('refused');
    expect(h.store.receipt(handle)).toEqual(h.receipt);
    h.actionStatus(-ERRNO.ESRCH);
    h.enter(entry => h.store.forgetCancelledReplica(handle, entry));
    await stopped;
    expect(() => h.store.receipt(handle)).toThrow('Unknown grouped platform handle');
  });

  it('reports an unarmed native token exactly once without carrying an entry into its settlement', () => {
    const h = harness(width), handle = h.prepare();
    h.view.setBigUint64(h.fields.value, (1n << 62n) + 9n, true);
    h.view.setUint32(h.fields.waitAddress, h.fixture.launch.expectation.replica + 8, true);
    const observation = h.enter(entry => h.store.prepareChannelObservation(handle, h.receipt, 0, entry));
    expect(h.settleNative).not.toHaveBeenCalled();
    observation.cancelUnarmed();
    expect(h.settleNative).toHaveBeenCalledExactlyOnceWith(h.receipt, (1n << 62n) + 9n);
    expect(() => observation.cancelUnarmed()).toThrow();
  });

  it('binds a pthread observation to its exact task instead of the leader handle', () => {
    const h = harness(width);
    const handle = h.prepare();
    const thread = { ...h.receipt, tid: 101, serial: h.receipt.serial + 1n };
    h.packet.set(encodeMemoryGroupReceipt(thread));
    h.view.setBigUint64(h.fields.value, 19n, true);
    h.view.setUint32(h.fields.waitAddress, h.fixture.launch.expectation.replica + 8, true);
    h.implementations.kernel_memory_group_storage_action.mockImplementation((input, length, action, _token,
      argument, output, capacity) => {
      expect(new Uint8Array(h.memory.buffer, Number(input), length)).toEqual(encodeMemoryGroupReceipt(thread));
      expect(action).toBe(P.storage.actions.pinChannel);
      expect(argument).toBe(65536);
      new Uint8Array(h.memory.buffer, Number(output), capacity).set(h.packet);
      return capacity;
    });
    const observation = h.enter(entry => h.store.prepareChannelObservation(handle, thread, 65536, entry));
    observation.cancelUnarmed();
    expect(h.settleNative).toHaveBeenCalledExactlyOnceWith(thread, 19n);
  });

  it('does not resolve a backing object after Rust refuses the exact task pin', () => {
    const h = harness(width), handle = h.prepare();
    const thread = { ...h.receipt, tid: 101, serial: h.receipt.serial + 1n };
    h.actionStatus(-ERRNO.ESRCH);
    expect(() => h.enter(entry => h.store.prepareChannelObservation(handle, thread, 65536, entry)))
      .toThrow(GroupMemoryStorageRefusal);
    expect(h.resources).not.toHaveBeenCalled();
    expect(h.settleNative).not.toHaveBeenCalled();
  });

  it('keeps unexpected channel observation refusals fatal without resolving a backing', () => {
    const h = harness(width), handle = h.prepare();
    h.actionStatus(-ERRNO.EIO);
    expect(() => h.enter(entry => h.store.prepareChannelObservation(handle, h.receipt, 0, entry)))
      .toThrow(MemoryGroupProtocolFault);
    expect(h.resources).not.toHaveBeenCalled();
    expect(h.settleNative).not.toHaveBeenCalled();
  });

  it('holds a real native wait until its actual settlement after transport closure', async () => {
    const h = harness(width), handle = h.prepare();
    h.view.setBigUint64(h.fields.value, 11n, true);
    h.view.setUint32(h.fields.waitAddress, h.fixture.launch.expectation.replica + 8, true);
    const observation = h.enter(entry => h.store.prepareChannelObservation(handle, h.receipt, 0, entry));
    const wait = observation.arm(0, 1000); expect(wait.async).toBe(true);
    h.store.close(); expect(h.settleNative).not.toHaveBeenCalled();
    observation.wake(); if (wait.async) await wait.value;
    expect(h.settleNative).toHaveBeenCalledExactlyOnceWith(h.receipt, 11n);
  });

  it('keeps platform handles until Rust confirms exact cancellation', () => {
    const h = harness(width), handle = h.prepare(); h.actionStatus(-ERRNO.EAGAIN);
    expect(() => h.enter(entry => h.store.forgetCancelledReplica(handle, entry))).toThrow();
    expect(h.store.receipt(handle)).toEqual(h.receipt);
    h.actionStatus(-ERRNO.ESRCH);
    h.enter(entry => h.store.forgetCancelledReplica(handle, entry));
    expect(() => h.store.receipt(handle)).toThrow('Unknown grouped platform handle');
  });
});
