/** Minimal Bun module graph, independent of the native launcher container. */
export function bunStandalone(entry: string): Buffer {
  const modules = [
    ["/$bunfs/root/cli", entry],
    ["/$bunfs/root/helper.js", 'export const tag="extracted-module";'],
  ];
  const chunks: Buffer[] = [];
  let size = 0;
  const records: Buffer[] = [];
  for (const [name, source] of modules) {
    const nameBytes = Buffer.from(name);
    const bytes = Buffer.from(source);
    const record = Buffer.alloc(52);
    record.writeUInt32LE(size, 0);
    record.writeUInt32LE(nameBytes.length, 4);
    record.writeUInt32LE(size + nameBytes.length, 8);
    record.writeUInt32LE(bytes.length, 12);
    record[48] = 1; // Latin1; fixtures use ASCII source.
    record[49] = 1; // JavaScript loader
    record[50] = 1; // ESM
    records.push(record);
    chunks.push(nameBytes, bytes);
    size += nameBytes.length + bytes.length;
  }
  const offsets = Buffer.alloc(32);
  offsets.writeBigUInt64LE(BigInt(size + records.length * 52));
  offsets.writeUInt32LE(size, 8);
  offsets.writeUInt32LE(records.length * 52, 12);
  return Buffer.concat([...chunks, ...records, offsets, Buffer.from("\n---- Bun! ----\n")]);
}
