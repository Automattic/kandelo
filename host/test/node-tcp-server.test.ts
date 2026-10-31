import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { nodeTcpServerCases } from './fixtures/node-tcp-server';

const target = JSON.parse(readFileSync(new URL('../../packages/registry/node-compat/target.json', import.meta.url), 'utf8'));
describe.skipIf(process.versions.node !== target.version)('exact native TCP listener controls', () => {
  for (const c of nodeTcpServerCases) {
    it(c.name, () => {
      const result = spawnSync(process.execPath, ['-e', c.source], { encoding: 'utf8', timeout: 5000 });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toMatch(/^node-tcp-.*-ok$/);
    });
  }
});
