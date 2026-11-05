import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
const target = JSON.parse(readFileSync(new URL('../../packages/registry/node-compat/target.json', import.meta.url), 'utf8'));
const fixture = fileURLToPath(new URL('./fixtures/node-uv-platform.cjs', import.meta.url));
describe.skipIf(process.versions.node !== target.version)('shared numeric errors with native boundaries', () => {
  for (const name of ['dnsNumericErrorFields', 'uvExceptionMapIsolation']) {
    it(name, () => {
      const proc = spawnSync(process.execPath, ['--expose-internals', fixture, name], {
        encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024,
      });
      expect(proc.error, proc.stderr).toBeUndefined();
      expect(proc.signal, proc.stderr).toBeNull();
      expect(proc.status, proc.stderr).toBe(0);
      expect(JSON.parse(proc.stdout.trim())).toEqual({ case: name, passed: true,
        scope: 'Candidate error algorithms/UV owner over real native error-data/engine boundaries; no guest engine conformance' });
    });
  }
});
