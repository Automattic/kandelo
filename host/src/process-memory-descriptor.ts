import * as G from './generated/program-extensions';
import { GroupProcessAddressSpace } from './process-address-space';
import { MemoryGroupPagePool } from './memory-group-pool';
import { MemoryGroupProtocolFault, memoryGroupU32, type MemoryGroupTaskReceipt } from './memory-group-protocol';
import type { ProcessMemorySource } from './process-memory-views';

const PAGE = G.MEMORY_GROUP_PAGE_BYTES;
const bufferGetter = Object.getOwnPropertyDescriptor(WebAssembly.Memory.prototype, 'buffer')!.get!;

/** Versioned metadata for kernel/process-Worker transport. The envelope adds
 * one complete guest backing and must never enter persistent browser/audio realms.
 */
export interface NativeProcessMemoryDescriptor {
  readonly kind: 'linear';
}
export interface GroupReplicaMemoryDescriptor {
  readonly kind: typeof G.MEMORY_GROUP_MODULE;
  readonly receipt: MemoryGroupTaskReceipt;
  readonly root: number;
  readonly replica: number;
  readonly maximumVirtualPages: number;
  readonly scratch: number;
  readonly scratchBytes: number;
}
export type ProcessMemoryDescriptor = NativeProcessMemoryDescriptor | GroupReplicaMemoryDescriptor;
export interface ProcessMemoryEnvelope {
  readonly memory: WebAssembly.Memory;
  readonly descriptor: ProcessMemoryDescriptor;
}

/** The receiver obtains this expectation from its admitted launch owner, not
 * from the descriptor being checked. Receipts are copied metadata, not an
 * admission capability or evidence that a former Worker stopped executing.
 */
export interface GroupReplicaMemoryExpectation {
  readonly receipt: MemoryGroupTaskReceipt;
  readonly root: number;
  readonly replica: number;
  readonly scratch: number;
  readonly maximumPhysicalPages: number;
  readonly maximumVirtualPages: number;
  readonly scratchBytes: number;
  readonly assertLive: () => void;
}
export interface GroupReplicaMemoryLaunchBinding extends GroupReplicaMemoryExpectation {
  readonly memory: WebAssembly.Memory;
}

