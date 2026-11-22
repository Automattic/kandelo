import { describe, expect, it } from 'vitest';
import { PreparedMemoryGroupProgramCatalog, memoryGroupSourceDigest } from '../src/prepared-memory-group-programs';
const source = new TextEncoder().encode('ordinary source').buffer;
const options = { catalogPath: '/usr/share/kandelo/shared-desktop/programs.json', artifactRoot: '/usr/libexec/kandelo/shared-desktop/' };
async function fixture(change: (manifest: any) => void = () => {}) {
  const manifest = { schema: 1, memoryGroup: 'trusted-v1', programs: [{ id: 'bash', ordinarySha256: await memoryGroupSourceDigest(source), groupedSha256: 'a'.repeat(64), bytes: 100 }] };
  change(manifest);
  let reads = 0;
  const catalog = new PreparedMemoryGroupProgramCatalog(options, async (path, limit) => {
    expect(path).toBe(options.catalogPath); expect(limit).toBe(512 * 1024 + 1); reads++;
    return new TextEncoder().encode(JSON.stringify(manifest));
  });
  return { catalog, reads: () => reads };
}
describe('descriptor SDK candidate catalog', () => {
  it('selects by retained source content and caches the bounded manifest', async () => {
    const { catalog, reads } = await fixture();
    expect(await catalog.select(source)).toEqual({ path: options.artifactRoot + 'bash/program.wasm', bytes: 100, sha256: 'a'.repeat(64) });
    expect(await catalog.select(new TextEncoder().encode('changed source').buffer)).toBeNull();
    expect(reads()).toBe(1);
  });
  it.each(['../bash', '/bash', 'bash/extra', ''])('rejects member path injection %s', async id => {
    const { catalog } = await fixture(m => { m.programs[0].id = id; });
    await expect(catalog.select(source)).rejects.toThrow('Invalid or ambiguous');
  });
  it('rejects ambiguous source identities and malformed hashes', async () => {
    const duplicate = await fixture(m => { m.programs.push({ ...m.programs[0], id: 'other' }); });
    await expect(duplicate.catalog.select(source)).rejects.toThrow('ambiguous');
    const malformed = await fixture(m => { m.programs[0].groupedSha256 = 'x'.repeat(64); });
    await expect(malformed.catalog.select(source)).rejects.toThrow('Invalid');
  });
  it('fails on missing, oversized and invalid UTF-8 catalogs', async () => {
    for (const bytes of [null, new Uint8Array(512 * 1024 + 1), Uint8Array.of(255)]) {
      const catalog = new PreparedMemoryGroupProgramCatalog(options, async () => bytes);
      await expect(catalog.select(source)).rejects.toThrow();
    }
  });
  it('rejects noncanonical catalog paths', () => {
    expect(() => new PreparedMemoryGroupProgramCatalog({ ...options, artifactRoot: '/usr/../tmp/' }, async () => null)).toThrow('paths');
  });
});
