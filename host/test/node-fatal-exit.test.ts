import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { nodeFatalExitCases } from './fixtures/node-fatal-exit';

const target = JSON.parse(readFileSync(new URL('../../packages/registry/node-compat/target.json', import.meta.url), 'utf8'));
describe.skipIf(process.versions.node !== target.version)('exact native fatal-exit controls', () => {
  for (const c of nodeFatalExitCases) {
    it(`checks ${c.name} with outstanding work on Node ${target.version}`, () => {
      const directory = mkdtempSync(join(tmpdir(), 'node-fatal-control-'));
      try {
        const file = join(directory, c.name + c.extension);
        writeFileSync(file, c.source);
        const args = c.extension === 'eval' ? ['-e', c.source] : [file];
        const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 5000 });
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(c.status);
        expect(result.stdout.trim()).toBe(c.marker);
      } finally { rmSync(directory, { recursive: true, force: true }); }
    });
  }
});
