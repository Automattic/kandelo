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
