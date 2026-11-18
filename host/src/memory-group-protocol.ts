import { MEMORY_GROUP_PROTOCOL as P } from './generated/abi';

export class MemoryGroupProtocolFault extends Error {}
export interface MemoryGroupTaskReceipt {
  readonly group: number;
  readonly pid: number;
  readonly tid: number;
  readonly serial: bigint;
  readonly generation: bigint;
}
export interface MemoryGroupSnapshot {
  readonly group: number;
  readonly maximumPages: number;
  readonly maximumProcesses: number;
  readonly maximumTasks: number;
  readonly accepting: boolean;
  readonly processes: number;
  readonly tasks: number;
  readonly quarantinedTasks: number;
  readonly backings: number;
  readonly images: number;
}
export function memoryGroupU32(...values: number[]): boolean {
  return values.every(value => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff);
}
function view(bytes: Uint8Array, expected: number): DataView {
  if (bytes.byteLength !== expected) throw new MemoryGroupProtocolFault('Invalid memory-group record length');
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
/** Decode independent scratch copies only. These values carry no kernel view
 * or execution-fence proof; Rust revalidates every receipt before any action.
 */
export function decodeMemoryGroupReceipt(bytes: Uint8Array, expected: {
  readonly pid: number; readonly tid: number; readonly group?: number; readonly generation?: bigint;
}): MemoryGroupTaskReceipt {
  const data = view(bytes, P.receipt_bytes), f = P.receipt_fields;
  const receipt = Object.freeze({ group: data.getUint32(f.group, true),
    pid: data.getUint32(f.pid, true), tid: data.getUint32(f.tid, true),
    serial: data.getBigUint64(f.serial, true), generation: data.getBigUint64(f.generation, true) });
  if (!receipt.group || receipt.group > 0x7fffffff || !receipt.serial
      || receipt.pid !== expected.pid || receipt.tid !== expected.tid
      || data.getUint32(f.reserved, true) !== 0
      || (expected.group !== undefined && receipt.group !== expected.group)
      || (expected.generation !== undefined && receipt.generation !== expected.generation)) {
    throw new MemoryGroupProtocolFault('Memory-group receipt does not match the admitted task');
  }
  return receipt;
}
export function decodeMemoryGroupSnapshot(bytes: Uint8Array, group: number): MemoryGroupSnapshot {
  const data = view(bytes, P.snapshot_bytes), f = P.snapshot_fields;
  const u32 = (name: keyof typeof f) => data.getUint32(f[name], true);
  const accepting = u32('accepting');
  const snapshot = Object.freeze({ group: u32('group'), maximumPages: u32('maximumPages'),
    maximumProcesses: u32('maximumProcesses'), maximumTasks: u32('maximumTasks'), accepting: accepting === 1,
    processes: u32('processes'), tasks: u32('tasks'), quarantinedTasks: u32('quarantinedTasks'),
    backings: u32('backings'), images: u32('images') });
  if (snapshot.group !== group || accepting > 1 || !snapshot.maximumPages
      || !snapshot.maximumProcesses || !snapshot.maximumTasks
      || snapshot.processes > snapshot.maximumProcesses || snapshot.tasks > snapshot.maximumTasks
      || snapshot.quarantinedTasks > snapshot.tasks) {
    throw new MemoryGroupProtocolFault('Inconsistent memory-group snapshot');
  }
  return snapshot;
}

export type GroupMemoryChangeKind = 'map' | 'unmap' | 'protect' | 'remap' | 'break';
export interface GroupMemoryChangeDescription {
  readonly receipt: MemoryGroupTaskReceipt;
  readonly token: bigint;
  readonly kind: GroupMemoryChangeKind;
  readonly prot: number;
  readonly address: number;
  readonly length: number;
  readonly oldAddress: number;
  readonly oldLength: number;
  readonly result: number;
  readonly flags: number;
  readonly populationAddress: number;
  readonly populationLength: number;
}

/** Copied channel scalars only; this packet carries no guest/kernel pointer. */
export function encodeGroupMemoryChangeRequest(syscall: number, args: readonly bigint[], observedPages: number): Uint8Array {
  const mapping = P.mapping;
  if (mapping.version !== 3 || !memoryGroupU32(syscall, observedPages) || observedPages < 1 || observedPages > 65536
      || args.length !== 6 || args.some(value => typeof value !== 'bigint'
      || value < -(1n << 63n) || value > (1n << 63n) - 1n)) {
    throw new MemoryGroupProtocolFault('Invalid grouped mapping request scalars');
  }
  const bytes = new Uint8Array(mapping.request_bytes), data = new DataView(bytes.buffer);
  data.setUint32(mapping.request_fields.syscall, syscall, true);
  data.setUint32(mapping.request_fields.observedPages, observedPages, true);
  args.forEach((value, index) => data.setBigUint64(mapping.request_fields.args + index * 8, BigInt.asUintN(64, value), true));
  return bytes;
}

export interface GroupMemoryLayoutInput {
  readonly initialPages: number; readonly maximumPages: number; readonly channel: number;
  readonly mode: 'fresh' | 'inherited';
  readonly brkBase?: number; readonly mmapBase?: number; readonly brkLimit?: number;
  readonly controlBase?: number; readonly controlEnd?: number;
}
export function encodeGroupMemoryLayout(receipt: MemoryGroupTaskReceipt, input: GroupMemoryLayoutInput): Uint8Array {
  const layout = P.layout;
  if (layout.version !== 1 || !memoryGroupU32(receipt.group, receipt.pid, receipt.tid, input.initialPages, input.maximumPages, input.channel)
      || receipt.group === 0 || receipt.group > 0x7fffffff || receipt.pid <= 1 || receipt.tid !== receipt.pid
      || typeof receipt.serial !== 'bigint' || receipt.serial <= 0n || receipt.serial > 0xffffffffffffffffn
      || typeof receipt.generation !== 'bigint' || receipt.generation < 0n || receipt.generation > 0xffffffffffffffffn
      || input.initialPages < 1 || input.initialPages > input.maximumPages || input.maximumPages > 65536
      || (input.mode !== 'fresh' && input.mode !== 'inherited')) throw new MemoryGroupProtocolFault('Invalid grouped layout identity/capacity');
  const bytes = new Uint8Array(layout.bytes), data = new DataView(bytes.buffer), f = layout.fields, r = P.receipt_fields;
  data.setUint32(r.group, receipt.group, true); data.setUint32(r.pid, receipt.pid, true); data.setUint32(r.tid, receipt.tid, true);
  data.setBigUint64(r.serial, receipt.serial, true); data.setBigUint64(r.generation, receipt.generation, true);
  data.setUint32(f.initialPages, input.initialPages, true); data.setUint32(f.maximumPages, input.maximumPages, true);
  data.setUint32(f.mode, layout.modes[input.mode], true); data.setBigUint64(f.channel, BigInt(input.channel), true);
  for (const key of ['brkBase', 'mmapBase', 'brkLimit', 'controlBase', 'controlEnd'] as const) {
    const value = input[key];
    if (input.mode === 'inherited') {
      if (value !== undefined && value !== 0) throw new MemoryGroupProtocolFault('Inherited layout cannot reset kernel state');
    } else {
      if (!Number.isSafeInteger(value) || value! < 0 || value! > input.maximumPages * 65536) throw new MemoryGroupProtocolFault('Invalid grouped virtual layout address');
      data.setBigUint64(f[key], BigInt(value!), true);
    }
  }
  return bytes;
}

/** Decode an owned scratch copy, retaining all token/receipt bits. The kernel
 * remains the mapping authority; this validates its result before host work.
 */
export function decodeGroupMemoryChangeDescription(bytes: Uint8Array,
  expected: MemoryGroupTaskReceipt, token?: bigint): GroupMemoryChangeDescription {
  const mapping = P.mapping, f = mapping.description_fields;
  const data = view(bytes, mapping.description_bytes);
  const receipt = decodeMemoryGroupReceipt(bytes.subarray(0, P.receipt_bytes), expected);
  const actualToken = data.getBigUint64(f.token, true);
  if (receipt.serial !== expected.serial || !actualToken || (token !== undefined && actualToken !== token)
      || data.getUint32(f.reserved, true) !== 0) {
    throw new MemoryGroupProtocolFault('Mapping description names another exact operation');
  }
  const rawKind = data.getUint32(f.kind, true);
  const kind = (Object.entries(mapping.kinds).find(([, value]) => value === rawKind)?.[0]) as GroupMemoryChangeKind | undefined;
  if (!kind) throw new MemoryGroupProtocolFault('Unknown grouped mapping effect');
  const address = (offset: number): number => {
    const value = data.getBigUint64(offset, true);
    if (value > 0x1_0000_0000n) throw new MemoryGroupProtocolFault('Mapping address exceeds memory32');
    return Number(value);
  };
  const result = Object.freeze({ receipt, token: actualToken, kind,
    prot: data.getUint32(f.prot, true), flags: data.getUint32(f.flags, true),
    address: address(f.address), length: address(f.length), oldAddress: address(f.oldAddress),
    oldLength: address(f.oldLength), result: address(f.result),
    populationAddress: address(f.populationAddress), populationLength: address(f.populationLength) });
  const page = 65536;
  const badRange = (at: number, size: number) => at % page !== 0 || size % page !== 0 || at + size > 0x1_0000_0000;
  if ((result.prot & ~7) !== 0 || (kind !== 'map' && result.flags !== 0)
      || (kind !== 'break' && badRange(result.address, result.length))
      || (kind !== 'remap' && kind !== 'break' && (result.oldAddress !== 0 || result.oldLength !== 0))
      || ((kind === 'map' || kind === 'remap') && (!result.length || result.result !== result.address))
      || ((kind === 'unmap' || kind === 'protect') && result.result !== 0)
      || (kind === 'unmap' && (!result.length || result.prot !== 0))
      || (kind === 'remap' && (!result.oldLength || badRange(result.oldAddress, result.oldLength)))
      || (kind === 'break' && (result.length !== 0 || result.oldLength !== 0 || result.result !== result.address || result.prot !== 3))
      || (result.populationLength === 0 ? result.populationAddress !== 0 :
        badRange(result.populationAddress, result.populationLength)
        || (kind !== 'map' && kind !== 'remap')
        || result.populationAddress !== result.address + (kind === 'remap' ? result.oldLength : 0)
        || result.populationLength !== result.length - (kind === 'remap' ? result.oldLength : 0))) {
    throw new MemoryGroupProtocolFault('Inconsistent grouped mapping effect');
  }
  return result;
}

/** Independent copies from the kernel's exact-target future reservation. */
export function decodeGroupExecPreparation(bytes: Uint8Array, expected: {
  readonly group: number; readonly pid: number; readonly generation: bigint;
}): { readonly receipt: MemoryGroupTaskReceipt; readonly initialPages: number; readonly maximumPages: number } {
  const protocol = P.exec_preparation;
  if (protocol.version !== 1) throw new MemoryGroupProtocolFault('Unsupported grouped exec preparation');
  const data = view(bytes, protocol.bytes);
  const receipt = decodeMemoryGroupReceipt(bytes.subarray(0, P.receipt_bytes), { ...expected, tid: expected.pid });
  const initialPages = data.getUint32(protocol.fields.initialPages, true), maximumPages = data.getUint32(protocol.fields.maximumPages, true);
  if (initialPages > maximumPages || maximumPages === 0 || maximumPages > 65536) {
    throw new MemoryGroupProtocolFault('Invalid grouped exec virtual bounds');
  }
  return Object.freeze({ receipt, initialPages, maximumPages });
}

export function encodeMemoryGroupReceipt(receipt: MemoryGroupTaskReceipt): Uint8Array {
  if (!memoryGroupU32(receipt.group, receipt.pid, receipt.tid) || receipt.group === 0 || receipt.pid <= 1 || receipt.tid === 0
      || typeof receipt.serial !== 'bigint' || receipt.serial <= 0n || receipt.serial > 0xffffffffffffffffn
      || typeof receipt.generation !== 'bigint' || receipt.generation < 0n || receipt.generation > 0xffffffffffffffffn) {
    throw new MemoryGroupProtocolFault('Invalid exact memory-group receipt');
  }
  const bytes = new Uint8Array(P.receipt_bytes), data = new DataView(bytes.buffer), fields = P.receipt_fields;
  data.setUint32(fields.group, receipt.group, true); data.setUint32(fields.pid, receipt.pid, true); data.setUint32(fields.tid, receipt.tid, true);
  data.setBigUint64(fields.serial, receipt.serial, true); data.setBigUint64(fields.generation, receipt.generation, true);
  return bytes;
}
