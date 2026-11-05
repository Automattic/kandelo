import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';
const target = JSON.parse(readFileSync(new URL('../../packages/registry/node-compat/target.json', import.meta.url), 'utf8'));
describe.skipIf(process.versions.node !== target.version)('pinned removal algorithms over native request boundaries', () => {
  for (const scenario of ['validation', 'force-errors', 'trees', 'paths', 'retry', 'race', 'vfs'])
    it(scenario, () => {
      const result = spawnSync(process.execPath, ['--expose-internals',
        fileURLToPath(new URL('./fixtures/node-removal-controls.cjs', import.meta.url)), scenario],
      { encoding: 'utf8', timeout: 15_000 });
      expect({ status: result.status, signal: result.signal, error: result.error?.message,
        stderr: result.status === 0 ? undefined : result.stderr }).toEqual({ status: 0, signal: null,
        error: undefined, stderr: undefined });
      expect(JSON.parse(result.stdout.trim()).passed).toBe(true);
    });
});
