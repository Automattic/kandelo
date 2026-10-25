/** Notification history belongs to the live transport, independently of its
 * current ready bits. Weak ownership lets connection retirement reclaim it. */
const generations = new WeakMap<object, [bigint, bigint]>();
function counters(source: object): [bigint, bigint] {
  let value = generations.get(source);
  if (!value) { value = [1n, 1n]; generations.set(source, value); }
  return value;
}
export function notifyReadiness(source: object, direction?: 0 | 1): void {
  const value = counters(source);
  if (direction === undefined || direction === 0) value[0]++;
  if (direction === undefined || direction === 1) value[1]++;
}
export function readinessGeneration(source: object, direction: number): bigint {
  return counters(source)[direction === 0 ? 0 : 1];
}
