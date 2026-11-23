import * as G from '../../src/generated/program-extensions';
import { GroupProcessAddressSpace, ProcessAddressFault, NativeI32Observation } from '../../src/process-address-space';
import { encodeProcessMemoryDescriptor } from '../../src/process-memory-descriptor';
import type { MemoryGroupTaskReceipt } from '../../src/memory-group-protocol';
import type { PreparedGroupReplica } from '../../src/group-memory-transport';

const PAGE = G.MEMORY_GROUP_PAGE_BYTES;

/** Static wire-format test data. Every page is reserved; this fixture has no
 * allocator, admission, publication, retirement or reclamation implementation.
 * Ownership behavior must be tested against Rust, not inferred from this data. */
export function groupMemoryLayout(options: {
  receipt: MemoryGroupTaskReceipt;
  initialPages?: number;
  maximumVirtualPages?: number;
  memory?: WebAssembly.Memory;
  rootPage?: number;
  replicaPage?: number;
  payloadPage?: number;
  retainNativeObservation?: (physical: number) => () => void;
}) {
  const memory = options.memory ?? new WebAssembly.Memory({ initial: 32, maximum: 32, shared: true });
  const maximumPhysicalPages = memory.buffer.byteLength / PAGE;
  initializeGroupMemoryMetadata(memory, maximumPhysicalPages);
  const receipt = Object.freeze({ ...options.receipt });
  const root = (options.rootPage ?? 1) * PAGE, replica = (options.replicaPage ?? 3) * PAGE;
  const maximumVirtualPages = options.maximumVirtualPages ?? 16;
  const initialPages = options.initialPages ?? 2;
  const words = new Uint32Array(memory.buffer);
  words[root / 4] = initialPages;
  words[root / 4 + 1] = maximumVirtualPages;
  words[root / 4 + 2] = PAGE;
  words[(root + G.MEMORY_GROUP_ROOT_RUN) / 4] = 1;
  for (let page = 0; page < initialPages; page++) {
    words[(root + G.MEMORY_GROUP_ROOT_HEADER_BYTES) / 4 + page] = ((options.payloadPage ?? 8) + page) * PAGE | 3;
  }
  const control = new DataView(memory.buffer, replica, G.MEMORY_GROUP_REPLICA_BYTES);
  for (const [offset, value] of [
    [G.MEMORY_GROUP_REPLICA_RUN, 1], [G.MEMORY_GROUP_REPLICA_ROOT, root],
    [G.MEMORY_GROUP_REPLICA_MAGIC_OFFSET, G.MEMORY_GROUP_REPLICA_MAGIC],
    [G.MEMORY_GROUP_REPLICA_PID, receipt.pid], [G.MEMORY_GROUP_REPLICA_TID, receipt.tid],
    [G.MEMORY_GROUP_REPLICA_GROUP, receipt.group],
  ]) control.setUint32(offset, value, true);
  control.setBigUint64(G.MEMORY_GROUP_REPLICA_SERIAL, receipt.serial, true);
  control.setBigUint64(G.MEMORY_GROUP_REPLICA_GENERATION, receipt.generation, true);
  let live = true;
  const assertLive = () => { if (!live) throw new ProcessAddressFault('retired'); };
  const expectation = Object.freeze({ receipt, root, replica, scratch: replica + G.MEMORY_GROUP_REPLICA_BYTES,
    scratchBytes: PAGE, maximumVirtualPages, maximumPhysicalPages, assertLive });
  const binding = { memory, root, maximumPages: maximumVirtualPages, assertLive };
  const source = new GroupProcessAddressSpace({ ...binding, retainNativeObservation: options.retainNativeObservation });
  const envelope = encodeProcessMemoryDescriptor(memory, { kind: G.MEMORY_GROUP_MODULE, receipt, root, replica,
    scratch: expectation.scratch, scratchBytes: PAGE, maximumVirtualPages }, { ...expectation, memory });
  const launch = { envelope, expectation, source: new GroupProcessAddressSpace(binding) };
  const handle = Object.freeze(Object.create(null)) as PreparedGroupReplica;
  const close = () => { live = false; source.detachHostAccess(); launch.source.detachHostAccess(); };
  return { memory, source, launch, handle, close };
}

/** A fake kernel reply for isolated channel/Worker scheduling tests. Count
 * actual NativeI32Observation lifetimes, without modeling Rust page custody. */
export function groupMemoryObservationFixture(options: Parameters<typeof groupMemoryLayout>[0],
  pending = new Set<object>()) {
  const retain = () => { const token = {}; pending.add(token); return () => { pending.delete(token); }; };
  const fixture = groupMemoryLayout({ ...options, retainNativeObservation: retain });
  const transport = {
    prepareChannelObservation(_handle: unknown, address: number, queue: boolean) {
      return queue ? new NativeI32Observation(new Int32Array(fixture.memory.buffer, G.MEMORY_GROUP_WAIT_HEADER, 1), retain())
        : fixture.source.prepareNativeObservationI32(address);
    },
  };
  return { ...fixture, transport, pending };
}

export function initializeGroupMemoryMetadata(memory: WebAssembly.Memory, maximumPages: number): void {
  const words = new Uint32Array(memory.buffer), control = G.MEMORY_GROUP_CONTROL / 4;
  if (words[control + 3] === G.MEMORY_GROUP_MAGIC) return;
  const physicalPages = memory.buffer.byteLength / PAGE;
  words[control + 1] = physicalPages;
  words[control + 2] = maximumPages;
  words[control + 3] = G.MEMORY_GROUP_MAGIC;
  for (let page = 0; page < physicalPages; page++) words[G.MEMORY_GROUP_BITMAP / 4 + (page >>> 5)] |= 1 << (page & 31);
}
