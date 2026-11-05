import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const target = JSON.parse(readFileSync(new URL('../../packages/registry/node-compat/target.json', import.meta.url), 'utf8'));
const fixture = fileURLToPath(new URL('./fixtures/node-fd-stream-platform.cjs', import.meta.url));
// Private activation stays in the child. Candidate stream/transport source
// uses actual native engine dependencies and real OS pipe/file I/O there;
// this establishes neither the guest native-watch path nor four-host behavior.
describe.skipIf(process.versions.node !== target.version)('fd-backed stream source with native I/O boundary', () => {
  for (const name of ['outputCompletionAndBackpressure', 'inputBufferingEncodingAndEof',
    'pauseRefResumeAndDestroy', 'actualFileErrorAndBorrowedOutputLifetime']) {
    it(name, () => {
      const result = spawnSync(process.execPath, ['--expose-internals', fixture, name], {
        encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024,
      });
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.signal, result.stderr).toBeNull();
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout.trim())).toEqual({ case: name, passed: true,
        scope: 'Candidate fd owners and pinned stream factories over actual native dependencies/pipes/files; not guest/four-host conformance' });
    });
  }
});
