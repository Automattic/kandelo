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
  // These views belong to this synchronous call only. Both callers recreate
  // their byte views from the current memory buffer; never retain guest views
  // across Wasm growth. Use words only when both ranges can share alignment.
  const sourceStart = source.byteOffset + sourceOffset;
  const snapshotStart = snapshot.byteOffset + snapshotOffset;
  const lead = (4 - sourceStart % 4) % 4;
  let sourceWords: Uint32Array | undefined;
  let snapshotWords: Uint32Array | undefined;
  const useWords = len >= 256 && Number.isInteger(sourceOffset) && Number.isInteger(snapshotOffset)
    && Number.isInteger(len) && sourceOffset >= 0 && snapshotOffset >= 0
    && sourceOffset + len <= source.length && snapshotOffset + len <= snapshot.length
    && (snapshotStart + lead) % 4 === 0;
  if (!useWords) return mergeChangedByteRunsScalar(
    source, sourceOffset, snapshot, snapshotOffset, destination, destinationOffset, len,
  );
  let changed = false;
  let i = 0;
  while (i < len) {
    while (i < len && source[sourceOffset + i] === snapshot[snapshotOffset + i]) {
        if (i >= lead && (i - lead) % 4 === 0) {
          // Allocate lazily: a completely changed range only needs the byte
          // run copier, and should not construct unused comparison views.
          if (!sourceWords || !snapshotWords) {
            const count = Math.floor((len - lead) / 4);
            sourceWords = new Uint32Array(source.buffer, sourceStart + lead, count);
            snapshotWords = new Uint32Array(snapshot.buffer, snapshotStart + lead, count);
          }
          let word = (i - lead) / 4;
          while (word < sourceWords.length && sourceWords[word] === snapshotWords[word]) word++;
          i = lead + word * 4;
          if (i >= len) break;
          // A differing word still needs byte comparison: only genuinely
          // changed bytes may overwrite canonical storage.
          if (source[sourceOffset + i] !== snapshot[snapshotOffset + i]) break;
        }
        i++;
    }
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

// Preserve the original scalar loop as a separate optimization unit for short
// or differently aligned ranges. No word-path branch runs inside its byte scan.
function mergeChangedByteRunsScalar(
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
