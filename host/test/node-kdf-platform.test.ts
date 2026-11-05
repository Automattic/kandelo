import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import * as crypto from 'node:crypto';
const require = createRequire(import.meta.url);
const { create } = require('./fixtures/node-kdf-platform.cjs');
const controls = require('./fixtures/node-kdf-controls.cjs');
const target = JSON.parse(readFileSync(new URL('../../packages/registry/node-compat/target.json', import.meta.url), 'utf8'));
// Candidate public algorithms and packet/callback conversion over actual
// native crypto jobs. Guest native work/JSAPI/GC are separate evidence.
describe.skipIf(process.versions.node !== target.version)('password KDFs with native dependencies', () => {
  for (const [name, run] of Object.entries(controls) as [string, (api: unknown) => unknown][]) {
    it(name, async () => {
      expect(await run(create())).toEqual(await run(crypto));
    });
  }
});
