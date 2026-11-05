import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
const target = JSON.parse(readFileSync(new URL('../../packages/registry/node-compat/target.json', import.meta.url), 'utf8'));
const fixture = fileURLToPath(new URL('./fixtures/node-testing-platform.cjs', import.meta.url));
// Candidate pure-JS owners over explicit native dependencies. These are not
// guest test-runner conformance: guest runtime and four-host conformance remain separate.
describe.skipIf(process.versions.node !== target.version)('testing source with native dependency boundaries', () => {
  for (const name of ['functionRecordsAndRestoration', 'descriptorAndPropertyOwnership',
    'virtualClockAndCleanup', 'reporterDataAndStream', 'monotonicProcessClock', 'defaultOptionState', 'executionHierarchyHooksAndCleanup', 'publicDefaultExecution']) {
    it(name, () => {
      const result = spawnSync(process.execPath, ['--expose-internals', fixture, name], {
        encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024,
      });
      if (name === 'publicDefaultExecution') {
        expect(result.stdout).toContain('default public sync');
        expect(result.stdout).toContain('default public async');
        expect(result.stdout).toContain('fail 0');
      }
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.signal, result.stderr).toBeNull();
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout.split('\n').find(line => line.startsWith('{"case":'))!)).toEqual({ case: name,
        ...(name === 'publicDefaultExecution' ? { registered: true } : { passed: true }),
        scope: 'Candidate testing tree/mock/clock/report owners with actual native dependencies; not guest/four-host conformance' });
    });
  }
  it('preserves deliberate test failure and unsuccessful process exit', () => {
    for (const mode of [[], ['native-reference']]) {
      const result = spawnSync(process.execPath,
        ['--expose-internals', fixture, 'publicDeliberateFailure', ...mode], {
          encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024,
        });
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.signal, result.stderr).toBeNull();
      expect(result.status, result.stderr).toBe(1);
      expect(result.stdout).toContain('deliberate public failure');
      expect(result.stdout).toContain('fail 1');
      expect(result.stdout).toContain('actual');
      expect(result.stdout).toContain('expected');
    }
  });
});
