export async function appendUnusedBlockTombstones(journal: Uint8Array, count: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(count) || count < 0 || count > 100_000 || journal.length < 72) {
    throw new Error("invalid bounded journal-history fixture input");
  }
  let sequence = 0n;
  let inode: bigint | undefined;
  let position = 72;
  while (position < journal.length) {
    if (position + 60 > journal.length) throw new Error("incomplete source transaction");
    const view = new DataView(journal.buffer, journal.byteOffset + position, journal.length - position);
    const length = view.getUint32(4, true);
    if (length < 60 || position + length > journal.length) throw new Error("invalid source frame length");
    sequence = view.getBigUint64(8, true);
    let record = 24;
    while (record < length - 36) {
      const nameLength = view.getUint8(record + 18);
      const valueLength = view.getUint32(record + 19 + nameLength, true);
      if (view.getUint8(record) === 1 && view.getUint8(record + 1) === 2) inode ??= view.getBigUint64(record + 2, true);
      record += 23 + nameLength + valueLength;
    }
    if (record !== length - 36) throw new Error("invalid source record boundaries");
    position += length;
  }
  if (inode === undefined) throw new Error("source has no guest-written file block");
  const recordsPerFrame = 4096;
  const output = new Uint8Array(journal.length + count * 23 + Math.ceil(count / recordsPerFrame) * 60);
  output.set(journal);
  position = journal.length;
  for (let start = 0; start < count; start += recordsPerFrame) {
    const records = Math.min(recordsPerFrame, count - start);
    const length = 60 + records * 23;
    const transaction = output.subarray(position, position + length);
    const view = new DataView(transaction.buffer, transaction.byteOffset, transaction.byteLength);
    transaction.set([75, 84, 88, 78]);
    view.setUint32(4, length, true);
    view.setBigUint64(8, ++sequence, true);
    view.setUint32(16, records, true);
    view.setUint32(20, (~length) >>> 0, true);
    for (let index = 0; index < records; index++) {
      const offset = 24 + index * 23;
      view.setUint8(offset, 2);
      view.setUint8(offset + 1, 2);
      view.setBigUint64(offset + 2, inode, true);
      view.setBigUint64(offset + 10, BigInt(1024 + start + index), true);
    }
    transaction.set(new Uint8Array(await crypto.subtle.digest("SHA-256", transaction.slice(0, -36).buffer)), length - 36);
    transaction.set([68, 79, 78, 69], length - 4);
    position += length;
  }
  return output;
}
