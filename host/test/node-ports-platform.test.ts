import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
const target = JSON.parse(readFileSync(new URL('../../packages/registry/node-compat/target.json', import.meta.url), 'utf8'));
const fixture = fileURLToPath(new URL('./fixtures/node-ports-platform.cjs', import.meta.url));
// Candidate IO/port/event source over actual native dependency/queue/byte
// boundaries. Manual fixture dispatch does not validate the guest loop.
describe.skipIf(process.versions.node !== target.version)('port source with explicit native queue boundary', () => {
  for (const name of ['graphQueueAndReceive', 'eventsRefAndClose', 'byteTransferAndClosedValidation',
    'markingExportsAndOwnPolicy', 'privateMarksDoNotInvokeTrapsOrInherit',
    'transferMarkValidatesBeforeGraphAndDetachment', 'cloneMarkUsesNativeBuiltinAndHostDispatch']) {
    it(name, () => {
      const result = spawnSync(process.execPath, ['--expose-internals', fixture, name], {
        encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024,
      });
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.signal, result.stderr).toBeNull();
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout.trim())).toEqual({ case: name, passed: true,
        scope: 'Candidate port/IO/event source over actual native Node queues, graph/byte serialization and engine dependencies; not guest/four-host or port transfer conformance' });
    });
  }
});
