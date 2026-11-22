/** SDK-produced alternatives to ordinary executable bytes. This catalog only
 * selects a candidate; the kernel binds it to the retained source descriptor. */
export interface PreparedMemoryGroupPrograms {
  catalogPath: string;
  artifactRoot: string;
}
export interface PreparedMemoryGroupProgram {
  path: string;
  bytes: number;
  sha256: string;
}
const MAX_CATALOG_BYTES = 512 * 1024;
const digestPattern = /^[a-f0-9]{64}$/;
function absolutePath(path: string): boolean {
  return path.startsWith('/') && !path.includes('\\') && !path.includes('\0')
    && path.length < 4096 && !path.split('/').some(part => part === '.' || part === '..');
}
export async function memoryGroupSourceDigest(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}
export class PreparedMemoryGroupProgramCatalog {
  private loaded?: Promise<ReadonlyMap<string, PreparedMemoryGroupProgram>>;
  constructor(private readonly options: PreparedMemoryGroupPrograms,
    private readonly read: (path: string, limit: number) => Promise<Uint8Array | null>) {
    if (!absolutePath(options.catalogPath) || !absolutePath(options.artifactRoot)
        || !options.artifactRoot.endsWith('/')) throw Error('Invalid SDK program catalog paths');
  }
  private async load(): Promise<ReadonlyMap<string, PreparedMemoryGroupProgram>> {
    const bytes = await this.read(this.options.catalogPath, MAX_CATALOG_BYTES + 1);
    if (!bytes || bytes.length > MAX_CATALOG_BYTES) throw Error('Missing or oversized SDK program catalog');
    const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (manifest.schema !== 1 || manifest.memoryGroup !== 'trusted-v1' || !Array.isArray(manifest.programs)
        || manifest.programs.length === 0 || manifest.programs.length > 256) throw Error('Invalid SDK program catalog');
    const programs = new Map<string, PreparedMemoryGroupProgram>();
    const ids = new Set<string>();
    for (const row of manifest.programs) {
      if (!row || typeof row.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(row.id)
          || ids.has(row.id) || typeof row.ordinarySha256 !== 'string' || !digestPattern.test(row.ordinarySha256)
          || typeof row.groupedSha256 !== 'string' || !digestPattern.test(row.groupedSha256)
          || !Number.isSafeInteger(row.bytes) || row.bytes < 8 || row.bytes > 512 * 1024 * 1024
          || programs.has(row.ordinarySha256)) throw Error('Invalid or ambiguous SDK program catalog member');
      ids.add(row.id);
      programs.set(row.ordinarySha256, Object.freeze({ path: this.options.artifactRoot + row.id + '/program.wasm',
        bytes: row.bytes, sha256: row.groupedSha256 }));
    }
    return programs;
  }
  async select(source: ArrayBuffer): Promise<PreparedMemoryGroupProgram | null> {
    const catalog = await (this.loaded ??= this.load());
    return catalog.get(await memoryGroupSourceDigest(source)) ?? null;
  }
}
