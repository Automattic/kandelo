import { MemoryGroupProtocolFault, memoryGroupU32, type MemoryGroupSnapshot } from './memory-group-protocol';

const backingFields = [
  'group', 'images', 'replicas', 'exposedReplicas', 'quarantinedReplicas',
  'allocatedPages', 'pendingWaitDrains', 'nativeObservers', 'mappingStagingBytes',
  'retainedMappingReferences', 'sharedObjects', 'sharedPages', 'sharedImageReferences',
  'maximumPages', 'highWaterPages', 'physicalExtentPages',
  'pausedImages', 'unacknowledgedReplicas', 'waitQueueLock', 'waitQueueNodes',
] as const;

/** Independent scalar counters, never a Memory, mapping root or ownership token. */
export type MemoryGroupBackingUsage = Readonly<Record<typeof backingFields[number], number>>;
export interface MemoryGroupUsage {
  readonly admission: MemoryGroupSnapshot;
  readonly backing: MemoryGroupBackingUsage | null;
}

const admissionFields = [
  'group', 'maximumPages', 'maximumProcesses', 'maximumTasks', 'processes', 'tasks',
  'quarantinedTasks', 'backings', 'images',
] as const;

/** Select public scalars before worker RPC, and validate them again on receipt. */
export function validateMemoryGroupUsage(value: unknown): MemoryGroupUsage | null {
  if (value === null) return null;
  const fault = (): never => { throw new MemoryGroupProtocolFault('Invalid memory-group usage reply'); };
  const object = (input: unknown): Record<string, unknown> =>
    input !== null && typeof input === 'object' ? input as Record<string, unknown> : fault();
  const counters = <K extends string>(input: unknown, keys: readonly K[], u32 = true): Readonly<Record<K, number>> => {
    const source = object(input);
    const result = {} as Record<K, number>;
    for (const key of keys) {
      const number = source[key];
      if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 0
          || (u32 && !memoryGroupU32(number))) fault();
      result[key] = number as number;
    }
    return Object.freeze(result);
  };
  const reply = object(value), raw = object(reply.admission);
  const counts = counters(raw, admissionFields);
  if (typeof raw.accepting !== 'boolean' || !counts.group || counts.group > 0x7fff_ffff
      || !counts.maximumPages || counts.maximumPages > 65536 || !counts.maximumProcesses
      || counts.maximumTasks < counts.maximumProcesses || counts.processes > counts.maximumProcesses
      || counts.tasks > counts.maximumTasks || counts.quarantinedTasks > counts.tasks) fault();
  const admission = Object.freeze({ ...counts, accepting: raw.accepting as boolean });
  // Host staging and reference totals aggregate across images; they are not
  // kernel u32 words and may exceed one address space's byte count.
  const backing = reply.backing === null ? null : counters(reply.backing, backingFields, false);
  if (backing && (backing.group !== admission.group || backing.maximumPages !== admission.maximumPages
      || backing.allocatedPages > backing.physicalExtentPages
      || backing.physicalExtentPages > backing.maximumPages || backing.highWaterPages > backing.physicalExtentPages
      || backing.sharedPages > backing.allocatedPages || backing.exposedReplicas > backing.replicas
      || backing.pausedImages > backing.images || backing.unacknowledgedReplicas > backing.replicas
      || backing.quarantinedReplicas > backing.replicas)) fault();
  return Object.freeze({ admission, backing });
}
