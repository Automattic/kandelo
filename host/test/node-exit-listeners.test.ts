import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { nodeExitListenerCases } from './fixtures/node-exit-listeners';
const target = JSON.parse(readFileSync(new URL('../../packages/registry/node-compat/target.json', import.meta.url), 'utf8'));
describe.skipIf(process.versions.node !== target.version)('exact native throwing exit-listener controls', () => {
  for (const c of nodeExitListenerCases) {
    it(c.name, () => {
      const result = spawnSync(process.execPath, ['-e', c.source], { encoding: 'utf8', timeout: 5000 });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(c.status);
      expect(result.stdout.trim()).toBe(c.marker);
      expect(result.stderr.includes('Error: exit-listener-secondary')).toBe(c.secondary);
      if (!c.secondary) expect(result.stderr).toContain('main-primary');
    });
  }
});
