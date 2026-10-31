import { createHash } from "node:crypto";

export function journalBytes(length = 72, digestByte = 7): Uint8Array {
  const bytes = new Uint8Array(length);
  bytes.set(Buffer.from("KOVL"));
  new DataView(bytes.buffer).setUint32(4, 1, true);
  bytes.fill(digestByte, 8, 40);
  bytes.set(createHash("sha256").update(bytes.subarray(0, 40)).digest(), 40);
  return bytes;
}

export function checkpointHeader(version = 1): Uint8Array {
  const bytes = new Uint8Array(160);
  const view = new DataView(bytes.buffer);
  bytes.set(Buffer.from("KIDX"));
  view.setUint32(4, version, true);
  view.setBigUint64(72, 72n, true);
  view.setBigUint64(88, 1n, true);
  const emptyDigest = createHash("sha256").digest();
  bytes.set(version === 3 || version === 4 ? createHash("sha256").update(emptyDigest).update(emptyDigest).digest() : emptyDigest, 96);
  bytes.set(createHash("sha256").update(bytes.subarray(0, 128)).digest(), 128);
  return bytes;
}