function fault(message: string): never { throw new MemoryGroupProtocolFault(message); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return fault('Process memory descriptor must contain plain transport records');
  }
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Object.getOwnPropertySymbols(value).length || Object.keys(fields).length !== keys.length
      || keys.some(key => !Object.hasOwn(fields, key) || !Object.hasOwn(fields[key], 'value'))) {
    return fault('Unexpected or accessor-bearing process memory descriptor');
  }
  const copy: Record<string, unknown> = {};
  for (const key of keys) copy[key] = fields[key].value;
  return copy;
}
function receipt(value: unknown): MemoryGroupTaskReceipt {
  const data = record(value, ['group', 'pid', 'tid', 'serial', 'generation']);
  if (!memoryGroupU32(data.group as number, data.pid as number, data.tid as number)
      || !(data.group as number) || (data.group as number) > 0x7fffffff
      || (data.pid as number) <= 1 || (data.tid as number) <= 1
      || typeof data.serial !== 'bigint' || data.serial <= 0n || data.serial > 0xffffffffffffffffn
      || typeof data.generation !== 'bigint' || data.generation < 0n || data.generation > 0xffffffffffffffffn) {
    return fault('Invalid process memory task receipt');
  }
  return Object.freeze(data) as unknown as MemoryGroupTaskReceipt;
}
function memory(value: unknown): { memory: WebAssembly.Memory; bytes: number } {
  let buffer: ArrayBufferLike;
  try { buffer = Reflect.apply(bufferGetter, value, []) as ArrayBufferLike; }
  catch { return fault('Process memory descriptor requires a genuine WebAssembly.Memory'); }
  if (!(buffer instanceof SharedArrayBuffer) || buffer.byteLength % PAGE) {
    return fault('Worker process memory must have shared standard-page storage');
  }
  return { memory: value as WebAssembly.Memory, bytes: buffer.byteLength };
}
function snapshot(value: unknown, owner?: GroupReplicaMemoryExpectation): ProcessMemoryEnvelope {
  const envelope = record(value, ['memory', 'descriptor']);
  const storage = memory(envelope.memory);
  value = envelope.descriptor;
  // Read the tag as an own data property. Never invoke transport getters.
  if (!value || typeof value !== 'object') return fault('Missing process memory descriptor');
  const kind = Object.getOwnPropertyDescriptor(value, 'kind');
  if (!kind || !Object.hasOwn(kind, 'value')) return fault('Missing process memory descriptor kind');
  if (kind.value === 'linear') {
    if (owner) return fault('An admitted grouped replica cannot use native memory addressing');
    record(value, ['kind']);
    return Object.freeze({ memory: storage.memory, descriptor: Object.freeze({ kind: 'linear' }) });
  }
  if (kind.value !== G.MEMORY_GROUP_MODULE || !owner || typeof owner.assertLive !== 'function') {
    return fault('Grouped memory requires its exact version and admitted replica owner');
  }
  const data = record(value, ['kind', 'receipt', 'root', 'replica', 'maximumVirtualPages', 'scratch', 'scratchBytes']);
  const task = receipt(data.receipt), expected = receipt(owner.receipt);
  for (const field of ['group', 'pid', 'tid', 'serial', 'generation'] as const) {
    if (task[field] !== expected[field]) return fault('Process memory descriptor names another task or image');
  }
  if (!memoryGroupU32(owner.maximumPhysicalPages, owner.maximumVirtualPages, owner.scratchBytes)
      || owner.maximumPhysicalPages < 2 || owner.maximumPhysicalPages > G.MEMORY_GROUP_MAXIMUM_PAGES
      || owner.maximumVirtualPages < 1 || owner.maximumVirtualPages > 65536
      || owner.scratchBytes < PAGE || owner.scratchBytes % PAGE
      || data.maximumVirtualPages !== owner.maximumVirtualPages || data.scratchBytes !== owner.scratchBytes
      || data.root !== owner.root || data.replica !== owner.replica || data.scratch !== owner.scratch
      || !memoryGroupU32(data.root as number, data.replica as number, data.scratch as number)
      || (data.root as number) < PAGE || (data.root as number) % PAGE
      || (data.replica as number) < PAGE || (data.replica as number) % PAGE
      || (data.scratch as number) !== (data.replica as number) + G.MEMORY_GROUP_REPLICA_BYTES) {
    return fault('Invalid admitted replica memory layout');
  }
  const root = data.root as number, scratch = data.scratch as number, replica = data.replica as number;
  const controlBytes = Math.ceil((G.MEMORY_GROUP_ROOT_HEADER_BYTES + owner.maximumVirtualPages * 4) / PAGE) * PAGE;
  const replicaBytes = Math.ceil((G.MEMORY_GROUP_REPLICA_BYTES + owner.scratchBytes) / PAGE) * PAGE;
  if (storage.bytes > owner.maximumPhysicalPages * PAGE || root > storage.bytes - controlBytes
      || replica > storage.bytes - replicaBytes
      || (root < replica + replicaBytes && replica < root + controlBytes)) {
    return fault('Replica controls exceed or overlap their admitted physical storage');
  }
  try { MemoryGroupPagePool.attach(storage.memory, owner.maximumPhysicalPages); }
  catch { return fault('Replica descriptor has incompatible physical pool metadata'); }
  const header = new Uint32Array(storage.memory.buffer, root, G.MEMORY_GROUP_ROOT_HEADER_BYTES / 4);
  if (Atomics.load(header, 0) > owner.maximumVirtualPages || header[1] !== owner.maximumVirtualPages
      || header[2] !== owner.scratchBytes || Atomics.load(header, 3) > 1) {
    return fault('Replica root disagrees with its admitted virtual limits');
  }
  const control = new DataView(storage.memory.buffer, replica, G.MEMORY_GROUP_REPLICA_BYTES);
  if (control.getUint32(G.MEMORY_GROUP_REPLICA_MAGIC_OFFSET, true) !== G.MEMORY_GROUP_REPLICA_MAGIC
      || control.getUint32(G.MEMORY_GROUP_REPLICA_ROOT, true) !== root
      || Atomics.load(new Int32Array(storage.memory.buffer, replica + G.MEMORY_GROUP_REPLICA_RUN, 1), 0) !== 1
      || control.getBigUint64(G.MEMORY_GROUP_REPLICA_SERIAL, true) !== task.serial
      || control.getBigUint64(G.MEMORY_GROUP_REPLICA_GENERATION, true) !== task.generation
      || control.getUint32(G.MEMORY_GROUP_REPLICA_PID, true) !== task.pid
      || control.getUint32(G.MEMORY_GROUP_REPLICA_TID, true) !== task.tid
      || control.getUint32(G.MEMORY_GROUP_REPLICA_GROUP, true) !== task.group) {
    return fault('Replica controls disagree with their exact admitted task');
  }
  owner.assertLive();
  return Object.freeze({ memory: storage.memory, descriptor: Object.freeze({ kind: G.MEMORY_GROUP_MODULE,
    receipt: task, root, replica, maximumVirtualPages: owner.maximumVirtualPages, scratch, scratchBytes: owner.scratchBytes }) });
}

/** Emit plain versioned data with one backing reference. Cloned wrapper
 * identity is not a backing identity contract. The trusted sender selects its
 * owned Memory; the receiver reconstructs local methods on the parent channel.
 * This codec does not authorize admission, execution or storage reclamation.
 */
export function encodeProcessMemoryDescriptor(memory: WebAssembly.Memory, value: ProcessMemoryDescriptor,
  owner?: GroupReplicaMemoryLaunchBinding): ProcessMemoryEnvelope {
  if (owner && memory !== owner.memory) return fault('Launch binding names another physical group backing');
  // The trusted sender binds its owned Memory exactly once. Receiver ownership
  // comes from that parent channel, not comparison of duplicated cloned wrappers.
  return snapshot({ memory, descriptor: value }, owner);
}
export function decodeProcessMemoryDescriptor(value: unknown, owner?: GroupReplicaMemoryExpectation): {
  readonly source: ProcessMemorySource;
  readonly memory: WebAssembly.Memory;
  readonly descriptor: ProcessMemoryDescriptor;
} {
  // Only the launch owner's authenticated parent channel supplies this
  // envelope. Decoding arbitrary guest messages cannot establish membership.
  const envelope = snapshot(value, owner), descriptor = envelope.descriptor;
  if (descriptor.kind === 'linear') return Object.freeze({ source: envelope.memory, ...envelope });
  const source = new GroupProcessAddressSpace({ memory: envelope.memory, root: descriptor.root,
    maximumPages: descriptor.maximumVirtualPages, assertLive: owner!.assertLive });
  return Object.freeze({ source, ...envelope });
}
