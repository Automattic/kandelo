import { MEMORY_GROUP_PROTOCOL as P } from './generated/abi';
import type { MemoryGroupBackingUsage } from './memory-group-usage';

export class MemoryGroupProtocolFault extends Error {
  constructor(message: string, options?: ErrorOptions, readonly retainedBacking?: MemoryGroupBackingUsage) {
    super(message, options);
  }
}
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
  readonly pid: number; readonly tid: number; readonly group?: number; readonly generation?: bigint; readonly serial?: bigint;
}): MemoryGroupTaskReceipt {
  const data = view(bytes, P.receipt_bytes), f = P.receipt_fields;
  const receipt = Object.freeze({ group: data.getUint32(f.group, true),
    pid: data.getUint32(f.pid, true), tid: data.getUint32(f.tid, true),
    serial: data.getBigUint64(f.serial, true), generation: data.getBigUint64(f.generation, true) });
  if (!receipt.group || receipt.group > 0x7fffffff || !receipt.serial
      || receipt.pid !== expected.pid || receipt.tid !== expected.tid
      || data.getUint32(f.reserved, true) !== 0
      || (expected.group !== undefined && receipt.group !== expected.group)
      || (expected.serial !== undefined && receipt.serial !== expected.serial)
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
