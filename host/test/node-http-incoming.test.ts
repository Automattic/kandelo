import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
const target = JSON.parse(readFileSync(new URL('../../packages/registry/node-compat/target.json', import.meta.url), 'utf8'));
const fixture = fileURLToPath(new URL('./fixtures/node-http-incoming-control.cjs', import.meta.url));
describe.skipIf(process.versions.node !== target.version)('pinned IncomingMessage and actual HTTP consumer', () => {
  for (const name of ['constructorAndDescriptors', 'headerAndTrailerState', 'readTimeoutAndAbort',
    'fragmentedWireHeadersAndTrailers', 'parserCompletionRetainsUnreadResponse', 'earlyResponseRetainsPendingWrite',
    'informationalBeforeFinalResponse', 'headResponseHasNoBody', 'upgradeAndConnectTransferHead',
    'malformedFramingAndHeaderLimits', 'parserOptionErrors', 'headerCountIsAppliedBeforeIncomingHeaders',
    'unsolicitedResponseBytesAreNotReused', 'pooledFailureDoesNotReplayPost']) it(name, () => {
    const result = spawnSync(process.execPath, ['--expose-internals', fixture, name], { encoding: 'utf8', timeout: 15000 });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.signal, result.stderr).toBeNull();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ case: name, passed: true });
  });
});
