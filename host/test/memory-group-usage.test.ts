import { expect, it } from 'vitest';
import { validateMemoryGroupUsage } from '../src/memory-group-usage';

const reply = () => ({
  admission: { group: 1, maximumPages: 2048, maximumProcesses: 4, maximumTasks: 8,
    accepting: true, processes: 1, tasks: 1, quarantinedTasks: 0, backings: 1, images: 1 },
  backing: { group: 1, images: 1, replicas: 1, exposedReplicas: 1, quarantinedReplicas: 0,
    allocatedPages: 20, pendingWaitDrains: 0, nativeObservers: 0, mappingStagingBytes: 0,
    retainedMappingReferences: 0, sharedObjects: 1, sharedPages: 2, sharedImageReferences: 1,
    maximumPages: 2048, highWaterPages: 20, physicalExtentPages: 32,
    pausedImages: 0, unacknowledgedReplicas: 0, waitQueueLock: 0, waitQueueNodes: 0 },
});

it('copies and freezes scalar inspection without retaining extra payloads', () => {
  const source = { admission: { ...reply().admission, extra: new Uint8Array(16) },
    backing: { ...reply().backing, extra: new Uint8Array(new SharedArrayBuffer(16)) }, extra: new Uint8Array(16) };
  const view = validateMemoryGroupUsage(source)!;
  source.admission.tasks = 7;
  source.backing.sharedPages = 18;
  expect(view.admission.tasks).toBe(1);
  expect(view.backing!.sharedPages).toBe(2);
  expect(Object.keys(view)).toEqual(['admission', 'backing']);
  expect(view.admission).not.toHaveProperty('extra');
  expect(view.backing).not.toHaveProperty('extra');
  expect(Object.isFrozen(view) && Object.isFrozen(view.admission) && Object.isFrozen(view.backing)).toBe(true);
});

it('preserves aggregate staging byte counts beyond one u32 address space', () => {
  const source = reply(); source.backing.mappingStagingBytes = 2 ** 33;
  expect(validateMemoryGroupUsage(source)!.backing!.mappingStagingBytes).toBe(2 ** 33);
});

it('distinguishes an absent group from admitted capacity without a backing', () => {
  expect(validateMemoryGroupUsage(null)).toBeNull();
  const source = { admission: reply().admission, backing: null };
  expect(validateMemoryGroupUsage(source)).toEqual(source);
});

it.each([
  (r: ReturnType<typeof reply>) => { r.backing.group = 2; },
  (r: ReturnType<typeof reply>) => { r.admission.tasks = 9; },
  (r: ReturnType<typeof reply>) => { r.admission.maximumTasks = 3; },
  (r: ReturnType<typeof reply>) => { r.backing.physicalExtentPages = 2049; },
  (r: ReturnType<typeof reply>) => { r.backing.allocatedPages = 33; },
  (r: ReturnType<typeof reply>) => { r.backing.sharedPages = 21; },
  (r: ReturnType<typeof reply>) => { r.backing.nativeObservers = Number.NaN; },
  (r: ReturnType<typeof reply>) => { r.backing.mappingStagingBytes = -1; },
  (r: ReturnType<typeof reply>) => { r.backing.mappingStagingBytes = Number.MAX_SAFE_INTEGER + 1; },
  (r: ReturnType<typeof reply>) => { (r.admission as any).accepting = 1; },
])('refuses inconsistent or malformed worker usage', mutate => {
  const source = reply(); mutate(source);
  expect(() => validateMemoryGroupUsage(source)).toThrow('Invalid memory-group usage reply');
});

it.each([undefined, {}, { admission: {} }, { admission: reply().admission }])('refuses incomplete replies', source => {
  expect(() => validateMemoryGroupUsage(source)).toThrow('Invalid memory-group usage reply');
});
