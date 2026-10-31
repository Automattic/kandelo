import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { nodeExitListenerCases } from './fixtures/node-exit-listeners';
const target = JSON.parse(readFileSync(new URL('../../packages/registry/node-compat/target.json', import.meta.url), 'utf8'));
describe.skipIf(process.versions.node !== target.version)('exact native throwing exit-listener controls', () => {
  for (const c of nodeExitListenerCases) {
    it(c.name, () => {
      const directory = mkdtempSync(join(tmpdir(), 'node-exit-listener-'));
      const file = join(directory, c.name + c.extension);
      writeFileSync(file, c.source);
      const args = c.extension === '.mjs' ? [file] : ['-e', c.source];
      let result;
      try { result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 5000 }); }
      finally { rmSync(directory, { recursive: true, force: true }); }
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(c.status);
      expect(result.stdout.trim()).toBe(c.marker);
      expect(result.stderr.includes(c.secondaryNeedle)).toBe(c.secondary);
      if (!c.secondary) expect(result.stderr).toContain('main-primary');
    });
  }
});
