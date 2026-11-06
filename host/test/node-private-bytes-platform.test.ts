import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
const require = createRequire(import.meta.url);
const { run } = require('./fixtures/node-private-bytes-controls.cjs');
const target = JSON.parse(readFileSync(new URL('../../packages/registry/node-compat/target.json', import.meta.url), 'utf8'));
// Candidate JS adapters over actual native handles; does not execute guest JSAPI.
describe.skipIf(process.versions.node !== target.version)('private native crypto byte authority', () => {
  it('bypasses public allocation and preserves encoding/BufferSource behavior', () => {
    expect(run()).toMatchObject({ pass: 96, fail: 0, ignoredEncodingCallbackCalls: 0 });
  });
});
