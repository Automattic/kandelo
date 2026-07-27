import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";

export async function restoreTrustedShellRootfs(
  image: Uint8Array,
  maxByteLength: number,
): Promise<MemoryFileSystem> {
  const fs = MemoryFileSystem.fromImage(image, { maxByteLength });
  // WHY: every shell resolver, registration, mutation, and save happens after
  // this boundary, so forged imported metadata cannot influence partial output.
  await fs.verifyImportedLazyAtomicGroupSeals();
  return fs;
}
