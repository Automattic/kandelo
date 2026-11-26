/** Normal package-derived variants are addressed by the ordinary source digest.
 * The kernel still validates and binds the retained source/variant descriptors. */
export const SHARED_MEMORY_PROGRAM_ROOT = '/usr/libexec/kandelo/memory-group/';
export function sharedMemoryProgramPath(sourceSha256: string): string {
  if (!/^[a-f0-9]{64}$/.test(sourceSha256)) throw Error('Invalid shared-memory source digest');
  return SHARED_MEMORY_PROGRAM_ROOT + sourceSha256 + '/program.wasm';
}
export async function memoryGroupSourceDigest(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}
