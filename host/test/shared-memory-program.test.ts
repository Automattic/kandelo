import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { sharedMemoryProgramPath, memoryGroupSourceDigest } from '../src/shared-memory-program';
it('addresses derived programs by exact ordinary executable content', async () => {
  const bytes = new TextEncoder().encode('ordinary executable');
  const digest = await memoryGroupSourceDigest(bytes.buffer);
  expect(digest).toBe(createHash('sha256').update(bytes).digest('hex'));
  expect(sharedMemoryProgramPath(digest)).toBe(`/usr/libexec/kandelo/memory-group/${digest}/program.wasm`);
  expect(await memoryGroupSourceDigest(new TextEncoder().encode('changed executable').buffer)).not.toBe(digest);
});
it.each(['', '../foo', '/tmp/file', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'a'.repeat(63) + '/'])('rejects a malformed source identity %j', value => {
  expect(() => sharedMemoryProgramPath(value)).toThrow('digest');
});
