import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const target = JSON.parse(readFileSync(new URL('../../packages/registry/node-compat/target.json', import.meta.url), 'utf8'));
const fixture = fileURLToPath(new URL('./fixtures/node-compression-binding.cjs', import.meta.url));
// Each reference process owns its private activation and timeout. The parent
// keeps ordinary module policy; an abort retains the other controls' accounting.
describe.skipIf(process.versions.node !== target.version)('compression source with explicit native backend boundary', () => {
  for (const name of ['constructors', 'fractionalOptions', 'asyncSpansAndParams', 'initializationErrors', 'publicValidation']) {
    it(name, () => {
      const result = spawnSync(process.execPath, ['--expose-internals', fixture, name], {
        encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
      });
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.signal, result.stderr).toBeNull();
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout.trim())).toEqual({ case: name, passed: true });
    });
  }
});
