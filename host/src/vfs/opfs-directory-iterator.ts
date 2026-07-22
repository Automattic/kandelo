export interface OpfsDirectoryIterator {
  entries: { name: string; kind: "file" | "directory" }[];
  index: number;
}

const DT_REG = 8;
const DT_DIR = 4;

/**
 * Marshal one OPFS directory entry and commit its iterator position only
 * after both the payload and its channel metadata have been published.
 * Returns false at end-of-directory.
 */
export function marshalNextOpfsDirectoryEntry(
  iter: OpfsDirectoryIterator,
  data: Uint8Array,
  publish: (nameLength: number) => void,
): boolean {
  if (iter.index >= iter.entries.length) return false;

  const index = iter.index;
  const entry = iter.entries[index];
  const nameBytes = new TextEncoder().encode(entry.name);
  if (nameBytes.length >= data.byteLength) {
    throw new RangeError("OPFS directory entry exceeds the channel buffer");
  }

  data.set(nameBytes);
  data[nameBytes.length] = entry.kind === "directory" ? DT_DIR : DT_REG;
  publish(nameBytes.length);
  iter.index = index + 1;
  return true;
}
