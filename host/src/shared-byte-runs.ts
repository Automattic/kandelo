/** Merge only writes relative to this mapping's last published snapshot.
 * Unchanged readers must never overwrite newer canonical bytes. */
export function mergeChangedByteRuns(
  source: Uint8Array,
  sourceOffset: number,
  snapshot: Uint8Array,
  snapshotOffset: number,
  destination: Uint8Array,
  destinationOffset: number,
  len: number,
): boolean {
  let changed = false;
  let i = 0;
  while (i < len) {
    while (i < len && source[sourceOffset + i] === snapshot[snapshotOffset + i]) i++;
    if (i >= len) break;
    const start = i;
    do { i++; } while (
      i < len && source[sourceOffset + i] !== snapshot[snapshotOffset + i]
    );
    destination.set(source.subarray(sourceOffset + start, sourceOffset + i), destinationOffset + start);
    changed = true;
  }
  return changed;
}
