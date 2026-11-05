import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
const target = JSON.parse(readFileSync(new URL('../../packages/registry/node-compat/target.json', import.meta.url), 'utf8'));
describe.skipIf(process.versions.node !== target.version)('pinned cipher classes over actual native boundaries', () => {
  for (const name of ['validation', 'incremental', 'authenticated', 'metadata', 'streamsAndCodecs'])
    it(name, () => {
      const result = spawnSync(process.execPath, ['--expose-internals', fileURLToPath(new URL('./fixtures/node-cipher-controls.cjs', import.meta.url)), name], { encoding: 'utf8', timeout: 15000 });
      expect({ status: result.status, signal: result.signal, error: result.error?.message, stderr: result.status ? result.stderr : undefined })
        .toEqual({ status: 0, signal: null, error: undefined, stderr: undefined });
      expect(JSON.parse(result.stdout.trim()).passed).toBe(true);
    });
});
